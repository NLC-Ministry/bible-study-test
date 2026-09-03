-- 0153_issue_report_conversation.sql
--
-- 回報系統升級：工單 + 訊息串。
--   · issue_reports 保留為工單本體（description = 不可變的開場貼文）。
--   · issue_report_messages 存後續來回對話：純文字（≤500 字）+ 每則最多 1 張截圖。
--   · 截圖本體放 Storage 私有 bucket issue-report-shots；訊息列只存中繼資料。
--   · 全部存取一律經 nlc-data 的 service role（授權在 SECURITY DEFINER RPC 內做）。
--
-- 冪等，可重複執行。

BEGIN;

------------------------------------------------------------------------
-- 1. issue_reports 增欄
------------------------------------------------------------------------
ALTER TABLE public.issue_reports
  ADD COLUMN IF NOT EXISTS last_message_at     timestamptz,
  ADD COLUMN IF NOT EXISTS member_last_read_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_last_read_at  timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at           timestamptz;

UPDATE public.issue_reports
SET last_message_at = COALESCE(last_message_at, updated_at, created_at)
WHERE last_message_at IS NULL;

------------------------------------------------------------------------
-- 2. 訊息表
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.issue_report_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES public.issue_reports(id) ON DELETE CASCADE,
  author_role  text NOT NULL CHECK (author_role IN ('member','admin')),
  author_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  body         text NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
  is_internal_note boolean NOT NULL DEFAULT false,
  attachment_path  text,
  attachment_mime  text CHECK (attachment_mime IS NULL OR attachment_mime IN ('image/webp','image/jpeg','image/png')),
  attachment_bytes int  CHECK (attachment_bytes IS NULL OR attachment_bytes BETWEEN 1 AND 512000),
  attachment_w     int,
  attachment_h     int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issue_msg_not_empty CHECK (char_length(body) > 0 OR attachment_path IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS issue_report_messages_thread_idx
  ON public.issue_report_messages (report_id, created_at);
CREATE INDEX IF NOT EXISTS issue_report_messages_author_idx
  ON public.issue_report_messages (author_id, created_at);
CREATE INDEX IF NOT EXISTS issue_reports_admin_list_idx
  ON public.issue_reports (status, last_message_at DESC);

-- RLS：全部存取經 nlc-data service role（繞過 RLS）。這裡開 RLS 但只放
-- 「admin 全權 / 本人讀非內部備註 / 本人發言」三條，作為 dev 與縱深防禦。
ALTER TABLE public.issue_report_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "msg admin all"   ON public.issue_report_messages;
DROP POLICY IF EXISTS "msg owner read"  ON public.issue_report_messages;
DROP POLICY IF EXISTS "msg owner write" ON public.issue_report_messages;

CREATE POLICY "msg admin all" ON public.issue_report_messages FOR ALL TO authenticated
  USING (public.current_role_code() = 'admin')
  WITH CHECK (public.current_role_code() = 'admin');
CREATE POLICY "msg owner read" ON public.issue_report_messages FOR SELECT TO authenticated
  USING (
    is_internal_note = false
    AND EXISTS (SELECT 1 FROM public.issue_reports r WHERE r.id = report_id AND r.user_id = auth.uid())
  );
CREATE POLICY "msg owner write" ON public.issue_report_messages FOR INSERT TO authenticated
  WITH CHECK (
    author_role = 'member' AND is_internal_note = false AND author_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.issue_reports r WHERE r.id = report_id AND r.user_id = auth.uid())
  );

