-- ============================================================================
-- 0122_exam_practice_review_and_auto_close.sql
-- 正式首考 / 重作練習分流、送出後唯讀回顧、關閉前禁止評分、到時自動關閉。
--
-- 重要不變量：
--   1. 每人每卷最多一筆 official + 一筆 practice。
--   2. published 期間只收答案，不判分；closed 後才可自動/人工評分與公布。
--   3. practice 不進正式統計、排行、團隊分數、正式批改、通知與公布條件。
--   4. practice 在 paper closed 或 NOW() >= close_at 後拒絕寫入。
--   5. 手動 / 排程關閉都走 _exam_close_paper，同一原子狀態轉換。
-- ============================================================================

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS practice_retake_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS close_reason TEXT;

ALTER TABLE public.exam_papers DROP CONSTRAINT IF EXISTS exam_papers_close_reason_check;
ALTER TABLE public.exam_papers ADD CONSTRAINT exam_papers_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN ('manual', 'scheduled'));

ALTER TABLE public.exam_attempts
  ADD COLUMN IF NOT EXISTS attempt_kind TEXT NOT NULL DEFAULT 'official',
  ADD COLUMN IF NOT EXISTS attempt_no SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS official_attempt_id UUID REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS practice_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS practice_completed_at TIMESTAMPTZ;

UPDATE public.exam_attempts
SET attempt_kind = 'official', attempt_no = 1, official_attempt_id = NULL
WHERE attempt_kind IS DISTINCT FROM 'official' OR attempt_no IS DISTINCT FROM 1;

ALTER TABLE public.exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_attempt_kind_check;
ALTER TABLE public.exam_attempts ADD CONSTRAINT exam_attempts_attempt_kind_check
  CHECK (attempt_kind IN ('official', 'practice'));
ALTER TABLE public.exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_attempt_shape_check;
ALTER TABLE public.exam_attempts ADD CONSTRAINT exam_attempts_attempt_shape_check CHECK (
  (attempt_kind = 'official' AND attempt_no = 1 AND official_attempt_id IS NULL)
  OR
  (attempt_kind = 'practice' AND attempt_no = 1 AND official_attempt_id IS NOT NULL
   AND practice_acknowledged_at IS NOT NULL)
);

ALTER TABLE public.exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_paper_id_user_id_key;
DROP INDEX IF EXISTS public.idx_exam_attempts_one_official;
DROP INDEX IF EXISTS public.idx_exam_attempts_one_practice;
CREATE UNIQUE INDEX idx_exam_attempts_one_official
  ON public.exam_attempts(paper_id, user_id) WHERE attempt_kind = 'official';
CREATE UNIQUE INDEX idx_exam_attempts_one_practice
  ON public.exam_attempts(paper_id, user_id) WHERE attempt_kind = 'practice';
CREATE INDEX IF NOT EXISTS idx_exam_attempts_paper_kind_status
  ON public.exam_attempts(paper_id, attempt_kind, status);

