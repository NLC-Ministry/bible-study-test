-- ============================================================================
-- 0096_speed_reading_exam.sql  —  「大測驗」速讀測驗 P0 骨架
-- ----------------------------------------------------------------------------
-- 一次性、全教會、限時單次、宣示同意、六大題型、自動核分(一~五)+人工評分(六)。
-- 與既有「今日小測驗」(daily_quiz / quiz_*) 完全獨立：新表、新 RPC、新 feature
-- flag。所有存取都經 nlc-data service-role + 本檔 RPC 的 actor/角色/scope 檢查，
-- 資料表本身 ENABLE RLS 但不開放 anon/authenticated 直接讀寫。
--
-- 部署：此檔不會自動套用。請在 Supabase SQL editor 執行，或 `supabase db push`。
-- ============================================================================

-- ── Feature flag（預設關閉；測試期只有系統管理員在「計劃管理 → 大測驗」看得到）──
INSERT INTO public.app_feature_settings (key, enabled, description)
VALUES (
  'speed_reading_exam',
  FALSE,
  '控制速讀「大測驗」的出題、作答、批改與成績查詢是否啟用。'
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 資料表
-- ============================================================================

-- 一份試卷
CREATE TABLE IF NOT EXISTS public.exam_papers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL DEFAULT '速讀測驗',
  description    TEXT NOT NULL DEFAULT '',
  mode           TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  open_at        TIMESTAMPTZ,
  close_at       TIMESTAMPTZ,
  duration_minutes SMALLINT NOT NULL DEFAULT 75 CHECK (duration_minutes BETWEEN 1 AND 600),
  total_points   SMALLINT NOT NULL DEFAULT 100 CHECK (total_points BETWEEN 1 AND 1000),
  -- 宣示條文快照（版本化，作答者同意的就是這一份）
  pledge         JSONB NOT NULL DEFAULT jsonb_build_object('openText', '', 'rules', '[]'::jsonb, 'consentTemplate', ''),
  -- 每型應有題數；publish 時校驗
  section_targets JSONB NOT NULL DEFAULT jsonb_build_object(
    'truefalse', 20, 'single', 20, 'multiple', 10,
    'matching', 10, 'ordering', 10, 'shortanswer', 3
  ),
  published_at   TIMESTAMPTZ,
  published_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 題目（大題順序 = section 固定；小題順序 = position 為標準序，作答時每人打亂）
CREATE TABLE IF NOT EXISTS public.exam_questions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id    UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  section     TEXT NOT NULL CHECK (section IN (
                'truefalse', 'single', 'multiple', 'matching', 'ordering', 'shortanswer')),
  position    INTEGER NOT NULL,
  points      NUMERIC(4,1) NOT NULL DEFAULT 1 CHECK (points >= 0 AND points <= 100),
  -- 題幹與選項/配對/事件（不含答案）。shape 對齊前端模板 EXAM.questions[]：
  --   truefalse   { stem }
  --   single      { stem, options:[..] }
  --   multiple    { stem, options:[..] }
  --   matching    { stem, left:[{id,text}], right:[{id,text}] }
  --   ordering    { stem, items:[{id,text}] }
  --   shortanswer { stem, referenceAnswer, rubric:[..], maxPoints }
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 標準答案，永不下發前端：
  --   truefalse  true/false        single  <canonical index>
  --   multiple   [<idx>,..]        matching { "<leftId>":"<rightId>", .. }
  --   ordering   ["<itemId>",..]   shortanswer  null（人工）
  answer_key  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, section, position)
);

-- 一位使用者的一次作答（一人一份；記錄以第一次為準）
CREATE TABLE IF NOT EXISTS public.exam_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id       UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reading_team_id UUID,               -- 作答當下的組隊快照（個人為 NULL），僅供統計
  is_test        BOOLEAN NOT NULL DEFAULT FALSE,
  status         TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress', 'submitted', 'graded')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at    TIMESTAMPTZ NOT NULL,          -- server 計算：min(started+duration, close_at)
  submitted_at   TIMESTAMPTZ,
  submit_reason  TEXT CHECK (submit_reason IN ('manual', 'timeout', 'auto_close')),
  -- 宣示存證
  pledge_name    TEXT NOT NULL,
  pledge_agreed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pledge_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 每人專屬的卷面排列（大題固定、小題與選項打亂；shortanswer 不打亂）
  layout         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 作答起始時凍結的去答案整卷（避免出題者中途改題影響作答中的人）
  paper_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  auto_score     NUMERIC(5,1),         -- 一~五題（送出時算）
  manual_score   NUMERIC(5,1),         -- 六題（全部批完才有）
  total_score    NUMERIC(6,1),         -- auto + manual（graded 才有）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, user_id)
);

