-- ============================================================================
-- 0112_exam_push_to_live.sql
-- test 版與正式版 = 兩份完全獨立的 exam_papers（各自 status / 預告文 / 題目）。
--   · test 版：管理員演練用，只有 admin/pastor 看得到（會友端不出現）。
--   · 正式版：會友端看到的那一份，預告文自己維護、自己發佈。
--   · 「推上正式版」(exam_push_to_live)：把 test 版的「題目 + 試卷設定」複製到
--     對應的正式版；若正式版當下是「已發佈」，就退回草稿（內容變了要重發）。
--     預告文與正式版的發佈狀態不受 push 影響（首次建立時才帶入 test 的預告文文案）。
--
-- 連結：exam_papers.pushed_from_id 指向來源 test 卷。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS pushed_from_id UUID REFERENCES public.exam_papers(id) ON DELETE SET NULL;

-- ── 首頁 banner：只給正式版（管理員也看得到 test 版）──
CREATE OR REPLACE FUNCTION public.exam_home_banner(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  pr       public.exam_papers%ROWTYPE;
  at       public.exam_attempts%ROWTYPE;
  now_ts   TIMESTAMPTZ := NOW();
  in_window BOOLEAN;
  can_enter BOOLEAN;
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam') THEN RETURN NULL; END IF;

  SELECT * INTO pr FROM public.exam_papers
  WHERE announcement_published = TRUE
    AND (mode = 'live' OR is_staff)
  ORDER BY (mode = 'live') DESC, announced_at DESC NULLS LAST, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  in_window := (pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL
                AND now_ts >= pr.open_at AND now_ts <= pr.close_at);
  can_enter := (
    at.status = 'in_progress'
    OR (pr.status = 'published'
        AND (in_window OR (pr.mode = 'test' AND is_staff))
        AND (at.id IS NULL OR at.status = 'in_progress'))
  );

  RETURN jsonb_build_object(
    'paperId', pr.id, 'title', pr.title, 'status', pr.status, 'mode', pr.mode,
    'headline', COALESCE(pr.announcement ->> 'headline', ''),
    'body', COALESCE(pr.announcement ->> 'body', ''),
    'ctaLabel', COALESCE(NULLIF(pr.announcement ->> 'ctaLabel', ''), '進入測驗'),
    'openAt', pr.open_at, 'closeAt', pr.close_at, 'durationMinutes', pr.duration_minutes,
    'serverNow', now_ts, 'inWindow', in_window, 'canEnter', can_enter,
    'myAttemptStatus', at.status, 'resultReady', (at.status = 'graded'),
    'myTotalScore', CASE WHEN at.status = 'graded' THEN at.total_score ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_home_banner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_home_banner(uuid) TO authenticated, service_role;

-- ── 作答入口：test 卷 + staff 略過開放時段（演練用）；一般會友照時段 ──
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

-- ── 推上正式版 ──
CREATE OR REPLACE FUNCTION public.exam_push_to_live(p_test_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  src public.exam_papers%ROWTYPE;
  dst public.exam_papers%ROWTYPE;
  did_create BOOLEAN := FALSE;
  reverted   BOOLEAN := FALSE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  SELECT * INTO src FROM public.exam_papers WHERE id = p_test_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF src.mode <> 'test' THEN RAISE EXCEPTION 'exam_push_source_not_test'; END IF;

  SELECT * INTO dst FROM public.exam_papers
  WHERE pushed_from_id = src.id AND mode = 'live'
  ORDER BY created_at DESC LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.exam_papers (
      title, description, mode, status, open_at, close_at,
      duration_minutes, total_points, pledge, sections, section_targets,
      announcement, announcement_published, pushed_from_id, created_by)
    VALUES (
      src.title, src.description, 'live', 'draft', src.open_at, src.close_at,
      src.duration_minutes, src.total_points, src.pledge, src.sections, src.section_targets,
      src.announcement, FALSE, src.id, actor_id)
    RETURNING * INTO dst;
    did_create := TRUE;
  ELSE
    reverted := (dst.status = 'published');
    UPDATE public.exam_papers SET
      title = src.title,
      description = src.description,
      open_at = src.open_at,
      close_at = src.close_at,
      duration_minutes = src.duration_minutes,
      total_points = src.total_points,
      pledge = src.pledge,
      sections = src.sections,
      section_targets = src.section_targets,
      status = CASE WHEN dst.status = 'published' THEN 'draft' ELSE dst.status END,
      published_at = CASE WHEN dst.status = 'published' THEN NULL ELSE dst.published_at END,
      published_by = CASE WHEN dst.status = 'published' THEN NULL ELSE dst.published_by END
      -- announcement / announcement_published 由正式版自己維護，push 不動
    WHERE id = dst.id
    RETURNING * INTO dst;
  END IF;

  -- 題目整份覆蓋（新 id、同內容）
  DELETE FROM public.exam_questions WHERE paper_id = dst.id;
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key)
  SELECT dst.id, section, position, points, payload, answer_key
  FROM public.exam_questions WHERE paper_id = src.id;

  RETURN jsonb_build_object(
    'livePaperId', dst.id, 'created', did_create, 'reverted', reverted, 'liveStatus', dst.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_push_to_live(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_push_to_live(uuid, uuid) TO authenticated, service_role;

-- ── exam_publish：只有正式版（mode='live'）才要求「先發預告文」；測試版直接發佈 ──
CREATE OR REPLACE FUNCTION public.exam_publish(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  bad_cnt  INTEGER;
  sec      TEXT;
  want     INTEGER;
  got      INTEGER;
  enabled_types TEXT[];
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.status <> 'draft' THEN RAISE EXCEPTION 'exam_already_published'; END IF;
  IF pr.mode = 'live' AND NOT pr.announcement_published THEN
    RAISE EXCEPTION 'exam_not_announced';
  END IF;
  IF pr.open_at IS NULL OR pr.close_at IS NULL OR pr.close_at <= pr.open_at THEN
    RAISE EXCEPTION 'exam_window_invalid';
  END IF;
  IF COALESCE(jsonb_array_length(pr.sections), 0) = 0 THEN
    RAISE EXCEPTION 'exam_no_sections';
  END IF;

  SELECT array_agg(e ->> 'type') INTO enabled_types
  FROM jsonb_array_elements(pr.sections) e;

  FOR sec, want IN
    SELECT e ->> 'type', (e ->> 'count')::int FROM jsonb_array_elements(pr.sections) e
  LOOP
    SELECT COUNT(*) INTO got FROM public.exam_questions WHERE paper_id = pr.id AND section = sec;
    IF got <> want THEN
      RAISE EXCEPTION 'exam_section_count_mismatch: % expected % got %', sec, want, got;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.exam_questions
             WHERE paper_id = pr.id AND NOT (section = ANY(enabled_types))) THEN
    RAISE EXCEPTION 'exam_section_not_enabled';
  END IF;

  SELECT COUNT(*) INTO bad_cnt FROM public.exam_questions q
  WHERE q.paper_id = pr.id AND q.section <> 'shortanswer' AND (
        q.answer_key IS NULL
     OR (q.section = 'matching'
         AND (SELECT COUNT(*) FROM jsonb_object_keys(q.answer_key))
             <> COALESCE(jsonb_array_length(q.payload -> 'left'), -1))
     OR (q.section = 'ordering'
         AND jsonb_array_length(q.answer_key)
             <> COALESCE(jsonb_array_length(q.payload -> 'items'), -1))
  );
  IF bad_cnt > 0 THEN RAISE EXCEPTION 'exam_answer_key_incomplete: % 題', bad_cnt; END IF;

  UPDATE public.exam_papers
  SET status = 'published', published_at = NOW(), published_by = actor_id
  WHERE id = pr.id;

  RETURN jsonb_build_object('paperId', pr.id, 'status', 'published');
END;
$$;

REVOKE ALL ON FUNCTION public.exam_publish(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_publish(uuid, uuid) TO authenticated, service_role;

-- ── exam_get_paper_admin：papers[] 多回 pushedFromId（前端做「前往正式版/測試版」快捷）──
CREATE OR REPLACE FUNCTION public.exam_get_paper_admin(p_paper_id UUID DEFAULT NULL, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  target   UUID := p_paper_id;
  papers   JSONB;
  result   JSONB;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', pr.id, 'title', pr.title, 'mode', pr.mode, 'status', pr.status,
           'pushedFromId', pr.pushed_from_id,
           'createdAt', pr.created_at,
           'questionCount', (SELECT COUNT(*) FROM public.exam_questions q WHERE q.paper_id = pr.id),
           'attemptCount', (SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id = pr.id))
         ORDER BY pr.created_at DESC), '[]'::jsonb)
    INTO papers
  FROM public.exam_papers pr;

  IF target IS NULL THEN
    SELECT id INTO target FROM public.exam_papers ORDER BY created_at DESC LIMIT 1;
  END IF;

  IF target IS NULL THEN
    RETURN jsonb_build_object('papers', papers, 'paper', NULL, 'questions', '[]'::jsonb, 'attemptCount', 0);
  END IF;

  SELECT jsonb_build_object(
    'papers', papers,
    'paper', to_jsonb(pr),
    'attemptCount', (SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id = pr.id),
    'questions', COALESCE((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q.section, q.position)
      FROM public.exam_questions q WHERE q.paper_id = pr.id
    ), '[]'::jsonb)
  ) INTO result
  FROM public.exam_papers pr WHERE pr.id = target;

  IF result IS NULL THEN
    RETURN jsonb_build_object('papers', papers, 'paper', NULL, 'questions', '[]'::jsonb, 'attemptCount', 0);
  END IF;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.exam_get_paper_admin(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_get_paper_admin(uuid, uuid) TO authenticated, service_role;
