-- 0135_member_lists_org_display_order.sql
-- 三份後台會友名單（未加入計畫、已加入計畫、團隊配置）原本都是照
-- 大區/牧區/小組「文字字母」排序，改成用 great_regions/pastoral_zones
-- 的 sort_order（migration 0133）排序——這些是名單顯示順序，不是任何
-- 排名/名次計算，所以只動 ORDER BY，其餘查詢邏輯（含權限範圍檢查）
-- 完全不變。
--
-- profiles.great_region/pastoral_zone 是純文字欄位，沒有直接關聯到
-- great_regions/pastoral_zones 資料表，所以額外 LEFT JOIN 兩張表撈
-- sort_order；找不到對應資料列（名稱是舊資料、拼字不同或本來就是空白）
-- 時 sort_order 是 NULL，用 NULLS LAST 排到最後，不會讓整批名單消失或
-- 出錯，也不影響是否列入名單的原始篩選條件。

-- ── get_unjoined_plan_members（現行版本：migration 0045）──
CREATE OR REPLACE FUNCTION public.get_unjoined_plan_members(
  p_global_plan_id UUID,
  p_plan_key TEXT DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $get_unjoined_plan_members$
DECLARE
  actor_id UUID;
  actor_profile public.profiles%ROWTYPE;
  target_plan public.global_plans%ROWTYPE;
  members_json JSONB;
  reminder_key TEXT;
BEGIN
  actor_id := public.resolve_reading_team_actor(p_actor_id);
  SELECT * INTO actor_profile FROM public.profiles WHERE id = actor_id;
  SELECT * INTO target_plan FROM public.global_plans WHERE id = p_global_plan_id;

  IF actor_profile.id IS NULL
     OR actor_profile.role NOT IN ('admin', 'great_zone_leader', 'zone_leader') THEN
    RAISE EXCEPTION 'plan_management_scope_required';
  END IF;
  IF target_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found';
  END IF;

  reminder_key := 'plan-invite:' || target_plan.id::TEXT;

  SELECT COALESCE(
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'id', candidate.id,
        'name', candidate.name,
        'greatRegion', NULLIF(BTRIM(candidate.great_region), ''),
        'pastoralZone', NULLIF(BTRIM(candidate.pastoral_zone), ''),
        'smallGroup', NULLIF(BTRIM(candidate.small_group), ''),
        'remindedToday', EXISTS (
          SELECT 1
          FROM public.care_reminders AS reminder
          WHERE reminder.sender_id = actor_id
            AND reminder.recipient_id = candidate.id
            AND reminder.plan_key = reminder_key
            AND reminder.sent_on = CURRENT_DATE
        )
      )
      ORDER BY gr.sort_order NULLS LAST, pz.sort_order NULLS LAST,
        candidate.great_region, candidate.pastoral_zone, candidate.small_group, candidate.name
    ),
    '[]'::JSONB
  ) INTO members_json
  FROM public.profiles AS candidate
  LEFT JOIN public.great_regions AS gr ON gr.name = candidate.great_region
  LEFT JOIN public.pastoral_zones AS pz ON pz.name = candidate.pastoral_zone AND pz.great_region_id = gr.id
  WHERE candidate.is_active = TRUE
    AND candidate.is_demo = FALSE
    AND candidate.id <> actor_id
    AND (
      actor_profile.role = 'admin'
      OR (
        actor_profile.role = 'great_zone_leader'
        AND EXISTS (
          SELECT 1
          FROM UNNEST(STRING_TO_ARRAY(COALESCE(candidate.great_region, ''), ',')) AS member_scope(value)
          JOIN UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor_profile.managed_regions, ''), actor_profile.great_region, ''), ','
          )) AS actor_scope(value)
            ON BTRIM(member_scope.value) = BTRIM(actor_scope.value)
          WHERE BTRIM(member_scope.value) <> ''
        )
      )
      OR (
        actor_profile.role = 'zone_leader'
        AND EXISTS (
          SELECT 1
          FROM UNNEST(STRING_TO_ARRAY(COALESCE(candidate.pastoral_zone, ''), ',')) AS member_scope(value)
          JOIN UNNEST(STRING_TO_ARRAY(
            COALESCE(NULLIF(actor_profile.managed_zones, ''), actor_profile.pastoral_zone, ''), ','
          )) AS actor_scope(value)
            ON BTRIM(member_scope.value) = BTRIM(actor_scope.value)
          WHERE BTRIM(member_scope.value) <> ''
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.reading_plans AS reading_plan
      WHERE reading_plan.user_id = candidate.id
        AND (
          reading_plan.global_plan_id = target_plan.id
          OR (
            NULLIF(BTRIM(p_plan_key), '') IS NOT NULL
            AND reading_plan.preset_key = BTRIM(p_plan_key)
          )
        )
    );

  RETURN JSONB_BUILD_OBJECT(
    'planId', target_plan.id,
    'planName', target_plan.name,
    'members', members_json
  );
END;
$get_unjoined_plan_members$;

REVOKE ALL ON FUNCTION public.get_unjoined_plan_members(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_unjoined_plan_members(UUID, TEXT, UUID) TO authenticated, service_role;

-- ── get_joined_plan_members（現行版本：migration 0079）──
CREATE OR REPLACE FUNCTION public.get_joined_plan_members(
  p_global_plan_id UUID,
  p_plan_key TEXT DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $get_joined_plan_members$
DECLARE
  actor_id UUID;
  actor_profile public.profiles%ROWTYPE;
  actor_role TEXT;
  target_plan public.global_plans%ROWTYPE;
  members_json JSONB;
BEGIN
  actor_id := public.resolve_reading_team_actor(p_actor_id);
  SELECT * INTO actor_profile FROM public.profiles WHERE id = actor_id;
  SELECT * INTO target_plan FROM public.global_plans WHERE id = p_global_plan_id;

  IF actor_profile.id IS NULL THEN
    RAISE EXCEPTION 'profile_identity_not_found';
  END IF;

  actor_role := public.role_code(actor_profile.role_id);
  IF actor_role NOT IN ('admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader') THEN
    RAISE EXCEPTION 'plan_management_scope_required';
  END IF;
  IF target_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found';
  END IF;

  SELECT COALESCE(
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'id', candidate.id,
        'name', candidate.name,
        'greatRegion', NULLIF(BTRIM(candidate.great_region), ''),
        'pastoralZone', NULLIF(BTRIM(candidate.pastoral_zone), ''),
        'smallGroup', NULLIF(BTRIM(candidate.small_group), ''),
        'joinedAt', joined_plan.created_at,
        'currentRound', COALESCE(joined_plan.current_round, 1)
      )
      ORDER BY gr.sort_order NULLS LAST, pz.sort_order NULLS LAST,
        candidate.great_region, candidate.pastoral_zone, candidate.small_group, candidate.name
    ),
    '[]'::JSONB
  ) INTO members_json
  FROM public.profiles AS candidate
  JOIN public.reading_plans AS joined_plan
    ON joined_plan.user_id = candidate.id
   AND (
     joined_plan.global_plan_id = target_plan.id
     OR (
       NULLIF(BTRIM(p_plan_key), '') IS NOT NULL
       AND joined_plan.preset_key = BTRIM(p_plan_key)
     )
   )
  LEFT JOIN public.great_regions AS gr ON gr.name = candidate.great_region
  LEFT JOIN public.pastoral_zones AS pz ON pz.name = candidate.pastoral_zone AND pz.great_region_id = gr.id
  WHERE candidate.is_active = TRUE
    AND candidate.is_demo = FALSE
    AND candidate.id <> actor_id
    AND (
      actor_role IN ('admin', 'pastor')
      OR (actor_role = 'great_zone_leader' AND public.values_overlap(candidate.great_region, COALESCE(NULLIF(actor_profile.managed_regions, ''), actor_profile.great_region, '')))
      OR (actor_role = 'zone_leader' AND public.values_overlap(candidate.pastoral_zone, COALESCE(NULLIF(actor_profile.managed_zones, ''), actor_profile.pastoral_zone, '')))
      OR (actor_role = 'group_leader' AND public.values_overlap(candidate.small_group, COALESCE(NULLIF(actor_profile.managed_groups, ''), actor_profile.small_group, '')))
    );

  RETURN JSONB_BUILD_OBJECT(
    'planId', target_plan.id,
    'planName', target_plan.name,
    'members', members_json
  );
END;
$get_joined_plan_members$;

REVOKE ALL ON FUNCTION public.get_joined_plan_members(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_joined_plan_members(UUID, TEXT, UUID) TO authenticated, service_role;

-- ── get_admin_member_team_placements（現行版本：migration 0081）──
CREATE OR REPLACE FUNCTION public.get_admin_member_team_placements(
  p_global_plan_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $get_admin_member_team_placements$
DECLARE
  actor_id UUID;
  actor_profile public.profiles%ROWTYPE;
  actor_role TEXT;
  target_plan public.global_plans%ROWTYPE;
  managed_regions_arr TEXT[];
  managed_zones_arr TEXT[];
  managed_groups_arr TEXT[];
  results_json JSONB;
BEGIN
  actor_id := public.resolve_reading_team_actor(p_actor_id);
  SELECT * INTO actor_profile FROM public.profiles WHERE id = actor_id;
  SELECT * INTO target_plan FROM public.global_plans WHERE id = p_global_plan_id;

  IF actor_profile.id IS NULL THEN
    RAISE EXCEPTION 'profile_identity_not_found';
  END IF;

  actor_role := public.role_code(actor_profile.role_id);
  IF actor_role NOT IN ('admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader') THEN
    RAISE EXCEPTION 'plan_management_scope_required';
  END IF;

  IF target_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found';
  END IF;

  -- Prepare delegated managed scopes arrays
  managed_regions_arr := ARRAY(
    SELECT NULLIF(BTRIM(x), '')
    FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor_profile.managed_regions, ''), actor_profile.great_region, ''), ',')) AS x
    WHERE NULLIF(BTRIM(x), '') IS NOT NULL
  );
  managed_zones_arr := ARRAY(
    SELECT NULLIF(BTRIM(x), '')
    FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor_profile.managed_zones, ''), actor_profile.pastoral_zone, ''), ',')) AS x
    WHERE NULLIF(BTRIM(x), '') IS NOT NULL
  );
  managed_groups_arr := ARRAY(
    SELECT NULLIF(BTRIM(x), '')
    FROM UNNEST(STRING_TO_ARRAY(COALESCE(NULLIF(actor_profile.managed_groups, ''), actor_profile.small_group, ''), ',')) AS x
    WHERE NULLIF(BTRIM(x), '') IS NOT NULL
  );

  SELECT COALESCE(
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'profileId', candidate.id,
        'name', candidate.name,
        'email', candidate.email,
        'greatRegion', NULLIF(BTRIM(candidate.great_region), ''),
        'pastoralZone', NULLIF(BTRIM(candidate.pastoral_zone), ''),
        'smallGroup', NULLIF(BTRIM(candidate.small_group), ''),
        'isJoined', (membership.user_id IS NOT NULL),
        'teamId', team.id,
        'teamName', team.name,
        'division', membership.division,
        'memberRole', membership.member_role,
        'memberCount', (
          SELECT COUNT(*)
          FROM public.reading_team_members AS tm
          WHERE tm.team_id = team.id
        )
      )
      ORDER BY gr.sort_order NULLS LAST, pz.sort_order NULLS LAST,
        candidate.great_region, candidate.pastoral_zone, candidate.small_group, candidate.name
    ),
    '[]'::JSONB
  ) INTO results_json
  FROM public.profiles AS candidate
  LEFT JOIN public.reading_team_members AS membership
    ON membership.user_id = candidate.id
   AND membership.global_plan_id = target_plan.id
  LEFT JOIN public.reading_teams AS team
    ON team.id = membership.team_id
  LEFT JOIN public.great_regions AS gr ON gr.name = candidate.great_region
  LEFT JOIN public.pastoral_zones AS pz ON pz.name = candidate.pastoral_zone AND pz.great_region_id = gr.id
  WHERE candidate.is_active = TRUE
    AND candidate.is_demo = FALSE
    AND (
      actor_role IN ('admin', 'pastor')
      OR (actor_role = 'great_zone_leader' AND candidate.great_region = ANY(managed_regions_arr))
      OR (actor_role = 'zone_leader' AND candidate.pastoral_zone = ANY(managed_zones_arr))
      OR (actor_role = 'group_leader' AND candidate.small_group = ANY(managed_groups_arr))
    );

  RETURN results_json;
END;
$get_admin_member_team_placements$;

REVOKE ALL ON FUNCTION public.get_admin_member_team_placements(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_member_team_placements(UUID, UUID) TO authenticated, service_role;
