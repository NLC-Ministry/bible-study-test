-- 0124_exam_practice_grace_period.sql
-- 正式測驗關閉與重作練習期限分離：
--   1. 關閉只收卷、鎖定、評分 official。
--   2. practice 可持續修改至原活動 close_at + 24 小時，不受 paper.status='closed' 影響。

CREATE OR REPLACE FUNCTION public._exam_practice_close_at(p_paper_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT close_at + INTERVAL '1 day' FROM public.exam_papers WHERE id = p_paper_id;
$$;
REVOKE ALL ON FUNCTION public._exam_practice_close_at(UUID) FROM PUBLIC;

-- 修復 0122 舊關閉流程在寬限期內誤收的 practice；只鎖定 attempt_kind='practice'
-- 且 submit_reason='auto_close' 的紀錄，絕不觸碰正式作答或使用者主動資料。
WITH restored AS (
  UPDATE public.exam_attempts a SET status='in_progress',submitted_at=NULL,submit_reason=NULL,
    auto_score=NULL,manual_score=NULL,total_score=NULL
  FROM public.exam_papers pr
  WHERE a.paper_id=pr.id AND a.attempt_kind='practice' AND a.submit_reason='auto_close'
    AND pr.close_at IS NOT NULL AND NOW()<pr.close_at+INTERVAL '1 day'
  RETURNING a.id
)
UPDATE public.exam_answers ea SET auto_correct=NULL,awarded_points=NULL,updated_at=NOW()
WHERE ea.attempt_id IN(SELECT id FROM restored);

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
    status='closed', closed_at=COALESCE(closed_at,NOW()),
    closed_by=CASE WHEN p_reason='manual' THEN p_closed_by ELSE NULL END,
    close_reason=COALESCE(close_reason,p_reason)
  WHERE id=p_paper_id AND status='published' RETURNING * INTO pr;
  IF NOT FOUND THEN
    SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
    RETURN jsonb_build_object('paperId',pr.id,'status',pr.status,'alreadyClosed',pr.status='closed',
      'finalized',0,'scored',0,'practiceCloseAt',public._exam_practice_close_at(pr.id));
  END IF;

  -- 只收正式作答；重作練習維持 in_progress，直到獨立期限屆滿。
  FOR a IN SELECT id FROM public.exam_attempts
    WHERE paper_id=pr.id AND attempt_kind='official' AND status='in_progress'
    FOR UPDATE SKIP LOCKED LOOP
    INSERT INTO public.exam_answers(attempt_id,question_id,section,response,auto_correct,awarded_points)
    SELECT a.id,q.id,q.section,NULL,NULL,NULL FROM public.exam_questions q WHERE q.paper_id=pr.id
    ON CONFLICT(attempt_id,question_id) DO NOTHING;
    UPDATE public.exam_attempts SET status='submitted',submitted_at=COALESCE(submitted_at,NOW()),
      submit_reason='auto_close',auto_score=NULL,manual_score=NULL,total_score=NULL
    WHERE id=a.id AND status='in_progress';
    n_finalized:=n_finalized+1;
  END LOOP;

  auto_on:=COALESCE(pr.auto_score_enabled,TRUE);
  keys_ok:=public._exam_keys_complete(pr.id);
  IF auto_on AND keys_ok THEN
    FOR a IN SELECT id FROM public.exam_attempts
      WHERE paper_id=pr.id AND attempt_kind='official' AND status IN('submitted','graded') LOOP
      PERFORM public._exam_score_attempt(a.id);
      n_scored:=n_scored+1;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('paperId',pr.id,'status','closed','alreadyClosed',FALSE,
    'finalized',n_finalized,'scored',n_scored,'autoScoreEnabled',auto_on,
    'answerKeysComplete',keys_ok,'practiceCloseAt',public._exam_practice_close_at(pr.id));
END;
$$;
REVOKE ALL ON FUNCTION public._exam_close_paper(UUID, TEXT, UUID) FROM PUBLIC;

-- 原活動時間到時自動關閉正式測驗；寬限期到時再獨立鎖定重作練習。
CREATE OR REPLACE FUNCTION public._exam_close_expired_papers()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE r RECORD;n INTEGER:=0;
BEGIN
  FOR r IN SELECT id FROM public.exam_papers
    WHERE status='published' AND close_at IS NOT NULL AND close_at<=NOW()
    FOR UPDATE SKIP LOCKED LOOP
    PERFORM public._exam_close_paper(r.id,'scheduled',NULL);
    n:=n+1;
  END LOOP;
  UPDATE public.exam_attempts a SET status='submitted',submitted_at=COALESCE(a.submitted_at,NOW()),
    submit_reason='auto_close',practice_completed_at=COALESCE(a.practice_completed_at,NOW())
  FROM public.exam_papers pr
  WHERE a.paper_id=pr.id AND a.attempt_kind='practice' AND a.status='in_progress'
    AND pr.close_at IS NOT NULL AND NOW()>=pr.close_at+INTERVAL '1 day';
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public._exam_close_expired_papers() FROM PUBLIC;

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
  actor_id UUID:=public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN:=public._exam_actor_role(actor_id) IN('admin','pastor');
  pr public.exam_papers%ROWTYPE;at public.exam_attempts%ROWTYPE;official_at public.exam_attempts%ROWTYPE;
  now_ts TIMESTAMPTZ:=NOW();practice_end TIMESTAMPTZ;open_state TEXT;want_preview BOOLEAN;tester_ok BOOLEAN;
BEGIN
  PERFORM public._exam_close_expired_papers();
  IF p_attempt_kind NOT IN('official','practice') THEN RAISE EXCEPTION 'exam_attempt_kind_invalid'; END IF;
  IF p_paper_id IS NOT NULL THEN SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  ELSE SELECT * INTO pr FROM public.exam_papers
    WHERE(is_staff OR(mode='live' AND status IN('published','closed')))
    ORDER BY(mode='live')DESC,published_at DESC NULLS LAST,created_at DESC LIMIT 1; END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','no_paper'); END IF;
  practice_end:=public._exam_practice_close_at(pr.id);
  want_preview:=COALESCE(p_preview,FALSE)AND is_staff;
  SELECT * INTO official_at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='official';
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind=p_attempt_kind;

  IF want_preview THEN open_state:='preview';
  ELSIF p_attempt_kind='practice' THEN
    IF at.id IS NOT NULL THEN open_state:=CASE WHEN now_ts<practice_end AND pr.status IN('published','closed') THEN 'open' ELSE 'closed' END;
    ELSIF pr.practice_retake_enabled AND pr.status IN('published','closed') AND now_ts<practice_end
      AND official_at.id IS NOT NULL AND official_at.status<>'in_progress' THEN open_state:='practice_ready';
    ELSE open_state:='not_open'; END IF;
  ELSIF pr.mode='test' THEN
    tester_ok:=public._exam_can_access_test(pr.id,actor_id);
    IF is_staff AND pr.status<>'published' THEN open_state:='preview';
    ELSIF tester_ok AND pr.status='published' THEN open_state:='open'; ELSE open_state:='not_open'; END IF;
  ELSIF at.id IS NOT NULL THEN open_state:=CASE WHEN at.status='in_progress' THEN 'open' ELSE pr.status END;
  ELSIF pr.status<>'published' THEN open_state:=CASE WHEN is_staff THEN 'preview' ELSE 'not_open' END;
  ELSIF now_ts<pr.open_at THEN open_state:='not_open';
  ELSIF now_ts>=pr.close_at THEN open_state:='closed'; ELSE open_state:='open'; END IF;

  RETURN jsonb_build_object('state',open_state,'preview',want_preview,'attemptKind',p_attempt_kind,
    'paper',jsonb_build_object('id',pr.id,'title',pr.title,'mode',pr.mode,'status',pr.status,
      'openAt',pr.open_at,'closeAt',pr.close_at,'practiceCloseAt',practice_end,
      'durationMinutes',pr.duration_minutes,'totalPoints',pr.total_points,'pledge',pr.pledge,
      'practiceRetakeEnabled',pr.practice_retake_enabled),
    'attempt',CASE WHEN at.id IS NULL OR want_preview THEN NULL ELSE jsonb_build_object(
      'id',at.id,'status',at.status,'attemptKind',at.attempt_kind,'countsTowardScore',at.attempt_kind='official',
      'startedAt',at.started_at,'deadlineAt',at.deadline_at,'submittedAt',at.submitted_at,
      'secondsRemaining',CASE WHEN at.attempt_kind='practice' THEN NULL ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(at.deadline_at-now_ts))))::int END,
      'layout',at.layout,'paperSnapshot',at.paper_snapshot,
      'savedAnswers',COALESCE((SELECT jsonb_object_agg(question_id::text,response) FROM public.exam_answers
        WHERE attempt_id=at.id AND response IS NOT NULL),'{}'::jsonb),
      'autoScore',at.auto_score,'manualScore',at.manual_score,'totalScore',at.total_score) END,
    'officialAttemptStatus',official_at.status,
    'previewQuestions',CASE WHEN at.id IS NOT NULL AND NOT want_preview THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',q.id,'section',q.section,'position',q.position,
        'points',q.points,'payload',public._exam_public_payload(q.section,q.payload,q.points))
      ORDER BY q.section,q.position)FROM public.exam_questions q WHERE q.paper_id=pr.id),'[]'::jsonb)END);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_start_practice(
  p_paper_id UUID,p_acknowledged BOOLEAN DEFAULT FALSE,p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);pr public.exam_papers%ROWTYPE;
  official_at public.exam_attempts%ROWTYPE;at public.exam_attempts%ROWTYPE;now_ts TIMESTAMPTZ:=NOW();
  practice_end TIMESTAMPTZ;seed TEXT;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  practice_end:=public._exam_practice_close_at(pr.id);
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='practice';
  IF FOUND THEN RETURN jsonb_build_object('attemptId',at.id,'status',at.status,'attemptKind','practice',
    'resumed',TRUE,'layout',at.layout,'paperSnapshot',at.paper_snapshot,'practiceCloseAt',practice_end); END IF;
  IF NOT COALESCE(p_acknowledged,FALSE) THEN RAISE EXCEPTION 'exam_practice_ack_required'; END IF;
  IF NOT pr.practice_retake_enabled OR pr.status NOT IN('published','closed') OR now_ts>=practice_end THEN
    RAISE EXCEPTION 'exam_practice_not_open'; END IF;
  SELECT * INTO official_at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='official';
  IF NOT FOUND OR official_at.status='in_progress' THEN RAISE EXCEPTION 'exam_practice_requires_official_submission'; END IF;
  seed:=md5(pr.id::text||':'||actor_id::text||':practice:'||COALESCE(pr.published_at,pr.created_at)::text);
  INSERT INTO public.exam_attempts(paper_id,user_id,reading_team_id,is_test,status,started_at,deadline_at,
    pledge_name,pledge_agreed_at,pledge_snapshot,layout,paper_snapshot,attempt_kind,attempt_no,
    official_attempt_id,practice_acknowledged_at)
  VALUES(pr.id,actor_id,official_at.reading_team_id,(pr.mode='test'),'in_progress',now_ts,practice_end,
    official_at.pledge_name,now_ts,official_at.pledge_snapshot,public._exam_build_layout(pr.id,seed),
    public._exam_paper_snapshot(pr.id),'practice',1,official_at.id,now_ts)
  ON CONFLICT DO NOTHING RETURNING * INTO at;
  IF at.id IS NULL THEN SELECT * INTO at FROM public.exam_attempts
    WHERE paper_id=pr.id AND user_id=actor_id AND attempt_kind='practice'; END IF;
  RETURN jsonb_build_object('attemptId',at.id,'status',at.status,'attemptKind','practice','resumed',FALSE,
    'layout',at.layout,'paperSnapshot',at.paper_snapshot,'practiceCloseAt',practice_end);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_save_progress(
  p_attempt_id UUID,p_answers JSONB,p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);at public.exam_attempts%ROWTYPE;
  pr public.exam_papers%ROWTYPE;pair RECORD;practice_end TIMESTAMPTZ;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND user_id=actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF at.status<>'in_progress' THEN RAISE EXCEPTION 'exam_attempt_locked'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  IF at.attempt_kind='practice' THEN
    practice_end:=public._exam_practice_close_at(pr.id);
    IF pr.status NOT IN('published','closed') OR NOW()>=practice_end THEN RAISE EXCEPTION 'exam_practice_locked'; END IF;
  ELSIF pr.status<>'published' OR NOW()>at.deadline_at+INTERVAL '120 seconds' THEN
    RAISE EXCEPTION 'exam_time_up';
  END IF;
  FOR pair IN SELECT key,value FROM jsonb_each(COALESCE(p_answers,'{}'::jsonb)) LOOP
    IF EXISTS(SELECT 1 FROM public.exam_questions q WHERE q.id=pair.key::uuid AND q.paper_id=at.paper_id)THEN
      INSERT INTO public.exam_answers(attempt_id,question_id,section,response)
      SELECT at.id,q.id,q.section,pair.value FROM public.exam_questions q WHERE q.id=pair.key::uuid
      ON CONFLICT(attempt_id,question_id)DO UPDATE SET response=EXCLUDED.response,
        auto_correct=NULL,awarded_points=NULL,updated_at=NOW();
    END IF;
  END LOOP;
  RETURN jsonb_build_object('attemptId',at.id,'saved',TRUE,'attemptKind',at.attempt_kind,
    'practiceCloseAt',CASE WHEN at.attempt_kind='practice' THEN practice_end ELSE NULL END,
    'secondsRemaining',CASE WHEN at.attempt_kind='practice' THEN NULL ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(at.deadline_at-NOW()))))::int END);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_mark_practice_complete(p_attempt_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);at public.exam_attempts%ROWTYPE;
  pr public.exam_papers%ROWTYPE;practice_end TIMESTAMPTZ;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO at FROM public.exam_attempts WHERE id=p_attempt_id AND user_id=actor_id AND attempt_kind='practice' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=at.paper_id;
  practice_end:=public._exam_practice_close_at(pr.id);
  IF at.status<>'in_progress' OR pr.status NOT IN('published','closed') OR NOW()>=practice_end THEN
    RAISE EXCEPTION 'exam_practice_locked'; END IF;
  UPDATE public.exam_attempts SET practice_completed_at=NOW() WHERE id=at.id;
  RETURN jsonb_build_object('attemptId',at.id,'saved',TRUE,'practiceCompletedAt',NOW(),'practiceCloseAt',practice_end);
