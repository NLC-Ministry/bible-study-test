-- 診斷用（唯讀，不會改任何資料）：查詢某位作答者的大測驗作答狀態，
-- 用來確認「簡答題沒有成功送出」的實際情況——她的 exam_attempts 到底存不存在、
-- 是哪一份試卷、目前狀態如何，以及三題簡答題現在資料庫裡是什麼樣子
-- （完全沒有那一列、還是有列但 response 是空的）。
--
-- 用法：把下面 :target_name 改成要查的人名，在 Supabase Dashboard -> SQL Editor
-- 執行。看完結果再決定要不要往下跑 insert_shortanswer_responses.sql。

WITH target_name(name) AS (VALUES ('傅敬媛'))
SELECT
  p.id   AS profile_id,
  p.name AS profile_name
FROM public.profiles p, target_name t
WHERE p.name = t.name;

-- 她所有的大測驗作答紀錄（可能不只一份試卷）：
WITH target_name(name) AS (VALUES ('傅敬媛'))
SELECT
  a.id            AS attempt_id,
  a.paper_id,
  pr.title        AS paper_title,
  pr.status       AS paper_status,
  a.status        AS attempt_status,
  a.submitted_at,
  a.auto_score,
  a.manual_score,
  a.total_score
FROM public.exam_attempts a
JOIN public.profiles p ON p.id = a.user_id
JOIN public.exam_papers pr ON pr.id = a.paper_id
JOIN target_name t ON p.name = t.name
ORDER BY a.created_at DESC;

-- 針對「上面查到的 attempt_id」（如果只有一份試卷，貼進下面 :target_attempt_id；
-- 有多份的話先確認是哪一份再繼續），列出簡答題第 1~3 題目前的狀態：
-- 有列出來但 response 是 NULL，代表資料列存在、只是答案沒存進去；
-- 完全沒列出來，代表連那一列都還沒建立。
WITH target_attempt(id) AS (VALUES ('REPLACE-WITH-ATTEMPT-ID'::uuid))
SELECT
  q.position,
  q.payload->>'stem' AS question_stem,
  ea.id  AS answer_row_id,
  ea.response,
  ea.awarded_points
FROM public.exam_questions q
JOIN target_attempt ta ON true
LEFT JOIN public.exam_answers ea
  ON ea.attempt_id = ta.id AND ea.question_id = q.id
WHERE q.paper_id = (SELECT paper_id FROM public.exam_attempts WHERE id = ta.id)
  AND q.section = 'shortanswer'
  AND q.position IN (1, 2, 3)
ORDER BY q.position;

-- 如果上面那段完全「No rows returned」，用這兩段抓出到底是哪裡對不上：

-- A. 這個 attempt_id 是不是真的存在？（貼的可能貼錯，或貼成 paper_id）
--    如果這裡也是 0 筆，代表 attempt_id 貼錯了，回上面第 2 段查詢重新複製。
WITH target_attempt(id) AS (VALUES ('REPLACE-WITH-ATTEMPT-ID'::uuid))
SELECT * FROM public.exam_attempts a JOIN target_attempt ta ON a.id = ta.id;

-- B. 如果 A 有查到資料，看這份試卷實際上有哪些題目、幾大題、每大題各有
--    幾題——確認「簡答題」這個大題是不是真的存在、位置編號是不是 1/2/3。
WITH target_attempt(id) AS (VALUES ('REPLACE-WITH-ATTEMPT-ID'::uuid))
SELECT q.section, q.position, q.payload->>'stem' AS question_stem
FROM public.exam_questions q
JOIN target_attempt ta ON true
WHERE q.paper_id = (SELECT paper_id FROM public.exam_attempts WHERE id = ta.id)
ORDER BY q.section, q.position;