-- 逐題作答（response 一律存 canonical id / index；批改與匯出都照標準序）
CREATE TABLE IF NOT EXISTS public.exam_answers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id     UUID NOT NULL REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  question_id    UUID NOT NULL REFERENCES public.exam_questions(id) ON DELETE CASCADE,
  section        TEXT NOT NULL,
  response       JSONB,               -- canonical：true/false、<idx>、[<idx>..]、{L:R}、[id..]、"文字"
  auto_correct   BOOLEAN,             -- 一~五題送出時判定；六題為 NULL
  awarded_points NUMERIC(4,1),        -- 一~五題送出時給；六題人工批改後給
  grader_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  grader_comment TEXT,                -- 六題：評語（回饋給作答者）
  graded_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, question_id)
);

-- 成績通知（比照 quiz_notifications 的極簡模式）
CREATE TABLE IF NOT EXISTS public.exam_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id   UUID NOT NULL REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'graded' CHECK (kind IN ('graded')),
  message      TEXT NOT NULL DEFAULT '速讀測驗成績已公布',
  status       TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, recipient_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_exam_questions_paper        ON public.exam_questions(paper_id, section, position);
CREATE INDEX IF NOT EXISTS idx_exam_attempts_paper_user    ON public.exam_attempts(paper_id, user_id);
CREATE INDEX IF NOT EXISTS idx_exam_attempts_paper_status  ON public.exam_attempts(paper_id, status);
CREATE INDEX IF NOT EXISTS idx_exam_answers_attempt        ON public.exam_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_exam_answers_grading        ON public.exam_answers(section, awarded_points) WHERE section = 'shortanswer';
CREATE INDEX IF NOT EXISTS idx_exam_notifications_recipient ON public.exam_notifications(recipient_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_exam_papers_updated_at ON public.exam_papers;
CREATE TRIGGER trg_exam_papers_updated_at BEFORE UPDATE ON public.exam_papers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_exam_questions_updated_at ON public.exam_questions;
CREATE TRIGGER trg_exam_questions_updated_at BEFORE UPDATE ON public.exam_questions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_exam_attempts_updated_at ON public.exam_attempts;
CREATE TRIGGER trg_exam_attempts_updated_at BEFORE UPDATE ON public.exam_attempts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_exam_answers_updated_at ON public.exam_answers;
CREATE TRIGGER trg_exam_answers_updated_at BEFORE UPDATE ON public.exam_answers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.exam_papers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_questions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_attempts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_answers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_notifications ENABLE ROW LEVEL SECURITY;
-- 不建立任何 permissive policy：一律經 service-role + 下列 RPC 存取。

-- ============================================================================
-- 內部輔助函式
-- ============================================================================

-- 角色代碼（'admin' / 'pastor' / ...），沿用 role_definitions
CREATE OR REPLACE FUNCTION public._exam_actor_role(p_actor_id UUID)
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(public.role_code(role_id), 'member') FROM public.profiles WHERE id = p_actor_id;
$$;

-- 自動核分：一題「整題全對才得分」；shortanswer 一律回 NULL（人工）
CREATE OR REPLACE FUNCTION public._exam_answer_is_correct(
  p_section     TEXT,
  p_answer_key  JSONB,
  p_response    JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_section = 'shortanswer' THEN RETURN NULL; END IF;
  IF p_answer_key IS NULL OR p_response IS NULL THEN RETURN FALSE; END IF;

  IF p_section IN ('truefalse', 'single', 'matching', 'ordering') THEN
    -- jsonb 物件相等與 key 順序無關；陣列相等看順序（排序題正是要看順序）
    RETURN p_answer_key = p_response;
  ELSIF p_section = 'multiple' THEN
    RETURN (
      SELECT COALESCE(jsonb_agg(e ORDER BY e::text), '[]'::jsonb)
      FROM jsonb_array_elements(p_answer_key) e
    ) = (
      SELECT COALESCE(jsonb_agg(e ORDER BY e::text), '[]'::jsonb)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_response) = 'array' THEN p_response ELSE '[]'::jsonb END) e
    );
  END IF;
  RETURN FALSE;
END;
$$;

-- 去答案的題目 payload（作答者可見）：shortanswer 只保留 stem / maxPoints
CREATE OR REPLACE FUNCTION public._exam_public_payload(p_section TEXT, p_payload JSONB, p_points NUMERIC)
RETURNS JSONB
LANGUAGE SQL IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_section = 'shortanswer' THEN jsonb_build_object(
      'stem', p_payload -> 'stem',
      'maxPoints', COALESCE(p_payload -> 'maxPoints', to_jsonb(p_points))
    )
    ELSE p_payload
  END;
$$;

-- 依 seed 對一組 text 值做決定性排序（回傳 jsonb 陣列）
CREATE OR REPLACE FUNCTION public._exam_shuffle_ids(p_ids JSONB, p_seed TEXT, p_salt TEXT)
RETURNS JSONB
LANGUAGE SQL IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    jsonb_agg(v ORDER BY md5(p_seed || ':' || p_salt || ':' || v)),
    '[]'::jsonb
  )
  FROM jsonb_array_elements_text(p_ids) v;
