-- ============================================================================
-- 0126_region_cohort_plan_kind.sql
-- 「延後大區梯次」第 1 步：資料結構。
--   · global_plans.plan_kind 多一種 'church_campaign_stage_cohort'
--     —— 某個大區整條計畫延後開跑時，每個階段給他們一份平行的階段計畫。
--     用獨立 kind 是為了避開 0018 的自動刪除、0056 的同步、0098 的進度閘門
--     那些以 plan_kind = 'church_campaign_stage' 為條件的邏輯。
--   · global_plans.audience_regions TEXT[] —— 非空 → 這份計畫只給
--     great_region 命中的會友（及 admin/pastor）看得到 / 加得到。
--     NULL / 空 = 全教會（正式階段就是這樣）。
--
-- 設計：docs/delayed-region-cohort-design.md
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

ALTER TABLE public.global_plans
  DROP CONSTRAINT IF EXISTS global_plans_plan_kind_check,
  ADD CONSTRAINT global_plans_plan_kind_check
    CHECK (plan_kind IN ('standard', 'church_campaign', 'church_campaign_stage', 'church_campaign_stage_cohort'));

ALTER TABLE public.global_plans
  ADD COLUMN IF NOT EXISTS audience_regions TEXT[];

COMMENT ON COLUMN public.global_plans.audience_regions IS
  '非空 → 這份計畫只開放給 profiles.great_region 命中此陣列的會友（admin/pastor 例外）。NULL/空 = 全教會。';
