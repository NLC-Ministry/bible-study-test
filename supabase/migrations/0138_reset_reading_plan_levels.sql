-- ============================================================================
-- 0138_reset_reading_plan_levels.sql
--
-- 「level（突破/興盛/讀 N 遍）」設定已廢除。日程永遠是教會原始的一遍、每週七日；
-- 多讀幾遍靠 current_round 累加、沿用同一份日程。前端 getPlanLevelRounds() 已一律
-- 回 1，segmentScheduleDaysForRoundCount 不再把章數乘遍數。
--
-- 這支把殘留的 reading_plans.level（breakthrough / super / levelN，約 375 筆）
-- 全部重設回 'normal'，讓那些使用者的 state.activePlan.days 從「N 遍打包的畸形
-- 排程」回到正常，連他們的每日讀經清單 / 進度條一起修正。
--
-- current_round 不動（多讀幾遍的紀錄保留）。rest_weekdays 不動（休息日要留）。
--
-- 0010 的 enforce_reading_plan_progress_transition trigger 會把「level 變小」視為
-- 未授權的降級而 RAISE，所以整段在 DISABLE / ENABLE trigger 之間跑。
-- （欄位本身的 DROP COLUMN + trigger 改寫 + 0058 修正留待批次 2。）
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

BEGIN;

ALTER TABLE public.reading_plans DISABLE TRIGGER trg_reading_plans_progress_transition;

UPDATE public.reading_plans
SET level = 'normal',
    was_downgraded = FALSE,
    downgrade_locked_until = NULL
WHERE COALESCE(level, 'normal') <> 'normal';

ALTER TABLE public.reading_plans ENABLE TRIGGER trg_reading_plans_progress_transition;

COMMIT;
