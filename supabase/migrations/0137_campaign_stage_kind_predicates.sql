-- ============================================================================
-- 0137_campaign_stage_kind_predicates.sql
--
-- 「延後大區梯次」收尾：把散落在各處、以 `plan_kind = 'church_campaign_stage'`
-- 為條件的邏輯，改成走「唯一定義」的述詞函式，讓 cohort 階段
-- （`plan_kind = 'church_campaign_stage_cohort'`，migration 0126 新增）
-- 一致地拿到「階段計畫」該有的行為，而不是每次加一種 kind 就人工重掃一次。
--
-- 兩個概念、兩個述詞（整個 DB 的字串字面值只在這裡出現一次）：
--   · is_campaign_stage_kind          — 「行為上是一個階段計畫」：正式 or 大區梯次。
--       階段開放閘門、進度凍結、階段獎、團隊報名 / 團隊榜 / carry-over 都屬這個。
--   · is_canonical_campaign_stage_kind — 「在全教會正式時間軸上」：只有正式階段。
--       0017 preset 同步、0018 清除 trigger（會 cascade DELETE）屬這個，cohort 永不觸及。
--
-- 手法：對每支「現行部署版本」用 pg_get_functiondef() 撈出 → REPLACE 掉那一個
--       述詞片段 → EXECUTE 回去（沿用 0047/0063 的動態改法，可重跑；REPLACE 後
--       舊片段已不存在 → 二次執行為 no-op）。plpgsql 函式本體是逐字保存的，
--       所以 REPLACE 目標字串就是各 migration 檔裡的原文。
--
-- 依賴：0126（plan_kind CHECK + audience_regions 欄位）、0127（0056/0098 的閘門
--       已擴為 IN(...) 的版本）。若 0127 未部署，DO 區塊會 RAISE WARNING 指出
--       哪一支的 pattern 找不到，不會靜默略過。
--
-- 部署：Supabase SQL editor 執行，或 `supabase db push`。純資料庫改動，
--       nlc-data / Edge Function 不需重部署（相關 RPC 早在 allowlist）。
-- ============================================================================

BEGIN;

-- ── 1. 唯一定義的述詞函式 ────────────────────────────────────────────────────
-- IMMUTABLE + 純 SQL → planner 內聯，等同原本的 = / IN 展開，索引照用、零成本。

