-- ============================================================================
-- 0111_exam_mode_label_only.sql
-- 決定：test / live 不再影響「會友看不看得到」。一律照正式版的規則走：
--   · banner 顯示 = 功能開 + announcement_published（不分 mode）
--   · 能不能作答 = status='published' 且現在在 open_at ~ close_at 內（不分 mode / 身分）
--   · staff 對「未發佈」的卷仍拿 preview 狀態（唯一保留的差別）
--
-- mode 只剩「標籤」用途：標 exam_attempts.is_test（統計可分辨演練用的作答）。
-- 因此 exam_set_mode 變成單純換標籤，任何 status 都可切、無副作用、不清預告文。
--
-- 這一版把 0107 / 0109 / 0110 裡跟 mode 綁的可見性判斷全部拿掉。
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

-- ── exam_get_for_attempt：拿掉「test 卷 + staff 略過時段」的特例 ──
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
    WHERE (is_staff OR status = 'published')
    ORDER BY (status = 'published') DESC, published_at DESC NULLS LAST, created_at DESC
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

-- ── exam_home_banner：不分 mode ──
CREATE OR REPLACE FUNCTION public.exam_home_banner(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  at       public.exam_attempts%ROWTYPE;
  now_ts   TIMESTAMPTZ := NOW();
  in_window BOOLEAN;
  can_enter BOOLEAN;
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam') THEN RETURN NULL; END IF;

  SELECT * INTO pr FROM public.exam_papers
  WHERE announcement_published = TRUE
  ORDER BY (status = 'published') DESC, announced_at DESC NULLS LAST, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  in_window := (pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL
                AND now_ts >= pr.open_at AND now_ts <= pr.close_at);
  can_enter := (
    at.status = 'in_progress'
    OR (pr.status = 'published' AND in_window
        AND (at.id IS NULL OR at.status = 'in_progress'))
  );

  RETURN jsonb_build_object(
    'paperId', pr.id,
    'title', pr.title,
    'status', pr.status,
    'mode', pr.mode,
    'headline', COALESCE(pr.announcement ->> 'headline', ''),
    'body', COALESCE(pr.announcement ->> 'body', ''),
    'ctaLabel', COALESCE(NULLIF(pr.announcement ->> 'ctaLabel', ''), '進入測驗'),
    'openAt', pr.open_at,
    'closeAt', pr.close_at,
    'durationMinutes', pr.duration_minutes,
    'serverNow', now_ts,
    'inWindow', in_window,
    'canEnter', can_enter,
    'myAttemptStatus', at.status,
    'resultReady', (at.status = 'graded'),
    'myTotalScore', CASE WHEN at.status = 'graded' THEN at.total_score ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_home_banner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_home_banner(uuid) TO authenticated, service_role;

-- ── exam_set_mode：只換標籤，任何 status 都可切，無副作用 ──
CREATE OR REPLACE FUNCTION public.exam_set_mode(p_paper_id UUID, p_mode TEXT, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF p_mode NOT IN ('test', 'live') THEN RAISE EXCEPTION 'exam_mode_invalid'; END IF;

  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;

  IF pr.mode = p_mode THEN
    RETURN jsonb_build_object('paperId', p_paper_id, 'mode', p_mode, 'changed', FALSE);
  END IF;

  UPDATE public.exam_papers SET mode = p_mode WHERE id = p_paper_id;
  UPDATE public.exam_attempts SET is_test = (p_mode = 'test') WHERE paper_id = p_paper_id;

  RETURN jsonb_build_object('paperId', p_paper_id, 'mode', p_mode, 'changed', TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_set_mode(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_set_mode(uuid, text, uuid) TO authenticated, service_role;