-- ── 內部：判斷一~五大題答案是否完整 ──
CREATE OR REPLACE FUNCTION public._exam_keys_complete(p_paper_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.exam_questions q
    WHERE q.paper_id = p_paper_id AND q.section <> 'shortanswer' AND q.answer_key IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public._exam_keys_complete(uuid) FROM PUBLIC;

-- ── 內部：依 server 已存 response 計算一筆 attempt ──
CREATE OR REPLACE FUNCTION public._exam_score_attempt(p_attempt_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  at public.exam_attempts%ROWTYPE;
  q RECORD;
  resp JSONB;
  ok BOOLEAN;
  pts NUMERIC;
  auto_sum NUMERIC := 0;
  has_short BOOLEAN := FALSE;
  short_total INTEGER := 0;
  short_graded INTEGER := 0;
  short_sum NUMERIC := 0;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR at.status = 'in_progress' THEN RETURN; END IF;

  FOR q IN SELECT id, section, points, answer_key FROM public.exam_questions
           WHERE paper_id = at.paper_id LOOP
    resp := (SELECT response FROM public.exam_answers
             WHERE attempt_id = at.id AND question_id = q.id);
    IF q.section = 'shortanswer' THEN
      has_short := TRUE;
      CONTINUE;
    END IF;
    ok := public._exam_answer_is_correct(q.section, q.answer_key, resp);
    pts := CASE WHEN ok THEN q.points ELSE 0 END;
    auto_sum := auto_sum + pts;
    UPDATE public.exam_answers SET auto_correct = ok, awarded_points = pts, updated_at = NOW()
    WHERE attempt_id = at.id AND question_id = q.id;
  END LOOP;

  IF at.attempt_kind = 'practice' THEN
    UPDATE public.exam_attempts SET
      status = 'graded', auto_score = auto_sum, manual_score = NULL, total_score = auto_sum
    WHERE id = at.id;
  ELSE
    SELECT COUNT(*),COUNT(*)FILTER(WHERE ea.awarded_points IS NOT NULL),
      COALESCE(SUM(ea.awarded_points),0) INTO short_total,short_graded,short_sum
    FROM public.exam_answers ea WHERE ea.attempt_id=at.id AND ea.section='shortanswer';
    UPDATE public.exam_attempts SET
      status = CASE WHEN has_short AND short_graded<short_total THEN 'submitted' ELSE 'graded' END,
      auto_score = auto_sum,
      manual_score = CASE WHEN has_short AND short_graded=short_total THEN short_sum
                          WHEN has_short THEN NULL ELSE 0 END,
      total_score = CASE WHEN has_short AND short_graded=short_total THEN auto_sum+short_sum
                         WHEN has_short THEN NULL ELSE auto_sum END
    WHERE id = at.id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._exam_score_attempt(uuid) FROM PUBLIC;

-- ── 內部：唯一關閉流程（手動與排程共用） ──
CREATE OR REPLACE FUNCTION public._exam_close_paper(
  p_paper_id UUID,
  p_reason TEXT,
  p_closed_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  pr public.exam_papers%ROWTYPE;
  a RECORD;
  auto_on BOOLEAN;
  keys_ok BOOLEAN;
  n_finalized INTEGER := 0;
  n_scored INTEGER := 0;
BEGIN
  IF p_reason NOT IN ('manual', 'scheduled') THEN RAISE EXCEPTION 'exam_close_reason_invalid'; END IF;

  UPDATE public.exam_papers SET
    status = 'closed', closed_at = COALESCE(closed_at, NOW()),
    closed_by = CASE WHEN p_reason = 'manual' THEN p_closed_by ELSE NULL END,
    close_reason = COALESCE(close_reason, p_reason)
  WHERE id = p_paper_id AND status = 'published'
  RETURNING * INTO pr;

  IF NOT FOUND THEN
    SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
    RETURN jsonb_build_object('paperId', pr.id, 'status', pr.status,
      'alreadyClosed', pr.status = 'closed', 'finalized', 0, 'scored', 0);
  END IF;

  -- 關閉瞬間收妥所有仍進行中的卷；只用 server 已存答案，不接受前端補寫。
  FOR a IN SELECT id FROM public.exam_attempts
           WHERE paper_id = pr.id AND status = 'in_progress'
           FOR UPDATE SKIP LOCKED LOOP
    INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
    SELECT a.id, q.id, q.section, NULL, NULL, NULL
    FROM public.exam_questions q WHERE q.paper_id = pr.id
    ON CONFLICT (attempt_id, question_id) DO NOTHING;

    UPDATE public.exam_attempts SET
      status = 'submitted', submitted_at = COALESCE(submitted_at, NOW()),
      submit_reason = 'auto_close', auto_score = NULL, manual_score = NULL, total_score = NULL
    WHERE id = a.id AND status = 'in_progress';
    n_finalized := n_finalized + 1;
  END LOOP;

  auto_on := COALESCE(pr.auto_score_enabled, TRUE);
  keys_ok := public._exam_keys_complete(pr.id);
  IF auto_on AND keys_ok THEN
    FOR a IN SELECT id FROM public.exam_attempts
             WHERE paper_id = pr.id AND status IN ('submitted','graded') LOOP
      PERFORM public._exam_score_attempt(a.id);
      n_scored := n_scored + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('paperId', pr.id, 'status', 'closed',
    'alreadyClosed', FALSE, 'finalized', n_finalized, 'scored', n_scored,
    'autoScoreEnabled', auto_on, 'answerKeysComplete', keys_ok);
END;
$$;
REVOKE ALL ON FUNCTION public._exam_close_paper(uuid, text, uuid) FROM PUBLIC;

-- ── 內部：到時自動關閉所有 published 試卷 ──
CREATE OR REPLACE FUNCTION public._exam_close_expired_papers()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE r RECORD; n INTEGER := 0;
BEGIN
  FOR r IN SELECT id FROM public.exam_papers
           WHERE status = 'published' AND close_at IS NOT NULL AND close_at <= NOW()
           FOR UPDATE SKIP LOCKED LOOP
    PERFORM public._exam_close_paper(r.id, 'scheduled', NULL);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public._exam_close_expired_papers() FROM PUBLIC;

-- 發佈期間不評分，因此允許答案尚未定稿；關閉後再驗證正解並計分。
CREATE OR REPLACE FUNCTION public.exam_publish(p_paper_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);pr public.exam_papers%ROWTYPE;
  sec TEXT;want INTEGER;got INTEGER;enabled_types TEXT[];
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.status<>'draft' THEN RAISE EXCEPTION 'exam_already_published'; END IF;
  IF pr.mode='live' AND NOT pr.announcement_published THEN RAISE EXCEPTION 'exam_not_announced'; END IF;
  IF pr.open_at IS NULL OR pr.close_at IS NULL OR pr.close_at<=pr.open_at OR pr.close_at<=NOW() THEN
    RAISE EXCEPTION 'exam_window_invalid';
  END IF;
  IF COALESCE(jsonb_array_length(pr.sections),0)=0 THEN RAISE EXCEPTION 'exam_no_sections'; END IF;
  SELECT array_agg(e->>'type') INTO enabled_types FROM jsonb_array_elements(pr.sections)e;
  FOR sec,want IN SELECT e->>'type',(e->>'count')::int FROM jsonb_array_elements(pr.sections)e LOOP
    SELECT COUNT(*) INTO got FROM public.exam_questions WHERE paper_id=pr.id AND section=sec;
    IF got<>want THEN RAISE EXCEPTION 'exam_section_count_mismatch: % expected % got %',sec,want,got; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.exam_questions WHERE paper_id=pr.id AND NOT(section=ANY(enabled_types))) THEN
    RAISE EXCEPTION 'exam_section_not_enabled';
  END IF;
  UPDATE public.exam_papers SET status='published',published_at=NOW(),published_by=actor_id,
    closed_at=NULL,closed_by=NULL,close_reason=NULL WHERE id=pr.id;
  RETURN jsonb_build_object('paperId',pr.id,'status','published',
    'answerKeysComplete',public._exam_keys_complete(pr.id));
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_set_auto_score(p_paper_id UUID,p_enabled BOOLEAN,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);pr public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;
  UPDATE public.exam_papers SET auto_score_enabled=COALESCE(p_enabled,TRUE) WHERE id=pr.id;
  RETURN jsonb_build_object('paperId',pr.id,'autoScoreEnabled',COALESCE(p_enabled,TRUE));
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_set_practice_enabled(p_paper_id UUID,p_enabled BOOLEAN,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);pr public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.status='closed' OR pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_practice_locked'; END IF;
  UPDATE public.exam_papers SET practice_retake_enabled=COALESCE(p_enabled,TRUE) WHERE id=pr.id;
  RETURN jsonb_build_object('paperId',pr.id,'practiceRetakeEnabled',COALESCE(p_enabled,TRUE));
END;
$$;

-- ── 手動關閉 / 狀態調整 ──
CREATE OR REPLACE FUNCTION public.exam_set_status(p_paper_id UUID, p_status TEXT, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id); result JSONB;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF p_status NOT IN ('draft', 'published', 'closed') THEN RAISE EXCEPTION 'exam_status_invalid'; END IF;
  IF p_status = 'closed' THEN
    RETURN public._exam_close_paper(p_paper_id, 'manual', actor_id);
  END IF;
  UPDATE public.exam_papers SET status = p_status,
    closed_at = CASE WHEN p_status = 'draft' THEN NULL ELSE closed_at END,
    closed_by = CASE WHEN p_status = 'draft' THEN NULL ELSE closed_by END,
    close_reason = CASE WHEN p_status = 'draft' THEN NULL ELSE close_reason END
  WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  RETURN jsonb_build_object('paperId', p_paper_id, 'status', p_status);
END;
$$;

-- 相容舊後台「收卷」RPC：新版不在 published 期間提前評分，只補做時間到關閉。
CREATE OR REPLACE FUNCTION public.exam_finalize_expired(p_paper_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);n INTEGER;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.exam_papers WHERE id=p_paper_id) THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  n:=public._exam_close_expired_papers();
  RETURN jsonb_build_object('paperId',p_paper_id,'closedExpiredPapers',n,'finalized',0);
END;
$$;

-- ── 取得卷面：明確指定 official / practice ──
DROP FUNCTION IF EXISTS public.exam_get_for_attempt(uuid, uuid, boolean);
CREATE OR REPLACE FUNCTION public.exam_get_for_attempt(
  p_paper_id UUID DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL,
  p_preview BOOLEAN DEFAULT FALSE,
  p_attempt_kind TEXT DEFAULT 'official'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  pr public.exam_papers%ROWTYPE;
  at public.exam_attempts%ROWTYPE;
  official_at public.exam_attempts%ROWTYPE;
  now_ts TIMESTAMPTZ := NOW();
  open_state TEXT;
  want_preview BOOLEAN;
  tester_ok BOOLEAN;
BEGIN
  PERFORM public._exam_close_expired_papers();
  IF p_attempt_kind NOT IN ('official','practice') THEN RAISE EXCEPTION 'exam_attempt_kind_invalid'; END IF;

  IF p_paper_id IS NOT NULL THEN
    SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  ELSE
    SELECT * INTO pr FROM public.exam_papers
    WHERE (is_staff OR (mode = 'live' AND status IN ('published','closed')))
    ORDER BY (mode = 'live') DESC, published_at DESC NULLS LAST, created_at DESC LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','no_paper'); END IF;

  want_preview := COALESCE(p_preview,FALSE) AND is_staff;
  SELECT * INTO official_at FROM public.exam_attempts
  WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='official';
  SELECT * INTO at FROM public.exam_attempts
  WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind=p_attempt_kind;

  IF want_preview THEN open_state := 'preview';
  ELSIF p_attempt_kind = 'practice' THEN
    IF at.id IS NOT NULL THEN open_state := CASE WHEN pr.status='closed' THEN 'closed' ELSE 'open' END;
    ELSIF pr.practice_retake_enabled AND pr.status='published' AND now_ts < pr.close_at
          AND official_at.id IS NOT NULL AND official_at.status <> 'in_progress' THEN open_state := 'practice_ready';
    ELSE open_state := 'not_open'; END IF;
  ELSIF pr.mode='test' THEN
    tester_ok := public._exam_can_access_test(pr.id,actor_id);
    IF is_staff AND pr.status <> 'published' THEN open_state := 'preview';
    ELSIF tester_ok AND pr.status='published' THEN open_state := 'open'; ELSE open_state := 'not_open'; END IF;
  ELSIF at.id IS NOT NULL THEN
    open_state := CASE WHEN at.status='in_progress' THEN 'open' ELSE pr.status END;
  ELSIF pr.status <> 'published' THEN open_state := CASE WHEN is_staff THEN 'preview' ELSE 'not_open' END;
  ELSIF now_ts < pr.open_at THEN open_state := 'not_open';
  ELSIF now_ts >= pr.close_at THEN open_state := 'closed'; ELSE open_state := 'open'; END IF;

  RETURN jsonb_build_object(
    'state',open_state,'preview',want_preview,'attemptKind',p_attempt_kind,
    'paper',jsonb_build_object('id',pr.id,'title',pr.title,'mode',pr.mode,'status',pr.status,
      'openAt',pr.open_at,'closeAt',pr.close_at,'durationMinutes',pr.duration_minutes,
      'totalPoints',pr.total_points,'pledge',pr.pledge,'practiceRetakeEnabled',pr.practice_retake_enabled),
    'attempt',CASE WHEN at.id IS NULL OR want_preview THEN NULL ELSE jsonb_build_object(
      'id',at.id,'status',at.status,'attemptKind',at.attempt_kind,'countsTowardScore',at.attempt_kind='official',
      'startedAt',at.started_at,'deadlineAt',at.deadline_at,'submittedAt',at.submitted_at,
      'secondsRemaining',CASE WHEN at.attempt_kind='practice' THEN NULL ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(at.deadline_at-now_ts))))::int END,
      'layout',at.layout,'paperSnapshot',at.paper_snapshot,
      'savedAnswers',COALESCE((SELECT jsonb_object_agg(question_id::text,response)
        FROM public.exam_answers WHERE attempt_id=at.id AND response IS NOT NULL),'{}'::jsonb),
      'autoScore',at.auto_score,'manualScore',at.manual_score,'totalScore',at.total_score) END,
    'officialAttemptStatus',official_at.status,
    'previewQuestions',CASE WHEN at.id IS NOT NULL AND NOT want_preview THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',q.id,'section',q.section,'position',q.position,
        'points',q.points,'payload',public._exam_public_payload(q.section,q.payload,q.points))
        ORDER BY q.section,q.position) FROM public.exam_questions q WHERE q.paper_id=pr.id),'[]'::jsonb) END
  );
