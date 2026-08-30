-- ============================================================================
-- 0132_exam_export_answers.sql
-- exam_export_answers(paper) — 後台「匯出完整作答」用：把每位（scoped）作答者
-- 對每一題的作答攤平成一列，前端組成 long-format CSV。
--   · 角色：admin / pastor 全教會；great_zone_leader / zone_leader / group_leader
--     只出自己 managed 範圍（比照 exam_get_stats 0121/0129 的 scoped 作法，
--     空範圍 fail closed）。
--   · 只含正式首考（attempt_kind='official'）且已送出 / 已批改。
--   · response / payload / answerKey 直接回 jsonb，由前端 describeExamValue 轉文字。
--
-- 部署：Supabase SQL editor 執行。nlc-data 需把 exam_export_answers 加進
--       EXAM_RPC_FUNCTIONS（不進 admin set，函式自己做角色 + 範圍檢查），並重新部署。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.exam_export_answers(p_paper_id UUID, p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID := public.resolve_quiz_actor(p_actor_id);
  actor    public.profiles%ROWTYPE;
  role_c   TEXT;
  mreg TEXT[]; mzon TEXT[]; mgrp TEXT[];
  scoped UUID[];
BEGIN
  SELECT * INTO actor FROM public.profiles WHERE id = actor_id;
  role_c := COALESCE(public.role_code(actor.role_id), 'member');
  IF role_c NOT IN ('admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader') THEN
    RAISE EXCEPTION 'exam_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE id = p_paper_id) THEN
    RAISE EXCEPTION 'exam_paper_not_found';
  END IF;

  mreg := ARRAY(SELECT NULLIF(BTRIM(x), '') FROM UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor.managed_regions, ''), actor.great_region, ''), ',')) AS x
          WHERE NULLIF(BTRIM(x), '') IS NOT NULL);
  mzon := ARRAY(SELECT NULLIF(BTRIM(x), '') FROM UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor.managed_zones, ''), actor.pastoral_zone, ''), ',')) AS x
          WHERE NULLIF(BTRIM(x), '') IS NOT NULL);
  mgrp := ARRAY(SELECT NULLIF(BTRIM(x), '') FROM UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor.managed_groups, ''), actor.small_group, ''), ',')) AS x
          WHERE NULLIF(BTRIM(x), '') IS NOT NULL);

  SELECT COALESCE(array_agg(a.id), '{}') INTO scoped
  FROM public.exam_attempts a
  JOIN public.profiles p ON p.id = a.user_id
  WHERE a.paper_id = p_paper_id
    AND a.attempt_kind = 'official'
    AND a.status IN ('submitted', 'graded')
    AND (
      role_c IN ('admin', 'pastor')
      OR (role_c = 'great_zone_leader' AND p.great_region = ANY(mreg))
      OR (role_c = 'zone_leader'       AND p.pastoral_zone = ANY(mzon))
      OR (role_c = 'group_leader'      AND p.small_group   = ANY(mgrp))
    );

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'name', p.name,
      'greatRegion', p.great_region, 'pastoralZone', p.pastoral_zone, 'smallGroup', p.small_group,
      'status', a.status, 'submittedAt', a.submitted_at,
      'section', q.section, 'sectionRank', public._exam_section_rank(q.section),
      'position', q.position, 'points', q.points,
      'response', ea.response,
      'payload', q.payload,
      'answerKey', CASE WHEN q.section <> 'shortanswer' THEN q.answer_key ELSE NULL END,
      'autoCorrect', ea.auto_correct, 'awardedPoints', ea.awarded_points
    ) ORDER BY p.name, a.id, public._exam_section_rank(q.section), q.position)
    FROM public.exam_attempts a
    JOIN public.profiles p ON p.id = a.user_id
    JOIN public.exam_questions q ON q.paper_id = a.paper_id
    LEFT JOIN public.exam_answers ea ON ea.attempt_id = a.id AND ea.question_id = q.id
    WHERE a.id = ANY(scoped)
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_export_answers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_export_answers(uuid, uuid) TO authenticated, service_role;
