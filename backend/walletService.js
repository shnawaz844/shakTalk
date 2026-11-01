/**
 * Wallet Service for ShakTalk
 * Handles user balances, wallet minutes top-ups via Razorpay, and balance deductions.
 * Provides resilient fallback storage to guarantee 100% uptime.
 * 
 * Conversion Rate:
 * - 1 Minute = 10 Cents ($0.10 / min)
 * - 100 Mins = 1,000 Cents ($10.00)
 */
const fs = require('fs');
const path = require('path');
const { supabase } = require('./supabaseClient');

const DATA_DIR = path.join(__dirname, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'user_plans_usage.json');

const memoryWallets = new Map();

function loadUsageData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('[wallet] Failed to load usage data:', err.message);
  }
  return {};
}

function saveUsageData(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[wallet] Failed to save usage data:', err.message);
  }
}

/**
 * Activate or reset plan minutes when user buys a plan
 */
function activateUserPlan(userId, tier = 'starter') {
  if (!userId) userId = 'test_user_wallet';
  let minutes = 100;
  if (tier === 'trial') minutes = 10;
  else if (tier === 'pro') minutes = 110;
  if (tier === 'business') minutes = 500;

  const usage = loadUsageData();
  usage[userId] = {
    planTier: tier,
    planMinutesTotal: minutes,
    planMinutesRemaining: minutes,
    lastActivatedAt: new Date().toISOString(),
  };
  saveUsageData(usage);
  console.log(`[wallet] Activated plan '${tier}' with ${minutes} minutes for ${userId}`);
  return usage[userId];
}

/**
 * Get remaining plan minutes and total minutes for a user
 */
async function getUserMinutes(userId, knownWalletMinutes) {
  if (!userId) userId = 'test_user_wallet';

  let planTier = 'starter';
  let planMinutesTotal = 100;

  if (supabase) {
    try {
      const { data } = await supabase
        .from('user_plans')
        .select('model_id, plan_engine')
        .eq('user_id', userId)
        .maybeSingle();

      if (data) {
        const m = (data.model_id || '').toLowerCase();
        if (m.includes('trial') || m.includes('free')) {
          planTier = 'trial';
          planMinutesTotal = 10;
        } else if (m.includes('3.5') && m.includes('2.5')) {
          planTier = 'business';
          planMinutesTotal = 500;
        } else if (m.includes('3.5') || m.includes('pro') || m.includes('livekit')) {
          planTier = 'pro';
          planMinutesTotal = 110;
        } else {
          planTier = 'starter';
          planMinutesTotal = 100;
        }
      }
    } catch (err) {
      console.warn('[wallet] getUserMinutes plan read error:', err.message);
    }
  }

  const usage = loadUsageData();
  let planRemaining = planMinutesTotal;

  if (usage[userId] && usage[userId].planMinutesRemaining !== undefined) {
    planRemaining = Math.max(0, usage[userId].planMinutesRemaining);
    planMinutesTotal = usage[userId].planMinutesTotal || planMinutesTotal;
    planTier = usage[userId].planTier || planTier;
  } else {
    // Initialize default usage for this user
    usage[userId] = {
      planTier,
      planMinutesTotal,
      planMinutesRemaining: planMinutesTotal,
      lastActivatedAt: new Date().toISOString(),
    };
    saveUsageData(usage);
  }

  const walletMinutes = knownWalletMinutes !== undefined ? knownWalletMinutes : 0;
  const totalMinutes = planRemaining + walletMinutes;

  return {
    userId,
    planTier,
    planMinutesTotal,
    planMinutesRemaining: planRemaining,
    walletMinutes,
    totalMinutes,
    canMakeCall: totalMinutes > 0,
    isLowMinutes: planRemaining === 0 && walletMinutes < 5,
  };
}

/**
 * Get or initialize user wallet
 */
