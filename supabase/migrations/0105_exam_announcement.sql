-- ============================================================================
-- 0105_exam_announcement.sql
-- 「發佈」拆成兩段：
--   1. 發佈預告文（draft → announced）：把預告文推上首頁 8/30 宣示 banner
--   2. 發佈測驗  （announced → published）：正式開放作答，必須先有預告文
--
--   exam_papers 新增 announcement JSONB { headline, body, ctaLabel } + announced_at/by
--   狀態機：draft →(發預告)→ announced →(發測驗)→ published →(關閉)→ closed
--           announced / published / closed 都可「改回草稿」
--   announced 與 published 一樣鎖題庫；預告文本身仍可用 exam_save_announcement 微調
--
--   新 RPC：exam_save_announcement / exam_publish_announcement / exam_home_banner
--   改  ： exam_publish 前置狀態 draft → announced
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

ALTER TABLE public.exam_papers
  DROP CONSTRAINT IF EXISTS exam_papers_status_check;
ALTER TABLE public.exam_papers
  ADD CONSTRAINT exam_papers_status_check
  CHECK (status IN ('draft', 'announced', 'published', 'closed'));

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS announcement JSONB NOT NULL
    DEFAULT jsonb_build_object('headline', '', 'body', '', 'ctaLabel', ''),
  ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS announced_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── 編輯預告文（draft / announced 皆可，讓 banner 上線後仍能微調文案）──
CREATE OR REPLACE FUNCTION public.exam_save_announcement(
  p_paper_id     UUID,
  p_announcement JSONB,
  p_actor_id     UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  row_out  public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  UPDATE public.exam_papers SET
    announcement = jsonb_build_object(
      'headline', COALESCE(p_announcement ->> 'headline', ''),
      'body',     COALESCE(p_announcement ->> 'body', ''),
      'ctaLabel', COALESCE(p_announcement ->> 'ctaLabel', ''))
  WHERE id = p_paper_id AND status IN ('draft', 'announced')
  RETURNING * INTO row_out;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_announcement_locked'; END IF;
  RETURN to_jsonb(row_out);
END;
$$;

-- ── 發佈預告文（draft → announced）──
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
  IF pr.status <> 'draft' THEN RAISE EXCEPTION 'exam_announcement_already_published'; END IF;
  IF COALESCE(btrim(pr.announcement ->> 'headline'), '') = ''
     OR COALESCE(btrim(pr.announcement ->> 'body'), '') = '' THEN
    RAISE EXCEPTION 'exam_announcement_incomplete';
  END IF;
  IF pr.open_at IS NULL OR pr.close_at IS NULL OR pr.close_at <= pr.open_at THEN
    RAISE EXCEPTION 'exam_window_invalid';
  END IF;

  UPDATE public.exam_papers
  SET status = 'announced', announced_at = NOW(), announced_by = actor_id
  WHERE id = pr.id;

  RETURN jsonb_build_object('paperId', pr.id, 'status', 'announced');
END;
$$;

-- ── exam_publish：前置狀態改為 announced（必須先發預告文）──
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
  IF pr.status <> 'announced' THEN RAISE EXCEPTION 'exam_not_announced'; END IF;
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

-- ── 首頁 8/30 宣示 banner 資料源（一般會友都可呼叫）──
--   功能關閉 / 沒有已發預告的試卷 → 回 NULL，前端隱藏整個區塊
CREATE OR REPLACE FUNCTION public.exam_home_banner(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  pr       public.exam_papers%ROWTYPE;
  at       public.exam_attempts%ROWTYPE;
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam') THEN RETURN NULL; END IF;

  SELECT * INTO pr FROM public.exam_papers
  WHERE status IN ('announced', 'published', 'closed')
    AND (is_staff OR mode = 'live')
  ORDER BY (mode = 'live') DESC, announced_at DESC NULLS LAST, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  RETURN jsonb_build_object(
    'paperId', pr.id,
    'title', pr.title,
    'status', pr.status,
    'headline', COALESCE(pr.announcement ->> 'headline', ''),
    'body', COALESCE(pr.announcement ->> 'body', ''),
    'ctaLabel', COALESCE(NULLIF(pr.announcement ->> 'ctaLabel', ''), '進入測驗'),
    'openAt', pr.open_at,
    'closeAt', pr.close_at,
    'durationMinutes', pr.duration_minutes,
    'serverNow', NOW(),
    'myAttemptStatus', at.status,
    'myTotalScore', CASE WHEN at.status = 'graded' THEN at.total_score ELSE NULL END
  );
END;
$$;

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_save_announcement(uuid, jsonb, uuid)',
    'exam_publish_announcement(uuid, uuid)',
    'exam_publish(uuid, uuid)',
    'exam_home_banner(uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