END;
$$;

-- ── 正式首考開始：只找 official ──
CREATE OR REPLACE FUNCTION public.exam_start_attempt(
  p_paper_id UUID, p_pledge_name TEXT, p_reading_team_id UUID DEFAULT NULL, p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID:=public.resolve_quiz_actor(p_actor_id); is_staff BOOLEAN:=public._exam_actor_role(actor_id) IN('admin','pastor');
  pr public.exam_papers%ROWTYPE; at public.exam_attempts%ROWTYPE; now_ts TIMESTAMPTZ:=NOW(); seed TEXT; deadline TIMESTAMPTZ;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='official';
  IF FOUND THEN RETURN jsonb_build_object('attemptId',at.id,'status',at.status,'attemptKind','official','resumed',TRUE,
    'deadlineAt',at.deadline_at,'secondsRemaining',GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(at.deadline_at-now_ts))))::int,
    'layout',at.layout,'paperSnapshot',at.paper_snapshot); END IF;
  IF NOT is_staff THEN
    IF pr.mode='test' THEN
      IF NOT public._exam_can_access_test(pr.id,actor_id) OR pr.status<>'published' THEN RAISE EXCEPTION 'exam_not_open'; END IF;
    ELSIF pr.status<>'published' OR now_ts<pr.open_at OR now_ts>=pr.close_at THEN RAISE EXCEPTION 'exam_not_open'; END IF;
  END IF;
  IF COALESCE(TRIM(p_pledge_name),'')='' THEN RAISE EXCEPTION 'exam_pledge_name_required'; END IF;
  seed:=md5(pr.id::text||':'||actor_id::text||':official:'||COALESCE(pr.published_at,pr.created_at)::text);
  deadline:=LEAST(now_ts+make_interval(mins=>pr.duration_minutes),COALESCE(pr.close_at,now_ts+make_interval(mins=>pr.duration_minutes)));
  INSERT INTO public.exam_attempts(paper_id,user_id,reading_team_id,is_test,status,started_at,deadline_at,
    pledge_name,pledge_agreed_at,pledge_snapshot,layout,paper_snapshot,attempt_kind,attempt_no)
  VALUES(pr.id,actor_id,p_reading_team_id,(pr.mode='test'),'in_progress',now_ts,deadline,TRIM(p_pledge_name),now_ts,
    pr.pledge,public._exam_build_layout(pr.id,seed),public._exam_paper_snapshot(pr.id),'official',1)
  ON CONFLICT DO NOTHING RETURNING * INTO at;
  IF at.id IS NULL THEN SELECT * INTO at FROM public.exam_attempts
    WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='official'; END IF;
  RETURN jsonb_build_object('attemptId',at.id,'status',at.status,'attemptKind','official','resumed',FALSE,
    'deadlineAt',at.deadline_at,'secondsRemaining',GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(at.deadline_at-now_ts))))::int,
    'layout',at.layout,'paperSnapshot',at.paper_snapshot);
END;
$$;

