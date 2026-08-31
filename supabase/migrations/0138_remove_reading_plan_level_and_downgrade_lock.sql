-- ============================================================================
-- 0138_remove_reading_plan_level_and_downgrade_lock.sql
--
-- 「level（突破 / 興盛 / 讀 N 遍）」與「降級鎖定」全部廢除。
--   · 日程永遠是教會原始的一遍、每週七日；多讀幾遍靠 current_round 累加、
--     沿用同一份日程。前端已完全不再讀寫這三個欄位。
--   · 沒有升級也沒有降級 → current_round 不需要「不可倒退」的鎖（進度重設會
--     正常地把它設回 1）。
--
-- 動作：
--   1. enforce_reading_plan_progress_transition → 只留「user_id 不可變」，
--      trigger 收窄成 BEFORE UPDATE OF user_id。
--   2. 拿掉 reading_plans_downgrade_lock_consistency CHECK。
--   3. carry_reading_teams_to_stage(0058) 的 INSERT 不再寫 level 欄。
--   4. DROP COLUMN level / was_downgraded / downgrade_locked_until。
--
-- ⚠️ 部署順序：前端（已拿掉所有 level / downgrade 參照）先上線，再跑這支。
--    反過來會讓還在讀這些欄位的舊前端 400。
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

BEGIN;

-- 1. 進度轉換 trigger：只保留「擁有者不可變」
CREATE OR REPLACE FUNCTION public.enforce_reading_plan_progress_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'reading plan ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reading_plans_progress_transition ON public.reading_plans;
CREATE TRIGGER trg_reading_plans_progress_transition
  BEFORE UPDATE OF user_id ON public.reading_plans
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reading_plan_progress_transition();

-- 2. downgrade-lock 一致性 CHECK 拿掉
ALTER TABLE public.reading_plans
  DROP CONSTRAINT IF EXISTS reading_plans_downgrade_lock_consistency;

-- 3. carry_reading_teams_to_stage 的 INSERT INTO reading_plans 不再帶 level 欄
--    （pg_get_functiondef 撈現行版本 → 刪掉 "level," 欄位與對應的 "'normal'," 值）
DO $carry$
DECLARE
  original TEXT;
  updated  TEXT;
BEGIN
  original := pg_get_functiondef('public.carry_reading_teams_to_stage(uuid, uuid)'::regprocedure);
  updated  := replace(original, E'        level,\n', '');
  updated  := replace(updated,  E'        ''normal'',\n', '');
  IF updated = original THEN
    RAISE WARNING '0138: carry_reading_teams_to_stage 的 level 欄未移除（pattern 未命中，請人工檢查）';
  ELSE
    EXECUTE updated;
    RAISE NOTICE '0138: carry_reading_teams_to_stage 已移除 level 欄';
  END IF;
END;
$carry$;

-- 4. 三個欄位砍掉
ALTER TABLE public.reading_plans
  DROP COLUMN IF EXISTS level,
  DROP COLUMN IF EXISTS was_downgraded,
  DROP COLUMN IF EXISTS downgrade_locked_until;

COMMIT;
