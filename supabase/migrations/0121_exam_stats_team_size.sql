-- ============================================================================
-- 0121_exam_stats_team_size.sql
-- 測驗統計 exam_get_stats 改寫：
--
--  1. 「組隊」區塊重做
--     舊：byDivision（依 exam_attempts.reading_team_id，作答時幾乎沒帶到 → 只剩「個人」）
--         + byTeam（→ 0 隊）
--     新：byTeamSize —— 依「作答者本人是否為 3 人 / 6 人讀經團隊的成員」
--         （查 reading_team_members，不靠 attempt 快照）分 3 人團隊 / 6 人團隊 / 未組隊。
--         同時在兩種團隊的人兩邊都計入。
--         teamRanking —— 每一隊（有人作答的）隊伍總分 = 成員 total_score 加總，
--         RANK() 依 division 分開排名 → 3 人隊排行、6 人隊排行各一份。
--     roster 每列改回傳 teamLabel（3 人團隊 / 6 人團隊 / 3+6 人團隊 / 個人）。
--
--  2. 依權限範圍顯示（跟計畫管理 / 小測驗一致）
--     admin / pastor → 全教會；great_zone_leader / zone_leader / group_leader
--     → 只看自己 managed_regions / managed_zones / managed_groups 內的作答。
--     空範圍 fail closed（= ANY('{}') 永遠 false）——不外洩全教會。
--     回傳多一個 scope 欄（'all' / 'scoped'）給前端標示。
--
-- 部署：Supabase SQL editor 執行，或 supabase db push。
--       nlc-data 需把 exam_get_stats 移出 EXAM_ADMIN_RPC_FUNCTIONS（留在 EXAM_RPC_FUNCTIONS）
--       並重新部署——否則 leader 角色會被 nlc-data 的 isAdmin 閘門擋掉。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_get_stats(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  actor    public.profiles%ROWTYPE;
  role_c   TEXT;
  pr       public.exam_papers%ROWTYPE;
  mreg     TEXT[];
  mzon     TEXT[];
  mgrp     TEXT[];
  scoped   UUID[];
  scope_label TEXT;
BEGIN
  SELECT * INTO actor FROM public.profiles WHERE id = actor_id;
  role_c := COALESCE(public.role_code(actor.role_id), 'member');
  IF role_c NOT IN ('admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;

  SELECT * INTO pr FROM public.exam_papers WHERE id = p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;

  -- 委派範圍（比照 get_admin_member_team_placements：COALESCE(NULLIF(managed_x,''), 本人欄位, '')）
  mreg := ARRAY(SELECT NULLIF(BTRIM(x), '') FROM UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor.managed_regions, ''), actor.great_region, ''), ',')) AS x
          WHERE NULLIF(BTRIM(x), '') IS NOT NULL);
  mzon := ARRAY(SELECT NULLIF(BTRIM(x), '') FROM UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor.managed_zones, ''), actor.pastoral_zone, ''), ',')) AS x
          WHERE NULLIF(BTRIM(x), '') IS NOT NULL);
  mgrp := ARRAY(SELECT NULLIF(BTRIM(x), '') FROM UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor.managed_groups, ''), actor.small_group, ''), ',')) AS x
          WHERE NULLIF(BTRIM(x), '') IS NOT NULL);

  scope_label := CASE WHEN role_c IN ('admin', 'pastor') THEN 'all' ELSE 'scoped' END;

  -- 這位使用者「看得到」的作答 id 清單。空清單 → 下面每個彙整都空（fail closed）。
  SELECT COALESCE(array_agg(a.id), '{}') INTO scoped
  FROM public.exam_attempts a
  JOIN public.profiles p ON p.id = a.user_id
  WHERE a.paper_id = pr.id
    AND (
      role_c IN ('admin', 'pastor')
      OR (role_c = 'great_zone_leader' AND p.great_region = ANY(mreg))
      OR (role_c = 'zone_leader'       AND p.pastoral_zone = ANY(mzon))
      OR (role_c = 'group_leader'      AND p.small_group   = ANY(mgrp))
    );

  RETURN jsonb_build_object(
    'paper', jsonb_build_object('id', pr.id, 'title', pr.title, 'status', pr.status,
                               'mode', pr.mode, 'totalPoints', pr.total_points),
    'scope', scope_label,

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
      FROM public.exam_attempts a WHERE a.id = ANY(scoped)
    ),

    'byRegion', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.name) FROM (
        SELECT COALESCE(NULLIF(p.great_region, ''), '（未分區）') AS name,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE a.status = 'graded') AS graded,
               ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1) AS "avgTotal"
        FROM public.exam_attempts a JOIN public.profiles p ON p.id = a.user_id
        WHERE a.id = ANY(scoped) AND a.status IN ('submitted','graded')
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
        WHERE a.id = ANY(scoped) AND a.status IN ('submitted','graded')
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
        WHERE a.id = ANY(scoped) AND a.status IN ('submitted','graded')
        GROUP BY 1, 2
      ) x
    ), '[]'::jsonb),

    -- ── 3 人團隊 / 6 人團隊 / 未組隊 ──
    'byTeamSize', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'label', b.label, 'count', b.cnt, 'graded', b.graded, 'avgTotal', b.avg_total
             ) ORDER BY b.sort)
      FROM (
        SELECT bl.label, bl.sort,
               COUNT(*) FILTER (WHERE bl.member)                                AS cnt,
               COUNT(*) FILTER (WHERE bl.member AND a.status = 'graded')        AS graded,
               ROUND(AVG(a.total_score) FILTER (WHERE bl.member AND a.status = 'graded')::numeric, 1) AS avg_total
        FROM public.exam_attempts a
        CROSS JOIN LATERAL (VALUES
          ('3 人團隊'::text, 1, EXISTS (SELECT 1 FROM public.reading_team_members m
                                       WHERE m.user_id = a.user_id AND m.division = 3)),
          ('6 人團隊'::text, 2, EXISTS (SELECT 1 FROM public.reading_team_members m
                                       WHERE m.user_id = a.user_id AND m.division = 6)),
          ('未組隊'::text,   3, NOT EXISTS (SELECT 1 FROM public.reading_team_members m
                                           WHERE m.user_id = a.user_id AND m.division IN (3, 6)))
        ) AS bl(label, sort, member)
        WHERE a.id = ANY(scoped) AND a.status IN ('submitted','graded')
        GROUP BY bl.label, bl.sort
      ) b
      WHERE b.cnt > 0
    ), '[]'::jsonb),

    -- ── 3 人隊排行 / 6 人隊排行（分開排名；隊伍總分 = 範圍內成員 total_score 加總）──
    'teamRanking', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'teamId', t.team_id, 'name', t.name, 'division', t.division,
               'rank', t.rnk,
               'completed', t.completed, 'submitted', t.submitted_cnt,
               'teamTotal', t.team_total, 'avgTotal', t.avg_total
             ) ORDER BY t.division, t.rnk, t.name)
      FROM (
        SELECT rt.id AS team_id, rt.name, rt.division,
               COUNT(a.*) FILTER (WHERE a.status = 'graded')                     AS completed,
               COUNT(a.*) FILTER (WHERE a.status IN ('submitted','graded'))      AS submitted_cnt,
               COALESCE(SUM(a.total_score) FILTER (WHERE a.status = 'graded'), 0) AS team_total,
               ROUND(AVG(a.total_score) FILTER (WHERE a.status = 'graded')::numeric, 1) AS avg_total,
               RANK() OVER (
                 PARTITION BY rt.division
                 ORDER BY COALESCE(SUM(a.total_score) FILTER (WHERE a.status = 'graded'), 0) DESC
               ) AS rnk
        FROM public.reading_teams rt
        JOIN public.reading_team_members m ON m.team_id = rt.id
        LEFT JOIN public.exam_attempts a ON a.user_id = m.user_id AND a.id = ANY(scoped)
        GROUP BY rt.id, rt.name, rt.division
        HAVING COUNT(a.*) FILTER (WHERE a.status IN ('submitted','graded')) > 0
      ) t
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
        JOIN public.exam_attempts a ON a.id = ea.attempt_id
                                   AND a.status IN ('submitted','graded')
                                   AND a.id = ANY(scoped)
        WHERE q.paper_id = pr.id AND q.section <> 'shortanswer'
        GROUP BY q.id, q.section, q.position
      ) x
    ), '[]'::jsonb),

    'roster', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'userId', a.user_id, 'name', p.name,
        'greatRegion', p.great_region, 'pastoralZone', p.pastoral_zone, 'smallGroup', p.small_group,
        'teamLabel', (
          SELECT CASE
            WHEN bool_or(m.division = 3) AND bool_or(m.division = 6) THEN '3+6 人團隊'
            WHEN bool_or(m.division = 3) THEN '3 人團隊'
            WHEN bool_or(m.division = 6) THEN '6 人團隊'
            ELSE '個人' END
          FROM public.reading_team_members m WHERE m.user_id = a.user_id
        ),
        'status', a.status,
        'autoScore', a.auto_score, 'manualScore', a.manual_score, 'totalScore', a.total_score,
        'submittedAt', a.submitted_at)
      ORDER BY a.total_score DESC NULLS LAST, a.submitted_at ASC)
      FROM public.exam_attempts a
      JOIN public.profiles p ON p.id = a.user_id
      WHERE a.id = ANY(scoped) AND a.status IN ('submitted','graded')
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exam_get_stats(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_get_stats(uuid, uuid) TO authenticated, service_role;
