-- ============================================================================
-- 0109_exam_banner_mode_filter.sql
-- 修 ①：test 卷發了預告文，會友首頁 banner 也看得到（exam_home_banner 的 SELECT
--       沒有濾 mode，只有按鈕 can_enter 有濾）→ 補上 mode='live' OR is_staff。
-- 加 ②：exam_set_mode(paper, mode) —— 讓「切換模式（test/live）」變成獨立動作，
--       不必進「試卷設定」表單、也不受 draft 限制（後台會對非 draft 的切換加確認）。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

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
    AND (mode = 'live' OR is_staff)          -- test 卷只有管理員／牧者看得到 banner
  ORDER BY (mode = 'live') DESC, announced_at DESC NULLS LAST, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  in_window := (pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL
                AND now_ts >= pr.open_at AND now_ts <= pr.close_at);
  can_enter := (
    at.status = 'in_progress'
    OR (pr.status = 'published'
        AND (pr.mode = 'live' OR is_staff)
        AND (in_window OR (pr.mode = 'test' AND is_staff))
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

-- ── 切換模式（test / live）獨立動作 ──
CREATE OR REPLACE FUNCTION public.exam_set_mode(p_paper_id UUID, p_mode TEXT, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF p_mode NOT IN ('test', 'live') THEN RAISE EXCEPTION 'exam_mode_invalid'; END IF;

  UPDATE public.exam_papers SET mode = p_mode WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;

  UPDATE public.exam_attempts SET is_test = (p_mode = 'test') WHERE paper_id = p_paper_id;

  RETURN jsonb_build_object('paperId', p_paper_id, 'mode', p_mode);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_set_mode(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_set_mode(uuid, text, uuid) TO authenticated, service_role;
