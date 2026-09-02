-- ============================================================================
-- 0149_reading_team_audit.sql — 團隊異動稽核（診斷「加入成功、隔天又退回」）
--
-- 症狀：組員用邀請碼加入團隊、看到成功畫面，隔一段時間卻又不在團隊裡，像退回
-- 加入前的狀態。靜態程式碼查不到兇手（沒有排程、沒有前端寫入、沒有刪成員的
-- trigger）——因為 reading_team_members / reading_teams 完全沒有異動紀錄。
--
-- 這個 migration 只「加儀器」，不動任何現有邏輯：
--   · reading_team_member_events：每次 INSERT / DELETE 一列成員，記下是誰、哪一隊、
--     哪個 txid、以及「呼叫堆疊（PG_CONTEXT）」——堆疊會直接寫出是哪支函式 /
--     哪條 SQL 觸發的（例：remove_reading_team_member、carry_reading_teams_to_stage、
--     或 "DELETE FROM reading_teams ..." 的 cascade）。
--   · reading_teams_events：team 列被 INSERT / UPDATE（division/name/status/plan 變動）/
--     DELETE 時記一筆——cascade 刪 team 是最可能的兇手，這裡會抓到。
--
-- 下次再發生，一句 SQL 就知道：
--   SELECT * FROM public.reading_team_member_events
--   WHERE team_id = '<出問題的隊>' ORDER BY created_at DESC;
--
-- 純新增。冪等。nlc-data 不用重部署。Supabase SQL editor 執行。
-- ============================================================================