async function getWallet(userId) {
  if (!userId) userId = 'test_user_wallet';

  let balanceCents = 0;

  // 1. Check Supabase
  if (supabase) {
    try {
      let { data, error } = await supabase
        .from('user_wallets')
        .select('id, balance_cents, currency')
        .eq('user_id', userId)
        .maybeSingle();

      if (!error && data) {
        balanceCents = Number(data.balance_cents || 0);
      } else if (!error && !data) {
        // Create initial wallet row with 0 balance
        const { data: created, error: insertErr } = await supabase
          .from('user_wallets')
          .insert({ user_id: userId, balance_cents: 0, currency: 'USD' })
          .select('balance_cents')
          .single();
        if (!insertErr && created) {
          balanceCents = Number(created.balance_cents || 0);
        }
      }
    } catch (err) {
      console.warn('[wallet] Supabase read fallback:', err.message);
    }
  }

  // 2. Check in-memory store
  if (memoryWallets.has(userId)) {
    balanceCents = Math.max(balanceCents, memoryWallets.get(userId));
  }

  // 3. Dynamic balance enforcement

  memoryWallets.set(userId, balanceCents);

  // 4. Update Supabase so database table reflects the correct balance
  if (supabase && balanceCents > 0) {
    try {
      await supabase
        .from('user_wallets')
        .update({ balance_cents: balanceCents, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    } catch (err) {
      console.warn('[wallet] Supabase update error:', err.message);
    }
  }

  const walletMinutes = Math.floor(balanceCents / 10);
  const minutesInfo = await getUserMinutes(userId, walletMinutes);

  return {
    userId,
    balanceCents,
    balanceMinutes: walletMinutes,
    walletMinutes,
    planMinutesRemaining: minutesInfo.planMinutesRemaining,
    planMinutesTotal: minutesInfo.planMinutesTotal,
    planTier: minutesInfo.planTier,
    totalMinutes: minutesInfo.totalMinutes,
    balanceFormatted: `${minutesInfo.totalMinutes} mins`,
    canMakeCall: minutesInfo.totalMinutes > 0,
    isLowMinutes: minutesInfo.isLowMinutes,
    currency: 'USD',
  };
}

/**
 * Credit balance (e.g. from Razorpay Top-up)
 */
async function topUpWallet(userId, amountCents, paymentId, description = 'Wallet Minutes Top-up via Razorpay') {
  if (!userId) userId = 'test_user_wallet';
  const cents = Number(amountCents) || 0;
  if (cents < 600) throw new Error('Minimum wallet top-up is 60 minutes ($6.00)');

  const wallet = await getWallet(userId);
  const newBalance = wallet.balanceCents + cents;
  memoryWallets.set(userId, newBalance);

  if (supabase) {
    try {
      // Check if row exists in user_wallets
      const { data: existing } = await supabase
        .from('user_wallets')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      if (existing) {
        const { error: updErr } = await supabase
          .from('user_wallets')
          .update({ balance_cents: newBalance, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
        if (updErr) console.error('[wallet] Supabase update failed:', updErr.message);
      } else {
        const { error: insErr } = await supabase
          .from('user_wallets')
          .insert({ user_id: userId, balance_cents: newBalance, currency: 'USD' });
        if (insErr) console.error('[wallet] Supabase insert failed:', insErr.message);
      }

      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        amount_cents: cents,
        type: 'topup',
        description,
        payment_id: paymentId,
      });
    } catch (err) {
      console.warn('[wallet] Supabase top-up write exception:', err.message);
    }
  }

  const walletMinutes = Math.floor(newBalance / 10);
  const minutesInfo = await getUserMinutes(userId, walletMinutes);

  return {
    userId,
    balanceCents: newBalance,
    balanceMinutes: walletMinutes,
    walletMinutes,
    planMinutesRemaining: minutesInfo.planMinutesRemaining,
    planMinutesTotal: minutesInfo.planMinutesTotal,
    totalMinutes: minutesInfo.totalMinutes,
    balanceFormatted: `${minutesInfo.totalMinutes} mins`,
  };
}

/**
 * Deduct balance for plan subscription or direct wallet payment
 */
async function deductWallet(userId, amountCents, description) {
  if (!userId) userId = 'test_user_wallet';
  const cents = Number(amountCents) || 0;
  const wallet = await getWallet(userId);

  if (wallet.balanceCents < cents) {
    return {
      success: false,
      error: 'Insufficient wallet balance',
      currentBalance: wallet.balanceFormatted,
    };
  }

  const newBalance = wallet.balanceCents - cents;
  memoryWallets.set(userId, newBalance);

  if (supabase) {
    try {
      await supabase
        .from('user_wallets')
        .update({ balance_cents: newBalance, updated_at: new Date().toISOString() })
        .eq('user_id', userId);

      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        amount_cents: -cents,
        type: 'subscription',
        description,
      });
    } catch (err) {
      console.warn('[wallet] Supabase deduct write fallback:', err.message);
    }
  }

  const walletMinutes = Math.floor(newBalance / 10);
  const minutesInfo = await getUserMinutes(userId, walletMinutes);

  return {
    success: true,
    userId,
    balanceCents: newBalance,
    balanceMinutes: walletMinutes,
    walletMinutes,
    planMinutesRemaining: minutesInfo.planMinutesRemaining,
    planMinutesTotal: minutesInfo.planMinutesTotal,
    totalMinutes: minutesInfo.totalMinutes,
    balanceFormatted: `${minutesInfo.totalMinutes} mins`,
  };
}

