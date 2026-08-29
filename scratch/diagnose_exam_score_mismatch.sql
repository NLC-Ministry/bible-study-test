-- ================================================================
-- 模擬測試卷 一次性診斷（Supabase SQL editor 直接整段貼上跑）
-- 三段各自 SELECT，結果分開回傳。整包貼回來即可。
-- ================================================================

-- (1) 有幾份「模擬測試卷」、哪份 test / 哪份 live
SELECT pr.id, pr.title, pr.mode, pr.status,
       pr.auto_score_enabled, pr.results_published_at, pr.pushed_from_id,
       pr.total_points,
       (SELECT COUNT(*) FROM public.exam_questions q WHERE q.paper_id = pr.id) AS questions,
       (SELECT COUNT(*) FROM public.exam_attempts  a WHERE a.paper_id = pr.id) AS attempts
FROM public.exam_papers pr
WHERE pr.title LIKE '%模擬測試卷%'
ORDER BY pr.mode, pr.created_at;

-- (2) 每一份的題目結構：各大題幾題、幾題有正解、配分
SELECT pr.mode, pr.id AS paper_id, q.section,
       COUNT(*)                                          AS q_count,
       COUNT(*) FILTER (WHERE q.answer_key IS NOT NULL)  AS with_key,
       SUM(q.points)                                     AS points_sum
FROM public.exam_papers pr
JOIN public.exam_questions q ON q.paper_id = pr.id
WHERE pr.title LIKE '%模擬測試卷%'
GROUP BY pr.mode, pr.id, q.section
ORDER BY pr.mode, q.section;

-- (3) 每一份的作答：狀態 / 分數 / 逐題判定統計
SELECT pr.mode, a.id AS attempt_id, pf.name AS examinee,
       a.status, a.auto_score, a.manual_score, a.total_score,
       COUNT(ea.*)                                                                          AS ans_total,
       COUNT(ea.*) FILTER (WHERE ea.section <> 'shortanswer' AND ea.auto_correct IS TRUE)   AS mark_true,
       COUNT(ea.*) FILTER (WHERE ea.section <> 'shortanswer' AND ea.auto_correct IS FALSE)  AS mark_false,
       COUNT(ea.*) FILTER (WHERE ea.section <> 'shortanswer' AND ea.auto_correct IS NULL)   AS mark_null,
       COALESCE(SUM(ea.awarded_points) FILTER (WHERE ea.section <> 'shortanswer'), 0)       AS sum_awarded_auto
FROM public.exam_papers pr
JOIN public.exam_attempts a ON a.paper_id = pr.id
LEFT JOIN public.profiles pf ON pf.id = a.user_id
LEFT JOIN public.exam_answers ea ON ea.attempt_id = a.id
WHERE pr.title LIKE '%模擬測試卷%'
GROUP BY pr.mode, a.id, pf.name, a.status, a.auto_score, a.manual_score, a.total_score
ORDER BY pr.mode, examinee;
