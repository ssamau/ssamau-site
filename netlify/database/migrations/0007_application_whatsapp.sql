-- Capture WhatsApp number on new membership applications so it round-trips
-- the same way bulk-imported members do. Many applicants will use a different
-- number for WhatsApp than for calls (e.g. a Saudi WhatsApp + an Aussie SIM
-- for calls), and admins need both for contact.
--
-- Stored as a free E.164 string (e.g. '+966500000000'); apply.html composes
-- it from a country-code dropdown + the local number, same UX as `phone`.

ALTER TABLE membership_applications
  ADD COLUMN IF NOT EXISTS whatsapp                  TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_country_code     TEXT;
