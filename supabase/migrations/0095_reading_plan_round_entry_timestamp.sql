-- Migration 0095: record exactly when a user confirmed entering their plan's
-- current round, so the next round's daily schedule can start counting from
-- that moment instead of inferring it from the previous round's last log or
-- the next round's first log (both of which could misrepresent the gap
-- between finishing one round and actually starting the next).
ALTER TABLE public.reading_plans
  ADD COLUMN IF NOT EXISTS current_round_started_at TIMESTAMP WITH TIME ZONE;
