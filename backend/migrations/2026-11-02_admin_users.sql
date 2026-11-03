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

-- 5. Insert or Update superadmin account
-- Credentials:
--   Username: admin
--   Email: cisafzllc.dev@gmail.com
--   Password: Myb'day@06 (salted PBKDF2 sha512)
INSERT INTO public.admin_users (
  username,
  email,
  password_hash,
  password_salt,
  role,
  is_active
) VALUES (
  'admin',
  'cisafzllc.dev@gmail.com',
  'ade3470b70c02a4cb00bf414c5834eb977b87e4040595aebb97561f70fe237eada28b01e34701830e54111ac14c35d84a153937c520885fe11ef09557207c837',
  'efed6f35ae37c8c5e04ac0901f62f9e5',
  'superadmin',
  TRUE
)
ON CONFLICT (username) DO UPDATE SET
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  password_salt = EXCLUDED.password_salt,
  is_active = TRUE,
  updated_at = NOW();

-- Also ensure any account with this email is updated
UPDATE public.admin_users
SET 
  password_hash = 'ade3470b70c02a4cb00bf414c5834eb977b87e4040595aebb97561f70fe237eada28b01e34701830e54111ac14c35d84a153937c520885fe11ef09557207c837',
  password_salt = 'efed6f35ae37c8c5e04ac0901f62f9e5',
  is_active = TRUE,
  updated_at = NOW()
WHERE email = 'cisafzllc.dev@gmail.com' OR username = 'admin';