-- ── 建立 / 返回唯一一份重作練習 ──
CREATE OR REPLACE FUNCTION public.exam_start_practice(
  p_paper_id UUID, p_acknowledged BOOLEAN DEFAULT FALSE, p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID:=public.resolve_quiz_actor(p_actor_id); pr public.exam_papers%ROWTYPE;
  official_at public.exam_attempts%ROWTYPE; at public.exam_attempts%ROWTYPE; now_ts TIMESTAMPTZ:=NOW(); seed TEXT;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='practice';
  IF FOUND THEN RETURN jsonb_build_object('attemptId',at.id,'status',at.status,'attemptKind','practice','resumed',TRUE,
    'layout',at.layout,'paperSnapshot',at.paper_snapshot); END IF;
  IF NOT COALESCE(p_acknowledged,FALSE) THEN RAISE EXCEPTION 'exam_practice_ack_required'; END IF;
  IF NOT pr.practice_retake_enabled OR pr.status<>'published' OR now_ts>=pr.close_at THEN RAISE EXCEPTION 'exam_practice_not_open'; END IF;
  SELECT * INTO official_at FROM public.exam_attempts
  WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='official';
  IF NOT FOUND OR official_at.status='in_progress' THEN RAISE EXCEPTION 'exam_practice_requires_official_submission'; END IF;
  seed:=md5(pr.id::text||':'||actor_id::text||':practice:'||COALESCE(pr.published_at,pr.created_at)::text);
  INSERT INTO public.exam_attempts(paper_id,user_id,reading_team_id,is_test,status,started_at,deadline_at,
    pledge_name,pledge_agreed_at,pledge_snapshot,layout,paper_snapshot,attempt_kind,attempt_no,
    official_attempt_id,practice_acknowledged_at)
  VALUES(pr.id,actor_id,official_at.reading_team_id,(pr.mode='test'),'in_progress',now_ts,pr.close_at,
    official_at.pledge_name,now_ts,official_at.pledge_snapshot,public._exam_build_layout(pr.id,seed),
    public._exam_paper_snapshot(pr.id),'practice',1,official_at.id,now_ts)
  ON CONFLICT DO NOTHING RETURNING * INTO at;
  IF at.id IS NULL THEN SELECT * INTO at FROM public.exam_attempts
    WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='practice'; END IF;
  RETURN jsonb_build_object('attemptId',at.id,'status',at.status,'attemptKind','practice','resumed',FALSE,
    'layout',at.layout,'paperSnapshot',at.paper_snapshot);
END;
$$;

-- ── 暫存：practice 每次寫入都重新檢查 paper status/close_at ──
CREATE OR REPLACE FUNCTION public.exam_save_progress(
  p_attempt_id UUID, p_answers JSONB, p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); at public.exam_attempts%ROWTYPE;
  pr public.exam_papers%ROWTYPE; pair RECORD;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND user_id=actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF at.status<>'in_progress' THEN RAISE EXCEPTION 'exam_attempt_locked'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  IF at.attempt_kind='practice' THEN
    IF pr.status<>'published' OR NOW()>=pr.close_at THEN RAISE EXCEPTION 'exam_practice_locked'; END IF;
  ELSIF NOW()>at.deadline_at+INTERVAL '120 seconds' THEN RAISE EXCEPTION 'exam_time_up'; END IF;
  FOR pair IN SELECT key,value FROM jsonb_each(COALESCE(p_answers,'{}'::jsonb)) LOOP
    IF EXISTS(SELECT 1 FROM public.exam_questions q WHERE q.id=pair.key::uuid AND q.paper_id=at.paper_id) THEN
      INSERT INTO public.exam_answers(attempt_id,question_id,section,response)
      SELECT at.id,q.id,q.section,pair.value FROM public.exam_questions q WHERE q.id=pair.key::uuid
      ON CONFLICT(attempt_id,question_id) DO UPDATE SET response=EXCLUDED.response,
        auto_correct=NULL,awarded_points=NULL,updated_at=NOW();
    END IF;
  END LOOP;
  RETURN jsonb_build_object('attemptId',at.id,'saved',TRUE,'attemptKind',at.attempt_kind,
    'secondsRemaining',CASE WHEN at.attempt_kind='practice' THEN NULL ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(at.deadline_at-NOW()))))::int END);
END;
$$;

-- ── 正式送出：published 期間只存答案，不判分 ──
CREATE OR REPLACE FUNCTION public.exam_submit_attempt(
  p_attempt_id UUID, p_answers JSONB, p_reason TEXT DEFAULT 'manual', p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); at public.exam_attempts%ROWTYPE;
  pr public.exam_papers%ROWTYPE; q RECORD; resp JSONB;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND user_id=actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF at.attempt_kind<>'official' THEN RAISE EXCEPTION 'exam_practice_no_submit'; END IF;
  IF at.status<>'in_progress' THEN RETURN jsonb_build_object('attemptId',at.id,'status',at.status,
    'attemptKind','official','alreadySubmitted',TRUE); END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  FOR q IN SELECT id,section FROM public.exam_questions WHERE paper_id=at.paper_id LOOP
    resp:=COALESCE(p_answers->q.id::text,(SELECT response FROM public.exam_answers
      WHERE attempt_id=at.id AND question_id=q.id));
    INSERT INTO public.exam_answers(attempt_id,question_id,section,response,auto_correct,awarded_points)
    VALUES(at.id,q.id,q.section,resp,NULL,NULL)
    ON CONFLICT(attempt_id,question_id) DO UPDATE SET response=EXCLUDED.response,
      auto_correct=NULL,awarded_points=NULL,updated_at=NOW();
  END LOOP;
  UPDATE public.exam_attempts SET status='submitted',submitted_at=NOW(),
    submit_reason=CASE WHEN p_reason IN('manual','timeout','auto_close') THEN p_reason ELSE 'manual' END,
    auto_score=NULL,manual_score=NULL,total_score=NULL WHERE id=at.id;
  RETURN jsonb_build_object('attemptId',at.id,'status','submitted','attemptKind','official',
    'autoScore',NULL,'totalScore',NULL,'alreadySubmitted',FALSE);
END;
$$;

-- practice 的「暫時完成」只記錄時間，不鎖答案。
CREATE OR REPLACE FUNCTION public.exam_mark_practice_complete(p_attempt_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); at public.exam_attempts%ROWTYPE; pr public.exam_papers%ROWTYPE;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND user_id=actor_id AND attempt_kind='practice' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  IF at.status<>'in_progress' OR pr.status<>'published' OR NOW()>=pr.close_at THEN RAISE EXCEPTION 'exam_practice_locked'; END IF;
  UPDATE public.exam_attempts SET practice_completed_at=NOW() WHERE id=at.id;
  RETURN jsonb_build_object('attemptId',at.id,'saved',TRUE,'practiceCompletedAt',NOW());
END;
$$;

-- ── 結果：以 attempt id 明確選正式 / 練習；未公布只回自己的填答 ──
DROP FUNCTION IF EXISTS public.exam_get_my_result(uuid, uuid);
CREATE OR REPLACE FUNCTION public.exam_get_my_result(
  p_paper_id UUID, p_actor_id UUID DEFAULT NULL, p_attempt_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); is_staff BOOLEAN:=public._exam_actor_role(actor_id) IN('admin','pastor');
  at public.exam_attempts%ROWTYPE; pr public.exam_papers%ROWTYPE; published BOOLEAN; show_full BOOLEAN;
