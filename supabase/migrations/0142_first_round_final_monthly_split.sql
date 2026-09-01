-- ============================================================================
-- 0142_first_round_final_monthly_split.sql
-- 教會計畫大調整：第一輪期末賽（stageNo 2）從「一段 2026-09 ~ 12」拆成
-- 4 個月度計畫，只保留 9 月（出埃及記）的資料，其餘清除。
--
--   9 月  出埃及記  church_r1final_2026_09  開放（is_hidden = FALSE）
--   10 月 利未記    church_r1final_2026_10  鎖住（探索清單可見、不可加入）
--   11 月 民數記    church_r1final_2026_11  鎖住
--   12 月 申命記    church_r1final_2026_12  鎖住，帶期末測驗 2026-12-27
--
-- 4 張都掛 rules.stageNo = 2（沿用鐵獎）＋ rules.discoverWhenLocked = true
-- （鎖住時仍出現在探索清單）。第三階段之後（c026 …03~…10）維持 is_hidden = TRUE，
-- 且沒有 discoverWhenLocked → 前端完全隱藏，等系統管理員逐一開放。
--
-- 前端（church_campaign.js / state.js / utils.js / db.js / plan.js）要先上線，
-- 再跑本檔。Supabase SQL editor 執行。冪等（可重跑）。
-- ============================================================================

BEGIN;

