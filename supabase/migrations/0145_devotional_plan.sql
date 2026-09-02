-- ============================================================================
-- 0145_devotional_plan.sql
--
-- 「每日靈修」= 一種新的計畫類型 plan_kind = 'devotional'。它有起訖日、N 天，
-- 每天的內容是：① 經文進度（passage）② 思想經文（reflections）③ 靈修影片連結。
-- 會友在「計畫」分頁打開它、按日期一天一天看；不上首頁。
--
-- 內容鍵用 day_index（第幾天，1..N，連續無休息日）而非日曆日期——改 start_date
-- 就整體平移、內容不動（未來要延後 / 調整開始日都不會錯位）。
-- 顯示日期 = global_plans.start_date + (day_index - 1)。
--
-- 「暫不開放」：feature flag `daily_devotion` 預設 FALSE。會友端全部 gate 在這旗標；
-- 管理員即使關著也能進管理頁先建內容（get_devotional_plan 對管理者放行）。
-- 「開放未來日期」：每個計畫各自的 rules.devotionFutureOpen（預設 FALSE = 未來日鎖住）。
--
-- 全表 ENABLE RLS 但無 policy —— 只走 service-role + 下面的 RPC。
-- 部署：Supabase SQL editor 執行。nlc-data 需把這 6 支 RPC 加進 allowlist 並重部署。
-- 冪等。
-- ============================================================================

-- ── 1. plan_kind 多一種 ──────────────────────────────────────────────────────
ALTER TABLE public.global_plans
  DROP CONSTRAINT IF EXISTS global_plans_plan_kind_check,
  ADD CONSTRAINT global_plans_plan_kind_check
    CHECK (plan_kind IN ('standard', 'church_campaign', 'church_campaign_stage',
                         'church_campaign_stage_cohort', 'devotional'));

-- ── 2. 每日靈修內容表 ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plan_devotion_days (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  global_plan_id UUID NOT NULL REFERENCES public.global_plans(id) ON DELETE CASCADE,
  day_index      INTEGER NOT NULL CHECK (day_index >= 1),
  passage_label  TEXT NOT NULL DEFAULT '',
  passage_refs   JSONB NOT NULL DEFAULT '[]'::JSONB,   -- [{book,chapterFrom,verseFrom,chapterTo,verseTo}]
  reflections    JSONB NOT NULL DEFAULT '[]'::JSONB,   -- string[]
  video_url      TEXT,
  video_title    TEXT,
  is_published   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (global_plan_id, day_index)
);

CREATE INDEX IF NOT EXISTS idx_plan_devotion_days_plan
  ON public.plan_devotion_days (global_plan_id, day_index);

ALTER TABLE public.plan_devotion_days ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_plan_devotion_days_updated_at ON public.plan_devotion_days;
CREATE TRIGGER set_plan_devotion_days_updated_at
  BEFORE UPDATE ON public.plan_devotion_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_devotion_days TO authenticated, service_role;

-- ── 3. feature flag（預設關 = 暫不開放）─────────────────────────────────────
INSERT INTO public.app_feature_settings (key, enabled, description)
VALUES ('daily_devotion', FALSE,
        '控制「每日靈修」計畫對會友的顯示，以及管理端的每日靈修編輯。')
ON CONFLICT (key) DO NOTHING;

-- ── 4. helper：誰能管理靈修內容（admin / pastor）────────────────────────────
CREATE OR REPLACE FUNCTION public._devotion_actor_can_manage(p_actor_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.role_code((SELECT role_id FROM public.profiles WHERE id = p_actor_id))
         IN ('admin', 'pastor');
$$;
REVOKE ALL ON FUNCTION public._devotion_actor_can_manage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._devotion_actor_can_manage(uuid) TO authenticated, service_role;

-- ── 5. 會友：取一份靈修計畫（meta + 已發佈的每日內容）───────────────────────
CREATE OR REPLACE FUNCTION public.get_devotional_plan(
  p_global_plan_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id    UUID := public.resolve_quiz_actor(p_actor_id);
  is_mgr      BOOLEAN := public._devotion_actor_can_manage(actor_id);
  gp          public.global_plans%ROWTYPE;
  future_open BOOLEAN;
  today_tw    DATE := (NOW() AT TIME ZONE 'Asia/Taipei')::DATE;
  days        JSONB;
BEGIN
  IF NOT public.is_feature_enabled('daily_devotion') AND NOT is_mgr THEN
    RAISE EXCEPTION 'daily_devotion_feature_disabled';
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

-- ── 6. 管理：列出一份計畫的所有每日內容（含未發佈）──────────────────────────
CREATE OR REPLACE FUNCTION public.list_devotion_days(
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
  IF NOT public._devotion_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'devotion_admin_required';
  END IF;
  SELECT * INTO gp FROM public.global_plans
  WHERE id = p_global_plan_id AND plan_kind = 'devotional';
  IF NOT FOUND THEN RAISE EXCEPTION 'devotional_plan_not_found'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',           d.id,
    'dayIndex',     d.day_index,
    'displayDate',  (gp.start_date + (d.day_index - 1))::TEXT,
    'passageLabel', d.passage_label,
    'passageRefs',  d.passage_refs,
    'reflections',  d.reflections,
    'videoUrl',     d.video_url,
    'videoTitle',   d.video_title,
    'isPublished',  d.is_published
  ) ORDER BY d.day_index), '[]'::jsonb)
  INTO rows_j
  FROM public.plan_devotion_days d
  WHERE d.global_plan_id = gp.id;

  RETURN jsonb_build_object(
    'planId',     gp.id,
    'name',       gp.name,
    'startDate',  gp.start_date::TEXT,
    'endDate',    gp.end_date::TEXT,
    'futureOpen', COALESCE((gp.rules ->> 'devotionFutureOpen')::BOOLEAN, FALSE),
    'days',       rows_j
  );
