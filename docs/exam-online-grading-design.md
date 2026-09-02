# 線上簡答批改頁 — 設計草案

> 狀態：**已實作，尚未部署 / 未 commit**（2026-09-03，版本 `20260903_online_grading`）。
> 交付：migration `0146_exam_online_grading.sql`、`nlc-data/index.ts`、`js/db.js`、`grade.html`、
> `js/grade-entry.js`、`js/modules/grading.js`、`js/modules/exam.js`（「簡答指派」子分頁）、
> `scripts/bundle.mjs`、`vercel.json`、`sw.js`、`index.css`。build + 1091 tests pass。
> 未做 runtime 驗證（`npm run dev` 壞、獨立頁要部署後才跑得動）。部署順序見本檔末 / 記憶檔。
> 目標：把大測驗第六大題（簡答題）的人工批改，從後台單一分頁改成「一位評分人員一條連結、點開就能線上改考卷」的獨立網頁。

## 定案摘要（2026-09-03 使用者回覆）

1. 身分：**A（NLC 帳號登入）＋ C（依指派分卷）**。批改名單＝被指派過的人；不另做名單表。
2. 伺服器草稿（L2 `exam_grading_drafts`）：**要做**。
3. **一張卷只由一個人改。** 換人改＝從「還沒改完的卷」裡重新挑出來、指派給別人。已改完的卷不進重新指派流程（但原指派人／admin 在成績公布前仍可重開修改）。
4. **不做單題短評。** 每題只有分數框；批改人員要對個別題目講評，寫在「整卷評語」裡。
5. 送出後（成績公布前）**可以再改**：重開該卷覆蓋即可。
6. **不顯示一~五大題的作答／自動分**（評分人員沒時間看）。
7. 名單與頁面顯示**真實姓名 ＋ 牧區 ＋ 小組**。

## 為什麼要另做一頁

現在的批改在 `js/modules/exam.js` 的 `renderExamGrading`（後台「大測驗 → 簡答批改」子分頁），限制：

- 要有 admin/pastor 角色才進得去 → 沒辦法把批改工作分給沒有後台權限的同工。
- 版面是「一長串卡片」，不是「一位一頁、逐題給分、右上角總分」。
- 目前只有分數輸入，沒有單題短評、沒有整卷評語欄。
- 防遺失只有 `is-dirty` class + 整批儲存，沒有本機鏡射／伺服器草稿；批到一半關掉就沒了。

沿用「獨立頁」的既有模式：大測驗作答本身就是獨立文件 `exam.html` + `js/exam-entry.js`（見 `docs/exam-close-ux-analysis.md`）。批改頁比照，做 `grade.html` + `js/grade-entry.js`。

## 1. 頁面結構（一位作答者一頁）

```
┌─────────────────────────────────────────────────────────┐
│ ← 上一位   [ 3 / 27 ]   下一位 →           總分  24 / 30 │  ← sticky header
│ 作答者：王小明     大區：北一 · 牧區：活水 · 小組：第 3 組 │
│ 狀態：待批改 · 送出 2026/08/30 21:14                       │
├─────────────────────────────────────────────────────────┤
│ 第 1 題（10 分）                            得分 [  8 ]/10│
│  題目：請說明……                                          │
│  參考答案 / 評分要點：……                                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 作答全文（唯讀，可捲動）                             │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│ 第 2 題（10 分）                            得分 [ 10 ]/10│
│  …                                                        │
├─────────────────────────────────────────────────────────┤
│ 第 3 題（10 分）                            得分 [    ]/10│
│  …                                                        │
├─────────────────────────────────────────────────────────┤
│ 整卷評語（含個別題目的講評都寫這裡）                       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│ 已存本機 21:47:03 · 伺服器草稿已存 21:46:40               │  ← 存檔狀態列
│              [ 儲存此張草稿 ]   [ 送出這一張 ]            │  ← sticky footer
└─────────────────────────────────────────────────────────┘
   ┌───────────────────────────────────────────────────┐
   │ 有 5 張已改未送            [ 送出全部待送（5）]      │  ← 有暫存修改時才出現
   └───────────────────────────────────────────────────┘
```

