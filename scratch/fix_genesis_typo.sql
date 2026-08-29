-- ============================================================================
-- fix_genesis_typo.sql
-- 「創世紀」是錯字，正確是「創世記」（言字旁，不是糸字旁）。
-- 程式碼 / 計畫資料（bible_data.js、church_campaign.js）都已是「創世記」，
-- 錯字只可能在資料庫的內容欄位（測驗卷 / 題目 / 公告等由後台或 seed 寫入）。
--
-- Supabase SQL editor：先跑「診斷」看在哪，再跑「修正」。
-- 「創世紀」不會有正當用途，全部換成「創世記」是安全的。
-- ============================================================================

-- ── 診斷：哪些資料含錯字 ──
SELECT 'exam_papers.title' AS loc, id::text, title AS sample
FROM public.exam_papers WHERE title LIKE '%創世紀%'
UNION ALL
SELECT 'exam_papers.description', id::text, description
FROM public.exam_papers WHERE description LIKE '%創世紀%'
UNION ALL
SELECT 'exam_papers.announcement', id::text, announcement::text
FROM public.exam_papers WHERE announcement::text LIKE '%創世紀%'
UNION ALL
SELECT 'exam_questions.payload', id::text, left(payload::text, 120)
FROM public.exam_questions WHERE payload::text LIKE '%創世紀%'
UNION ALL
SELECT 'exam_questions.answer_key', id::text, answer_key::text
FROM public.exam_questions WHERE answer_key::text LIKE '%創世紀%'
UNION ALL
SELECT 'church_announcements', id::text, title
FROM public.church_announcements WHERE title LIKE '%創世紀%' OR content LIKE '%創世紀%'
UNION ALL
SELECT 'daily_quizzes.questions', id::text, left(questions::text, 120)
FROM public.daily_quizzes WHERE questions::text LIKE '%創世紀%'
UNION ALL
SELECT 'global_plans', id::text, name
FROM public.global_plans WHERE name LIKE '%創世紀%' OR description LIKE '%創世紀%' OR rules::text LIKE '%創世紀%'
UNION ALL
SELECT 'reading_plans.name', id::text, name
FROM public.reading_plans WHERE name LIKE '%創世紀%'
UNION ALL
SELECT 'devotional_notes.content', id::text, left(content, 120)
FROM public.devotional_notes WHERE content LIKE '%創世紀%';

-- ── 修正 ──
BEGIN;

UPDATE public.exam_papers
SET title = replace(title, '創世紀', '創世記')
WHERE title LIKE '%創世紀%';

UPDATE public.exam_papers
SET description = replace(description, '創世紀', '創世記')
WHERE description LIKE '%創世紀%';

UPDATE public.exam_papers
SET announcement = replace(announcement::text, '創世紀', '創世記')::jsonb
WHERE announcement::text LIKE '%創世紀%';

UPDATE public.exam_questions
SET payload = replace(payload::text, '創世紀', '創世記')::jsonb
WHERE payload::text LIKE '%創世紀%';

UPDATE public.exam_questions
SET answer_key = replace(answer_key::text, '創世紀', '創世記')::jsonb
WHERE answer_key::text LIKE '%創世紀%';

UPDATE public.church_announcements
SET title = replace(title, '創世紀', '創世記'),
    content = replace(content, '創世紀', '創世記')
WHERE title LIKE '%創世紀%' OR content LIKE '%創世紀%';

UPDATE public.daily_quizzes
SET questions = replace(questions::text, '創世紀', '創世記')::jsonb
WHERE questions::text LIKE '%創世紀%';

UPDATE public.global_plans
SET name = replace(name, '創世紀', '創世記'),
    description = replace(COALESCE(description, ''), '創世紀', '創世記'),
    rules = replace(rules::text, '創世紀', '創世記')::jsonb
WHERE name LIKE '%創世紀%' OR description LIKE '%創世紀%' OR rules::text LIKE '%創世紀%';

UPDATE public.reading_plans
SET name = replace(name, '創世紀', '創世記')
WHERE name LIKE '%創世紀%';

UPDATE public.devotional_notes
SET content = replace(content, '創世紀', '創世記')
WHERE content LIKE '%創世紀%';

COMMIT;

-- ── 驗證：應該回 0 列 ──
SELECT count(*) AS remaining FROM (
  SELECT 1 FROM public.exam_papers WHERE title LIKE '%創世紀%' OR description LIKE '%創世紀%' OR announcement::text LIKE '%創世紀%'
  UNION ALL SELECT 1 FROM public.exam_questions WHERE payload::text LIKE '%創世紀%' OR answer_key::text LIKE '%創世紀%'
  UNION ALL SELECT 1 FROM public.church_announcements WHERE title LIKE '%創世紀%' OR content LIKE '%創世紀%'
  UNION ALL SELECT 1 FROM public.daily_quizzes WHERE questions::text LIKE '%創世紀%'
  UNION ALL SELECT 1 FROM public.global_plans WHERE name LIKE '%創世紀%' OR description LIKE '%創世紀%' OR rules::text LIKE '%創世紀%'
  UNION ALL SELECT 1 FROM public.reading_plans WHERE name LIKE '%創世紀%'
  UNION ALL SELECT 1 FROM public.devotional_notes WHERE content LIKE '%創世紀%'
) t;
