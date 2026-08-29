-- ============================================================================
-- 0117_exam_publish_results_lock.sql
-- 「公布成績」＝一次對外釋出、之後成績鎖定不得再改。
--
--   exam_papers.results_published_at TIMESTAMPTZ  (NULL = 尚未公布)
--   exam_publish_results(paper)  — 需所有作答都已 graded；設旗標、對每位發通知
--   公布後：exam_set_answer_key / exam_recompute_scores / exam_grade_answer /
--           exam_reset_attempts 一律 RAISE 'exam_results_locked'
--   exam_get_my_result / exam_home_banner：未公布前一般會友看不到分數與正解
--           （管理員 / 牧者不受限，方便驗證）
--   exam_grade_answer 不再自己發通知（改由 exam_publish_results 統一發）
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS results_published_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public._exam_results_locked(p_paper_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SET search_path = pg_catalog, public
AS $$
  SELECT results_published_at IS NOT NULL FROM public.exam_papers WHERE id = p_paper_id;
$$;
REVOKE ALL ON FUNCTION public._exam_results_locked(uuid) FROM PUBLIC;

-- ── 公布成績 ──
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

-- ── 補正解：公布後鎖定 ──
CREATE OR REPLACE FUNCTION public.exam_set_answer_key(p_question_id UUID, p_answer_key JSONB, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  q        public.exam_questions%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO q FROM public.exam_questions WHERE id = p_question_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_question_not_found'; END IF;
  IF q.section = 'shortanswer' THEN RAISE EXCEPTION 'exam_answer_not_gradable'; END IF;
  IF public._exam_results_locked(q.paper_id) THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  UPDATE public.exam_questions SET answer_key = p_answer_key, updated_at = NOW() WHERE id = p_question_id;
  RETURN jsonb_build_object('questionId', p_question_id, 'section', q.section);
END;
$$;

-- ── 重新計分：公布後鎖定 ──
CREATE OR REPLACE FUNCTION public.exam_recompute_scores(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  a        RECORD;
  q        RECORD;
  ok       BOOLEAN;
  pts      NUMERIC;
  auto_sum NUMERIC;
  has_short BOOLEAN;
  short_total INTEGER;
  short_graded INTEGER;
  short_sum NUMERIC;
  n INTEGER := 0;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = p_paper_id) THEN
    RAISE EXCEPTION 'exam_paper_not_found';
  END IF;
  IF public._exam_results_locked(p_paper_id) THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  SELECT EXISTS (SELECT 1 FROM public.exam_questions WHERE paper_id = p_paper_id AND section = 'shortanswer')
    INTO has_short;

  FOR a IN SELECT * FROM public.exam_attempts
           WHERE paper_id = p_paper_id AND status IN ('submitted', 'graded') LOOP
    auto_sum := 0;
    FOR q IN SELECT id, section, points, answer_key FROM public.exam_questions
             WHERE paper_id = p_paper_id AND section <> 'shortanswer' LOOP
      ok := public._exam_answer_is_correct(q.section, q.answer_key,
              (SELECT response FROM public.exam_answers WHERE attempt_id = a.id AND question_id = q.id));
      pts := CASE WHEN ok THEN q.points ELSE 0 END;
      auto_sum := auto_sum + pts;
      UPDATE public.exam_answers SET auto_correct = ok, awarded_points = pts, updated_at = NOW()
        WHERE attempt_id = a.id AND question_id = q.id;
    END LOOP;

    SELECT COUNT(*), COUNT(*) FILTER (WHERE ea.awarded_points IS NOT NULL), COALESCE(SUM(ea.awarded_points), 0)
      INTO short_total, short_graded, short_sum
    FROM public.exam_answers ea WHERE ea.attempt_id = a.id AND ea.section = 'shortanswer';

    UPDATE public.exam_attempts SET
      auto_score = auto_sum,
      manual_score = CASE WHEN NOT has_short THEN 0
                          WHEN short_total > 0 AND short_graded = short_total THEN short_sum ELSE NULL END,
      total_score = CASE WHEN NOT has_short THEN auto_sum
                         WHEN short_total > 0 AND short_graded = short_total THEN auto_sum + short_sum ELSE NULL END,
      status = CASE WHEN NOT has_short THEN 'graded'
                    WHEN short_total > 0 AND short_graded = short_total THEN 'graded' ELSE 'submitted' END
    WHERE id = a.id;
    n := n + 1;
  END LOOP;

  RETURN jsonb_build_object('paperId', p_paper_id, 'recomputed', n);
END;
$$;

-- ── 簡答批改：公布後鎖定；不再自己發通知 ──
CREATE OR REPLACE FUNCTION public.exam_grade_answer(
  p_answer_id UUID, p_points NUMERIC, p_comment TEXT DEFAULT '', p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id  UUID := public.resolve_quiz_actor(p_actor_id);
  ea        public.exam_answers%ROWTYPE;
  at        public.exam_attempts%ROWTYPE;
  max_pts   NUMERIC;
  pending   INTEGER;
  short_sum NUMERIC;
  finalized BOOLEAN := FALSE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO ea FROM public.exam_answers WHERE id = p_answer_id;
  IF NOT FOUND OR ea.section <> 'shortanswer' THEN RAISE EXCEPTION 'exam_answer_not_gradable'; END IF;
  SELECT * INTO at FROM public.exam_attempts WHERE id = ea.attempt_id;
  IF public._exam_results_locked(at.paper_id) THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  SELECT points INTO max_pts FROM public.exam_questions WHERE id = ea.question_id;
  IF p_points IS NULL OR p_points < 0 OR p_points > max_pts THEN
    RAISE EXCEPTION 'exam_points_out_of_range: 0..%', max_pts;
  END IF;

  UPDATE public.exam_answers
  SET awarded_points = p_points, grader_comment = NULLIF(TRIM(p_comment), ''),
      grader_id = actor_id, graded_at = NOW()
  WHERE id = ea.id;

  SELECT COUNT(*) FILTER (WHERE awarded_points IS NULL), COALESCE(SUM(awarded_points), 0)
    INTO pending, short_sum
  FROM public.exam_answers WHERE attempt_id = at.id AND section = 'shortanswer';

  IF pending = 0 THEN
    UPDATE public.exam_attempts
    SET status = 'graded', manual_score = short_sum, total_score = COALESCE(auto_score, 0) + short_sum
    WHERE id = at.id;
    finalized := TRUE;
  END IF;

  RETURN jsonb_build_object('answerId', ea.id, 'awardedPoints', p_points,
    'attemptFinalized', finalized, 'pendingInAttempt', pending);
END;
$$;

-- ── 清除作答：公布後鎖定 ──
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
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  DELETE FROM public.exam_attempts WHERE paper_id = pr.id;
  GET DIAGNOSTICS n_deleted = ROW_COUNT;
  RETURN jsonb_build_object('paperId', pr.id, 'deletedAttempts', n_deleted);
END;
$$;

-- ── 作答者看成績：未公布前（且非 staff）看不到分數與正解 ──
CREATE OR REPLACE FUNCTION public.exam_get_my_result(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  at       public.exam_attempts%ROWTYPE;
  published BOOLEAN;
  show_full BOOLEAN;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = p_paper_id AND user_id = actor_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_attempt'); END IF;
  IF at.status = 'in_progress' THEN RETURN jsonb_build_object('state', 'in_progress'); END IF;

  SELECT results_published_at IS NOT NULL INTO published FROM public.exam_papers WHERE id = p_paper_id;
  show_full := (at.status = 'graded') AND (published OR is_staff);

  RETURN jsonb_build_object(
    'state', CASE WHEN show_full THEN 'graded' ELSE 'submitted' END,
    'autoScore',   CASE WHEN show_full THEN at.auto_score ELSE NULL END,
    'manualScore', CASE WHEN show_full THEN at.manual_score ELSE NULL END,
    'totalScore',  CASE WHEN show_full THEN at.total_score ELSE NULL END,
    'submittedAt', at.submitted_at,
    'answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'questionId', ea.question_id, 'section', ea.section, 'position', q.position,
        'points', q.points,
        'sectionRank', public._exam_section_rank(ea.section),
        'response', ea.response,
        'autoCorrect', CASE WHEN show_full THEN ea.auto_correct ELSE NULL END,
        'awardedPoints', CASE WHEN show_full THEN ea.awarded_points ELSE NULL END,
        'graderComment', CASE WHEN show_full THEN ea.grader_comment ELSE NULL END,
        'payload', CASE WHEN show_full THEN q.payload
                        ELSE public._exam_public_payload(q.section, q.payload, q.points) END,
        'answerKey', CASE WHEN show_full AND ea.section <> 'shortanswer' THEN q.answer_key ELSE NULL END)
      ORDER BY public._exam_section_rank(ea.section), q.position)
      FROM public.exam_answers ea JOIN public.exam_questions q ON q.id = ea.question_id
      WHERE ea.attempt_id = at.id
    ), '[]'::jsonb)
  );
END;
$$;

-- ── 首頁 banner：resultReady / 分數要等成績公布 ──
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

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_publish_results(uuid, uuid)',
    'exam_set_answer_key(uuid, jsonb, uuid)',
    'exam_recompute_scores(uuid, uuid)',
    'exam_grade_answer(uuid, numeric, text, uuid)',
    'exam_reset_attempts(uuid, uuid)',
    'exam_get_my_result(uuid, uuid)',
    'exam_home_banner(uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