------------------------------------------------------------------------
-- 3. Storage 私有 bucket（本體只由 nlc-data service role 讀寫）
------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('issue-report-shots', 'issue-report-shots', false, 524288,
        ARRAY['image/webp','image/jpeg','image/png'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

------------------------------------------------------------------------
-- 4. 新訊息 → 更新工單本體（last_message_at；會友在已結案串留言則重開）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._issue_touch_report_on_message()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_internal_note THEN
    RETURN NEW;
  END IF;
  UPDATE public.issue_reports
  SET last_message_at = NEW.created_at,
      status = CASE WHEN NEW.author_role = 'member' AND status IN ('resolved','ignored')
                    THEN 'pending' ELSE status END,
      closed_at = CASE WHEN NEW.author_role = 'member' AND status IN ('resolved','ignored')
                       THEN NULL ELSE closed_at END
  WHERE id = NEW.report_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_issue_touch_report_on_message ON public.issue_report_messages;
CREATE TRIGGER trg_issue_touch_report_on_message
  AFTER INSERT ON public.issue_report_messages
  FOR EACH ROW EXECUTE FUNCTION public._issue_touch_report_on_message();

------------------------------------------------------------------------
-- 5. actor / admin 解析
--    有 auth.uid()（dev 真實 Session）→ 一律用它，忽略 p_actor_id（防偽造）。
--    沒有（正式站 service role）→ 用 nlc-data 已用 token 驗過再注入的 p_actor_id。
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._issue_actor(p_actor_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(auth.uid(), p_actor_id);
$$;

CREATE OR REPLACE FUNCTION public._issue_is_admin(p_actor uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE code text;
BEGIN
  IF p_actor IS NULL THEN RETURN false; END IF;
  -- profiles.role（文字欄）已於 0048/後續移除；角色一律走 role_id → role_definitions.code
  SELECT public.role_code(role_id) INTO code
  FROM public.profiles WHERE id = p_actor;
  RETURN COALESCE(code = 'admin', false);
END $$;

------------------------------------------------------------------------
-- 6. 讀一串（會友：只有自己的；管理員：任意）＋順手標記已讀
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_thread_get(
  p_report_id uuid, p_actor_id uuid DEFAULT NULL, p_mark_read boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor    uuid := public._issue_actor(p_actor_id);
  is_admin boolean := public._issue_is_admin(actor);
  r        public.issue_reports%ROWTYPE;
  msgs     jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO r FROM public.issue_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF NOT is_admin AND r.user_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', m.id, 'authorRole', m.author_role, 'isInternal', m.is_internal_note,
           'body', m.body, 'createdAt', m.created_at,
           'attachmentPath', m.attachment_path, 'attachmentMime', m.attachment_mime,
           'attachmentW', m.attachment_w, 'attachmentH', m.attachment_h
         ) ORDER BY m.created_at), '[]'::jsonb)
  INTO msgs
  FROM public.issue_report_messages m
  WHERE m.report_id = p_report_id
    AND (is_admin OR m.is_internal_note = false)
    AND m.attachment_path IS DISTINCT FROM 'pending';   -- 上傳中的佔位列先不回

  IF p_mark_read THEN
    IF is_admin THEN
      UPDATE public.issue_reports SET admin_last_read_at = now() WHERE id = p_report_id;
    ELSE
      UPDATE public.issue_reports SET member_last_read_at = now() WHERE id = p_report_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'report', jsonb_build_object(
      'id', r.id, 'category', r.category, 'status', r.status,
      'description', r.description, 'url', r.url,
      'createdAt', r.created_at, 'lastMessageAt', r.last_message_at, 'closedAt', r.closed_at,
      -- 讀取進度（取「呼叫前」的值，用來顯示「管理員已讀」/「會友已讀」）
      'adminLastReadAt', r.admin_last_read_at, 'memberLastReadAt', r.member_last_read_at),
    'messages', msgs,
    'viewerRole', CASE WHEN is_admin THEN 'admin' ELSE 'member' END);
END $$;

------------------------------------------------------------------------
-- 7. 發一則訊息（純文字；有附件時先建佔位列，由 nlc-data 上傳後回填）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_thread_post(
  p_report_id uuid, p_body text, p_is_internal boolean DEFAULT false,
  p_has_attachment boolean DEFAULT false, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor    uuid := public._issue_actor(p_actor_id);
  is_admin boolean := public._issue_is_admin(actor);
  r        public.issue_reports%ROWTYPE;
  v_body   text := btrim(regexp_replace(COALESCE(p_body,''), '[[:cntrl:]]', '', 'g'));
  v_role   text;
  v_id     uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF char_length(v_body) > 500 THEN RAISE EXCEPTION 'invalid_body'; END IF;
  IF char_length(v_body) < 1 AND NOT p_has_attachment THEN RAISE EXCEPTION 'empty_message'; END IF;

  SELECT * INTO r FROM public.issue_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF NOT is_admin AND r.user_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'forbidden'; END IF;

  v_role := CASE WHEN is_admin THEN 'admin' ELSE 'member' END;

  IF (SELECT count(*) FROM public.issue_report_messages
      WHERE author_id = actor AND created_at > now() - interval '1 minute') >= 10 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT count(*) FROM public.issue_report_messages WHERE report_id = p_report_id) >= 200 THEN
    RAISE EXCEPTION 'thread_full';
  END IF;

  INSERT INTO public.issue_report_messages
    (report_id, author_role, author_id, body, is_internal_note, attachment_path)
  VALUES (p_report_id, v_role, actor, v_body, (p_is_internal AND is_admin),
          CASE WHEN p_has_attachment THEN 'pending' ELSE NULL END)
  RETURNING id INTO v_id;

  IF is_admin THEN
    UPDATE public.issue_reports SET admin_last_read_at = now() WHERE id = p_report_id;
  ELSE
    UPDATE public.issue_reports SET member_last_read_at = now() WHERE id = p_report_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'reportId', p_report_id,
                            'authorRole', v_role, 'needsAttachment', p_has_attachment);
