-- ============================================================================
-- 0140_region_stage_cohort_materialized_schedule.sql
-- 「延後大區梯次」修正：把壓縮後的排程 materialize 進 global_plans.rules。
--
-- 事故：0128 的 create_region_stage_cohort 複製 src.rules 時，rules 裡沒有
--   stages[] / segments[] 陣列（那些活在前端 CHURCH_CAMPAIGN.segments）。
--   前端 mapGlobalPlanRecord 因此退回 getChurchCampaignStageDefinition(N)——
--   canonical 定義的日期還停在原始月份（例：階段 1 = 8/1~8/31、創世記），
--   plan.days 整個生在錯的月份，桃園梯次 9 月每天都「補讀與休息日」、0/0。
--
-- 修法（決策：梯次 = 一個日曆月，把來源階段整份經卷壓進 [start,end]、
--   examDate 清 null 由領袖日後自訂、每列獨立算）：
--   1. create_region_stage_cohort 新增 p_cohort_definition JSONB——前端用
--      buildCohortStageDefinition(sourceStage, start, end) 算好（單一 segment
--      涵蓋整個視窗、stages[0] 起訖 = 視窗、examDate = null），後端只驗證 +
--      存進 rules，並以它的起訖為 row 的 start_date / end_date。
--   2. 回填現有那一列（桃園｜階段 1｜創世記 1-50）的 rules.stages / rules.segments。
--   3. 收尾斷言：任何 cohort 列若 rules 仍缺 segments → migration 失敗。
--
-- 部署：Supabase SQL editor 執行（或 supabase db push）。
--   前端（buildCohortStageDefinition + mapGlobalPlanRecord 保底）要先上線；
--   本檔後上。nlc-data 不用改（create_region_stage_cohort 已在 allowlist，
--   p_cohort_definition 走 body.args 直接轉發，p_actor_id 仍自動注入）。
-- ============================================================================

-- 舊 5+1 參數簽章要先 DROP，否則新的 5+2 參數會變成 overload、命名參數呼叫時 ambiguous。
DROP FUNCTION IF EXISTS public.create_region_stage_cohort(TEXT, INTEGER, DATE, DATE, BOOLEAN, UUID);

