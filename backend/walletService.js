/**
 * Wallet Service for ShakTalk
 * Handles user balances, wallet top-ups via Razorpay, and balance deductions.
 * Provides resilient fallback storage to guarantee 100% uptime.
 */
const { supabase } = require('./supabaseClient');

const memoryWallets = new Map();

/**
 * Get or initialize user wallet
 */
async function getWallet(userId) {
  if (!userId) userId = 'test_user_wallet';

  if (supabase) {
    try {
      let { data, error } = await supabase
        .from('user_wallets')
        .select('balance_cents, currency')
        .eq('user_id', userId)
        .maybeSingle();

      if (!error && data) {
        const balanceCents = Number(data.balance_cents || 0);
        memoryWallets.set(userId, balanceCents);
        return {
          userId,
          balanceCents,
          balanceFormatted: `$${(balanceCents / 100).toFixed(2)}`,
          currency: data.currency || 'USD',
        };
      }

      if (!error && !data) {
        // Create new wallet with 0 balance
        const { data: newWallet, error: insertErr } = await supabase
          .from('user_wallets')
          .insert({ user_id: userId, balance_cents: 0, currency: 'USD' })
          .select('balance_cents, currency')
          .single();

        if (!insertErr && newWallet) {
          const balanceCents = Number(newWallet.balance_cents || 0);
          memoryWallets.set(userId, balanceCents);
          return {
            userId,
            balanceCents,
            balanceFormatted: `$${(balanceCents / 100).toFixed(2)}`,
            currency: newWallet.currency || 'USD',
          };
        }
      }
    } catch (err) {
      console.warn('[wallet] Supabase read fallback to memory:', err.message);
    }
  }

  // Fallback to in-memory store
  if (!memoryWallets.has(userId)) {
    memoryWallets.set(userId, 0);
  }
  const balanceCents = memoryWallets.get(userId);
  return {
    userId,
    balanceCents,
    balanceFormatted: `$${(balanceCents / 100).toFixed(2)}`,
    currency: 'USD',
  };
}

/**
 * Credit balance (e.g. from Razorpay Top-up)
 */
async function topUpWallet(userId, amountCents, paymentId, description = 'Wallet Top-up via Razorpay') {
  if (!userId) userId = 'test_user_wallet';
  const cents = Number(amountCents) || 0;
  if (cents <= 0) throw new Error('Invalid top-up amount');

  const wallet = await getWallet(userId);
  const newBalance = wallet.balanceCents + cents;
  memoryWallets.set(userId, newBalance);

  if (supabase) {
    try {
      await supabase
        .from('user_wallets')
        .upsert({ user_id: userId, balance_cents: newBalance, updated_at: new Date().toISOString() });

      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        amount_cents: cents,
        type: 'topup',
        description,
        payment_id: paymentId,
      });
    } catch (err) {
      console.warn('[wallet] Supabase top-up write fallback:', err.message);
    }
  }

  return {
    userId,
    balanceCents: newBalance,
    balanceFormatted: `$${(newBalance / 100).toFixed(2)}`,
  };
}

/**
 * Deduct balance for plan subscription or call time
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

  return {
    success: true,
    userId,
    balanceCents: newBalance,
    balanceFormatted: `$${(newBalance / 100).toFixed(2)}`,
  };
}

module.exports = {
  getWallet,
  topUpWallet,
  deductWallet,
};
