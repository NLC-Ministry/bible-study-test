-- ============================================================================
-- 0146_exam_online_grading.sql — 線上簡答批改頁（grade.html）
--
-- 設計文件：docs/exam-online-grading-design.md
--
--   · 大測驗第六大題（簡答題）的人工批改，改成「一位批改人員一條連結、點開就能
--     線上改考卷」的獨立網頁。批改人員 = 一般 NLC 會友，不需 admin/pastor 角色；
--     能改哪些卷完全看 exam_grading_assignments（後台指派）。
--   · 一張卷只由一個人改；換人 = 對「還沒改完」的卷重新指派（改派時清該卷草稿）。
--   · 三層防遺失：L1 localStorage（前端）／L2 伺服器草稿 exam_grading_drafts／
--     L3 正式送出 exam_grade_attempt(_bulk)。樂觀鎖用 _exam_attempt_grading_rev。
--   · 只有整卷評語 exam_attempts.grader_overall_comment；不做單題短評。
--   · 成績公布後（exam_papers.results_published_at）一律 exam_results_locked。
--
-- 部署：Supabase SQL editor 執行，或 `supabase db push`。
--       nlc-data 的 EXAM_RPC_FUNCTIONS 需加以下 7 支、EXAM_ADMIN_RPC_FUNCTIONS 加
--       exam_list_gradable_attempts / exam_assign_attempts，並重新部署 Edge Function。
-- ============================================================================

-- ── 新表 ────────────────────────────────────────────────────────────────────

