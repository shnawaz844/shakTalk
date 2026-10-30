-- ============================================================
-- ShakTranslate - Supabase Schema
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query
-- ============================================================

-- CONVERSATIONS table
CREATE TABLE IF NOT EXISTS public.conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL UNIQUE,
  host_user_id    TEXT,
  guest_user_id   TEXT,
  host_lang       TEXT,
  guest_lang      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS conversations_host_user_idx  ON public.conversations (host_user_id);
CREATE INDEX IF NOT EXISTS conversations_guest_user_idx ON public.conversations (guest_user_id);
CREATE INDEX IF NOT EXISTS conversations_session_idx    ON public.conversations (session_id);

-- MESSAGES table
CREATE TABLE IF NOT EXISTS public.messages (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id          UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_user_id           TEXT,
  role                     TEXT,
  original_text            TEXT DEFAULT '',
  translated_text          TEXT DEFAULT '',
  original_audio_url       TEXT,
  translated_audio_url     TEXT,
  original_audio_offset_ms INT DEFAULT 0,
  sent_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON public.messages (conversation_id);
CREATE INDEX IF NOT EXISTS messages_sender_idx       ON public.messages (sender_user_id);
CREATE INDEX IF NOT EXISTS messages_sent_at_idx      ON public.messages (sent_at);

-- RLS ON with no policies: the server's service role key bypasses RLS, while
-- the public anon key gets no access. (See migrations/2026-10-25_enable_row_level_security.sql)
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;

-- USER_PLANS table
-- Stores the AI translation plan each user selected on the plan-selection screen.
-- user_id is the Clerk user sub (unique per user).
CREATE TABLE IF NOT EXISTS public.user_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL UNIQUE,
  plan_engine   TEXT NOT NULL,     -- 'legacy' | 'livekit'
  model_id      TEXT NOT NULL,     -- e.g. 'gemini-live-2.5-flash-native-audio'
  selected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_plans_user_idx ON public.user_plans (user_id);
ALTER TABLE public.user_plans ENABLE ROW LEVEL SECURITY;

-- WALLETS table
-- Stores prepaid user balance for calls and plan subscriptions.
CREATE TABLE IF NOT EXISTS public.user_wallets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL UNIQUE,
  balance_cents BIGINT NOT NULL DEFAULT 0, -- Stored in USD cents (e.g. 1000 = $10.00)
  currency      TEXT NOT NULL DEFAULT 'USD',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_wallets_user_idx ON public.user_wallets (user_id);
ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;

-- WALLET_TRANSACTIONS table
-- Audit log of all top-ups and deductions.
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  amount_cents    BIGINT NOT NULL,
  type            TEXT NOT NULL, -- 'topup' | 'subscription' | 'call_deduction'
  description     TEXT,
  payment_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx ON public.wallet_transactions (user_id);
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