$$;

-- 產生一份 attempt 的專屬排列（大題固定、shortanswer 不打亂）
CREATE OR REPLACE FUNCTION public._exam_build_layout(p_paper_id UUID, p_seed TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public
AS $$
DECLARE
  section_order  JSONB := jsonb_build_array('truefalse','single','multiple','matching','ordering','shortanswer');
  question_order JSONB;
  option_order   JSONB;
  match_right    JSONB;
  order_pool     JSONB;
BEGIN
  -- 小題順序：非 shortanswer 依 md5(seed) 打亂；shortanswer 依 position
  SELECT jsonb_object_agg(section, ids) INTO question_order FROM (
    SELECT q.section,
           jsonb_agg(q.id::text ORDER BY
             CASE WHEN q.section = 'shortanswer'
                  THEN lpad(q.position::text, 8, '0')
                  ELSE md5(p_seed || ':q:' || q.id::text) END) AS ids
    FROM public.exam_questions q
    WHERE q.paper_id = p_paper_id
    GROUP BY q.section
  ) s;

  -- 單選 / 複選：選項索引打亂
  SELECT jsonb_object_agg(qid, ord) INTO option_order FROM (
    SELECT q.id::text AS qid,
           jsonb_agg(idx ORDER BY md5(p_seed || ':o:' || q.id::text || ':' || idx::text)) AS ord
    FROM public.exam_questions q
    CROSS JOIN LATERAL generate_series(0, COALESCE(jsonb_array_length(q.payload -> 'options'), 0) - 1) AS idx
    WHERE q.paper_id = p_paper_id AND q.section IN ('single','multiple')
    GROUP BY q.id
  ) o;

  -- 連連看：右欄順序打亂（左欄維持 payload 順序）
  SELECT jsonb_object_agg(qid, public._exam_shuffle_ids(ids, p_seed, 'mr:' || qid)) INTO match_right FROM (
    SELECT q.id::text AS qid, jsonb_agg(r ->> 'id') AS ids
    FROM public.exam_questions q
    CROSS JOIN LATERAL jsonb_array_elements(q.payload -> 'right') AS r
    WHERE q.paper_id = p_paper_id AND q.section = 'matching'
    GROUP BY q.id
  ) m;

  -- 事件排序：待排序區初始順序打亂
  SELECT jsonb_object_agg(qid, public._exam_shuffle_ids(ids, p_seed, 'op:' || qid)) INTO order_pool FROM (
    SELECT q.id::text AS qid, jsonb_agg(it ->> 'id') AS ids
    FROM public.exam_questions q
    CROSS JOIN LATERAL jsonb_array_elements(q.payload -> 'items') AS it
    WHERE q.paper_id = p_paper_id AND q.section = 'ordering'
    GROUP BY q.id
  ) p;

  RETURN jsonb_build_object(
    'seed', p_seed,
    'sectionOrder', section_order,
    'questionOrder', COALESCE(question_order, '{}'::jsonb),
    'optionOrder', COALESCE(option_order, '{}'::jsonb),
    'matchRightOrder', COALESCE(match_right, '{}'::jsonb),
    'orderPoolOrder', COALESCE(order_pool, '{}'::jsonb)
  );
END;
$$;

-- 凍結去答案整卷
CREATE OR REPLACE FUNCTION public._exam_paper_snapshot(p_paper_id UUID)
RETURNS JSONB
LANGUAGE SQL STABLE SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'paperId', pr.id,
    'title', pr.title,
    'durationMinutes', pr.duration_minutes,
    'totalPoints', pr.total_points,
    'pledge', pr.pledge,
    'questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q.id, 'section', q.section, 'position', q.position, 'points', q.points,
               'payload', public._exam_public_payload(q.section, q.payload, q.points))
             ORDER BY q.position)
      FROM public.exam_questions q WHERE q.paper_id = pr.id
    ), '[]'::jsonb)
  )
  FROM public.exam_papers pr WHERE pr.id = p_paper_id;
$$;

