import { describe, expect, it } from "vitest";
import fs from "node:fs";

const dbSource = fs.readFileSync("js/db.js", "utf8");
const authSource = fs.readFileSync("js/auth.js", "utf8");
const stateSource = fs.readFileSync("js/state.js", "utf8");
const profileSource = fs.readFileSync("js/modules/profile.js", "utf8");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`Could not find ${signature}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${signature}`);
}

function loadApplyNlcProfile(state) {
  const method = extractFunction(dbSource, "applyNlcProfile(profile, lockedFields = null) {")
    .replace("applyNlcProfile(profile, lockedFields = null)", "function applyNlcProfile(profile, lockedFields = null)");
  return new Function("state", "getDisplayName", "getRoleDefinition", `return (${method});`)(
    state,
    profile => String(profile.name || "").trim(),
    roleId => roleId ? { id: roleId, code: "member", label: "一般組員" } : null
  );
}

function loadProfileIdentityChrome({ state, memberHubManaged }) {
  const getLeadershipDisplayLabel = new Function(
    "isMemberHubManagedProfile",
    `return (${extractFunction(profileSource, "function getLeadershipDisplayLabel(user) {")});`
  )(() => memberHubManaged);
  return new Function(
    "state",
    "getLeadershipDisplayLabel",
    "renderMemberHubOrgPlacement",
    "getUserRoleCode",
    "getRoleDefinition",
    `return (${extractFunction(profileSource, "function paintProfileIdentityChrome() {")});`
  )(
    state,
    getLeadershipDisplayLabel,
    () => {},
    user => user?.role_definition?.code || "member",
    role => state.currentUser?.role_definition?.code === role ? state.currentUser.role_definition : null
  );
}

function renderRole({ user, memberHubManaged }) {
  const roleElement = {
    textContent: "",
    setAttribute() {},
    removeAttribute() {}
  };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: id => id === "profile-summary-role" ? roleElement : null };
  try {
    loadProfileIdentityChrome({ state: { currentUser: user, profileIdentityLoading: false }, memberHubManaged })();
  } finally {
    globalThis.document = previousDocument;
  }
  return roleElement.textContent;
}

describe("member context frontend sync metadata", () => {
  it("copies Member Hub sync metadata into currentUser", () => {
    for (const field of [
      "member_context_synced_at",
      "member_context_sync_attempted_at",
      "member_context_sync_status",
      "member_context_sync_error",
      "member_context_contract_version",
      "member_context_membership_lifecycle_state",
      "member_context_placement_state",
      "member_context_placement_workflow_state",
      "member_context_has_required_placement",
      "member_context_required_action",
      "member_context_required_action_url"
    ]) expect(dbSource).toContain(`state.currentUser.${field} = profile.${field} || ""`);
  });

  it("preserves the synchronized profile in the NLC cache", () => {
    expect(dbSource).toMatch(/localStorage\.setItem\("nlc_supabase_profile",\s*JSON\.stringify\(payload\.profile\)\)/);
  });

  it("forces a fresh Edge session on manual refresh without also forcing a Logto token refresh", () => {
    // `force` bypasses the local edge-session cache so a fresh member_context
    // comes back from nlc-session; it must NOT also force auth to refresh an
    // already-valid Logto token. That coupling used to mean any forced
    // resync — including now-automatic background retries, not just this
    // manual refresh — could turn a single flaky-network hiccup into a full
    // silent logout. See getValidAccessToken's own force_refresh_without_
    // refresh_token fallback for the related token-layer safety net.
    expect(dbSource).toContain("auth.getValidAccessToken(false)");
    expect(dbSource).not.toContain("auth.getValidAccessToken(force)");
    expect(profileSource).toContain("await db.syncNlcSessionWithSupabase(true)");
    expect(dbSource).toContain("if (!force && cachedExpiresAt > Date.now() + 60000)");
  });

  it("keeps a valid token when force refresh has no refresh token", () => {
    expect(authSource).toContain("force_refresh_without_refresh_token");
    expect(authSource).toMatch(/return\s+token/);
  });

  it("initializes Member Hub sync metadata for fresh state", () => {
    for (const field of [
      "member_context_synced_at",
      "member_context_sync_attempted_at",
      "member_context_sync_status",
      "member_context_sync_error"
    ]) {
      expect(stateSource).toContain(`${field}: ""`);
      expect(authSource).toContain(`${field}: ""`);
    }
  });

  it("copies role UUID and leadership identity projection into currentUser", () => {
    const state = { currentUser: {} };
    const assignments = [{ assignmentId: "assignment-1", identityKey: "church_pastor" }];
    loadApplyNlcProfile(state).call({ refreshRoleDependentUI() {} }, {
      id: "profile-1",
      role_id: "member-id",
      role_definition: { id: "member-id", code: "member", label: "一般組員" },
      member_context_leadership_display_label: "教會牧者",
      member_context_leadership_primary_assignment_id: "assignment-1",
      member_context_leadership_assignments: assignments
    });
    expect(state.currentUser.role_id).toBe("member-id");
    expect(state.currentUser.role_definition.code).toBe("member");
    expect(state.currentUser.member_context_leadership_display_label).toBe("教會牧者");
    expect(state.currentUser.member_context_leadership_assignments).toBe(assignments);
  });

  it("renders the authoritative Hub display label first", () => {
    expect(renderRole({
      user: { role_definition: { code: "group_leader", label: "小組長" }, member_context_leadership_display_label: "牧區同工" },
      memberHubManaged: true
    })).toBe("牧區同工");
  });

  it("renders 一般組員 for a Hub-managed user without a leadership label", () => {
    expect(renderRole({
      user: { role_definition: { code: "group_leader", label: "小組長" }, member_context_leadership_display_label: "" },
      memberHubManaged: true
    })).toBe("一般組員");
  });

  it("renders the linked role definition label for a non-Hub session", () => {
    expect(renderRole({
      user: { role_definition: { code: "group_leader", label: "小組長" }, member_context_leadership_display_label: "" },
      memberHubManaged: false
    })).toBe("小組長");
  });
});