END $$;

-- 7b. 附件回填（nlc-data 上傳 Storage 成功後呼叫）
CREATE OR REPLACE FUNCTION public.issue_thread_set_attachment(
  p_message_id uuid, p_path text, p_mime text, p_bytes int, p_w int, p_h int,
  p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  m public.issue_report_messages%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.issue_report_messages WHERE id = p_message_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_not_found'; END IF;
  IF NOT public._issue_is_admin(actor) AND m.author_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_mime NOT IN ('image/webp','image/jpeg','image/png') THEN RAISE EXCEPTION 'bad_mime'; END IF;
  IF p_bytes IS NULL OR p_bytes < 1 OR p_bytes > 512000 THEN RAISE EXCEPTION 'too_large'; END IF;
  UPDATE public.issue_report_messages
  SET attachment_path = p_path, attachment_mime = p_mime, attachment_bytes = p_bytes,
      attachment_w = p_w, attachment_h = p_h
  WHERE id = p_message_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 7c. 移除附件（會友限自己、管理員任意）。回傳舊路徑讓 nlc-data 刪 Storage 物件。
--     若訊息沒有文字，整列一起刪。
CREATE OR REPLACE FUNCTION public.issue_thread_drop_attachment(
  p_message_id uuid, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  m public.issue_report_messages%ROWTYPE;
  v_old text;
BEGIN
  SELECT * INTO m FROM public.issue_report_messages WHERE id = p_message_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'oldPath', NULL); END IF;
  IF NOT public._issue_is_admin(actor) AND m.author_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_old := NULLIF(m.attachment_path, 'pending');
  IF char_length(COALESCE(m.body,'')) = 0 THEN
    DELETE FROM public.issue_report_messages WHERE id = p_message_id;
  ELSE
    UPDATE public.issue_report_messages
    SET attachment_path = NULL, attachment_mime = NULL, attachment_bytes = NULL,
        attachment_w = NULL, attachment_h = NULL
    WHERE id = p_message_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'oldPath', v_old);
END $$;

