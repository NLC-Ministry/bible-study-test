-- Allow early enrollment and scripture preview, but never accept reading
-- progress before a campaign stage is released and officially starts.

CREATE OR REPLACE FUNCTION public.enforce_reading_log_stage_progress_open()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $enforce_reading_log_stage_progress_open$
DECLARE
  target_plan public.global_plans%ROWTYPE;
  enrollment_user_id UUID;
BEGIN
  IF NEW.plan_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enrollment.user_id INTO enrollment_user_id
  FROM public.reading_plans enrollment
  WHERE enrollment.id = NEW.plan_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF enrollment_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'reading_log_plan_owner_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT global_plan.* INTO target_plan
  FROM public.reading_plans enrollment
  JOIN public.global_plans global_plan ON global_plan.id = enrollment.global_plan_id
  WHERE enrollment.id = NEW.plan_id;

  IF NOT FOUND OR target_plan.plan_kind <> 'church_campaign_stage' THEN
    RETURN NEW;
  END IF;

  IF target_plan.is_hidden
     OR (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::DATE < target_plan.start_date THEN
    RAISE EXCEPTION 'campaign_stage_progress_not_open' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$enforce_reading_log_stage_progress_open$;

REVOKE ALL ON FUNCTION public.enforce_reading_log_stage_progress_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_reading_log_stage_progress_open() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_reading_log_stage_open ON public.reading_logs;
DROP TRIGGER IF EXISTS trg_reading_log_stage_progress_open ON public.reading_logs;
CREATE TRIGGER trg_reading_log_stage_progress_open
  BEFORE INSERT OR UPDATE OF plan_id, user_id, book, chapter, round, read_at
  ON public.reading_logs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reading_log_stage_progress_open();
