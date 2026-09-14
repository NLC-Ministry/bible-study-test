-- Migration 0172: Remove the admin name-review/approval feature
--
-- name_review_approved (migration 0069) backed an admin console workflow that
-- let an admin manually approve a member's name when it looked suspicious.
-- Company policy is that member profile data (name, org placement) is owned
-- exclusively by Member Hub and mirrored into this app read-only — an
-- app-local approval flag on the name no longer serves a purpose, since
-- Member Hub's projected name always wins on the next login sync regardless
-- of this flag. The whole review/approve UI and its backing code were
-- removed alongside this migration.

ALTER TABLE public.profiles
DROP COLUMN IF EXISTS name_review_approved;
