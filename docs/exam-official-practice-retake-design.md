# 大測驗「作答回顧＋重作模式」設計報告

## 1. 目標

1. 正式首考送出後，使用者可立即查看自己每一題填寫的內容與未作答狀況，但不能修改。
2. 正式成績公布前，不顯示對錯、得分、正解、簡答評語或參考答案。
3. 每人可開啟一份「重作練習卷」；管理員手動關閉或活動時間到自動關閉前，可反覆修改與儲存，沒有個人倒數，且不列入正式成績、統計、排行或團隊分數。
4. 後台把正式首考與重作紀錄完全分流，避免批改、統計與通知混在一起。
5. 所有資格、次數、分數歸屬與資料可見性均由伺服器強制，不能只靠前端按鈕。

## 2. 建議規則

### 2.1 正式首考

- 每位使用者每份正式卷只能有 1 筆正式 attempt。
- 首考照既有開放時間、限時、宣示與自動收卷規則。
- 首考是唯一可列入個人正式成績、組織統計、題目分析、3/6 人團隊統計與排行的作答。
- 首考簡答題進入正式批改佇列，並阻擋「公布成績」直到全部批完。

### 2.2 送出後立即查看

- 可看：試卷題目、自己的作答、未作答標記、送出時間、送出原因。
- 不可看：答對/答錯、各題得分、總分、正解、簡答參考答案、評分要點、管理員評語。
- 畫面標示「正式作答已送出，答案已鎖定」。
- 成績公布後，同一頁才解鎖正式分數、對錯、正解與簡答評語。

### 2.3 重作練習模式

- 每位使用者只有 1 份重作練習卷（首考 1 份＋練習卷 1 份），不是一次又一次建立新的 attempt。
- 只有正式首考已送出後才能開啟練習卷，不能在首考進行中建立。
- 重作開始前必須出現確認頁：
  - 「現在是重作模式」
  - 「本次分數不列入正式成績、排行或團隊統計」
  - 「你的正式首考答案與成績不會被覆蓋」
- 重作使用新的 attempt、獨立答案與獨立排列；絕不覆寫首考。
- 重作**沒有個人限時倒數**；可編輯期限固定等於正式測驗活動的 `close_at`。
- 試卷關閉前（管理員手動關閉，或 `close_at` 到達後自動關閉），可不限次數返回、修改與自動儲存答案；不提供不可逆的「正式送出」動作。
- 使用者可按「暫時完成練習」離開，但這只是離開畫面，不會鎖定答案；活動結束前仍可回來修改。
- 試卷關閉後，由伺服器凍結練習卷，之後只能查看、不能再修改。
- 練習卷在凍結時才計算自動題練習分數；正式成績公布前仍不向使用者顯示，避免提前推知正式答案。
- 重作簡答題預設不進正式人工批改佇列，也不阻擋正式成績公布；後台僅供檢視。若未來要提供練習回饋，應另做「重作回饋」流程，不與正式批改共用。
- 重作不發「正式成績公布」通知。

### 2.4 可重作時段

- 從正式首考送出後開始，到試卷 `status='closed'` 前可建立、返回及修改練習卷。
- 管理員手動關閉，或伺服器在 `NOW() >= close_at` 時自動關閉後，不可再建立練習卷，也不可更改既有練習答案。
- 新增 `practice_retake_enabled` 開關；預設開啟。練習截止不另設第二個時間欄位，唯一權威是試卷 `status='closed'`。
- `close_at` 是自動結束活動的權威時間。到時若試卷仍是 `published`，伺服器必須自動轉成 `closed`，結束正式作答與重作練習並開放評分流程；管理員也可以提前手動關閉。
- 正式成績只能在關閉測驗後公布；此時練習答案已同步鎖定。

## 3. 資料結構

### 3.1 `exam_attempts` 新欄位

