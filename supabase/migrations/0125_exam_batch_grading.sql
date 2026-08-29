-- 0125_exam_batch_grading.sql
-- 簡答批次批改：整批驗證、同一交易寫入，避免逐題 RPC 與部分成功。

CREATE OR REPLACE FUNCTION public.exam_grade_answers_batch(
  p_paper_id UUID,
  p_grades JSONB,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID:=public.resolve_quiz_actor(p_actor_id);
  pr public.exam_papers%ROWTYPE;
  grade_count INTEGER;
  valid_count INTEGER;
  duplicate_count INTEGER;
  affected_attempt UUID;
  pending_count INTEGER;
  short_sum NUMERIC;
  finalized_count INTEGER:=0;
  total_count INTEGER;
  pending_total INTEGER;
  graded_total INTEGER;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.status<>'closed' THEN RAISE EXCEPTION 'exam_grading_before_close'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;
  IF jsonb_typeof(COALESCE(p_grades,'null'::jsonb))<>'array' THEN RAISE EXCEPTION 'exam_batch_invalid'; END IF;

  grade_count:=jsonb_array_length(p_grades);
  IF grade_count<1 THEN RAISE EXCEPTION 'exam_batch_empty'; END IF;
  IF grade_count>500 THEN RAISE EXCEPTION 'exam_batch_too_large'; END IF;

  CREATE TEMP TABLE exam_batch_grades_input(
    answer_id UUID PRIMARY KEY,
    points NUMERIC NOT NULL,
    comment_text TEXT
  ) ON COMMIT DROP;

  BEGIN
    INSERT INTO exam_batch_grades_input(answer_id,points,comment_text)
    SELECT (item->>'answerId')::uuid,(item->>'points')::numeric,NULLIF(TRIM(item->>'comment'),'')
    FROM jsonb_array_elements(p_grades)item;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'exam_batch_duplicate_answer';
  WHEN invalid_text_representation OR numeric_value_out_of_range OR not_null_violation THEN
    RAISE EXCEPTION 'exam_batch_invalid';
  END;

  SELECT COUNT(*) INTO duplicate_count FROM exam_batch_grades_input;
  IF duplicate_count<>grade_count THEN RAISE EXCEPTION 'exam_batch_invalid'; END IF;

  SELECT COUNT(*) INTO valid_count
  FROM exam_batch_grades_input g
  JOIN public.exam_answers ea ON ea.id=g.answer_id AND ea.section='shortanswer'
  JOIN public.exam_attempts a ON a.id=ea.attempt_id AND a.paper_id=pr.id AND a.attempt_kind='official'
    AND a.status IN('submitted','graded')
  JOIN public.exam_questions q ON q.id=ea.question_id AND q.paper_id=pr.id
  WHERE g.points>=0 AND g.points<=q.points;
  IF valid_count<>grade_count THEN RAISE EXCEPTION 'exam_batch_validation_failed'; END IF;

  IF EXISTS(
    SELECT 1 FROM exam_batch_grades_input g
    JOIN public.exam_answers ea ON ea.id=g.answer_id
    JOIN public.exam_attempts a ON a.id=ea.attempt_id
    WHERE a.auto_score IS NULL AND EXISTS(
      SELECT 1 FROM public.exam_questions q WHERE q.paper_id=a.paper_id AND q.section<>'shortanswer'
    )
  ) THEN RAISE EXCEPTION 'exam_auto_score_pending'; END IF;

  UPDATE public.exam_answers ea SET
    awarded_points=g.points,
    grader_comment=g.comment_text,
    grader_id=actor_id,
    graded_at=NOW(),
    updated_at=NOW()
  FROM exam_batch_grades_input g
  WHERE ea.id=g.answer_id;

  FOR affected_attempt IN
    SELECT DISTINCT ea.attempt_id FROM public.exam_answers ea
    JOIN exam_batch_grades_input g ON g.answer_id=ea.id
  LOOP
    SELECT COUNT(*)FILTER(WHERE awarded_points IS NULL),COALESCE(SUM(awarded_points),0)
    INTO pending_count,short_sum FROM public.exam_answers
    WHERE attempt_id=affected_attempt AND section='shortanswer';
    IF pending_count=0 THEN
      UPDATE public.exam_attempts SET status='graded',manual_score=short_sum,
        total_score=COALESCE(auto_score,0)+short_sum WHERE id=affected_attempt;
      finalized_count:=finalized_count+1;
    END IF;
  END LOOP;

  SELECT COUNT(*),COUNT(*)FILTER(WHERE ea.awarded_points IS NULL),COUNT(*)FILTER(WHERE ea.awarded_points IS NOT NULL)
  INTO total_count,pending_total,graded_total
  FROM public.exam_answers ea JOIN public.exam_attempts a ON a.id=ea.attempt_id
  WHERE a.paper_id=pr.id AND a.attempt_kind='official' AND ea.section='shortanswer'
    AND a.status IN('submitted','graded');

  RETURN jsonb_build_object('paperId',pr.id,'updated',grade_count,'attemptsFinalized',finalized_count,
    'summary',jsonb_build_object('total',total_count,'pending',pending_total,'graded',graded_total));
END;
$$;

GRANT EXECUTE ON FUNCTION public.exam_grade_answers_batch(UUID,JSONB,UUID) TO authenticated;

COMMENT ON FUNCTION public.exam_grade_answers_batch(UUID,JSONB,UUID)
IS '簡答批次批改；整批驗證並在同一交易更新，只允許 admin/pastor、closed、未公布成績的正式卷。';
