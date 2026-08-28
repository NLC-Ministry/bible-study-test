-- ============================================================================
-- 0108_exam_sync_question_points.sql
-- 修：自動計分用的是 exam_questions.points（每題），但「試卷設定 → 題型與配分」
-- 改的是 exam_papers.sections[].pointsPer；兩者不會互相同步 → 改了配分後分數不對。
--
--   · 新增 trigger：exam_papers.sections 一改，就把該卷所有題目的 points 對正
--     對應題型的 pointsPer。
--   · 一次性回填：把現有所有題目的 points 對正各自試卷的 sections 配分。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public._exam_sync_question_points()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.sections IS DISTINCT FROM OLD.sections THEN
    UPDATE public.exam_questions q
    SET points = COALESCE((
      SELECT (e ->> 'pointsPer')::numeric
      FROM jsonb_array_elements(NEW.sections) e
      WHERE e ->> 'type' = q.section
    ), q.points)
    WHERE q.paper_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_exam_sync_question_points ON public.exam_papers;
CREATE TRIGGER trg_exam_sync_question_points
  AFTER UPDATE OF sections ON public.exam_papers
  FOR EACH ROW EXECUTE FUNCTION public._exam_sync_question_points();

-- 一次性回填：現有題目 points 對正 sections 配分
UPDATE public.exam_questions q
SET points = sub.pp
FROM (
  SELECT q2.id, (e ->> 'pointsPer')::numeric AS pp
  FROM public.exam_questions q2
  JOIN public.exam_papers p ON p.id = q2.paper_id
  JOIN LATERAL jsonb_array_elements(p.sections) e ON e ->> 'type' = q2.section
) sub
WHERE sub.id = q.id
  AND sub.pp IS NOT NULL
  AND q.points IS DISTINCT FROM sub.pp;

REVOKE ALL ON FUNCTION public._exam_sync_question_points() FROM PUBLIC;
