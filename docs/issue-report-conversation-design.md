# 回報系統：改成可來回對話（設計文件）

狀態：**已實作，未部署**（2026-09-03）。migration `0153` + `nlc-data` + 排程 EF + 前端全數落地；1107 測試通過（僅既有 `reader-module-syntax` 環境失敗）。部署前請跑〈部署順序〉。

## 目標與範圍

把現在「一段描述 + 一則管理員回覆」的回報，升級成**工單 + 訊息串**：使用者與管理員可以在同一則回報下多次來回，把狀況講清楚。

明確**不做**（初版）：

- 不做即時推播（沒有 WebSocket / Supabase Realtime）。打開對話框時抓一次 + 輕量輪詢即可。
- 不做 Web Push / Email 通知。沿用站內鈴鐺 + 浮動按鈕的未讀數字。
- 不做多客服指派 / SLA / 罐頭回覆 / 機器人。
- **可以傳截圖**（每則訊息最多 1 張），但走「手動上傳 + 前端壓縮 + 私有 bucket + 短效簽名網址」，不做貼上自動截圖、不做多張、不做編輯畫記。

三個硬性要求貫穿整份設計：**節省空間**、**好效能**、**安全**。對應章節見〈設計取捨〉。

---

## 資料模型

### 保留 `issue_reports` 為「工單本體」

不動現有欄位語意。`description` 仍是**不可變的開場貼文**，顯示在對話串最上面；後續對話另存新表。這樣：

- 不需要搬移 / 複製 `description`。
- `0077` Google 試算表同步（讀 `description` / `metadata`）**完全不受影響**。
- 既有 `metadata`（管理員回覆、`reply_seen_at`…）原封不動，只在遷移時把 `metadata.reply` 轉成第一則管理員訊息。

新增欄位：

| 欄位 | 型別 | 用途 |
|---|---|---|
| `last_message_at` | `timestamptz` | 對話串最後一則訊息時間；管理端排序用（配索引）。開場時 = `created_at`。 |
| `member_last_read_at` | `timestamptz` | 回報者最後讀到哪。算未讀用。 |
| `admin_last_read_at` | `timestamptz` | 管理員群最後讀到哪（全體共用一個，因為只有 2–3 位管理員、不分派）。 |
| `closed_at` | `timestamptz` | 自動關閉時間戳，`NULL` = 未關閉。 |

### 新表 `issue_report_messages`

一則訊息 = 文字（可空）+ **最多一張截圖**。要傳兩張就送兩則。截圖本體放 Supabase Storage 私有 bucket，訊息列只存中繼資料（路徑、尺寸、大小）。

```sql
CREATE TABLE public.issue_report_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES public.issue_reports(id) ON DELETE CASCADE,
  author_role  text NOT NULL CHECK (author_role IN ('member','admin')),
  author_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  body         text NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
  is_internal_note boolean NOT NULL DEFAULT false,  -- 管理員之間的私密備註，會友看不到
  -- 附件（0 或 1 張）：路徑由伺服器決定 = <report_id>/<message_id>.<ext>
  attachment_path  text,
  attachment_mime  text CHECK (attachment_mime IN ('image/webp','image/jpeg','image/png')),
  attachment_bytes int  CHECK (attachment_bytes IS NULL OR attachment_bytes BETWEEN 1 AND 512000),
  attachment_w     int,
  attachment_h     int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 不能是「空訊息」：至少要有文字或附件
  CONSTRAINT issue_msg_not_empty CHECK (char_length(body) > 0 OR attachment_path IS NOT NULL)
);
```

刻意**不存**逐則已讀回條、不存編輯歷史（append-only）。文字約 0.3–0.5 KB／則；截圖前端壓到 WebP ≤ 300 KB／張，bucket 再設 512 KB 硬上限。

---

## Migration 草稿

檔名 `supabase/migrations/0153_issue_report_conversation.sql`（下一個可用編號）。以下為草稿，實作時再細修。

