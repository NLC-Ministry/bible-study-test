-- ============================================================================
-- 0103_exam_team_stats.sql
-- exam_get_stats 加入「三人 / 六人組隊」統計：
--   byDivision — 個人 / 三人組 / 六人組 各有多少人作答、平均總分
--   byTeam     — 每一隊：隊名、組別、幾人作答、已批、平均/總和/最高/最低總分
-- （每人仍是獨立作答獨立計分；這裡只是依 exam_attempts.reading_team_id 彙整。）
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

    -- ── 個人 / 三人組 / 六人組 ──
    'byDivision', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.sort) FROM (
        SELECT COALESCE(rt.division, 0) AS division,
               CASE COALESCE(rt.division, 0) WHEN 3 THEN '三人組' WHEN 6 THEN '六人組' ELSE '個人' END AS label,
               CASE COALESCE(rt.division, 0) WHEN 0 THEN 0 WHEN 3 THEN 1 ELSE 2 END AS sort,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE a.status = 'graded') AS graded,
               ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1) AS "avgTotal"
        FROM public.exam_attempts a
        LEFT JOIN public.reading_teams rt ON rt.id = a.reading_team_id
        WHERE a.paper_id = pr.id AND a.status IN ('submitted','graded')
        GROUP BY 1, 2, 3
      ) x
    ), '[]'::jsonb),

    -- ── 每一隊 ──
    'byTeam', COALESCE((
      SELECT jsonb_agg(x ORDER BY x."avgTotal" DESC NULLS LAST, x.name) FROM (
        SELECT rt.name,
               rt.division,
               COUNT(*) AS members,
               COUNT(*) FILTER (WHERE a.status = 'graded') AS graded,
               ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1) AS "avgTotal",
               SUM(a.total_score) FILTER (WHERE a.status = 'graded') AS "totalSum",
               MAX(a.total_score) FILTER (WHERE a.status = 'graded') AS "maxTotal",
               MIN(a.total_score) FILTER (WHERE a.status = 'graded') AS "minTotal"
        FROM public.exam_attempts a
        JOIN public.reading_teams rt ON rt.id = a.reading_team_id
        WHERE a.paper_id = pr.id AND a.status IN ('submitted','graded')
        GROUP BY rt.id, rt.name, rt.division
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

REVOKE ALL ON FUNCTION public.exam_get_stats(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_get_stats(uuid, uuid) TO authenticated, service_role;
