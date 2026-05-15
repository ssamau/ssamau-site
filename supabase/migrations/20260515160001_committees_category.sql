-- Committees — distinguish specialized committees from initiatives.
--
-- ── Why ────────────────────────────────────────────────────────────
-- The homepage hero + about-us KPIs show "لجان متخصصة" (Specialized
-- Committees) with the count of committee rows in the DB. There are
-- currently 10 rows but only 9 are actually specialized committees;
-- the 10th, "مبادرة مرفأ", is an initiative the club runs — same
-- governance shape (head + vice, members, projects) but not a
-- standing committee. President called this out directly:
-- "9 specialized committees, مرفأ is an initiative".
--
-- Solution: a `category` column with two values (Specialized,
-- Initiative). The homepage counter then filters to category=
-- 'Specialized' and the count drops from 10 → 9 automatically without
-- having to hardcode "exclude this one row".
--
-- The Specialized default means every existing + future committee
-- shows in the count by default; flipping a row to Initiative is an
-- explicit admin choice.

ALTER TABLE public.committees
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Specialized'
    CHECK (category IN ('Specialized', 'Initiative'));

COMMENT ON COLUMN public.committees.category IS
  'Specialized = a standing committee (default, counts toward "لجان متخصصة" stat). Initiative = a named club initiative with committee-shaped governance but NOT a specialized committee (excluded from the homepage count).';

-- Migrate the single known initiative. Match by name pattern in case
-- the prefix wording shifts ("مبادرة مرفأ" vs just "مرفأ" depending
-- on data source).
UPDATE public.committees
SET    category = 'Initiative'
WHERE  committee_name LIKE '%مرفأ%';
