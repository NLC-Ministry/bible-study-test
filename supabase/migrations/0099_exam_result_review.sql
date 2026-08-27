-- ============================================================================
-- 0099_exam_result_review.sql
-- 成績公布 (status='graded') 後，讓作答者能看「完整逐題檢討」：題幹、選項/事件文字、
-- 自己的作答、正解、簡答的參考答案與評分要點。
--
-- exam_get_my_result 每題多回傳 payload 與 points：
--   · graded 且非簡答 → 回完整 payload（含 options/left/right/items 文字）＋ answerKey
--   · graded 且簡答   → 回完整 payload（含 referenceAnswer / rubric）
--   · submitted        → 只回去答案版 payload（stem＋選項文字，不含 referenceAnswer/rubric）
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

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
        'points', q.points,
        'sectionRank', public._exam_section_rank(ea.section),
        'response', ea.response,
        'autoCorrect', ea.auto_correct,
        'awardedPoints', ea.awarded_points,
        'graderComment', ea.grader_comment,
        -- 成績公布後回完整 payload（含簡答的參考答案/評分要點）；否則去答案版
        'payload', CASE WHEN at.status = 'graded'
                        THEN q.payload
                        ELSE public._exam_public_payload(q.section, q.payload, q.points) END,
        -- 正解只在成績公布後、且非簡答時給
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
