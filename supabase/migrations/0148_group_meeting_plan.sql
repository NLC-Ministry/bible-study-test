-- ============================================================================
-- 0148_group_meeting_plan.sql
--
-- 「小組聚會經營」= 一種新的計畫類型 plan_kind = 'group_meeting'。週為單位，
-- 每週三塊：① 信息經文（小組經文）② 奉獻經文（可空，九月整月沒有）
-- ③ 敬拜讚美詩歌（歌本編號＋歌名）。另有每月月主題、每週小標、備註（Pastor Greg 特會）。
--
-- 內容鍵用 week_index（第幾週，1..N，連續）。日期不綁死：畫面顯示用 date_label
-- （「7/1–7/2」照教會材料）；日曆以「一週 Sun–Sat」呈現，
-- 第 N 週的日～六 = global_plans.start_date（W1 那個 Sun–Sat 週的週日）+ (week_index-1)*7。
--
-- feature flag `group_meeting_plan` 預設 FALSE（暫不開放）。會友端全 gate 在旗標；
-- 管理員即使關著也能進管理頁先建內容。每計畫各自的 rules.groupMeetingFutureOpen。
--
-- 全表 ENABLE RLS 但無 policy —— 只走 service-role + 下面的 RPC。冪等。
-- 部署：Supabase SQL editor 執行。nlc-data 需把這 6 支 RPC 加進 allowlist 並重部署。
-- ============================================================================

-- ── 1. plan_kind 多一種 ──────────────────────────────────────────────────────
ALTER TABLE public.global_plans
  DROP CONSTRAINT IF EXISTS global_plans_plan_kind_check,
  ADD CONSTRAINT global_plans_plan_kind_check
    CHECK (plan_kind IN ('standard', 'church_campaign', 'church_campaign_stage',
                         'church_campaign_stage_cohort', 'devotional', 'group_meeting'));

-- ── 2. 小組聚會每週內容表 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plan_group_meeting_weeks (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  global_plan_id         UUID NOT NULL REFERENCES public.global_plans(id) ON DELETE CASCADE,
  week_index             INTEGER NOT NULL CHECK (week_index >= 1),
  date_label             TEXT NOT NULL DEFAULT '',           -- 顯示用「7/1–7/2」
  month_theme            TEXT NOT NULL DEFAULT '',           -- 該月月主題
  message_topic          TEXT NOT NULL DEFAULT '',           -- 信息經文小標
  message_passage_label  TEXT NOT NULL DEFAULT '',
  message_passage_refs   JSONB NOT NULL DEFAULT '[]'::JSONB, -- [{book,chapterFrom,verseFrom,chapterTo,verseTo}]
  offering_topic         TEXT NOT NULL DEFAULT '',           -- 奉獻經文小標（可空）
  offering_passage_label TEXT NOT NULL DEFAULT '',
  offering_passage_refs  JSONB NOT NULL DEFAULT '[]'::JSONB,
  songs                  JSONB NOT NULL DEFAULT '[]'::JSONB, -- [{code,title}]
  note                   TEXT,                               -- Pastor Greg 特會…等
  is_published           BOOLEAN NOT NULL DEFAULT FALSE,
  created_by             UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by             UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (global_plan_id, week_index)
);

CREATE INDEX IF NOT EXISTS idx_plan_group_meeting_weeks_plan
  ON public.plan_group_meeting_weeks (global_plan_id, week_index);

ALTER TABLE public.plan_group_meeting_weeks ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_plan_group_meeting_weeks_updated_at ON public.plan_group_meeting_weeks;
CREATE TRIGGER set_plan_group_meeting_weeks_updated_at
  BEFORE UPDATE ON public.plan_group_meeting_weeks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_group_meeting_weeks TO authenticated, service_role;

-- ── 3. feature flag（預設關 = 暫不開放）─────────────────────────────────────
INSERT INTO public.app_feature_settings (key, enabled, description)
VALUES ('group_meeting_plan', FALSE,
        '控制「小組聚會經營」週計畫對會友的顯示，以及管理端的每週內容編輯。')
ON CONFLICT (key) DO NOTHING;

