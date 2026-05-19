-- =============================================================================
-- Block direct writes from the anon (browser) key. After this:
--   - students can read questions + settings  (unchanged)
--   - nobody can write to either table via the anon REST API
--   - the admin Edge Function (using service_role) bypasses RLS and can write
--
-- Trade-off: anon retains SELECT on ALL questions including `hidden = true`.
-- If you want truly private hidden questions, change the policy to
-- `USING (hidden = false)` — but then your admin UI's reads will also be
-- filtered, and you'd need a read RPC or route admin reads through the proxy.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read questions" ON public.questions;
DROP POLICY IF EXISTS "anon read settings"  ON public.settings;

-- Read everything from these two tables. No INSERT/UPDATE/DELETE policy =
-- those operations are blocked for anon and authenticated.
CREATE POLICY "anon read questions"
  ON public.questions FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "anon read settings"
  ON public.settings FOR SELECT TO anon, authenticated
  USING (true);