BEGIN
  PERFORM public._exam_close_expired_papers();
  IF p_attempt_id IS NOT NULL THEN
    SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND paper_id=p_paper_id
      AND (user_id=actor_id OR is_staff);
  ELSE
    SELECT * INTO at FROM public.exam_attempts WHERE paper_id=p_paper_id AND user_id=actor_id AND attempt_kind='official';
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','no_attempt'); END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  published:=pr.results_published_at IS NOT NULL;
  show_full:=(at.status='graded') AND (published OR is_staff);
  RETURN jsonb_build_object(
    'state',CASE WHEN at.status='in_progress' THEN 'in_progress' WHEN show_full THEN 'graded' ELSE 'submitted' END,
    'attemptId',at.id,'attemptKind',at.attempt_kind,'countsTowardScore',at.attempt_kind='official',
    'resultsPublished',published,'staffPreview',(show_full AND NOT published AND is_staff),
    'reviewVisibility',CASE WHEN show_full THEN 'full_review' ELSE 'responses_only' END,
    'autoScore',CASE WHEN show_full THEN at.auto_score ELSE NULL END,
    'manualScore',CASE WHEN show_full THEN at.manual_score ELSE NULL END,
    'totalScore',CASE WHEN show_full THEN at.total_score ELSE NULL END,
    'submittedAt',at.submitted_at,'practiceCompletedAt',at.practice_completed_at,
    'answers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'questionId',ea.question_id,'section',ea.section,'position',q.position,'points',q.points,
      'sectionRank',public._exam_section_rank(ea.section),'response',ea.response,
      'autoCorrect',CASE WHEN show_full THEN ea.auto_correct ELSE NULL END,
      'awardedPoints',CASE WHEN show_full THEN ea.awarded_points ELSE NULL END,
      'graderComment',CASE WHEN show_full AND at.attempt_kind='official' THEN ea.grader_comment ELSE NULL END,
      'payload',CASE WHEN show_full THEN q.payload ELSE public._exam_public_payload(q.section,q.payload,q.points) END,
      'answerKey',CASE WHEN show_full AND ea.section<>'shortanswer' THEN q.answer_key ELSE NULL END)
      ORDER BY public._exam_section_rank(ea.section),q.position)
      FROM public.exam_answers ea JOIN public.exam_questions q ON q.id=ea.question_id
      WHERE ea.attempt_id=at.id),'[]'::jsonb)
  );
END;
$$;

-- ── 評分防呆：關閉前禁止；正式重算只處理 official ──
CREATE OR REPLACE FUNCTION public.exam_recompute_scores(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); pr public.exam_papers%ROWTYPE; a RECORD;
  n INTEGER:=0; practice_n INTEGER:=0;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.status<>'closed' THEN RAISE EXCEPTION 'exam_scoring_before_close'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;
  IF NOT public._exam_keys_complete(pr.id) THEN RAISE EXCEPTION 'exam_answer_key_incomplete'; END IF;
  FOR a IN SELECT id FROM public.exam_attempts WHERE paper_id=pr.id AND attempt_kind='official'
           AND status IN('submitted','graded') LOOP
    PERFORM public._exam_score_attempt(a.id); n:=n+1;
  END LOOP;
  FOR a IN SELECT id FROM public.exam_attempts WHERE paper_id=pr.id AND attempt_kind='practice'
           AND status IN('submitted','graded') LOOP
    PERFORM public._exam_score_attempt(a.id); practice_n:=practice_n+1;
  END LOOP;
  RETURN jsonb_build_object('paperId',pr.id,'recomputed',n,'practiceRecomputed',practice_n);
END;
$$;

-- ── 正式批改佇列：practice 永不混入 ──
CREATE OR REPLACE FUNCTION public.exam_get_grading_queue(
  p_paper_id UUID,p_filter TEXT DEFAULT 'pending',p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); pr public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  RETURN jsonb_build_object('paperStatus',pr.status,'summary',(
    SELECT jsonb_build_object('total',COUNT(*),'pending',COUNT(*)FILTER(WHERE ea.awarded_points IS NULL),
      'graded',COUNT(*)FILTER(WHERE ea.awarded_points IS NOT NULL))
    FROM public.exam_answers ea JOIN public.exam_attempts a ON a.id=ea.attempt_id
    WHERE a.paper_id=pr.id AND a.attempt_kind='official' AND ea.section='shortanswer'
      AND a.status IN('submitted','graded')),
    'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('answerId',ea.id,'attemptId',a.id,
      'examineeName',p.name,'greatRegion',p.great_region,'pastoralZone',p.pastoral_zone,'smallGroup',p.small_group,
      'position',q.position,'points',q.points,'stem',q.payload->'stem','referenceAnswer',q.payload->'referenceAnswer',
      'rubric',COALESCE(q.payload->'rubric','[]'::jsonb),'response',ea.response,
      'awardedPoints',ea.awarded_points,'graderComment',ea.grader_comment,'gradedAt',ea.graded_at)
      ORDER BY q.position,p.name)
      FROM public.exam_answers ea JOIN public.exam_attempts a ON a.id=ea.attempt_id
      JOIN public.exam_questions q ON q.id=ea.question_id JOIN public.profiles p ON p.id=a.user_id
      WHERE a.paper_id=pr.id AND a.attempt_kind='official' AND ea.section='shortanswer'
        AND a.status IN('submitted','graded') AND(p_filter='all'
          OR(p_filter='pending' AND ea.awarded_points IS NULL)
          OR(p_filter='graded' AND ea.awarded_points IS NOT NULL))),'[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_grade_answer(
  p_answer_id UUID,p_points NUMERIC,p_comment TEXT DEFAULT '',p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); ea public.exam_answers%ROWTYPE;
  at public.exam_attempts%ROWTYPE; pr public.exam_papers%ROWTYPE; max_pts NUMERIC; pending INTEGER;
  short_sum NUMERIC; finalized BOOLEAN:=FALSE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO ea FROM public.exam_answers WHERE id=p_answer_id;
  IF NOT FOUND OR ea.section<>'shortanswer' THEN RAISE EXCEPTION 'exam_answer_not_gradable'; END IF;
  SELECT * INTO at FROM public.exam_attempts WHERE id=ea.attempt_id;
  IF at.attempt_kind<>'official' THEN RAISE EXCEPTION 'exam_practice_not_gradable'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  IF pr.status<>'closed' THEN RAISE EXCEPTION 'exam_grading_before_close'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;
  IF at.auto_score IS NULL AND EXISTS(SELECT 1 FROM public.exam_questions
      WHERE paper_id=at.paper_id AND section<>'shortanswer') THEN RAISE EXCEPTION 'exam_auto_score_pending'; END IF;
  SELECT points INTO max_pts FROM public.exam_questions WHERE id=ea.question_id;
  IF p_points IS NULL OR p_points<0 OR p_points>max_pts THEN RAISE EXCEPTION 'exam_points_out_of_range: 0..%',max_pts; END IF;
  UPDATE public.exam_answers SET awarded_points=p_points,grader_comment=NULLIF(TRIM(p_comment),''),
    grader_id=actor_id,graded_at=NOW() WHERE id=ea.id;
  SELECT COUNT(*)FILTER(WHERE awarded_points IS NULL),COALESCE(SUM(awarded_points),0)
  INTO pending,short_sum FROM public.exam_answers WHERE attempt_id=at.id AND section='shortanswer';
  IF pending=0 THEN UPDATE public.exam_attempts SET status='graded',manual_score=short_sum,
    total_score=COALESCE(auto_score,0)+short_sum WHERE id=at.id; finalized:=TRUE; END IF;
  RETURN jsonb_build_object('answerId',ea.id,'awardedPoints',p_points,
    'attemptFinalized',finalized,'pendingInAttempt',pending);
