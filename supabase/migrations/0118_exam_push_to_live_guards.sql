-- ============================================================================
-- 0118_exam_push_to_live_guards.sql
-- 「推上正式版」(exam_push_to_live) 加兩道防呆：
--
--   1. 正式版已有人作答 → 一律禁止（exam_push_live_has_attempts）
--      題目整份 DELETE + 重新 INSERT 會換掉 question id，exam_answers 對不回去，
--      已計分的成績會全毀。有作答就不能再推。
--
--   2. 正式版必須是「草稿」或「已關閉」狀態才能更新題目（exam_push_live_not_closed）
--      測驗進行中（status='published'）要先「關閉測驗」再推。
--      推完若原本是 closed → 退回 draft（內容變了要重新發佈），reverted=TRUE。
--
--   首次建立正式版（還沒有 live 卷）不受這兩道限制。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

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
    -- 防呆 1：正式版已有人作答 → 不准再推（會換 question id、毀掉已計分結果）
    IF EXISTS (SELECT 1 FROM public.exam_attempts WHERE paper_id = dst.id) THEN
      RAISE EXCEPTION 'exam_push_live_has_attempts';
    END IF;
    -- 防呆 2：測驗進行中 → 先關閉測驗再更新題目
    IF dst.status = 'published' THEN
      RAISE EXCEPTION 'exam_push_live_not_closed';
    END IF;

    reverted := (dst.status = 'closed');
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
      status = CASE WHEN dst.status = 'closed' THEN 'draft' ELSE dst.status END,
      published_at = NULL,
      published_by = NULL
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
