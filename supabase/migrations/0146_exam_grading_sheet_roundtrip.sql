-- ============================================================================
-- 0146_exam_grading_sheet_roundtrip.sql — 簡答批改：Google 試算表往返
--
-- 設計文件：docs/exam-online-grading-design.md（Option B）
--
--   工作流：管理員在「大測驗 → 簡答批改」按「匯出批改用 CSV」→ 匯入 Google Sheet
--   共編 → 大家填分數 / 評語 / 認領人 → 管理員「檔案 → 下載 → CSV」→ 回後台
--   「從 CSV 匯回」→ 驗證後寫進 exam_answers / exam_attempts。
--
--   · 不做「不登入的批改頁」——匯出、匯回都在已登入的管理後台，只有 admin/pastor 能做。
--   · Google 端不需要 Apps Script / 不需要 secret / 不開對外端口。
--   · 匯回逐列處理：一列有問題只跳過那列，其餘照寫；可重複匯回（分數有變才覆蓋）。
--   · 成績已公布（exam_papers.results_published_at）後一律 exam_results_locked。
--
-- 部署：Supabase SQL editor 執行，或 `supabase db push`。
--       nlc-data 的 EXAM_RPC_FUNCTIONS + EXAM_ADMIN_RPC_FUNCTIONS 需加
--       exam_grading_sheet_rows / exam_apply_sheet_grades，並重新部署 Edge Function。
-- ============================================================================

-- 整卷評語（唯一的評語欄；個別題目的講評也寫這裡）
ALTER TABLE public.exam_attempts
  ADD COLUMN IF NOT EXISTS grader_overall_comment TEXT;

-- ── 匯出：一位作答者一列，帶齊每一道簡答題（含未作答的）────────────────────
CREATE OR REPLACE FUNCTION public.exam_grading_sheet_rows(
  p_paper_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = p_paper_id) THEN
    RAISE EXCEPTION 'exam_paper_not_found';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'attemptId', a.id,
      'name', p.name,
      'greatRegion', p.great_region,
      'pastoralZone', p.pastoral_zone,
      'smallGroup', p.small_group,
      'submittedAt', a.submitted_at,
      'attemptStatus', a.status,
      'overallComment', a.grader_overall_comment,
      'questions', (
        SELECT jsonb_agg(jsonb_build_object(
          'position', q.position,
          'points', q.points,
          'stem', q.payload -> 'stem',
          'referenceAnswer', q.payload -> 'referenceAnswer',
          'response', CASE WHEN ea.response IS NULL OR jsonb_typeof(ea.response) = 'null'
                           THEN NULL ELSE ea.response #>> '{}' END,
          'awardedPoints', ea.awarded_points
        ) ORDER BY q.position)
        FROM public.exam_questions q
        LEFT JOIN public.exam_answers ea ON ea.attempt_id = a.id AND ea.question_id = q.id
        WHERE q.paper_id = p_paper_id AND q.section = 'shortanswer'
      )
    ) ORDER BY p.pastoral_zone NULLS LAST, p.small_group NULLS LAST, p.name)
    FROM public.exam_attempts a
    JOIN public.profiles p ON p.id = a.user_id
    WHERE a.paper_id = p_paper_id
      AND a.attempt_kind = 'official'
      AND a.status IN ('submitted', 'graded')
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_grading_sheet_rows(uuid, uuid) FROM PUBLIC;

