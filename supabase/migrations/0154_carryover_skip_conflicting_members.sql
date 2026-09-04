-- ============================================================================
-- 0154_carryover_skip_conflicting_members.sql
--
-- 「隊長想帶隊進入下一階段，但有一位隊員已經在下一階段加入了別的隊伍」→
-- 舊版 carry_reading_teams_to_stage 一旦偵測到隊上任何一位成員在下一階段同
-- 組別已經有 membership，就整支隊伍（連同這次呼叫要處理的其他隊伍）RAISE
-- EXCEPTION 全部 rollback，隊長跟其他真心想繼續的隊員全部被卡住，且沒有指出
-- 是誰造成的、也沒有重試機制（唯一入口是 plan.js 的一次性自動彈窗）。
--
-- 改法：
--   · 偵測到某位「非隊長」成員衝突 → 只排除那個人，其餘成員照常帶入新隊伍，
--     並在回傳的 skippedMembers 裡列出被排除者的姓名，讓前端能顯示具體訊息。
--   · 若「隊長本人」在下一階段同組別已經有衝突 membership → 這支隊伍整個
--     無法帶（新隊伍一定要有隊長），列進 skippedTeams，但不影響這位隊長
--     名下其他組別（例如另一個 6 人團隊）照常帶入。
--   · 只有「候選隊伍一支都沒有」（呼叫者在上一階段根本不是任何隊伍的隊長）
--     才維持原本的 team_carryover_captain_required 例外。
--   · 冪等重跑（隊伍已經帶過一次）時，改成即時比對來源/目的隊伍名單算出
--     skippedMembers，而不是回報「不知道」。
--
-- 同時把 migration 0137 對本函式動態 patch 過的兩處也一併寫進來（避免這次
-- CREATE OR REPLACE 蓋掉那次的修正）：
--   · 目標/來源階段判斷改用 is_campaign_stage_kind()（讓大區延後梯次也適用）
--   · 來源階段比對加 audience_regions 相等守門（避免跨梯次家族誤沿用）
--
-- get_reading_team_carryover_offer 本次不需要改，維持 0058／0137 版本。
--
-- 部署：Supabase SQL editor 執行，或 `supabase db push`。純資料庫改動；
--       函式簽名不變，carry_reading_teams_to_stage 早已在 nlc-data 的
--       TEAM_RPC_FUNCTIONS allowlist，Edge Function 不需重部署。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.carry_reading_teams_to_stage(
  p_target_global_plan_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $carry_reading_teams_to_stage$
DECLARE
  actor_id UUID;
  target_plan public.global_plans%ROWTYPE;
  source_plan_id UUID;
  target_stage_no INTEGER;
  source_stage_no INTEGER;
  source_team RECORD;
  target_team public.reading_teams%ROWTYPE;
  generated_code TEXT;
  carried_teams JSONB := '[]'::JSONB;
  skipped_teams JSONB := '[]'::JSONB;
  carried_member_count INTEGER := 0;
  captain_conflict BOOLEAN;
  skipped_members JSONB;
  carried_count INTEGER;
BEGIN
  actor_id := public.resolve_reading_team_actor(p_actor_id);

  SELECT * INTO target_plan
  FROM public.global_plans
  WHERE id = p_target_global_plan_id
    AND public.is_campaign_stage_kind(plan_kind)
    AND is_hidden = FALSE
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'target_stage_not_open'; END IF;

  target_stage_no := NULLIF(target_plan.rules->>'stageNo', '')::INTEGER;
  IF target_stage_no IS NULL OR target_stage_no <= 1 THEN
    RAISE EXCEPTION 'previous_stage_not_found';
  END IF;
  source_stage_no := target_stage_no - 1;

  SELECT source_plan.id INTO source_plan_id
  FROM public.global_plans source_plan
  WHERE public.is_campaign_stage_kind(source_plan.plan_kind)
    AND NULLIF(source_plan.rules->>'stageNo', '')::INTEGER = source_stage_no
    AND COALESCE(source_plan.rules->>'parentCampaignId', '')
      = COALESCE(target_plan.rules->>'parentCampaignId', '')
    AND source_plan.audience_regions IS NOT DISTINCT FROM target_plan.audience_regions
  ORDER BY source_plan.published_at DESC NULLS LAST
  LIMIT 1;

  IF source_plan_id IS NULL THEN RAISE EXCEPTION 'previous_stage_not_found'; END IF;

  FOR source_team IN
    SELECT team.*
    FROM public.reading_teams team
    JOIN public.reading_team_members captain_membership
      ON captain_membership.team_id = team.id
     AND captain_membership.global_plan_id = team.global_plan_id
     AND captain_membership.division = team.division
    WHERE team.global_plan_id = source_plan_id
      AND team.captain_id = actor_id
      AND captain_membership.user_id = actor_id
      AND captain_membership.member_role = 'captain'
    ORDER BY team.division
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_target_global_plan_id::TEXT || ':' || source_team.id::TEXT,
        0
      )
    );

    SELECT * INTO target_team
    FROM public.reading_teams
    WHERE global_plan_id = p_target_global_plan_id
      AND carried_from_team_id = source_team.id
    FOR UPDATE;

    IF NOT FOUND THEN
      -- 隊長本人已經在下一階段同組別加入別的隊伍：新隊伍一定要有隊長，
      -- 這支隊伍整個無法帶——但不影響這位隊長名下其他組別的隊伍。
      SELECT EXISTS (
        SELECT 1
        FROM public.reading_team_members target_membership
        WHERE target_membership.global_plan_id = p_target_global_plan_id
          AND target_membership.user_id = actor_id
          AND target_membership.division = source_team.division
      ) INTO captain_conflict;

      IF captain_conflict THEN
        skipped_teams := skipped_teams || jsonb_build_array(jsonb_build_object(
          'sourceTeamId', source_team.id,
          'name', source_team.name,
          'division', source_team.division,
          'reason', 'captain_already_in_target'
        ));
        CONTINUE;
      END IF;

      -- 隊上其他成員若已經在下一階段同組別加入別的隊伍，只排除那個人，
      -- 其餘真心想繼續的隊員照常帶入——不再因為一個人卡住整隊。
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'userId', source_member.user_id,
          'name', profile.name
        )), '[]'::JSONB)
        INTO skipped_members
      FROM public.reading_team_members source_member
      JOIN public.reading_team_members target_membership
        ON target_membership.user_id = source_member.user_id
       AND target_membership.global_plan_id = p_target_global_plan_id
       AND target_membership.division = source_team.division
      JOIN public.profiles profile ON profile.id = source_member.user_id
      WHERE source_member.team_id = source_team.id
        AND source_member.user_id <> actor_id;

      LOOP
        generated_code := upper(substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 10));
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM public.reading_teams WHERE invite_code = generated_code
        );
      END LOOP;

      INSERT INTO public.reading_teams(
        global_plan_id,
        division,
        name,
        captain_id,
        invite_code,
        status,
        carried_from_team_id
      ) VALUES (
        p_target_global_plan_id,
        source_team.division,
        source_team.name,
        source_team.captain_id,
        generated_code,
        'forming',
        source_team.id
      )
      RETURNING * INTO target_team;

      INSERT INTO public.reading_team_members(
        team_id,
        global_plan_id,
        user_id,
        division,
        member_role,
        joined_at
      )
      SELECT
        target_team.id,
        p_target_global_plan_id,
        source_member.user_id,
        source_team.division,
        source_member.member_role,
        NOW()
      FROM public.reading_team_members source_member
      WHERE source_member.team_id = source_team.id
        AND (
          source_member.user_id = actor_id
          OR NOT EXISTS (
            SELECT 1
            FROM public.reading_team_members target_membership
            WHERE target_membership.global_plan_id = p_target_global_plan_id
              AND target_membership.user_id = source_member.user_id
              AND target_membership.division = source_team.division
          )
        )
      ON CONFLICT (global_plan_id, user_id, division) DO NOTHING;

      GET DIAGNOSTICS carried_count = ROW_COUNT;

      UPDATE public.reading_teams
      SET status = CASE WHEN carried_count = source_team.division THEN 'ready' ELSE 'forming' END
      WHERE id = target_team.id;

      INSERT INTO public.reading_plans(
        user_id,
        global_plan_id,
        name,
        start_date,
        end_date,
        target_books,
        preset_key,
        level,
        current_round,
        upgrade_prompt_handled,
        is_fixed
      )
      SELECT
        carried_member.user_id,
        target_plan.id,
        target_plan.name,
        target_plan.start_date,
        target_plan.end_date,
        target_plan.target_books,
        target_plan.rules->>'presetKey',
        'normal',
        1,
        FALSE,
        target_plan.is_fixed
      FROM public.reading_team_members carried_member
      WHERE carried_member.team_id = target_team.id
      ON CONFLICT (user_id, global_plan_id)
        WHERE global_plan_id IS NOT NULL
        DO NOTHING;

      carried_member_count := carried_member_count + carried_count;
    ELSE
      -- 冪等重跑：這支隊伍先前已經帶過了，即時比對來源／目的名單，
      -- 讓回傳的 skippedMembers 仍然準確反映現況（而不是回報「不知道」）。
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'userId', source_member.user_id,
          'name', profile.name
        )), '[]'::JSONB)
        INTO skipped_members
      FROM public.reading_team_members source_member
      JOIN public.profiles profile ON profile.id = source_member.user_id
      WHERE source_member.team_id = source_team.id
        AND NOT EXISTS (
          SELECT 1 FROM public.reading_team_members target_membership
          WHERE target_membership.team_id = target_team.id
            AND target_membership.user_id = source_member.user_id
        );

      SELECT COUNT(*)::INTEGER INTO carried_count
      FROM public.reading_team_members
      WHERE team_id = target_team.id;
    END IF;

    carried_teams := carried_teams || jsonb_build_array(jsonb_build_object(
      'sourceTeamId', source_team.id,
      'teamId', target_team.id,
      'name', target_team.name,
      'division', target_team.division,
      'memberCount', carried_count,
      'inviteCode', target_team.invite_code,
      'skippedMembers', skipped_members
    ));
  END LOOP;

  IF jsonb_array_length(carried_teams) = 0 THEN
    IF jsonb_array_length(skipped_teams) > 0 THEN
      -- 隊長在每個候選組別都已經自己加入下一階段的其他隊伍——沒有任何一隊
      -- 帶得動，但這不是「你不是隊長」，用不同的訊息讓前端能講清楚。
      RETURN jsonb_build_object(
        'success', TRUE,
        'targetPlanId', target_plan.id,
        'targetStageNo', target_stage_no,
        'teams', carried_teams,
        'skippedTeams', skipped_teams,
        'memberCount', 0
      );
    END IF;
    RAISE EXCEPTION 'team_carryover_captain_required';
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'targetPlanId', target_plan.id,
    'targetStageNo', target_stage_no,
    'teams', carried_teams,
    'skippedTeams', skipped_teams,
    'memberCount', carried_member_count
  );
END;
$carry_reading_teams_to_stage$;

REVOKE ALL ON FUNCTION public.carry_reading_teams_to_stage(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.carry_reading_teams_to_stage(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.carry_reading_teams_to_stage(UUID, UUID) IS
  'Carries a captain''s previous-stage team roster into the next open stage. A member who already joined a different team in the target stage is skipped individually (reported in skippedMembers) rather than blocking the whole team; if the captain themselves conflicts, that one team is skipped (reported in skippedTeams) without affecting the captain''s other-division team.';