-- 一張 attempt 指派給哪位批改人員（一 attempt 一列；換人 = UPDATE grader_id）
CREATE TABLE IF NOT EXISTS public.exam_grading_assignments (
  attempt_id  UUID PRIMARY KEY REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  paper_id    UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  grader_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS exam_grading_assignments_paper_grader_idx
  ON public.exam_grading_assignments (paper_id, grader_id);
ALTER TABLE public.exam_grading_assignments ENABLE ROW LEVEL SECURITY;

-- L2 伺服器草稿（一 attempt 一份，因為只有一個人改）
CREATE TABLE IF NOT EXISTS public.exam_grading_drafts (
  attempt_id UUID PRIMARY KEY REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  grader_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.exam_grading_drafts ENABLE ROW LEVEL SECURITY;

-- 整卷評語（唯一的評語欄；個別題目的講評也寫這裡）
ALTER TABLE public.exam_attempts
  ADD COLUMN IF NOT EXISTS grader_overall_comment TEXT;

-- ── helper ─────────────────────────────────────────────────────────────────

-- 樂觀鎖版本：以「簡答題作答的最後更新時間」與「attempt 最後更新時間」較大者
-- 換算成毫秒。草稿寫入刻意不算進來 —— 同一位批改人員反覆存草稿不會把自己鎖死。
CREATE OR REPLACE FUNCTION public._exam_attempt_grading_rev(p_attempt_id UUID)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(
    COALESCE((SELECT (EXTRACT(EPOCH FROM MAX(ea.updated_at)) * 1000)::bigint
              FROM public.exam_answers ea
              WHERE ea.attempt_id = p_attempt_id AND ea.section = 'shortanswer'), 0),
    COALESCE((SELECT (EXTRACT(EPOCH FROM a.updated_at) * 1000)::bigint
              FROM public.exam_attempts a WHERE a.id = p_attempt_id), 0)
  );
$$;
REVOKE ALL ON FUNCTION public._exam_attempt_grading_rev(uuid) FROM PUBLIC;

-- 這位 actor 能不能改這張卷：admin/pastor 一律可；否則要有指派。
CREATE OR REPLACE FUNCTION public._exam_actor_can_grade(p_attempt_id UUID, p_actor_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT public._exam_actor_role(p_actor_id) IN ('admin', 'pastor')
      OR EXISTS (SELECT 1 FROM public.exam_grading_assignments ga
                 WHERE ga.attempt_id = p_attempt_id AND ga.grader_id = p_actor_id);
$$;
REVOKE ALL ON FUNCTION public._exam_actor_can_grade(uuid, uuid) FROM PUBLIC;

-- 內部：把一張卷的簡答評分寫進去（exam_grade_attempt 與 _bulk 共用）。
-- 呼叫端負責權限、鎖定、rev 檢查；這裡只驗分數範圍與「涵蓋所有簡答題」。
CREATE OR REPLACE FUNCTION public._exam_apply_attempt_grades(
  p_attempt_id      UUID,
  p_grades          JSONB,
  p_overall_comment TEXT,
  p_grader_id       UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  at            public.exam_attempts%ROWTYPE;
  pr            public.exam_papers%ROWTYPE;
  short_total   INTEGER;
  grade_count   INTEGER;
  valid_count   INTEGER;
  pending_short INTEGER;
  short_sum     NUMERIC;
  has_auto_sec  BOOLEAN;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF at.attempt_kind <> 'official' OR at.status NOT IN ('submitted', 'graded') THEN
    RAISE EXCEPTION 'exam_grading_attempt_not_gradable';
  END IF;

  SELECT * INTO pr FROM public.exam_papers WHERE id = at.paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  IF jsonb_typeof(COALESCE(p_grades, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'exam_grading_invalid';
  END IF;

  SELECT COUNT(*) INTO short_total
  FROM public.exam_questions q WHERE q.paper_id = at.paper_id AND q.section = 'shortanswer';

  CREATE TEMP TABLE _exam_grade_in (
    question_id UUID PRIMARY KEY,
    points      NUMERIC NOT NULL
  ) ON COMMIT DROP;

  BEGIN
    INSERT INTO _exam_grade_in (question_id, points)
    SELECT (item->>'questionId')::uuid, (item->>'points')::numeric
    FROM jsonb_array_elements(p_grades) item;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'exam_grading_invalid';
    WHEN invalid_text_representation OR numeric_value_out_of_range OR not_null_violation THEN
      RAISE EXCEPTION 'exam_grading_invalid';
  END;

  SELECT COUNT(*) INTO grade_count FROM _exam_grade_in;
  IF grade_count <> short_total THEN
    DROP TABLE _exam_grade_in;
    RAISE EXCEPTION 'exam_grading_incomplete';
  END IF;

  SELECT COUNT(*) INTO valid_count
  FROM _exam_grade_in g
  JOIN public.exam_questions q ON q.id = g.question_id
    AND q.paper_id = at.paper_id AND q.section = 'shortanswer'
  WHERE g.points >= 0 AND g.points <= q.points;
  IF valid_count <> grade_count THEN
    DROP TABLE _exam_grade_in;
    RAISE EXCEPTION 'exam_grading_out_of_range';
  END IF;

  -- 一~五大題若還沒自動計分，簡答結算會算錯 total → 擋下（比照 0125）
  SELECT EXISTS (SELECT 1 FROM public.exam_questions q
                 WHERE q.paper_id = at.paper_id AND q.section <> 'shortanswer')
    INTO has_auto_sec;
  IF has_auto_sec AND at.auto_score IS NULL THEN
    DROP TABLE _exam_grade_in;
    RAISE EXCEPTION 'exam_auto_score_pending';
  END IF;

  INSERT INTO public.exam_answers (attempt_id, question_id, section, awarded_points, grader_id, graded_at, updated_at)
  SELECT at.id, g.question_id, 'shortanswer', g.points, p_grader_id, NOW(), NOW()
  FROM _exam_grade_in g
  ON CONFLICT (attempt_id, question_id) DO UPDATE
    SET awarded_points = EXCLUDED.awarded_points,
        grader_id      = EXCLUDED.grader_id,
        graded_at      = NOW(),
        updated_at     = NOW();

  DROP TABLE _exam_grade_in;

  SELECT COUNT(*) FILTER (WHERE awarded_points IS NULL), COALESCE(SUM(awarded_points), 0)
  INTO pending_short, short_sum
  FROM public.exam_answers WHERE attempt_id = at.id AND section = 'shortanswer';

  UPDATE public.exam_attempts SET
    grader_overall_comment = NULLIF(BTRIM(COALESCE(p_overall_comment, '')), ''),
    manual_score = CASE WHEN pending_short = 0 THEN short_sum ELSE manual_score END,
    total_score  = CASE WHEN pending_short = 0 THEN COALESCE(auto_score, 0) + short_sum ELSE total_score END,
    status       = CASE WHEN pending_short = 0 THEN 'graded' ELSE status END,
    updated_at   = NOW()
  WHERE id = at.id;

  DELETE FROM public.exam_grading_drafts WHERE attempt_id = at.id;

  RETURN jsonb_build_object(
    'attemptId', at.id,
    'status', CASE WHEN pending_short = 0 THEN 'graded' ELSE at.status END,
    'manualScore', CASE WHEN pending_short = 0 THEN short_sum ELSE NULL END,
    'totalScore', CASE WHEN pending_short = 0 THEN COALESCE(at.auto_score, 0) + short_sum ELSE NULL END,
    'rev', public._exam_attempt_grading_rev(at.id)
  );
END;
$$;
REVOKE ALL ON FUNCTION public._exam_apply_attempt_grades(uuid, jsonb, text, uuid) FROM PUBLIC;

-- ── 後台：列出可指派的作答者 ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_list_gradable_attempts(
  p_paper_id UUID,
  p_filter   JSONB DEFAULT '{}'::jsonb,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  f_zone   TEXT := NULLIF(BTRIM(COALESCE(p_filter->>'zone', '')), '');
  f_status TEXT := COALESCE(NULLIF(p_filter->>'status', ''), 'all');   -- pending | graded | all
  f_assign TEXT := COALESCE(NULLIF(p_filter->>'assigned', ''), 'all'); -- yes | no | all
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = p_paper_id) THEN
    RAISE EXCEPTION 'exam_paper_not_found';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.pastoral_zone, t.small_group, t.name)
    FROM (
      SELECT
        a.id                       AS "attemptId",
        p.name                     AS name,
        p.great_region             AS "greatRegion",
        p.pastoral_zone            AS "pastoralZone",
        p.small_group              AS "smallGroup",
        p.pastoral_zone            AS pastoral_zone,
        p.small_group              AS small_group,
        a.submitted_at             AS "submittedAt",
        a.status                   AS status,
        (SELECT COUNT(*) FROM public.exam_questions q
           WHERE q.paper_id = a.paper_id AND q.section = 'shortanswer')             AS "shortTotal",
        (SELECT COUNT(*) FROM public.exam_answers ea
           WHERE ea.attempt_id = a.id AND ea.section = 'shortanswer'
             AND ea.awarded_points IS NOT NULL)                                     AS "shortGraded",
        ga.grader_id               AS "assignedGraderId",
        gp.name                    AS "assignedGraderName"
      FROM public.exam_attempts a
      JOIN public.profiles p ON p.id = a.user_id
      LEFT JOIN public.exam_grading_assignments ga ON ga.attempt_id = a.id
      LEFT JOIN public.profiles gp ON gp.id = ga.grader_id
      WHERE a.paper_id = p_paper_id
        AND a.attempt_kind = 'official'
        AND a.status IN ('submitted', 'graded')
        AND (f_zone IS NULL OR p.pastoral_zone = f_zone)
        AND (f_status = 'all'
             OR (f_status = 'graded'  AND a.status = 'graded')
             OR (f_status = 'pending' AND a.status <> 'graded'))
        AND (f_assign = 'all'
             OR (f_assign = 'yes' AND ga.grader_id IS NOT NULL)
             OR (f_assign = 'no'  AND ga.grader_id IS NULL))
    ) t
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_list_gradable_attempts(uuid, jsonb, uuid) FROM PUBLIC;

-- ── 後台：搜尋要指派的批改人員（姓名 / email）─────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_search_grader_candidates(
  p_query    TEXT,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  q        TEXT := BTRIM(COALESCE(p_query, ''));
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF length(q) < 1 THEN RETURN '[]'::jsonb; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'email', p.email,
      'pastoralZone', p.pastoral_zone, 'smallGroup', p.small_group
    ) ORDER BY p.name)
    FROM (
      SELECT * FROM public.profiles
      WHERE is_active IS DISTINCT FROM FALSE
        AND (name ILIKE '%' || q || '%' OR email ILIKE '%' || q || '%')
      ORDER BY name
      LIMIT 20
    ) p
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_search_grader_candidates(text, uuid) FROM PUBLIC;

-- ── 後台：指派 / 改派 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_assign_attempts(
  p_paper_id          UUID,
  p_attempt_ids       UUID[],
  p_grader_profile_id UUID,
  p_force             BOOLEAN DEFAULT FALSE,
  p_actor_id          UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id  UUID := public.resolve_quiz_actor(p_actor_id);
  aid       UUID;
  at_status TEXT;
  at_paper  UUID;
  assigned  UUID[] := '{}';
  skipped   UUID[] := '{}';
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = p_paper_id) THEN
    RAISE EXCEPTION 'exam_paper_not_found';
  END IF;
  IF p_grader_profile_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_grader_profile_id) THEN
    RAISE EXCEPTION 'exam_grader_not_found';
  END IF;
  IF p_attempt_ids IS NULL OR array_length(p_attempt_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'exam_grading_invalid';
  END IF;

  FOREACH aid IN ARRAY p_attempt_ids LOOP
    SELECT a.status, a.paper_id INTO at_status, at_paper
    FROM public.exam_attempts a
    WHERE a.id = aid AND a.attempt_kind = 'official';

    IF at_status IS NULL OR at_paper <> p_paper_id OR at_status NOT IN ('submitted', 'graded') THEN
      skipped := skipped || aid;
      CONTINUE;
    END IF;
    -- 已改完的卷預設不進改派流程（避免打亂已完成的結果）
    IF at_status = 'graded' AND NOT p_force THEN
      skipped := skipped || aid;
      CONTINUE;
    END IF;

    INSERT INTO public.exam_grading_assignments (attempt_id, paper_id, grader_id, assigned_by, assigned_at)
    VALUES (aid, p_paper_id, p_grader_profile_id, actor_id, NOW())
    ON CONFLICT (attempt_id) DO UPDATE
      SET grader_id = EXCLUDED.grader_id, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW();

    -- 改派 → 清掉前一位改到一半的草稿
    DELETE FROM public.exam_grading_drafts WHERE attempt_id = aid;
    assigned := assigned || aid;
  END LOOP;

  RETURN jsonb_build_object(
    'assigned', to_jsonb(assigned),
    'skipped',  to_jsonb(skipped),
    'graderId', p_grader_profile_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.exam_assign_attempts(uuid, uuid[], uuid, boolean, uuid) FROM PUBLIC;

-- ── 批改頁：我的工作區（名單）──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_get_grading_workspace(
  p_paper_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'exam_forbidden'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;

  IF NOT is_staff AND NOT EXISTS (
    SELECT 1 FROM public.exam_grading_assignments ga
    WHERE ga.paper_id = p_paper_id AND ga.grader_id = actor_id
  ) THEN
    RAISE EXCEPTION 'exam_grading_not_assigned';
  END IF;

  RETURN jsonb_build_object(
    'paper', jsonb_build_object(
      'id', pr.id, 'title', pr.title,
      'resultsPublished', pr.results_published_at IS NOT NULL,
      'shortCount', (SELECT COUNT(*) FROM public.exam_questions q
                     WHERE q.paper_id = pr.id AND q.section = 'shortanswer'),
      'shortPoints', (SELECT COALESCE(SUM(q.points), 0) FROM public.exam_questions q
                      WHERE q.paper_id = pr.id AND q.section = 'shortanswer')
    ),
    'roster', COALESCE((
      SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.pastoral_zone, t.small_group, t.name)
      FROM (
        SELECT
          a.id            AS "attemptId",
          p.name          AS name,
          p.great_region  AS "greatRegion",
          p.pastoral_zone AS "pastoralZone",
          p.small_group   AS "smallGroup",
          p.pastoral_zone AS pastoral_zone,
          p.small_group   AS small_group,
          a.submitted_at  AS "submittedAt",
          (SELECT COUNT(*) FROM public.exam_answers ea
             WHERE ea.attempt_id = a.id AND ea.section = 'shortanswer')             AS "shortTotal",
          (SELECT COUNT(*) FROM public.exam_answers ea
             WHERE ea.attempt_id = a.id AND ea.section = 'shortanswer'
               AND ea.awarded_points IS NOT NULL)                                   AS "shortGraded",
          (SELECT COUNT(*) FROM public.exam_questions q
             WHERE q.paper_id = a.paper_id AND q.section = 'shortanswer')           AS "shortQuestions",
          a.status        AS "attemptStatus",
          EXISTS (SELECT 1 FROM public.exam_grading_drafts d WHERE d.attempt_id = a.id) AS "hasDraft",
          public._exam_attempt_grading_rev(a.id) AS rev
        FROM public.exam_grading_assignments ga
        JOIN public.exam_attempts a ON a.id = ga.attempt_id
        JOIN public.profiles p ON p.id = a.user_id
        WHERE ga.paper_id = p_paper_id
          AND (is_staff OR ga.grader_id = actor_id)
      ) t
    ), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.exam_get_grading_workspace(uuid, uuid) FROM PUBLIC;

-- ── 批改頁：單卷 ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_get_grading_sheet(
  p_attempt_id UUID,
  p_actor_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  at       public.exam_attempts%ROWTYPE;
  pr       public.exam_papers%ROWTYPE;
  ex       public.profiles%ROWTYPE;
  dft      public.exam_grading_drafts%ROWTYPE;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'exam_forbidden'; END IF;
  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF NOT public._exam_actor_can_grade(p_attempt_id, actor_id) THEN
    RAISE EXCEPTION 'exam_grading_not_assigned';
  END IF;

  SELECT * INTO pr FROM public.exam_papers WHERE id = at.paper_id;
  SELECT * INTO ex FROM public.profiles WHERE id = at.user_id;
  SELECT * INTO dft FROM public.exam_grading_drafts WHERE attempt_id = at.id;

  RETURN jsonb_build_object(
    'attemptId', at.id,
    'attemptStatus', at.status,
    'resultsPublished', pr.results_published_at IS NOT NULL,
    'rev', public._exam_attempt_grading_rev(at.id),
    'overallComment', at.grader_overall_comment,
    'draft', CASE WHEN dft.attempt_id IS NULL THEN NULL
                  ELSE jsonb_build_object('payload', dft.payload, 'savedAt', dft.updated_at) END,
    'examinee', jsonb_build_object(
      'name', ex.name, 'greatRegion', ex.great_region,
      'pastoralZone', ex.pastoral_zone, 'smallGroup', ex.small_group,
      'submittedAt', at.submitted_at
    ),
    'paperTitle', pr.title,
    'questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'questionId', q.id,
        'answerId', ea.id,
        'position', q.position,
        'points', q.points,
        'stem', q.payload -> 'stem',
        'referenceAnswer', q.payload -> 'referenceAnswer',
        'rubric', COALESCE(q.payload -> 'rubric', '[]'::jsonb),
        'response', CASE WHEN ea.response IS NULL OR jsonb_typeof(ea.response) = 'null'
                         THEN NULL ELSE ea.response #>> '{}' END,
        'awardedPoints', ea.awarded_points
      ) ORDER BY q.position)
      FROM public.exam_questions q
      LEFT JOIN public.exam_answers ea ON ea.attempt_id = at.id AND ea.question_id = q.id
      WHERE q.paper_id = at.paper_id AND q.section = 'shortanswer'
    ), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.exam_get_grading_sheet(uuid, uuid) FROM PUBLIC;

-- ── 批改頁：L2 存草稿 ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_save_grading_draft(
  p_attempt_id UUID,
  p_payload    JSONB,
  p_base_rev   BIGINT DEFAULT 0,
  p_actor_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  cur_rev  BIGINT;
  pub      BOOLEAN;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'exam_forbidden'; END IF;
  IF NOT public._exam_actor_can_grade(p_attempt_id, actor_id) THEN
    RAISE EXCEPTION 'exam_grading_not_assigned';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_attempts WHERE id = p_attempt_id) THEN
    RAISE EXCEPTION 'exam_attempt_not_found';
  END IF;

  SELECT (p.results_published_at IS NOT NULL) INTO pub
  FROM public.exam_papers p
  JOIN public.exam_attempts a ON a.paper_id = p.id
  WHERE a.id = p_attempt_id;
  IF pub THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  cur_rev := public._exam_attempt_grading_rev(p_attempt_id);
  IF COALESCE(p_base_rev, 0) > 0 AND cur_rev > p_base_rev THEN
    RAISE EXCEPTION 'exam_grading_stale';
  END IF;

  INSERT INTO public.exam_grading_drafts (attempt_id, grader_id, payload, updated_at)
  VALUES (p_attempt_id, actor_id, COALESCE(p_payload, '{}'::jsonb), NOW())
  ON CONFLICT (attempt_id) DO UPDATE
    SET grader_id = EXCLUDED.grader_id, payload = EXCLUDED.payload, updated_at = NOW();

  RETURN jsonb_build_object('savedAt', NOW(), 'rev', cur_rev);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_save_grading_draft(uuid, jsonb, bigint, uuid) FROM PUBLIC;

-- ── 批改頁：L3 單張送出 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_grade_attempt(
  p_attempt_id      UUID,
  p_grades          JSONB,
  p_overall_comment TEXT DEFAULT NULL,
  p_base_rev        BIGINT DEFAULT 0,
  p_actor_id        UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  cur_rev  BIGINT;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'exam_forbidden'; END IF;
  IF NOT public._exam_actor_can_grade(p_attempt_id, actor_id) THEN
    RAISE EXCEPTION 'exam_grading_not_assigned';
  END IF;

  cur_rev := public._exam_attempt_grading_rev(p_attempt_id);
  IF COALESCE(p_base_rev, 0) > 0 AND cur_rev > p_base_rev THEN
    RAISE EXCEPTION 'exam_grading_stale';
  END IF;

  RETURN public._exam_apply_attempt_grades(p_attempt_id, p_grades, p_overall_comment, actor_id);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_grade_attempt(uuid, jsonb, text, bigint, uuid) FROM PUBLIC;

-- ── 批改頁：L3 批次送出（逐張，不因單張失敗而整批中止）────────────────────
CREATE OR REPLACE FUNCTION public.exam_grade_attempts_bulk(
  p_items    JSONB,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  item     JSONB;
  aid      UUID;
  base_rev BIGINT;
  cur_rev  BIGINT;
  results  JSONB := '[]'::jsonb;
  one      JSONB;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'exam_forbidden'; END IF;
  IF jsonb_typeof(COALESCE(p_items, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'exam_grading_invalid';
  END IF;
  IF jsonb_array_length(p_items) > 200 THEN RAISE EXCEPTION 'exam_grading_batch_too_large'; END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    aid := (item->>'attemptId')::uuid;
    base_rev := COALESCE((item->>'baseRev')::bigint, 0);
    BEGIN
      IF aid IS NULL THEN RAISE EXCEPTION 'exam_grading_invalid'; END IF;
      IF NOT public._exam_actor_can_grade(aid, actor_id) THEN
        RAISE EXCEPTION 'exam_grading_not_assigned';
      END IF;
      cur_rev := public._exam_attempt_grading_rev(aid);
      IF base_rev > 0 AND cur_rev > base_rev THEN RAISE EXCEPTION 'exam_grading_stale'; END IF;

      one := public._exam_apply_attempt_grades(
        aid, item->'grades', item->>'overallComment', actor_id);
      results := results || jsonb_build_object('attemptId', aid, 'ok', TRUE, 'result', one);
    EXCEPTION WHEN OTHERS THEN
      results := results || jsonb_build_object('attemptId', aid, 'ok', FALSE, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('results', results);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_grade_attempts_bulk(jsonb, uuid) FROM PUBLIC;

-- ── GRANT（都給 authenticated + service_role；權限在函式內做）─────────────
GRANT EXECUTE ON FUNCTION public._exam_attempt_grading_rev(uuid)                       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._exam_actor_can_grade(uuid, uuid)                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._exam_apply_attempt_grades(uuid, jsonb, text, uuid)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_list_gradable_attempts(uuid, jsonb, uuid)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_search_grader_candidates(text, uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_assign_attempts(uuid, uuid[], uuid, boolean, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_get_grading_workspace(uuid, uuid)                TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_get_grading_sheet(uuid, uuid)                    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_save_grading_draft(uuid, jsonb, bigint, uuid)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_grade_attempt(uuid, jsonb, text, bigint, uuid)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_grade_attempts_bulk(jsonb, uuid)                 TO authenticated, service_role;

COMMENT ON TABLE public.exam_grading_assignments IS '線上簡答批改：一張 attempt 指派給哪位批改人員（一人一卷）。';
COMMENT ON TABLE public.exam_grading_drafts IS '線上簡答批改：L2 伺服器草稿（尚未送出的評分），一 attempt 一份。';
