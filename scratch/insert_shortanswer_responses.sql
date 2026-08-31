-- 手動補寫大測驗簡答題答案（因傳送失敗、資料庫裡沒存到）。
-- 使用前請先跑 find_exam_attempt_for_missing_shortanswer.sql，確認：
--   1. 這位作答者的 attempt_id 是哪一筆（如果她有不只一份試卷的作答紀錄，
--      務必選對份數，不要選錯試卷）。
--   2. 三題簡答題目前 response 真的是空的，不是已經有內容只是還沒批改。
--
-- 用法：
-- 1. 把下面 target_attempt 的 UUID 換成確認過的 attempt_id。
-- 2. 直接在 Supabase Dashboard -> SQL Editor 執行整份腳本。
-- 3. 讀 STEP 1「即將寫入的內容」預覽——三列的 question_position 應該剛好
--    是 1、2、3，且都對應到目前這份試卷的簡答題。看起來不對就不要往下，
--    關掉分頁或改成 ROLLBACK。
-- 4. 沒問題才會走到最後的 COMMIT，正式生效。
--
-- 只補寫 response（作答內容本身），不動 awarded_points/grader_id/graded_at——
-- 這三題補寫後會照正常流程出現在「簡答批改」的待批清單，用後台批改功能
-- 評分即可，不需要在這裡順便打分數。

BEGIN;

WITH target_attempt(id) AS (
  VALUES ('REPLACE-WITH-ATTEMPT-ID'::uuid)
),
answers(position, response_text) AS (
  VALUES
    (1, '1-11章：神的創造與早期人類的歷史 12-50章：以色列先祖的歷史'),
    (2, '以色列是神揀選要彰顯祂自己的國家，也是全人類的歷史縮影，也是神首先呼召的國家，是神的選民'),
    (3, '談及神對人救贖的計劃，並賦予人使命，期待人人都活出神創造像祂的樣子，要和人一同治理神的國')
)
SELECT
  '即將寫入的內容' AS check_label,
  q.position AS question_position,
  q.payload->>'stem' AS question_stem,
  ans.response_text
FROM answers ans
JOIN target_attempt ta ON true
JOIN public.exam_questions q
  ON q.paper_id = (SELECT paper_id FROM public.exam_attempts WHERE id = ta.id)
 AND q.section = 'shortanswer'
 AND q.position = ans.position
ORDER BY q.position;

-- STOP AND READ 上面的預覽——三行、position 剛好 1/2/3，內容也對得上，
-- 再往下讓它繼續執行。

WITH target_attempt(id) AS (
  VALUES ('REPLACE-WITH-ATTEMPT-ID'::uuid)
),
answers(position, response_text) AS (
  VALUES
    (1, '1-11章：神的創造與早期人類的歷史 12-50章：以色列先祖的歷史'),
    (2, '以色列是神揀選要彰顯祂自己的國家，也是全人類的歷史縮影，也是神首先呼召的國家，是神的選民'),
    (3, '談及神對人救贖的計劃，並賦予人使命，期待人人都活出神創造像祂的樣子，要和人一同治理神的國')
)
INSERT INTO public.exam_answers (attempt_id, question_id, section, response)
SELECT
  ta.id,
  q.id,
  'shortanswer',
  to_jsonb(ans.response_text)
FROM answers ans
JOIN target_attempt ta ON true
JOIN public.exam_questions q
  ON q.paper_id = (SELECT paper_id FROM public.exam_attempts WHERE id = ta.id)
 AND q.section = 'shortanswer'
 AND q.position = ans.position
ON CONFLICT (attempt_id, question_id) DO UPDATE
  SET response = EXCLUDED.response,
      updated_at = NOW()
  WHERE public.exam_answers.awarded_points IS NULL; -- 已經批改過的答案不覆蓋，保護起見

-- 最後檢查一次，應該剛好是 3 筆、response 都不是 NULL：
WITH target_attempt(id) AS (VALUES ('REPLACE-WITH-ATTEMPT-ID'::uuid))
SELECT COUNT(*) AS 應該是3, COUNT(*) FILTER (WHERE response IS NOT NULL) AS 應該也是3
FROM public.exam_answers ea
JOIN target_attempt ta ON ea.attempt_id = ta.id
JOIN public.exam_questions q ON q.id = ea.question_id
WHERE q.section = 'shortanswer' AND q.position IN (1, 2, 3);

-- 一切正常才下這行，正式生效：
COMMIT;

-- 如果任何一步看起來不對，改成執行這行來取消，資料不會有任何變動：
-- ROLLBACK;