```sql
-- 0153_issue_report_conversation.sql
-- 回報系統：工單 + 訊息串。issue_reports 保留為工單本體（description = 開場貼文），
-- 後續對話存 issue_report_messages。純文字、append-only、無附件。

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
  attachment_mime  text CHECK (attachment_mime IN ('image/webp','image/jpeg','image/png')),
  attachment_bytes int  CHECK (attachment_bytes IS NULL OR attachment_bytes BETWEEN 1 AND 512000),
  attachment_w     int,
  attachment_h     int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issue_msg_not_empty CHECK (char_length(body) > 0 OR attachment_path IS NOT NULL)
);

-- 截圖本體：私有 bucket，只由 nlc-data 的 service role 讀寫；對外一律短效簽名網址
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('issue-report-shots', 'issue-report-shots', false, 524288,
        ARRAY['image/webp','image/jpeg','image/png'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- storage.objects 政策只給 dev / localhost 的真實 Supabase Auth 路徑（正式站走 service role）
DROP POLICY IF EXISTS "shots: admin read"   ON storage.objects;
DROP POLICY IF EXISTS "shots: admin delete" ON storage.objects;
CREATE POLICY "shots: admin read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'issue-report-shots'
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));
CREATE POLICY "shots: admin delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'issue-report-shots'
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- 對話串抓取（依 report_id + 時間）
CREATE INDEX IF NOT EXISTS issue_report_messages_thread_idx
  ON public.issue_report_messages (report_id, created_at);
-- 頻率限制 / 未讀統計（依作者 + 時間）
CREATE INDEX IF NOT EXISTS issue_report_messages_author_idx
  ON public.issue_report_messages (author_id, created_at);
-- 管理端清單排序
CREATE INDEX IF NOT EXISTS issue_reports_admin_list_idx
  ON public.issue_reports (status, last_message_at DESC);

ALTER TABLE public.issue_report_messages ENABLE ROW LEVEL SECURITY;

-- RLS 只服務 dev / localhost 的真實 Supabase Auth 路徑；正式站一律走
-- nlc-data 的 service role（繞過 RLS，授權在 RPC 內做）。政策比照 0030 的 issue_reports。
CREATE POLICY "msg: admin all" ON public.issue_report_messages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));
CREATE POLICY "msg: owner read" ON public.issue_report_messages FOR SELECT TO authenticated
  USING (
    is_internal_note = false
    AND EXISTS (SELECT 1 FROM public.issue_reports r WHERE r.id = report_id AND r.user_id = auth.uid())
  );
CREATE POLICY "msg: owner write" ON public.issue_report_messages FOR INSERT TO authenticated
  WITH CHECK (
    author_role = 'member' AND is_internal_note = false AND author_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.issue_reports r WHERE r.id = report_id AND r.user_id = auth.uid())
  );

------------------------------------------------------------------------
-- 3. 新訊息 → 更新工單本體
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._issue_touch_report_on_message()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_internal_note THEN
    RETURN NEW;  -- 內部備註不改工單狀態 / 時間
  END IF;
  UPDATE public.issue_reports
  SET last_message_at = NEW.created_at,
      -- 會友在已結案的工單再留言 → 重新開啟
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
-- 4. actor 解析（安全關鍵）
--    有 auth.uid()（dev 真實 Session）→ 一律用它，忽略 p_actor_id（防 dev 端偽造）。
--    沒有（正式站 service role）→ 用 nlc-data 已用 Logto 驗過再注入的 p_actor_id。
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._issue_actor(p_actor_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(auth.uid(), p_actor_id);
$$;

CREATE OR REPLACE FUNCTION public._issue_is_admin(p_actor uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT public.role_code((SELECT role_id FROM public.profiles WHERE id = p_actor)) = 'admin';
$$;

------------------------------------------------------------------------
-- 5. 讀一串（會友：只有自己的；管理員：任意）＋順手標記已讀
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
           'attachmentPath', m.attachment_path,   -- nlc-data 會換成 5 分鐘簽名網址
           'attachmentMime', m.attachment_mime,
           'attachmentW', m.attachment_w, 'attachmentH', m.attachment_h
         ) ORDER BY m.created_at), '[]'::jsonb)
  INTO msgs
  FROM public.issue_report_messages m
  WHERE m.report_id = p_report_id
    AND (is_admin OR m.is_internal_note = false);

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
      'createdAt', r.created_at, 'lastMessageAt', r.last_message_at,
      'closedAt', r.closed_at),
    'messages', msgs,
    'viewerRole', CASE WHEN is_admin THEN 'admin' ELSE 'member' END);
END $$;

------------------------------------------------------------------------
-- 6. 發一則訊息（純文字，或先建列、附件由 nlc-data 上傳後回填）
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

  -- 頻率限制：每人每分鐘 10 則
  IF (SELECT count(*) FROM public.issue_report_messages
      WHERE author_id = actor AND created_at > now() - interval '1 minute') >= 10 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  -- 單串上限：200 則
  IF (SELECT count(*) FROM public.issue_report_messages WHERE report_id = p_report_id) >= 200 THEN
    RAISE EXCEPTION 'thread_full';
  END IF;

  -- p_has_attachment 時先寫一個佔位路徑，滿足 not-empty 限制；nlc-data 上傳成功後
  -- 呼叫 issue_thread_set_attachment 回填真實中繼資料，失敗則刪掉這一列。
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

  RETURN jsonb_build_object('id', v_id, 'reportId', p_report_id, 'authorRole', v_role,
                            'needsAttachment', p_has_attachment);
END $$;

-- 6b. 附件回填（nlc-data 上傳到 Storage 後呼叫）
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

-- 6c. 移除附件（會友限自己、管理員任意）。回傳舊路徑讓 nlc-data 去刪 Storage 物件。
--     訊息本身若沒有文字，整列一起刪。
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
  v_old := m.attachment_path;
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
-- 7. 標記已讀（不讀內容時用）
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
-- 8. 未讀摘要（會友：自己的工單；管理員：全部）
--    只回數字 + 精簡清單，不拉訊息內文。
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_thread_unread_summary(p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  is_admin boolean := public._issue_is_admin(actor);
  total int;
BEGIN
  IF actor IS NULL THEN RETURN jsonb_build_object('total', 0); END IF;
  IF is_admin THEN
    SELECT count(*) INTO total
    FROM public.issue_reports r
    WHERE EXISTS (
      SELECT 1 FROM public.issue_report_messages m
      WHERE m.report_id = r.id AND m.author_role = 'member' AND m.is_internal_note = false
        AND m.created_at > COALESCE(r.admin_last_read_at, r.created_at));
  ELSE
    SELECT count(*) INTO total
    FROM public.issue_reports r
    WHERE r.user_id = actor
      AND EXISTS (
        SELECT 1 FROM public.issue_report_messages m
        WHERE m.report_id = r.id AND m.author_role = 'admin' AND m.is_internal_note = false
          AND m.created_at > COALESCE(r.member_last_read_at, r.created_at));
  END IF;
  RETURN jsonb_build_object('total', COALESCE(total, 0));
END $$;

------------------------------------------------------------------------
-- 9. 管理端清單（admin only）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_admin_thread_list(
  p_status text DEFAULT NULL, p_limit int DEFAULT 30, p_offset int DEFAULT 0, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
  rows_j jsonb;
BEGIN
  IF NOT public._issue_is_admin(actor) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'lastMessageAt' DESC), '[]'::jsonb) INTO rows_j
  FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'category', r.category, 'status', r.status,
      'description', r.description, 'url', r.url,
      'createdAt', r.created_at, 'lastMessageAt', r.last_message_at,
      'messageCount', (SELECT count(*) FROM public.issue_report_messages m WHERE m.report_id = r.id),
      'unreadFromMember', EXISTS (
        SELECT 1 FROM public.issue_report_messages m
        WHERE m.report_id = r.id AND m.author_role = 'member' AND m.is_internal_note = false
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
-- 10. 管理端改狀態（admin only；取代對 issue_reports 的原始 update）
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_admin_set_status(
  p_report_id uuid, p_status text, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public._issue_actor(p_actor_id);
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
-- 11. 排程用（不經 nlc-data，只給 pg_cron / 排程 Edge Function 呼叫）
------------------------------------------------------------------------
-- 管理員已回覆、會友 14 天沒再回 → 自動結案
CREATE OR REPLACE FUNCTION public.issue_threads_autoclose()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  WITH last_msg AS (
    SELECT DISTINCT ON (report_id) report_id, author_role, created_at
    FROM public.issue_report_messages
    WHERE is_internal_note = false
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

-- 結案超過 N 天 → 刪掉訊息（工單本體 / description / 狀態保留，供統計與試算表）。
-- 只刪 DB 列；對應的 Storage 物件由排程 Edge Function 掃孤兒清掉（SQL 動不到 Storage）。
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
-- 12. 遷移既有 metadata.reply → 第一則管理員訊息
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
-- 13. 權限
------------------------------------------------------------------------
DO $$ DECLARE fn text; BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'issue_thread_get(uuid, uuid, boolean)',
    'issue_thread_post(uuid, text, boolean, boolean, uuid)',
    'issue_thread_set_attachment(uuid, text, text, int, int, int, uuid)',
    'issue_thread_drop_attachment(uuid, uuid)',
    'issue_thread_mark_read(uuid, uuid)',
    'issue_thread_unread_summary(uuid)',
    'issue_admin_thread_list(text, int, int, uuid)',
    'issue_admin_set_status(uuid, text, uuid)',
    'issue_threads_autoclose()',
    'issue_threads_purge_messages(int)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;

COMMIT;
```

