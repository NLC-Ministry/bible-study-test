import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  getCanonicalMemberPrerequisiteBlock,
  getUserOnboardingBlock,
  isCanonicalMemberJourneyProjection,
} from '../js/member-journey.mjs';

const migrationPath = 'supabase/migrations/0093_canonical_member_journey_projection.sql';
const projectionFields = [
  'member_context_contract_version',
  'member_context_membership_lifecycle_state',
  'member_context_placement_state',
  'member_context_placement_workflow_state',
  'member_context_has_required_placement',
  'member_context_required_action',
  'member_context_required_action_url',
];

describe('canonical Member Hub journey projection', () => {
  it('stores externally versioned enum-like values as tolerant text', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    for (const field of projectionFields) expect(sql).toContain(field);
    expect(sql).toMatch(/member_context_required_action\s+text/i);
    expect(sql).toMatch(/member_context_membership_lifecycle_state\s+text/i);
    expect(sql).not.toMatch(/CHECK\s*\([^)]*member_context_required_action/i);
    expect(sql).not.toMatch(/CHECK\s*\([^)]*member_context_membership_lifecycle_state/i);
    expect(sql).toContain('unknown upstream values are preserved');
  });

  it('projects all v2 decision fields only after a successful Hub context fetch', () => {
    const source = fs.readFileSync('supabase/functions/nlc-session/index.ts', 'utf8');

    expect(source).toContain('projectCanonicalMemberJourney(memberContext)');
    expect(source).toContain('member_context_contract_version: canonicalJourney.contractVersion');
    expect(source).toContain('member_context_required_action: canonicalJourney.requiredAction');
    expect(source).toContain('member_context_required_action_url: canonicalJourney.requiredActionUrl');
    expect(source).toMatch(/\.\.\.\(memberContext \? \{[\s\S]*member_context_contract_version/);
  });
});

describe('canonical Bible user-onboarding door', () => {
  const now = Date.parse('2026-08-14T12:00:00.000Z');
  const base = {
    member_context_contract_version: 2,
    member_context_membership_lifecycle_state: 'none',
    member_context_placement_state: 'missing',
    member_context_placement_workflow_state: 'none',
    member_context_has_required_placement: false,
    member_context_required_action: 'submit_membership',
    member_context_required_action_url: 'https://member.newlife.org.tw/member/continue',
    member_context_synced_at: '2026-08-14T11:59:00.000Z',
    member_context_sync_status: 'success',
  };

  it('aliases the old prerequisite helper to the user-completion door', () => {
    expect(getCanonicalMemberPrerequisiteBlock).toBe(getUserOnboardingBlock);
  });

  it('fails closed when v2 projection is missing', () => {
    expect(getUserOnboardingBlock({ name: '王大明' }, { now })).toMatchObject({
      reason: 'member_context_unavailable',
    });
  });

  it('blocks a visitor who still owes the official form', () => {
    expect(getUserOnboardingBlock(base, { now })).toMatchObject({
      reason: 'membership_application_required',
      requiredAction: 'submit_membership',
    });
  });

  it('lets pending or approved members in even if Hub still reports complete_profile', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'pending',
      member_context_required_action: 'complete_profile',
    }, { now })).toBeNull();
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'approved',
      member_context_required_action: 'complete_profile',
    }, { now })).toBeNull();
  });

  it('still blocks complete_profile for a visitor with no membership', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'none',
      member_context_required_action: 'complete_profile',
    }, { now })).toMatchObject({ reason: 'member_profile_required' });
  });

  it('lets a pending official application in without placement', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'pending',
      member_context_required_action: 'await_membership_review',
    }, { now })).toBeNull();
  });

  it('lets a pastor-created seeker in without an official form', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'pending',
      member_context_required_action: 'submit_membership',
    }, { now })).toBeNull();
  });

  it('lets an official member in without confirmed placement', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'approved',
      member_context_required_action: 'request_placement',
    }, { now })).toBeNull();
  });

  it('lets approved + placed members in', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'approved',
      member_context_placement_state: 'active',
      member_context_has_required_placement: true,
      member_context_required_action: 'none',
    }, { now })).toBeNull();
    expect(isCanonicalMemberJourneyProjection({
      member_context_contract_version: 2,
    })).toBe(true);
  });

  it('blocks inactive and unknown actions', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'inactive',
      member_context_required_action: 'none',
    }, { now })).toMatchObject({ reason: 'inactive_membership' });
    expect(getUserOnboardingBlock({
      ...base,
      member_context_required_action: 'verify_phone',
    }, { now })).toMatchObject({ reason: 'unknown_member_hub_action' });
    expect(getUserOnboardingBlock({
      ...base,
      member_context_required_action: 'resolve_membership_record',
    }, { now })).toMatchObject({ reason: 'membership_record_inconsistent' });
  });

  it('tolerates a projection up to 60 minutes old', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'approved',
      member_context_required_action: 'none',
      member_context_synced_at: '2026-08-14T11:40:00.000Z',
    }, { now })).toBeNull();
  });

  it('fails closed after the projection is older than 60 minutes', () => {
    expect(getUserOnboardingBlock({
      ...base,
      member_context_membership_lifecycle_state: 'approved',
      member_context_required_action: 'none',
      member_context_synced_at: '2026-08-14T10:40:00.000Z',
    }, { now })).toMatchObject({ reason: 'member_context_unavailable' });
  });
});
