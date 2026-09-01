-- ============================================================================
-- 0140_region_stage_cohort_materialized_schedule.sql
-- （檔名沿用，實際內容：延後大區梯次改走「普通固定日期計畫 + 沿用獎勵」）
-- 「延後大區梯次」修正：梯次是「普通固定日期計畫 + 沿用獎勵」。
--
-- 設計定案：延後大區梯次 = 一個獨立的固定日期計畫（自己的名稱 / 起訖 / 經卷），
--   排程走一般路徑（target_books 平均鋪進 [start,end]）。**唯一**跟正式階段共用
--   的是「完成給哪個獎」——靠 rules.stageNo + rules.cohortSourceStageNo 帶著。
--   不需要 campaignDefinition / stages / segments materialize。
--
-- 事故根因：
--   1. 0128 建 cohort 列時沒有明確寫 rules.stageNo（只寫 cohortSourceStageNo），
--      前端舊版只讀 rules.stageNo → 推不出階段序 → 發獎失效 + 排程走錯路。
--   2. 若來源正式階段列的 target_books 是空的，cohort 列也空 → 一般排程路徑
--      沒有經卷可鋪 → 每天都空。
--
-- 本檔：
--   A. 還原 create_region_stage_cohort 為 0128 的簽章（若曾被改成帶 JSONB 版），
--      並在 new_rules 明確補上 stageNo；target_books 一律用來源階段列的
--      （空的話由前端退回 getChurchCampaignStageDefinition(N).books，不在此處理）。
--   B. 回填現有 cohort 列：補 rules.stageNo，target_books 空的話從來源階段列補。
--
-- 部署：Supabase SQL editor 執行（或 supabase db push）。前端（db.js /
--   church_campaign.js / utils.js / plan.js）要一起上。nlc-data 不用改。
-- ============================================================================

-- 若之前跑過帶 JSONB 參數的版本，先 DROP 掉那個 overload，回到 0128 簽章。
DROP FUNCTION IF EXISTS public.create_region_stage_cohort(TEXT, INTEGER, DATE, DATE, BOOLEAN, JSONB, UUID);
DROP FUNCTION IF EXISTS public.create_region_stage_cohort(TEXT, INTEGER, DATE, DATE, BOOLEAN, UUID);

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

  -- 沿用來源階段的 rules，明確補上 stageNo / cohortSourceStageNo（發獎靠這兩個），
  -- 疊上梯次專屬欄位。不含 stages / segments —— 梯次不走 campaign 排程機制。
  new_rules := COALESCE(src.rules, '{}'::jsonb) || jsonb_build_object(
    'planKind',            'church_campaign_stage_cohort',
    'presetKey',           preset,
    'name',                dst_name,
    'startDate',           p_start_date::TEXT,
    'endDate',             p_end_date::TEXT,
    'stageNo',             p_source_stage_no,
    'cohortRegion',        region,
    'cohortSourceStageNo', p_source_stage_no
  );
  new_rules := (new_rules - 'id') - 'stages' - 'segments';

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


-- ── 回填現有 cohort 列 ────────────────────────────────────────────────────
-- 1) rules.stageNo：缺的話從 cohortSourceStageNo 補（前端讀這個推階段序 → 發獎）。
-- 2) target_books：空的話從來源正式階段列補（前端排程靠它；空也可，前端會退回
--    getChurchCampaignStageDefinition(N).books，但盡量在 DB 補齊比較乾淨）。
DO $backfill$
DECLARE
  row_rec    RECORD;
  src_books  TEXT[];
  fixed_no   INTEGER;
  n_updated  INTEGER := 0;
BEGIN
  FOR row_rec IN
    SELECT gp.id, gp.rules, gp.target_books
    FROM public.global_plans gp
    WHERE gp.plan_kind = 'church_campaign_stage_cohort'
  LOOP
    fixed_no := COALESCE(
      NULLIF(row_rec.rules->>'stageNo', '')::INTEGER,
      NULLIF(row_rec.rules->>'cohortSourceStageNo', '')::INTEGER
    );

    IF fixed_no IS NULL THEN
      RAISE WARNING '[0140] cohort 列 % 沒有 stageNo / cohortSourceStageNo，無法回填，請從後台重新送出一次。', row_rec.id;
      CONTINUE;
    END IF;

    SELECT sp.target_books INTO src_books
    FROM public.global_plans sp
    WHERE sp.id = format('00000000-0000-0000-c026-%s', lpad(fixed_no::TEXT, 12, '0'))::UUID;

    UPDATE public.global_plans SET
      rules = (row_rec.rules - 'stages' - 'segments')
              || jsonb_build_object('stageNo', fixed_no, 'cohortSourceStageNo', fixed_no),
      target_books = CASE
        WHEN row_rec.target_books IS NULL OR cardinality(row_rec.target_books) = 0
        THEN src_books
        ELSE row_rec.target_books
      END,
      updated_at = NOW()
    WHERE id = row_rec.id;

    -- enrollment 也補 target_books（一般排程路徑靠它）
    UPDATE public.reading_plans rp SET
      target_books = CASE
        WHEN rp.target_books IS NULL OR cardinality(rp.target_books) = 0
        THEN src_books
        ELSE rp.target_books
      END,
      updated_at = NOW()
    WHERE rp.global_plan_id = row_rec.id
      AND (rp.target_books IS NULL OR cardinality(rp.target_books) = 0)
      AND src_books IS NOT NULL;

    n_updated := n_updated + 1;
    RAISE NOTICE '[0140] 回填 cohort 列 % (stageNo=%)', row_rec.id, fixed_no;
  END LOOP;
  RAISE NOTICE '[0140] 共回填 % 列 cohort 計畫。', n_updated;
END;
$backfill$;

-- ── 收尾斷言：每個 cohort 列都要有 rules.stageNo（發獎的依據）──────────────
DO $assert$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM public.global_plans
  WHERE plan_kind = 'church_campaign_stage_cohort'
    AND NULLIF(rules->>'stageNo', '') IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION '[0140] 仍有 % 列 cohort 計畫沒有 rules.stageNo。', bad_count;
  END IF;
END;
$assert$;
