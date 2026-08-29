-- ============================================================================
-- 0128_create_region_stage_cohort.sql
-- 「延後大區梯次」第 3 步：後台建立 cohort 階段計畫的 RPC。
--
--   create_region_stage_cohort(great_region, source_stage_no, start_date, end_date,
--                              is_hidden, actor_id)
--     · admin / pastor（nlc-data 端另會用 isAdmin 收緊成 admin）
--     · 從正式階段 …c026-00000000000N 複製 target_books / rules（含 stageNo，發獎用）
--       / description，套上新的名稱、日期、plan_kind='church_campaign_stage_cohort'、
--       audience_regions = {great_region}、獨立 presetKey。
--     · 以 (audience_regions, rules.stageNo) 冪等：已存在 → 更新日期 / 開放狀態，
--       並同步既有 enrollment 的排程日期。
--
-- 假設：一次一個大區。若日後同一階段要給多個大區各自梯次，presetKey 需再帶區名。
-- 部署：Supabase SQL editor 執行。nlc-data 需把 create_region_stage_cohort
--       加進 ADMIN_RPC_FUNCTIONS + p_actor_id 注入清單，並重新部署。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_region_stage_cohort(
  p_great_region    TEXT,
  p_source_stage_no INTEGER,
  p_start_date      DATE,
  p_end_date        DATE,
  p_is_hidden       BOOLEAN DEFAULT TRUE,
  p_actor_id        UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id   UUID;
  actor_role TEXT;
  region     TEXT := BTRIM(COALESCE(p_great_region, ''));
  src_id     UUID;
  src        public.global_plans%ROWTYPE;
  dst_id     UUID;
  dst_name   TEXT;
  preset     TEXT := 'church_stage_cohort_' || lpad(COALESCE(p_source_stage_no, 0)::TEXT, 2, '0');
  new_rules  JSONB;
  did_create BOOLEAN := FALSE;
BEGIN
  IF p_actor_id IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'actor_override_forbidden';
  END IF;
  actor_id := COALESCE(p_actor_id, public.current_profile_id());
  actor_role := COALESCE(
    public.role_code((SELECT role_id FROM public.profiles WHERE id = actor_id)), 'member');
  IF actor_role NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  IF region = '' THEN RAISE EXCEPTION 'great_region_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.great_regions WHERE name = region) THEN
    RAISE EXCEPTION 'great_region_not_found: %', region;
  END IF;
  IF p_source_stage_no IS NULL OR p_source_stage_no < 1 OR p_source_stage_no > 10 THEN
    RAISE EXCEPTION 'invalid_stage_no';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'invalid_date_range';
  END IF;

  src_id := format('00000000-0000-0000-c026-%s', lpad(p_source_stage_no::TEXT, 12, '0'))::UUID;
  SELECT * INTO src FROM public.global_plans
  WHERE id = src_id AND plan_kind = 'church_campaign_stage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_stage_not_found: %', p_source_stage_no;
  END IF;

  dst_name := src.name || '（' || region || '延後梯次）';

  new_rules := COALESCE(src.rules, '{}'::jsonb) || jsonb_build_object(
    'planKind',            'church_campaign_stage_cohort',
    'presetKey',           preset,
    'name',                dst_name,
    'startDate',           p_start_date::TEXT,
    'endDate',             p_end_date::TEXT,
    'cohortRegion',        region,
    'cohortSourceStageNo', p_source_stage_no
  );
  new_rules := new_rules - 'id';

  SELECT id INTO dst_id FROM public.global_plans
  WHERE plan_kind = 'church_campaign_stage_cohort'
    AND audience_regions = ARRAY[region]
    AND (rules->>'stageNo')::INTEGER = p_source_stage_no
  LIMIT 1;

  IF dst_id IS NULL THEN
    dst_id := gen_random_uuid();
    INSERT INTO public.global_plans (
      id, name, description, start_date, end_date, target_books,
      is_hidden, is_fixed, plan_kind, rules, rule_version, published_at,
      audience_regions, created_by
    ) VALUES (
      dst_id, dst_name, src.description, p_start_date, p_end_date, src.target_books,
      COALESCE(p_is_hidden, TRUE), TRUE, 'church_campaign_stage_cohort',
      new_rules, COALESCE(src.rule_version, 1), NOW(),
      ARRAY[region], actor_id
    );
    did_create := TRUE;
  ELSE
    UPDATE public.global_plans SET
      name         = dst_name,
      description  = src.description,
      start_date   = p_start_date,
      end_date     = p_end_date,
      target_books = src.target_books,
      is_hidden    = COALESCE(p_is_hidden, is_hidden),
      rules        = new_rules,
      updated_at   = NOW()
    WHERE id = dst_id;

    UPDATE public.reading_plans SET
      name         = dst_name,
      start_date   = p_start_date,
      end_date     = p_end_date,
      target_books = src.target_books,
      preset_key   = preset,
      updated_at   = NOW()
    WHERE global_plan_id = dst_id;
  END IF;

  RETURN jsonb_build_object(
    'planId', dst_id, 'created', did_create, 'name', dst_name,
    'stageNo', p_source_stage_no, 'region', region,
    'isHidden', COALESCE(p_is_hidden, TRUE)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_region_stage_cohort(TEXT, INTEGER, DATE, DATE, BOOLEAN, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_region_stage_cohort(TEXT, INTEGER, DATE, DATE, BOOLEAN, UUID) TO authenticated, service_role;