---

## Edge Function：`supabase/functions/nlc-data/index.ts`

有兩類：**純資料的走 RPC passthrough**；**碰 Storage 的（簽名網址、上傳、刪物件）要新 action**，因為 SQL 動不到 Storage。

### 純 RPC（passthrough）

```ts
const ISSUE_RPC_FUNCTIONS = new Set([
  "issue_thread_mark_read", "issue_thread_unread_summary",
  "issue_admin_thread_list", "issue_admin_set_status",
]);
const ISSUE_ADMIN_RPC_FUNCTIONS = new Set(["issue_admin_thread_list", "issue_admin_set_status"]);
```

- 併入 `RPC_FUNCTIONS` union；`p_actor_id` 注入清單加 `|| ISSUE_RPC_FUNCTIONS.has(fn)`。
- 授權：`if (ISSUE_ADMIN_RPC_FUNCTIONS.has(fn) && !isAdmin(profile)) return 403`。
- **無 feature flag**（回報一律開啟）。

### 新 action（碰 Storage）

| action | 做什麼 |
|---|---|
| `issue_thread_get` | 呼叫 `rpc('issue_thread_get')` 拿訊息 → 對每個 `attachmentPath` 批次 `createSignedUrls('issue-report-shots', paths, 300)` → 回傳帶 `attachmentUrl` 的訊息。 |
| `issue_thread_post` | 收 `{report_id, body, is_internal, image?}`（`image` = `{base64, mime, w, h}`）。① `rpc('issue_thread_post', {..., p_has_attachment: !!image})` 拿 `message_id`；② 有圖 → 檢查 base64 解出的 bytes ≤ 512000、mime 白名單 → `storage.upload('<report_id>/<message_id>.<ext>', bytes, {contentType})` → `rpc('issue_thread_set_attachment', {message_id, path, mime, bytes, w, h})`；③ 上傳失敗 → `rpc('issue_thread_drop_attachment', {message_id})` 補償刪列，回 500。 |
| `issue_thread_attachment_delete` | 收 `{message_id}` → `rpc('issue_thread_drop_attachment')` 拿 `oldPath` → `storage.remove([oldPath])`。授權在 RPC 內（admin 或作者本人）。 |

