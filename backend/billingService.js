/**
 * ShakTalk - Billing & Subscription Service
 * Based on "ShakTalk – Subscriptions & Payments Build Plan" (Oct 31, 2026)
 *
 * Rules:
 * - Single source of truth on the server for plans, engines, and minutes left.
 * - Free trial: 10 Pro minutes (livekit) once per account and per device. Never resets.
 * - Standard plan: 100 mins/mo (legacy turn-by-turn). Resets every renewal. Top-up +60m ($2.99/₹299, 12m).
 * - Pro plan: 110 mins/mo (livekit real-time). Resets every renewal. Top-up +60m ($8.99/₹849, 12m).
 * - Call billing: Host pays, guest is free. Clock starts on `gemini_ready`.
 * - Top-ups: Used after plan minutes, oldest first, expire in 12 months.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('./supabaseClient');

const DATA_DIR = path.join(__dirname, 'data');
const BILLING_FILE = path.join(DATA_DIR, 'billing_accounts.json');
const PACKS_FILE = path.join(DATA_DIR, 'minute_packs.json');
const USAGE_FILE = path.join(DATA_DIR, 'call_usage_v2.json');

const TRIAL_MINUTES = parseInt(process.env.TRIAL_MINUTES || '10', 10);
const PLAN_MINUTES_STANDARD = parseInt(process.env.PLAN_MINUTES_STANDARD || '100', 10);
const PLAN_MINUTES_PRO = parseInt(process.env.PLAN_MINUTES_PRO || '110', 10);
const TOPUP_MINUTES = parseInt(process.env.TOPUP_MINUTES || '60', 10);
const BILLING_ENFORCE = process.env.BILLING_ENFORCE !== 'false';

// ── File storage helpers for fallback / local resiliency ─────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, def = {}) {
  try {
    ensureDataDir();
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[billingService] Error reading ${file}:`, e.message);
  }
  return def;
}

function writeJson(file, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`[billingService] Error writing ${file}:`, e.message);
  }
}

// ── Map plan to engine ───────────────────────────────────────────────────────
function getEngineForPlan(plan) {
  if (plan === 'pro' || plan === 'trial') return 'livekit';
  if (plan === 'standard') return 'legacy';
  return 'legacy'; // fallback for 'none'
}

// ── Account Initialization & Retrieval ──────────────────────────────────────
async function getOrCreateAccount(userId, deviceId = null) {
  if (!userId) userId = 'anonymous';

  // 1. Try Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('billing_accounts')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (!error && data) {
        return data;
      }

      // Check device fraud: if deviceId was already used for a trial, grant 0 minutes
      let canGetTrial = true;
      if (deviceId) {
        const { data: existingDevice } = await supabase
          .from('billing_accounts')
          .select('user_id')
          .eq('trial_device_id', deviceId)
          .maybeSingle();
        if (existingDevice) canGetTrial = false;
      }

      const initialPlan = canGetTrial ? 'trial' : 'none';
      const initialSeconds = canGetTrial ? TRIAL_MINUTES * 60 : 0;

      const newAccount = {
        user_id: userId,
        plan: initialPlan,
        period_end: null,
        plan_seconds_left: initialSeconds,
        will_renew: false,
        trial_device_id: canGetTrial ? deviceId : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: created, error: insertErr } = await supabase
        .from('billing_accounts')
        .insert(newAccount)
        .select()
        .single();

      if (!insertErr && created) {
        console.log(`[billingService] Created Supabase billing account for ${userId} (plan: ${initialPlan}, seconds: ${initialSeconds})`);
        return created;
      }
    } catch (e) {
      console.warn('[billingService] Supabase getOrCreateAccount fallback:', e.message);
    }
  }

  // 2. Fallback to Local JSON
  const accounts = readJson(BILLING_FILE, {});
  if (accounts[userId]) {
    return accounts[userId];
  }

  // Device check in local storage
  let canGetTrial = true;
  if (deviceId) {
    for (const id of Object.keys(accounts)) {
      if (accounts[id].trial_device_id === deviceId) {
        canGetTrial = false;
        break;
      }
    }
  }

  const initialPlan = canGetTrial ? 'trial' : 'none';
  const initialSeconds = canGetTrial ? TRIAL_MINUTES * 60 : 0;

  const newAcc = {
    user_id: userId,
    plan: initialPlan,
    period_end: null,
    plan_seconds_left: initialSeconds,
    will_renew: false,
    trial_device_id: canGetTrial ? deviceId : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  accounts[userId] = newAcc;
  writeJson(BILLING_FILE, accounts);
  console.log(`[billingService] Created Local billing account for ${userId} (plan: ${initialPlan}, seconds: ${initialSeconds})`);
  return newAcc;
}

// ── Get Active Minute Packs ──────────────────────────────────────────────────
async function getActiveMinutePacks(userId, engine = null) {
  const now = new Date().toISOString();

  if (supabase) {
    try {
      let query = supabase
        .from('minute_packs')
        .select('*')
        .eq('user_id', userId)
        .gt('seconds_left', 0)
        .gt('expires_at', now)
        .order('expires_at', { ascending: true });

      if (engine) {
        query = query.eq('engine', engine);
      }

      const { data, error } = await query;
      if (!error && Array.isArray(data)) return data;
    } catch (e) {
      console.warn('[billingService] Supabase getActiveMinutePacks fallback:', e.message);
    }
  }

  const allPacks = readJson(PACKS_FILE, []);
  const userPacks = allPacks.filter((p) => {
    if (p.user_id !== userId) return false;
    if (p.seconds_left <= 0) return false;
    if (p.expires_at <= now) return false;
    if (engine && p.engine !== engine) return false;
    return true;
  });

  return userPacks.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
}

// ── Get Available Minutes Summary ────────────────────────────────────────────
async function getAvailableMinutes(userId, deviceId = null) {
  const account = await getOrCreateAccount(userId, deviceId);
  const engine = getEngineForPlan(account.plan);
  const packs = await getActiveMinutePacks(userId, engine);

  const topupSecondsLeft = packs.reduce((acc, p) => acc + (p.seconds_left || 0), 0);
  const planSecondsLeft = Math.max(0, account.plan_seconds_left || 0);
  const totalSeconds = planSecondsLeft + topupSecondsLeft;

  const planMinutes = Math.floor(planSecondsLeft / 60);
  const topupMinutes = Math.floor(topupSecondsLeft / 60);
  const totalMinutes = Math.floor(totalSeconds / 60);

  return {
    plan: account.plan,
    engine,
    planMinutesRemaining: planMinutes,
    planSecondsRemaining: planSecondsLeft,
    topupMinutesRemaining: topupMinutes,
    totalMinutes,
    totalSeconds,
    periodEnd: account.period_end,
    willRenew: account.will_renew,
    topupPacksCount: packs.length,
  };
}

// ── Atomic Charge Function ───────────────────────────────────────────────────
/**
 * Deduct seconds from host's plan minutes first, then top-up packs FIFO.
 * Waiting for the partner is free. Rounded up to nearest minute at call end.
 */