END;
$$;

-- 0123 的多試卷摘要同步採用練習獨立期限。
CREATE OR REPLACE FUNCTION public._exam_member_paper_summary(p_paper_id UUID,p_actor_id UUID,p_is_staff BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE pr public.exam_papers%ROWTYPE;official_at public.exam_attempts%ROWTYPE;practice_at public.exam_attempts%ROWTYPE;
  now_ts TIMESTAMPTZ:=NOW();practice_end TIMESTAMPTZ;in_window BOOLEAN:=FALSE;
  can_enter BOOLEAN:=FALSE;can_practice BOOLEAN:=FALSE;result_ready BOOLEAN:=FALSE;
BEGIN
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  practice_end:=public._exam_practice_close_at(pr.id);
  SELECT * INTO official_at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=p_actor_id AND attempt_kind='official';
  SELECT * INTO practice_at FROM public.exam_attempts WHERE paper_id=pr.id AND user_id=p_actor_id AND attempt_kind='practice';
  in_window:=pr.open_at IS NOT NULL AND pr.close_at IS NOT NULL AND now_ts>=pr.open_at AND now_ts<pr.close_at;
  can_enter:=official_at.id IS NULL AND pr.status='published' AND(in_window OR(pr.mode='test' AND p_is_staff));
  can_practice:=pr.practice_retake_enabled AND pr.status IN('published','closed') AND now_ts<practice_end
    AND official_at.id IS NOT NULL AND official_at.status<>'in_progress';
  result_ready:=official_at.status='graded' AND(pr.results_published_at IS NOT NULL OR p_is_staff);
  RETURN jsonb_build_object('paperId',pr.id,'title',pr.title,'status',pr.status,'mode',pr.mode,
    'headline',COALESCE(pr.announcement->>'headline',''),'body',COALESCE(pr.announcement->>'body',''),
    'ctaLabel',COALESCE(NULLIF(pr.announcement->>'ctaLabel',''),'進入測驗'),'openAt',pr.open_at,
    'closeAt',pr.close_at,'practiceCloseAt',practice_end,'durationMinutes',pr.duration_minutes,
    'serverNow',now_ts,'inWindow',in_window,'canEnter',can_enter,'myAttemptStatus',official_at.status,
    'officialAttemptId',official_at.id,'canReviewOfficial',official_at.id IS NOT NULL AND official_at.status<>'in_progress',
    'canPractice',can_practice,'practiceAttemptId',practice_at.id,'practiceAttemptStatus',practice_at.status,
    'practiceReviewReady',practice_at.id IS NOT NULL,'resultReady',result_ready,
    'resultsPublishedAt',pr.results_published_at,
    'myTotalScore',CASE WHEN result_ready THEN official_at.total_score ELSE NULL END);
END;
$$;
REVOKE ALL ON FUNCTION public._exam_member_paper_summary(UUID,UUID,BOOLEAN) FROM PUBLIC;

-- 舊版首頁單卡片 RPC 的相容層也同步新規則。
CREATE OR REPLACE FUNCTION public.exam_home_banner(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID:=public.resolve_quiz_actor(p_actor_id);is_staff BOOLEAN:=public._exam_actor_role(actor_id)IN('admin','pastor');
  paper_id UUID;
BEGIN
  IF NOT public.is_feature_enabled('speed_reading_exam')THEN RETURN NULL; END IF;
  PERFORM public._exam_close_expired_papers();
  SELECT pr.id INTO paper_id FROM public.exam_papers pr WHERE pr.announcement_published=TRUE AND(pr.mode='live' OR is_staff)
  ORDER BY(pr.mode='live')DESC,pr.announced_at DESC NULLS LAST,pr.created_at DESC LIMIT 1;
  IF paper_id IS NULL THEN RETURN NULL; END IF;
  RETURN public._exam_member_paper_summary(paper_id,actor_id,is_staff);
END;
$$;

-- 函式行為由專案測試驗證；不使用 pg_get_functiondef 的文字 ASSERT，
-- 避免 PostgreSQL 版本或格式化差異造成正確 migration 被誤判回滾。