- 這三個 action 走 `body.action` 分支（比照 `mark_issue_report_reply_seen` / `send_care_reminder`），不是 `action:"rpc"`。
- `issue_threads_autoclose` / `issue_threads_purge_messages` 都**不對前端開放** — 只給排程呼叫。
- 既有 `mark_issue_report_reply_seen` action、對 `issue_reports` 的 `insert`（開新工單）保留不動；`update` / `delete` 仍限 admin。

### 排程 Edge Function（`supabase/functions/issue-report-maintenance/`）

每日 Cron 觸發：① `rpc('issue_threads_autoclose')`；② 每月 `rpc('issue_threads_purge_messages', {p_older_than_days: 180})`；③ 掃 `issue-report-shots` bucket，列出物件、比對 `issue_report_messages.attachment_path`，**刪掉沒有對應訊息列的孤兒物件**（purge 之後、上傳失敗殘留、report 被 admin 硬刪 cascade 掉訊息但物件還在）。沒有 pg_cron 也能只靠這支。

---

## 前端

### `components/issue-report/IssueReportBlocks.ts`

- 抽一個共用 `callNlc(action, payload)`（POST `functions/v1/nlc-data`，帶 token；沿用 `ReportDrawer` / `AdminReportView` 那套取 token 邏輯，去重）。
- 新增 `ThreadPipeline`：`get(reportId)` / `post(reportId, {body, image?})` / `markRead(reportId)` / `unreadSummary()` / `deleteAttachment(messageId)`。
- 新增 `compressScreenshot(file): Promise<{base64, mime, w, h}>`：`createImageBitmap` → `<canvas>` 縮到最長邊 ≤ 1600 → `canvas.toBlob('image/webp', 0.7)`；> 300 KB 就降到 q0.55 → q0.4 → 尺寸砍到 1200 再試。canvas 重新編碼會**順便去掉 EXIF/GPS**。只收 `image/png|jpeg|webp`。
- `ReportPipeline.execute` 開新工單後，回傳 `report_id`（insert 加 `select:"id"`）。
- 離線佇列 `OfflineQueue` 擴充：`kind: 'new_report' | 'thread_message'`；訊息記錄可帶壓縮後的 `image`（base64）。`online` 事件重播時呼叫 `issue_thread_post` action。