-- ── A. 建立 4 個月度期末賽計畫列 ─────────────────────────────────────────────
-- 首次建立時帶入預定的 is_hidden；之後重跑一律保留管理員當下的可見性選擇。
INSERT INTO public.global_plans(
  id, name, description, start_date, end_date, target_books,
  is_hidden, is_fixed, plan_kind, rules, rule_version, published_at
) VALUES
(
  '00000000-0000-0000-c126-000000202609'::UUID,
  '第一輪期末賽｜2026年9月・出埃及記',
  '2026年9月讀出埃及記；連同 9–12 月四個月全部完成可獲得「鐵獎」。',
  '2026-09-01'::DATE, '2026-09-30'::DATE, ARRAY['出埃及記']::TEXT[],
  FALSE, TRUE, 'church_campaign_stage',
  '{"id":"00000000-0000-0000-c126-000000202609","parentCampaignId":"00000000-0000-0000-c026-000000002029","presetKey":"church_r1final_2026_09","planKind":"church_campaign_stage","name":"第一輪期末賽｜2026年9月・出埃及記","description":"2026年9月讀出埃及記；連同 9–12 月四個月全部完成可獲得「鐵獎」。","startDate":"2026-09-01","endDate":"2026-09-30","isFixed":true,"isHidden":false,"version":1,"stageNo":2,"roundNo":1,"phase":"final","awardName":"鐵獎","examDate":null,"discoverWhenLocked":true,"rules":{"allowMidJoin":true,"sequentialAwards":true,"applyChangesFrom":"future_only","teamRules":{"personal":{"min":1,"max":1,"source":"self"},"smallHome":{"min":2,"max":4,"source":"registration"},"smallGroup":{"min":6,"max":null,"source":"profile.small_group"}}},"stages":[{"stageNo":2,"roundNo":1,"phase":"final","name":"第一輪期末賽","startDate":"2026-09-01","endDate":"2026-09-30","awardName":"鐵獎","examDate":null}],"segments":[{"stageNo":2,"roundNo":1,"label":"2026年9月","startDate":"2026-09-01","endDate":"2026-09-30","readings":[{"book":"出埃及記","from":1,"to":40}]}],"books":["出埃及記"]}'::JSONB,
  1, NOW()
),
(
  '00000000-0000-0000-c126-000000202610'::UUID,
  '第一輪期末賽｜2026年10月・利未記',
  '2026年10月讀利未記；連同 9–12 月四個月全部完成可獲得「鐵獎」。',
  '2026-10-01'::DATE, '2026-10-31'::DATE, ARRAY['利未記']::TEXT[],
  TRUE, TRUE, 'church_campaign_stage',
  '{"id":"00000000-0000-0000-c126-000000202610","parentCampaignId":"00000000-0000-0000-c026-000000002029","presetKey":"church_r1final_2026_10","planKind":"church_campaign_stage","name":"第一輪期末賽｜2026年10月・利未記","description":"2026年10月讀利未記；連同 9–12 月四個月全部完成可獲得「鐵獎」。","startDate":"2026-10-01","endDate":"2026-10-31","isFixed":true,"isHidden":true,"version":1,"stageNo":2,"roundNo":1,"phase":"final","awardName":"鐵獎","examDate":null,"discoverWhenLocked":true,"rules":{"allowMidJoin":true,"sequentialAwards":true,"applyChangesFrom":"future_only","teamRules":{"personal":{"min":1,"max":1,"source":"self"},"smallHome":{"min":2,"max":4,"source":"registration"},"smallGroup":{"min":6,"max":null,"source":"profile.small_group"}}},"stages":[{"stageNo":2,"roundNo":1,"phase":"final","name":"第一輪期末賽","startDate":"2026-10-01","endDate":"2026-10-31","awardName":"鐵獎","examDate":null}],"segments":[{"stageNo":2,"roundNo":1,"label":"2026年10月","startDate":"2026-10-01","endDate":"2026-10-31","readings":[{"book":"利未記","from":1,"to":27}]}],"books":["利未記"]}'::JSONB,
  1, NOW()
),
(
  '00000000-0000-0000-c126-000000202611'::UUID,
  '第一輪期末賽｜2026年11月・民數記',
  '2026年11月讀民數記；連同 9–12 月四個月全部完成可獲得「鐵獎」。',
  '2026-11-01'::DATE, '2026-11-30'::DATE, ARRAY['民數記']::TEXT[],
  TRUE, TRUE, 'church_campaign_stage',
  '{"id":"00000000-0000-0000-c126-000000202611","parentCampaignId":"00000000-0000-0000-c026-000000002029","presetKey":"church_r1final_2026_11","planKind":"church_campaign_stage","name":"第一輪期末賽｜2026年11月・民數記","description":"2026年11月讀民數記；連同 9–12 月四個月全部完成可獲得「鐵獎」。","startDate":"2026-11-01","endDate":"2026-11-30","isFixed":true,"isHidden":true,"version":1,"stageNo":2,"roundNo":1,"phase":"final","awardName":"鐵獎","examDate":null,"discoverWhenLocked":true,"rules":{"allowMidJoin":true,"sequentialAwards":true,"applyChangesFrom":"future_only","teamRules":{"personal":{"min":1,"max":1,"source":"self"},"smallHome":{"min":2,"max":4,"source":"registration"},"smallGroup":{"min":6,"max":null,"source":"profile.small_group"}}},"stages":[{"stageNo":2,"roundNo":1,"phase":"final","name":"第一輪期末賽","startDate":"2026-11-01","endDate":"2026-11-30","awardName":"鐵獎","examDate":null}],"segments":[{"stageNo":2,"roundNo":1,"label":"2026年11月","startDate":"2026-11-01","endDate":"2026-11-30","readings":[{"book":"民數記","from":1,"to":36}]}],"books":["民數記"]}'::JSONB,
  1, NOW()
),
(
  '00000000-0000-0000-c126-000000202612'::UUID,
  '第一輪期末賽｜2026年12月・申命記',
  '2026年12月讀申命記；連同 9–12 月四個月全部完成可獲得「鐵獎」。',
  '2026-12-01'::DATE, '2026-12-31'::DATE, ARRAY['申命記']::TEXT[],
  TRUE, TRUE, 'church_campaign_stage',
  '{"id":"00000000-0000-0000-c126-000000202612","parentCampaignId":"00000000-0000-0000-c026-000000002029","presetKey":"church_r1final_2026_12","planKind":"church_campaign_stage","name":"第一輪期末賽｜2026年12月・申命記","description":"2026年12月讀申命記；連同 9–12 月四個月全部完成可獲得「鐵獎」。","startDate":"2026-12-01","endDate":"2026-12-31","isFixed":true,"isHidden":true,"version":1,"stageNo":2,"roundNo":1,"phase":"final","awardName":"鐵獎","examDate":"2026-12-27","discoverWhenLocked":true,"rules":{"allowMidJoin":true,"sequentialAwards":true,"applyChangesFrom":"future_only","teamRules":{"personal":{"min":1,"max":1,"source":"self"},"smallHome":{"min":2,"max":4,"source":"registration"},"smallGroup":{"min":6,"max":null,"source":"profile.small_group"}}},"stages":[{"stageNo":2,"roundNo":1,"phase":"final","name":"第一輪期末賽","startDate":"2026-12-01","endDate":"2026-12-31","awardName":"鐵獎","examDate":"2026-12-27"}],"segments":[{"stageNo":2,"roundNo":1,"label":"2026年12月","startDate":"2026-12-01","endDate":"2026-12-31","readings":[{"book":"申命記","from":1,"to":34}]}],"books":["申命記"]}'::JSONB,
  1, NOW()
)
ON CONFLICT (id) DO UPDATE SET
  name         = EXCLUDED.name,
  description  = EXCLUDED.description,
  start_date   = EXCLUDED.start_date,
  end_date     = EXCLUDED.end_date,
  target_books = EXCLUDED.target_books,
  -- 保留管理員當下的 is_hidden（開放/鎖住由後台控制），只在首次建立時吃預設值
  is_fixed     = TRUE,
  plan_kind    = 'church_campaign_stage',
  rules        = EXCLUDED.rules,
  rule_version = EXCLUDED.rule_version,
  updated_at   = NOW();


-- ── B~D. 把舊第二階段的資料只保留 9 月（出埃及記），其餘清除 ──────────────────
-- 遷移期間關掉 stage-open 觸發器與 FK/RLS，避免搬移中途被 gate 擋下。
SET session_replication_role = replica;

