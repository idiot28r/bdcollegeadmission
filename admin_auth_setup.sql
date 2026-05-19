-- =============================================================================
-- Admin auth setup. Run ONCE in the Supabase SQL editor.
--
-- 1. Before running: replace 'CHANGE-ME-NOW' on line ~30 with a strong secret.
--    This is your "signup key" — anyone who knows it can create an admin via
--    the app's "Create Admin" screen. Keep it private.
--
-- 2. After running, go to your app, navigate to /?admin, click
--    "Need to create an admin? →", and use your signup key to create the
--    first admin user. Subsequent admins can also be created through the
--    same screen with the same signup key.
--
-- 3. To rotate the signup key later, run:
--      UPDATE public.admin_config SET signup_key = 'NEW-SECRET' WHERE id = 1;
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ===== Tables =====

CREATE TABLE IF NOT EXISTS public.admins (
  id            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
-- No policies — direct SELECT/INSERT/UPDATE/DELETE is blocked for everyone.
-- The RPCs below (SECURITY DEFINER) are the only way to touch this table.
REVOKE ALL ON public.admins FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.admin_config (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  signup_key text NOT NULL
);
ALTER TABLE public.admin_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_config FROM anon, authenticated;

-- !! EDIT THIS LINE: replace 'CHANGE-ME-NOW' with your private signup key.
INSERT INTO public.admin_config (id, signup_key)
VALUES (1, 'CHANGE-ME-NOW')
ON CONFLICT (id) DO UPDATE SET signup_key = EXCLUDED.signup_key;

-- ===== RPCs =====

-- Sign in. Returns one row {id, username} on success, zero rows on failure.
CREATE OR REPLACE FUNCTION public.admin_login(p_username text, p_password text)
RETURNS TABLE(id uuid, username text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id       uuid;
  v_hash     text;
  v_username text;
BEGIN
  SELECT a.id, a.password_hash, a.username
    INTO v_id, v_hash, v_username
    FROM public.admins a
    WHERE a.username = lower(trim(p_username));

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  IF crypt(p_password, v_hash) = v_hash THEN
    RETURN QUERY SELECT v_id, v_username;
  END IF;
END;
$$;

-- Create a new admin. Requires the signup key. Returns the new admin's id.
-- Raises an exception on bad key or invalid input.
CREATE OR REPLACE FUNCTION public.admin_signup(p_admin_key text, p_username text, p_password text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_expected text;
  v_id       uuid;
  v_username text;
BEGIN
  SELECT signup_key INTO v_expected FROM public.admin_config WHERE id = 1;
  IF v_expected IS NULL OR p_admin_key <> v_expected THEN
    RAISE EXCEPTION 'Invalid admin key';
  END IF;

  v_username := lower(trim(p_username));
  IF length(v_username) < 3 THEN
    RAISE EXCEPTION 'Username must be at least 3 characters';
  END IF;
  IF length(p_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters';
  END IF;

  INSERT INTO public.admins (username, password_hash)
  VALUES (v_username, crypt(p_password, gen_salt('bf', 10)))
  RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That username is already taken';
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_login(text, text)            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_signup(text, text, text)     TO anon, authenticated;
