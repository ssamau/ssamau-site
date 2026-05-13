-- Pin `search_path` on the trg_set_updated_at trigger function.
--
-- Flagged by Supabase Security Advisor: "Function Search Path Mutable".
--
-- The risk: the function body says `NEW.updated_at = NOW()` — both
-- `NEW` and `NOW()` resolve through whatever `search_path` is in
-- effect at execution time. If an attacker can create objects in a
-- schema that's searched ahead of `pg_catalog`, they could intercept
-- a built-in like `NOW()`. The default Postgres setup makes this hard
-- (`pg_catalog` is always searched first implicitly), but the
-- Supabase linter wants the path pinned explicitly so we don't rely
-- on the default — defence in depth.
--
-- Fix: `SET search_path = pg_catalog, pg_temp` on the function. This
-- means built-ins always come from pg_catalog and nothing else gets
-- searched. The function body doesn't reference user tables, so
-- omitting `public` is correct here — anything that needs `public`
-- (like the trigger's NEW row) is already schema-qualified by the
-- trigger machinery.
--
-- ALTER FUNCTION ... SET search_path is a no-rewrite operation; the
-- function body is untouched, only its config is changed. Existing
-- triggers continue to work.

ALTER FUNCTION public.trg_set_updated_at()
  SET search_path = pg_catalog, pg_temp;

-- Defensive: same pin via CREATE OR REPLACE so if anyone ever pulls
-- the function definition out of pg_dump for a fresh-install, the
-- pinning travels with the source.
CREATE OR REPLACE FUNCTION public.trg_set_updated_at()
RETURNS TRIGGER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