-- B. 舊 stage-2 的 enrollment / 團隊 → 改指 9 月出埃及記
UPDATE public.reading_plans SET
  global_plan_id = '00000000-0000-0000-c126-000000202609'::UUID,
  preset_key     = 'church_r1final_2026_09',
  name           = '第一輪期末賽｜2026年9月・出埃及記',
  start_date     = '2026-09-01'::DATE,
  end_date       = '2026-09-30'::DATE,
  target_books   = ARRAY['出埃及記']::TEXT[],
  updated_at     = NOW()
WHERE global_plan_id = '00000000-0000-0000-c026-000000000002'::UUID;

UPDATE public.reading_teams SET global_plan_id = '00000000-0000-0000-c126-000000202609'::UUID
WHERE global_plan_id = '00000000-0000-0000-c026-000000000002'::UUID;
UPDATE public.reading_team_members SET global_plan_id = '00000000-0000-0000-c126-000000202609'::UUID
WHERE global_plan_id = '00000000-0000-0000-c026-000000000002'::UUID;
UPDATE public.small_home_teams SET global_plan_id = '00000000-0000-0000-c126-000000202609'::UUID
WHERE global_plan_id = '00000000-0000-0000-c026-000000000002'::UUID;

-- C. 這些 enrollment 上非「出埃及記」的打卡（利/民/申等）→ 刪除
DELETE FROM public.reading_logs
WHERE plan_id IN (
  SELECT id FROM public.reading_plans
  WHERE global_plan_id = '00000000-0000-0000-c126-000000202609'::UUID
)
AND book <> '出埃及記';

-- D. 停用舊 stage-2 定義列（已被 4 個月度計畫取代）。
UPDATE public.global_plans SET
  name        = '第2階段｜第一輪期末賽（已由 9–12 月四個月度計畫取代）',
  description = '此階段已拆成 church_r1final_2026_09 ~ _12 四個月度計畫；本列僅保留為歷史記錄。',
  is_hidden   = TRUE,
  rules       = COALESCE(rules, '{}'::jsonb) || jsonb_build_object('supersededBy', 'monthly_finals_2026', 'discoverWhenLocked', FALSE),
  updated_at  = NOW()
WHERE id = '00000000-0000-0000-c026-000000000002'::UUID;

SET session_replication_role = DEFAULT;


-- ── E. sync_church_campaign_stage_plans 跳過 stageNo 2 ─────────────────────
-- 之後若發佈新的 campaign 規則，這個 trigger 不會再重建 c026-…02。
-- 其餘與 0056 版一致（ON CONFLICT 保留 is_hidden）。
CREATE OR REPLACE FUNCTION public.sync_church_campaign_stage_plans()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $sync_stage_plans$
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

    -- 第一輪期末賽（stageNo 2）已改由 church_r1final_2026_09 ~ _12 四個月度計畫負責，
    -- 不再重建 c026-…02。
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
      stage_no <> 1, TRUE, 'church_campaign_stage', stage_definition, NEW.rule_version, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      target_books = EXCLUDED.target_books,
      -- Deliberately preserve global_plans.is_hidden. It is controlled by admin.
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
$sync_stage_plans$;


-- ── F. 第三階段之後（c026 …03 ~ …10）維持隱藏 ─────────────────────────────
UPDATE public.global_plans SET is_hidden = TRUE, updated_at = NOW()
WHERE id BETWEEN '00000000-0000-0000-c026-000000000003'::UUID
            AND '00000000-0000-0000-c026-000000000010'::UUID
  AND plan_kind = 'church_campaign_stage'
  AND is_hidden = FALSE;


-- ── 收尾斷言 ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  monthly_count INTEGER;
  orphan_logs   INTEGER;
  old_stage2_enrollments INTEGER;
BEGIN
  SELECT COUNT(*) INTO monthly_count FROM public.global_plans
  WHERE id BETWEEN '00000000-0000-0000-c126-000000202609'::UUID
              AND '00000000-0000-0000-c126-000000202612'::UUID;
  IF monthly_count <> 4 THEN
    RAISE EXCEPTION '[0142] 應有 4 個月度期末賽計畫，實際 %', monthly_count;
  END IF;

  SELECT COUNT(*) INTO old_stage2_enrollments FROM public.reading_plans
  WHERE global_plan_id = '00000000-0000-0000-c026-000000000002'::UUID;
  IF old_stage2_enrollments <> 0 THEN
    RAISE EXCEPTION '[0142] 舊 stage-2 仍有 % 筆 enrollment 未遷移', old_stage2_enrollments;
  END IF;

  SELECT COUNT(*) INTO orphan_logs FROM public.reading_logs
  WHERE plan_id IN (SELECT id FROM public.reading_plans
                    WHERE global_plan_id = '00000000-0000-0000-c126-000000202609'::UUID)
    AND book <> '出埃及記';
  IF orphan_logs <> 0 THEN
    RAISE EXCEPTION '[0142] 9 月出埃及記 enrollment 上仍有 % 筆非出埃及記打卡', orphan_logs;
  END IF;

  RAISE NOTICE '[0142] OK：月度計畫 4、舊 stage-2 enrollment 0、9 月非出埃及記 log 0';
END;
$assert$;

COMMIT;