END;
$$;

-- ── 公布：closed + 只檢查/通知 official ──
CREATE OR REPLACE FUNCTION public.exam_publish_results(p_paper_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id); pr public.exam_papers%ROWTYPE;
  n_unfinished INTEGER;n_notified INTEGER;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.status<>'closed' THEN RAISE EXCEPTION 'exam_results_before_close'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RETURN jsonb_build_object('paperId',pr.id,
    'resultsPublishedAt',pr.results_published_at,'alreadyPublished',TRUE); END IF;
  SELECT COUNT(*) INTO n_unfinished FROM public.exam_attempts
  WHERE paper_id=pr.id AND attempt_kind='official' AND status<>'graded';
  IF n_unfinished>0 THEN RAISE EXCEPTION 'exam_results_incomplete: % 筆正式作答尚未結算',n_unfinished; END IF;
  UPDATE public.exam_papers SET results_published_at=NOW() WHERE id=pr.id;
  INSERT INTO public.exam_notifications(attempt_id,recipient_id,kind)
  SELECT a.id,a.user_id,'graded' FROM public.exam_attempts a
  WHERE a.paper_id=pr.id AND a.attempt_kind='official' AND a.status='graded'
  ON CONFLICT(attempt_id,recipient_id,kind) DO NOTHING;
  GET DIAGNOSTICS n_notified=ROW_COUNT;
  RETURN jsonb_build_object('paperId',pr.id,'resultsPublishedAt',NOW(),'notified',n_notified);
END;
$$;

-- ── 首頁：正式狀態與重作狀態分開回傳 ──
CREATE OR REPLACE FUNCTION public.exam_home_banner(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);is_staff BOOLEAN:=public._exam_actor_role(actor_id) IN('admin','pastor');
  pr public.exam_papers%ROWTYPE;official_at public.exam_attempts%ROWTYPE;practice_at public.exam_attempts%ROWTYPE;
  now_ts TIMESTAMPTZ:=NOW();in_window BOOLEAN;can_enter BOOLEAN;can_practice BOOLEAN;res_ready BOOLEAN;
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam') THEN RETURN NULL; END IF;
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO pr FROM public.exam_papers WHERE announcement_published=TRUE AND(mode='live' OR is_staff)
  ORDER BY(mode='live')DESC,announced_at DESC NULLS LAST,created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO official_at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='official';
  SELECT * INTO practice_at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='practice';
  in_window:=pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL AND now_ts>=pr.open_at AND now_ts<pr.close_at;
  can_enter:=official_at.id IS NULL AND pr.status='published' AND(in_window OR(pr.mode='test' AND is_staff));
  can_practice:=pr.practice_retake_enabled AND pr.status='published' AND now_ts<pr.close_at
    AND official_at.id IS NOT NULL AND official_at.status<>'in_progress';
  res_ready:=official_at.status='graded' AND(pr.results_published_at IS NOT NULL OR is_staff);
  RETURN jsonb_build_object('paperId',pr.id,'title',pr.title,'status',pr.status,'mode',pr.mode,
    'headline',COALESCE(pr.announcement->>'headline',''),'body',COALESCE(pr.announcement->>'body',''),
    'ctaLabel',COALESCE(NULLIF(pr.announcement->>'ctaLabel',''),'進入測驗'),
    'openAt',pr.open_at,'closeAt',pr.close_at,'durationMinutes',pr.duration_minutes,
    'serverNow',now_ts,'inWindow',in_window,'canEnter',can_enter,
    'myAttemptStatus',official_at.status,'officialAttemptId',official_at.id,
    'canReviewOfficial',official_at.id IS NOT NULL AND official_at.status<>'in_progress',
    'canPractice',can_practice,'practiceAttemptId',practice_at.id,'practiceAttemptStatus',practice_at.status,
    'practiceReviewReady',practice_at.id IS NOT NULL AND practice_at.status<>'in_progress',
    'resultReady',res_ready,'myTotalScore',CASE WHEN res_ready THEN official_at.total_score ELSE NULL END);
END;
$$;

-- ── 後台練習紀錄（與正式 roster / grading 分離） ──
CREATE OR REPLACE FUNCTION public.exam_get_practice_records(p_paper_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);actor public.profiles%ROWTYPE;role_c TEXT;
  mreg TEXT[];mzon TEXT[];mgrp TEXT[];
BEGIN
  SELECT * INTO actor FROM public.profiles WHERE id=actor_id;
  role_c:=COALESCE(public.role_code(actor.role_id),'member');
  IF role_c NOT IN('admin','pastor','great_zone_leader','zone_leader','group_leader') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  mreg:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_regions,''),actor.great_region,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mzon:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_zones,''),actor.pastoral_zone,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mgrp:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_groups,''),actor.small_group,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  RETURN jsonb_build_object('records',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'attemptId',a.id,'userId',a.user_id,'name',p.name,'greatRegion',p.great_region,
    'pastoralZone',p.pastoral_zone,'smallGroup',p.small_group,'status',a.status,
    'startedAt',a.started_at,'lastSavedAt',a.updated_at,'practiceCompletedAt',a.practice_completed_at,
    'submittedAt',a.submitted_at,'autoScore',a.auto_score,'totalScore',a.total_score,
    'answeredCount',(SELECT COUNT(*) FROM public.exam_answers ea WHERE ea.attempt_id=a.id AND ea.response IS NOT NULL))
    ORDER BY p.name) FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
    WHERE a.paper_id=p_paper_id AND a.attempt_kind='practice' AND(
      role_c IN('admin','pastor') OR(role_c='great_zone_leader' AND p.great_region=ANY(mreg))
      OR(role_c='zone_leader' AND p.pastoral_zone=ANY(mzon))
      OR(role_c='group_leader' AND p.small_group=ANY(mgrp)))),'[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_get_practice_detail(p_attempt_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);actor public.profiles%ROWTYPE;
  role_c TEXT;at public.exam_attempts%ROWTYPE;owner public.profiles%ROWTYPE;pr public.exam_papers%ROWTYPE;
  mreg TEXT[];mzon TEXT[];mgrp TEXT[];allowed BOOLEAN:=FALSE;show_marks BOOLEAN:=FALSE;