### `components/issue-report/ReportDrawer.tsx`

- 「填寫回報」tab 不變（送出後可直接切到該工單對話）。
- 「我的歷史與回覆」tab：每張卡片可展開成**對話串**——最上面是 `description`（開場貼文），下面依序 `messages`（會友靠右、管理員靠左、內部備註不會出現）。有截圖的訊息顯示縮圖，點開燈箱（用 `attachmentUrl` 簽名網址）。
- 底部輸入列：`textarea` +「＋ 截圖」按鈕（`<input type="file" accept="image/png,image/jpeg,image/webp">`）。選檔 → `compressScreenshot` → 顯示待送縮圖（可 ✕ 移除）→ 送出時一起帶。文字可空（純圖訊息）。
- 打開某串時 `issue_thread_get`（自動標記已讀）；**每 20 秒輪詢**一次，卡片收合 / 抽屜關閉即停。`visibilitychange → visible` 時補抓一次。
- 已結案的串仍可送訊息（後端 trigger 會重新開啟）。

### 未讀 badge

- `SupportFab.tsx`（浮動按鈕）改用 `issue_thread_unread_summary().total`。
- 現有的鈴鐺通知中心（`js/app.js` `renderNotificationsList`）：把「回報有新回覆」列為第 4 種來源（`db.fetchIssueThreadUnread()` → 顯示「你的回報有新回覆」，點擊打開回報抽屜到該串）。實作上就是 `Promise.all` 再加一支。

### 管理端 `AdminReportView.tsx` / `AdminReportTable.tsx`

- 清單改呼叫 `issue_admin_thread_list`（分頁 `p_limit/p_offset`，狀態篩選 `p_status`）。每列多一個「會友有新訊息」小紅點（`unreadFromMember`）與訊息數。
- 點一列 → 右側 / 彈層 **對話 pane**：`issue_thread_get` 顯示整串（含內部備註，樣式區隔）、截圖縮圖 + 燈箱、每張圖旁「刪除截圖」（`issue_thread_attachment_delete`）；底部回覆框 +「＋ 截圖」+「內部備註」勾選 + 狀態下拉。
- 回覆走 `issue_thread_post`（可帶圖）；改狀態走 `issue_admin_set_status`（不再直接 `update` `issue_reports`）。
- 匯出 CSV 保留（欄位可加「訊息數 / 最後訊息時間」）。

### `js/db.js`

