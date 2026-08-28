-- ============================================================================
-- 0106_exam_reset_attempts.sql
-- 「清除作答紀錄（測試用）」：把一份試卷的所有 exam_attempts（連同 exam_answers、
-- exam_notifications 一起 cascade）刪掉，讓測試循環可以從宣示畫面重跑。
--
--   ⚠️ 只允許 mode = 'test' 的試卷。正式卷（live）一律拒絕，避免誤刪真實成績；
--      正式卷若真要重置，請由工程人員手動處理。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_reset_attempts(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id  UUID := public.resolve_quiz_actor(p_actor_id);
  pr        public.exam_papers%ROWTYPE;
  n_deleted INTEGER;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.mode <> 'test' THEN RAISE EXCEPTION 'exam_reset_live_forbidden'; END IF;

  DELETE FROM public.exam_attempts WHERE paper_id = pr.id;
  GET DIAGNOSTICS n_deleted = ROW_COUNT;

  RETURN jsonb_build_object('paperId', pr.id, 'deletedAttempts', n_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_reset_attempts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_reset_attempts(uuid, uuid) TO authenticated, service_role;
