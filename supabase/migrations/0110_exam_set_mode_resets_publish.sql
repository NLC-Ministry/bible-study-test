-- ============================================================================
-- 0110_exam_set_mode_resets_publish.sql
-- 修：test / live 共用同一份 status + announcement_published →「在 test 模式發佈
--     預告文」後切到 live，預告文 banner 立刻對全體會友出現（連動發佈）。
--
-- 修法：
--   · 模式只能在「草稿」狀態切換（已發佈測驗要先「關閉 → 改回草稿」）。
--   · 切換模式時**一律清掉 `announcement_published`**（連同 announced_at/by）——
--     舊模式的預告文不跟著換模式走；新模式要重新按「發佈預告文」。
--   · 題庫、試卷設定、標題等不動，草稿階段照樣可編輯。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_set_mode(p_paper_id UUID, p_mode TEXT, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  was_announced BOOLEAN;
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

  -- 已發佈測驗的卷不給切模式（先關閉 → 改回草稿）
  IF pr.status <> 'draft' THEN RAISE EXCEPTION 'exam_mode_locked'; END IF;

  was_announced := pr.announcement_published;

  UPDATE public.exam_papers SET
    mode = p_mode,
    announcement_published = FALSE,
    announced_at = NULL,
    announced_by = NULL
  WHERE id = p_paper_id;

  RETURN jsonb_build_object(
    'paperId', p_paper_id, 'mode', p_mode, 'changed', TRUE,
    'announcementCleared', was_announced
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_set_mode(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_set_mode(uuid, text, uuid) TO authenticated, service_role;