- 加 `fetchIssueThread` / `postIssueThreadMessage`（可帶 `image`）/ `deleteIssueThreadAttachment` / `markIssueThreadRead` / `fetchIssueThreadUnread` / `fetchAdminIssueThreads` / `setIssueReportStatus` wrapper（比照 `_callDevotionRpc` 的寫法，走 `state.supabase` action / shim）。

### 版本字串

`index.html` 的 `index.css` 與 `js/app.js`、以及 `issue-report-ui.bundle.js` 相關版本一起 bump，例如 `20260903_issue_report_threads`。

---

## 設計取捨（對應三個硬性要求）

### 節省空間

- **文字單則 ≤ 500 字**（沿用既有 constraint）→ 一則約 0.3–0.5 KB。
- **截圖**：每則最多 1 張、前端壓 WebP ≤ 300 KB、bucket 硬上限 512 KB。要傳多張就多則訊息（自然節流）。
- **不存**逐則已讀回條、不存編輯歷史。已讀只有工單上兩個 `timestamptz`。
- `description` 不搬進訊息表（不重複儲存）。
- **自動結案**（管理員回覆後 14 天無回應）避免長尾未結案累積。
- **`issue_threads_purge_messages`**：結案超過 180 天 → 刪訊息列，只留工單殼（`description` / `status` / 時間）；對應 Storage 物件由排程 EF 掃孤兒刪除。統計與 `0077` 試算表不受影響。
- Postgres 對 `text` 自動 TOAST 壓縮；截圖走物件儲存，**不進 DB 備份**。
- 粗估：500 工單 × 平均 6 則 × 0.4 KB ≈ **1.2 MB** 文字；截圖假設 3 成訊息有圖 × 200 KB ≈ **180 MB**，加 purge + 孤兒清理，穩態遠低於此（Supabase 免費額度 1 GB）。

### 好效能

- 索引：`issue_report_messages(report_id, created_at)`（抓串）、`(author_id, created_at)`（頻率限制 / 未讀）、`issue_reports(status, last_message_at DESC)`（管理端清單）。
- 未讀數字用 `EXISTS` 子查詢**只回數字**，不拉任何訊息內文。
- 管理端清單用 RPC 一次組好（分頁 ≤ 100），不是前端抓全部再算。
- 對話串抓取有上限（單串 ≤ 200 則；超過可加 `p_before` 游標分頁，初版不需要）。
- **無 Realtime、無長連線**：只有「開著對話框時每 20 秒一次」的輕量輪詢，關掉就停 → 幾乎零背景負載。
- 新訊息 → 工單本體更新走一支精簡 `AFTER INSERT` trigger，無遞迴。

### 安全

- 正式站全部經 `nlc-data`：**每個 request 用 Logto token 重新驗身**，再以 service role 執行；`p_actor_id` 由伺服器注入，前端傳的會被 `_issue_actor()` 在有 `auth.uid()` 時忽略。
- `author_role` / `author_id` **一律伺服器決定**，前端無法偽造身分或冒充管理員。
- **內部備註**：非管理員永遠讀不到（RPC 過濾 + RLS 政策），也永遠設不了（`p_is_internal AND is_admin`）。
- 每個讀 / 寫 RPC 都先檢查 `is_admin OR report.user_id = actor` → 不會串到別人的工單。
- **頻率限制**（每人每分鐘 10 則）、**單串上限**（200 則）在 RPC 內擋。
- Body 伺服器端再驗長度、剝控制字元；前端 React 預設逸出，管理端一律以 text node 呈現，無 HTML 注入面。
- 狀態轉換白名單化（`issue_admin_set_status`）。
- `issue_report_messages` 開 RLS，dev / localhost 路徑有對應政策（比照 `0030`）。
- `ON DELETE CASCADE`：刪工單 → 訊息一併消失（Storage 物件由排程 EF 掃孤兒清）。
- `autoclose` / `purge` 不對外開放，只由排程呼叫。
- **截圖 bucket 私有**：`public=false` + `allowed_mime_types` + `file_size_limit`。上傳路徑 `<report_id>/<message_id>.<ext>` **由伺服器產生**，前端無法指定；讀取一律短效（300 秒）簽名網址，不落 URL 參數、不快取。上傳前 nlc-data 再驗一次 bytes 與 mime。EXIF 由前端 canvas 重編碼移除。刪附件先驗 `admin 或作者本人`（`issue_thread_drop_attachment`）再刪物件。