CREATE OR REPLACE FUNCTION public.is_campaign_stage_kind(p_plan_kind TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_plan_kind IN ('church_campaign_stage', 'church_campaign_stage_cohort')
$$;
COMMENT ON FUNCTION public.is_campaign_stage_kind(TEXT) IS
  '行為上是一個階段計畫（正式或大區延後梯次）。階段閘門/進度凍結/階段獎/團隊功能用此。';

CREATE OR REPLACE FUNCTION public.is_canonical_campaign_stage_kind(p_plan_kind TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_plan_kind = 'church_campaign_stage'
$$;
COMMENT ON FUNCTION public.is_canonical_campaign_stage_kind(TEXT) IS
  '在全教會正式時間軸上（僅正式階段）。preset 同步 / 清除 trigger 用此，永不匹配 cohort。';


-- ── 2. 動態改寫的小工具（session 結束自動消失）────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp.rewrite_fn(p_sig TEXT, p_from TEXT, p_to TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $rw$
DECLARE
  original TEXT;
  updated  TEXT;
BEGIN
  original := pg_get_functiondef(p_sig::regprocedure);
  updated  := replace(original, p_from, p_to);
  IF updated = original THEN
    RAISE WARNING '0137: 在 % 找不到片段，未改寫：%', p_sig, p_from;
  ELSE
    EXECUTE updated;
    RAISE NOTICE '0137: 已改寫 %', p_sig;
  END IF;
END;
$rw$;


-- ── 3. 概念 A：改走 is_campaign_stage_kind（把 cohort 納入階段行為）────────────

-- 3a. create_reading_team — 這就是「延後梯次不能報名團隊」的根因（RAISE team_plan_not_found）。
SELECT pg_temp.rewrite_fn(
  'public.create_reading_team(uuid, smallint, text, uuid)',
  $q$plan.plan_kind = 'church_campaign_stage'$q$,
  $q$public.is_campaign_stage_kind(plan.plan_kind)$q$
);

-- 3b. get_reading_team_leaderboards — 建好隊後看團隊榜也會 RAISE 同一個錯。
SELECT pg_temp.rewrite_fn(
  'public.get_reading_team_leaderboards(uuid, uuid)',
  $q$plan.plan_kind = 'church_campaign_stage'$q$,
  $q$public.is_campaign_stage_kind(plan.plan_kind)$q$
);

-- 3c. get_reading_team_registration_overview — 後台總覽要含 cohort 的隱藏階段。
SELECT pg_temp.rewrite_fn(
  'public.get_reading_team_registration_overview(uuid)',
  $q$gp.plan_kind = 'church_campaign_stage'$q$,
  $q$public.is_campaign_stage_kind(gp.plan_kind)$q$
);

-- 3d. assert_campaign_stage_open（0127 版本已是內聯 IN(...)）— 收斂成述詞，消掉重複清單。
SELECT pg_temp.rewrite_fn(
  'public.assert_campaign_stage_open(uuid, uuid)',
  $q$target_plan.plan_kind IN ('church_campaign_stage', 'church_campaign_stage_cohort')$q$,
  $q$public.is_campaign_stage_kind(target_plan.plan_kind)$q$
);

-- 3e. enforce_reading_log_stage_progress_open（0127 版本）— 同上（NOT IN 形式）。
SELECT pg_temp.rewrite_fn(
  'public.enforce_reading_log_stage_progress_open()',
  $q$target_plan.plan_kind NOT IN ('church_campaign_stage', 'church_campaign_stage_cohort')$q$,
  $q$NOT public.is_campaign_stage_kind(target_plan.plan_kind)$q$
);


-- ── 4. 概念 B：改走 is_canonical_campaign_stage_kind（意圖標註 + 縱深防禦）──────

-- cleanup_removed_church_campaign_stages 是會 cascade DELETE enrollment + reading_logs
-- 的 trigger。cohort 目前靠不同的 plan_kind 就已排除，這裡再加 audience_regions IS NULL
-- 當保險：就算日後有人改了 cohort 的 kind，帶著 audience_regions 的列也永遠刪不到。
-- （REPLACE 會一次改掉函式裡兩個相同的述詞。）
SELECT pg_temp.rewrite_fn(
  'public.cleanup_removed_church_campaign_stages()',
  $q$stage_plan.plan_kind = 'church_campaign_stage'$q$,
  $q$public.is_canonical_campaign_stage_kind(stage_plan.plan_kind) AND stage_plan.audience_regions IS NULL$q$
);


-- ── 5. carry-over：概念 A ＋「同梯次家族」防呆 ───────────────────────────────
-- source / target 都要是階段計畫，且 audience_regions 必須相等
-- （NULL = NULL 走正式 → 正式；{A 大區} = {A 大區} 走該大區梯次內部），
-- 否則 A 大區 stage-1 的隊會被沿用到正式 stage-2（兩者同 parentCampaignId + stageNo）。
-- 完整跨家族沿用等 _stage_family 再做。

DO $carryover$
DECLARE
  sig      TEXT;
  original TEXT;
  updated  TEXT;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.get_reading_team_carryover_offer(uuid, uuid)',
    'public.carry_reading_teams_to_stage(uuid, uuid)'
  ]
  LOOP
    original := pg_get_functiondef(sig::regprocedure);
    updated  := original;

    -- 先換較長的（否則 'plan_kind = ...' 會誤中 'source_plan.plan_kind = ...' 的尾段）
    updated := replace(updated,
      $q$source_plan.plan_kind = 'church_campaign_stage'$q$,
      $q$public.is_campaign_stage_kind(source_plan.plan_kind)$q$);
    updated := replace(updated,
      $q$plan_kind = 'church_campaign_stage'$q$,
      $q$public.is_campaign_stage_kind(plan_kind)$q$);

    -- 在來源階段的比對條件後面補上 audience_regions 相等的守門
    updated := replace(updated,
      $q$AND NULLIF(source_plan.rules->>'stageNo', '')::INTEGER = source_stage_no$q$,
      $q$AND NULLIF(source_plan.rules->>'stageNo', '')::INTEGER = source_stage_no
    AND source_plan.audience_regions IS NOT DISTINCT FROM target_plan.audience_regions$q$);

    IF updated = original THEN
      RAISE WARNING '0137: carry-over 未改寫（pattern 未命中）：%', sig;
    ELSE
      EXECUTE updated;
      RAISE NOTICE '0137: 已改寫 %', sig;
    END IF;
  END LOOP;
END;
$carryover$;


-- ── 6. RLS policy（0057）：鎖住的 cohort 階段也要保持可見（顯示為未開放卡片）────
-- 僅影響 Supabase-Auth 模式（dev/localhost）；正式站走 nlc-data service-role，
-- audience 過濾在前端 / nlc-data。

DROP POLICY IF EXISTS global_plans_read_visible ON public.global_plans;
CREATE POLICY global_plans_read_visible
ON public.global_plans
FOR SELECT
TO authenticated
USING (
  is_hidden = FALSE
  OR public.is_campaign_stage_kind(plan_kind)
  OR (SELECT my_role FROM public.get_my_profile()) = 'admin'
);

COMMIT;

-- ── 刻意「不動」的地方（cohort 已因不同 kind 而正確排除，改了只是換皮、徒增依賴）──
--   · sync_church_campaign_stage_plans（0056）— 只在 campaign master 那一列上跑，
--     函式裡的 'church_campaign_stage' 全是「要寫進去的字面值」，不是述詞。
--   · create_region_stage_cohort（0128）— WHERE ... plan_kind = 'church_campaign_stage'
--     是在挑「要複製的正式來源階段」，語意本來就是 canonical-only。
--   · get_pastoral_zone_leaderboard / 排行 / 首頁「本階段教會進度」/ 後台進度狀態 —
--     不以 plan_kind 過濾，而是呼叫端傳正式階段 id；cohort 暫不併入（待 _stage_family）。
