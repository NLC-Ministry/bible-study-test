-- ============================================================================
-- 0156_devotion_group_features_master.sql
--
-- 「每日靈修」「小組聚會週計畫」原本是兩個「全教會共用一個開關」的功能旗標
-- （daily_devotion / group_meeting_plan）。這裡改成「每個會友各自一份」的偏好：
--
--   ① 管理分頁「功能設定」總開關（devotion_group_features_master，admin 專屬）：
--      關閉 → 沒有任何會友摸得到這兩個功能，「個人」分頁完全不會出現「功能
--             設定」這一排；同時強制清空所有會友已經自己開啟的個人偏好。
--      開啟 → 「個人」分頁所有人都會多出「功能設定」這一排，但不會幫任何人
--             預設打開，要自己再進去開。
--   ② 個人分頁「功能設定」子頁面（僅在①開啟時對所有會友顯示）：每個人自己
--      的「每日靈修」「小組經營」開關，存在 profile_feature_preferences，
--      一人一筆，互不影響。
--
-- daily_devotion / group_meeting_plan 這兩個舊的全域旗標 key 保留在
-- app_feature_settings（不刪，避免影響舊資料），但不再有任何地方寫入或依賴
-- 它們判斷會友端可見度——get_devotional_plan / get_group_meeting_plan 改成
-- 檢查「總開關 AND 這個人自己的偏好」。
--
-- 部署：Supabase SQL editor 執行；因為改了 get_devotional_plan /
-- get_group_meeting_plan 的函式定義，需要把新的 3 支 RPC 加進 nlc-data 的
-- allowlist 並重新部署（supabase/functions/nlc-data/index.ts）。
-- 冪等。
-- ============================================================================

-- ── 1. 每人一份的功能偏好表 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profile_feature_preferences (
  profile_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL CHECK (feature_key IN ('daily_devotion', 'group_meeting_plan')),
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, feature_key)
);

ALTER TABLE public.profile_feature_preferences ENABLE ROW LEVEL SECURITY;
-- 全表沒有 RLS policy —— 只走下面的 RPC + service-role（沿用整個 app 現有模式）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_feature_preferences TO authenticated, service_role;

-- ── 2. 總開關（沿用既有 app_feature_settings 機制，預設關閉）────────────────
INSERT INTO public.app_feature_settings (key, enabled, description)
VALUES ('devotion_group_features_master', FALSE,
        '每日靈修／小組聚會週計畫「功能設定」總開關：關閉時個人分頁不會出現「功能設定」，且會清空所有會友的個人偏好；開啟後不會幫任何人預設打開。')
ON CONFLICT (key) DO NOTHING;

