-- ============================================================================
-- scratch/mask_admin_sender_in_quiz_notifications.sql
-- 系統管理員發出的小測驗通知：sender.name 一律遮成「系統管理員」，不外露本名。
-- （前端 db.js 也會遮一層；這支是伺服器端的防線，之後直接讀 RPC 的地方也安全。）
--
-- Supabase SQL editor 執行。純 CREATE OR REPLACE，不動資料、不用重部署 nlc-data。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_quiz_notifications(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $get_quiz_notifications$
DECLARE
  actor_id UUID;
  result JSONB;
BEGIN
  actor_id := public.resolve_quiz_actor(p_actor_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', notification.id,
    'type', 'quiz',
    'status', notification.status,
    'message', notification.message,
    'sent_on', publication.quiz_date,
    'globalPlanId', publication.global_plan_id,
    'quizDate', publication.quiz_date,
    'createdAt', notification.created_at,
    'sender', jsonb_build_object(
      'name', CASE WHEN publication.publisher_role = 'admin'
                   THEN '系統管理員' ELSE publisher.name END,
      'role_definition', jsonb_build_object('code', publication.publisher_role)
    )
  ) ORDER BY notification.created_at DESC), '[]'::JSONB) INTO result
  FROM (
    SELECT *
    FROM public.quiz_notifications
    WHERE recipient_id = actor_id
    ORDER BY created_at DESC
    LIMIT 50
  ) notification
  JOIN public.quiz_publications publication ON publication.id = notification.publication_id
  JOIN public.profiles publisher ON publisher.id = publication.published_by
  ;
  RETURN result;
END;
$get_quiz_notifications$;

REVOKE ALL ON FUNCTION public.get_quiz_notifications(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_quiz_notifications(UUID) TO authenticated, service_role;
