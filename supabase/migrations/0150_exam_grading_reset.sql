-- Migration 0150: 線上簡答批改頁 — 重設為待批
--
-- 批改人員誤改（改錯份、按錯、想整份重來）目前完全沒有回頭路：分數一送出
-- 就只能用新分數蓋掉舊分數，沒辦法清空重新開始。這裡加一支 RPC，把一張卷
-- 的簡答評分整個清掉、狀態退回「已送出、尚未批改」，比照 exam_grade_attempt
-- 同一套權限（指派給我 or admin/pastor）與鎖定規則（成績公布後不可再動）。

CREATE OR REPLACE FUNCTION public.exam_reset_attempt_grading(
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
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'exam_forbidden'; END IF;
  IF NOT public._exam_actor_can_grade(p_attempt_id, actor_id) THEN
    RAISE EXCEPTION 'exam_grading_not_assigned';
  END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF at.attempt_kind <> 'official' OR at.status NOT IN ('submitted', 'graded') THEN
    RAISE EXCEPTION 'exam_grading_attempt_not_gradable';
  END IF;

  SELECT * INTO pr FROM public.exam_papers WHERE id = at.paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  UPDATE public.exam_answers
  SET awarded_points = NULL, grader_id = NULL, graded_at = NULL, updated_at = NOW()
  WHERE attempt_id = at.id AND section = 'shortanswer';

  -- 退回「剛送出、還沒批改」的原始狀態：manual_score/total_score 清空（跟
  -- 從未批改過時一樣是 NULL），status 退回 submitted。auto_score（一~五大題）
  -- 不受影響。
  UPDATE public.exam_attempts SET
    grader_overall_comment = NULL,
    manual_score = NULL,
    total_score  = NULL,
    status       = 'submitted',
    updated_at   = NOW()
  WHERE id = at.id;

  -- 清掉伺服器草稿——重設後不該讓舊草稿在下次開啟時把清空的分數又蓋回來。
  DELETE FROM public.exam_grading_drafts WHERE attempt_id = at.id;

  RETURN jsonb_build_object(
    'attemptId', at.id,
    'status', 'submitted',
    'rev', public._exam_attempt_grading_rev(at.id)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.exam_reset_attempt_grading(uuid, uuid) FROM PUBLIC;
