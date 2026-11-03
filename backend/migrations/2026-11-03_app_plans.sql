-- Migration: 2026-11-03_app_plans.sql
-- Table: public.app_plans
-- Stores dynamic subscription plans, pricing, and promotional discount configuration.

CREATE TABLE IF NOT EXISTS public.app_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  model_name TEXT,
  engine TEXT NOT NULL DEFAULT 'livekit',
  currency TEXT NOT NULL DEFAULT 'INR',
  price_inr NUMERIC NOT NULL DEFAULT 0,
  original_price_inr NUMERIC NOT NULL DEFAULT 0,
  price_usd NUMERIC NOT NULL DEFAULT 0,
  original_price_usd NUMERIC NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0,
  badge TEXT DEFAULT '',
  discount_active BOOLEAN NOT NULL DEFAULT FALSE,
  discount_percentage NUMERIC DEFAULT 0,
  discount_start_date TIMESTAMPTZ,
  discount_end_date TIMESTAMPTZ,
  selected_currency TEXT DEFAULT 'USD',
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.app_plans ENABLE ROW LEVEL SECURITY;

-- Allow public read access (for mobile app & website to fetch plans)
CREATE POLICY "Allow public read access to app_plans"
ON public.app_plans FOR SELECT
USING (true);

-- Allow service_role full access (for admin backend to update plans)
CREATE POLICY "Allow service role full access to app_plans"
ON public.app_plans FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

