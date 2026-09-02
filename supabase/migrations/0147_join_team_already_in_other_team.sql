-- ============================================================================
-- 0147_join_team_already_in_other_team.sql
--
-- 問題：使用者「已經在這個計畫的某一隊」（常見：之前不小心自己建過一隊），
-- 再輸入別隊的邀請碼想換隊時，join_reading_team_by_code 一律 RAISE
-- 'already_in_plan_division'，而前端 isAlreadyJoinedTeamResult() 把
-- 'already_in_plan_division' 當成「已加入 → 視為成功」→ 畫面顯示「已成功加入團隊！」
-- 但其實人還在舊隊裡，什麼都沒變。使用者以為成功、結果沒動，很容易誤會 / 生氣。
--
-- 改法：把兩種情況分開
--   · 輸入的邀請碼就是「自己已經在的那一隊」→ 視為無動作的成功（回 alreadyMember=true）
--   · 輸入的是「別隊」的邀請碼、但自己已經在同計畫同組別的其他隊 →
--     RAISE 'already_in_other_team'（前端要顯示明確訊息：先離開原本的團隊才能換隊）
--
-- 其餘邏輯（滿員檢查、自我修復 status、寫入 membership）與 0072 相同。
-- 簽名不變 → nlc-data 不用重部署。
--
-- 部署：Supabase SQL editor 執行，或 `supabase db push`。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.join_reading_team_by_code(
  p_global_plan_id UUID,
  p_invite_code TEXT,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $join_reading_team$
DECLARE
  actor_id UUID;
  selected_team public.reading_teams%ROWTYPE;
  current_count INTEGER;
  existing_team_id UUID;
BEGIN
  actor_id := public.resolve_reading_team_actor(p_actor_id);

  SELECT * INTO selected_team
  FROM public.reading_teams
  WHERE global_plan_id = p_global_plan_id
    AND invite_code = upper(btrim(COALESCE(p_invite_code, '')))
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'team_invite_not_found'; END IF;

  -- 這位使用者在這個計畫的這個組別，是不是已經在某一隊裡了？
  SELECT team_id INTO existing_team_id
  FROM public.reading_team_members
  WHERE global_plan_id = p_global_plan_id
    AND user_id = actor_id
    AND division = selected_team.division
  LIMIT 1;

  IF existing_team_id IS NOT NULL THEN
    IF existing_team_id = selected_team.id THEN
      -- 就是這一隊：無動作的成功（可能是重複輸入自己的邀請碼）
      SELECT COUNT(*)::INTEGER INTO current_count
      FROM public.reading_team_members WHERE team_id = selected_team.id;
      RETURN jsonb_build_object(
        'teamId', selected_team.id,
        'division', selected_team.division,
        'memberCount', current_count,
        'capacity', selected_team.division,
        'alreadyMember', TRUE,
        'status', selected_team.status
      );
    END IF;
    -- 已經在同計畫同組別的「別隊」→ 要換隊得先離開原本的
    RAISE EXCEPTION 'already_in_other_team';
  END IF;

  SELECT COUNT(*)::INTEGER INTO current_count
  FROM public.reading_team_members WHERE team_id = selected_team.id;

  -- Row count is always the source of truth. If a membership row was ever
  -- removed without going through remove_reading_team_member, the cached
  -- status column can be stuck at 'ready' below capacity — correct it here
  -- rather than trusting it.
  IF selected_team.status = 'ready' AND current_count < selected_team.division THEN
    UPDATE public.reading_teams SET status = 'forming' WHERE id = selected_team.id;
    selected_team.status := 'forming';
  END IF;

  IF current_count >= selected_team.division OR selected_team.status = 'ready' THEN
    RAISE EXCEPTION 'reading_team_full';
  END IF;

  INSERT INTO public.reading_team_members(team_id, global_plan_id, user_id, division, member_role)
  VALUES (selected_team.id, p_global_plan_id, actor_id, selected_team.division, 'member');
  current_count := current_count + 1;

  IF current_count = selected_team.division THEN
    UPDATE public.reading_teams SET status = 'ready' WHERE id = selected_team.id;
  END IF;

  RETURN jsonb_build_object(
    'teamId', selected_team.id,
    'division', selected_team.division,
    'memberCount', current_count,
    'capacity', selected_team.division,
    'status', CASE WHEN current_count = selected_team.division THEN 'ready' ELSE 'forming' END
  );
EXCEPTION
  -- 競態：檢查後、寫入前又被別的路徑加進某隊。保守起見沿用通用碼。
  WHEN unique_violation THEN RAISE EXCEPTION 'already_in_plan_division';
END;
$join_reading_team$;

REVOKE ALL ON FUNCTION public.join_reading_team_by_code(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_reading_team_by_code(UUID, TEXT, UUID) TO authenticated, service_role;
