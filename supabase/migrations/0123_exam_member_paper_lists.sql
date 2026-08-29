-- 0123_exam_member_paper_lists.sql
-- 多試卷入口：首頁可同時呈現多份已發預告試卷；個人頁保留參與紀錄。
-- 僅回傳目前登入者自己的 attempt 摘要，不暴露其他使用者資料。

CREATE OR REPLACE FUNCTION public._exam_member_paper_summary(
  p_paper_id UUID,
  p_actor_id UUID,
  p_is_staff BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  pr public.exam_papers%ROWTYPE;
  official_at public.exam_attempts%ROWTYPE;
  practice_at public.exam_attempts%ROWTYPE;
  now_ts TIMESTAMPTZ := NOW();
  in_window BOOLEAN := FALSE;
  can_enter BOOLEAN := FALSE;
  can_practice BOOLEAN := FALSE;
  result_ready BOOLEAN := FALSE;
BEGIN
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO official_at
  FROM public.exam_attempts
  WHERE paper_id = pr.id AND user_id = p_actor_id AND attempt_kind = 'official';

  SELECT * INTO practice_at
  FROM public.exam_attempts
  WHERE paper_id = pr.id AND user_id = p_actor_id AND attempt_kind = 'practice';

  in_window := pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL
    AND now_ts >= pr.open_at AND now_ts < pr.close_at;
  can_enter := official_at.id IS NULL AND pr.status = 'published'
    AND (in_window OR (pr.mode = 'test' AND p_is_staff));
  can_practice := pr.practice_retake_enabled AND pr.status = 'published' AND now_ts < pr.close_at
    AND official_at.id IS NOT NULL AND official_at.status <> 'in_progress';
  result_ready := official_at.status = 'graded'
    AND (pr.results_published_at IS NOT NULL OR p_is_staff);

  RETURN jsonb_build_object(
    'paperId', pr.id,
    'title', pr.title,
    'status', pr.status,
    'mode', pr.mode,
    'headline', COALESCE(pr.announcement->>'headline', ''),
    'body', COALESCE(pr.announcement->>'body', ''),
    'ctaLabel', COALESCE(NULLIF(pr.announcement->>'ctaLabel', ''), '進入測驗'),
    'openAt', pr.open_at,
    'closeAt', pr.close_at,
    'durationMinutes', pr.duration_minutes,
    'serverNow', now_ts,
    'inWindow', in_window,
    'canEnter', can_enter,
    'myAttemptStatus', official_at.status,
    'officialAttemptId', official_at.id,
    'canReviewOfficial', official_at.id IS NOT NULL AND official_at.status <> 'in_progress',
    'canPractice', can_practice,
    'practiceAttemptId', practice_at.id,
    'practiceAttemptStatus', practice_at.status,
    'practiceReviewReady', practice_at.id IS NOT NULL,
    'resultReady', result_ready,
    'resultsPublishedAt', pr.results_published_at,
    'myTotalScore', CASE WHEN result_ready THEN official_at.total_score ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public._exam_member_paper_summary(UUID, UUID, BOOLEAN) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.exam_home_exams(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam') THEN RETURN '[]'::jsonb; END IF;
  PERFORM public._exam_close_expired_papers();

  RETURN COALESCE((
    SELECT jsonb_agg(public._exam_member_paper_summary(pr.id, actor_id, is_staff)
      ORDER BY
        (pr.status = 'published' AND NOW() >= pr.open_at AND NOW() < pr.close_at) DESC,
        (pr.status = 'published' AND NOW() < pr.open_at) DESC,
        pr.open_at DESC NULLS LAST,
        pr.created_at DESC)
    FROM public.exam_papers pr
    WHERE pr.announcement_published = TRUE
      AND (pr.mode = 'live' OR is_staff)
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_my_papers(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam') THEN RETURN '[]'::jsonb; END IF;
  PERFORM public._exam_close_expired_papers();

  RETURN COALESCE((
    SELECT jsonb_agg(public._exam_member_paper_summary(pr.id, actor_id, is_staff)
      ORDER BY
        (oa.status = 'in_progress') DESC,
        (pr.status = 'published' AND NOW() >= pr.open_at AND NOW() < pr.close_at) DESC,
        (pr.results_published_at IS NOT NULL) DESC,
        pr.close_at DESC NULLS LAST,
        pr.created_at DESC)
    FROM public.exam_papers pr
    LEFT JOIN public.exam_attempts oa
      ON oa.paper_id = pr.id AND oa.user_id = actor_id AND oa.attempt_kind = 'official'
    WHERE pr.mode = 'live'
      AND (oa.id IS NOT NULL OR pr.announcement_published = TRUE)
  ), '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.exam_home_exams(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exam_my_papers(UUID) TO authenticated;

COMMENT ON FUNCTION public.exam_home_exams(UUID) IS '目前登入者首頁可見的多份測驗卡片；只含本人 attempt 摘要。';
COMMENT ON FUNCTION public.exam_my_papers(UUID) IS '目前登入者的正式測驗清單與歷史紀錄；只含本人資料。';
