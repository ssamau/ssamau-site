-- Port of netlify/database/migrations/0007_application_whatsapp.sql
--
-- Capture WhatsApp number on new membership applications so it round-trips
-- the same way bulk-imported members do. Many applicants use a different
-- number for WhatsApp than for calls. Stored as E.164.
-- Hand-port from Netlify, unchanged.

ALTER TABLE membership_applications
  ADD COLUMN IF NOT EXISTS whatsapp                  TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_country_code     TEXT;
