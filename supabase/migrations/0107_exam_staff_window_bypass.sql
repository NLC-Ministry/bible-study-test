-- ============================================================================
-- 0107_exam_staff_window_bypass.sql
-- 修：已發佈的試卷若開放時段還沒到（例如 8/30 才開），管理員／牧者按「實際作答」
-- 會看到「測驗尚未開放作答」而進不去。exam_start_attempt 早就讓 staff 略過時段檢查，
-- 但 exam_get_for_attempt / exam_home_banner 沒跟著放行，導致畫面卡在 not_open。
--
-- 這裡讓「測試卷（mode = 'test'）+ 管理員／牧者」在「已發佈」狀態下不受 open_at /
-- close_at 限制（測試沙盒用途）。正式卷（mode = 'live'）不論管理員與否，一律照
-- open_at / close_at 開放時段；正式卷要事前試流程請用「預覽試卷」(?preview=1)。
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
  ELSIF pr.status <> 'published' THEN
    open_state := CASE WHEN is_staff THEN 'preview' ELSE 'not_open' END;
  ELSIF (pr.mode = 'test' AND is_staff) THEN
    open_state := 'open';                       -- 測試卷 + 管理員／牧者：不受開放時段限制
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

-- ── exam_home_banner：canEnter 也比照（只有「測試卷 + staff」略過時段）──
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
  ORDER BY (mode = 'live') DESC, announced_at DESC NULLS LAST, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  in_window := (pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL
                AND now_ts >= pr.open_at AND now_ts <= pr.close_at);
  can_enter := (
    at.status = 'in_progress'
    OR (pr.status = 'published'
        AND (pr.mode = 'live' OR is_staff)                        -- 測試卷會友端沒有入口
        AND (in_window OR (pr.mode = 'test' AND is_staff))        -- 只有測試卷 + staff 可略過時段
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
