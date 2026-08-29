-- ============================================================================
-- 0116_exam_set_answer_key.sql
-- 情境：測驗先考、事後才拿到官方正確答案。這時題目不能動（動了 question id 會換，
-- 已作答的 exam_answers 就對不回去），但要能「只填答案」。
--
--   exam_set_answer_key(question_id, answer_key) — 只改該題的 answer_key，
--   不碰 payload / section / position / points，不受試卷 status / 作答紀錄限制。
--
-- 填完後在後台按「開啟自動評分 → 重新計分」(0115) 即可依新答案結算。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_set_answer_key(p_question_id UUID, p_answer_key JSONB, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  q        public.exam_questions%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO q FROM public.exam_questions WHERE id = p_question_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_question_not_found'; END IF;
  IF q.section = 'shortanswer' THEN RAISE EXCEPTION 'exam_answer_not_gradable'; END IF;

  UPDATE public.exam_questions
  SET answer_key = p_answer_key, updated_at = NOW()
  WHERE id = p_question_id;

  RETURN jsonb_build_object('questionId', p_question_id, 'section', q.section);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_set_answer_key(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_set_answer_key(uuid, jsonb, uuid) TO authenticated, service_role;