async function charge(userId, secondsToCharge, engine) {
  if (!secondsToCharge || secondsToCharge <= 0) {
    return await getAvailableMinutes(userId);
  }

  const account = await getOrCreateAccount(userId);
  let remainingToDeduct = secondsToCharge;

  // 1. Deduct from plan seconds first
  let newPlanSeconds = account.plan_seconds_left;
  if (newPlanSeconds > 0) {
    const fromPlan = Math.min(newPlanSeconds, remainingToDeduct);
    newPlanSeconds -= fromPlan;
    remainingToDeduct -= fromPlan;
  }

  // Update account in Supabase or Local
  if (supabase) {
    try {
      await supabase
        .from('billing_accounts')
        .update({ plan_seconds_left: newPlanSeconds, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    } catch (e) {
      console.warn('[billingService] Supabase plan_seconds_left update fallback:', e.message);
    }
  }
  const accounts = readJson(BILLING_FILE, {});
  if (accounts[userId]) {
    accounts[userId].plan_seconds_left = newPlanSeconds;
    accounts[userId].updated_at = new Date().toISOString();
    writeJson(BILLING_FILE, accounts);
  }

  // 2. Deduct remainder from active minute packs FIFO (oldest first)
  if (remainingToDeduct > 0) {
    const packs = await getActiveMinutePacks(userId, engine);
    const allPacks = readJson(PACKS_FILE, []);

    for (const pack of packs) {
      if (remainingToDeduct <= 0) break;
      const take = Math.min(pack.seconds_left, remainingToDeduct);
      pack.seconds_left -= take;
      remainingToDeduct -= take;

      if (supabase) {
        try {
          await supabase
            .from('minute_packs')
            .update({ seconds_left: pack.seconds_left })
            .eq('id', pack.id);
        } catch (e) {
          console.warn('[billingService] Supabase pack deduction fallback:', e.message);
        }
      }

      // Sync local file
      const idx = allPacks.findIndex((p) => p.id === pack.id || (p.transaction_id && p.transaction_id === pack.transaction_id));
      if (idx !== -1) {
        allPacks[idx].seconds_left = pack.seconds_left;
      }
    }
    writeJson(PACKS_FILE, allPacks);
  }

  return await getAvailableMinutes(userId);
}

// ── Log Completed Call Usage ─────────────────────────────────────────────────
async function recordCallUsage({ userId, sessionId, engine, startedAt, endedAt, billedSeconds }) {
  const usageRecord = {
    id: uuidv4(),
    user_id: userId,
    session_id: sessionId,
    engine,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    billed_seconds: billedSeconds,
    created_at: new Date().toISOString(),
  };

  if (supabase) {
    try {
      await supabase.from('call_usage').insert(usageRecord);
    } catch (e) {
      console.warn('[billingService] Supabase recordCallUsage fallback:', e.message);
    }
  }

  const allUsage = readJson(USAGE_FILE, []);
  allUsage.push(usageRecord);
  writeJson(USAGE_FILE, allUsage);
}

// ── RevenueCat Webhook Handler ───────────────────────────────────────────────
async function applyRevenueCatEvent(event) {
  const type = event.type;
  const appUserId = event.app_user_id;
  const productId = (event.product_id || '').toLowerCase();
  const transactionId = event.transaction_id || event.id || uuidv4();

  console.log(`[billingService] Processing RevenueCat webhook event '${type}' for user ${appUserId} (product: ${productId})`);

  if (!appUserId) return { status: 'ignored_no_user' };

  const account = await getOrCreateAccount(appUserId);

  // Check if standard or pro
  const isPro = productId.includes('pro');
  const isStandard = productId.includes('standard');
  const isTopup = productId.includes('topup');

  // 1. Initial Purchase & Renewal
  if (type === 'INITIAL_PURCHASE' || type === 'RENEWAL') {
    if (isTopup) {
      // Consumable top-up
      await addMinutePack(appUserId, isPro ? 'livekit' : 'legacy', transactionId);
    } else {
      // Subscription reset
      const newPlan = isPro ? 'pro' : 'standard';
      const allocatedSeconds = (isPro ? PLAN_MINUTES_PRO : PLAN_MINUTES_STANDARD) * 60;
      const periodEnd = event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null;

      await updateAccountFields(appUserId, {
        plan: newPlan,
        plan_seconds_left: allocatedSeconds,
        period_end: periodEnd,
        will_renew: true,
      });
      console.log(`[billingService] ${type}: Set plan '${newPlan}' with ${allocatedSeconds / 60} mins for ${appUserId}`);
    }
  }
  // 2. Product Change (Upgrade / Downgrade)
  else if (type === 'PRODUCT_CHANGE') {
    if (isPro) {
      // Immediate upgrade to Pro: full Pro minutes at once
      const allocatedSeconds = PLAN_MINUTES_PRO * 60;
      const periodEnd = event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null;
      await updateAccountFields(appUserId, {
        plan: 'pro',
        plan_seconds_left: allocatedSeconds,
        period_end: periodEnd,
        will_renew: true,
      });
      console.log(`[billingService] Immediate Upgrade to Pro for ${appUserId}: ${PLAN_MINUTES_PRO} mins granted`);
    } else if (isStandard) {
      // Downgrade happens at next renewal (keep Pro until period end)
      console.log(`[billingService] Downgrade scheduled for next renewal for ${appUserId}`);
    }
  }
  // 3. Cancellation (User turns off auto-renewal)
  else if (type === 'CANCELLATION') {
    await updateAccountFields(appUserId, { will_renew: false });
    console.log(`[billingService] Cancellation: will_renew set to false for ${appUserId}; plan remains active until period_end`);
  }
  // 4. Expiration (Period ended without renewal)
  else if (type === 'EXPIRATION') {
    await updateAccountFields(appUserId, {
      plan: 'none',
      plan_seconds_left: 0,
      will_renew: false,
    });
    console.log(`[billingService] Expiration: Set plan 'none' and 0 plan seconds for ${appUserId}`);
  }
  // 5. Non-renewing purchase (Consumable top-up via custom event)
  else if (type === 'NON_RENEWING_PURCHASE') {
    await addMinutePack(appUserId, isPro ? 'livekit' : 'legacy', transactionId);
  }
  // 6. Refund
  else if (type === 'REFUND') {
    console.log(`[billingService] Refund received for ${appUserId}. Removing purchased minutes.`);
    if (isTopup) {
      // Mark pack as 0
      await voidMinutePack(transactionId);
    } else {
      // Deduct plan minutes down to 0
      const current = await getOrCreateAccount(appUserId);
      const deduct = (isPro ? PLAN_MINUTES_PRO : PLAN_MINUTES_STANDARD) * 60;
      const newSec = Math.max(0, (current.plan_seconds_left || 0) - deduct);
      await updateAccountFields(appUserId, { plan_seconds_left: newSec });
    }
  }

  return { status: 'processed', type, user: appUserId };
}

// ── Add Top-Up Minute Pack ───────────────────────────────────────────────────
async function addMinutePack(userId, engine, transactionId) {
  // Idempotency: prevent double credit on repeated webhook delivery
  if (supabase) {
    try {
      const { data: existing } = await supabase
        .from('minute_packs')
        .select('id')
        .eq('transaction_id', transactionId)
        .maybeSingle();
      if (existing) {
        console.log(`[billingService] Minute pack transaction ${transactionId} already exists. Skipping.`);
        return existing;
      }
    } catch (e) {
      console.warn('[billingService] Supabase idempotency check fallback:', e.message);
    }
  }

  const allPacks = readJson(PACKS_FILE, []);
  if (allPacks.find((p) => p.transaction_id === transactionId)) {
    console.log(`[billingService] Local minute pack transaction ${transactionId} already exists. Skipping.`);
    return;
  }

  const seconds = TOPUP_MINUTES * 60; // +60 mins = 3600s
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 12 months

  const pack = {
    id: uuidv4(),
    user_id: userId,
    engine,
    seconds_left: seconds,
    expires_at: expiresAt,
    transaction_id: transactionId,
    created_at: new Date().toISOString(),
  };

  if (supabase) {
    try {
      await supabase.from('minute_packs').insert(pack);
    } catch (e) {
      console.warn('[billingService] Supabase addMinutePack fallback:', e.message);
    }
  }

  allPacks.push(pack);
  writeJson(PACKS_FILE, allPacks);
  console.log(`[billingService] Added +${TOPUP_MINUTES} mins top-up pack for ${userId} (${engine}, expires: ${expiresAt})`);
  return pack;
}

async function voidMinutePack(transactionId) {
  if (supabase) {
    try {
      await supabase.from('minute_packs').update({ seconds_left: 0 }).eq('transaction_id', transactionId);
    } catch (e) {
      console.warn('[billingService] Supabase voidMinutePack fallback:', e.message);
    }
  }
  const allPacks = readJson(PACKS_FILE, []);
  const p = allPacks.find((x) => x.transaction_id === transactionId);
  if (p) {
    p.seconds_left = 0;
    writeJson(PACKS_FILE, allPacks);
  }
}

async function updateAccountFields(userId, fields) {
  fields.updated_at = new Date().toISOString();

  if (supabase) {
    try {
      await supabase.from('billing_accounts').update(fields).eq('user_id', userId);
    } catch (e) {
      console.warn('[billingService] Supabase updateAccountFields fallback:', e.message);
    }
  }

  const accounts = readJson(BILLING_FILE, {});
  if (accounts[userId]) {
    accounts[userId] = { ...accounts[userId], ...fields };
  } else {
    accounts[userId] = { user_id: userId, ...fields };
  }
  writeJson(BILLING_FILE, accounts);
}

module.exports = {
  getOrCreateAccount,
  getAvailableMinutes,
  getEngineForPlan,
  charge,
  recordCallUsage,
  applyRevenueCatEvent,
  addMinutePack,
  BILLING_ENFORCE,
  TRIAL_MINUTES,
  PLAN_MINUTES_STANDARD,
  PLAN_MINUTES_PRO,
  TOPUP_MINUTES,
};
