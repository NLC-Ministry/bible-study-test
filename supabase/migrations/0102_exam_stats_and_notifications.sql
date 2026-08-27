-- ============================================================================
-- 0102_exam_stats_and_notifications.sql
-- P3：大測驗統計報表 + 成績通知
--   exam_get_stats(paper)         — 整體 / 大區 / 牧區 / 小組 / 逐題正確率 / 名單（admin｜pastor）
--   get_exam_notifications        — 我的成績通知（未讀優先）
--   mark_exam_notifications_read  — 標記已讀（單筆或全部）
--
-- 測試期只有系統管理員能進大測驗後台，統計先做「全教會」不分 scope；日後開給
-- 區長／小組長時再套 managed_regions/zones/groups（COALESCE(NULLIF(col,''),…) 陷阱）。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_get_stats(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  pr       public.exam_papers%ROWTYPE;
BEGIN
  IF public._exam_actor_role(actor_id) NOT IN ('admin', 'pastor') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;

  RETURN jsonb_build_object(
    'paper', jsonb_build_object('id', pr.id, 'title', pr.title, 'status', pr.status,
                               'mode', pr.mode, 'totalPoints', pr.total_points),

    'overall', (
      SELECT jsonb_build_object(
        'attempts',  COUNT(*),
        'submitted', COUNT(*) FILTER (WHERE a.status IN ('submitted','graded')),
        'graded',    COUNT(*) FILTER (WHERE a.status = 'graded'),
        'inProgress',COUNT(*) FILTER (WHERE a.status = 'in_progress'),
        'avgAuto',   ROUND(AVG(a.auto_score)  FILTER (WHERE a.status IN ('submitted','graded'))::numeric, 1),
        'avgManual', ROUND(AVG(a.manual_score)FILTER (WHERE a.status = 'graded')::numeric, 1),
        'avgTotal',  ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1),
        'maxTotal',  MAX(a.total_score) FILTER (WHERE a.status = 'graded'),
        'minTotal',  MIN(a.total_score) FILTER (WHERE a.status = 'graded'))
      FROM public.exam_attempts a WHERE a.paper_id = pr.id
    ),

    'byRegion', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.name) FROM (
        SELECT COALESCE(NULLIF(p.great_region, ''), '（未分區）') AS name,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE a.status = 'graded') AS graded,
               ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1) AS "avgTotal"
        FROM public.exam_attempts a JOIN public.profiles p ON p.id = a.user_id
        WHERE a.paper_id = pr.id AND a.status IN ('submitted','graded')
        GROUP BY 1
      ) x
    ), '[]'::jsonb),

    'byZone', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.region, x.name) FROM (
        SELECT COALESCE(NULLIF(p.great_region, ''), '（未分區）') AS region,
               COALESCE(NULLIF(p.pastoral_zone, ''), '（未分牧區）') AS name,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE a.status = 'graded') AS graded,
               ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1) AS "avgTotal"
        FROM public.exam_attempts a JOIN public.profiles p ON p.id = a.user_id
        WHERE a.paper_id = pr.id AND a.status IN ('submitted','graded')
        GROUP BY 1, 2
      ) x
    ), '[]'::jsonb),

    'byGroup', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.zone, x.name) FROM (
        SELECT COALESCE(NULLIF(p.pastoral_zone, ''), '（未分牧區）') AS zone,
               COALESCE(NULLIF(p.small_group, ''), '（未分組）') AS name,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE a.status = 'graded') AS graded,
               ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1) AS "avgTotal"
        FROM public.exam_attempts a JOIN public.profiles p ON p.id = a.user_id
        WHERE a.paper_id = pr.id AND a.status IN ('submitted','graded')
        GROUP BY 1, 2
      ) x
    ), '[]'::jsonb),

    'byQuestion', COALESCE((
      SELECT jsonb_agg(x ORDER BY x."sectionRank", x.position) FROM (
        SELECT q.section, q.position,
               public._exam_section_rank(q.section) AS "sectionRank",
               COUNT(ea.*) AS answered,
               COUNT(ea.*) FILTER (WHERE ea.auto_correct) AS correct,
               ROUND((COUNT(ea.*) FILTER (WHERE ea.auto_correct))::numeric
                     / NULLIF(COUNT(ea.*), 0), 3) AS "correctRate"
        FROM public.exam_questions q
        JOIN public.exam_answers ea ON ea.question_id = q.id
        JOIN public.exam_attempts a ON a.id = ea.attempt_id AND a.status IN ('submitted','graded')
        WHERE q.paper_id = pr.id AND q.section <> 'shortanswer'
        GROUP BY q.id, q.section, q.position
      ) x
    ), '[]'::jsonb),

    'roster', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'userId', a.user_id, 'name', p.name,
        'greatRegion', p.great_region, 'pastoralZone', p.pastoral_zone, 'smallGroup', p.small_group,
        'team', rt.name, 'teamDivision', rt.division,
        'status', a.status,
        'autoScore', a.auto_score, 'manualScore', a.manual_score, 'totalScore', a.total_score,
        'submittedAt', a.submitted_at)
      ORDER BY a.total_score DESC NULLS LAST, a.submitted_at ASC)
      FROM public.exam_attempts a
      JOIN public.profiles p ON p.id = a.user_id
      LEFT JOIN public.reading_teams rt ON rt.id = a.reading_team_id
      WHERE a.paper_id = pr.id AND a.status IN ('submitted','graded')
    ), '[]'::jsonb)
  );
END;
$$;

-- ── 成績通知 ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_exam_notifications(p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', n.id, 'type', 'exam', 'status', n.status, 'message', n.message,
      'createdAt', n.created_at, 'sent_on', to_char(n.created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD'),
      'paperId', a.paper_id, 'paperTitle', pr.title,
      'totalScore', a.total_score,
      'sender', jsonb_build_object('name', pr.title, 'role_definition', jsonb_build_object('code', 'exam')))
    ORDER BY n.created_at DESC)
    FROM (
      SELECT * FROM public.exam_notifications
      WHERE recipient_id = actor_id
      ORDER BY created_at DESC LIMIT 50
    ) n
    JOIN public.exam_attempts a ON a.id = n.attempt_id
    JOIN public.exam_papers pr ON pr.id = a.paper_id
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_exam_notifications_read(p_notification_id UUID DEFAULT NULL, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  n INTEGER;
BEGIN
  UPDATE public.exam_notifications
  SET status = 'read', read_at = NOW()
  WHERE recipient_id = actor_id AND status = 'unread'
    AND (p_notification_id IS NULL OR id = p_notification_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('updated', n);
END;
$$;

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'exam_get_stats(uuid, uuid)',
    'get_exam_notifications(uuid)',
    'mark_exam_notifications_read(uuid, uuid)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
