-- ============================================================================
-- 0119_exam_my_result_published_flag.sql
-- exam_get_my_result 多回一個 resultsPublished 布林，讓前端分辨：
--   · 會友看到完整成績   → 一定是「已公布」
--   · 管理員看到完整成績 → 可能只是「公布前的預覽」（is_staff 提前看得到）
-- 讓管理員端不要誤以為「成績已公布」。行為不變，只多一個欄位。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_get_my_result(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  at       public.exam_attempts%ROWTYPE;
  published BOOLEAN;
  show_full BOOLEAN;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = p_paper_id AND user_id = actor_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_attempt'); END IF;
  IF at.status = 'in_progress' THEN RETURN jsonb_build_object('state', 'in_progress'); END IF;

  SELECT results_published_at IS NOT NULL INTO published FROM public.exam_papers WHERE id = p_paper_id;
  show_full := (at.status = 'graded') AND (published OR is_staff);

  RETURN jsonb_build_object(
    'state', CASE WHEN show_full THEN 'graded' ELSE 'submitted' END,
    'resultsPublished', COALESCE(published, FALSE),
    'staffPreview', (show_full AND NOT COALESCE(published, FALSE) AND is_staff),
    'autoScore',   CASE WHEN show_full THEN at.auto_score ELSE NULL END,
    'manualScore', CASE WHEN show_full THEN at.manual_score ELSE NULL END,
    'totalScore',  CASE WHEN show_full THEN at.total_score ELSE NULL END,
    'submittedAt', at.submitted_at,
    'answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'questionId', ea.question_id, 'section', ea.section, 'position', q.position,
        'points', q.points,
        'sectionRank', public._exam_section_rank(ea.section),
        'response', ea.response,
        'autoCorrect', CASE WHEN show_full THEN ea.auto_correct ELSE NULL END,
        'awardedPoints', CASE WHEN show_full THEN ea.awarded_points ELSE NULL END,
        'graderComment', CASE WHEN show_full THEN ea.grader_comment ELSE NULL END,
        'payload', CASE WHEN show_full THEN q.payload
                        ELSE public._exam_public_payload(q.section, q.payload, q.points) END,
        'answerKey', CASE WHEN show_full AND ea.section <> 'shortanswer' THEN q.answer_key ELSE NULL END)
      ORDER BY public._exam_section_rank(ea.section), q.position)
      FROM public.exam_answers ea JOIN public.exam_questions q ON q.id = ea.question_id
      WHERE ea.attempt_id = at.id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_get_my_result(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_get_my_result(uuid, uuid) TO authenticated, service_role;
