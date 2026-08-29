-- ============================================================================
-- 0127_region_cohort_stage_gates.sql
-- 「延後大區梯次」第 2 步：閘門。
--   · assert_campaign_stage_open：
--       (a) 新增 audience_regions 檢查——非空且 actor 不在名單、也不是
--           admin/pastor → RAISE 'plan_audience_restricted'。
--       (b) 隱藏階段的擋人邏輯，plan_kind 從 = 'church_campaign_stage'
--           擴為 IN ('church_campaign_stage', 'church_campaign_stage_cohort')。
--     （此函式已由 0056 掛在 reading_plans / reading_logs / reading_teams /
--       reading_team_members / small_home_teams(_members) 的 BEFORE trigger 上，
--       trigger 不用重掛。）
--   · enforce_reading_log_stage_progress_open：同樣把 plan_kind 判斷擴為
--     IN (...)，讓 cohort 階段也受「is_hidden 或 今天 < start_date 就擋打卡」。
--
-- 純 CREATE OR REPLACE，無 signature / trigger 變更。
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assert_campaign_stage_open(
  target_global_plan_id UUID,
  actor_profile_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $assert_stage_open$
DECLARE
  target_plan  public.global_plans%ROWTYPE;
  actor_role   TEXT;
  actor_region TEXT;
BEGIN
  IF target_global_plan_id IS NULL THEN RETURN; END IF;

  SELECT * INTO target_plan
  FROM public.global_plans
  WHERE id = target_global_plan_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT public.role_code(profile.role_id), NULLIF(BTRIM(profile.great_region), '')
    INTO actor_role, actor_region
  FROM public.profiles profile
  WHERE profile.id = actor_profile_id;
  actor_role := COALESCE(actor_role, 'member');

  -- (a) 對象大區限制：非空 audience_regions，且 actor 不是全教會角色、也不在名單 → 擋
  IF target_plan.audience_regions IS NOT NULL
     AND cardinality(target_plan.audience_regions) > 0
     AND actor_role NOT IN ('admin', 'pastor')
     AND NOT (COALESCE(actor_region, '') = ANY(target_plan.audience_regions))
  THEN
    RAISE EXCEPTION 'plan_audience_restricted' USING ERRCODE = 'P0001';
  END IF;

  -- (b) 隱藏的階段（正式或延後梯次）：非 admin 一律擋
  IF target_plan.plan_kind IN ('church_campaign_stage', 'church_campaign_stage_cohort')
     AND target_plan.is_hidden
     AND actor_role <> 'admin'
  THEN
    RAISE EXCEPTION 'campaign_stage_not_open' USING ERRCODE = 'P0001';
  END IF;
END;
$assert_stage_open$;
REVOKE ALL ON FUNCTION public.assert_campaign_stage_open(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_campaign_stage_open(UUID, UUID) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.enforce_reading_log_stage_progress_open()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $enforce_reading_log_stage_progress_open$
DECLARE
  target_plan public.global_plans%ROWTYPE;
  enrollment_user_id UUID;
BEGIN
  IF NEW.plan_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enrollment.user_id INTO enrollment_user_id
  FROM public.reading_plans enrollment
  WHERE enrollment.id = NEW.plan_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF enrollment_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'reading_log_plan_owner_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT global_plan.* INTO target_plan
  FROM public.reading_plans enrollment
  JOIN public.global_plans global_plan ON global_plan.id = enrollment.global_plan_id
  WHERE enrollment.id = NEW.plan_id;

  IF NOT FOUND
     OR target_plan.plan_kind NOT IN ('church_campaign_stage', 'church_campaign_stage_cohort') THEN
    RETURN NEW;
  END IF;

  IF target_plan.is_hidden
     OR (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::DATE < target_plan.start_date THEN
    RAISE EXCEPTION 'campaign_stage_progress_not_open' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$enforce_reading_log_stage_progress_open$;
REVOKE ALL ON FUNCTION public.enforce_reading_log_stage_progress_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_reading_log_stage_progress_open() TO authenticated, service_role;