-- ── 匯回：逐列寫入分數 + 整卷評語 ─────────────────────────────────────────
-- p_rows = [ { attemptId, grades:[{position, points}], overall } ]
CREATE OR REPLACE FUNCTION public.exam_apply_sheet_grades(
  p_paper_id UUID,
  p_rows     JSONB,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id     UUID := public.resolve_quiz_actor(p_actor_id);
  pr           public.exam_papers%ROWTYPE;
  short_total  INTEGER;
  has_auto_sec BOOLEAN;
  row_item     JSONB;
  aid          UUID;
  at           public.exam_attempts%ROWTYPE;
  g            JSONB;
  qid          UUID;
  pts          NUMERIC;
  pos          INTEGER;
  filled       INTEGER;
  pending      INTEGER;
  short_sum    NUMERIC;
  written      JSONB := '[]'::jsonb;
  skipped      JSONB := '[]'::jsonb;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;
  IF jsonb_typeof(COALESCE(p_rows, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'exam_sheet_invalid';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN RAISE EXCEPTION 'exam_sheet_too_large'; END IF;

  SELECT COUNT(*) INTO short_total
  FROM public.exam_questions WHERE paper_id = p_paper_id AND section = 'shortanswer';
  SELECT EXISTS (SELECT 1 FROM public.exam_questions
                 WHERE paper_id = p_paper_id AND section <> 'shortanswer')
    INTO has_auto_sec;

  FOR row_item IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    aid := NULL;
    BEGIN
      aid := (row_item->>'attemptId')::uuid;
      IF aid IS NULL THEN RAISE EXCEPTION 'attempt_id_missing'; END IF;

      SELECT * INTO at FROM public.exam_attempts WHERE id = aid FOR UPDATE;
      IF NOT FOUND OR at.paper_id <> p_paper_id OR at.attempt_kind <> 'official'
         OR at.status NOT IN ('submitted', 'graded') THEN
        RAISE EXCEPTION 'attempt_not_gradable';
      END IF;

      IF jsonb_typeof(COALESCE(row_item->'grades', 'null'::jsonb)) <> 'array'
         OR jsonb_array_length(row_item->'grades') <> short_total THEN
        RAISE EXCEPTION 'grades_incomplete';
      END IF;

      -- 寫每一題（用 position 對到 question_id）
      FOR g IN SELECT * FROM jsonb_array_elements(row_item->'grades') LOOP
        pos := (g->>'position')::int;
        pts := (g->>'points')::numeric;
        SELECT id INTO qid FROM public.exam_questions
        WHERE paper_id = p_paper_id AND section = 'shortanswer' AND position = pos;
        IF qid IS NULL THEN RAISE EXCEPTION 'bad_position'; END IF;
        IF pts IS NULL OR pts < 0 OR pts > (SELECT points FROM public.exam_questions WHERE id = qid) THEN
          RAISE EXCEPTION 'points_out_of_range';
        END IF;

        INSERT INTO public.exam_answers (attempt_id, question_id, section, awarded_points, grader_id, graded_at, updated_at)
        VALUES (aid, qid, 'shortanswer', pts, actor_id, NOW(), NOW())
        ON CONFLICT (attempt_id, question_id) DO UPDATE
          SET awarded_points = EXCLUDED.awarded_points,
              grader_id      = EXCLUDED.grader_id,
              graded_at      = NOW(),
              updated_at     = NOW();
      END LOOP;

      -- 結算
      SELECT COUNT(*) FILTER (WHERE awarded_points IS NOT NULL),
             COUNT(*) FILTER (WHERE awarded_points IS NULL),
             COALESCE(SUM(awarded_points), 0)
      INTO filled, pending, short_sum
      FROM public.exam_answers WHERE attempt_id = aid AND section = 'shortanswer';

      IF filled >= short_total THEN
        IF has_auto_sec AND at.auto_score IS NULL THEN
          RAISE EXCEPTION 'auto_score_pending';
        END IF;
        UPDATE public.exam_attempts SET
          grader_overall_comment = NULLIF(BTRIM(COALESCE(row_item->>'overall', '')), ''),
          manual_score = short_sum,
          total_score  = COALESCE(auto_score, 0) + short_sum,
          status       = 'graded',
          updated_at   = NOW()
        WHERE id = aid;
      ELSE
        UPDATE public.exam_attempts SET
          grader_overall_comment = NULLIF(BTRIM(COALESCE(row_item->>'overall', '')), ''),
          updated_at = NOW()
        WHERE id = aid;
      END IF;

      written := written || to_jsonb(aid::text);
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped || jsonb_build_object('attemptId', aid, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'paperId', p_paper_id,
    'written', jsonb_array_length(written),
    'writtenIds', written,
    'skipped', skipped,
    'total', jsonb_array_length(p_rows)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.exam_apply_sheet_grades(uuid, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.exam_grading_sheet_rows(uuid, uuid)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exam_apply_sheet_grades(uuid, jsonb, uuid)   TO authenticated, service_role;

COMMENT ON FUNCTION public.exam_grading_sheet_rows(uuid, uuid)
  IS '簡答批改：匯出成 Google Sheet 用的資料，一位作答者一列，帶齊每道簡答題（含未作答）。admin/pastor。';
COMMENT ON FUNCTION public.exam_apply_sheet_grades(uuid, jsonb, uuid)
  IS '簡答批改：把共編試算表的分數 + 整卷評語匯回；逐列驗證寫入，成績公布後鎖定。admin/pastor。';
