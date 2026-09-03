-- 0151_drop_phantom_aggregate_stage2.sql
--
-- 背景：
--   0017 的 trigger `sync_church_campaign_stage_plans()` 會把 master 教會計畫
--   (c026-…2029) 的 rules->'stages' 每一階段展開成一列 global_plans。
--   其中「第2階段｜第一輪期末賽」(c026-…000000000002) 後來已被拆成 4 場
--   月度期末賽（c126 命名空間，2026-09 ~ 2026-12），聚合版那一列變成幽靈資料：
--   不會出現在會友端探索清單（前端已過濾），但仍出現在後台計畫管理／報名統計
--   等直接讀 global_plans 的地方。
--
-- 這支 migration：
--   1. CREATE OR REPLACE trigger 函式，讓它在 stageNo = 2 時直接跳過，
--      之後 master 計畫再被重存也不會又長回這列。
--   2. 清掉現存的 c026-…000000000002 幽靈列與其附屬資料。
--
-- 冪等：可重複執行。

BEGIN;

------------------------------------------------------------------------
-- 1. Trigger 函式：跳過 stageNo = 2（聚合期末賽已拆成月度賽）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_church_campaign_stage_plans()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  stage JSONB;
  stage_segments JSONB;
  stage_definition JSONB;
  stage_no INTEGER;
  stage_id UUID;
  stage_name TEXT;
  stage_books TEXT[];
BEGIN
  IF NEW.id <> '00000000-0000-0000-c026-000000002029'::UUID
     OR NEW.plan_kind <> 'church_campaign'
     OR jsonb_typeof(NEW.rules->'stages') <> 'array'
     OR jsonb_typeof(NEW.rules->'segments') <> 'array' THEN
    RETURN NEW;
  END IF;

  FOR stage IN SELECT value FROM jsonb_array_elements(NEW.rules->'stages')
  LOOP
    stage_no := (stage->>'stageNo')::INTEGER;

    -- 第2階段（第一輪期末賽）已拆成 4 場月度期末賽（c126 命名空間），
    -- 不再產生聚合版的 c026-…000000000002。
    IF stage_no = 2 THEN
      CONTINUE;
    END IF;

    stage_id := format('00000000-0000-0000-c026-%s', lpad(stage_no::TEXT, 12, '0'))::UUID;
    stage_name := '第' || stage_no || '階段｜' || stage->>'name';

    SELECT COALESCE(jsonb_agg(segment ORDER BY segment->>'startDate'), '[]'::JSONB)
      INTO stage_segments
    FROM jsonb_array_elements(NEW.rules->'segments') segment
    WHERE (segment->>'stageNo')::INTEGER = stage_no;

    SELECT COALESCE(array_agg(DISTINCT reading->>'book'), ARRAY[]::TEXT[])
      INTO stage_books
    FROM jsonb_array_elements(stage_segments) segment
    CROSS JOIN LATERAL jsonb_array_elements(segment->'readings') reading;

    stage_definition := jsonb_build_object(
      'id', stage_id::TEXT,
      'parentCampaignId', NEW.id::TEXT,
      'presetKey', 'church_stage_' || lpad(stage_no::TEXT, 2, '0'),
      'planKind', 'church_campaign_stage',
      'name', stage_name,
      'description', stage->>'name' || '，完成本階段可獲得「' || stage->>'awardName' || '」。',
      'startDate', stage->>'startDate',
      'endDate', stage->>'endDate',
      'isFixed', TRUE,
      'version', NEW.rule_version,
      'stageNo', stage_no,
      'roundNo', (stage->>'roundNo')::INTEGER,
      'phase', stage->>'phase',
      'awardName', stage->>'awardName',
      'examDate', stage->'examDate',
      'rules', NEW.rules->'rules',
      'stages', jsonb_build_array(stage),
      'segments', stage_segments,
      'books', to_jsonb(stage_books)
    );

    INSERT INTO public.global_plans(
      id, name, description, start_date, end_date, target_books,
      is_hidden, is_fixed, plan_kind, rules, rule_version, published_at
    ) VALUES (
      stage_id, stage_name, stage_definition->>'description',
      (stage->>'startDate')::DATE, (stage->>'endDate')::DATE, stage_books,
      FALSE, TRUE, 'church_campaign_stage', stage_definition, NEW.rule_version, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      target_books = EXCLUDED.target_books,
      is_hidden = FALSE,
      is_fixed = TRUE,
      plan_kind = 'church_campaign_stage',
      rules = EXCLUDED.rules,
      rule_version = EXCLUDED.rule_version,
      published_at = EXCLUDED.published_at;

    UPDATE public.reading_plans
    SET name = stage_name,
        start_date = (stage->>'startDate')::DATE,
        end_date = (stage->>'endDate')::DATE,
        target_books = stage_books,
        preset_key = 'church_stage_' || lpad(stage_no::TEXT, 2, '0'),
        is_fixed = TRUE
    WHERE global_plan_id = stage_id;
  END LOOP;

  RETURN NEW;
END;
$$;

------------------------------------------------------------------------
-- 2. 清掉現存的幽靈聚合列與附屬資料
------------------------------------------------------------------------
DO $$
DECLARE
  phantom_id CONSTANT UUID := '00000000-0000-0000-c026-000000000002'::UUID;
  n_plans      INTEGER := 0;
  n_teams      INTEGER := 0;
  n_members    INTEGER := 0;
  n_home       INTEGER := 0;
  n_reading    INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.global_plans WHERE id = phantom_id) THEN
    RAISE NOTICE '0151: 幽靈列 % 不存在，略過清理。', phantom_id;
    RETURN;
  END IF;

  -- 個人計畫（reading_plans.global_plan_id 為 ON DELETE SET NULL，
  -- 若直接刪 global_plans 會留下孤兒個人計畫，這裡明確刪除）。
  -- reading_logs 以 reading_plan_id 關聯，會隨 reading_plans 一併處理。
  SELECT count(*) INTO n_reading
  FROM public.reading_plans WHERE global_plan_id = phantom_id;

  SELECT count(*) INTO n_members
  FROM public.reading_team_members WHERE global_plan_id = phantom_id;

  SELECT count(*) INTO n_teams
  FROM public.reading_teams WHERE global_plan_id = phantom_id;

  BEGIN
    SELECT count(*) INTO n_home
    FROM public.small_home_teams WHERE global_plan_id = phantom_id;
  EXCEPTION WHEN undefined_table THEN
    n_home := 0;
  END;

  RAISE NOTICE '0151: 準備清理幽靈列 % — reading_plans=%, reading_teams=%, team_members=%, small_home_teams=%',
    phantom_id, n_reading, n_teams, n_members, n_home;

  -- 明確刪除個人計畫（連帶 reading_logs 由該表自身的 FK CASCADE 處理）
  DELETE FROM public.reading_plans WHERE global_plan_id = phantom_id;
  GET DIAGNOSTICS n_plans = ROW_COUNT;

  -- 其餘子表（reading_teams / reading_team_members / registrations /
  -- daily quizzes 等）皆為 ON DELETE CASCADE，隨下面這句一併清除。
  DELETE FROM public.global_plans WHERE id = phantom_id;

  RAISE NOTICE '0151: 已刪除幽靈列 %（個人計畫 % 列，其餘子表由 CASCADE 清除）。',
    phantom_id, n_plans;
END $$;

COMMIT;