---

## 部署順序

1. **SQL editor 跑 `0153_issue_report_conversation.sql`**（建表 + 索引 + RLS + trigger + RPC 函式群 + **建 `issue-report-shots` 私有 bucket** + `metadata.reply` 遷移）。
2. **重新部署 `nlc-data` Edge Function**（`ISSUE_RPC_FUNCTIONS` + 三個 Storage action：`issue_thread_get` / `issue_thread_post` / `issue_thread_attachment_delete`）。
3. **部署前端**（bump 版本字串）。
4. 驗證：
   - 會友：送新回報 → 開「我的歷史與回覆」→ 回一則（含截圖）→ 管理端看到紅點與縮圖。
   - 截圖：點縮圖出燈箱（簽名網址可開）、刪除截圖後 Storage 物件也不見。
   - 管理員：對話 pane 回覆、加內部備註（會友看不到）、改狀態。
   - 未讀 badge：浮動按鈕 + 鈴鐺。
   - 舊回報的 `metadata.reply` 有變成第一則管理員訊息。
5. **部署排程 Edge Function `issue-report-maintenance`**（autoclose + purge + 孤兒物件清理），設每日 Cron。（或用 `pg_cron` 跑前兩者，物件清理仍需這支。）

---

## 對話感 / 發現性強化（2026-09-03 補做）

舊用戶把「回報」當投遞箱，不知道會有回覆、可以回話。已做：

**發現性**
- 泡泡打開時：**有回報過就先進「我的對話」列表**（新用戶才直接進表單）。`IssueReportFab` 開啟前先查 `myReports()` / `unreadSummary()`。
- 送出成功訊息改成：「已送出。管理員的回覆會出現在這個對話裡，你也可以隨時補充訊息或截圖。」送出後直接停在該對話。
- 第一次進任一對話：頂部一次性提示條「我們會在這裡回覆你 👇…」，`localStorage['issue_thread_hint_seen']` 記住。
- 文案：標題「問題回報與對話」、副標「回報後可以在這裡跟我們一來一往討論、補充截圖」、分頁「💬 我的對話」/「＋ 新問題」、泡泡 aria「問題回報與對話」。
- 人在 App 裡、抽屜關著時，未讀從無變有 → `window.showToast("你的回報有新回覆…")`（`IssueReportFab` 每 60s 輪詢 + focus）。

**像對話框**
- 訊息**分組**（同一人 5 分鐘內連續訊息只標一次名字）＋**日期分隔線**（今天／昨天／M月D日），helper 從 `ReportDrawer.tsx` export（`groupMessages` / `dayKey` / `dayLabel` / `clockTime` / `formatWhen`），管理端 pane 共用。
- **「管理員已讀」**：會友最後一則訊息下方，當 `report.adminLastReadAt >= 該訊息時間`。`issue_thread_get`（SQL）多回 `adminLastReadAt` / `memberLastReadAt`（取呼叫前的值）。
- 管理員訊息標「🛡 管理員」，會友訊息不標名。
- 空串顯示系統列「已送出，等待管理員回覆…」。
- 輸入框：圓角、自動長高至 ~5 行（120px 上限）、Cmd/Ctrl+Enter 送出。會友端維持共用 `<Textarea>` primitive（過 font-size 測試）。

## 日後可加（不在初版）

- Web Push（VAPID + 訂閱表 + 發推 Edge Function）→ 關掉 App 也收得到。
- 「＋ 截圖」旁加一顆「擷取目前畫面」= `html2canvas(document.body)`（已全域載入）自動拍當前畫面，版面 bug 更好溝通；走同一條上傳路徑。
- 一則多張截圖（改 child table）。
- 罐頭回覆 / 常見問題自動回覆。
- 「對方正在輸入」「已讀」提示（需要 broadcast 頻道或更密的輪詢）。
- 多管理員指派 / SLA 倒數。