-- ── 成員異動 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reading_team_member_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type     TEXT NOT NULL CHECK (event_type IN ('insert', 'delete')),
  team_id        UUID,
  user_id        UUID,
  global_plan_id UUID,
  division       SMALLINT,
  member_role    TEXT,
  txid           BIGINT NOT NULL DEFAULT txid_current(),
  trigger_depth  INTEGER,
  db_user        TEXT,
  app_name       TEXT,
  jwt_claims     TEXT,
  call_context   TEXT,                     -- PG_CONTEXT：呼叫堆疊，看得出是哪支函式 / 哪條 SQL
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_rtm_events_team    ON public.reading_team_member_events (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rtm_events_user    ON public.reading_team_member_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rtm_events_txid    ON public.reading_team_member_events (txid);
CREATE INDEX IF NOT EXISTS idx_rtm_events_created ON public.reading_team_member_events (created_at DESC);
ALTER TABLE public.reading_team_member_events ENABLE ROW LEVEL SECURITY;

-- ── team 本身的異動 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reading_teams_events (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type           TEXT NOT NULL CHECK (event_type IN ('insert', 'update', 'delete')),
  team_id              UUID,
  global_plan_id_old   UUID,
  global_plan_id_new   UUID,
  division_old         SMALLINT,
  division_new         SMALLINT,
  name_old             TEXT,
  name_new             TEXT,
  status_old           TEXT,
  status_new           TEXT,
  captain_id           UUID,
  carried_from_team_id UUID,
  invite_code          TEXT,
  txid                 BIGINT NOT NULL DEFAULT txid_current(),
  trigger_depth        INTEGER,
  db_user              TEXT,
  app_name             TEXT,
  jwt_claims           TEXT,
  call_context         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_rt_events_team    ON public.reading_teams_events (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rt_events_txid    ON public.reading_teams_events (txid);
CREATE INDEX IF NOT EXISTS idx_rt_events_created ON public.reading_teams_events (created_at DESC);
ALTER TABLE public.reading_teams_events ENABLE ROW LEVEL SECURITY;

-- ── trigger：成員 ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._audit_reading_team_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ctx TEXT;
  v_jwt TEXT;
  r public.reading_team_members%ROWTYPE;
BEGIN
  GET DIAGNOSTICS v_ctx = PG_CONTEXT;
  BEGIN v_jwt := current_setting('request.jwt.claims', true); EXCEPTION WHEN OTHERS THEN v_jwt := NULL; END;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;

  INSERT INTO public.reading_team_member_events
    (event_type, team_id, user_id, global_plan_id, division, member_role,
     trigger_depth, db_user, app_name, jwt_claims, call_context)
  VALUES (
    lower(TG_OP), r.team_id, r.user_id, r.global_plan_id, r.division, r.member_role,
    pg_trigger_depth(), current_user::text,
    current_setting('application_name', true),
    left(COALESCE(v_jwt, ''), 2000),
    left(COALESCE(v_ctx, ''), 4000)
  );
  RETURN NULL;   -- AFTER trigger
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_reading_team_members ON public.reading_team_members;
CREATE TRIGGER trg_audit_reading_team_members
  AFTER INSERT OR DELETE ON public.reading_team_members
  FOR EACH ROW EXECUTE FUNCTION public._audit_reading_team_member();

-- ── trigger：team ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._audit_reading_team()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ctx TEXT;
  v_jwt TEXT;
BEGIN
  GET DIAGNOSTICS v_ctx = PG_CONTEXT;
  BEGIN v_jwt := current_setting('request.jwt.claims', true); EXCEPTION WHEN OTHERS THEN v_jwt := NULL; END;

  INSERT INTO public.reading_teams_events
    (event_type, team_id,
     global_plan_id_old, global_plan_id_new, division_old, division_new,
     name_old, name_new, status_old, status_new,
     captain_id, carried_from_team_id, invite_code,
     trigger_depth, db_user, app_name, jwt_claims, call_context)
  VALUES (
    lower(TG_OP),
    COALESCE(NEW.id, OLD.id),
    OLD.global_plan_id, NEW.global_plan_id,
    OLD.division, NEW.division,
    OLD.name, NEW.name,
    OLD.status, NEW.status,
    COALESCE(NEW.captain_id, OLD.captain_id),
    COALESCE(NEW.carried_from_team_id, OLD.carried_from_team_id),
    COALESCE(NEW.invite_code, OLD.invite_code),
    pg_trigger_depth(), current_user::text,
    current_setting('application_name', true),
    left(COALESCE(v_jwt, ''), 2000),
    left(COALESCE(v_ctx, ''), 4000)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_reading_teams ON public.reading_teams;
CREATE TRIGGER trg_audit_reading_teams
  AFTER INSERT OR UPDATE OR DELETE ON public.reading_teams
  FOR EACH ROW EXECUTE FUNCTION public._audit_reading_team();

-- ── 權限：稽核表只給 service_role 讀（管理端經 nlc-data 讀，或直接在 SQL editor）
REVOKE ALL ON public.reading_team_member_events FROM PUBLIC, authenticated;
REVOKE ALL ON public.reading_teams_events       FROM PUBLIC, authenticated;
GRANT SELECT, INSERT ON public.reading_team_member_events TO service_role;
GRANT SELECT, INSERT ON public.reading_teams_events       TO service_role;

COMMENT ON TABLE public.reading_team_member_events IS
  '團隊成員異動稽核（0149）：每次 reading_team_members INSERT/DELETE 記一筆，call_context 是呼叫堆疊。';
COMMENT ON TABLE public.reading_teams_events IS
  '團隊列異動稽核（0149）：reading_teams INSERT/UPDATE/DELETE，抓 cascade 刪 team 這類根因。';

-- ── 方便查的 view：把同一個 txid 的成員異動 + team 異動兜在一起 ─────────────
CREATE OR REPLACE VIEW public.reading_team_audit_timeline AS
SELECT created_at, txid, 'member' AS scope, event_type,
       team_id, user_id, NULL::text AS detail, trigger_depth, db_user, call_context
FROM public.reading_team_member_events
UNION ALL
SELECT created_at, txid, 'team' AS scope, event_type,
       team_id, NULL::uuid AS user_id,
       concat_ws(' → ',
         NULLIF(concat('status ', status_old, '/', status_new), 'status /'),
         NULLIF(concat('division ', division_old, '/', division_new), 'division /'),
         NULLIF(concat('plan ', global_plan_id_old, '/', global_plan_id_new), 'plan /')
       ) AS detail,
       trigger_depth, db_user, call_context
FROM public.reading_teams_events
ORDER BY created_at DESC;
GRANT SELECT ON public.reading_team_audit_timeline TO service_role;
