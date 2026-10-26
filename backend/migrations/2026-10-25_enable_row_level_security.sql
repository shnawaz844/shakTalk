-- Turn Row Level Security back ON for all app tables.
--
-- Why: with RLS disabled, anyone who has the project's public "anon" key can
-- read and change these tables directly through Supabase's REST API,
-- bypassing our server completely.
--
-- Is it safe? Yes. Our backend uses the SERVICE ROLE key, which always
-- bypasses RLS, so the server keeps working exactly as before. With RLS on
-- and no policies, the anon/public key simply gets no access.
--
-- Run once in Supabase → SQL Editor.

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_plans    ENABLE ROW LEVEL SECURITY;

-- Check (should list all three with rowsecurity = true):
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'
--   AND tablename IN ('conversations', 'messages', 'user_plans');