CREATE OR REPLACE FUNCTION public.create_region_stage_cohort(
  p_great_region      TEXT,
  p_source_stage_no   INTEGER,
  p_start_date        DATE,
  p_end_date          DATE,
  p_is_hidden         BOOLEAN DEFAULT TRUE,
  p_cohort_definition JSONB   DEFAULT NULL,
  p_actor_id          UUID    DEFAULT NULL
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
  def        JSONB := p_cohort_definition;
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

  -- 排程定義必須由前端 buildCohortStageDefinition 算好帶進來。
  IF def IS NULL OR jsonb_typeof(def) <> 'object' THEN
    RAISE EXCEPTION 'cohort_definition_required';
  END IF;
  IF jsonb_typeof(def->'stages') <> 'array' OR jsonb_array_length(def->'stages') < 1
     OR jsonb_typeof(def->'segments') <> 'array' OR jsonb_array_length(def->'segments') < 1 THEN
    RAISE EXCEPTION 'cohort_definition_malformed';
  END IF;
  IF (def->>'startDate') <> p_start_date::TEXT OR (def->>'endDate') <> p_end_date::TEXT THEN
    RAISE EXCEPTION 'cohort_definition_window_mismatch: def % ~ %, args % ~ %',
      def->>'startDate', def->>'endDate', p_start_date, p_end_date;
  END IF;
  IF NULLIF(def->'examDate', 'null'::jsonb) IS NOT NULL
     OR NULLIF(def->'stages'->0->'examDate', 'null'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION 'cohort_definition_exam_date_must_be_null';
  END IF;

  src_id := format('00000000-0000-0000-c026-%s', lpad(p_source_stage_no::TEXT, 12, '0'))::UUID;
  SELECT * INTO src FROM public.global_plans
  WHERE id = src_id AND plan_kind = 'church_campaign_stage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_stage_not_found: %', p_source_stage_no;
  END IF;

  dst_name := src.name || '（' || region || '延後梯次）';

  -- rules = 前端算好的完整壓縮定義（含 stages/segments/startDate/endDate/examDate=null）
  --         疊上梯次專屬欄位。stageNo 明確保留（發獎 + 冪等 key 都靠它）。
  new_rules := (def - 'id') || jsonb_build_object(
    'planKind',            'church_campaign_stage_cohort',
    'presetKey',           preset,
    'name',                dst_name,
    'stageNo',             p_source_stage_no,
    'cohortRegion',        region,
    'cohortSourceStageNo', p_source_stage_no
  );

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

REVOKE ALL ON FUNCTION public.create_region_stage_cohort(TEXT, INTEGER, DATE, DATE, BOOLEAN, JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_region_stage_cohort(TEXT, INTEGER, DATE, DATE, BOOLEAN, JSONB, UUID) TO authenticated, service_role;


-- ── 回填：現有沒有 materialize segments 的 cohort 列 ─────────────────────────
-- 目前正式站只有「桃園｜階段 1」一列。階段 1 的排程 = 創世記 1-50（Genesis 剛好
-- 50 章），單一 segment 涵蓋該列自己的 [start_date, end_date]、examDate = null。
-- 其他 stageNo 的 cohort 列（若有）無法在 SQL 端安全重建經卷清單 → 留給操作者
-- 從後台「延後大區梯次」重新送出一次（前端已會帶 p_cohort_definition）。
DO $backfill$
DECLARE
  row_rec   RECORD;
  seg       JSONB;
  stg       JSONB;
BEGIN
  FOR row_rec IN
    SELECT id, name, start_date, end_date, rules
    FROM public.global_plans
    WHERE plan_kind = 'church_campaign_stage_cohort'
      AND (jsonb_typeof(rules->'segments') <> 'array'
           OR jsonb_array_length(COALESCE(rules->'segments', '[]'::jsonb)) < 1)
  LOOP
    IF (row_rec.rules->>'stageNo')::INTEGER = 1 THEN
      seg := jsonb_build_array(jsonb_build_object(
        'stageNo',   1,
        'roundNo',   1,
        'label',     row_rec.name,
        'startDate', row_rec.start_date::TEXT,
        'endDate',   row_rec.end_date::TEXT,
        'readings',  jsonb_build_array(jsonb_build_object('book', '創世記', 'from', 1, 'to', 50))
      ));
      stg := jsonb_build_array(jsonb_build_object(
        'stageNo',   1,
        'roundNo',   1,
        'phase',     'warmup',
        'name',      '第一輪熱身賽',
        'startDate', row_rec.start_date::TEXT,
        'endDate',   row_rec.end_date::TEXT,
        'awardName', '磐石獎',
        'examDate',  NULL
      ));
      UPDATE public.global_plans SET
        rules = row_rec.rules || jsonb_build_object(
          'startDate', row_rec.start_date::TEXT,
          'endDate',   row_rec.end_date::TEXT,
          'examDate',  NULL,
          'stages',    stg,
          'segments',  seg
        ),
        updated_at = NOW()
      WHERE id = row_rec.id;
      RAISE NOTICE '[0140] 已回填 cohort 列 % (%%)', row_rec.id, row_rec.name;
    ELSE
      RAISE WARNING '[0140] cohort 列 % (stageNo=%) 無法在 SQL 端回填，請從後台「延後大區梯次」重新送出一次。',
        row_rec.id, row_rec.rules->>'stageNo';
    END IF;
  END LOOP;
END;
$backfill$;

-- ── 收尾斷言：任何 stageNo=1 的 cohort 列若仍缺 segments → migration 失敗 ──
DO $assert$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM public.global_plans
  WHERE plan_kind = 'church_campaign_stage_cohort'
    AND (rules->>'stageNo')::INTEGER = 1
    AND (jsonb_typeof(rules->'segments') <> 'array'
         OR jsonb_array_length(COALESCE(rules->'segments', '[]'::jsonb)) < 1);
  IF bad_count > 0 THEN
    RAISE EXCEPTION '[0140] 仍有 % 列 stageNo=1 的 cohort 計畫沒有 materialize segments。', bad_count;
  END IF;
END;
$assert$;
