-- ============================================================================
-- 0100_exam_paper_list.sql
-- 大測驗後台改用「試卷清單下拉」選要編輯/批改哪一份（不再靠計畫篩選）。
-- exam_get_paper_admin 的回傳多帶一個 `papers` 陣列（所有試卷的精簡資訊），
-- 讓前端做下拉選單；`paper` / `questions` 仍是目前選中那份的完整內容。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

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

  -- 所有試卷（精簡）— 給下拉選單用
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', pr.id, 'title', pr.title, 'mode', pr.mode, 'status', pr.status,
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

  -- target 傳了但找不到（已刪）→ 回清單讓前端改選
  IF result IS NULL THEN
    RETURN jsonb_build_object('papers', papers, 'paper', NULL, 'questions', '[]'::jsonb, 'attemptCount', 0);
  END IF;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.exam_get_paper_admin(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_get_paper_admin(uuid, uuid) TO authenticated, service_role;
