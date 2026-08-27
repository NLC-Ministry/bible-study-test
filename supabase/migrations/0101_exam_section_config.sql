-- ============================================================================
-- 0101_exam_section_config.sql
-- 試卷可自選「要哪些題型」與「各大題配分」。
--   exam_papers.sections JSONB = [{ type, count, pointsPer }, ...]
--     · 只有列出來的題型才會出現在這份測驗
--     · total_points 由 Σ(count × pointsPer) 自動算，section_targets 從 sections 派生（向下相容）
--   exam_upsert_paper：接受 sections，重算 total_points 與 section_targets
--   exam_publish：改用 sections 驗證（只檢查有列出的題型；題數要相符、答案要齊全）
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS sections JSONB NOT NULL DEFAULT jsonb_build_array(
    jsonb_build_object('type','truefalse',  'count',20,'pointsPer',1),
    jsonb_build_object('type','single',     'count',20,'pointsPer',1),
    jsonb_build_object('type','multiple',   'count',10,'pointsPer',1),
    jsonb_build_object('type','matching',   'count',10,'pointsPer',1),
    jsonb_build_object('type','ordering',   'count',10,'pointsPer',1),
    jsonb_build_object('type','shortanswer','count',3, 'pointsPer',10)
  );

-- 既有試卷：從 section_targets 回填 sections（簡答每題 10 分，其餘 1 分）
UPDATE public.exam_papers p SET sections = COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
           'type', t.key,
           'count', t.value::int,
           'pointsPer', CASE WHEN t.key = 'shortanswer' THEN 10 ELSE 1 END)
         ORDER BY public._exam_section_rank(t.key))
  FROM jsonb_each_text(p.section_targets) t
), p.sections)
WHERE p.sections IS NULL
   OR p.sections = '[]'::jsonb;

-- 依 sections 算派生欄位的小工具
CREATE OR REPLACE FUNCTION public._exam_sections_total(p_sections JSONB)
RETURNS NUMERIC
LANGUAGE SQL IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(SUM(GREATEST((e ->> 'count')::int, 0) * GREATEST((e ->> 'pointsPer')::numeric, 0)), 0)
  FROM jsonb_array_elements(COALESCE(p_sections, '[]'::jsonb)) e;
$$;
CREATE OR REPLACE FUNCTION public._exam_sections_targets(p_sections JSONB)
RETURNS JSONB
LANGUAGE SQL IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(jsonb_object_agg(e ->> 'type', (e ->> 'count')::int), '{}'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_sections, '[]'::jsonb)) e;
$$;
REVOKE ALL ON FUNCTION public._exam_sections_total(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._exam_sections_targets(jsonb) FROM PUBLIC;

-- ── exam_upsert_paper：多接受 sections，重算 total_points / section_targets ──
CREATE OR REPLACE FUNCTION public.exam_upsert_paper(p_payload JSONB, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id   UUID := public.resolve_quiz_actor(p_actor_id);
  v_paper_id UUID := NULLIF(p_payload ->> 'id', '')::uuid;
  v_sections JSONB := p_payload -> 'sections';
  row_out    public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  IF v_paper_id IS NULL THEN
    IF v_sections IS NULL THEN
      v_sections := jsonb_build_array(
        jsonb_build_object('type','truefalse','count',20,'pointsPer',1),
        jsonb_build_object('type','single','count',20,'pointsPer',1),
        jsonb_build_object('type','multiple','count',10,'pointsPer',1),
        jsonb_build_object('type','matching','count',10,'pointsPer',1),
        jsonb_build_object('type','ordering','count',10,'pointsPer',1),
        jsonb_build_object('type','shortanswer','count',3,'pointsPer',10));
    END IF;
    INSERT INTO public.exam_papers (title, description, mode, open_at, close_at,
        duration_minutes, total_points, pledge, sections, section_targets, created_by)
    VALUES (
      COALESCE(NULLIF(p_payload ->> 'title', ''), '速讀測驗'),
      COALESCE(p_payload ->> 'description', ''),
      COALESCE(NULLIF(p_payload ->> 'mode', ''), 'test'),
      NULLIF(p_payload ->> 'open_at', '')::timestamptz,
      NULLIF(p_payload ->> 'close_at', '')::timestamptz,
      COALESCE((p_payload ->> 'duration_minutes')::smallint, 75),
      GREATEST(public._exam_sections_total(v_sections)::smallint, 1),
      COALESCE(p_payload -> 'pledge', jsonb_build_object('openText','', 'rules','[]'::jsonb, 'consentTemplate','')),
      v_sections,
      public._exam_sections_targets(v_sections),
      actor_id)
    RETURNING * INTO row_out;
  ELSE
    UPDATE public.exam_papers SET
      title = COALESCE(NULLIF(p_payload ->> 'title', ''), title),
      description = COALESCE(p_payload ->> 'description', description),
      mode = COALESCE(NULLIF(p_payload ->> 'mode', ''), mode),
      open_at = COALESCE(NULLIF(p_payload ->> 'open_at', '')::timestamptz, open_at),
      close_at = COALESCE(NULLIF(p_payload ->> 'close_at', '')::timestamptz, close_at),
      duration_minutes = COALESCE((p_payload ->> 'duration_minutes')::smallint, duration_minutes),
      pledge = COALESCE(p_payload -> 'pledge', pledge),
      sections = COALESCE(v_sections, sections),
      section_targets = CASE WHEN v_sections IS NOT NULL
                             THEN public._exam_sections_targets(v_sections) ELSE section_targets END,
      total_points = CASE WHEN v_sections IS NOT NULL
                          THEN GREATEST(public._exam_sections_total(v_sections)::smallint, 1)
                          ELSE COALESCE((p_payload ->> 'total_points')::smallint, total_points) END
    WHERE id = v_paper_id AND status = 'draft'
    RETURNING * INTO row_out;
    IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_editable'; END IF;
  END IF;

  RETURN to_jsonb(row_out);
END;
$$;

-- ── exam_publish：改用 sections 驗證（只檢查有列出的題型）──
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
  IF pr.open_at IS NULL OR pr.close_at IS NULL OR pr.close_at <= pr.open_at THEN
    RAISE EXCEPTION 'exam_window_invalid';
  END IF;
  IF COALESCE(jsonb_array_length(pr.sections), 0) = 0 THEN
    RAISE EXCEPTION 'exam_no_sections';
  END IF;

  SELECT array_agg(e ->> 'type') INTO enabled_types
  FROM jsonb_array_elements(pr.sections) e;

  -- 已列出的題型：題數要相符
  FOR sec, want IN
    SELECT e ->> 'type', (e ->> 'count')::int FROM jsonb_array_elements(pr.sections) e
  LOOP
    SELECT COUNT(*) INTO got FROM public.exam_questions WHERE paper_id = pr.id AND section = sec;
    IF got <> want THEN
      RAISE EXCEPTION 'exam_section_count_mismatch: % expected % got %', sec, want, got;
    END IF;
  END LOOP;

  -- 不該出現的題型（沒列出卻有題目）
  IF EXISTS (SELECT 1 FROM public.exam_questions
             WHERE paper_id = pr.id AND NOT (section = ANY(enabled_types))) THEN
    RAISE EXCEPTION 'exam_section_not_enabled';
  END IF;

  -- 一~五題必須有 answer_key，且結構合理
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

REVOKE ALL ON FUNCTION public.exam_upsert_paper(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_upsert_paper(jsonb, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.exam_publish(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_publish(uuid, uuid) TO authenticated, service_role;
