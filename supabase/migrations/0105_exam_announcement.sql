-- ============================================================================
-- 0105_exam_announcement.sql
-- 「發佈」拆成兩件互相獨立的事：
--   1. 發佈預告文 —— 只切一個布林旗標 announcement_published，
--      **不動 status、不鎖題庫**。首頁 8/30 宣示 banner 依這個旗標顯示。
--   2. 發佈測驗   —— 走原本的 exam_publish（status: draft → published），
--      前置條件是「預告文已發佈」。發佈測驗才會鎖定題庫。
--
--   → 可以同時「預告文對全體會友上線」又「試卷留在 draft / 切回 test 繼續改題」。
--   → mode(test/live) 只決定「誰能真的進入作答」，不影響預告 banner 是否顯示。
--
--   status 維持 draft / published / closed（沒有新增 announced）。
--   exam_papers 新增 announcement JSONB { headline, body, ctaLabel }
--                     + announcement_published BOOL + announced_at / announced_by
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

-- 預設帶入原本首頁硬寫的 8/30 預告文案，出題者不必重打（要改再改）。
ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS announcement JSONB NOT NULL
    DEFAULT jsonb_build_object(
      'headline', '8/30 速讀測驗即將登場',
      'body', '8/30 00:00 起開放 24 小時，作答限時 75 分鐘。開始前請先詳閱測驗宣示規則。',
      'ctaLabel', ''),
  ADD COLUMN IF NOT EXISTS announcement_published BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS announced_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 既有試卷若還沒有預告文內容，帶入原文案當預設（不自動發佈；要上線請在後台按「發佈預告文」）。
UPDATE public.exam_papers
SET announcement = jsonb_build_object(
      'headline', '8/30 速讀測驗即將登場',
      'body', '8/30 00:00 起開放 24 小時，作答限時 75 分鐘。開始前請先詳閱測驗宣示規則。',
      'ctaLabel', '')
WHERE announcement IS NULL
   OR COALESCE(btrim(announcement ->> 'headline'), '') = '';

-- ── 編輯預告文（草稿 / 已發佈測驗都可微調文案；只有關閉後鎖定）──
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
  WHERE id = p_paper_id AND status <> 'closed'
  RETURNING * INTO row_out;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_announcement_locked'; END IF;
  RETURN to_jsonb(row_out);
END;
$$;

-- ── 發佈預告文（旗標開）──
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

-- ── 撤下預告文（旗標關；不影響 status / 作答）──
CREATE OR REPLACE FUNCTION public.exam_unpublish_announcement(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  UPDATE public.exam_papers
  SET announcement_published = FALSE
  WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  RETURN jsonb_build_object('paperId', p_paper_id, 'announcementPublished', FALSE);
END;
$$;

-- ── exam_publish：發佈測驗前必須先發佈預告文 ──
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
  IF NOT pr.announcement_published THEN RAISE EXCEPTION 'exam_not_announced'; END IF;
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
--   功能關閉 / 沒有已發佈預告文的試卷 → 回 NULL，前端隱藏整塊。
--   預告文一旦發佈，不分 test/live 都會顯示；能不能真的進入作答由 canEnter 決定。
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
    OR (pr.status = 'published' AND in_window AND (pr.mode = 'live' OR is_staff)
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

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_save_announcement(uuid, jsonb, uuid)',
    'exam_publish_announcement(uuid, uuid)',
    'exam_unpublish_announcement(uuid, uuid)',
    'exam_publish(uuid, uuid)',
    'exam_home_banner(uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