| 欄位 | 型別 | 用途 |
|---|---|---|
| `attempt_kind` | TEXT | `official` 或 `practice`；既有資料全部回填 `official` |
| `attempt_no` | SMALLINT | 保留版本識別；目前 official/practice 都固定為 1 |
| `official_attempt_id` | UUID NULL | 重作 attempt 指向該使用者的正式首考；正式首考為 NULL |
| `practice_acknowledged_at` | TIMESTAMPTZ NULL | 使用者確認「不列入成績」的存證 |
| `practice_completed_at` | TIMESTAMPTZ NULL | 使用者按「暫時完成練習」的時間；不代表鎖定，之後仍可修改 |

約束：

- `attempt_kind IN ('official','practice')`
- official：`attempt_no=1 AND official_attempt_id IS NULL`
- practice：`official_attempt_id IS NOT NULL`
- partial unique index：每份卷每位使用者只能一筆 official。
- unique index：`(paper_id, user_id, attempt_kind)`，確保每人只有一份 official 與一份 practice，並防止雙點或雙裝置建立重複練習卷。
- foreign key：`official_attempt_id -> exam_attempts(id) ON DELETE CASCADE`。

現有的 `UNIQUE (paper_id, user_id)` 必須移除；不能只是移除而不補上述兩個唯一索引，否則所有「我的作答」查詢會變成不確定多筆。

### 3.2 `exam_papers` 新欄位

| 欄位 | 型別 | 建議預設 | 用途 |
|---|---|---:|---|
| `practice_retake_enabled` | BOOLEAN | TRUE | 是否允許重作 |

不新增獨立的 `practice_open_until`：重作練習的唯一鎖定條件是 `exam_papers.status='closed'`。

### 3.3 `exam_answers`

- 不需新增 attempt 類型欄位，因為 `attempt_id` 已能明確連到 official/practice。
- `UNIQUE (attempt_id, question_id)` 維持不變。
- 所有後台查詢必須透過 `exam_attempts.attempt_kind` 分類，禁止只用 `paper_id` 混合彙總。

## 4. RPC 與伺服器規則

### 4.1 啟動作答

建議將現有 `exam_start_attempt` 擴充 `p_attempt_kind`，或新增版本化 RPC：

- official：沿用原規則，找到既有 official 就續作或回已送出狀態。
- practice：伺服器驗證正式首考存在且已送出、開關已開、試卷尚未 `closed`、`NOW() < close_at`、已確認重作聲明，再取得或建立該使用者唯一的練習 attempt。
- practice 不使用個人 deadline 判斷可否編輯；每次儲存都重新檢查試卷是否仍未 `closed`，避免使用者在管理員關閉後用舊頁面繼續寫入。
- actor 一律由 `resolve_quiz_actor` 決定，前端不可傳入任意 user id。
- 使用 transaction＋唯一索引處理雙擊/雙裝置競態。

### 4.2 取得作答與結果

目前 `exam_get_for_attempt` / `exam_get_my_result` 只以 `paper_id` 找一筆，加入重作後必須改為明確識別：

- `exam_get_for_attempt(paper_id, attempt_kind, attempt_id?)`
- `exam_get_my_result(attempt_id)`，RPC 內驗證該 attempt 屬於 actor；staff 才可看別人的。
- 回傳固定包含：`attemptId`、`attemptKind`、`attemptNo`、`isOfficial`、`countsTowardScore`、`resultsPublished`、`reviewVisibility`。

`reviewVisibility` 建議值：

- `responses_only`：只看題目與自己的填答。
- `full_review`：可看對錯、得分、正解與評語。

### 4.3 自動收卷與計分

- official 維持現有 `exam_submit_attempt` 與個人倒數收卷。
- **試卷尚未關閉時，official 送出只保存作答，不執行自動判分**：`auto_correct`、`awarded_points`、`auto_score`、`total_score` 保持 NULL，狀態停在 `submitted`。
- practice 不走不可逆的 `exam_submit_attempt`；試卷關閉前只走具 actor ownership 與 paper status 檢查的 `exam_save_progress`。
- 管理員手動關閉或時間到自動關閉時，伺服器先原子地把 paper 改成 `closed`，再凍結所有 practice；從這一刻開始任何舊頁面的儲存都必須被 RPC 拒絕。
- 關閉後才允許 `exam_recompute_scores` 執行正式自動評分。若關閉當下 `auto_score_enabled=TRUE` 且正解完整，可由關閉流程接著自動計分；若開關為 FALSE 或正解未完整，則維持未評分，等管理員填完正解、開啟自動評分後再手動重新計分。
- practice 的練習自動分也只能在關閉後計算，且永遠 `countsTowardScore=false`。
- practice 的 `countsTowardScore=false` 永遠由 attempt_kind 推導，不能由前端指定。
- practice 不可改寫 official 的任何 score/status/notification。