BEGIN
  SELECT * INTO actor FROM public.profiles WHERE id=actor_id;
  role_c:=COALESCE(public.role_code(actor.role_id),'member');
  IF role_c NOT IN('admin','pastor','great_zone_leader','zone_leader','group_leader') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND attempt_kind='practice';
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  SELECT * INTO owner FROM public.profiles WHERE id=at.user_id;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  mreg:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_regions,''),actor.great_region,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mzon:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_zones,''),actor.pastoral_zone,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mgrp:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_groups,''),actor.small_group,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  allowed:=role_c IN('admin','pastor')
    OR(role_c='great_zone_leader' AND owner.great_region=ANY(mreg))
    OR(role_c='zone_leader' AND owner.pastoral_zone=ANY(mzon))
    OR(role_c='group_leader' AND owner.small_group=ANY(mgrp));
  IF NOT allowed THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  show_marks:=pr.results_published_at IS NOT NULL OR role_c IN('admin','pastor');
  RETURN jsonb_build_object('attemptId',at.id,'name',owner.name,'status',at.status,
    'countsTowardScore',FALSE,'autoScore',CASE WHEN show_marks THEN at.auto_score ELSE NULL END,
    'answers',COALESCE((SELECT jsonb_agg(jsonb_build_object('section',ea.section,'position',q.position,
      'stem',q.payload->>'stem','payload',public._exam_public_payload(q.section,q.payload,q.points),'response',ea.response,
      'autoCorrect',CASE WHEN show_marks THEN ea.auto_correct ELSE NULL END,
      'awardedPoints',CASE WHEN show_marks THEN ea.awarded_points ELSE NULL END)
      ORDER BY public._exam_section_rank(ea.section),q.position)
      FROM public.exam_answers ea JOIN public.exam_questions q ON q.id=ea.question_id
      WHERE ea.attempt_id=at.id),'[]'::jsonb));
END;
$$;

-- ── 後台 paper counts 分流 ──
CREATE OR REPLACE FUNCTION public.exam_get_paper_admin(p_paper_id UUID DEFAULT NULL,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);target UUID:=p_paper_id;papers JSONB;result JSONB;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN('admin','pastor') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  PERFORM public._exam_close_expired_papers();
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pr.id,'title',pr.title,'mode',pr.mode,'status',pr.status,
    'pushedFromId',pr.pushed_from_id,'createdAt',pr.created_at,
    'questionCount',(SELECT COUNT(*) FROM public.exam_questions q WHERE q.paper_id=pr.id),
    'attemptCount',(SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id=pr.id),
    'officialAttemptCount',(SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id=pr.id AND a.attempt_kind='official'),
    'practiceAttemptCount',(SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id=pr.id AND a.attempt_kind='practice'))
    ORDER BY pr.created_at DESC),'[]'::jsonb) INTO papers FROM public.exam_papers pr;
  IF target IS NULL THEN SELECT id INTO target FROM public.exam_papers ORDER BY created_at DESC LIMIT 1; END IF;
  IF target IS NULL THEN RETURN jsonb_build_object('papers',papers,'paper',NULL,'questions','[]'::jsonb,'attemptCount',0); END IF;
  SELECT jsonb_build_object('papers',papers,'paper',to_jsonb(pr),
    'attemptCount',(SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id=pr.id),
    'officialAttemptCount',(SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id=pr.id AND a.attempt_kind='official'),
    'practiceAttemptCount',(SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id=pr.id AND a.attempt_kind='practice'),
    'questions',COALESCE((SELECT jsonb_agg(to_jsonb(q)ORDER BY q.section,q.position)
      FROM public.exam_questions q WHERE q.paper_id=pr.id),'[]'::jsonb)) INTO result
  FROM public.exam_papers pr WHERE pr.id=target;
  RETURN COALESCE(result,jsonb_build_object('papers',papers,'paper',NULL,'questions','[]'::jsonb,'attemptCount',0));
END;
$$;

