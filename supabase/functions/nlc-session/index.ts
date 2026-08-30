import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const PROFILE_LOOKUP_SELECT = "id, name, email, nlc_member_id, role_id, great_region_id, pastoral_zone_id, small_group_id, great_region, pastoral_zone, small_group, name_review_approved, member_context_synced_at, member_context_contract_version, member_context_membership_lifecycle_state, member_context_placement_state, member_context_placement_workflow_state, member_context_has_required_placement, member_context_required_action, member_context_required_action_url";
const PROFILE_RESPONSE_SELECT = "id, name, email, avatar_url, nlc_member_id, role_id, great_region_id, pastoral_zone_id, small_group_id, great_region, pastoral_zone, small_group, is_demo, is_active, name_review_approved, managed_regions, managed_zones, managed_groups, member_context_synced_at, member_context_sync_attempted_at, member_context_sync_status, member_context_sync_error, member_context_contract_version, member_context_membership_lifecycle_state, member_context_placement_state, member_context_placement_workflow_state, member_context_has_required_placement, member_context_required_action, member_context_required_action_url, member_context_leadership_display_label, member_context_leadership_primary_assignment_id, member_context_leadership_assignments, role_definition:role_definitions!profiles_role_definition_fkey(id, code, label, sort_order, is_assignable, can_manage_plans, can_manage_permissions, scope_type)";

function parseJwt(token: string) {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((char) => "%" + ("00" + char.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

function normalizeMemberName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > 40) return null;
  if (/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF\uFFFD]/u.test(normalized)) return null;
  // Common UTF-8 decoded-as-Latin-1 signatures. Preserve the existing name
  // rather than projecting visibly corrupted text into every app surface.
  if (/(?:\u00C3[\u0080-\u00BF]|\u00C2[\u0080-\u00BF]|\u00E2[\u0080-\u00BF]{1,2}|\u00F0\u0178|\u00EF\u00BF\u00BD)/u.test(normalized)) return null;
  return normalized;
}

const LEVEL_DEPTH = {
  great_region: 0,
  pastoral_zone: 1,
  small_group: 2
};

const LEVEL_NAME_HINTS: Record<string, string[]> = {
  great_region: ["大區"],
  pastoral_zone: ["牧區"],
  small_group: ["小組"]
};

function pickNameByDepth(segments: any[], depth: number) {
  if (!Array.isArray(segments)) return null;
  const match = segments.find((seg) => seg && seg.levelDepth === depth);
  if (match?.name) return String(match.name).trim() || null;
  const byIndex = segments[depth];
  if (byIndex?.name) return String(byIndex.name).trim() || null;
  return null;
}

