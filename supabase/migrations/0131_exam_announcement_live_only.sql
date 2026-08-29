-- ============================================================================
-- 0131_exam_announcement_live_only.sql
-- 測試版不該有預告文。
--   1) exam_publish_announcement：只允許 mode='live'（否則 exam_announcement_live_only）。
--   2) exam_set_mode：切成 'test' 時清掉 announcement_published / announced_at / announced_by。
--   3) 一次性：把現有測試版殘留的 announcement_published 旗標清掉。
--
-- 跑完後首頁 exam_home_exams（只撈 announcement_published = TRUE）就不會再出現
-- 測試版卡片。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。nlc-data 不用改。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_publish_announcement(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
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
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.mode <> 'live' THEN RAISE EXCEPTION 'exam_announcement_live_only'; END IF;
  IF pr.status = 'closed' THEN RAISE EXCEPTION 'exam_announcement_locked'; END IF;
  IF pr.announcement_published THEN RAISE EXCEPTION 'exam_announcement_already_published'; END IF;
  IF COALESCE(btrim(pr.announcement ->> 'headline'), '') = ''
     OR COALESCE(btrim(pr.announcement ->> 'body'), '') = '' THEN
    RAISE EXCEPTION 'exam_announcement_incomplete';
  END IF;
  IF pr.open_at IS NULL OR pr.close_at IS NULL OR pr.close_at <= pr.open_at THEN
    RAISE EXCEPTION 'exam_window_invalid';
  END IF;

  UPDATE public.exam_papers
  SET announcement_published = TRUE, announced_at = NOW(), announced_by = actor_id
  WHERE id = pr.id;

  RETURN jsonb_build_object('paperId', pr.id, 'announcementPublished', TRUE);
END;
$$;

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

  UPDATE public.exam_papers SET
    mode = p_mode,
    announcement_published = CASE WHEN p_mode = 'test' THEN FALSE ELSE announcement_published END,
    announced_at           = CASE WHEN p_mode = 'test' THEN NULL  ELSE announced_at END,
    announced_by           = CASE WHEN p_mode = 'test' THEN NULL  ELSE announced_by END
  WHERE id = p_paper_id;
  UPDATE public.exam_attempts SET is_test = (p_mode = 'test') WHERE paper_id = p_paper_id;

  RETURN jsonb_build_object('paperId', p_paper_id, 'mode', p_mode, 'changed', TRUE);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_set_mode(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_set_mode(uuid, text, uuid) TO authenticated, service_role;

-- 一次性清理：現有測試版殘留的預告文旗標
UPDATE public.exam_papers
SET announcement_published = FALSE, announced_at = NULL, announced_by = NULL
WHERE mode = 'test' AND announcement_published = TRUE;