-- ── 正式統計：scoped IDs 從源頭只收 official，所有下游彙整天然排除 practice ──
CREATE OR REPLACE FUNCTION public.exam_get_stats(p_paper_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID:=public.resolve_quiz_actor(p_actor_id); actor public.profiles%ROWTYPE; role_c TEXT;
  pr public.exam_papers%ROWTYPE;mreg TEXT[];mzon TEXT[];mgrp TEXT[];scoped UUID[];scope_label TEXT;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO actor FROM public.profiles WHERE id=actor_id;
  role_c:=COALESCE(public.role_code(actor.role_id),'member');
  IF role_c NOT IN('admin','pastor','great_zone_leader','zone_leader','group_leader') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  mreg:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_regions,''),actor.great_region,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mzon:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_zones,''),actor.pastoral_zone,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mgrp:=ARRAY(SELECT NULLIF(BTRIM(x),'') FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_groups,''),actor.small_group,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  scope_label:=CASE WHEN role_c IN('admin','pastor') THEN 'all' ELSE 'scoped' END;
  SELECT COALESCE(array_agg(a.id),'{}') INTO scoped
  FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
  WHERE a.paper_id=pr.id AND a.attempt_kind='official' AND(
    role_c IN('admin','pastor') OR(role_c='great_zone_leader' AND p.great_region=ANY(mreg))
    OR(role_c='zone_leader' AND p.pastoral_zone=ANY(mzon))
    OR(role_c='group_leader' AND p.small_group=ANY(mgrp)));

  RETURN jsonb_build_object(
    'paper',jsonb_build_object('id',pr.id,'title',pr.title,'status',pr.status,'mode',pr.mode,'totalPoints',pr.total_points),
    'scope',scope_label,
    'overall',(SELECT jsonb_build_object('attempts',COUNT(*),
      'submitted',COUNT(*)FILTER(WHERE a.status IN('submitted','graded')),
      'graded',COUNT(*)FILTER(WHERE a.status='graded'),'inProgress',COUNT(*)FILTER(WHERE a.status='in_progress'),
      'avgAuto',ROUND(AVG(a.auto_score)FILTER(WHERE a.status IN('submitted','graded'))::numeric,1),
      'avgManual',ROUND(AVG(a.manual_score)FILTER(WHERE a.status='graded')::numeric,1),
      'avgTotal',ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1),
      'maxTotal',MAX(a.total_score)FILTER(WHERE a.status='graded'),
      'minTotal',MIN(a.total_score)FILTER(WHERE a.status='graded'))
      FROM public.exam_attempts a WHERE a.id=ANY(scoped)),
    'byRegion',COALESCE((SELECT jsonb_agg(x ORDER BY x.name)FROM(
      SELECT COALESCE(NULLIF(p.great_region,''),'（未分區）')name,COUNT(*)count,
        COUNT(*)FILTER(WHERE a.status='graded')graded,
        ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1)"avgTotal"
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')GROUP BY 1)x),'[]'::jsonb),
    'byZone',COALESCE((SELECT jsonb_agg(x ORDER BY x.region,x.name)FROM(
      SELECT COALESCE(NULLIF(p.great_region,''),'（未分區）')region,
        COALESCE(NULLIF(p.pastoral_zone,''),'（未分牧區）')name,COUNT(*)count,
        COUNT(*)FILTER(WHERE a.status='graded')graded,
        ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1)"avgTotal"
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')GROUP BY 1,2)x),'[]'::jsonb),
    'byGroup',COALESCE((SELECT jsonb_agg(x ORDER BY x.zone,x.name)FROM(
      SELECT COALESCE(NULLIF(p.pastoral_zone,''),'（未分牧區）')zone,
        COALESCE(NULLIF(p.small_group,''),'（未分組）')name,COUNT(*)count,
        COUNT(*)FILTER(WHERE a.status='graded')graded,
        ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1)"avgTotal"
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')GROUP BY 1,2)x),'[]'::jsonb),
    'byTeamSize',COALESCE((SELECT jsonb_agg(jsonb_build_object('label',b.label,'count',b.cnt,
      'graded',b.graded,'avgTotal',b.avg_total)ORDER BY b.sort)FROM(
      SELECT bl.label,bl.sort,COUNT(*)FILTER(WHERE bl.member)cnt,
        COUNT(*)FILTER(WHERE bl.member AND a.status='graded')graded,
        ROUND(AVG(a.total_score)FILTER(WHERE bl.member AND a.status='graded')::numeric,1)avg_total
      FROM public.exam_attempts a CROSS JOIN LATERAL(VALUES
        ('3 人團隊'::text,1,EXISTS(SELECT 1 FROM public.reading_team_members m WHERE m.user_id=a.user_id AND m.division=3)),
        ('6 人團隊'::text,2,EXISTS(SELECT 1 FROM public.reading_team_members m WHERE m.user_id=a.user_id AND m.division=6)),
        ('未組隊'::text,3,NOT EXISTS(SELECT 1 FROM public.reading_team_members m WHERE m.user_id=a.user_id AND m.division IN(3,6)))
      )bl(label,sort,member)WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')
      GROUP BY bl.label,bl.sort)b WHERE b.cnt>0),'[]'::jsonb),
    'teamRanking',COALESCE((SELECT jsonb_agg(jsonb_build_object('teamId',t.team_id,'name',t.name,
      'division',t.division,'rank',t.rnk,'completed',t.completed,'submitted',t.submitted_cnt,
      'teamTotal',t.team_total,'avgTotal',t.avg_total)ORDER BY t.division,t.rnk,t.name)FROM(
      SELECT rt.id team_id,rt.name,rt.division,
        COUNT(a.*)FILTER(WHERE a.status='graded')completed,
        COUNT(a.*)FILTER(WHERE a.status IN('submitted','graded'))submitted_cnt,
        COALESCE(SUM(a.total_score)FILTER(WHERE a.status='graded'),0)team_total,
        ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1)avg_total,
        RANK()OVER(PARTITION BY rt.division ORDER BY COALESCE(SUM(a.total_score)FILTER(WHERE a.status='graded'),0)DESC)rnk
      FROM public.reading_teams rt JOIN public.reading_team_members m ON m.team_id=rt.id
      LEFT JOIN public.exam_attempts a ON a.user_id=m.user_id AND a.id=ANY(scoped)
      GROUP BY rt.id,rt.name,rt.division
      HAVING COUNT(a.*)FILTER(WHERE a.status IN('submitted','graded'))>0)t),'[]'::jsonb),
    'byQuestion',COALESCE((SELECT jsonb_agg(x ORDER BY x."sectionRank",x.position)FROM(
      SELECT q.section,q.position,public._exam_section_rank(q.section)"sectionRank",COUNT(ea.*)answered,
        COUNT(ea.*)FILTER(WHERE ea.auto_correct)correct,
        ROUND((COUNT(ea.*)FILTER(WHERE ea.auto_correct))::numeric/NULLIF(COUNT(ea.*),0),3)"correctRate"
      FROM public.exam_questions q JOIN public.exam_answers ea ON ea.question_id=q.id
      JOIN public.exam_attempts a ON a.id=ea.attempt_id AND a.status IN('submitted','graded')AND a.id=ANY(scoped)
      WHERE q.paper_id=pr.id AND q.section<>'shortanswer' GROUP BY q.id,q.section,q.position)x),'[]'::jsonb),
    'roster',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',a.user_id,'name',p.name,
      'greatRegion',p.great_region,'pastoralZone',p.pastoral_zone,'smallGroup',p.small_group,
      'teamLabel',(SELECT CASE WHEN bool_or(m.division=3)AND bool_or(m.division=6)THEN'3+6 人團隊'
        WHEN bool_or(m.division=3)THEN'3 人團隊' WHEN bool_or(m.division=6)THEN'6 人團隊' ELSE'個人'END
        FROM public.reading_team_members m WHERE m.user_id=a.user_id),
      'status',a.status,'autoScore',a.auto_score,'manualScore',a.manual_score,'totalScore',a.total_score,
      'submittedAt',a.submitted_at)ORDER BY a.total_score DESC NULLS LAST,a.submitted_at ASC)
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')),'[]'::jsonb)
  );
END;
$$;

-- ── RPC grants ──
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_set_status(uuid, text, uuid)',
    'exam_publish(uuid, uuid)',
    'exam_set_auto_score(uuid, boolean, uuid)',
    'exam_set_practice_enabled(uuid, boolean, uuid)',
    'exam_finalize_expired(uuid, uuid)',
    'exam_get_for_attempt(uuid, uuid, boolean, text)',
    'exam_start_attempt(uuid, text, uuid, uuid)',
    'exam_start_practice(uuid, boolean, uuid)',
    'exam_save_progress(uuid, jsonb, uuid)',
    'exam_submit_attempt(uuid, jsonb, text, uuid)',
    'exam_mark_practice_complete(uuid, uuid)',
    'exam_get_my_result(uuid, uuid, uuid)',
    'exam_recompute_scores(uuid, uuid)',
    'exam_get_grading_queue(uuid, text, uuid)',
    'exam_grade_answer(uuid, numeric, text, uuid)',
    'exam_publish_results(uuid, uuid)',
    'exam_home_banner(uuid)',
    'exam_get_practice_records(uuid, uuid)',
    'exam_get_practice_detail(uuid, uuid)',
    'exam_get_paper_admin(uuid, uuid)',
    'exam_get_stats(uuid, uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC',fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role',fn);
  END LOOP;
END $$;

-- ── 每分鐘自動關閉；Supabase 需可啟用 pg_cron ──
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
DO $$
DECLARE old_job BIGINT;
BEGIN
  SELECT jobid INTO old_job FROM cron.job WHERE jobname='exam-auto-close' LIMIT 1;
  IF old_job IS NOT NULL THEN PERFORM cron.unschedule(old_job); END IF;
  PERFORM cron.schedule('exam-auto-close','* * * * *','SELECT public._exam_close_expired_papers();');
END $$;