END;
$$;

-- ── 7. 管理：新增 / 更新一天 ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_devotion_day(
  p_payload JSONB,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  v_plan   UUID := (p_payload ->> 'globalPlanId')::UUID;
  v_day    INT  := (p_payload ->> 'dayIndex')::INT;
  v_id     UUID;
BEGIN
  IF NOT public._devotion_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'devotion_admin_required';
  END IF;
  IF v_plan IS NULL OR v_day IS NULL OR v_day < 1 THEN
    RAISE EXCEPTION 'devotion_payload_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_plans
                 WHERE id = v_plan AND plan_kind = 'devotional') THEN
    RAISE EXCEPTION 'devotional_plan_not_found';
  END IF;

  INSERT INTO public.plan_devotion_days
    (global_plan_id, day_index, passage_label, passage_refs, reflections,
     video_url, video_title, is_published, created_by, updated_by)
  VALUES (
    v_plan, v_day,
    COALESCE(p_payload ->> 'passageLabel', ''),
    COALESCE(p_payload -> 'passageRefs', '[]'::jsonb),
    COALESCE(p_payload -> 'reflections', '[]'::jsonb),
    NULLIF(BTRIM(COALESCE(p_payload ->> 'videoUrl', '')), ''),
    NULLIF(BTRIM(COALESCE(p_payload ->> 'videoTitle', '')), ''),
    COALESCE((p_payload ->> 'isPublished')::BOOLEAN, FALSE),
    actor_id, actor_id
  )
  ON CONFLICT (global_plan_id, day_index) DO UPDATE SET
    passage_label = EXCLUDED.passage_label,
    passage_refs  = EXCLUDED.passage_refs,
    reflections   = EXCLUDED.reflections,
    video_url     = EXCLUDED.video_url,
    video_title   = EXCLUDED.video_title,
    is_published  = EXCLUDED.is_published,
    updated_by    = actor_id,
    updated_at    = NOW()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'globalPlanId', v_plan, 'dayIndex', v_day);
END;
$$;

-- ── 8. 管理：刪除一天 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_devotion_day(
  p_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF NOT public._devotion_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'devotion_admin_required';
  END IF;
  DELETE FROM public.plan_devotion_days WHERE id = p_id;
  RETURN jsonb_build_object('deleted', FOUND);
END;
$$;

-- ── 9. 管理：批次匯入（貼手冊文字解析後傳一整批）────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_upsert_devotion_days(
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
  v_day    INT;
  n        INT := 0;
BEGIN
  IF NOT public._devotion_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'devotion_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_plans
                 WHERE id = p_global_plan_id AND plan_kind = 'devotional') THEN
    RAISE EXCEPTION 'devotional_plan_not_found';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'devotion_payload_invalid';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_day := (r ->> 'dayIndex')::INT;
    CONTINUE WHEN v_day IS NULL OR v_day < 1;
    INSERT INTO public.plan_devotion_days
      (global_plan_id, day_index, passage_label, passage_refs, reflections,
       video_url, video_title, is_published, created_by, updated_by)
    VALUES (
      p_global_plan_id, v_day,
      COALESCE(r ->> 'passageLabel', ''),
      COALESCE(r -> 'passageRefs', '[]'::jsonb),
      COALESCE(r -> 'reflections', '[]'::jsonb),
      NULLIF(BTRIM(COALESCE(r ->> 'videoUrl', '')), ''),
      NULLIF(BTRIM(COALESCE(r ->> 'videoTitle', '')), ''),
      COALESCE((r ->> 'isPublished')::BOOLEAN, FALSE),
      actor_id, actor_id
    )
    ON CONFLICT (global_plan_id, day_index) DO UPDATE SET
      passage_label = EXCLUDED.passage_label,
      passage_refs  = EXCLUDED.passage_refs,
      reflections   = EXCLUDED.reflections,
      video_url     = COALESCE(EXCLUDED.video_url, public.plan_devotion_days.video_url),
      video_title   = COALESCE(EXCLUDED.video_title, public.plan_devotion_days.video_title),
      is_published  = EXCLUDED.is_published,
      updated_by    = actor_id,
      updated_at    = NOW();
    n := n + 1;
  END LOOP;

  RETURN jsonb_build_object('upserted', n);
END;
$$;

-- ── 10. 管理：切換「開放未來日期」──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_devotional_plan_future_open(
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
  IF NOT public._devotion_actor_can_manage(actor_id) THEN
    RAISE EXCEPTION 'devotion_admin_required';
  END IF;
  UPDATE public.global_plans
  SET rules = COALESCE(rules, '{}'::jsonb)
              || jsonb_build_object('devotionFutureOpen', COALESCE(p_open, FALSE))
  WHERE id = p_global_plan_id AND plan_kind = 'devotional';
  IF NOT FOUND THEN RAISE EXCEPTION 'devotional_plan_not_found'; END IF;
  RETURN jsonb_build_object('planId', p_global_plan_id, 'futureOpen', COALESCE(p_open, FALSE));
END;
$$;

-- ── 權限 ───────────────────────────────────────────────────────────────────
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'get_devotional_plan(uuid, uuid)',
    'list_devotion_days(uuid, uuid)',
    'upsert_devotion_day(jsonb, uuid)',
    'delete_devotion_day(uuid, uuid)',
    'bulk_upsert_devotion_days(uuid, jsonb, uuid)',
    'set_devotional_plan_future_open(uuid, boolean, uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
