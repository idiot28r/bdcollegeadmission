-- =============================================================================
-- Announcement banner — added to the existing settings row (id = 1).
-- banner_enabled controls visibility; banner_message is the text.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS banner_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS banner_message text NOT NULL DEFAULT 'প্রশ্ন আপলোডের কাজ চলছে';

-- Make sure the singleton row exists so UPDATE statements have a target.
INSERT INTO public.settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
