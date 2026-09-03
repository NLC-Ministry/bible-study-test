-- 0152_devotion_day_title.sql
--
-- 每日靈修：每天多一個「主題 / 標題」欄位（例：「等候所應許的」「耶穌被接升天」）。
-- 手冊原文標頭本來就有（「8/22（六） 徒1:1~5 等候所應許的」），只是先前
-- 批次匯入時被丟掉、schema 也沒有欄位。這支補上欄位並讓 4 支 RPC 讀寫它。
--
-- 只 ALTER + CREATE OR REPLACE，函式簽章不變 → 既有 GRANT 不受影響。
-- 冪等，可重複執行。

BEGIN;

ALTER TABLE public.plan_devotion_days
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

------------------------------------------------------------------------
-- 會友：取一份靈修計畫（meta + 已發佈的每日內容）  ── 加 'title'
------------------------------------------------------------------------
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
      'title',        d.title,
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

------------------------------------------------------------------------
-- 管理：列出一份計畫的所有每日內容（含未發佈）  ── 加 'title'
------------------------------------------------------------------------
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
    'title',        d.title,
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

------------------------------------------------------------------------
-- 管理：新增 / 更新一天  ── 寫入 title
------------------------------------------------------------------------
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
    (global_plan_id, day_index, title, passage_label, passage_refs, reflections,
     video_url, video_title, is_published, created_by, updated_by)
  VALUES (
    v_plan, v_day,
    BTRIM(COALESCE(p_payload ->> 'title', '')),
    COALESCE(p_payload ->> 'passageLabel', ''),
    COALESCE(p_payload -> 'passageRefs', '[]'::jsonb),
    COALESCE(p_payload -> 'reflections', '[]'::jsonb),
    NULLIF(BTRIM(COALESCE(p_payload ->> 'videoUrl', '')), ''),
    NULLIF(BTRIM(COALESCE(p_payload ->> 'videoTitle', '')), ''),
    COALESCE((p_payload ->> 'isPublished')::BOOLEAN, FALSE),
    actor_id, actor_id
  )
  ON CONFLICT (global_plan_id, day_index) DO UPDATE SET
    title         = EXCLUDED.title,
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

------------------------------------------------------------------------
-- 管理：批次匯入  ── 寫入 title（沿用「非空才覆蓋」的保守合併）
------------------------------------------------------------------------
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
      (global_plan_id, day_index, title, passage_label, passage_refs, reflections,
       video_url, video_title, is_published, created_by, updated_by)
    VALUES (
      p_global_plan_id, v_day,
      BTRIM(COALESCE(r ->> 'title', '')),
      COALESCE(r ->> 'passageLabel', ''),
      COALESCE(r -> 'passageRefs', '[]'::jsonb),
      COALESCE(r -> 'reflections', '[]'::jsonb),
      NULLIF(BTRIM(COALESCE(r ->> 'videoUrl', '')), ''),
      NULLIF(BTRIM(COALESCE(r ->> 'videoTitle', '')), ''),
      COALESCE((r ->> 'isPublished')::BOOLEAN, FALSE),
      actor_id, actor_id
    )
    ON CONFLICT (global_plan_id, day_index) DO UPDATE SET
      title         = COALESCE(NULLIF(EXCLUDED.title, ''), public.plan_devotion_days.title),
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

COMMIT;