- **右上總分** = Σ 各題得分，隨輸入即時更新。
  - 任一題留白 → 顯示「24 / 30 · 尚缺 1 題」，送出鈕停用。
  - 任一題超過配分或負數 → 該題紅框、送出鈕停用。
- **逐題**：題號 + 配分 + 題幹 + 參考答案/rubric + 作答全文（唯讀）+ 分數框。**沒有單題短評框。**
- **整卷評語**：一個 textarea，對應 `exam_attempts.grader_overall_comment`（新欄）。個別題目要講評也寫這裡。
- **不顯示一~五大題**（自動計分題）的作答與自動分。

## 2. 導覽 / 名單

- Header 的「上一位 / 下一位」在「指派給我的名單」內移動。
- 名單面板：桌機側欄、手機抽屜。每列＝姓名 + 牧區·小組 + 狀態徽章：
  `待批` / `本機有草稿` / `伺服器草稿` / `已送出` / `⚠ 有未存修改`。
- 名單可依 **牧區 / 狀態** 篩選、搜尋姓名；預設依 牧區 → 小組 → 姓名 排序，未作答（簡答全空）沉到最底（對齊文字檔匯出的排序規則）。
- URL 帶 `?paper=<id>&attempt=<id>`；重新整理不丟位置、可把單一連結貼給人看特定一位。

## 3. 資料流與防遺失（重點 — 對齊「簡答答案送出後不見」事故）

三層保護：

### L1　本機鏡射（每次輸入，debounce ~600ms）

- key：`localStorage["exam_grade_<paperId>_<attemptId>"]`
- value：`{ scores:{answerId:points}, qComments:{answerId:text}, overall:text, __savedAt, __baseRev }`
- 進頁時：讀本機 → 和伺服器資料合併。本機 `__savedAt` 較新 → 以本機為準，並在狀態列標「本機有較新的未送出修改」。
- 進頁時掃掉 21 天以上的舊 `exam_grade_*`（比照 `exam.js` 既有的 `pruneStaleExamResp`）。
- `beforeunload` / `visibilitychange→hidden`：同步 flush 一次 L1。

### L2　伺服器草稿（切換作答者、每 20 秒、切背景、按「儲存草稿」）— 確認要做

- 新 RPC `exam_save_grading_draft(p_attempt_id, p_payload, p_base_rev)` → upsert `exam_grading_drafts`（PK `attempt_id`，一張卷一份草稿）。
  - **不動 `exam_answers`、不結算、不發通知。**
  - 回 `{ savedAt, rev }`。`rev` 給樂觀鎖。
- 草稿＝「還沒送出的評分」，任何時候可被同一位批改人員覆蓋。
- 好處：換裝置 / 當機 / 清快取都回得來，不是只靠 localStorage。
- 重新指派該 attempt 給別人時，這份草稿一併刪除（前一位改到一半的內容不留給下一位）。

### L3　正式送出

- **單張**：`exam_grade_attempt(p_attempt_id, p_grades[], p_overall_comment, p_base_rev)`
  - 一次寫完該卷所有簡答題 `awarded_points` + `grader_comment`（新欄）+ `exam_attempts.grader_overall_comment`。
  - 每題驗 `0 ≤ points ≤ question.points`；**全部有效才 commit**（沿用現有 `gradeExamAnswersBatch` 的「全數通過才寫」精神）。
  - 全卷簡答都給分 → 結算 `manual_score` / `total_score` / `status='graded'`（沿用現有結算邏輯）；只給一部分 → 留 `submitted`。
  - 成功後清該卷 L1 本機鏡射 + L2 草稿。