### 4.3.1 評分狀態機防呆

| 試卷狀態 | 收答案 | 修改練習答案 | 自動評分 | 簡答批改 | 公布答案/成績 |
|---|---:|---:|---:|---:|---:|
| `draft` | 否 | 否 | 否 | 否 | 否 |
| `published` | 是 | 是 | **禁止** | **禁止** | **禁止** |
| `closed` | 否 | 否 | 允許 | 允許 | 全部結算後允許 |

伺服器防呆：

- `exam_submit_attempt`：paper 未 closed 時只存答案、不判分。
- `exam_recompute_scores`：paper 不是 closed → `exam_scoring_before_close`。
- `exam_grade_answer`：paper 不是 closed → `exam_grading_before_close`。
- `exam_publish_results`：paper 不是 closed → `exam_results_before_close`。
- `exam_set_answer_key`：建議 paper 尚未 closed 時仍可由管理員填入，但不得觸發計分；若要最高隔離，也可設定為 closed 後才允許。前端不會向作答者下發 answer_key。
- 上述限制必須寫在 SECURITY DEFINER RPC，不能只把前端按鈕藏起來。

### 4.3.2 到時自動關閉機制

自動關閉不能依賴使用者瀏覽器或前端倒數，因為活動時間到時可能沒有人開著頁面。建議採雙重保證：

1. **資料庫排程（主要）**：使用 Supabase `pg_cron` 每分鐘執行 `_exam_close_expired_papers()`，找出 `status='published' AND close_at <= NOW()` 的試卷並關閉。
2. **惰性補償（備援）**：`exam_home_banner`、`exam_get_for_attempt`、`exam_save_progress`、`exam_get_stats`、`exam_publish_results` 進入時都先呼叫同一個 helper；即使排程暫時失效，下一個請求也會補關閉。

`_exam_close_paper(paper_id, reason)` 必須是唯一共用關閉流程，手動與自動都呼叫它：

- 以 `UPDATE ... WHERE status='published' RETURNING` 原子搶鎖，確保只關閉一次。
- 記錄 `closed_at`、`closed_by`（自動關閉為 NULL）與 `close_reason='manual'|'scheduled'`。
- 收卷所有仍在進行中的 official attempt。
- 凍結所有 practice attempt。
- 若 `auto_score_enabled=TRUE` 且正解完整，關閉後才執行自動評分；否則維持待評分。
- 不在關閉時自動公布成績或正解；仍需管理員完成簡答批改後按「公布成績」。

若環境無法啟用 `pg_cron`，惰性補償仍能保證資料狀態在下一個請求時修正，但不能保證無請求期間精準在該分鐘更新；因此正式部署應優先啟用資料庫排程。

### 4.4 公布成績

- `exam_publish_results` 必須要求 `paper.status='closed'`；關閉前不可公布正式分數與正解。
- `exam_publish_results` 的未完成檢查只計 official attempt。
- 通知只對 official graded attempt 建立。
- `results_published_at` 仍鎖定正解、正式重算、正式批改與正式資料；此時活動已結束，practice 也已凍結，只能查看。

## 5. 後台資訊架構

### 5.1 建議子分頁

1. **正式成績**
   - 只顯示 official。
   - 名冊：姓名、組織、團隊、狀態、自動分、簡答分、總分、送出時間。
   - 作為 CSV、平均、排行、3/6 人團隊統計唯一資料來源。

2. **正式簡答批改**
   - 只顯示 official shortanswer。
   - 篩選：待批／已批／全部。
   - 顯示「正式首考」標籤，不會混入重作。