-- ============================================================================
-- RPC：出題（僅 admin / pastor）
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_upsert_paper(p_payload JSONB, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id   UUID := public.resolve_quiz_actor(p_actor_id);
  v_paper_id UUID := NULLIF(p_payload ->> 'id', '')::uuid;
  row_out    public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  IF v_paper_id IS NULL THEN
    INSERT INTO public.exam_papers (title, description, mode, open_at, close_at,
        duration_minutes, total_points, pledge, section_targets, created_by)
    VALUES (
      COALESCE(NULLIF(p_payload ->> 'title', ''), '速讀測驗'),
      COALESCE(p_payload ->> 'description', ''),
      COALESCE(NULLIF(p_payload ->> 'mode', ''), 'test'),
      NULLIF(p_payload ->> 'open_at', '')::timestamptz,
      NULLIF(p_payload ->> 'close_at', '')::timestamptz,
      COALESCE((p_payload ->> 'duration_minutes')::smallint, 75),
      COALESCE((p_payload ->> 'total_points')::smallint, 100),
      COALESCE(p_payload -> 'pledge', jsonb_build_object('openText','', 'rules','[]'::jsonb, 'consentTemplate','')),
      COALESCE(p_payload -> 'section_targets', jsonb_build_object(
        'truefalse',20,'single',20,'multiple',10,'matching',10,'ordering',10,'shortanswer',3)),
      actor_id)
    RETURNING * INTO row_out;
  ELSE
    UPDATE public.exam_papers SET
      title = COALESCE(NULLIF(p_payload ->> 'title', ''), title),
      description = COALESCE(p_payload ->> 'description', description),
      mode = COALESCE(NULLIF(p_payload ->> 'mode', ''), mode),
      open_at = COALESCE(NULLIF(p_payload ->> 'open_at', '')::timestamptz, open_at),
      close_at = COALESCE(NULLIF(p_payload ->> 'close_at', '')::timestamptz, close_at),
      duration_minutes = COALESCE((p_payload ->> 'duration_minutes')::smallint, duration_minutes),
      total_points = COALESCE((p_payload ->> 'total_points')::smallint, total_points),
      pledge = COALESCE(p_payload -> 'pledge', pledge),
      section_targets = COALESCE(p_payload -> 'section_targets', section_targets)
    WHERE id = v_paper_id AND status = 'draft'
    RETURNING * INTO row_out;
    IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_editable'; END IF;
  END IF;

  RETURN to_jsonb(row_out);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_upsert_question(p_payload JSONB, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id   UUID := public.resolve_quiz_actor(p_actor_id);
  v_q_id     UUID := NULLIF(p_payload ->> 'id', '')::uuid;
  v_paper_id UUID := (p_payload ->> 'paper_id')::uuid;
  v_section  TEXT := p_payload ->> 'section';
  row_out    public.exam_questions%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = v_paper_id AND status = 'draft') THEN
    RAISE EXCEPTION 'exam_paper_not_editable';
  END IF;

  IF v_q_id IS NULL THEN
    INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key)
    VALUES (
      v_paper_id,
      v_section,
      COALESCE((p_payload ->> 'position')::int,
               (SELECT COALESCE(MAX(eq.position), 0) + 1 FROM public.exam_questions eq
                WHERE eq.paper_id = v_paper_id AND eq.section = v_section)),
      COALESCE((p_payload ->> 'points')::numeric, 1),
      COALESCE(p_payload -> 'payload', '{}'::jsonb),
      p_payload -> 'answer_key')
    RETURNING * INTO row_out;
  ELSE
    UPDATE public.exam_questions eq SET
      section = COALESCE(p_payload ->> 'section', eq.section),
      position = COALESCE((p_payload ->> 'position')::int, eq.position),
      points = COALESCE((p_payload ->> 'points')::numeric, eq.points),
      payload = COALESCE(p_payload -> 'payload', eq.payload),
      answer_key = CASE WHEN p_payload ? 'answer_key' THEN p_payload -> 'answer_key' ELSE eq.answer_key END
    WHERE eq.id = v_q_id AND eq.paper_id = v_paper_id
    RETURNING * INTO row_out;
    IF NOT FOUND THEN RAISE EXCEPTION 'exam_question_not_found'; END IF;
  END IF;

  RETURN to_jsonb(row_out);
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_delete_question(p_question_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  DELETE FROM public.exam_questions q
  USING public.exam_papers pr
  WHERE q.id = p_question_id AND q.paper_id = pr.id AND pr.status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_question_not_deletable'; END IF;
  RETURN jsonb_build_object('deleted', p_question_id);
END;
$$;

-- 後台編輯器用：整卷 + 答案
CREATE OR REPLACE FUNCTION public.exam_get_paper_admin(p_paper_id UUID DEFAULT NULL, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  target   UUID := p_paper_id;
  result   JSONB;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  IF target IS NULL THEN
    SELECT id INTO target FROM public.exam_papers ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF target IS NULL THEN RETURN jsonb_build_object('paper', NULL, 'questions', '[]'::jsonb); END IF;

  SELECT jsonb_build_object(
    'paper', to_jsonb(pr),
    'attemptCount', (SELECT COUNT(*) FROM public.exam_attempts a WHERE a.paper_id = pr.id),
    'questions', COALESCE((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q.section, q.position)
      FROM public.exam_questions q WHERE q.paper_id = pr.id
    ), '[]'::jsonb)
  ) INTO result
  FROM public.exam_papers pr WHERE pr.id = target;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_publish(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  bad_cnt  INTEGER;
  sec      TEXT;
  want     INTEGER;
  got      INTEGER;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  IF pr.status <> 'draft' THEN RAISE EXCEPTION 'exam_already_published'; END IF;
  IF pr.open_at IS NULL OR pr.close_at IS NULL OR pr.close_at <= pr.open_at THEN
    RAISE EXCEPTION 'exam_window_invalid';
  END IF;

  -- 每型題數
  FOR sec, want IN SELECT key, value::int FROM jsonb_each_text(pr.section_targets) LOOP
    SELECT COUNT(*) INTO got FROM public.exam_questions WHERE paper_id = pr.id AND section = sec;
    IF got <> want THEN
      RAISE EXCEPTION 'exam_section_count_mismatch: % expected % got %', sec, want, got;
    END IF;
  END LOOP;

  -- 一~五題必須有 answer_key，且結構合理
  SELECT COUNT(*) INTO bad_cnt FROM public.exam_questions q
  WHERE q.paper_id = pr.id AND q.section <> 'shortanswer' AND (
        q.answer_key IS NULL
     OR (q.section = 'matching'
         AND (SELECT COUNT(*) FROM jsonb_object_keys(q.answer_key))
             <> COALESCE(jsonb_array_length(q.payload -> 'left'), -1))
     OR (q.section = 'ordering'
         AND jsonb_array_length(q.answer_key)
             <> COALESCE(jsonb_array_length(q.payload -> 'items'), -1))
  );
  IF bad_cnt > 0 THEN RAISE EXCEPTION 'exam_answer_key_incomplete: % 題', bad_cnt; END IF;

  UPDATE public.exam_papers
  SET status = 'published', published_at = NOW(), published_by = actor_id
  WHERE id = pr.id;

  RETURN jsonb_build_object('paperId', pr.id, 'status', 'published');
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_set_status(p_paper_id UUID, p_status TEXT, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF p_status NOT IN ('draft', 'published', 'closed') THEN RAISE EXCEPTION 'exam_status_invalid'; END IF;
  UPDATE public.exam_papers SET status = p_status WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  RETURN jsonb_build_object('paperId', p_paper_id, 'status', p_status);
END;
$$;

-- ============================================================================
-- RPC：作答（一般會友；nlc-data 端另檢查 feature flag）
-- ============================================================================

-- 進測驗畫面：回開放狀態 + 我的 attempt（若有，含凍結卷面與剩餘秒數）
CREATE OR REPLACE FUNCTION public.exam_get_for_attempt(p_paper_id UUID DEFAULT NULL, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  is_staff BOOLEAN := public._exam_actor_role(actor_id) IN ('admin', 'pastor');
  pr       public.exam_papers%ROWTYPE;
  at       public.exam_attempts%ROWTYPE;
  now_ts   TIMESTAMPTZ := NOW();
  open_state TEXT;
BEGIN
  IF p_paper_id IS NOT NULL THEN
    SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  ELSE
    -- 測試期：admin 拿最新的 test 卷；一般會友拿目前開放中的 live 卷
    SELECT * INTO pr FROM public.exam_papers
    WHERE (is_staff OR (mode = 'live' AND status = 'published'))
    ORDER BY (mode = 'live') DESC, published_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_paper'); END IF;

  IF pr.status <> 'published' THEN
    open_state := CASE WHEN is_staff THEN 'preview' ELSE 'not_open' END;
  ELSIF now_ts < COALESCE(pr.open_at, now_ts) THEN open_state := 'not_open';
  ELSIF now_ts > COALESCE(pr.close_at, now_ts) THEN open_state := 'closed';
  ELSE open_state := 'open';
  END IF;

  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;

  RETURN jsonb_build_object(
    'state', open_state,
    'paper', jsonb_build_object(
      'id', pr.id, 'title', pr.title, 'mode', pr.mode, 'status', pr.status,
      'openAt', pr.open_at, 'closeAt', pr.close_at,
      'durationMinutes', pr.duration_minutes, 'totalPoints', pr.total_points,
      'pledge', pr.pledge
    ),
    'attempt', CASE WHEN at.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', at.id, 'status', at.status,
      'startedAt', at.started_at, 'deadlineAt', at.deadline_at, 'submittedAt', at.submitted_at,
      'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - now_ts))))::int,
      'layout', at.layout,
      'paperSnapshot', at.paper_snapshot,
      'savedAnswers', COALESCE((
        SELECT jsonb_object_agg(question_id::text, response)
        FROM public.exam_answers WHERE attempt_id = at.id AND response IS NOT NULL
      ), '{}'::jsonb),
      'autoScore', at.auto_score, 'manualScore', at.manual_score, 'totalScore', at.total_score
    ) END,
    -- 尚未開始作答者，給去答案整卷讓前端顯示宣示畫面 / 預覽
    'previewQuestions', CASE WHEN at.id IS NOT NULL THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q.id, 'section', q.section, 'position', q.position, 'points', q.points,
               'payload', public._exam_public_payload(q.section, q.payload, q.points))
             ORDER BY q.section, q.position)
      FROM public.exam_questions q WHERE q.paper_id = pr.id
    ), '[]'::jsonb) END
  );
