-- ============================================================================
-- 0097_exam_result_section_order.sql
-- 修正 exam_get_my_result 的逐題結果排序：exam_questions.section 是 TEXT，
-- 原本 ORDER BY q.section 會按字母排（matching, multiple, ordering, shortanswer,
-- single, truefalse），畫面上看起來是亂序。改用固定的大題序（一~六）。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public._exam_section_rank(p_section TEXT)
RETURNS INTEGER
LANGUAGE SQL IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_section
    WHEN 'truefalse'   THEN 1
    WHEN 'single'      THEN 2
    WHEN 'multiple'    THEN 3
    WHEN 'matching'    THEN 4
    WHEN 'ordering'    THEN 5
    WHEN 'shortanswer' THEN 6
    ELSE 99
  END;
$$;
REVOKE ALL ON FUNCTION public._exam_section_rank(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.exam_get_my_result(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  at       public.exam_attempts%ROWTYPE;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = p_paper_id AND user_id = actor_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_attempt'); END IF;
  IF at.status = 'in_progress' THEN RETURN jsonb_build_object('state', 'in_progress'); END IF;

  RETURN jsonb_build_object(
    'state', at.status,
    'autoScore', at.auto_score, 'manualScore', at.manual_score, 'totalScore', at.total_score,
    'submittedAt', at.submitted_at,
    'answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'questionId', ea.question_id, 'section', ea.section, 'position', q.position,
        'sectionRank', public._exam_section_rank(ea.section),
        'response', ea.response, 'autoCorrect', ea.auto_correct, 'awardedPoints', ea.awarded_points,
        'graderComment', ea.grader_comment,
        'answerKey', CASE WHEN at.status = 'graded' AND ea.section <> 'shortanswer'
                          THEN q.answer_key ELSE NULL END)
      ORDER BY public._exam_section_rank(ea.section), q.position)
      FROM public.exam_answers ea JOIN public.exam_questions q ON q.id = ea.question_id
      WHERE ea.attempt_id = at.id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_get_my_result(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_get_my_result(uuid, uuid) TO authenticated, service_role;