3. **重作紀錄**
   - 只顯示 practice。
   - 每位使用者一列練習卷，展開顯示進度、最後儲存時間、暫時完成時間、凍結時間與練習自動分。
   - 明顯標示「不列入成績」。
   - 可檢視每題作答；簡答預設唯讀、不出現在待批數。

4. **題目分析**
   - 預設只分析 official，避免練習後熟悉題目造成正確率虛高。
   - 可選「重作分析」作為教學參考，但畫面與 CSV 必須有獨立區塊，不提供混合值。

### 5.2 禁止的混合方式

- 不可在同一 roster 內把首考與重作當兩位考生。
- 不可用「取最高分」「取最後一次」覆蓋正式首考。
- 不可讓 practice 進團隊總分、平均分、排名、完成率或成績公布完成條件。
- 不可讓 practice 的待批簡答增加正式待批數。

## 6. 使用者流程

### 首考送出後、成績未公布

- 首頁顯示：`查看我的作答`、`開始重作練習（不列入成績）`。
- 查看作答：每題顯示「你的作答」，未答題顯示「未作答」；所有欄位唯讀。
- 不顯示任何分數與正解。

### 進入重作練習

- 顯示獨立確認畫面與勾選聲明。
- 頂部全程固定標籤：`重作模式｜不列入正式成績`。
- 不顯示個人倒數；顯示「可修改至活動結束：日期時間」。
- 每次更改自動儲存，可按「暫時完成練習」離開；活動結束前再次進入會回到同一份練習卷並可繼續修改。
- 管理員提前關閉或活動時間到自動關閉後，練習卷立即鎖定，不會跳回或覆蓋正式首考。

### 成績公布後

- `正式成績`：顯示正式首考完整檢討。
- `重作紀錄`：顯示練習結果並持續標示不列入成績。
- 首頁主要 CTA 仍優先正式成績；重作放次要按鈕。

## 7. 安全、完整性與有效性

- 正式/重作分類寫入資料庫並由 RPC 驗證，不能相信前端 `countsTowardScore`。
- 正式統計、批改、公布、通知每支 RPC 都要顯式加 `attempt_kind='official'`。
- leader 的統計範圍沿用 0121 的組織 scope；重作檢視也必須套相同 fail-closed scope，不能因新分頁暴露全教會資料。
- live 已有人作答後的 push guard 維持；重作同樣算「有人作答」，不可推題換 question id。
- 作答快照、server deadline、逾時自動收卷、冪等送出維持不變。
- migration 回填與索引建立應在同一交易完成，避免短暫失去唯一性。

## 8. 遷移與交付順序

1. Schema migration：新增欄位、回填 existing attempts=official、移除舊唯一約束、建立 partial/compound unique indexes。
2. RPC migration：明確 attempt 識別、重作建立、結果可見性、收卷、正式批改/統計/公布過濾。
3. nlc-data allowlist：新增必要 RPC，保持 actor 注入與角色閘門。
4. db.js：所有結果/作答方法改傳 attempt id/kind。
5. runner：送出回顧唯讀、重作聲明、固定重作標籤。
6. home banner：正式狀態與重作狀態分開回傳、CTA 分流。
7. admin：正式成績／正式批改／重作紀錄／題目分析分頁。
8. 測試：雙擊建立、雙裝置、逾時、斷線、正式公布前後、重作不入統計、leader scope、通知只發正式首考。

## 9. 驗收標準

- 首考送出後立即可唯讀查看自己的每題填答。
- 未公布前一般使用者無法從任何 RPC 取得正解、對錯、分數、評語或 rubric。
- 同一使用者最多 1 筆 official 與 1 筆 practice。
- practice 在 paper 未 closed 且 `NOW() < close_at` 前可反覆修改；手動或自動關閉後所有儲存 RPC 都由伺服器拒絕。
- 重作分數不出現在正式名冊、平均、排行、團隊統計、CSV、待批數及公布條件。
- 管理員能以清楚分頁查看正式作答與重作紀錄，不會同名重複混列。
- 成績公布後正式資料仍永久鎖定，重作不會解除或繞過鎖定。