END;
$$;

-- 開始作答：建 attempt、凍結卷面與排列、server 計 deadline、UNIQUE 擋重複
CREATE OR REPLACE FUNCTION public.exam_start_attempt(
  p_paper_id       UUID,
  p_pledge_name    TEXT,
  p_reading_team_id UUID DEFAULT NULL,
  p_actor_id       UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
  at       public.exam_attempts%ROWTYPE;
  now_ts   TIMESTAMPTZ := NOW();
  seed     TEXT;
  deadline TIMESTAMPTZ;
BEGIN
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;

  -- 既有 attempt：直接回（記錄以第一次為準）
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;
  IF FOUND THEN
    RETURN jsonb_build_object('attemptId', at.id, 'status', at.status, 'resumed', TRUE,
      'deadlineAt', at.deadline_at,
      'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - now_ts))))::int,
      'layout', at.layout, 'paperSnapshot', at.paper_snapshot);
  END IF;

  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    IF pr.status <> 'published' THEN RAISE EXCEPTION 'exam_not_open'; END IF;
    IF now_ts < pr.open_at OR now_ts > pr.close_at THEN RAISE EXCEPTION 'exam_not_open'; END IF;
  END IF;
  IF COALESCE(TRIM(p_pledge_name), '') = '' THEN RAISE EXCEPTION 'exam_pledge_name_required'; END IF;

  seed := md5(pr.id::text || ':' || actor_id::text || ':' || COALESCE(pr.published_at, pr.created_at)::text);
  deadline := LEAST(now_ts + make_interval(mins => pr.duration_minutes), COALESCE(pr.close_at, now_ts + make_interval(mins => pr.duration_minutes)));

  INSERT INTO public.exam_attempts (
    paper_id, user_id, reading_team_id, is_test, status,
    started_at, deadline_at, pledge_name, pledge_agreed_at, pledge_snapshot,
    layout, paper_snapshot)
  VALUES (
    pr.id, actor_id, p_reading_team_id, (pr.mode = 'test'), 'in_progress',
    now_ts, deadline, TRIM(p_pledge_name), now_ts, pr.pledge,
    public._exam_build_layout(pr.id, seed), public._exam_paper_snapshot(pr.id))
  ON CONFLICT (paper_id, user_id) DO NOTHING
  RETURNING * INTO at;

  IF at.id IS NULL THEN
    SELECT * INTO at FROM public.exam_attempts WHERE paper_id = pr.id AND user_id = actor_id;
  END IF;

  RETURN jsonb_build_object('attemptId', at.id, 'status', at.status, 'resumed', FALSE,
    'deadlineAt', at.deadline_at,
    'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - now_ts))))::int,
    'layout', at.layout, 'paperSnapshot', at.paper_snapshot);
END;
$$;

-- 作答中暫存（response 一律 canonical）；p_answers: { "<questionId>": <response>, .. }
CREATE OR REPLACE FUNCTION public.exam_save_progress(p_attempt_id UUID, p_answers JSONB, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  at       public.exam_attempts%ROWTYPE;
  kv       RECORD;
  q_sec    TEXT;
  saved    INTEGER := 0;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id AND user_id = actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;
  IF at.status <> 'in_progress' THEN RAISE EXCEPTION 'exam_attempt_locked'; END IF;
  IF NOW() > at.deadline_at + INTERVAL '120 seconds' THEN RAISE EXCEPTION 'exam_time_up'; END IF;

  FOR kv IN SELECT * FROM jsonb_each(COALESCE(p_answers, '{}'::jsonb)) LOOP
    SELECT section INTO q_sec FROM public.exam_questions
      WHERE id = kv.key::uuid AND paper_id = at.paper_id;
    CONTINUE WHEN q_sec IS NULL;
    INSERT INTO public.exam_answers (attempt_id, question_id, section, response)
    VALUES (at.id, kv.key::uuid, q_sec, kv.value)
    ON CONFLICT (attempt_id, question_id)
      DO UPDATE SET response = EXCLUDED.response, updated_at = NOW()
      WHERE public.exam_answers.awarded_points IS NULL;
    saved := saved + 1;
  END LOOP;

  RETURN jsonb_build_object('saved', saved,
    'secondsRemaining', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (at.deadline_at - NOW()))))::int);
