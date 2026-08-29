-- 0129_exam_team_fixed_denominator.sql
-- 團隊公平計分：3 人隊固定除以 3、6 人隊固定除以 6。
-- 未完成或未評分成員視為 0 分；不可用實際完成人數縮小分母。

CREATE OR REPLACE FUNCTION public.exam_get_stats(p_paper_id UUID,p_actor_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id UUID:=public.resolve_quiz_actor(p_actor_id);actor public.profiles%ROWTYPE;role_c TEXT;
  pr public.exam_papers%ROWTYPE;mreg TEXT[];mzon TEXT[];mgrp TEXT[];scoped UUID[];scope_label TEXT;
BEGIN
  PERFORM public._exam_close_expired_papers();
  SELECT * INTO actor FROM public.profiles WHERE id=actor_id;
  role_c:=COALESCE(public.role_code(actor.role_id),'member');
  IF role_c NOT IN('admin','pastor','great_zone_leader','zone_leader','group_leader') THEN RAISE EXCEPTION 'exam_admin_required'; END IF;
  SELECT * INTO pr FROM public.exam_papers WHERE id=p_paper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'exam_paper_not_found'; END IF;
  mreg:=ARRAY(SELECT NULLIF(BTRIM(x),'')FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_regions,''),actor.great_region,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mzon:=ARRAY(SELECT NULLIF(BTRIM(x),'')FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_zones,''),actor.pastoral_zone,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  mgrp:=ARRAY(SELECT NULLIF(BTRIM(x),'')FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor.managed_groups,''),actor.small_group,''),','))x WHERE NULLIF(BTRIM(x),'')IS NOT NULL);
  scope_label:=CASE WHEN role_c IN('admin','pastor')THEN'all' ELSE'scoped' END;
  SELECT COALESCE(array_agg(a.id),'{}')INTO scoped
  FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
  WHERE a.paper_id=pr.id AND a.attempt_kind='official' AND(
    role_c IN('admin','pastor')OR(role_c='great_zone_leader' AND p.great_region=ANY(mreg))
    OR(role_c='zone_leader' AND p.pastoral_zone=ANY(mzon))
    OR(role_c='group_leader' AND p.small_group=ANY(mgrp)));

  RETURN jsonb_build_object(
    'paper',jsonb_build_object('id',pr.id,'title',pr.title,'status',pr.status,'mode',pr.mode,'totalPoints',pr.total_points),
    'scope',scope_label,
    'overall',(SELECT jsonb_build_object('attempts',COUNT(*),
      'submitted',COUNT(*)FILTER(WHERE a.status IN('submitted','graded')),
      'graded',COUNT(*)FILTER(WHERE a.status='graded'),'inProgress',COUNT(*)FILTER(WHERE a.status='in_progress'),
      'avgAuto',ROUND(AVG(a.auto_score)FILTER(WHERE a.status IN('submitted','graded'))::numeric,1),
      'avgManual',ROUND(AVG(a.manual_score)FILTER(WHERE a.status='graded')::numeric,1),
      'avgTotal',ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1),
      'maxTotal',MAX(a.total_score)FILTER(WHERE a.status='graded'),'minTotal',MIN(a.total_score)FILTER(WHERE a.status='graded'))
      FROM public.exam_attempts a WHERE a.id=ANY(scoped)),
    'byRegion',COALESCE((SELECT jsonb_agg(x ORDER BY x.name)FROM(
      SELECT COALESCE(NULLIF(p.great_region,''),'（未分區）')name,COUNT(*)count,
        COUNT(*)FILTER(WHERE a.status='graded')graded,ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1)"avgTotal"
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')GROUP BY 1)x),'[]'::jsonb),
    'byZone',COALESCE((SELECT jsonb_agg(x ORDER BY x.region,x.name)FROM(
      SELECT COALESCE(NULLIF(p.great_region,''),'（未分區）')region,
        COALESCE(NULLIF(p.pastoral_zone,''),'（未分牧區）')name,COUNT(*)count,
        COUNT(*)FILTER(WHERE a.status='graded')graded,ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1)"avgTotal"
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')GROUP BY 1,2)x),'[]'::jsonb),
    'byGroup',COALESCE((SELECT jsonb_agg(x ORDER BY x.zone,x.name)FROM(
      SELECT COALESCE(NULLIF(p.pastoral_zone,''),'（未分牧區）')zone,
        COALESCE(NULLIF(p.small_group,''),'（未分組）')name,COUNT(*)count,
        COUNT(*)FILTER(WHERE a.status='graded')graded,ROUND(AVG(a.total_score)FILTER(WHERE a.status='graded')::numeric,1)"avgTotal"
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')GROUP BY 1,2)x),'[]'::jsonb),
    'byTeamSize',COALESCE((SELECT jsonb_agg(jsonb_build_object('label',b.label,'count',b.cnt,
      'graded',b.graded,'avgTotal',b.avg_total)ORDER BY b.sort)FROM(
      SELECT bl.label,bl.sort,COUNT(*)FILTER(WHERE bl.member)cnt,
        COUNT(*)FILTER(WHERE bl.member AND a.status='graded')graded,
        ROUND(AVG(a.total_score)FILTER(WHERE bl.member AND a.status='graded')::numeric,1)avg_total
      FROM public.exam_attempts a CROSS JOIN LATERAL(VALUES
        ('3 人團隊'::text,1,EXISTS(SELECT 1 FROM public.reading_team_members m WHERE m.user_id=a.user_id AND m.division=3)),
        ('6 人團隊'::text,2,EXISTS(SELECT 1 FROM public.reading_team_members m WHERE m.user_id=a.user_id AND m.division=6)),
        ('未組隊'::text,3,NOT EXISTS(SELECT 1 FROM public.reading_team_members m WHERE m.user_id=a.user_id AND m.division IN(3,6)))
      )bl(label,sort,member)WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')
      GROUP BY bl.label,bl.sort)b WHERE b.cnt>0),'[]'::jsonb),
    'teamRanking',COALESCE((SELECT jsonb_agg(jsonb_build_object('teamId',t.team_id,'name',t.name,
      'division',t.division,'rank',t.rnk,'completed',t.completed,'submitted',t.submitted_cnt,
      'teamTotal',t.team_total,'avgTotal',t.avg_total)ORDER BY t.division,t.rnk,t.name)FROM(
      SELECT ranked.team_id,ranked.name,ranked.division,ranked.completed,ranked.submitted_cnt,
        ranked.team_total,ranked.avg_total,
        RANK()OVER(PARTITION BY ranked.division ORDER BY ranked.avg_total DESC)rnk
      FROM(
        SELECT rt.id team_id,rt.name,rt.division,
          COUNT(a.*)FILTER(WHERE a.status='graded')completed,
          COUNT(a.*)FILTER(WHERE a.status IN('submitted','graded'))submitted_cnt,
          COALESCE(SUM(a.total_score)FILTER(WHERE a.status='graded'),0)team_total,
          ROUND(COALESCE(SUM(a.total_score)FILTER(WHERE a.status='graded'),0)::numeric/rt.division,1)avg_total
        FROM public.reading_teams rt
        JOIN public.exam_attempts a ON a.reading_team_id=rt.id AND a.id=ANY(scoped)
        GROUP BY rt.id,rt.name,rt.division
        HAVING COUNT(a.*)FILTER(WHERE a.status IN('submitted','graded'))>0
      )ranked
    )t),'[]'::jsonb),
    'byQuestion',COALESCE((SELECT jsonb_agg(x ORDER BY x."sectionRank",x.position)FROM(
      SELECT q.section,q.position,public._exam_section_rank(q.section)"sectionRank",COUNT(ea.*)answered,
        COUNT(ea.*)FILTER(WHERE ea.auto_correct)correct,
        ROUND((COUNT(ea.*)FILTER(WHERE ea.auto_correct))::numeric/NULLIF(COUNT(ea.*),0),3)"correctRate"
      FROM public.exam_questions q JOIN public.exam_answers ea ON ea.question_id=q.id
      JOIN public.exam_attempts a ON a.id=ea.attempt_id AND a.status IN('submitted','graded')AND a.id=ANY(scoped)
      WHERE q.paper_id=pr.id AND q.section<>'shortanswer' GROUP BY q.id,q.section,q.position)x),'[]'::jsonb),
    'roster',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',a.user_id,'name',p.name,
      'greatRegion',p.great_region,'pastoralZone',p.pastoral_zone,'smallGroup',p.small_group,
      'teamLabel',(SELECT CASE WHEN bool_or(m.division=3)AND bool_or(m.division=6)THEN'3+6 人團隊'
        WHEN bool_or(m.division=3)THEN'3 人團隊' WHEN bool_or(m.division=6)THEN'6 人團隊' ELSE'個人'END
        FROM public.reading_team_members m WHERE m.user_id=a.user_id),
      'status',a.status,'autoScore',a.auto_score,'manualScore',a.manual_score,'totalScore',a.total_score,
      'submittedAt',a.submitted_at)ORDER BY a.total_score DESC NULLS LAST,a.submitted_at ASC)
      FROM public.exam_attempts a JOIN public.profiles p ON p.id=a.user_id
      WHERE a.id=ANY(scoped)AND a.status IN('submitted','graded')),'[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.exam_get_stats(UUID,UUID) TO authenticated;

COMMENT ON FUNCTION public.exam_get_stats(UUID,UUID)
IS '正式測驗統計；團隊平均固定以 reading_teams.division（3 或 6）為分母，未完成成員按 0 分計。';
