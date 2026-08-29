-- ============================================================================
-- 0120_exam_finalize_expired.sql
-- 逾時自動收卷：作答時間過了、但前端沒能送出（裝置睡眠 / 背景 / 斷線後沒回來）
-- 的 attempt，會永遠卡在 'in_progress'——首頁 banner 一直顯示「作答中」、使用者
-- 看不到成績、exam_publish_results 也因為有非 graded 的 attempt 而卡住。
--
--   _exam_sweep_expired(paper)   內部：把 deadline_at + 120s 之後仍 in_progress 的
--                                attempt，用「已存進 exam_answers 的作答」跑跟
--                                exam_submit_attempt 相同的計分，submit_reason='auto_close'。
--                                只讀伺服器已存的作答，不吃前端任何輸入。
--   exam_finalize_expired(paper) admin/pastor 手動觸發（後台「收卷」按鈕）。
--   惰性掃描：exam_home_banner / exam_publish_results 進入時先掃一遍 → 沒有 pg_cron
--             也能自癒（下次任何人開首頁 / 按公布就結算掉）。
--
-- 冪等：exam_submit_attempt 既有的 `status <> 'in_progress'` 檢查 + 這裡的
--       `WHERE ... status = 'in_progress'` guard + FOR UPDATE SKIP LOCKED，
--       前端 submit 與這個 sweep 不會重複計分。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。nlc-data 需加
--       exam_finalize_expired 到 allowlist 並重新部署。
-- ============================================================================

