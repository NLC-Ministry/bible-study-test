# 教會計畫大調整：第一輪期末賽拆成 4 個月度計畫

2026-09 定案。相關：migration `0142_first_round_final_monthly_split.sql`、
`church_campaign.js` / `state.js` / `utils.js` / `db.js` / `plan.js`。

## 需求（A–F，全部確認）

| # | 決策 |
|---|---|
| **A** | 4 個月度計畫是**普通固定日期計畫 + 沿用獎勵**，不重新編號 stage、不動 2027+。 |
| **B** | **四個月度計畫全部 100% 完成**才算完成「第一輪期末賽」一遍 → 鐵獎。期末測驗維持一場，綁 12 月（2026-12-27）。 |
| **C** | 舊第二階段資料：enrollment / 團隊 → 改指 9 月出埃及記；`reading_logs` 出埃及記保留、其餘刪除。 |
| **D** | 10–12 月 = **探索清單看得到、鎖住**（`available-locked`）；不因日期到自動解鎖，由系統管理員逐月開放。 |
| **E** | 第三階段之後（`c026-…03`~`…10`）維持 `is_hidden = TRUE`，且**不**出現在探索清單。 |
| **F** | 月度計畫 id 用 `c126` 命名空間（`00000000-0000-0000-c126-000000YYYYMM`），preset key `church_r1final_2026_09`~`_12`。 |

## 對應的月份

| preset | id | 期間 | 書卷 | 初始 is_hidden | examDate |
|---|---|---|---|---|---|
| `church_r1final_2026_09` | `…c126-000000202609` | 9/1–9/30 | 出埃及記 1–40 | FALSE（開放） | — |
| `church_r1final_2026_10` | `…c126-000000202610` | 10/1–10/31 | 利未記 1–27 | TRUE（鎖住） | — |
| `church_r1final_2026_11` | `…c126-000000202611` | 11/1–11/30 | 民數記 1–36 | TRUE | — |
| `church_r1final_2026_12` | `…c126-000000202612` | 12/1–12/31 | 申命記 1–34 | TRUE | 2026-12-27 |

全部 `plan_kind = church_campaign_stage`、`rules.stageNo = 2`、`rules.awardName = "鐵獎"`、`rules.discoverWhenLocked = true`。

## 機制

### 前端

- **`church_campaign.js`**：`CHURCH_CAMPAIGN.monthlyFinals` 4 筆；`createChurchCampaignStageDefinitions` 改 `flatMap`，stageNo 2 展開成 4 個月度定義（`buildMonthlyFinalDefinition`）。每個定義帶 `discoverWhenLocked`；一般階段 `discoverWhenLocked = stageNo <= 2`。`getChurchCampaignStageDefinition(2)` 回第一個（9 月）當「發獎錨點」。
- **`state.js`**：`CHURCH_PLAN_PRESETS` 1:1 吃 13 個定義（1 熱身 + 4 期末月度 + 8 個 stage 3–10），帶 `discoverWhenLocked`。
- **`utils.js`**：
  - `isCampaignStageDiscoverableWhileLocked(plan)` —— 讀 `plan.discoverWhenLocked` / `rules.discoverWhenLocked` / `campaignDefinition.discoverWhenLocked`。
  - `getCampaignStageCompletedRounds(2)` / `getCampaignStageCurrentRound(2)` 特判：取 4 個 `church_r1final_*` 計畫完成遍數的**最小值**（沒加入的月＝0）→ 鐵獎。
- **`db.js`**：`mapGlobalPlanRecord` 回 `discoverWhenLocked: Boolean(dbPlan.rules?.discoverWhenLocked)`。
- **`plan.js`**：探索清單過濾 —— `isHidden && !canManage && !(isCampaignStageLocked && isCampaignStageDiscoverableWhileLocked)` → 隱藏。

### 後端（0142）

- 建 4 個 `c126` 列（`ON CONFLICT` 保留管理員 `is_hidden`）。
- `SET session_replication_role = replica` 期間：舊 `c026-…02` 的 enrollment / `reading_teams` / `reading_team_members` / `small_home_teams` → 改指 9 月；非出埃及記的 `reading_logs` 刪除；舊 `c026-…02` 列 `is_hidden=TRUE` + 改名 + `rules.supersededBy`。
- `sync_church_campaign_stage_plans`：迴圈 `IF stage_no = 2 THEN CONTINUE`（不再重建 `c026-…02`）。
- 重申 `c026-…03`~`…10` `is_hidden = TRUE`。

## 部署順序

1. 前端（`church_campaign.js` 那批）先上線。
2. Supabase SQL editor 跑 `0142`。冪等。
3. 驗證：探索清單 9 月可加入、10–12 月鎖住、無 2027 stage；後台開放/隱藏 toggle 對 `c126` 列 + `c026-…03`~`…10` 生效。

## 尚未處理 / 之後

- 「加入第一輪期末賽 = 一次加入 9–12 月四張」的 UX（目前各月分開加入）。
- 月度計畫在探索清單的卡片文案（現在 campaign-stage 卡顯示「第 2 階段・第 1 輪」，理想是顯示月份 + 書卷）。
- 期末測驗（大測驗）對 4 月度計畫成員的 gate 讀取 12 月那張的 `examDate`。
