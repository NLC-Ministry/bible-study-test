-- ============================================================================
-- 0155_devotion_video_sync.sql
--
-- 每日靈修影片自動抓取：教會 YouTube 頻道（@NewLifeChurch）每天早上大約 07:00
-- 會上架當天的靈修影片。這支排程每天固定時間呼叫 Edge Function
-- sync-devotion-video，去讀 YouTube 官方公開的 RSS 訂閱源
-- （youtube.com/feeds/videos.xml，不用登入、不用 API 金鑰，跟用瀏覽器打開頻道
-- 頁面看到的是同一份公開資訊），把最新一支影片填進「今天」那一天的
-- plan_devotion_days。
--
-- 只在該天 video_url 還是空的時候才自動填——如果管理員已經手動填過別的連結，
-- 排程完全不會覆蓋（見 sync_devotion_day_video 的 WHERE video_url IS NULL）。
--
-- 部署：Supabase SQL editor 執行。抓取／解析邏輯本身在 Edge Function
-- supabase/functions/sync-devotion-video/index.ts，需另外部署 + 設定密鑰
-- （見 supabase/functions/README.md）。
-- 冪等。
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 只在當天那一列還沒有影片連結時才寫入。service-role 專用（cron 的 Edge
--    Function 用 service role 呼叫），不開放給一般登入使用者。──────────────────
CREATE OR REPLACE FUNCTION public.sync_devotion_day_video(
  p_global_plan_id UUID,
  p_day_index INTEGER,
  p_video_url TEXT,
  p_video_title TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE public.plan_devotion_days
  SET video_url   = NULLIF(BTRIM(COALESCE(p_video_url, '')), ''),
      video_title = NULLIF(BTRIM(COALESCE(p_video_title, '')), '')
  WHERE global_plan_id = p_global_plan_id
    AND day_index = p_day_index
    AND video_url IS NULL
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('updated', v_id IS NOT NULL, 'id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_devotion_day_video(uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_devotion_day_video(uuid, integer, text, text) TO service_role;

-- ── pg_cron：每天 07:10 台北時間（= 23:10 UTC）呼叫 Edge Function ───────────
-- The shared secret is intentionally not committed. Configure it once:
--
--   select vault.create_secret(
--     'REPLACE_WITH_DEVOTION_VIDEO_SYNC_CRON_SECRET',
--     'devotion_video_sync_cron_secret',
--     'x-cron-secret sent to sync-devotion-video'
--   );
--
-- Set the identical value as the Edge Function secret
-- DEVOTION_VIDEO_SYNC_CRON_SECRET.

CREATE OR REPLACE FUNCTION public.invoke_devotion_video_sync()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $invoke_devotion_video_sync$
DECLARE
  cron_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO cron_secret
  FROM vault.decrypted_secrets
  WHERE name = 'devotion_video_sync_cron_secret'
  LIMIT 1;

  IF cron_secret IS NULL THEN
    RAISE WARNING 'devotion_video_sync_cron_secret not found in Vault; skipping devotion video sync';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://ztozevcqkfrohgjmngcj.supabase.co/functions/v1/sync-devotion-video',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := jsonb_build_object('source', 'pg_cron')
  );
END;
$invoke_devotion_video_sync$;

DO $schedule_devotion_video_sync$
DECLARE
  existing_job BIGINT;
BEGIN
  SELECT jobid INTO existing_job
  FROM cron.job
  WHERE jobname = 'sync-daily-devotion-video'
  LIMIT 1;
  IF existing_job IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job);
  END IF;
  PERFORM cron.schedule(
    'sync-daily-devotion-video',
    '10 23 * * *',
    'SELECT public.invoke_devotion_video_sync();'
  );
END;
$schedule_devotion_video_sync$;

REVOKE ALL ON FUNCTION public.invoke_devotion_video_sync() FROM PUBLIC;
