-- ============================================================================
-- 0144_get_unjoined_plan_members_role_id.sql
--
-- 修 get_unjoined_plan_members：0135 版仍在讀已被移除的 profiles.role 欄位
--   → RPC 執行時 RAISE 'record "actor_profile" has no field "role"' (42703)
--   → nlc-data 回 HTTP 400；進「管理 → 計畫管理」每次都撞（不分計畫）。
--
-- 同一支 migration（0135）裡的 get_joined_plan_members / get_admin_member_team_placements
-- 已改用 public.role_code(actor_profile.role_id)，只有這支漏改。
--
-- 這裡把它對齊 get_joined_plan_members 的寫法：role_id → role_code、5 個管理角色的
-- 閘門、四個範圍分支都走 public.values_overlap。查詢的「是否列入名單」邏輯不變
-- （未加入該計畫 = NOT EXISTS reading_plans 對 global_plan_id / preset_key）。
--
-- 部署：Supabase SQL editor 執行。nlc-data 不用重部署（簽名未變、已在 allowlist）。冪等。
-- ============================================================================

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
  actor_role TEXT;
  target_plan public.global_plans%ROWTYPE;
  members_json JSONB;
  reminder_key TEXT;
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
      actor_role IN ('admin', 'pastor')
      OR (actor_role = 'great_zone_leader' AND public.values_overlap(candidate.great_region, COALESCE(NULLIF(actor_profile.managed_regions, ''), actor_profile.great_region, '')))
      OR (actor_role = 'zone_leader' AND public.values_overlap(candidate.pastoral_zone, COALESCE(NULLIF(actor_profile.managed_zones, ''), actor_profile.pastoral_zone, '')))
      OR (actor_role = 'group_leader' AND public.values_overlap(candidate.small_group, COALESCE(NULLIF(actor_profile.managed_groups, ''), actor_profile.small_group, '')))
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