END;
$$;

-- 送出：server 重新核分一~五題（不信任前端分數），寫逐題，狀態 submitted
CREATE OR REPLACE FUNCTION public.exam_submit_attempt(
  p_attempt_id UUID,
  p_answers    JSONB,
  p_reason     TEXT DEFAULT 'manual',
  p_actor_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  at       public.exam_attempts%ROWTYPE;
  q        RECORD;
  resp     JSONB;
  ok       BOOLEAN;
  pts      NUMERIC;
  auto_sum NUMERIC := 0;
  has_short BOOLEAN := FALSE;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE id = p_attempt_id AND user_id = actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_attempt_not_found'; END IF;

  -- 已送出 → 冪等回既有結果
  IF at.status <> 'in_progress' THEN
    RETURN jsonb_build_object('attemptId', at.id, 'status', at.status,
      'autoScore', at.auto_score, 'manualScore', at.manual_score, 'totalScore', at.total_score,
      'alreadySubmitted', TRUE);
  END IF;

  FOR q IN SELECT id, section, points, answer_key FROM public.exam_questions
           WHERE paper_id = at.paper_id LOOP
    resp := COALESCE(p_answers -> q.id::text,
                     (SELECT response FROM public.exam_answers
                      WHERE attempt_id = at.id AND question_id = q.id));

    IF q.section = 'shortanswer' THEN
      has_short := TRUE;
      INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
      VALUES (at.id, q.id, q.section, resp, NULL, NULL)
      ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET response = EXCLUDED.response, updated_at = NOW();
    ELSE
      ok := public._exam_answer_is_correct(q.section, q.answer_key, resp);
      pts := CASE WHEN ok THEN q.points ELSE 0 END;
      auto_sum := auto_sum + pts;
      INSERT INTO public.exam_answers (attempt_id, question_id, section, response, auto_correct, awarded_points)
      VALUES (at.id, q.id, q.section, resp, ok, pts)
      ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET response = EXCLUDED.response, auto_correct = EXCLUDED.auto_correct,
                      awarded_points = EXCLUDED.awarded_points, updated_at = NOW();
    END IF;
  END LOOP;

  UPDATE public.exam_attempts SET
    status = CASE WHEN has_short THEN 'submitted' ELSE 'graded' END,
    submitted_at = NOW(),
    submit_reason = CASE WHEN p_reason IN ('manual','timeout','auto_close') THEN p_reason ELSE 'manual' END,
    auto_score = auto_sum,
    manual_score = CASE WHEN has_short THEN NULL ELSE 0 END,
    total_score = CASE WHEN has_short THEN NULL ELSE auto_sum END
  WHERE id = at.id;

  RETURN jsonb_build_object('attemptId', at.id,
    'status', CASE WHEN has_short THEN 'submitted' ELSE 'graded' END,
    'autoScore', auto_sum,
    'totalScore', CASE WHEN has_short THEN NULL ELSE auto_sum END,
    'alreadySubmitted', FALSE);
END;
$$;

-- 我的成績（一~五逐題對錯 + 六題得分與評語）
CREATE OR REPLACE FUNCTION public.exam_get_my_result(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  at       public.exam_attempts%ROWTYPE;
BEGIN
  SELECT * INTO at FROM public.exam_attempts WHERE paper_id = p_paper_id AND user_id = actor_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_attempt'); END IF;
  IF at.status = 'in_progress' THEN RETURN jsonb_build_object('state', 'in_progress'); END IF;

  RETURN jsonb_build_object(
    'state', at.status,
    'autoScore', at.auto_score, 'manualScore', at.manual_score, 'totalScore', at.total_score,
    'submittedAt', at.submitted_at,
    'answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'questionId', ea.question_id, 'section', ea.section, 'position', q.position,
        'response', ea.response, 'autoCorrect', ea.auto_correct, 'awardedPoints', ea.awarded_points,
        'graderComment', ea.grader_comment,
        'answerKey', CASE WHEN at.status = 'graded' AND ea.section <> 'shortanswer'
                          THEN q.answer_key ELSE NULL END)
      ORDER BY q.section, q.position)
      FROM public.exam_answers ea JOIN public.exam_questions q ON q.id = ea.question_id
      WHERE ea.attempt_id = at.id
    ), '[]'::jsonb)
  );