------------------------------------------------------------------------
-- 8. 標記已讀
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_thread_mark_read(p_report_id uuid, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  is_admin boolean := public._issue_is_admin(actor);
  r public.issue_reports%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO r FROM public.issue_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF NOT is_admin AND r.user_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF is_admin THEN
    UPDATE public.issue_reports SET admin_last_read_at = now() WHERE id = p_report_id;
  ELSE
    UPDATE public.issue_reports SET member_last_read_at = now() WHERE id = p_report_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

------------------------------------------------------------------------
-- 9. 未讀摘要（會友：自己的工單有 admin 新訊息；管理員：有 member 新訊息的工單數）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_thread_unread_summary(p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  is_admin boolean := public._issue_is_admin(actor);
  total int;
BEGIN
  IF actor IS NULL THEN RETURN jsonb_build_object('total', 0, 'role', 'anon'); END IF;
  IF is_admin THEN
    SELECT count(*) INTO total FROM public.issue_reports r
    WHERE EXISTS (
      SELECT 1 FROM public.issue_report_messages m
      WHERE m.report_id = r.id AND m.author_role = 'member' AND m.is_internal_note = false
        AND m.attachment_path IS DISTINCT FROM 'pending'
        AND m.created_at > COALESCE(r.admin_last_read_at, r.created_at));
  ELSE
    SELECT count(*) INTO total FROM public.issue_reports r
    WHERE r.user_id = actor AND EXISTS (
      SELECT 1 FROM public.issue_report_messages m
      WHERE m.report_id = r.id AND m.author_role = 'admin' AND m.is_internal_note = false
        AND m.attachment_path IS DISTINCT FROM 'pending'
        AND m.created_at > COALESCE(r.member_last_read_at, r.created_at));
  END IF;
  RETURN jsonb_build_object('total', COALESCE(total, 0),
                            'role', CASE WHEN is_admin THEN 'admin' ELSE 'member' END);
END $$;

------------------------------------------------------------------------
-- 10. 會友：我的工單清單（給抽屜「我的回報」用）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_my_reports(p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  rows_j jsonb;
BEGIN
  IF actor IS NULL THEN RETURN jsonb_build_object('rows', '[]'::jsonb); END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'lastMessageAt' DESC), '[]'::jsonb) INTO rows_j
  FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'category', r.category, 'status', r.status,
      'description', r.description,
      'createdAt', r.created_at, 'lastMessageAt', r.last_message_at,
      'unread', EXISTS (
        SELECT 1 FROM public.issue_report_messages m
        WHERE m.report_id = r.id AND m.author_role = 'admin' AND m.is_internal_note = false
          AND m.attachment_path IS DISTINCT FROM 'pending'
          AND m.created_at > COALESCE(r.member_last_read_at, r.created_at))
    ) AS x
    FROM public.issue_reports r
    WHERE r.user_id = actor
    ORDER BY r.last_message_at DESC NULLS LAST
    LIMIT 100
  ) sub;
  RETURN jsonb_build_object('rows', rows_j);
END $$;

------------------------------------------------------------------------
-- 11. 管理端清單（admin only）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_admin_thread_list(
  p_status text DEFAULT NULL, p_limit int DEFAULT 40, p_offset int DEFAULT 0, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  rows_j jsonb;
BEGIN
  IF NOT public._issue_is_admin(actor) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'lastMessageAt' DESC NULLS LAST), '[]'::jsonb) INTO rows_j
  FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'category', r.category, 'status', r.status,
      'description', r.description, 'url', r.url,
      'createdAt', r.created_at, 'lastMessageAt', r.last_message_at,
      'messageCount', (SELECT count(*) FROM public.issue_report_messages m
                       WHERE m.report_id = r.id AND m.attachment_path IS DISTINCT FROM 'pending'),
      'unreadFromMember', EXISTS (
        SELECT 1 FROM public.issue_report_messages m
        WHERE m.report_id = r.id AND m.author_role = 'member' AND m.is_internal_note = false
          AND m.attachment_path IS DISTINCT FROM 'pending'
          AND m.created_at > COALESCE(r.admin_last_read_at, r.created_at)),
      'reporter', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
        'name', p.name, 'pastoralZone', p.pastoral_zone, 'smallGroup', p.small_group) END
    ) AS x
    FROM public.issue_reports r
    LEFT JOIN public.profiles p ON p.id = r.user_id
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.last_message_at DESC NULLS LAST
    LIMIT LEAST(GREATEST(p_limit, 1), 100) OFFSET GREATEST(p_offset, 0)
  ) sub;
  RETURN jsonb_build_object('rows', rows_j);
