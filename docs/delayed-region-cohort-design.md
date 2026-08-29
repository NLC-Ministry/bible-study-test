# 延後大區梯次（延後開跑的整條計畫）

> 決策（2026-08-29）：**完全獨立的平行梯次計畫**。不做全教會合併，日後有需求再加 `_stage_family` 併回。

## 需求

某一個**大區**（`profiles.great_region`）整條 2026–2029 速讀計畫延後一個階段開跑。當全教會在第二階段時，他們才進第一階段；之後每個階段對他們都往後延。

| 項目 | 決定 |
|---|---|
| 範圍 | 一個大區 |
| 獎項 | 一樣頒「磐石獎」等（同 `stageNo` 的獎） |
| 大測驗 | 他們自己另出一份新試卷（本設計不涉及） |
| 追上之後 | 後面每個階段都自己一條時間軸，不回主線 |
| 全教會統計 / 排行 / 團隊榜 | **暫不併入**（獨立）。日後要併再做 `_stage_family` |

## 模型：平行梯次計畫

- 新 `plan_kind = 'church_campaign_stage_cohort'`（加進 `global_plans_plan_kind_check`）。
- 每個階段給這個大區一列 `global_plans`：
  - **新 id**（不用 `…c026-0000000000NN` 正式範圍）。
  - `target_books` / `rules` / `segments` 從對應的正式階段複製；`rules.stageNo` 保留（發獎靠它）。
  - 自己的 `start_date` / `end_date`（往後挪）。
  - `is_hidden` 由管理員控制，跟正式階段一樣（預設除了他們的第一階段外都 hidden，逐一開放）。
  - 新欄位 `audience_regions TEXT[]`：非空 → 只有 `great_region` 命中的會友（及管理者）看得到 / 加得到；NULL/空 → 全教會（正式階段就是這樣）。

### 為什麼用獨立 `plan_kind`

`0018_cleanup_removed_church_campaign_stages` 會 `DELETE FROM global_plans WHERE plan_kind='church_campaign_stage' AND parentCampaignId=<campaign> AND id NOT IN (10 個正式 id)`（連 enrollment + logs cascade），在每次發佈 campaign 規則時觸發。`0056` 的同步、`0098` 的進度閘門也都以 `plan_kind='church_campaign_stage'` 為條件。用 `church_campaign_stage_cohort` 就全部避開，改由管理員直接維護。

## 要動的東西

### Migration

1. **0122**：`global_plans_plan_kind_check` 加 `'church_campaign_stage_cohort'`；`global_plans` 加 `audience_regions TEXT[]`。
2. **0123**：`enforce_reading_log_stage_progress_open`、`assert_campaign_stage_open` CREATE OR REPLACE——把 `plan_kind = 'church_campaign_stage'` 的判斷改成 `IN ('church_campaign_stage', 'church_campaign_stage_cohort')`（`is_hidden` / `start_date` 邏輯不變）。
3. **0124**：`create_region_stage_cohort(p_great_region, p_source_stage_no, p_start_date, p_end_date, p_actor_id)`——admin/pastor；找對應正式階段複製內容，插一列 cohort `global_plans`（`audience_regions = {p_great_region}`、`is_hidden` 可帶參數、`rules.stageNo = p_source_stage_no`）；以 `(audience_regions, stageNo)` 冪等（重跑就 UPDATE 日期）。回 `{planId}`。

### nlc-data

- `create_region_stage_cohort` 進 allowlist（admin set）。`global_plans` 讀取已允許。**重部署。**

### 前端

4. **可見性過濾**：計畫清單（`db.js` 抓計畫 ~1286、`getVisiblePlans` / `isPlanHidden` 一帶、`plan.js` preset / 可加入清單渲染）——`audience_regions` 非空的計畫，只有 `state.currentUser.great_region ∈ audience_regions` 或 `canManageHiddenPlans()` 才顯示。
5. **階段 UI**：cohort 計畫要跟正式階段一樣進「階段卡」清單、依 `stageNo` 排序。目標大區的人「目前階段 / 下一階段」邏輯要在 cohort 計畫之間選，而不是正式階段。
6. **後台**：計畫管理加「大區延後梯次」小區塊——選大區 + 來源階段 + 起訖日 → 呼叫 `create_region_stage_cohort`；列出已建立的 cohort 計畫、可改日期 / 開放狀態（沿用既有的 `setGlobalPlanHidden`，它是泛用的 `global_plans` 更新）。

### 不用動

- **發獎**：`gamification.js` 用 `stage.stageNo` 給 `church_stage_award_<n>`，cohort 計畫的 `rules.stageNo` 帶著就會發同一個獎。去重 key 若是 `stageNo` → 只在該大區梯次的人拿一次，正常。
- **團隊**：`create_reading_team` / 報名總覽 / carry-over 都以 `global_plan_id` 為單位——傳 cohort 計畫 id 就能在該梯次內獨立運作。
- **每人 campaign 累計**（總章數等）：本來就是把該 user 名下所有 `reading_plans` 加總，cohort 自動算進去。
- **大測驗**：跟階段沒綁；他們另出試卷。

## 已知限制（已同意）

以下**在補 `_stage_family` 前不會包含這個大區**：`get_user_rankings`、`get_pastoral_zone_leaderboard`、`get_reading_team_leaderboards`、`get_reading_team_statistics`、後台「進度狀態」、首頁「本階段教會進度」。他們有自己那份（傳 cohort 計畫 id）。

## 日後要併回全教會時

`global_plans` 加 `canonical_stage_id UUID`（cohort → 正式階段）；helper `_stage_family(p_stage_id) → uuid[]`；上面 6 支彙整 RPC 把 `= p_stage_id` 換成 `= ANY(_stage_family(p_stage_id))`（團隊那兩支的 `reading_team_members.global_plan_id` join 也要換）。