- **批次**：`exam_grade_attempts_bulk(p_items[])`，每個 item = 一張卷的 grades + comment。
  - 伺服器逐張跑 `exam_grade_attempt`，回 `[{attemptId, ok, error?}]`。
  - 前端只清成功那幾張；失敗的留紅字（「第 3 張：分數超出配分」）等修正後重送。
- 送出前先把「當前這張的即時值」直接帶進 payload，不倚賴剛剛的 debounce。
- 送出失敗（網路）→ 指數退避自動重試（最多 4 次）；期間 L1/L2 都在，可離開頁面。

### 衝突偵測（同一人多分頁 / admin 同時在改）

一張卷只有一位批改人員，衝突情境變少，但仍要擋：同一人開兩個分頁、或 admin 在後台同時動了這張。

- 每張卷帶 `rev`（`exam_answers` 最後更新版本，或 draft rev，取大者）。
- 存草稿 / 送出時比對 `p_base_rev`：
  - 伺服器較新 → 不覆蓋，回 `exam_grading_stale`，前端跳「這張已被 <誰> 於 <時間> 改過」，讓批改人員選「用我的覆蓋」或「重新載入這張」。

### 成績公布後

- 該卷 `results_published_at IS NOT NULL` → 所有寫入 RPC 一律 `exam_results_locked`（沿用 migration 0117）。批改頁與指派介面都進入唯讀。
- 公布**前**：已送出的卷可重開修改再送（`exam_grade_attempt` 可重複呼叫覆蓋）。

## 4. 後端（草案，全部未實作）

### 新表

- **`exam_grading_assignments`** — 一張 attempt 指派給哪位批改人員（第 3、5 節）。
  - `attempt_id UUID PK → exam_attempts ON DELETE CASCADE`
  - `grader_id UUID`（profile id）
  - `assigned_by UUID`、`assigned_at TIMESTAMPTZ`
  - 一 attempt 一列；換人＝`UPDATE grader_id`。
  - 「這份卷的批改名單」＝該卷所有 assignment 的 distinct `grader_id`（不另做名單表）。
  - `ENABLE RLS`，無 policy，只走 service-role + RPC。
- **`exam_grading_drafts`** — L2 伺服器草稿。
  - `attempt_id UUID PK → exam_attempts ON DELETE CASCADE`（一 attempt 一份草稿，因為只有一個人改）
  - `grader_id UUID`（寫這份草稿的人，稽核用）
  - `payload JSONB`、`rev INT`、`updated_at TIMESTAMPTZ`
  - `ENABLE RLS`，無 policy。
  - **重新指派時清掉該 attempt 的草稿**（那是前一位改到一半的東西，新的人從頭改）。

### 既有表加欄

- `exam_attempts.grader_overall_comment TEXT` — 整卷評語（唯一的評語欄；個別題目講評也寫這裡）。
- （**不加** `exam_answers.grader_comment`——第 4 節決定不做單題短評。分數仍寫既有的 `exam_answers.awarded_points`。）

### 新 RPC（都進 `nlc-data` allowlist）

