-- Deletes duplicate profiles you've identified from
-- scratch/find_duplicate_accounts.sql. DESTRUCTIVE and IRREVERSIBLE.
--
-- Deleting a profiles row cascades (ON DELETE CASCADE) and also removes:
--   user_identities, reading_plans, reading_logs, devotional_notes,
--   devotional_likes, devotional_comments, care_reminders (as sender or
--   recipient), reading_team_members, verse_notes, quiz recipients/answers,
--   and anything else with a profile FK.
-- Two exceptions:
--   - issue_reports.user_id is set to NULL instead of deleted (report stays,
--     just loses the "who reported this" link).
--   - daily_church_quizzes.published_by is ON DELETE RESTRICT: if the
--     profile you're deleting ever published a quiz, this transaction will
--     fail with a foreign-key error and roll back automatically. That's a
--     safety net, not a bug — it means you picked an account that's still
--     doing something. Investigate before forcing it through.
--
-- How to use:
-- 1. Replace the UUIDs in `ids_to_delete` below with the exact profile_id
--    values you decided to remove from the diagnostic query's results.
-- 2. Run this whole script in Supabase Dashboard -> SQL Editor.
-- 3. Read the SELECT output under "Rows that will be deleted" BEFORE the
--    script reaches the actual DELETE — if it doesn't match what you
--    expect, stop here (close the SQL editor tab without running further,
--    or run ROLLBACK) instead of letting it continue.
-- 4. If it looks right, the script commits automatically at the end. If you
--    would rather approve it manually, remove the final COMMIT line and run
--    `COMMIT;` yourself only after checking the output.

BEGIN;

WITH ids_to_delete AS (
  SELECT unnest(ARRAY[
    'REPLACE-WITH-PROFILE-ID-1'::uuid
    -- , 'REPLACE-WITH-PROFILE-ID-2'::uuid
    -- , 'REPLACE-WITH-PROFILE-ID-3'::uuid
  ]) AS id
)
SELECT 'Rows that will be deleted' AS check_label,
       p.id, p.name, p.email, p.last_seen_at, p.created_at,
       (SELECT MAX(read_at) FROM public.reading_logs WHERE user_id = p.id) AS last_read_at,
       (SELECT COUNT(*) FROM public.reading_logs WHERE user_id = p.id) AS reading_log_count
FROM public.profiles p
JOIN ids_to_delete d ON d.id = p.id;

-- STOP AND READ the SELECT result above before letting this run further.

DELETE FROM public.profiles
WHERE id IN (
  SELECT unnest(ARRAY[
    'REPLACE-WITH-PROFILE-ID-1'::uuid
    -- , 'REPLACE-WITH-PROFILE-ID-2'::uuid
    -- , 'REPLACE-WITH-PROFILE-ID-3'::uuid
  ])
);

COMMIT;
