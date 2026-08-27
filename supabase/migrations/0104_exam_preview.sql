-- ============================================================================
-- 0104_exam_preview.sql
-- exam_get_for_attempt 加 p_preview 參數：
--   後台「預覽作答」時（admin／pastor），無論自己是否已有一份測試 attempt，
--   一律回「去答案的整卷」讓前端以唯讀模式呈現題目，不再跳到自己的作答結果。
--
-- 因為多了一個參數會與舊的 2-arg 版本形成 overload / 呼叫歧義，先 DROP 再建。
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

DROP FUNCTION IF EXISTS public.exam_get_for_attempt(uuid, uuid);

CREATE OR REPLACE FUNCTION public.exam_get_for_attempt(
  p_paper_id UUID DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL,
  p_preview  BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  pr       public.exam_papers%ROWTYPE;
  at       public.exam_attempts%ROWTYPE;
  now_ts   TIMESTAMPTZ := NOW();
  open_state TEXT;
  want_preview BOOLEAN;
BEGIN
  IF p_paper_id IS NOT NULL THEN
    SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  ELSE
    -- 測試期：admin 拿最新的 test 卷；一般會友拿目前開放中的 live 卷
    SELECT * INTO pr FROM public.exam_papers
    WHERE (is_staff OR (mode = 'live' AND status = 'published'))
    ORDER BY (mode = 'live') DESC, published_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_paper'); END IF;

  want_preview := (COALESCE(p_preview, FALSE) AND is_staff);

  IF want_preview THEN
    open_state := 'preview';
  ELSIF pr.status <> 'published' THEN
    open_state := CASE WHEN is_staff THEN 'preview' ELSE 'not_open' END;
  ELSIF now_ts < COALESCE(pr.open_at, now_ts) THEN open_state := 'not_open';
  ELSIF now_ts > COALESCE(pr.close_at, now_ts) THEN open_state := 'closed';
  ELSE open_state := 'open';
  END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  RETURN jsonb_build_object(
    'state', open_state,
    'preview', want_preview,
    'paper', jsonb_build_object(
      'id', pr.id, 'title', pr.title, 'mode', pr.mode, 'status', pr.status,
      'openAt', pr.open_at, 'closeAt', pr.close_at,
      'durationMinutes', pr.duration_minutes, 'totalPoints', pr.total_points,
      'pledge', pr.pledge
    ),
    -- 預覽模式：不吐自己的 attempt，避免前端跳到作答結果畫面
    'attempt', CASE WHEN (at.id IS NULL OR want_preview) THEN NULL ELSE jsonb_build_object(
      'id', at.id, 'status', at.status,
      'startedAt', at.started_at, 'deadlineAt', at.deadline_at, 'submittedAt', at.submitted_at,
      'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - now_ts))))::int,
      'layout', at.layout,
      'paperSnapshot', at.paper_snapshot,
      'savedAnswers', COALESCE((
        SELECT jsonb_object_agg(question_id::text, response)
        FROM public.exam_answers WHERE attempt_id = at.id AND response IS NOT NULL
      ), '{}'::jsonb),
      'autoScore', at.auto_score, 'manualScore', at.manual_score, 'totalScore', at.total_score
    ) END,
    -- 尚未開始作答者（或後台預覽），給去答案整卷讓前端顯示宣示畫面 / 唯讀預覽
    'previewQuestions', CASE WHEN (at.id IS NOT NULL AND NOT want_preview) THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q.id, 'section', q.section, 'position', q.position, 'points', q.points,
               'payload', public._exam_public_payload(q.section, q.payload, q.points))
             ORDER BY q.section, q.position)
      FROM public.exam_questions q WHERE q.paper_id = pr.id
    ), '[]'::jsonb) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_get_for_attempt(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_get_for_attempt(uuid, uuid, boolean) TO authenticated, service_role;