| RPC | 用途 | 權限 |
|---|---|---|
| `exam_list_gradable_attempts(p_paper_id, p_filter)` | 後台指派用：回該卷所有 attempt `{attemptId,name,greatRegion,pastoralZone,smallGroup,status,assignedGraderId,assignedGraderName}`，可依牧區/狀態/是否已指派篩選 | admin/pastor |
| `exam_assign_attempts(p_paper_id, p_attempt_ids[], p_grader_profile_id)` | 後台把多張 attempt 指派/改派給某位 NLC 會友；**已 graded 的預設擋下**（要 `p_force` 才覆寫指派），改派時清該 attempt 的草稿 | admin/pastor |
| `exam_get_grading_workspace(p_paper_id)` | 批改頁：回 `{ paper:{title,sections,resultsPublished}, roster:[{attemptId,name,greatRegion,pastoralZone,smallGroup,status,hasDraft,rev}] }`，**只回指派給我的**（含我已送出的，狀態標「已送出」） | 指派給我 |
| `exam_get_grading_sheet(p_attempt_id)` | 批改頁單卷：`{ examinee:{name,greatRegion,pastoralZone,smallGroup,submittedAt}, overallComment, rev, questions:[{answerId,position,points,stem,referenceAnswer,rubric,response,awardedPoints}] }`（只有簡答題） | 指派給我 or admin |
| `exam_save_grading_draft(p_attempt_id, p_payload, p_base_rev)` | L2 草稿，回 `{savedAt,rev}`，rev 衝突 → `exam_grading_stale` | 指派給我 |
| `exam_grade_attempt(p_attempt_id, p_grades, p_overall_comment, p_base_rev)` | L3 單張送出（見 L3）；**成績公布前可重複呼叫覆蓋**（第 5 節決策 5） | 指派給我 or admin |
| `exam_grade_attempts_bulk(p_items)` | L3 批次送出，逐張回 `[{attemptId,ok,error?}]` | 指派給我 or admin |

- 沿用不動：`exam_publish_results`（最後一次性公布 + 發通知，仍 admin only）、自動評分／`exam_recompute_scores`（一~五大題）、`exam_get_stats`。
- `nlc-data`：`exam_list_gradable_attempts` / `exam_assign_attempts` 進 `EXAM_ADMIN_RPC_FUNCTIONS`；其餘 5 支進新的 `EXAM_GRADER_RPC_FUNCTIONS`（閘門＝「呼叫者被指派了這個 attempt / paper」，不需 admin 角色）。**需重部署 Edge Function。**
- **強制 scope**：每支寫入 RPC 內綁死 `attempt_id`／`paper_id`，並先驗 `exam_grading_assignments.grader_id = resolve_quiz_actor(...)`（比照 `applyForcedScope`，見 [[feedback_nlc_data_bypasses_rls]]）。

## 5. 權限與連結（定案：A + C）

### 身分（A）

- 批改人員本來就是 NLC 會友 → `grade.html?paper=<id>` 未登入就導 Logto SSO，回來後 `resolve_quiz_actor` 取 `profile.id`。
- **不需要 admin/pastor 角色**；能不能進、能改哪些，全看 `exam_grading_assignments`。
- 沒有任何指派 → 頁面顯示「你目前沒有被指派要批改的考卷」。

### 指派（C）

- 後台（大測驗 → 新的「簡答指派」子分頁，admin/pastor）：
  - `exam_list_gradable_attempts` 列出該卷所有作答者，可依 **牧區 / 狀態（待批・已送出）/ 是否已指派** 篩選、多選。
  - 選一批 → 從 NLC 會友搜尋（姓名/email）挑一位 → `exam_assign_attempts` 指派。
  - 一張卷同時只屬於一位批改人員。
- **換人改（決策 3）**：對「還沒改完（`status <> 'graded'`）」的 attempt，在指派介面重新選、改派給另一人；系統清掉該 attempt 的伺服器草稿。已 `graded` 的預設不給改派（避免打亂已完成的結果）；真的要動，`exam_assign_attempts` 帶 `p_force`。
- **已 graded 但成績未公布**：原指派人（或 admin）可在批改頁重開該卷、改分數/評語再送出（決策 5）。這是「修改」不是「改派」。
- 成績公布後（`results_published_at`）全鎖，指派與批改頁都變唯讀。

### 連結怎麼發（下一步討論）

- 最單純：把 `https://<站>/grade?paper=<id>` 這一條連結群發給所有批改同工；每個人點進去、SSO 登入後只看到指派給自己的。
- 進階（要不要做再說）：後台「簡答指派」每列旁邊有「複製此人的批改連結」，或指派完自動發一則站內通知（`exam_notifications` kind 加一種）給被指派的人，點通知直接進 `grade.html`。

## 6. 前端檔案（草案）

