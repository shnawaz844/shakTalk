-- ShakTalk Admin Users Schema
-- Created on Nov 02, 2026
-- Enables database-backed administrative accounts, password hashing, and session management.

-- 1. Create admin_users table
CREATE TABLE IF NOT EXISTS public.admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'superadmin' CHECK (role IN ('superadmin', 'admin', 'moderator')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  session_token TEXT,
  token_expires_at TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes for fast lookup by username, email, or active session token
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON public.admin_users (lower(username));
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON public.admin_users (lower(email));
CREATE INDEX IF NOT EXISTS idx_admin_users_token ON public.admin_users (session_token);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policy: allow backend service role full access
DROP POLICY IF EXISTS "Service role full access on admin_users" ON public.admin_users;
CREATE POLICY "Service role full access on admin_users"
  ON public.admin_users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. Insert initial superadmin account
-- Credentials:
--   Username: admin
--   Email: admin@shaktalk.com
--   Default Password: shaktalk2026admin (salted PBKDF2 sha512)
INSERT INTO public.admin_users (
  username,
  email,
  password_hash,
  password_salt,
  role,
  is_active
) VALUES (
  'admin',
  'admin@shaktalk.com',
  'dcf7b41a6357332f389920800ae1577b219dae7c740d8a0d4fd77124d3f43ef3710d628e80d71013e8e176f01c342274cf22715ac9098e40f5021e93a0b5ab85',
  'd471ea737a6c094d3992f38e8aa04a30',
  'superadmin',
  TRUE
) ON CONFLICT (username) DO NOTHING;

