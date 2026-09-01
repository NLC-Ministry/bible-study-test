# 延後大區梯次（延後開跑的整條計畫）

> 決策（2026-08-29）：**完全獨立的平行梯次計畫**。不做全教會合併，日後有需求再加 `_stage_family` 併回。
>
> 實作（2026-08-30，前端 `20260830_exam_p5j` / `_region_cohort_v1`）：migration **0126–0128**（原文寫 0122–0124，被別人的大測驗練習功能佔用，順延）。
>
> 修正（2026-08-31，`_cohort_stage_kind_v1`）：migration **0137** ＋ 前端 sweep。0126–0128 只補了 0056/0098 的階段閘門，**漏掉所有其他以 `plan_kind = 'church_campaign_stage'` 為條件的邏輯**（下方「不用動 → 團隊」那段當初判斷錯誤）。0137 引入兩個述詞把散落的字串比較收斂成唯一定義，詳見下方「述詞模型」。

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
4. **0140（修正・定案）**：**延後大區梯次 = 「普通固定日期計畫 + 沿用獎勵」，其他全部獨立。**
   - **不掛 `campaignDefinition`、不走 campaign 排程機制。** 它就是一個固定日期計畫：自己的名稱 / 起訖 / 經卷，排程走 `generatePlanObject` 一般路徑（`target_books` 平均鋪進 `[start_date, end_date]`、跳週休）。
   - **唯一共用的是「完成給哪個獎」**：靠 `rules.stageNo` + `rules.cohortSourceStageNo`（發獎 `getCampaignStageCompletedRounds` 靠 `plan.stageNo`）。`awardName` / `roundNo` / `parentCampaignId` 從來源正式階段帶。
   - **`examDate` 建立時為 `null`**——日後由該大區領袖自訂（另做小 RPC）。
   - **落後/超前/補讀基準** = 該梯次自己的 `plan.days`（`getCanonicalStageScheduleDays` 在 `campaignDefinition` 為 null 時就回 `plan.days`）。
   - **每個梯次列各自算**，不串接。
   - 事故根因：0128 沒明確寫 `rules.stageNo`（只寫 `cohortSourceStageNo`），前端舊版只讀 `rules.stageNo` → 推不出階段序 → 發獎失效 + 排程走錯路；且來源階段列 `target_books` 若空，梯次也空 → 一般排程沒經卷可鋪。
   - 0140：RPC 還原成 0128 簽章（若曾被改成帶 JSONB 版就 DROP），`new_rules` 明確補 `stageNo`、剔除 `stages`/`segments`；回填現有 cohort 列（補 `rules.stageNo`、`target_books` 空的話從來源階段補，enrollment 也補）；收尾斷言每個 cohort 列都有 `rules.stageNo`。

### nlc-data

- `create_region_stage_cohort` 進 allowlist（admin set）。`global_plans` 讀取已允許。**重部署。**
- **0140 不用動 nlc-data**：RPC 簽章回到 0128 的（`p_actor_id` 仍在既有注入清單）。

### 前端

0. **排程（0140 定案）**：`js/db.js` `mapGlobalPlanRecord` 的 cohort 分支：**`campaignDefinition = null`**；`stageNo` / `roundNo` / `awardName` / `parentCampaignId` 從 `getChurchCampaignStageDefinition(rules.stageNo ?? rules.cohortSourceStageNo)` 帶（發獎用）；`books` 用 `dbPlan.target_books`，空的話退回來源階段的 `books`。`js/utils.js` `resolveChurchCampaignDefinition`：cohort 的 globalPlan 找到但 `campaignDefinition` 為 null → **回 `null`，不退回整份 MASTER**（否則會走進 campaign 排程機制）。`db.js` enrollment 對映：`generatePlanObject` 傳的 `selectedBooks` 用 `dbPlan.target_books || linkedGlobalPlan.books`；`planObj.awardName` / `roundNo` / `parentCampaignId` 從 `linkedGlobalPlan` 帶。`plan.js` 計畫詳情：獎章卡改用 `plan.awardName`（不再只看 `isCampaignStage`）；每日清單整個計畫都空 → 顯示「進度尚未就緒，請聯絡同工」。`utils.js` `generateChurchCampaignPlanObject` 排程建完沒有任何一天有章 → `console.error`（靜默失敗變大聲）。
4. **可見性過濾**：計畫清單（`db.js` 抓計畫 ~1286、`getVisiblePlans` / `isPlanHidden` 一帶、`plan.js` preset / 可加入清單渲染）——`audience_regions` 非空的計畫，只有 `state.currentUser.great_region ∈ audience_regions` 或 `canManageHiddenPlans()` 才顯示。
5. **階段 UI**：cohort 計畫要跟正式階段一樣進「階段卡」清單、依 `stageNo` 排序。目標大區的人「目前階段 / 下一階段」邏輯要在 cohort 計畫之間選，而不是正式階段。
6. **後台**：計畫管理加「大區延後梯次」小區塊——選大區 + 來源階段 + 起訖日 → 呼叫 `create_region_stage_cohort`；列出已建立的 cohort 計畫、可改日期 / 開放狀態（沿用既有的 `setGlobalPlanHidden`，它是泛用的 `global_plans` 更新）。