END;
$$;

-- ============================================================================
-- RPC：人工評分（僅 admin / pastor）
-- ============================================================================

-- 待批清單（簡答題）
CREATE OR REPLACE FUNCTION public.exam_get_grading_queue(
  p_paper_id UUID,
  p_filter   TEXT DEFAULT 'pending',   -- pending | graded | all
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  RETURN jsonb_build_object(
    'summary', (
      SELECT jsonb_build_object(
        'total', COUNT(*),
        'pending', COUNT(*) FILTER (WHERE ea.awarded_points IS NULL),
        'graded', COUNT(*) FILTER (WHERE ea.awarded_points IS NOT NULL))
      FROM public.exam_answers ea JOIN public.exam_attempts a ON a.id = ea.attempt_id
      WHERE a.paper_id = p_paper_id AND ea.section = 'shortanswer' AND a.status IN ('submitted','graded')
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'answerId', ea.id, 'attemptId', a.id,
        'examineeName', p.name,
        'greatRegion', p.great_region, 'pastoralZone', p.pastoral_zone, 'smallGroup', p.small_group,
        'position', q.position, 'points', q.points,
        'stem', q.payload -> 'stem',
        'referenceAnswer', q.payload -> 'referenceAnswer',
        'rubric', COALESCE(q.payload -> 'rubric', '[]'::jsonb),
        'response', ea.response,
        'awardedPoints', ea.awarded_points, 'graderComment', ea.grader_comment,
        'gradedAt', ea.graded_at)
      ORDER BY q.position, p.name)
      FROM public.exam_answers ea
      JOIN public.exam_attempts a ON a.id = ea.attempt_id
      JOIN public.exam_questions q ON q.id = ea.question_id
      JOIN public.profiles p ON p.id = a.user_id
      WHERE a.paper_id = p_paper_id AND ea.section = 'shortanswer' AND a.status IN ('submitted','graded')
        AND (p_filter = 'all'
             OR (p_filter = 'pending' AND ea.awarded_points IS NULL)
             OR (p_filter = 'graded' AND ea.awarded_points IS NOT NULL))
    ), '[]'::jsonb)
  );