/**
 * Deduct Call Minutes when a call ends
 * - Ceiling round up: e.g. 3 min 45 sec (225s) -> 4 minutes, 5 min 30 sec (330s) -> 6 minutes
 * - Uses plan minutes first; if exhausted, uses wallet minutes
 */
async function deductCallMinutes(userId, durationSec) {
  if (!userId) userId = 'test_user_wallet';
  const sec = Math.max(0, Number(durationSec) || 0);

  // Dropped call or under 15s -> no charge
  if (sec < 15) {
    return {
      billed: 0,
      reason: 'duration_too_short',
      durationSec: sec,
    };
  }

  // Ceiling to next whole minute: 3 min 45s (225s) -> 4 mins, 5 min 30s (330s) -> 6 mins
  const minutesBilled = Math.ceil(sec / 60);

  const wallet = await getWallet(userId);
  let planRemaining = wallet.planMinutesRemaining;
  let walletMinutes = wallet.walletMinutes;

  let deductedFromPlan = 0;
  let deductedFromWallet = 0;

  if (planRemaining >= minutesBilled) {
    deductedFromPlan = minutesBilled;
    planRemaining -= minutesBilled;
  } else {
    deductedFromPlan = planRemaining;
    const overflow = minutesBilled - planRemaining;
    planRemaining = 0;
    deductedFromWallet = Math.min(walletMinutes, overflow);
  }

  // Update plan minutes persistence
  const usage = loadUsageData();
  if (!usage[userId]) {
    usage[userId] = {
      planTier: wallet.planTier,
      planMinutesTotal: wallet.planMinutesTotal,
      planMinutesRemaining: wallet.planMinutesTotal,
    };
  }
  usage[userId].planMinutesRemaining = Math.max(0, planRemaining);
  usage[userId].lastUpdated = new Date().toISOString();
  saveUsageData(usage);

  // Deduct overflow from wallet balance
  if (deductedFromWallet > 0) {
    const centsToDeduct = deductedFromWallet * 10;
    await deductWallet(
      userId,
      centsToDeduct,
      `Call overflow: ${deductedFromWallet} mins (${sec}s call, ${minutesBilled} mins total billed)`
    );
  }

  // Record call deduction transaction in Supabase
  if (supabase) {
    try {
      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        amount_cents: -(minutesBilled * 10),
        type: 'call_deduction',
        description: `Call duration ${sec}s (${minutesBilled} mins billed): ${deductedFromPlan} mins from plan, ${deductedFromWallet} mins from wallet`,
      });
    } catch (err) {
      console.warn('[wallet] Error recording call deduction:', err.message);
    }
  }

  const updatedWallet = await getWallet(userId);
  console.log(`[billing] Call completed for ${userId}: ${sec}s -> ${minutesBilled} mins billed (${deductedFromPlan} plan, ${deductedFromWallet} wallet). Remaining: plan=${planRemaining}m, wallet=${updatedWallet.walletMinutes}m, total=${updatedWallet.totalMinutes}m`);

  return {
    success: true,
    durationSec: sec,
    minutesBilled,
    deductedFromPlan,
    deductedFromWallet,
    planMinutesRemaining: planRemaining,
    walletMinutes: updatedWallet.walletMinutes,
    totalMinutes: updatedWallet.totalMinutes,
  };
}

module.exports = {
  getWallet,
  getUserMinutes,
  activateUserPlan,
  topUpWallet,
  deductWallet,
  deductCallMinutes,
  loadUsageData,
};