### 不用動

- **發獎**：`gamification.js` 用 `stage.stageNo` 給 `church_stage_award_<n>`，cohort 計畫的 `rules.stageNo` 帶著就會發同一個獎。去重 key 若是 `stageNo` → 只在該大區梯次的人拿一次，正常。
- **每人 campaign 累計**（總章數等）：本來就是把該 user 名下所有 `reading_plans` 加總，cohort 自動算進去。
- **大測驗**：跟階段沒綁；他們另出試卷。

> ⚠️ 原本這裡還寫了「**團隊**：`create_reading_team` / 報名總覽 / carry-over 都以 `global_plan_id` 為單位，不用動」——**這是錯的**。`create_reading_team`（0037）、`get_reading_team_leaderboards`（0076）、報名總覽（0079）、carry-over（0058）全都硬檢查 `plan_kind = 'church_campaign_stage'`，cohort 會 `RAISE team_plan_not_found`。已由 migration 0137 修正（改走 `is_campaign_stage_kind`）。

## 述詞模型（migration 0137）

`plan_kind = 'church_campaign_stage'` 過去同時代表三個概念，正式階段剛好都成立、cohort 只成立第一個。0137 起改用兩個述詞，字串字面值三個 runtime 各只出現一次（Postgres：`public.is_campaign_stage_kind` / `is_canonical_campaign_stage_kind`；前端 ESM：`js/data/campaign-stage-kinds.mjs`）：

| 概念 | 述詞 | cohort | 用途 |
|---|---|---|---|
| 行為上是階段計畫 | `is_campaign_stage_kind` | ✅ 含 | 階段開放閘門、進度凍結、階段獎、團隊報名/榜/carry-over、階段卡 UI |
| 在正式時間軸上 | `is_canonical_campaign_stage_kind` | ❌ 不含 | 0017 preset 同步、0018 清除 trigger、preset override 重套規則 |
| 計入全教會彙整 | （不以 plan_kind 過濾，靠呼叫端傳正式階段 id） | ❌ 暫不 | 見下方「已知限制」 |

carry-over 另加「同梯次家族」防呆：來源／目標 `audience_regions` 必須相等（`IS NOT DISTINCT FROM`），否則 A 大區 stage-1 的隊會被沿用進正式 stage-2（兩者同 `parentCampaignId` + `stageNo`）。跨家族沿用仍等 `_stage_family`。

## 已知限制（已同意）

以下**在補 `_stage_family` 前不會把這個大區併進正式階段的合併視圖**：`get_user_rankings`、`get_pastoral_zone_leaderboard`、後台「進度狀態」、首頁「本階段教會進度」。

團隊功能（`get_reading_team_leaderboards` / `get_reading_team_statistics` / 報名總覽 / carry-over）0137 起**以 cohort 計畫 id 為單位獨立運作**——該大區有自己的團隊榜／統計，只是不與正式階段的併在一起。

## 日後要併回全教會時

`global_plans` 加 `canonical_stage_id UUID`（cohort → 正式階段）；helper `_stage_family(p_stage_id) → uuid[]`；上面 6 支彙整 RPC 把 `= p_stage_id` 換成 `= ANY(_stage_family(p_stage_id))`（團隊那兩支的 `reading_team_members.global_plan_id` join 也要換）。