CREATE OR REPLACE FUNCTION public._exam_sweep_expired(p_paper_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  auto_on   BOOLEAN;
  has_short BOOLEAN;
  a         RECORD;
  q         RECORD;
  resp      JSONB;
  ok        BOOLEAN;
  pts       NUMERIC;
  auto_sum  NUMERIC;
  n_done    INTEGER := 0;
BEGIN
  IF p_paper_id IS NULL THEN RETURN 0; END IF;

  SELECT COALESCE(auto_score_enabled, TRUE) INTO auto_on
  FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT EXISTS (SELECT 1 FROM public.exam_questions
                 WHERE paper_id = p_paper_id AND section = 'shortanswer')
    INTO has_short;

  FOR a IN
    SELECT id FROM public.exam_attempts
    WHERE paper_id = p_paper_id
      AND status = 'in_progress'
      AND NOW() > deadline_at + INTERVAL '120 seconds'
    FOR UPDATE SKIP LOCKED
  LOOP
    auto_sum := 0;

    FOR q IN SELECT id, section, points, answer_key FROM public.exam_questions
             WHERE paper_id = p_paper_id LOOP
      resp := (SELECT response FROM public.exam_answers
               WHERE attempt_id = a.id AND question_id = q.id);

      IF q.section = 'shortanswer' THEN
        INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
        VALUES (a.id, q.id, q.section, resp, NULL, NULL)
        ON CONFLICT (attempt_id, question_id)
          DO UPDATE SET response = EXCLUDED.response, updated_at = NOW();
      ELSIF auto_on THEN
        ok  := public._exam_answer_is_correct(q.section, q.answer_key, resp);
        pts := CASE WHEN ok THEN q.points ELSE 0 END;
        auto_sum := auto_sum + pts;
        INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
        VALUES (a.id, q.id, q.section, resp, ok, pts)
        ON CONFLICT (attempt_id, question_id)
          DO UPDATE SET response = EXCLUDED.response, auto_correct = EXCLUDED.auto_correct,
                        awarded_points = EXCLUDED.awarded_points, updated_at = NOW();
      ELSE
        INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
        VALUES (a.id, q.id, q.section, resp, NULL, NULL)
        ON CONFLICT (attempt_id, question_id)
          DO UPDATE SET response = EXCLUDED.response, auto_correct = NULL,
                        awarded_points = NULL, updated_at = NOW();
      END IF;
    END LOOP;

    UPDATE public.exam_attempts SET
      status       = CASE WHEN (auto_on AND NOT has_short) THEN 'graded' ELSE 'submitted' END,
      submitted_at = COALESCE(submitted_at, NOW()),
      submit_reason = 'auto_close',
      auto_score   = CASE WHEN auto_on THEN auto_sum ELSE NULL END,
      manual_score = CASE WHEN (auto_on AND NOT has_short) THEN 0 ELSE NULL END,
      total_score  = CASE WHEN (auto_on AND NOT has_short) THEN auto_sum ELSE NULL END
    WHERE id = a.id AND status = 'in_progress';

    n_done := n_done + 1;
  END LOOP;

  RETURN n_done;
END;
$$;
REVOKE ALL ON FUNCTION public._exam_sweep_expired(uuid) FROM PUBLIC;

-- ── 後台手動「收卷（結算逾時未交）」 ──
CREATE OR REPLACE FUNCTION public.exam_finalize_expired(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  n INTEGER;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = p_paper_id) THEN
    RAISE EXCEPTION 'exam_paper_not_found';
  END IF;
  n := public._exam_sweep_expired(p_paper_id);
  RETURN jsonb_build_object('paperId', p_paper_id, 'finalized', n);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_finalize_expired(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_finalize_expired(uuid, uuid) TO authenticated, service_role;

-- ── 惰性掃描：首頁 banner 進入時先收一輪逾時卷 ──
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
  res_ready BOOLEAN;
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam') THEN RETURN NULL; END IF;

  SELECT * INTO pr FROM public.exam_papers
  WHERE announcement_published = TRUE AND (mode = 'live' OR is_staff)
  ORDER BY (mode = 'live') DESC, announced_at DESC NULLS LAST, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM public._exam_sweep_expired(pr.id);

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  in_window := (pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL
                AND now_ts >= pr.open_at AND now_ts <= pr.close_at);
  can_enter := (
    at.status = 'in_progress'
    OR (pr.status = 'published' AND (in_window OR (pr.mode = 'test' AND is_staff))
        AND (at.id IS NULL OR at.status = 'in_progress'))
  );
  res_ready := (at.status = 'graded' AND (pr.results_published_at IS NOT NULL OR is_staff));

  RETURN jsonb_build_object(
    'paperId', pr.id, 'title', pr.title, 'status', pr.status, 'mode', pr.mode,
    'headline', COALESCE(pr.announcement ->> 'headline', ''),
    'body', COALESCE(pr.announcement ->> 'body', ''),
    'ctaLabel', COALESCE(NULLIF(pr.announcement ->> 'ctaLabel', ''), '進入測驗'),
    'openAt', pr.open_at, 'closeAt', pr.close_at, 'durationMinutes', pr.duration_minutes,
    'serverNow', now_ts, 'inWindow', in_window, 'canEnter', can_enter,
    'myAttemptStatus', at.status, 'resultReady', res_ready,
    'myTotalScore', CASE WHEN res_ready THEN at.total_score ELSE NULL END
  );
END;
$$;

-- ── 惰性掃描：公布成績前先收一輪逾時卷（不然一筆卡住就整份不能公布）──
CREATE OR REPLACE FUNCTION public.exam_publish_results(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  n_unfinished INTEGER;
  n_notified   INTEGER;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.results_published_at IS NOT NULL THEN
    RETURN jsonb_build_object('paperId', pr.id, 'resultsPublishedAt', pr.results_published_at, 'alreadyPublished', TRUE);
  END IF;

  PERFORM public._exam_sweep_expired(pr.id);

  SELECT COUNT(*) INTO n_unfinished FROM public.exam_attempts
  WHERE paper_id = pr.id AND status <> 'graded';
  IF n_unfinished > 0 THEN
    RAISE EXCEPTION 'exam_results_incomplete: % 筆作答尚未結算（作答中 / 待批 / 待重新計分）', n_unfinished;
  END IF;

  UPDATE public.exam_papers SET results_published_at = NOW() WHERE id = pr.id;

  INSERT INTO public.exam_notifications (attempt_id, recipient_id, kind)
  SELECT a.id, a.user_id, 'graded' FROM public.exam_attempts a
  WHERE a.paper_id = pr.id AND a.status = 'graded'
  ON CONFLICT (attempt_id, recipient_id, kind) DO NOTHING;
  GET DIAGNOSTICS n_notified = ROW_COUNT;

  RETURN jsonb_build_object('paperId', pr.id, 'resultsPublishedAt', NOW(), 'notified', n_notified);
END;
$$;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.exam_home_banner(uuid) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.exam_home_banner(uuid) TO authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.exam_publish_results(uuid, uuid) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.exam_publish_results(uuid, uuid) TO authenticated, service_role';
END $$;