-- ── 3. 會友：讀自己的偏好 + 總開關狀態 ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_devotion_group_preferences(
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id         UUID := public.resolve_quiz_actor(p_actor_id);
  master_enabled   BOOLEAN;
  devotion_enabled BOOLEAN;
  group_enabled    BOOLEAN;
BEGIN
  SELECT enabled INTO master_enabled
  FROM public.app_feature_settings WHERE key = 'devotion_group_features_master';

  SELECT enabled INTO devotion_enabled
  FROM public.profile_feature_preferences
  WHERE profile_id = actor_id AND feature_key = 'daily_devotion';

  SELECT enabled INTO group_enabled
  FROM public.profile_feature_preferences
  WHERE profile_id = actor_id AND feature_key = 'group_meeting_plan';

  RETURN jsonb_build_object(
    'masterEnabled',   COALESCE(master_enabled, FALSE),
    'dailyDevotion',   COALESCE(devotion_enabled, FALSE),
    'groupMeetingPlan', COALESCE(group_enabled, FALSE)
  );
END;
$$;

-- ── 4. 會友：改自己的偏好（一定是自己那筆，沒有目標使用者參數）────────────
CREATE OR REPLACE FUNCTION public.set_my_devotion_group_preference(
  p_feature_key TEXT,
  p_enabled BOOLEAN,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id       UUID := public.resolve_quiz_actor(p_actor_id);
  master_enabled BOOLEAN;
BEGIN
  IF p_feature_key NOT IN ('daily_devotion', 'group_meeting_plan') THEN
    RAISE EXCEPTION 'invalid_feature_key';
  END IF;

  IF COALESCE(p_enabled, FALSE) THEN
    SELECT enabled INTO master_enabled
    FROM public.app_feature_settings WHERE key = 'devotion_group_features_master';
    IF COALESCE(master_enabled, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'devotion_group_features_master_disabled';
    END IF;
  END IF;

  INSERT INTO public.profile_feature_preferences (profile_id, feature_key, enabled)
  VALUES (actor_id, p_feature_key, COALESCE(p_enabled, FALSE))
  ON CONFLICT (profile_id, feature_key) DO UPDATE
    SET enabled = EXCLUDED.enabled, updated_at = NOW();

  RETURN jsonb_build_object('featureKey', p_feature_key, 'enabled', COALESCE(p_enabled, FALSE));
END;
$$;

-- ── 5. 管理員：切換總開關 ───────────────────────────────────────────────────
-- 關閉 → 一併清空所有會友的個人偏好（DELETE，等同全部重設回關閉）。
-- 開啟 → 只開總開關本身，不對任何人的個人偏好做事（不預設打開）。
CREATE OR REPLACE FUNCTION public.set_devotion_group_features_master(
  p_enabled BOOLEAN,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id    UUID := public.resolve_quiz_actor(p_actor_id);
  actor_admin BOOLEAN;
  reset_count INT := 0;
BEGIN
  SELECT public.role_code((SELECT role_id FROM public.profiles WHERE id = actor_id)) = 'admin'
  INTO actor_admin;
  IF NOT COALESCE(actor_admin, FALSE) THEN
    RAISE EXCEPTION 'devotion_group_master_admin_required';
  END IF;

  UPDATE public.app_feature_settings
  SET enabled = COALESCE(p_enabled, FALSE)
  WHERE key = 'devotion_group_features_master';

  IF NOT COALESCE(p_enabled, FALSE) THEN
    WITH deleted AS (
      DELETE FROM public.profile_feature_preferences
      WHERE feature_key IN ('daily_devotion', 'group_meeting_plan')
      RETURNING 1
    )
    SELECT COUNT(*) INTO reset_count FROM deleted;
  END IF;

  RETURN jsonb_build_object('enabled', COALESCE(p_enabled, FALSE), 'resetCount', reset_count);
END;
$$;

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'get_my_devotion_group_preferences(uuid)',
    'set_my_devotion_group_preference(text, boolean, uuid)',
    'set_devotion_group_features_master(boolean, uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;

-- ── 6. get_devotional_plan（0145）改成看「總開關 AND 這個人自己的偏好」──────
-- 其餘欄位/邏輯跟 0145 完全一樣，只換掉可見度判斷那一段。
CREATE OR REPLACE FUNCTION public.get_devotional_plan(
  p_global_plan_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id       UUID := public.resolve_quiz_actor(p_actor_id);
  is_mgr         BOOLEAN := public._devotion_actor_can_manage(actor_id);
  master_enabled BOOLEAN;
  my_pref        BOOLEAN;
  gp             public.global_plans%ROWTYPE;
  future_open    BOOLEAN;
  today_tw       DATE := (NOW() AT TIME ZONE 'Asia/Taipei')::DATE;
  days           JSONB;
BEGIN
  IF NOT is_mgr THEN
    SELECT enabled INTO master_enabled
    FROM public.app_feature_settings WHERE key = 'devotion_group_features_master';
    SELECT enabled INTO my_pref
    FROM public.profile_feature_preferences
    WHERE profile_id = actor_id AND feature_key = 'daily_devotion';
    IF COALESCE(master_enabled, FALSE) IS NOT TRUE OR COALESCE(my_pref, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'daily_devotion_feature_disabled';
    END IF;
  END IF;

  SELECT * INTO gp FROM public.global_plans
  WHERE id = p_global_plan_id AND plan_kind = 'devotional';
  IF NOT FOUND THEN RAISE EXCEPTION 'devotional_plan_not_found'; END IF;

  future_open := COALESCE((gp.rules ->> 'devotionFutureOpen')::BOOLEAN, FALSE);

  SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'dayIndex')::INT), '[]'::jsonb)
  INTO days
  FROM (
    SELECT jsonb_build_object(
      'dayIndex',     d.day_index,
      'displayDate',  (gp.start_date + (d.day_index - 1))::TEXT,
      'passageLabel', d.passage_label,
      'passageRefs',  d.passage_refs,
      'reflections',  d.reflections,
      'videoUrl',     d.video_url,
      'videoTitle',   d.video_title,
      'isPublished',  d.is_published,
      'locked', (NOT is_mgr AND NOT future_open
                 AND (gp.start_date + (d.day_index - 1)) > today_tw)
    ) AS x
    FROM public.plan_devotion_days d
    WHERE d.global_plan_id = gp.id
      AND (d.is_published OR is_mgr)
  ) sub;

  RETURN jsonb_build_object(
    'planId',      gp.id,
    'name',        gp.name,
    'description',  gp.description,
    'startDate',   gp.start_date::TEXT,
    'endDate',     gp.end_date::TEXT,
    'futureOpen',  future_open,
    'today',       today_tw::TEXT,
    'isManager',   is_mgr,
    'days',        days
  );
END;
$$;

-- ── 7. get_group_meeting_plan（0148）比照辦理 ──────────────────────────────
CREATE OR REPLACE FUNCTION public.get_group_meeting_plan(
  p_global_plan_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id       UUID := public.resolve_quiz_actor(p_actor_id);
  is_mgr         BOOLEAN := public._group_meeting_actor_can_manage(actor_id);
  master_enabled BOOLEAN;
  my_pref        BOOLEAN;
  gp             public.global_plans%ROWTYPE;
  future_open    BOOLEAN;
  today_tw       DATE := (NOW() AT TIME ZONE 'Asia/Taipei')::DATE;
  weeks          JSONB;
BEGIN
  IF NOT is_mgr THEN
    SELECT enabled INTO master_enabled
    FROM public.app_feature_settings WHERE key = 'devotion_group_features_master';
    SELECT enabled INTO my_pref
    FROM public.profile_feature_preferences
    WHERE profile_id = actor_id AND feature_key = 'group_meeting_plan';
    IF COALESCE(master_enabled, FALSE) IS NOT TRUE OR COALESCE(my_pref, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'group_meeting_feature_disabled';
    END IF;
  END IF;

  SELECT * INTO gp FROM public.global_plans
  WHERE id = p_global_plan_id AND plan_kind = 'group_meeting';
  IF NOT FOUND THEN RAISE EXCEPTION 'group_meeting_plan_not_found'; END IF;

  future_open := COALESCE((gp.rules ->> 'groupMeetingFutureOpen')::BOOLEAN, FALSE);

  SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'weekIndex')::INT), '[]'::jsonb)
  INTO weeks
  FROM (
    SELECT jsonb_build_object(
      'weekIndex',            w.week_index,
      'dateLabel',            w.date_label,
      'weekStart',            (gp.start_date + (w.week_index - 1) * 7)::TEXT,
      'weekEnd',              (gp.start_date + (w.week_index - 1) * 7 + 6)::TEXT,
      'isThisWeek',           (today_tw BETWEEN (gp.start_date + (w.week_index - 1) * 7)
                                            AND (gp.start_date + (w.week_index - 1) * 7 + 6)),
      'isPast',               ((gp.start_date + (w.week_index - 1) * 7 + 6) < today_tw),
      'monthTheme',           w.month_theme,
      'messageTopic',         w.message_topic,
      'messagePassageLabel',  w.message_passage_label,
      'messagePassageRefs',   w.message_passage_refs,
      'offeringTopic',        w.offering_topic,
      'offeringPassageLabel', w.offering_passage_label,
      'offeringPassageRefs',  w.offering_passage_refs,
      'songs',                w.songs,
      'note',                 w.note,
      'isPublished',          w.is_published,
      'locked', (NOT is_mgr AND NOT future_open
                 AND (gp.start_date + (w.week_index - 1) * 7) > today_tw)
    ) AS x
    FROM public.plan_group_meeting_weeks w
    WHERE w.global_plan_id = gp.id
      AND (w.is_published OR is_mgr)
  ) sub;

  RETURN jsonb_build_object(
    'planId',      gp.id,
    'name',        gp.name,
    'description', gp.description,
    'startDate',   gp.start_date::TEXT,
    'endDate',     gp.end_date::TEXT,
    'futureOpen',  future_open,
    'today',       today_tw::TEXT,
    'isManager',   is_mgr,
    'weeks',       weeks
  );
END;
$$;