- `grade.html`（root，獨立文件，比照 `exam.html`）
- `js/grade-entry.js`（進入點：同 `exam-entry.js` 的核心前置 import + 驗證 → `mountGradingWorkspace({ paperId, attemptId })`）
- `js/modules/grading.js`：`GradingWorkspace` 類 —— roster 載入、單卷 render、L1/L2/L3、導覽、批次列、衝突處理。
- `index.css` 追加 `.grade-*`（class-based、只用 token、字級 ≥ 0.875rem、無 inline hex/svg、`z-index` 用 token）。
- `scripts/bundle.mjs`：`emitBundle` 末段加打包 `grade-entry.js` → `dist/grade.<hash>.js` + 改寫 `dist/grade.html`（比照 exam 那段）。
- `vercel.json`：`/grade`、`/grade.html` → `no-store`；`/grade.(.*).js` → immutable。
- `sw.js`：`shouldBypassCache` 加 `/grade` `/grade.html`。
- `db.js`：`_callExamRpc` 加 7 個 wrapper（2 指派 + 5 批改）+ 錯誤訊息（`exam_grading_stale` / `exam_results_locked` / `exam_grading_not_assigned` / …）。
- 後台：`js/modules/exam.js` 加「簡答指派」子分頁（`exam_list_gradable_attempts` + `exam_assign_attempts`；牧區/狀態篩選、多選、NLC 會友搜尋）。

## 7. 已定案

| # | 決策 | 結果 |
|---|---|---|
| 1 | 身分與連結 | **A（NLC SSO 登入）+ C（依指派分卷）**。不做 magic-link token 表；批改名單＝被指派過的人。 |
| 2 | 伺服器草稿 L2 | **做**（`exam_grading_drafts`，PK `attempt_id`）。 |
| 3 | 一張卷幾人改 | **一人**。換人＝從未改完的卷重新指派；改派清草稿。已 graded 的不進改派流程（admin `p_force` 例外）。 |
| 4 | 評語 | **只有整卷評語**（`exam_attempts.grader_overall_comment`）。不做單題短評、不加 `exam_answers.grader_comment`。 |
| 5 | 送出後可改 | **可**，成績公布前重開覆蓋（`exam_grade_attempt` 可重複呼叫）。 |
| 6 | 顯示一~五大題 | **不顯示**。批改頁只有簡答題。 |
| 7 | 顯示身分 | **真實姓名 + 牧區 + 小組**（header 與名單都要）。 |

### 連結發送方式（定案）

- **先用一條共用連結群發**：`https://<站>/grade?paper=<id>`。每人點進去 SSO 登入後，`exam_get_grading_workspace` 只回指派給他自己的名單。
- 「每列複製個人連結」「指派後自動發站內通知」＝之後有需要再加，不在第一版。

### 指派介面位置（定案）

- 大測驗後台新增子分頁 **「簡答指派」**，和現有「簡答批改」**並列**（不取代）。
- 內容：`exam_list_gradable_attempts` 列出作答者（牧區/狀態/是否已指派可篩選、多選）→ 搜尋 NLC 會友 → `exam_assign_attempts` 指派/改派。

### 不在範圍

- 「今日小測驗」（`daily_quiz`）的簡答不用這頁，只服務大測驗。

## 8. 不能動的底線（沿用大測驗現有不變量）

| 不變量 | 守門位置 |
|---|---|
| 計分/結算/公布在 server，前端只顯示與輸入 | `exam_grade_attempt` / `exam_publish_results` |
| 成績公布後永久鎖定 | `_exam_results_locked`（0117），批改頁唯讀 |
| 寫入強制 scope（不跨卷/跨人誤寫） | RPC 內 `applyForcedScope` 式的 attempt_id/paper_id 綁定 |
| `exam_*` RPC 不進 SW 快取 | `sw.js` `shouldBypassCache` |
| 批改權限不放寬到 anon | 第 5 節驗證層 |
