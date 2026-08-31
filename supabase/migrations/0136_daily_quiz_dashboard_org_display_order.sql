-- 0136_daily_quiz_dashboard_org_display_order.sql
-- get_daily_quiz_dashboard 給小組長/牧區長看的「各小組每日測驗完成度」清單，
-- 原本照大區/牧區/小組名稱字母排序，改成用 great_regions/pastoral_zones 的
-- sort_order（migration 0133）排序。這裡跟其他三份會友名單不一樣：
-- small_groups.pastoral_zone_id 跟 pastoral_zones.great_region_id 本來就是
-- 正規的外鍵關聯，manageable_groups 這個 CTE 已經 JOIN 到
-- public.pastoral_zones/public.great_regions，所以直接多抓 sort_order 欄位
-- 就好，不需要再用名稱去額外配對。純粹是清單顯示順序，不是排名，其餘查詢
-- 邏輯（含各角色的管理範圍判斷）完全不變。

CREATE OR REPLACE FUNCTION public.get_daily_quiz_dashboard(
  p_global_plan_id UUID,
  p_quiz_date DATE,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $get_daily_quiz_dashboard$
DECLARE
  actor_id UUID;
  actor_role TEXT;
  publication_row public.quiz_publications%ROWTYPE;
  quiz_row public.daily_quizzes%ROWTYPE;
  attempt_row public.quiz_attempts%ROWTYPE;
  my_quiz JSONB := NULL;
  review_quizzes JSONB := '[]'::JSONB;
  managed_groups JSONB := '[]'::JSONB;
  approved_variants JSONB := '[]'::JSONB;
  auto_request_count INTEGER := 0;
BEGIN
  actor_id := public.resolve_quiz_actor(p_actor_id);
  SELECT public.role_code(role_id) INTO actor_role
  FROM public.profiles
  WHERE id = actor_id;

  SELECT publication.* INTO publication_row
  FROM public.quiz_publications publication
  WHERE publication.global_plan_id = p_global_plan_id
    AND publication.quiz_date = p_quiz_date
    AND public.profile_belongs_to_quiz_group(actor_id, publication.small_group_id)
  ORDER BY publication.published_at DESC
  LIMIT 1;

  IF publication_row.id IS NOT NULL THEN
    SELECT * INTO quiz_row FROM public.daily_quizzes WHERE id = publication_row.quiz_id;
    SELECT * INTO attempt_row
    FROM public.quiz_attempts
    WHERE publication_id = publication_row.id AND user_id = actor_id;
    my_quiz := jsonb_build_object(
      'publicationId', publication_row.id,
      'quizId', quiz_row.id,
      'quizDate', publication_row.quiz_date,
      'variant', quiz_row.variant,
      'chapterRefs', quiz_row.chapter_refs,
      'publisherRole', publication_row.publisher_role,
      'publishedAt', publication_row.published_at,
      'questions', public.quiz_questions_for_member(quiz_row.questions, attempt_row.id IS NOT NULL),
      'attempt', CASE WHEN attempt_row.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', attempt_row.id,
        'answers', attempt_row.answers,
        'score', attempt_row.score,
        'total', attempt_row.total,
        'completedAt', attempt_row.completed_at
      ) END
    );
  END IF;

  SELECT
    COALESCE(
      jsonb_agg(jsonb_build_object('id', id, 'variant', variant) ORDER BY variant)
        FILTER (WHERE generation_status = 'ready' AND review_status = 'approved' AND variant IN ('A', 'B')),
      '[]'::JSONB
    ),
    COALESCE(SUM(automatic_generation_attempts), 0)::INTEGER
  INTO approved_variants, auto_request_count
  FROM public.daily_quizzes
  WHERE global_plan_id = p_global_plan_id AND quiz_date = p_quiz_date;

  IF actor_role IN ('admin', 'pastor') THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', quiz.id,
      'variant', quiz.variant,
      'chapterRefs', quiz.chapter_refs,
      'questions', quiz.questions,
      'generationStatus', quiz.generation_status,
      'reviewStatus', quiz.review_status,
      'generationError', quiz.generation_error,
      'generatedAt', quiz.generated_at,
      'reviewedAt', quiz.reviewed_at
    ) ORDER BY quiz.variant), '[]'::JSONB)
    INTO review_quizzes
    FROM public.daily_quizzes quiz
    WHERE quiz.global_plan_id = p_global_plan_id AND quiz.quiz_date = p_quiz_date
      AND quiz.variant IN ('A', 'B');
  END IF;

  IF actor_role IN ('admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader') THEN
    WITH manageable_groups AS MATERIALIZED (
      SELECT
        g.id,
        g.name,
        g.pastoral_zone_id,
        COALESCE(z.name, '') AS pastoral_zone,
        COALESCE(r.name, '') AS great_region,
        z.sort_order AS zone_sort_order,
        r.sort_order AS great_region_sort_order
      FROM public.small_groups g
      LEFT JOIN public.pastoral_zones z ON z.id = g.pastoral_zone_id
      LEFT JOIN public.great_regions r ON r.id = z.great_region_id
      WHERE actor_role IN ('admin', 'pastor')
         OR public.can_manage_quiz_group(actor_id, g.id)
    ),
    direct_members AS (
      SELECT
        group_row.id AS group_id,
        member.id,
        member.name
      FROM manageable_groups group_row
      JOIN public.profiles member
        ON member.small_group_id = group_row.id
       AND member.is_active = TRUE
    ),
    legacy_members AS (
      SELECT
        group_row.id AS group_id,
        member.id,
        member.name
      FROM public.profiles member
      CROSS JOIN LATERAL unnest(string_to_array(COALESCE(member.small_group, ''), ',')) legacy_group_name(value)
      JOIN manageable_groups group_row
        ON btrim(legacy_group_name.value) <> ''
       AND btrim(legacy_group_name.value) = btrim(group_row.name)
       AND (
         member.pastoral_zone_id = group_row.pastoral_zone_id
         OR group_row.pastoral_zone = ''
         OR public.values_overlap(member.pastoral_zone, group_row.pastoral_zone)
       )
      WHERE member.is_active = TRUE
    ),
    member_matches AS MATERIALIZED (
      SELECT group_id, id, name FROM direct_members
      UNION
      SELECT group_id, id, name FROM legacy_members
    ),
    member_counts AS (
      SELECT group_id, COUNT(*)::INTEGER AS member_count
      FROM member_matches
      GROUP BY group_id
    ),
    target_publications AS MATERIALIZED (
      SELECT publication.*
      FROM public.quiz_publications publication
      WHERE publication.global_plan_id = p_global_plan_id
        AND publication.quiz_date = p_quiz_date
    ),
    attempt_stats AS (
      SELECT
        attempt.publication_id,
        COUNT(*)::INTEGER AS completed_count,
        ROUND(AVG(attempt.score)::NUMERIC, 1) AS average_score
      FROM public.quiz_attempts attempt
      JOIN target_publications publication ON publication.id = attempt.publication_id
      GROUP BY attempt.publication_id
    ),
    published_members AS (
      SELECT
        publication.small_group_id AS group_id,
        jsonb_agg(jsonb_build_object(
          'id', member.id,
          'name', member.name,
          'completed', attempt.id IS NOT NULL,
          'score', attempt.score,
          'total', attempt.total,
          'completedAt', attempt.completed_at
        ) ORDER BY member.name) AS members
      FROM target_publications publication
      JOIN member_matches member ON member.group_id = publication.small_group_id
      LEFT JOIN public.quiz_attempts attempt
        ON attempt.publication_id = publication.id AND attempt.user_id = member.id
      GROUP BY publication.small_group_id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', group_row.id,
      'name', group_row.name,
      'pastoralZone', group_row.pastoral_zone,
      'greatRegion', group_row.great_region,
      'memberCount', COALESCE(member_count.member_count, 0),
      'publication', CASE WHEN publication.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', publication.id,
        'variant', published_quiz.variant,
        'publisherRole', publication.publisher_role,
        'publisherName', COALESCE(publisher.name, ''),
        'publishedAt', publication.published_at
      ) END,
      'completedCount', COALESCE(attempt_stat.completed_count, 0),
      'averageScore', attempt_stat.average_score,
      'members', COALESCE(published_member.members, '[]'::JSONB)
    ) ORDER BY group_row.great_region_sort_order NULLS LAST, group_row.zone_sort_order NULLS LAST,
      group_row.great_region, group_row.pastoral_zone, group_row.name), '[]'::JSONB)
    INTO managed_groups
    FROM manageable_groups group_row
    LEFT JOIN member_counts member_count ON member_count.group_id = group_row.id
    LEFT JOIN target_publications publication ON publication.small_group_id = group_row.id
    LEFT JOIN public.daily_quizzes published_quiz ON published_quiz.id = publication.quiz_id
    LEFT JOIN public.profiles publisher ON publisher.id = publication.published_by
    LEFT JOIN attempt_stats attempt_stat ON attempt_stat.publication_id = publication.id
    LEFT JOIN published_members published_member ON published_member.group_id = group_row.id;
  END IF;

  RETURN jsonb_build_object(
    'quizDate', p_quiz_date,
    'role', actor_role,
    'canReview', actor_role IN ('admin', 'pastor'),
    'canPublish', actor_role IN ('admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader'),
    'automaticRequestCount', auto_request_count,
    'approvedVariants', approved_variants,
    'reviewQuizzes', review_quizzes,
    'managedGroups', managed_groups,
    'myQuiz', my_quiz
  );
END;
$get_daily_quiz_dashboard$;

COMMENT ON FUNCTION public.get_daily_quiz_dashboard(UUID, DATE, UUID) IS
  'Returns quiz review, publication, and attempt data. Review queue and approved-variant badges are scoped to A/B only; self-authored C quizzes are personal to their publish action. managedGroups is ordered by great_regions/pastoral_zones.sort_order (migration 0133), not name.';