END $$;

------------------------------------------------------------------------
-- 12. 管理端改狀態（admin only）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_admin_set_status(
  p_report_id uuid, p_status text, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public._issue_actor(p_actor_id);
BEGIN
  IF NOT public._issue_is_admin(actor) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_status NOT IN ('pending','processing','resolved','ignored') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  UPDATE public.issue_reports
  SET status = p_status,
      closed_at = CASE WHEN p_status IN ('resolved','ignored') THEN now() ELSE NULL END,
      admin_last_read_at = now()
  WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  RETURN jsonb_build_object('ok', true, 'status', p_status);
END $$;

------------------------------------------------------------------------
-- 13. 排程用（不對前端開放；只給排程 Edge Function / pg_cron）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_threads_autoclose()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  WITH last_msg AS (
    SELECT DISTINCT ON (report_id) report_id, author_role, created_at
    FROM public.issue_report_messages
    WHERE is_internal_note = false AND attachment_path IS DISTINCT FROM 'pending'
    ORDER BY report_id, created_at DESC)
  UPDATE public.issue_reports r
  SET status = 'resolved', closed_at = now()
  FROM last_msg lm
  WHERE r.id = lm.report_id
    AND r.status IN ('pending','processing')
    AND lm.author_role = 'admin'
    AND lm.created_at < now() - interval '14 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.issue_threads_purge_messages(p_older_than_days int DEFAULT 180)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  DELETE FROM public.issue_report_messages m
  USING public.issue_reports r
  WHERE m.report_id = r.id
    AND r.status IN ('resolved','ignored')
    AND r.closed_at < now() - make_interval(days => GREATEST(p_older_than_days, 30));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

------------------------------------------------------------------------
-- 14. 遷移既有 metadata.reply → 第一則管理員訊息
------------------------------------------------------------------------
INSERT INTO public.issue_report_messages (report_id, author_role, author_id, body, created_at)
SELECT r.id, 'admin',
       CASE WHEN r.metadata->>'replied_by' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (r.metadata->>'replied_by')::uuid END,
       left(btrim(r.metadata->>'reply'), 500),
       COALESCE(NULLIF(r.metadata->>'replied_at','')::timestamptz, r.updated_at, r.created_at)
FROM public.issue_reports r
WHERE COALESCE(btrim(r.metadata->>'reply'),'') <> ''
  AND NOT EXISTS (SELECT 1 FROM public.issue_report_messages m WHERE m.report_id = r.id);

UPDATE public.issue_reports r
SET last_message_at = GREATEST(r.last_message_at,
      (SELECT max(created_at) FROM public.issue_report_messages m WHERE m.report_id = r.id))
WHERE EXISTS (SELECT 1 FROM public.issue_report_messages m WHERE m.report_id = r.id);

------------------------------------------------------------------------
-- 15. 權限
------------------------------------------------------------------------
DO $$ DECLARE fn text; BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'issue_thread_get(uuid, uuid, boolean)',
    'issue_thread_post(uuid, text, boolean, boolean, uuid)',
    'issue_thread_set_attachment(uuid, text, text, integer, integer, integer, uuid)',
    'issue_thread_drop_attachment(uuid, uuid)',
    'issue_thread_mark_read(uuid, uuid)',
    'issue_thread_unread_summary(uuid)',
    'issue_my_reports(uuid)',
    'issue_admin_thread_list(text, integer, integer, uuid)',
    'issue_admin_set_status(uuid, text, uuid)',
    'issue_threads_autoclose()',
    'issue_threads_purge_messages(integer)',
    '_issue_actor(uuid)',
    '_issue_is_admin(uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;

COMMIT;