-- ── 4. helper：誰能管理小組聚會內容（admin / pastor）───────────────────────
CREATE OR REPLACE FUNCTION public._group_meeting_actor_can_manage(p_actor_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.role_code((SELECT role_id FROM public.profiles WHERE id = p_actor_id))
         IN ('admin', 'pastor');
$$;
REVOKE ALL ON FUNCTION public._group_meeting_actor_can_manage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._group_meeting_actor_can_manage(uuid) TO authenticated, service_role;

-- ── 5. 會友：取一份小組聚會計畫（meta + 已發佈的每週內容）───────────────────
CREATE OR REPLACE FUNCTION public.get_group_meeting_plan(
  p_global_plan_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id    UUID := public.resolve_quiz_actor(p_actor_id);
  is_mgr      BOOLEAN := public._group_meeting_actor_can_manage(actor_id);
  gp          public.global_plans%ROWTYPE;
  future_open BOOLEAN;
  today_tw    DATE := (NOW() AT TIME ZONE 'Asia/Taipei')::DATE;
  weeks       JSONB;
BEGIN
  IF NOT public.is_feature_enabled('group_meeting_plan') AND NOT is_mgr THEN
    RAISE EXCEPTION 'group_meeting_feature_disabled';
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

-- ── 6. 管理：列出一份計畫的所有每週內容（含未發佈）─────────────────────────
CREATE OR REPLACE FUNCTION public.list_group_meeting_weeks(
  p_global_plan_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  gp       public.global_plans%ROWTYPE;
  rows_j   JSONB;
BEGIN
  IF NOT public._group_meeting_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'group_meeting_admin_required';
  END IF;
  SELECT * INTO gp FROM public.global_plans
  WHERE id = p_global_plan_id AND plan_kind = 'group_meeting';
  IF NOT FOUND THEN RAISE EXCEPTION 'group_meeting_plan_not_found'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',                   w.id,
    'weekIndex',            w.week_index,
    'dateLabel',            w.date_label,
    'weekStart',            (gp.start_date + (w.week_index - 1) * 7)::TEXT,
    'monthTheme',           w.month_theme,
    'messageTopic',         w.message_topic,
    'messagePassageLabel',  w.message_passage_label,
    'messagePassageRefs',   w.message_passage_refs,
    'offeringTopic',        w.offering_topic,
    'offeringPassageLabel', w.offering_passage_label,
    'offeringPassageRefs',  w.offering_passage_refs,
    'songs',                w.songs,
    'note',                 w.note,
    'isPublished',          w.is_published
  ) ORDER BY w.week_index), '[]'::jsonb)
  INTO rows_j
  FROM public.plan_group_meeting_weeks w
  WHERE w.global_plan_id = gp.id;

  RETURN jsonb_build_object(
    'planId',     gp.id,
    'name',       gp.name,
    'startDate',  gp.start_date::TEXT,
    'endDate',    gp.end_date::TEXT,
    'futureOpen', COALESCE((gp.rules ->> 'groupMeetingFutureOpen')::BOOLEAN, FALSE),
    'weeks',      rows_j
  );
END;
$$;

-- ── 7. 管理：新增 / 更新一週 ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_group_meeting_week(
  p_payload JSONB,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  v_plan   UUID := (p_payload ->> 'globalPlanId')::UUID;
  v_week   INT  := (p_payload ->> 'weekIndex')::INT;
  v_id     UUID;
BEGIN
  IF NOT public._group_meeting_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'group_meeting_admin_required';
  END IF;
  IF v_plan IS NULL OR v_week IS NULL OR v_week < 1 THEN
    RAISE EXCEPTION 'group_meeting_payload_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_plans
                 WHERE id = v_plan AND plan_kind = 'group_meeting') THEN
    RAISE EXCEPTION 'group_meeting_plan_not_found';
  END IF;

  INSERT INTO public.plan_group_meeting_weeks
    (global_plan_id, week_index, date_label, month_theme,
     message_topic, message_passage_label, message_passage_refs,
     offering_topic, offering_passage_label, offering_passage_refs,
     songs, note, is_published, created_by, updated_by)
  VALUES (
    v_plan, v_week,
    COALESCE(p_payload ->> 'dateLabel', ''),
    COALESCE(p_payload ->> 'monthTheme', ''),
    COALESCE(p_payload ->> 'messageTopic', ''),
    COALESCE(p_payload ->> 'messagePassageLabel', ''),
    COALESCE(p_payload -> 'messagePassageRefs', '[]'::jsonb),
    COALESCE(p_payload ->> 'offeringTopic', ''),
    COALESCE(p_payload ->> 'offeringPassageLabel', ''),
    COALESCE(p_payload -> 'offeringPassageRefs', '[]'::jsonb),
    COALESCE(p_payload -> 'songs', '[]'::jsonb),
    NULLIF(BTRIM(COALESCE(p_payload ->> 'note', '')), ''),
    COALESCE((p_payload ->> 'isPublished')::BOOLEAN, FALSE),
    actor_id, actor_id
  )
  ON CONFLICT (global_plan_id, week_index) DO UPDATE SET
    date_label             = EXCLUDED.date_label,
    month_theme            = EXCLUDED.month_theme,
    message_topic          = EXCLUDED.message_topic,
    message_passage_label  = EXCLUDED.message_passage_label,
    message_passage_refs   = EXCLUDED.message_passage_refs,
    offering_topic         = EXCLUDED.offering_topic,
    offering_passage_label = EXCLUDED.offering_passage_label,
    offering_passage_refs  = EXCLUDED.offering_passage_refs,
    songs                  = EXCLUDED.songs,
    note                   = EXCLUDED.note,
    is_published           = EXCLUDED.is_published,
    updated_by             = actor_id,
    updated_at             = NOW()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'globalPlanId', v_plan, 'weekIndex', v_week);
