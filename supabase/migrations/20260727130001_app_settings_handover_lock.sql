-- App-level key/value settings, used first for the handover lock.
--
-- The handover lock freezes all write actions across the whole API
-- (enforced in the Edge Function dispatcher) so the club's data —
-- members, hours, everything — can't change during a committee
-- handover. Only reads, login, export, and unlock keep working.
--
-- RLS enabled + forced with no policies: only the Edge Function
-- (service-role connection) reads/writes this, same posture as the
-- other app tables.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by integer REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings FORCE ROW LEVEL SECURITY;

-- Seed the lock row in the unlocked state.
INSERT INTO public.app_settings (key, value)
  VALUES ('handover_lock', '{"locked": false}'::jsonb)
  ON CONFLICT (key) DO NOTHING;
