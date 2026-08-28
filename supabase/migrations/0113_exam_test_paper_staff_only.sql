-- ============================================================================
-- 0113_exam_test_paper_staff_only.sql
-- 補洞：測試版（mode='test'）本來只是「不出現在首頁 banner / 無 param 入口」，
-- 但如果有人拿到 exam.html?paper=<測試版id> 的**直接連結**，而該測試版又是
-- 「已發佈 + 在開放時段內」，一般會友還是進得去、還能作答。
--
-- 修法：測試版一律只有 admin / pastor 能進入或作答。
--   · exam_get_for_attempt：會友對 mode='test' 的卷 → open_state = 'not_open'
--   · exam_start_attempt   ：會友對 mode='test' 的卷 → RAISE 'exam_not_open'
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

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
    SELECT * INTO pr FROM public.exam_papers
    WHERE (is_staff OR (mode = 'live' AND status = 'published'))
    ORDER BY (mode = 'live') DESC, published_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_paper'); END IF;

  want_preview := (COALESCE(p_preview, FALSE) AND is_staff);

  IF want_preview THEN
    open_state := 'preview';
  ELSIF (pr.mode = 'test' AND NOT is_staff) THEN
    open_state := 'not_open';                    -- 測試版：會友不得進入（即使拿到直接連結）
  ELSIF pr.status <> 'published' THEN
    open_state := CASE WHEN is_staff THEN 'preview' ELSE 'not_open' END;
  ELSIF (pr.mode = 'test' AND is_staff) THEN
    open_state := 'open';
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
    'attempt', CASE WHEN (at.id IS NULL OR want_preview) THEN NULL ELSE jsonb_build_object(
      'id', at.id, 'status', at.status,
      'startedAt', at.started_at, 'deadlineAt', at.deadline_at, 'submittedAt', at.submitted_at,
      'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - now_ts))))::int,
      'layout', at.layout, 'paperSnapshot', at.paper_snapshot,
      'savedAnswers', COALESCE((
        SELECT jsonb_object_agg(question_id::text, response)
        FROM public.exam_answers WHERE attempt_id = at.id AND response IS NOT NULL
      ), '{}'::jsonb),
      'autoScore', at.auto_score, 'manualScore', at.manual_score, 'totalScore', at.total_score
    ) END,
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

-- ── exam_start_attempt：會友不得作答測試版 ──
CREATE OR REPLACE FUNCTION public.exam_start_attempt(
  p_paper_id       UUID,
  p_pledge_name    TEXT,
  p_reading_team_id UUID DEFAULT NULL,
  p_actor_id       UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  at       public.exam_attempts%ROWTYPE;
  now_ts   TIMESTAMPTZ := NOW();
  seed     TEXT;
  deadline TIMESTAMPTZ;
BEGIN
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;
  IF FOUND THEN
    RETURN jsonb_build_object('attemptId', at.id, 'status', at.status, 'resumed', TRUE,
      'deadlineAt', at.deadline_at,
      'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - now_ts))))::int,
      'layout', at.layout, 'paperSnapshot', at.paper_snapshot);
  END IF;

  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    IF pr.mode = 'test' THEN RAISE EXCEPTION 'exam_not_open'; END IF;   -- 測試版只有 staff 能作答
    IF pr.status <> 'published' THEN RAISE EXCEPTION 'exam_not_open'; END IF;
    IF now_ts < pr.open_at OR now_ts > pr.close_at THEN RAISE EXCEPTION 'exam_not_open'; END IF;
  END IF;
  IF COALESCE(TRIM(p_pledge_name), '') = '' THEN RAISE EXCEPTION 'exam_pledge_name_required'; END IF;

  seed := md5(pr.id::text || ':' || actor_id::text || ':' || COALESCE(pr.published_at, pr.created_at)::text);
  deadline := LEAST(now_ts + make_interval(mins => pr.duration_minutes), COALESCE(pr.close_at, now_ts + make_interval(mins => pr.duration_minutes)));

  INSERT INTO public.exam_attempts (
    paper_id, user_id, reading_team_id, is_test, status,
    started_at, deadline_at, pledge_name, pledge_agreed_at, pledge_snapshot,
    layout, paper_snapshot)
  VALUES (
    pr.id, actor_id, p_reading_team_id, (pr.mode = 'test'), 'in_progress',
    now_ts, deadline, TRIM(p_pledge_name), now_ts, pr.pledge,
    public._exam_build_layout(pr.id, seed), public._exam_paper_snapshot(pr.id))
  ON CONFLICT (paper_id, user_id) DO NOTHING
  RETURNING * INTO at;

  IF at.id IS NULL THEN
    SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;
  END IF;

  RETURN jsonb_build_object('attemptId', at.id, 'status', at.status, 'resumed', FALSE,
    'deadlineAt', at.deadline_at,
    'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - now_ts))))::int,
    'layout', at.layout, 'paperSnapshot', at.paper_snapshot);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_start_attempt(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_start_attempt(uuid, text, uuid, uuid) TO authenticated, service_role;