END;
$$;

-- ── 8. 管理：刪除一週 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_group_meeting_week(
  p_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF NOT public._group_meeting_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'group_meeting_admin_required';
  END IF;
  DELETE FROM public.plan_group_meeting_weeks WHERE id = p_id;
  RETURN jsonb_build_object('deleted', FOUND);
END;
$$;

-- ── 9. 管理：批次匯入 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_upsert_group_meeting_weeks(
  p_global_plan_id UUID,
  p_rows JSONB,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  r        JSONB;
  v_week   INT;
  n        INT := 0;
BEGIN
  IF NOT public._group_meeting_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'group_meeting_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_plans
                 WHERE id = p_global_plan_id AND plan_kind = 'group_meeting') THEN
    RAISE EXCEPTION 'group_meeting_plan_not_found';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'group_meeting_payload_invalid';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_week := (r ->> 'weekIndex')::INT;
    CONTINUE WHEN v_week IS NULL OR v_week < 1;
    INSERT INTO public.plan_group_meeting_weeks
      (global_plan_id, week_index, date_label, month_theme,
       message_topic, message_passage_label, message_passage_refs,
       offering_topic, offering_passage_label, offering_passage_refs,
       songs, note, is_published, created_by, updated_by)
    VALUES (
      p_global_plan_id, v_week,
      COALESCE(r ->> 'dateLabel', ''),
      COALESCE(r ->> 'monthTheme', ''),
      COALESCE(r ->> 'messageTopic', ''),
      COALESCE(r ->> 'messagePassageLabel', ''),
      COALESCE(r -> 'messagePassageRefs', '[]'::jsonb),
      COALESCE(r ->> 'offeringTopic', ''),
      COALESCE(r ->> 'offeringPassageLabel', ''),
      COALESCE(r -> 'offeringPassageRefs', '[]'::jsonb),
      COALESCE(r -> 'songs', '[]'::jsonb),
      NULLIF(BTRIM(COALESCE(r ->> 'note', '')), ''),
      COALESCE((r ->> 'isPublished')::BOOLEAN, FALSE),
      actor_id, actor_id
    )
    ON CONFLICT (global_plan_id, week_index) DO UPDATE SET
      date_label             = EXCLUDED.date_label,
      month_theme            = EXCLUDED.month_theme,
      message_topic          = EXCLUDED.message_topic,
      message_passage_label  = EXCLUDED.message_passage_label,
      message_passage_refs   = EXCLUDED.message_passage_refs,
      offering_topic         = EXCLUDED.offering_topic,
      offering_passage_label = EXCLUDED.offering_passage_label,
      offering_passage_refs  = EXCLUDED.offering_passage_refs,
      songs                  = EXCLUDED.songs,
      note                   = EXCLUDED.note,
      is_published           = EXCLUDED.is_published,
      updated_by             = actor_id,
      updated_at             = NOW();
    n := n + 1;
  END LOOP;

  RETURN jsonb_build_object('upserted', n);
END;
$$;

-- ── 10. 管理：切換「開放未來週次」───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_group_meeting_plan_future_open(
  p_global_plan_id UUID,
  p_open BOOLEAN,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF NOT public._group_meeting_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'group_meeting_admin_required';
  END IF;
  UPDATE public.global_plans
  SET rules = COALESCE(rules, '{}'::jsonb)
              || jsonb_build_object('groupMeetingFutureOpen', COALESCE(p_open, FALSE))
  WHERE id = p_global_plan_id AND plan_kind = 'group_meeting';
  IF NOT FOUND THEN RAISE EXCEPTION 'group_meeting_plan_not_found'; END IF;
  RETURN jsonb_build_object('planId', p_global_plan_id, 'futureOpen', COALESCE(p_open, FALSE));
END;
$$;

-- ── 權限 ───────────────────────────────────────────────────────────────────
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'get_group_meeting_plan(uuid, uuid)',
    'list_group_meeting_weeks(uuid, uuid)',
    'upsert_group_meeting_week(jsonb, uuid)',
    'delete_group_meeting_week(uuid, uuid)',
    'bulk_upsert_group_meeting_weeks(uuid, jsonb, uuid)',
    'set_group_meeting_plan_future_open(uuid, boolean, uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