function pickNameByLevelName(segments: any[], hints: string[]) {
  if (!Array.isArray(segments) || !hints.length) return null;
  const match = segments.find((seg) => {
    const label = String(seg?.levelName || "").trim();
    return hints.some((hint) => label.includes(hint));
  });
  return match?.name ? String(match.name).trim() || null : null;
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function orgFromCareChain(careChain: any[]) {
  return {
    great_region: pickNameByDepth(careChain, LEVEL_DEPTH.great_region),
    pastoral_zone: pickNameByDepth(careChain, LEVEL_DEPTH.pastoral_zone),
    small_group: pickNameByDepth(careChain, LEVEL_DEPTH.small_group)
  };
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function orgFromHomePath(path: any[]) {
  if (!Array.isArray(path)) {
    return { great_region: null, pastoral_zone: null, small_group: null };
  }
  return {
    great_region: pickNameByLevelName(path, LEVEL_NAME_HINTS.great_region) || pickNameByDepth(path, 0),
    pastoral_zone: pickNameByLevelName(path, LEVEL_NAME_HINTS.pastoral_zone) || pickNameByDepth(path, 1),
    small_group: pickNameByLevelName(path, LEVEL_NAME_HINTS.small_group) || pickNameByDepth(path, 2)
  };
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function orgFromMemberContext(organization: any) {
  const org = organization || {};
  const nodeName = org.placementNodeName ? String(org.placementNodeName).trim() : "";
  const levelName = org.placementLevelName ? String(org.placementLevelName).trim() : "";
  const result: Record<"great_region" | "pastoral_zone" | "small_group", string | null> = {
    great_region: null,
    pastoral_zone: null,
    small_group: null
  };
  if (!nodeName || !levelName) return result;

  for (const [field, hints] of Object.entries(LEVEL_NAME_HINTS)) {
    if (hints.some((hint) => levelName.includes(hint))) {
      result[field as "great_region" | "pastoral_zone" | "small_group"] = nodeName;
      break;
    }
  }
  return result;
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
const HUB_OWNED_PROFILE_FIELDS = ["name", "great_region", "pastoral_zone", "small_group"];

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function buildLockedFields(sourceValues: Record<string, string | null>, options: { hubLinked?: boolean } = {}) {
  const locked = Object.entries(sourceValues)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(([field]) => field);

  if (options.hubLinked) {
    for (const field of HUB_OWNED_PROFILE_FIELDS) {
      if (!locked.includes(field)) locked.push(field);
    }
  }

  return locked;
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function projectOrgFieldsFromHub(
  mergedOrg: { great_region?: string | null; pastoral_zone?: string | null; small_group?: string | null },
  existingProfile: { great_region?: string | null; pastoral_zone?: string | null; small_group?: string | null } | null,
  hubLinked: boolean
) {
  const hubOrg = {
    great_region: mergedOrg?.great_region ? String(mergedOrg.great_region).trim() : "",
    pastoral_zone: mergedOrg?.pastoral_zone ? String(mergedOrg.pastoral_zone).trim() : "",
    small_group: mergedOrg?.small_group ? String(mergedOrg.small_group).trim() : ""
  };

  if (hubLinked) return hubOrg;

  const firstValue = (...values: any[]) => {
    for (const value of values) {
      if (value !== null && value !== undefined && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };

  return {
    great_region: firstValue(hubOrg.great_region, existingProfile?.great_region),
    pastoral_zone: firstValue(hubOrg.pastoral_zone, existingProfile?.pastoral_zone),
    small_group: firstValue(hubOrg.small_group, existingProfile?.small_group)
  };
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function copyOrgFields(org: any) {
  return {
    great_region: org?.great_region || null,
    pastoral_zone: org?.pastoral_zone || null,
    small_group: org?.small_group || null
  };
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function buildOrgProjectionAudit({
  memberContext,
  organization,
  platformOrgFields,
  placementOrgFields,
  contextOrgFields,
  mergedOrg,
  projectedOrg,
  existingProfile,
  orgResolutionSource,
  memberContextError
}: {
  memberContext: any;
  organization: any;
  platformOrgFields: any;
  placementOrgFields: any;
  contextOrgFields: any;
  mergedOrg: any;
  projectedOrg: any;
  existingProfile: any;
  orgResolutionSource: string;
  memberContextError: string | null;
}) {
  const canonicalPlacement = {
    placementNodeId: organization?.placementNodeId || null,
    placementNodeName: organization?.placementNodeName || null,
    placementLevelName: organization?.placementLevelName || null,
    hasRequiredPlacement: memberContext?.hasRequiredPlacement ?? null
  };

  return {
    source: orgResolutionSource || "none",
    status: projectedOrg?.great_region || projectedOrg?.pastoral_zone || projectedOrg?.small_group ? "projected" : "empty",
    member_context_available: Boolean(memberContext),
    member_context_error: memberContextError || null,
    canonical_placement: canonicalPlacement,
    inputs: {
      platform: copyOrgFields(platformOrgFields),
      placement: copyOrgFields(placementOrgFields),
      context: copyOrgFields(contextOrgFields),
      merged: copyOrgFields(mergedOrg)
    },
    existing_profile: copyOrgFields(existingProfile),
    projected_profile: copyOrgFields(projectedOrg)
  };
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
const INVENTED_PROFILE_NAMES = new Set(["教會肢體", "NLC User", "新使用者", "尚未取得姓名", "未命名使用者"]);

function resolveProjectedProfileName({ hubName, existingName }: { hubName: unknown; existingName: unknown }) {
  const hub = String(hubName || "").trim();
  if (hub && !INVENTED_PROFILE_NAMES.has(hub)) return hub;
  const existing = String(existingName || "").trim();
  if (existing && !INVENTED_PROFILE_NAMES.has(existing)) return existing;
  return "";
}

/** Keep in sync with scripts/lib/nlc-profile-sync.mjs */
function mergeOrgSources(platformOrg: any, placementOrg: any, contextOrganization: any) {
  const contextOrg = orgFromMemberContext(contextOrganization);

  const pick = (field: "great_region" | "pastoral_zone" | "small_group") => {
    if (placementOrg?.[field]) return placementOrg[field];
    if (contextOrg[field]) return contextOrg[field];
    if (platformOrg?.[field]) return platformOrg[field];
    return null;
  };

  return {
    great_region: pick("great_region"),
    pastoral_zone: pick("pastoral_zone"),
    small_group: pick("small_group")
  };
}

function sanitizeLeadershipIdentity(memberContext: any) {
  const leadership = memberContext?.leadershipIdentity;
  const assignments = Array.isArray(leadership?.assignments)
    ? leadership.assignments
      .filter((assignment: any) => assignment && typeof assignment === "object")
      .map((assignment: any) => ({
        assignmentId: assignment.assignmentId ? String(assignment.assignmentId) : null,
        identityKey: String(assignment.identityKey || ""),
        displayName: String(assignment.displayName || ""),
        displayRank: Number.isFinite(Number(assignment.displayRank)) ? Number(assignment.displayRank) : 0,
        nodeId: String(assignment.nodeId || ""),
        nodeName: String(assignment.nodeName || ""),
        levelName: assignment.levelName ? String(assignment.levelName) : null,
        levelDepth: assignment.levelDepth === null || assignment.levelDepth === undefined
          ? null
          : Number.isFinite(Number(assignment.levelDepth)) ? Number(assignment.levelDepth) : null,
        isPrimary: Boolean(assignment.isPrimary),
      }))
      .filter((assignment: any) => assignment.identityKey)
    : [];

  return {
    displayLabel: leadership?.displayLabel ? String(leadership.displayLabel) : null,
    primaryAssignmentId: leadership?.primaryAssignmentId ? String(leadership.primaryAssignmentId) : null,
    assignments,
  };
}

function projectCanonicalMemberJourney(memberContext: any) {
  const rawVersion = Number(memberContext?.contextContractVersion);
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 120) : null;
  const rawUrl = typeof memberContext?.requiredActionUrl === "string"
    ? memberContext.requiredActionUrl.slice(0, 2048)
    : null;
  return {
    contractVersion: Number.isInteger(rawVersion) && rawVersion > 0 ? rawVersion : null,
    membershipLifecycleState: text(memberContext?.membershipLifecycleState),
    placementState: text(memberContext?.placementState),
    placementWorkflowState: text(memberContext?.placementWorkflowState),
    hasRequiredPlacement: typeof memberContext?.hasRequiredPlacement === "boolean"
      ? memberContext.hasRequiredPlacement
      : null,
    requiredAction: text(memberContext?.requiredAction),
    requiredActionUrl: rawUrl,
  };
}

const MEMBER_ROLE_ID = "10000000-0000-4000-8000-000000000001";

function normalizePermissionSignal(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase();
}

function collectHubPermissionSignals(memberContext: any) {
  const leadership = memberContext?.leadershipIdentity || {};
  const assignments = Array.isArray(leadership.assignments) ? leadership.assignments : [];
  const roles = Array.isArray(memberContext?.roles) ? memberContext.roles : [];
  const membershipApproved = memberContext?.membershipState === "approved";
  const normalizedRoles = roles.map(normalizePermissionSignal).filter(Boolean);
  const satelliteAdminVerified = membershipApproved
    && normalizedRoles.includes("satellite_admin");
  const regularKeys = [
    ...roles,
    memberContext?.primaryRole,
    ...assignments.map((assignment: any) => assignment?.identityKey)
  ].map(normalizePermissionSignal).filter(Boolean)
    .filter(value => value !== "satellite_admin");
  const keys = satelliteAdminVerified ? [...regularKeys, "satellite_admin"] : regularKeys;
  const labels = [
    memberContext?.primaryRole,
    leadership.displayLabel,
    ...assignments.map((assignment: any) => assignment?.displayName)
  ].map(normalizePermissionSignal).filter(Boolean)
    .filter(value => value !== "satellite_admin");
  return {
    keys: [...new Set(keys)],
    labels: [...new Set(labels)],
    primaryRole: normalizePermissionSignal(memberContext?.primaryRole) === "satellite_admin"
      ? ""
      : normalizePermissionSignal(memberContext?.primaryRole),
    satelliteAdminVerified
  };
}

async function resolveSyncedRoleId(
  supabaseAdmin: any,
  memberContext: any,
  existingRoleId: string | null | undefined,
  linkedBy: "identity" | "member_id" | "email" | "none"
) {
  const strong = linkedBy === "identity" || linkedBy === "member_id" || linkedBy === "none";
  if (!strong) return MEMBER_ROLE_ID;
  if (!memberContext) return existingRoleId || MEMBER_ROLE_ID;

  const { data: definitions, error } = await supabaseAdmin
    .from("role_definitions")
    .select("id, code, label, sort_order, hub_permission_keys, hub_permission_labels")
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const signals = collectHubPermissionSignals(memberContext);
  const matched = (definitions || [])
    .filter((definition: any) => {
      const keys = (definition.hub_permission_keys || []).map(normalizePermissionSignal);
      const labels = [
        definition.code,
        definition.label,
        ...(definition.hub_permission_labels || [])
      ].map(normalizePermissionSignal);
      const keyMatched = signals.keys.some((value: string) => keys.includes(value));
      const labelMatched = signals.labels.some((value: string) => labels.includes(value));
      const adminLabelMatched = definition.code === "admin"
        && signals.labels.some((l: string) => ["組織架構管理員", "系統管理員", "平台管理員", "admin"].includes(l));
      return keyMatched || adminLabelMatched || labelMatched;
    })
    .sort((left: any, right: any) =>
      Number(left.sort_order ?? 100) - Number(right.sort_order ?? 100)
    )[0];
  return matched?.id || MEMBER_ROLE_ID;
}
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function hasAnyOrgField(org: { great_region?: string | null; pastoral_zone?: string | null; small_group?: string | null }) {
  return Boolean(org.great_region || org.pastoral_zone || org.small_group);
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }

  return body;
}

async function fetchJsonOptional(url: string, init?: RequestInit) {
  try {
    return await fetchJson(url, init);
  } catch (err) {
    console.warn("Optional fetch failed:", url, err);
    return null;
  }
}

async function resolveLocalOrgLinks(
  supabaseAdmin: any,
  profilePayload: { great_region?: string | null; pastoral_zone?: string | null; small_group?: string | null },
  memberContext: any
) {
  let great_region_id: string | null = null;
  let pastoral_zone_id: string | null = null;
  let small_group_id: string | null = null;
  let orgLinkStatus = memberContext ? "not_linked" : "skipped";
  let orgLinkError: string | null = null;

  const failed = (err: unknown) => {
    orgLinkStatus = "failed";
    orgLinkError = err instanceof Error ? err.message : String(err);
    console.warn("Member Hub org-tree link failed; continuing session sync with text org fields.", err);
    return {
      great_region_id: null,
      pastoral_zone_id: null,
      small_group_id: null,
      orgLinkStatus,
      orgLinkError
    };
  };

  try {
    // Rebuild the organization tree from authoritative Member Hub data as
    // members sign in. A degraded sync must never recreate stale local data.
    if (memberContext && profilePayload.great_region) {
      const { data: regionData, error: regionError } = await supabaseAdmin
        .from("great_regions")
        .upsert(
          { name: profilePayload.great_region },
          { onConflict: "name" }
        )
        .select("id")
        .single();
      if (regionError) return failed(regionError);
      great_region_id = regionData.id;
    }
    if (memberContext && profilePayload.pastoral_zone && great_region_id) {
      const { data: zoneData, error: zoneError } = await supabaseAdmin
        .from("pastoral_zones")
        .upsert(
          {
            name: profilePayload.pastoral_zone,
            great_region_id
          },
          { onConflict: "name,great_region_id" }
        )
        .select("id")
        .single();
      if (zoneError) return failed(zoneError);
      pastoral_zone_id = zoneData.id;
    }
    if (memberContext && profilePayload.small_group && pastoral_zone_id) {
      const { data: groupData, error: groupError } = await supabaseAdmin
        .from("small_groups")
        .upsert(
          {
            name: profilePayload.small_group,
            pastoral_zone_id
          },
          { onConflict: "name,pastoral_zone_id" }
        )
        .select("id")
        .single();
      if (groupError) return failed(groupError);
      small_group_id = groupData.id;
    }

    orgLinkStatus = memberContext && hasAnyOrgField(profilePayload) ? "linked" : orgLinkStatus;
  } catch (err) {
    return failed(err);
  }

  return {
    great_region_id,
    pastoral_zone_id,
    small_group_id,
    orgLinkStatus,
    orgLinkError
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "*";
  const localCorsHeaders = {
    ...corsHeaders,
    "Access-Control-Allow-Origin": origin
  };

  const jsonResponse = (body: unknown, status = 200) => {
    return new Response(JSON.stringify(body), { status, headers: localCorsHeaders });
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: localCorsHeaders });
  }
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const issuer = trimSlash(Deno.env.get("NLC_LOGTO_ISSUER") || "https://sso.newlife.org.tw/oidc");
    const memberHubUrl = trimSlash(Deno.env.get("NLC_MEMBER_HUB_URL") || "https://member.newlife.org.tw");
    const platformApiUrl = trimSlash(
      Deno.env.get("NLC_PLATFORM_API_URL") || "https://platform.newlife.org.tw/platform/v1"
    );

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "server_not_configured" }, 500);
    }

    const { access_token: accessToken, id_token: idToken } = await req.json().catch(() => ({}));
    if (!accessToken || typeof accessToken !== "string") {
      return jsonResponse({ error: "missing_access_token" }, 400);
    }

    const bearerHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    };

    let userinfo: any = null;
    let freshUserinfo: any = null;
    if (idToken && typeof idToken === "string") {
      userinfo = parseJwt(idToken);
    }

    // ID-token claims may remain stale after a profile edit. Always retrieve
    // current UserInfo during a real Edge session sync; the browser caches the
    // resulting projection, so this does not run on every page navigation.
    try {
      const discovery = await fetchJson(`${issuer}/.well-known/openid-configuration`);
      const userinfoEndpoint = discovery.userinfo_endpoint;
      if (userinfoEndpoint) {
        const fullUserinfo = await fetchJson(userinfoEndpoint, { headers: bearerHeaders });
        if (fullUserinfo && fullUserinfo.sub) {
          freshUserinfo = fullUserinfo;
          userinfo = { ...userinfo, ...fullUserinfo };
        }
      }
    } catch (err) {
      console.warn("Failed to fetch fresh userinfo from OIDC endpoint:", err);
    }

    if (!userinfo || !userinfo.sub) {
      return jsonResponse({ error: "invalid_userinfo" }, 401);
    }

    let memberContext: any = null;
    let memberContextError: string | null = null;
    try {
      const memberResponse = await fetchJson(`${memberHubUrl}/api/me/context`, {
        headers: bearerHeaders
      });
      const validEnvelope = memberResponse?.ok === true
        && memberResponse.context
        && typeof memberResponse.context === "object"
        && !Array.isArray(memberResponse.context);
      memberContext = validEnvelope ? memberResponse.context : null;
      if (!validEnvelope) {
        memberContextError = "member_hub_context_invalid_envelope";
      }
    } catch (err) {
      console.error("Member Hub context fetch failed:", err);
      memberContextError = `member_hub_context_failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!memberContext) {
      memberContextError = memberContextError || "member_hub_context_missing";
    }

    const memberProfile = memberContext?.profile || {};
    const memberIdentity = memberContext?.identity || {};
    const organization = memberContext?.organization || {};
    const leadershipIdentity = sanitizeLeadershipIdentity(memberContext);
    const canonicalJourney = projectCanonicalMemberJourney(memberContext);
    const memberId = memberIdentity.memberId || null;
    const membershipStatus = memberProfile.membershipStatus || null;

    let platformOrganization: any = null;
    let platformOrgFields = { great_region: null as string | null, pastoral_zone: null as string | null, small_group: null as string | null };

    if (memberId) {
      const platformResponse = await fetchJsonOptional(
        `${platformApiUrl}/members/${encodeURIComponent(memberId)}/organization`,
        { headers: bearerHeaders }
      );
      platformOrganization = platformResponse?.organization || null;
      if (platformOrganization?.careChain) {
        platformOrgFields = orgFromCareChain(platformOrganization.careChain);
      }
    }

    let placementOrgFields = { great_region: null as string | null, pastoral_zone: null as string | null, small_group: null as string | null };

    const contextOrgFields = orgFromMemberContext(organization);
    const mergedOrg = mergeOrgSources(platformOrgFields, placementOrgFields, organization);
    const orgResolutionSource = hasAnyOrgField(placementOrgFields)
      ? "member_hub_org_placement"
      : (hasAnyOrgField(contextOrgFields) ? "member_hub_context" : (hasAnyOrgField(platformOrgFields) ? "platform_organization" : "none"));

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: existingIdentity, error: identityError } = await supabaseAdmin
      .from("user_identities")
      .select("profile_id")
      .eq("provider", "logto")
      .eq("provider_user_id", userinfo.sub)
      .maybeSingle();

    if (identityError) throw identityError;

    let profileId = existingIdentity?.profile_id || null;
    let existingProfile: any = null;
    // How the existing profile was matched — governs whether Hub permission labels may be trusted.
    let linkSource: "identity" | "member_id" | "email" | "none" = profileId ? "identity" : "none";

    const lookupEmail = userinfo.email || memberIdentity.email || null;

    // Strong link: match an existing profile by the authenticated NLC member id.
    if (!profileId && memberId) {
      const { data: profileByMember, error: memberLookupError } = await supabaseAdmin
        .from("profiles")
        .select(PROFILE_LOOKUP_SELECT)
        .eq("nlc_member_id", memberId)
        .maybeSingle();
      if (memberLookupError) throw memberLookupError;
      if (profileByMember) {
        existingProfile = profileByMember;
        profileId = profileByMember.id;
        linkSource = "member_id";
      }
    }

    // Weak link: match by email only. NLC identity can be phone-primary, so the token
    // email may not be caller-owned; role UUID synchronization refuses to escalate privilege here.
    if (!profileId && lookupEmail) {
      const { data: profileByEmail, error: profileLookupError } = await supabaseAdmin
        .from("profiles")
        .select(PROFILE_LOOKUP_SELECT)
        .ilike("email", lookupEmail)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (profileLookupError) throw profileLookupError;
      if (profileByEmail) {
        existingProfile = profileByEmail;
        profileId = profileByEmail.id;
        linkSource = "email";
      }
    }

    if (profileId && !existingProfile) {
      const { data: profileById, error: profileByIdError } = await supabaseAdmin
        .from("profiles")
        .select(PROFILE_LOOKUP_SELECT)
        .eq("id", profileId)
        .maybeSingle();
      if (profileByIdError) throw profileByIdError;
      existingProfile = profileById || null;
    }


    if (!profileId) {
      // Guard against silently orphaning existing user data.
      // If userinfo.sub is known (non-empty), double-check whether this sub has ANY
      // historical identity record (including soft-deleted / mislinked ones).
      // If a record exists but profile lookup failed above, something is wrong —
      // return an error so the user can re-authenticate rather than silently creating
      // a new empty profile that loses all reading logs and team records.
      if (userinfo?.sub) {
        const { data: anyIdentity } = await supabaseAdmin
          .from("user_identities")
          .select("profile_id, provider_user_id")
          .eq("provider_user_id", userinfo.sub)
          .limit(1)
          .maybeSingle();

        if (anyIdentity) {
          // The sub is known but we couldn't load the linked profile — refuse to create
          // a new UUID to avoid data loss. Return a recoverable error.
          console.error("nlc-session: sub exists in user_identities but profile lookup failed", {
            sub: userinfo.sub,
            linked_profile_id: anyIdentity.profile_id
          });
          return jsonResponse({
            error: "profile_resolution_failed",
            message: "帳號資料暫時無法讀取，請重新登入。如問題持續，請聯絡教會支援。",
            sub_known: true
          }, 409);
        }
      }
      // Confirmed new user (sub never seen before) — safe to create a fresh profile.
      profileId = crypto.randomUUID();
    }


    const syncedRoleId = await resolveSyncedRoleId(supabaseAdmin, memberContext, existingProfile?.role_id, linkSource);

    // Member Hub is canonical only when the context endpoint was reachable for this session.
    const hubLinked = !!memberContext;
    const projectedOrg = projectOrgFieldsFromHub(mergedOrg, existingProfile, hubLinked);
    const orgProjectionAudit = buildOrgProjectionAudit({
      memberContext,
      organization,
      platformOrgFields,
      placementOrgFields,
      contextOrgFields,
      mergedOrg,
      projectedOrg,
      existingProfile,
      orgResolutionSource,
      memberContextError
    });
    console.info("nlc-session org projection", JSON.stringify(orgProjectionAudit));

    const canonicalName = [
      memberProfile.displayName,
      freshUserinfo?.name,
      freshUserinfo?.preferred_username,
      memberIdentity.username,
      ...(!existingProfile ? [userinfo.name, userinfo.preferred_username] : [])
    ].map(normalizeMemberName).find(Boolean) || null;

    const sourceValues: Record<string, string | null> = {
      email: lookupEmail,
      name: canonicalName,
      great_region: projectedOrg.great_region || null,
      pastoral_zone: projectedOrg.pastoral_zone || null,
      small_group: projectedOrg.small_group || null,
    };

    const lockedFields = buildLockedFields(sourceValues, { hubLinked });
    if (!lockedFields.includes("role_id")) lockedFields.push("role_id");

    const firstValue = (...values: any[]) => {
      for (const value of values) {
        if (value !== null && value !== undefined && String(value).trim() !== "") return value;
      }
      return "";
    };

    const nowIso = new Date().toISOString();
    const memberContextSyncStatus = memberContext ? "success" : "degraded";
    const nextProfileName = resolveProjectedProfileName({
      hubName: sourceValues.name,
      existingName: existingProfile?.name,
    });
    const canonicalNameChanged = Boolean(
      existingProfile
      && sourceValues.name
      && String(nextProfileName).trim() !== String(existingProfile.name || "").trim()
    );
    const profilePayload: Record<string, any> = {
      id: profileId,
      name: nextProfileName,
      email: firstValue(sourceValues.email, existingProfile?.email, null) || null,
      great_region: projectedOrg.great_region,
      pastoral_zone: projectedOrg.pastoral_zone,
      small_group: projectedOrg.small_group,
      role_id: syncedRoleId,
      is_demo: false,
      is_active: true,
      last_seen_at: nowIso,
      member_context_synced_at: memberContext ? nowIso : (existingProfile?.member_context_synced_at || null),
      member_context_sync_attempted_at: nowIso,
      member_context_sync_status: memberContextSyncStatus,
      member_context_sync_error: memberContextError,
      ...(memberContext ? {
        member_context_contract_version: canonicalJourney.contractVersion,
        member_context_membership_lifecycle_state: canonicalJourney.membershipLifecycleState,
        member_context_placement_state: canonicalJourney.placementState,
        member_context_placement_workflow_state: canonicalJourney.placementWorkflowState,
        member_context_has_required_placement: canonicalJourney.hasRequiredPlacement,
        member_context_required_action: canonicalJourney.requiredAction,
        member_context_required_action_url: canonicalJourney.requiredActionUrl,
        member_context_leadership_display_label: leadershipIdentity.displayLabel,
        member_context_leadership_primary_assignment_id: leadershipIdentity.primaryAssignmentId,
        member_context_leadership_assignments: leadershipIdentity.assignments,
      } : {}),
      updated_at: nowIso
    };

    if (canonicalNameChanged) {
      profilePayload.name_review_approved = false;
    }

    if (memberId) {
      profilePayload.nlc_member_id = memberId;
    } else if (existingProfile?.nlc_member_id) {
      profilePayload.nlc_member_id = existingProfile.nlc_member_id;
    }

    const {
      great_region_id,
      pastoral_zone_id,
      small_group_id,
      orgLinkStatus,
      orgLinkError
    } = await resolveLocalOrgLinks(supabaseAdmin, profilePayload, memberContext);

    profilePayload.great_region_id = (great_region_id || (profilePayload.great_region === existingProfile?.great_region ? existingProfile?.great_region_id : null)) || null;
    profilePayload.pastoral_zone_id = (pastoral_zone_id || (profilePayload.pastoral_zone === existingProfile?.pastoral_zone ? existingProfile?.pastoral_zone_id : null)) || null;
    profilePayload.small_group_id = (small_group_id || (profilePayload.small_group === existingProfile?.small_group ? existingProfile?.small_group_id : null)) || null;

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .upsert(profilePayload, { onConflict: "id" })
      .select(PROFILE_RESPONSE_SELECT)
      .single();

    if (profileError) throw profileError;

    // Prune only after an authoritative Hub projection has been committed.
    // The database function applies a grace period so concurrent sessions can
    // finish linking nodes they have just upserted.
    let orgCleanupStatus = memberContext ? "pending" : "skipped";
    let orgCleanupResult: any = null;
    let orgCleanupError: string | null = null;
    if (memberContext) {
      const { data: cleanupData, error: cleanupError } = await supabaseAdmin
        .rpc("prune_orphaned_church_org_nodes", {});
      if (cleanupError) {
        orgCleanupStatus = "failed";
        orgCleanupError = cleanupError.message || String(cleanupError);
        console.warn("Orphaned organization cleanup failed; continuing session sync.", cleanupError);
      } else {
        orgCleanupStatus = "success";
        orgCleanupResult = cleanupData;
      }
    }

    const { error: clearPrimaryError } = await supabaseAdmin
      .from("user_identities")
      .update({ is_primary: false, updated_at: nowIso })
      .eq("profile_id", profileId);

    if (clearPrimaryError) throw clearPrimaryError;

    const identityMetadata: Record<string, unknown> = {
      issuer,
      userinfo,
      member_context: memberContext
    };
    identityMetadata.org_resolution_source = orgResolutionSource;
    identityMetadata.org_resolution = {
      source: orgResolutionSource,
      placement_available: hasAnyOrgField(placementOrgFields),
      platform_available: hasAnyOrgField(platformOrgFields),
      context_available: hasAnyOrgField(contextOrgFields),
      org_link_status: orgLinkStatus,
      org_link_error: orgLinkError,
      org_cleanup_status: orgCleanupStatus,
      org_cleanup_result: orgCleanupResult,
      org_cleanup_error: orgCleanupError
    };
    identityMetadata.org_projection_audit = orgProjectionAudit;
    const rolePermissionSignals = collectHubPermissionSignals(memberContext);
    const roleResolutionAudit = {
      status: linkSource === "email"
        ? "weak_link_member"
        : (memberContext ? "member_hub_resolved" : "degraded_preserved"),
      link_source: linkSource,
      role_id: profile.role_id,
      role_code: profile.role_definition?.code || null,
      permission_keys: rolePermissionSignals.keys,
      permission_labels: rolePermissionSignals.labels,
      satellite_admin_verified: rolePermissionSignals.satelliteAdminVerified,
      member_context_envelope_valid: Boolean(memberContext)
    };
    identityMetadata.role_resolution = roleResolutionAudit;
    console.info("nlc-session role projection", JSON.stringify(roleResolutionAudit));
    if (memberContextError) {
      identityMetadata.member_context_error = memberContextError;
    }
    if (platformOrganization) {
      identityMetadata.platform_organization = platformOrganization;
    }
    if (membershipStatus) {
      identityMetadata.membership_status = membershipStatus;
    }

    const { error: upsertIdentityError } = await supabaseAdmin
      .from("user_identities")
      .upsert({
        profile_id: profileId,
        provider: "logto",
        provider_user_id: userinfo.sub,
        email: profilePayload.email,
        display_name: profilePayload.name,
        is_primary: true,
        metadata: identityMetadata,
        last_seen_at: nowIso,
        updated_at: nowIso
      }, { onConflict: "provider,provider_user_id" });

    if (upsertIdentityError) throw upsertIdentityError;

    return jsonResponse({
      edge_session: true,
      profile,
      locked_fields: lockedFields,
      membership_status: membershipStatus,
      member_context_error: memberContextError,
      org_projection_debug: orgProjectionAudit,
      role_resolution_debug: roleResolutionAudit
    });
  } catch (err) {
    // Log full detail server-side only — never return a stack trace to the
    // client. A stack trace can reveal internal file paths, function names,
    // and dependency versions to anyone who can trigger this failure path.
    console.error("nlc-session failed:", err);
    return jsonResponse({
      error: "nlc_session_failed",
      message: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
