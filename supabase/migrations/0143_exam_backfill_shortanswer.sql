-- ============================================================================
-- 0143_exam_backfill_shortanswer.sql
--
-- 「簡答題送出後不見」救援：讓「已送出 / 已批改」的 attempt 也能補寫簡答題答案。
--
--   exam_backfill_shortanswer(p_attempt_id uuid, p_answers jsonb, p_actor_id uuid)
--     · 權限：該 attempt 的 owner 本人，或 admin / pastor。
--     · 只處理 section = 'shortanswer' 的題。
--     · 只在目前「沒有作答內容」（response 為 NULL / JSON null / 空字串）
--       且「尚未批改」（awarded_points IS NULL）時寫入——已有文字 / 已給分的一律不動。
--     · submitted / graded 都允許（這就是重點：突破 exam_save_progress /
--       exam_submit_attempt 的 status = 'in_progress' 限制）。
--     · 成績已公布（results_published_at IS NOT NULL）後一律禁止，防事後竄改。
--     · 補進去的題照正常流程進「簡答批改」待批清單（不動 grader_id / graded_at）。
--
--   前端救援流程（js/modules/exam.js renderResult）：結果頁把 server 回傳的答案
--   跟本機暫存（this.RESP + localStorage 鏡射）比對，簡答題 server 空、本機有內容
--   → 呼叫這支自動補送，並在畫面顯示本機版讓使用者看得到。
--
-- 部署：Supabase SQL editor 執行；nlc-data 的 EXAM_RPC_FUNCTIONS 需加
--       "exam_backfill_shortanswer" 並重新部署 Edge Function。冪等。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_backfill_shortanswer(
  p_attempt_id UUID,
  p_answers    JSONB,
  p_actor_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id  UUID    := public.resolve_quiz_actor(p_actor_id);
  is_staff  BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  at        public.exam_attempts%ROWTYPE;
  pr        public.exam_papers%ROWTYPE;
  q         RECORD;
  incoming  TEXT;
  written   INT := 0;
  skipped   INT := 0;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'exam_forbidden'; END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF at.user_id <> actor_id AND NOT is_staff THEN RAISE EXCEPTION 'exam_forbidden'; END IF;

  SELECT * INTO pr FROM public.exam_papers WHERE id = at.paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.results_published_at IS NOT NULL THEN RAISE EXCEPTION 'exam_results_locked'; END IF;

  FOR q IN
    SELECT eq.id
    FROM public.exam_questions eq
    WHERE eq.paper_id = at.paper_id AND eq.section = 'shortanswer'
  LOOP
    incoming := NULLIF(BTRIM(COALESCE(p_answers ->> q.id::text, '')), '');
    IF incoming IS NULL THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.exam_answers (attempt_id, question_id, section, response)
    VALUES (at.id, q.id, 'shortanswer', to_jsonb(incoming))
    ON CONFLICT (attempt_id, question_id) DO UPDATE
      SET response = to_jsonb(incoming),
          updated_at = NOW()
      WHERE public.exam_answers.awarded_points IS NULL
        AND (
          public.exam_answers.response IS NULL
          OR jsonb_typeof(public.exam_answers.response) = 'null'
          OR BTRIM(COALESCE(public.exam_answers.response #>> '{}', '')) = ''
        );

    IF FOUND THEN
      written := written + 1;
    ELSE
      skipped := skipped + 1;   -- 已有文字 / 已批改 → 保留，不覆蓋
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'attemptId', at.id,
    'attemptStatus', at.status,
    'written', written,
    'skipped', skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_backfill_shortanswer(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_backfill_shortanswer(uuid, jsonb, uuid) TO authenticated, service_role;
