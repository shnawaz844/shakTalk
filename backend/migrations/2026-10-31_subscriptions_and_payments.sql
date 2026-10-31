-- ShakTalk Subscriptions & Payments Schema
-- Based on Subscriptions & Payments Build Plan (Oct 31, 2026)

-- 1. billing_accounts table
CREATE TABLE IF NOT EXISTS billing_accounts (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'none', 'standard', 'pro')),
  period_end TIMESTAMPTZ,
  plan_seconds_left INTEGER NOT NULL DEFAULT 600, -- 10 Pro minutes for initial trial
  will_renew BOOLEAN NOT NULL DEFAULT FALSE,
  trial_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for device trial fraud prevention (1 trial per physical device)
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_accounts_device_trial 
ON billing_accounts (trial_device_id) 
WHERE trial_device_id IS NOT NULL;

-- 2. minute_packs table (Consumable Top-ups)
CREATE TABLE IF NOT EXISTS minute_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
  engine TEXT NOT NULL CHECK (engine IN ('legacy', 'livekit')),
  seconds_left INTEGER NOT NULL DEFAULT 3600, -- 60 minutes = 3600s
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 months'),
  transaction_id TEXT NOT NULL UNIQUE, -- Prevents double credit on webhook replay
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_minute_packs_user_fifo 
ON minute_packs (user_id, expires_at ASC) 
WHERE seconds_left > 0;

-- 3. call_usage table
CREATE TABLE IF NOT EXISTS call_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  billed_seconds INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_usage_user 
ON call_usage (user_id, created_at DESC);
