-- 0130_exam_full_paper_result.sql
-- 查看成績必須回傳完整試卷；以 questions 為主 LEFT JOIN answers，未作答題也不可漏掉。

CREATE OR REPLACE FUNCTION public.exam_get_my_result(
  p_paper_id UUID,p_actor_id UUID DEFAULT NULL,p_attempt_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN:=public._exam_actor_role(actor_id)IN('admin','pastor');
  at public.exam_attempts%ROWTYPE;pr public.exam_papers%ROWTYPE;published BOOLEAN;show_full BOOLEAN;
BEGIN
  PERFORM public._exam_close_expired_papers();
  IF p_attempt_id IS NOT NULL THEN
    SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND paper_id=p_paper_id
      AND(user_id=actor_id OR is_staff);
  ELSE
    SELECT * INTO at FROM public.exam_attempts WHERE paper_id=p_paper_id AND user_id=actor_id AND attempt_kind='official';
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','no_attempt'); END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  published:=pr.results_published_at IS NOT NULL;
  show_full:=(at.status='graded')AND(published OR is_staff);
  RETURN jsonb_build_object(
    'state',CASE WHEN at.status='in_progress'THEN'in_progress' WHEN show_full THEN'graded' ELSE'submitted' END,
    'attemptId',at.id,'attemptKind',at.attempt_kind,'countsTowardScore',at.attempt_kind='official',
    'resultsPublished',published,'staffPreview',(show_full AND NOT published AND is_staff),
    'reviewVisibility',CASE WHEN show_full THEN'full_review' ELSE'responses_only' END,
    'autoScore',CASE WHEN show_full THEN at.auto_score ELSE NULL END,
    'manualScore',CASE WHEN show_full THEN at.manual_score ELSE NULL END,
    'totalScore',CASE WHEN show_full THEN at.total_score ELSE NULL END,
    'submittedAt',at.submitted_at,'practiceCompletedAt',at.practice_completed_at,
    'answers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'questionId',q.id,'section',q.section,'position',q.position,'points',q.points,
      'sectionRank',public._exam_section_rank(q.section),'response',ea.response,
      'autoCorrect',CASE WHEN show_full THEN ea.auto_correct ELSE NULL END,
      'awardedPoints',CASE WHEN show_full THEN ea.awarded_points ELSE NULL END,
      'graderComment',CASE WHEN show_full AND at.attempt_kind='official' THEN ea.grader_comment ELSE NULL END,
      'payload',CASE WHEN show_full THEN q.payload ELSE public._exam_public_payload(q.section,q.payload,q.points)END,
      'answerKey',CASE WHEN show_full AND q.section<>'shortanswer'THEN q.answer_key ELSE NULL END)
      ORDER BY public._exam_section_rank(q.section),q.position)
      FROM public.exam_questions q LEFT JOIN public.exam_answers ea
        ON ea.question_id=q.id AND ea.attempt_id=at.id
      WHERE q.paper_id=at.paper_id),'[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.exam_get_my_result(UUID,UUID,UUID) TO authenticated;

COMMENT ON FUNCTION public.exam_get_my_result(UUID,UUID,UUID)
IS '回傳本人完整試卷結果；所有題目皆保留，成績公布前只顯示本人作答，公布後才顯示正解與評分。';