END;
$$;

-- 批一題：分數 + 評語；三題都批完 → 結算 total、發通知
CREATE OR REPLACE FUNCTION public.exam_grade_answer(
  p_answer_id UUID,
  p_points    NUMERIC,
  p_comment   TEXT DEFAULT '',
  p_actor_id  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id  UUID := public.resolve_quiz_actor(p_actor_id);
  ea        public.exam_answers%ROWTYPE;
  at        public.exam_attempts%ROWTYPE;
  max_pts   NUMERIC;
  pending   INTEGER;
  short_sum NUMERIC;
  finalized BOOLEAN := FALSE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  SELECT * INTO ea FROM public.exam_answers WHERE id = p_answer_id;
  IF NOT FOUND OR ea.section <> 'shortanswer' THEN RAISE EXCEPTION 'exam_answer_not_gradable'; END IF;
  SELECT points INTO max_pts FROM public.exam_questions WHERE id = ea.question_id;
  IF p_points IS NULL OR p_points < 0 OR p_points > max_pts THEN
    RAISE EXCEPTION 'exam_points_out_of_range: 0..%', max_pts;
  END IF;

  UPDATE public.exam_answers
  SET awarded_points = p_points, grader_comment = NULLIF(TRIM(p_comment), ''),
      grader_id = actor_id, graded_at = NOW()
  WHERE id = ea.id;

  SELECT * INTO at FROM public.exam_attempts WHERE id = ea.attempt_id;

  SELECT COUNT(*) FILTER (WHERE awarded_points IS NULL),
         COALESCE(SUM(awarded_points), 0)
    INTO pending, short_sum
  FROM public.exam_answers WHERE attempt_id = at.id AND section = 'shortanswer';

  IF pending = 0 THEN
    UPDATE public.exam_attempts
    SET status = 'graded', manual_score = short_sum,
        total_score = COALESCE(auto_score, 0) + short_sum
    WHERE id = at.id;
    INSERT INTO public.exam_notifications (attempt_id, recipient_id, kind)
    VALUES (at.id, at.user_id, 'graded')
    ON CONFLICT (attempt_id, recipient_id, kind) DO NOTHING;
    finalized := TRUE;
  END IF;

  RETURN jsonb_build_object('answerId', ea.id, 'awardedPoints', p_points,
    'attemptFinalized', finalized, 'pendingInAttempt', pending);
END;
$$;

-- ============================================================================
-- 權限：一律 REVOKE PUBLIC，只給 authenticated / service_role
-- ============================================================================
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_upsert_paper(jsonb, uuid)',
    'exam_upsert_question(jsonb, uuid)',
    'exam_delete_question(uuid, uuid)',
    'exam_get_paper_admin(uuid, uuid)',
    'exam_publish(uuid, uuid)',
    'exam_set_status(uuid, text, uuid)',
    'exam_get_for_attempt(uuid, uuid)',
    'exam_start_attempt(uuid, text, uuid, uuid)',
    'exam_save_progress(uuid, jsonb, uuid)',
    'exam_submit_attempt(uuid, jsonb, text, uuid)',
    'exam_get_my_result(uuid, uuid)',
    'exam_get_grading_queue(uuid, text, uuid)',
    'exam_grade_answer(uuid, numeric, text, uuid)'
  ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public._exam_actor_role(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._exam_answer_is_correct(text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._exam_public_payload(text, jsonb, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._exam_shuffle_ids(jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._exam_build_layout(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._exam_paper_snapshot(uuid) FROM PUBLIC;
