-- Hours breakdown: the frontend tracks before/during/after volunteer hours,
-- not a single hours_count. Replace the single column with three buckets plus
-- a generated total. Also add the participant_type and recorded_by_member_id
-- columns the frontend sends.

ALTER TABLE hours
  ADD COLUMN IF NOT EXISTS hours_before          NUMERIC(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hours_during          NUMERIC(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hours_after           NUMERIC(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS participant_type      TEXT,
  ADD COLUMN IF NOT EXISTS recorded_by_member_id TEXT REFERENCES members(member_id) ON DELETE SET NULL;

-- Backfill any existing rows: assume the prior single-column value was the
-- "during" bucket. Idempotent — only fills rows that haven't been split yet.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hours' AND column_name = 'hours_count'
  ) THEN
    EXECUTE 'UPDATE hours
             SET hours_during = hours_count
             WHERE hours_count IS NOT NULL
               AND hours_before = 0 AND hours_during = 0 AND hours_after = 0';
    EXECUTE 'ALTER TABLE hours DROP COLUMN hours_count';
  END IF;
END$$;

ALTER TABLE hours
  ADD COLUMN IF NOT EXISTS total_hours NUMERIC(7,2)
    GENERATED ALWAYS AS (hours_before + hours_during + hours_after) STORED;
