-- ============================================================================
-- 0114_exam_paper_testers.sql
-- 讓管理員把「指定的一般使用者」加進某份測試版的「測試名單」，
-- 名單內的人（即使不是 admin/pastor）也能用 exam.html?paper=<測試版id>
-- 進入、作答該測試版（不受開放時段限制；仍需測試版 status='published'）。
--
--   exam_paper_testers            — 名單（paper_id, user_id）
--   _exam_can_access_test(paper, actor) — staff 或 名單內
--   exam_add_tester / exam_remove_tester / exam_get_paper_testers — 管理 RPC
--   exam_get_for_attempt / exam_start_attempt — 測試版放行條件改用 _exam_can_access_test
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.exam_paper_testers (
  paper_id  UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES public.profiles(id)    ON DELETE CASCADE,
  added_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (paper_id, user_id)
);
ALTER TABLE public.exam_paper_testers ENABLE ROW LEVEL SECURITY;
-- 無 policy：一律走 service-role + 下列 RPC。

CREATE OR REPLACE FUNCTION public._exam_can_access_test(p_paper_id UUID, p_actor_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SET search_path = pg_catalog, public
AS $$
  SELECT public._exam_actor_role(p_actor_id) IN ('admin', 'pastor')
      OR EXISTS (SELECT 1 FROM public.exam_paper_testers t
                 WHERE t.paper_id = p_paper_id AND t.user_id = p_actor_id);
$$;
REVOKE ALL ON FUNCTION public._exam_can_access_test(uuid, uuid) FROM PUBLIC;

-- ── 管理名單 ──
CREATE OR REPLACE FUNCTION public.exam_add_tester(p_paper_id UUID, p_email TEXT, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  u        public.profiles%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = p_paper_id) THEN
    RAISE EXCEPTION 'exam_paper_not_found';
  END IF;
  SELECT * INTO u FROM public.profiles
  WHERE lower(email) = lower(btrim(COALESCE(p_email, ''))) AND btrim(COALESCE(p_email, '')) <> ''
  ORDER BY created_at ASC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_tester_user_not_found'; END IF;

  INSERT INTO public.exam_paper_testers (paper_id, user_id, added_by)
  VALUES (p_paper_id, u.id, actor_id)
  ON CONFLICT (paper_id, user_id) DO NOTHING;

  RETURN jsonb_build_object('userId', u.id, 'name', u.name, 'email', u.email);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_remove_tester(p_paper_id UUID, p_user_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  DELETE FROM public.exam_paper_testers WHERE paper_id = p_paper_id AND user_id = p_user_id;
  RETURN jsonb_build_object('removed', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_get_paper_testers(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'userId', t.user_id, 'name', p.name, 'email', p.email, 'addedAt', t.added_at)
           ORDER BY t.added_at DESC)
    FROM public.exam_paper_testers t JOIN public.profiles p ON p.id = t.user_id
    WHERE t.paper_id = p_paper_id
  ), '[]'::jsonb);
END;
$$;

-- ── 放行條件：測試版改用 _exam_can_access_test ──
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
  tester_ok BOOLEAN;
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
  ELSIF pr.mode = 'test' THEN
    tester_ok := public._exam_can_access_test(pr.id, actor_id);
    IF is_staff AND pr.status <> 'published' THEN open_state := 'preview';
    ELSIF tester_ok AND pr.status = 'published' THEN open_state := 'open';    -- staff / 名單內：不受時段限制
    ELSE open_state := 'not_open';
    END IF;
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
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
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

  IF NOT is_staff THEN
    IF pr.mode = 'test' THEN
      IF NOT public._exam_can_access_test(pr.id, actor_id) THEN RAISE EXCEPTION 'exam_not_open'; END IF;
      IF pr.status <> 'published' THEN RAISE EXCEPTION 'exam_not_open'; END IF;
      -- 名單內測試者不檢查開放時段
    ELSE
      IF pr.status <> 'published' THEN RAISE EXCEPTION 'exam_not_open'; END IF;
      IF now_ts < pr.open_at OR now_ts > pr.close_at THEN RAISE EXCEPTION 'exam_not_open'; END IF;
    END IF;
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

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_add_tester(uuid, text, uuid)',
    'exam_remove_tester(uuid, uuid, uuid)',
    'exam_get_paper_testers(uuid, uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
