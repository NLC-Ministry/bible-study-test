const KNOWN_REQUIRED_ACTIONS = new Set([
  'complete_profile',
  'submit_membership',
  'await_membership_review',
  'resolve_membership_record',
  'request_placement',
  'await_placement_review',
  'none',
]);

const KNOWN_MEMBERSHIP_STATES = new Set(['none', 'pending', 'approved', 'inactive']);
const KNOWN_PLACEMENT_STATES = new Set(['missing', 'active', 'invalid']);
const DEFAULT_MAX_PROJECTION_AGE_MS = 60 * 60 * 1000;

const USER_COMPLETE_ACTIONS = new Set([
  'await_membership_review',
  'request_placement',
  'await_placement_review',
  'none',
]);

export function isCanonicalMemberJourneyProjection(user) {
  return Number(user?.member_context_contract_version) >= 2;
}

function recoveryFields(user) {
  return {
    requiredAction: String(user?.member_context_required_action || ''),
    requiredActionUrl: String(user?.member_context_required_action_url || '') || null,
  };
}

export function getUserOnboardingBlock(user, options = {}) {
  if (!user || user.is_demo) return null;
  if (!isCanonicalMemberJourneyProjection(user)) {
    return { reason: 'member_context_unavailable', requiredAction: '', requiredActionUrl: null };
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Number(options.maxAgeMs)
    : DEFAULT_MAX_PROJECTION_AGE_MS;
  const syncedAt = Date.parse(String(user?.member_context_synced_at || ''));
  const projectionAge = Number.isFinite(syncedAt) ? Math.max(0, now - syncedAt) : Infinity;
  const recovery = recoveryFields(user);

  if (projectionAge > maxAgeMs) {
    return { reason: 'member_context_unavailable', ...recovery };
  }

  const action = recovery.requiredAction;
  if (!KNOWN_REQUIRED_ACTIONS.has(action)) {
    return { reason: 'unknown_member_hub_action', ...recovery };
  }

  const membershipState = String(user?.member_context_membership_lifecycle_state || '');
  if (!KNOWN_MEMBERSHIP_STATES.has(membershipState)) {
    return { reason: 'unknown_member_hub_state', ...recovery };
  }
  if (membershipState === 'inactive') {
    return { reason: 'inactive_membership', ...recovery };
  }
  if (action === 'resolve_membership_record') {
    return { reason: 'membership_record_inconsistent', ...recovery };
  }
  if (action === 'complete_profile' && membershipState !== 'pending' && membershipState !== 'approved') {
    return { reason: 'member_profile_required', ...recovery };
  }
  if (action === 'submit_membership' && membershipState !== 'pending' && membershipState !== 'approved') {
    return { reason: 'membership_application_required', ...recovery };
  }
  if (membershipState === 'pending' || membershipState === 'approved' || USER_COMPLETE_ACTIONS.has(action)) {
    return null;
  }
  return { reason: 'unknown_member_hub_action', ...recovery };
}

export const getCanonicalMemberPrerequisiteBlock = getUserOnboardingBlock;

export { DEFAULT_MAX_PROJECTION_AGE_MS, KNOWN_REQUIRED_ACTIONS };
