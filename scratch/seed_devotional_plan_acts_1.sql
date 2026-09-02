-- 建立「使徒行傳靈修（一）」這份 devotional 計畫的 global_plans 列。
-- 前置：migration 0145_devotional_plan.sql 已跑（plan_kind 允許 'devotional'）。
-- 內容（每天的經文 / 思想經文 / 影片）之後用管理端「每日靈修 → 貼文字批次匯入」填。
--
-- 手冊日期：8/22 起、連續 32 天（無休息日）→ 顯示日期 = start_date + (day_index - 1)。
-- day_index 1 = 使徒行傳 1:1-5。改 start_date 就整體平移、內容不動。
--
-- Supabase Dashboard → SQL Editor 執行。冪等（ON CONFLICT (id) DO UPDATE）。

INSERT INTO public.global_plans
  (id, name, description, start_date, end_date, target_books, plan_kind, is_hidden, rules)
VALUES (
  '00000000-0000-0000-d1f0-000000000001',
  '使徒行傳靈修（一）',
  '使徒行傳 1–9 每日靈修：經文進度、思想經文、靈修影片。',
  DATE '2026-08-22',
  DATE '2026-09-22',                                   -- 8/22 + 31 = 9/22（第 32 天）
  ARRAY['使徒行傳']::TEXT[],
  'devotional',
  FALSE,                                               -- 對會友的顯示改由 feature flag daily_devotion 控制
  jsonb_build_object('devotionFutureOpen', FALSE)      -- 未來日期預設鎖住，管理端可切開
)
ON CONFLICT (id) DO UPDATE SET
  name         = EXCLUDED.name,
  description  = EXCLUDED.description,
  start_date   = EXCLUDED.start_date,
  end_date     = EXCLUDED.end_date,
  target_books = EXCLUDED.target_books,
  plan_kind    = EXCLUDED.plan_kind,
  rules        = public.global_plans.rules || EXCLUDED.rules,  -- 保留管理端已切的 devotionFutureOpen
  updated_at   = NOW();

-- 確認
SELECT id, name, plan_kind, start_date, end_date, rules
FROM public.global_plans
WHERE id = '00000000-0000-0000-d1f0-000000000001';
