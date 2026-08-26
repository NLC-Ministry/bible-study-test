-- Read-only diagnostic query: find likely duplicate profiles and show enough
-- activity signal (last login, last actual reading, account age) to decide
-- which one to keep. Does NOT delete or modify anything.
--
-- How to use: run in Supabase Dashboard -> SQL Editor. Review the `match_type`
-- and `match_key` columns to see WHY two rows were grouped together, then use
-- last_seen_at / last_read_at / created_at to judge which is the live one.

WITH placeholder_names AS (
  -- Never treat these as a "real" duplicate signal — they're invented/empty
  -- display-name fallbacks, not an actual person's name.
  SELECT unnest(ARRAY[
    '新使用者', '未命名使用者', '教會肢體', '尚未取得姓名', 'NLC User', '訪客', ''
  ]) AS name
),
eligible_profiles AS (
  SELECT p.*
  FROM public.profiles p
  WHERE p.is_demo = FALSE
),
last_read AS (
  SELECT user_id, MAX(read_at) AS last_read_at
  FROM public.reading_logs
  GROUP BY user_id
),
identity_summary AS (
  SELECT
    profile_id,
    STRING_AGG(DISTINCT provider, ', ' ORDER BY provider) AS providers,
    MAX(last_seen_at) AS identity_last_seen_at
  FROM public.user_identities
  GROUP BY profile_id
),
by_email AS (
  SELECT
    'same_email' AS match_type,
    LOWER(TRIM(p.email)) AS match_key,
    p.id
  FROM eligible_profiles p
  WHERE p.email IS NOT NULL AND TRIM(p.email) <> ''
),
by_name AS (
  SELECT
    'same_name' AS match_type,
    LOWER(TRIM(p.name)) AS match_key,
    p.id
  FROM eligible_profiles p
  WHERE p.name IS NOT NULL
    AND TRIM(p.name) <> ''
    AND TRIM(p.name) NOT IN (SELECT name FROM placeholder_names)
),
candidate_groups AS (
  SELECT match_type, match_key FROM by_email GROUP BY match_type, match_key HAVING COUNT(*) > 1
  UNION ALL
  SELECT match_type, match_key FROM by_name GROUP BY match_type, match_key HAVING COUNT(*) > 1
),
matched_ids AS (
  SELECT g.match_type, g.match_key, e.id
  FROM candidate_groups g
  JOIN by_email e ON g.match_type = 'same_email' AND g.match_key = e.match_key
  UNION ALL
  SELECT g.match_type, g.match_key, n.id
  FROM candidate_groups g
  JOIN by_name n ON g.match_type = 'same_name' AND g.match_key = n.match_key
)
SELECT
  m.match_type,
  m.match_key,
  p.id AS profile_id,
  p.name,
  p.email,
  p.great_region,
  p.pastoral_zone,
  p.small_group,
  p.is_active,
  p.last_seen_at,
  lr.last_read_at,
  p.created_at,
  isum.providers AS login_providers,
  GREATEST(COALESCE(p.last_seen_at, 'epoch'::timestamptz), COALESCE(lr.last_read_at, 'epoch'::timestamptz)) AS last_activity_at
FROM matched_ids m
JOIN public.profiles p ON p.id = m.id
LEFT JOIN last_read lr ON lr.user_id = p.id
LEFT JOIN identity_summary isum ON isum.profile_id = p.id
ORDER BY m.match_type, m.match_key, last_activity_at DESC NULLS LAST;
