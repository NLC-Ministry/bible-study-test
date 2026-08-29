-- ============================================================================
-- 0115_exam_auto_score_toggle.sql
-- 一鍵開關「自動評分」。答案還沒定稿時先關掉，作答只存不計分；
-- 答案填好後開回來、按「重新計分」把所有已送出的作答一次算完。
--
--   exam_papers.auto_score_enabled BOOLEAN DEFAULT TRUE
--   exam_set_auto_score(paper, enabled)        — 開 / 關
--   exam_recompute_scores(paper)               — 依現有 answer_key 重算所有作答
--   exam_submit_attempt                        — auto_score_enabled=FALSE 時只存不計分、狀態停在 'submitted'
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS auto_score_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 開 / 關 ──
CREATE OR REPLACE FUNCTION public.exam_set_auto_score(p_paper_id UUID, p_enabled BOOLEAN, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  UPDATE public.exam_papers SET auto_score_enabled = COALESCE(p_enabled, TRUE) WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  RETURN jsonb_build_object('paperId', p_paper_id, 'autoScoreEnabled', COALESCE(p_enabled, TRUE));
END;
$$;

-- ── 送出：依 auto_score_enabled 決定要不要算分 ──
CREATE OR REPLACE FUNCTION public.exam_submit_attempt(
  p_attempt_id UUID,
  p_answers    JSONB,
  p_reason     TEXT DEFAULT 'manual',
  p_actor_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  at       public.exam_attempts%ROWTYPE;
  auto_on  BOOLEAN;
  q        RECORD;
  resp     JSONB;
  ok       BOOLEAN;
  pts      NUMERIC;
  auto_sum NUMERIC := 0;
  has_short BOOLEAN := FALSE;
  new_status TEXT;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id AND user_id = actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;

  IF at.status <> 'in_progress' THEN
    RETURN jsonb_build_object('attemptId', at.id, 'status', at.status,
      'autoScore', at.auto_score, 'manualScore', at.manual_score, 'totalScore', at.total_score,
      'alreadySubmitted', TRUE);
  END IF;

  SELECT auto_score_enabled INTO auto_on FROM public.exam_papers WHERE id = at.paper_id;

  FOR q IN SELECT id, section, points, answer_key FROM public.exam_questions
           WHERE paper_id = at.paper_id LOOP
    resp := COALESCE(p_answers -> q.id::text,
                     (SELECT response FROM public.exam_answers
                      WHERE attempt_id = at.id AND question_id = q.id));

    IF q.section = 'shortanswer' THEN
      has_short := TRUE;
      INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
      VALUES (at.id, q.id, q.section, resp, NULL, NULL)
      ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET response = EXCLUDED.response, updated_at = NOW();
    ELSIF auto_on THEN
      ok := public._exam_answer_is_correct(q.section, q.answer_key, resp);
      pts := CASE WHEN ok THEN q.points ELSE 0 END;
      auto_sum := auto_sum + pts;
      INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
      VALUES (at.id, q.id, q.section, resp, ok, pts)
      ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET response = EXCLUDED.response, auto_correct = EXCLUDED.auto_correct,
                      awarded_points = EXCLUDED.awarded_points, updated_at = NOW();
    ELSE
      -- 自動評分關閉：只存作答，不判定
      INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
      VALUES (at.id, q.id, q.section, resp, NULL, NULL)
      ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET response = EXCLUDED.response, auto_correct = NULL, awarded_points = NULL, updated_at = NOW();
    END IF;
  END LOOP;

  -- 自動評分關 → 一律停在 'submitted'（待重新計分 / 公布）
  new_status := CASE WHEN (auto_on AND NOT has_short) THEN 'graded' ELSE 'submitted' END;

  UPDATE public.exam_attempts SET
    status = new_status,
    submitted_at = NOW(),
    submit_reason = CASE WHEN p_reason IN ('manual','timeout','auto_close') THEN p_reason ELSE 'manual' END,
    auto_score   = CASE WHEN auto_on THEN auto_sum ELSE NULL END,
    manual_score = CASE WHEN (auto_on AND NOT has_short) THEN 0 ELSE NULL END,
    total_score  = CASE WHEN (auto_on AND NOT has_short) THEN auto_sum ELSE NULL END
  WHERE id = at.id;

  RETURN jsonb_build_object('attemptId', at.id, 'status', new_status,
    'autoScore', CASE WHEN auto_on THEN auto_sum ELSE NULL END,
    'totalScore', CASE WHEN (auto_on AND NOT has_short) THEN auto_sum ELSE NULL END,
    'alreadySubmitted', FALSE);
END;
$$;

-- ── 重新計分：依現有 answer_key 把所有已送出的作答重算一遍 ──
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
      UPDATE public.exam_answers
        SET auto_correct = ok, awarded_points = pts, updated_at = NOW()
        WHERE attempt_id = a.id AND question_id = q.id;
    END LOOP;

    SELECT COUNT(*), COUNT(*) FILTER (WHERE ea.awarded_points IS NOT NULL),
           COALESCE(SUM(ea.awarded_points), 0)
      INTO short_total, short_graded, short_sum
    FROM public.exam_answers ea
    WHERE ea.attempt_id = a.id AND ea.section = 'shortanswer';

    UPDATE public.exam_attempts SET
      auto_score = auto_sum,
      manual_score = CASE WHEN NOT has_short THEN 0
                          WHEN short_total > 0 AND short_graded = short_total THEN short_sum
                          ELSE NULL END,
      total_score = CASE WHEN NOT has_short THEN auto_sum
                         WHEN short_total > 0 AND short_graded = short_total THEN auto_sum + short_sum
                         ELSE NULL END,
      status = CASE WHEN NOT has_short THEN 'graded'
                    WHEN short_total > 0 AND short_graded = short_total THEN 'graded'
                    ELSE 'submitted' END
    WHERE id = a.id;
    n := n + 1;
  END LOOP;

  RETURN jsonb_build_object('paperId', p_paper_id, 'recomputed', n);
END;
$$;

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_set_auto_score(uuid, boolean, uuid)',
    'exam_submit_attempt(uuid, jsonb, text, uuid)',
    'exam_recompute_scores(uuid, uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
