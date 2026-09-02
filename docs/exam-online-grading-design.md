# 簡答批改 — Google 試算表往返（Option B）

> 狀態：**已實作，尚未部署 / 未 commit**（2026-09-03，版本 `20260903_grading_sheet_csv`）。
> 交付：migration `0146_exam_grading_sheet_roundtrip.sql`、`supabase/functions/nlc-data/index.ts`、
> `js/db.js`、`js/modules/exam.js`（「簡答批改」分頁的匯出 / 匯回）、`index.css`。
> build + 測試通過。未做 runtime 驗證。

## 決策脈絡

原本規劃過「線上批改頁 grade.html + 指派」（Option A，2026-09-03 一度實作、commit `982f48f`），
後來使用者改主意：**不指派、不登入、拿連結大家一起改還沒改完的**。

分析後（見對話）三個方向：

| | A 公開連結直寫 DB | **B Google 共編試算表** | C 公開連結 → 暫存表 → 管理員採用 |
|---|---|---|---|
| 連結外流最壞情況 | 正式分數被亂改 | 試算表被亂改（不碰 DB） | 暫存表塞垃圾 |
| 新增對外開口 | 要（不驗登入的通道） | **不用**（匯出匯回都在已登入後台） | 要 |
| 工 | 中 | **小** | 大 |

使用者選 **B**，且匯回用**手動 CSV 下載 / 上傳**（不寫 Apps Script、不設 secret）。
Option A 的檔案（grade.html / grade-entry.js / grading.js / 指派 RPC / 指派子分頁 / bundle・vercel・sw 的 grade 區塊）**全部還原**。

## 工作流

1. 大測驗 → 選試卷 → **「簡答批改」分頁** → 展開「用 Google 試算表批改」→ **「匯出批改用 CSV」**
   下載 `批改_<卷名>.csv`，一位作答者一列：

   `作答ID | 姓名 | 牧區 | 小組 | 送出時間 | 第1題題目 | 第1題作答 | 參考答案1 | 第1題得分 | 第1題配分 | …(2、3題) | 整卷評語 | 認領人`

   - 每一道簡答題都有欄，**含未作答的**（顯示「（未作答）」，批改人填 0）
   - 「第N題得分」「整卷評語」若已經有分數 / 評語會帶進去（可重複循環）

2. 管理員把 CSV `檔案 → 匯入` 進一份新的 Google Sheet，設「知道連結的人可編輯」，群發批改同工。
   - 建議：把「作答ID / 題目 / 作答」欄設**保護範圍**，只有管理員能改
   - 建議加一欄公式算總分、超配分標紅（例：`=IF(SUM(I2,N2,S2)>SUM(J2,O2,T2),"⚠超過",SUM(I2,N2,S2))`，欄位對應依實際）
   - 大家填「認領人」、篩「第N題得分」空白的來改 → 就是「改還沒改完的」

3. 改完 → 管理員 `檔案 → 下載 → CSV` → 回「簡答批改」→ **「從 CSV 匯回…」**選檔
   - 先出**預覽**：`N 位可寫入、M 列有問題（列出哪列、什麼問題）`
   - 按「確定匯回」→ `exam_apply_sheet_grades`
   - 逐列處理：一列有問題只跳過那列；回報「已寫入 N 位、M 位沒寫入（原因）」
   - **可重複匯回**（以「作答ID」對應，分數覆寫）；成績一旦公布 → `exam_results_locked`

## 後端（migration `0146`，未部署）

- `ALTER TABLE exam_attempts ADD COLUMN grader_overall_comment TEXT` — 整卷評語（唯一評語欄）
- `exam_grading_sheet_rows(p_paper_id, p_actor_id)` — admin/pastor。回一位作答者一物件，
  `questions` 帶齊每道簡答題（LEFT JOIN answers，未作答的也在），依 牧區 → 小組 → 姓名 排序。
- `exam_apply_sheet_grades(p_paper_id, p_rows, p_actor_id)` — admin/pastor。
  `p_rows = [{ attemptId, grades:[{position, points}], overall }]`。
  逐列 subtransaction：驗 attempt 屬於此卷 / official / submitted|graded；grades 要涵蓋所有簡答題 position；
  每題 `0 ≤ points ≤ 該題配分`；用 position 對到 question_id 後 upsert `exam_answers.awarded_points`；
  寫 `exam_attempts.grader_overall_comment`；全給分且（有自動題時）`auto_score` 已算 → 結算
  `manual_score / total_score / status='graded'`。`results_published_at` 非空 → 整批擋 `exam_results_locked`。
- `nlc-data`：`exam_grading_sheet_rows` / `exam_apply_sheet_grades` 進 `EXAM_RPC_FUNCTIONS` +
  `EXAM_ADMIN_RPC_FUNCTIONS`。**需重部署 Edge Function。**

## 前端

- `js/db.js`：`getGradingSheetRows(paperId)` / `applySheetGrades(paperId, rows)` + 錯誤訊息
  `exam_sheet_invalid` / `exam_sheet_too_large`。
- `js/modules/exam.js`（`renderExamGrading` 內）：
  - `<details class="exam-admin__grade-sheet">` 區塊：「匯出批改用 CSV」「從 CSV 匯回…」+ 隱藏 file input + 結果區
  - `parseCsv(text)`：RFC4180 風格極簡解析（引號 / `""` / `\r\n` / BOM），濾掉全空列
  - `exportGradingCsv(paperId, title, btn)`：`getGradingSheetRows` → pivot 成一列一人 → `Blob` 下載（BOM + `\r\n`）
  - `importGradingCsv(paperId, file, resultBox, onDone)`：`file.text()` → `parseCsv` → 依表頭
    找「作答ID」「整卷評語」「第N題得分」欄 → 前端先驗（UUID、分數非空且 ≥ 0）→ 預覽 →
    「確定匯回」→ `applySheetGrades` → 顯示結果 → 1.2s 後重繪批改分頁
- `index.css`：`.exam-admin__grade-sheet*` / `.exam-admin__sheet-problems`

## 部署順序

1. SQL editor 跑 `0146_exam_grading_sheet_roundtrip.sql`
2. 重新部署 `nlc-data`（不然兩支 RPC 被擋 `forbidden_rpc`）
3. 部署前端
4. 「大測驗」feature flag 要開著
5. 大測驗 → 選試卷 → 「簡答批改」→「用 Google 試算表批改」→ 匯出 → 開共編 → 匯回

## 邊界 / 已知限制

- 匯回信任 CSV 內容（管理員自己下載的）；靠「作答ID」對應，ID 被改壞的列會被預覽標出、不寫入。
- 沒有「誰改的」的稽核（Google 那邊有逐格編輯紀錄 + 認領人欄）。
- 未作答題也要在試算表填 0，才會結算為「已批改」。
- 匯回不刪分數，只覆寫；要「退回未批」需另外處理（目前沒有）。
- 大測驗的自動題（一~五大題）不走這條，仍由 `exam_recompute_scores` / `exam_publish_results`。
