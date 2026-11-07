-- Migration: 2026-11-06_leads_and_pilots.sql
-- Tables for capturing website B2B leads and iOS waitlist registrations

-- 1. Table: public.waitlist_leads
-- Stores users requesting notification for the iPhone / iOS App Store launch
CREATE TABLE IF NOT EXISTS public.waitlist_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'ios-waitlist',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.waitlist_leads ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Allow service role full access to waitlist_leads"
ON public.waitlist_leads FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Index for fast lookup & sorting
CREATE INDEX IF NOT EXISTS idx_waitlist_leads_created_at ON public.waitlist_leads (created_at DESC);


-- 2. Table: public.pilot_requests
-- Stores inbound B2B company pilot and industry programme requests
CREATE TABLE IF NOT EXISTS public.pilot_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  country TEXT,
  language_pair TEXT,
  team_size TEXT,
  contact TEXT NOT NULL,
  assigned_to TEXT NOT NULL DEFAULT 'sales@shaktalk.com',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.pilot_requests ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Allow service role full access to pilot_requests"
ON public.pilot_requests FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Index for fast lookup & sorting
CREATE INDEX IF NOT EXISTS idx_pilot_requests_created_at ON public.pilot_requests (created_at DESC);

