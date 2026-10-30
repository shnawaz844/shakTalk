/**
 * Wallet Service for ShakTalk
 * Handles user balances, wallet top-ups via Razorpay, and balance deductions.
 */
const { supabase } = require('./supabaseClient');

/**
 * Get or initialize user wallet
 */
async function getWallet(userId) {
  if (!userId) throw new Error('userId is required');

  let { data, error } = await supabase
    .from('user_wallets')
    .select('balance_cents, currency')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[wallet] getWallet error:', error.message);
    throw error;
  }

  if (!data) {
    // Create new wallet with 0 balance
    const { data: newWallet, error: insertErr } = await supabase
      .from('user_wallets')
      .insert({ user_id: userId, balance_cents: 0, currency: 'USD' })
      .select('balance_cents, currency')
      .single();

    if (insertErr) {
      console.error('[wallet] insertWallet error:', insertErr.message);
      throw insertErr;
    }
    data = newWallet;
  }

  return {
    userId,
    balanceCents: Number(data.balance_cents),
    balanceFormatted: `$${(Number(data.balance_cents) / 100).toFixed(2)}`,
    currency: data.currency,
  };
}

/**
 * Credit balance (e.g. from Razorpay Top-up)
 */
async function topUpWallet(userId, amountCents, paymentId, description = 'Wallet Top-up via Razorpay') {
  if (!userId) throw new Error('userId is required');
  if (!amountCents || amountCents <= 0) throw new Error('Invalid top-up amount');

  const wallet = await getWallet(userId);
  const newBalance = wallet.balanceCents + Number(amountCents);

  const { error: updateErr } = await supabase
    .from('user_wallets')
    .update({ balance_cents: newBalance, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  if (updateErr) throw updateErr;

  // Record audit transaction
  await supabase.from('wallet_transactions').insert({
    user_id: userId,
    amount_cents: Number(amountCents),
    type: 'topup',
    description,
    payment_id: paymentId,
  });

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
  if (!userId) throw new Error('userId is required');
  const wallet = await getWallet(userId);

  if (wallet.balanceCents < amountCents) {
    return {
      success: false,
      error: 'Insufficient wallet balance',
      currentBalance: wallet.balanceFormatted,
    };
  }

  const newBalance = wallet.balanceCents - amountCents;

  const { error: updateErr } = await supabase
    .from('user_wallets')
    .update({ balance_cents: newBalance, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  if (updateErr) throw updateErr;

  // Record audit transaction
  await supabase.from('wallet_transactions').insert({
    user_id: userId,
    amount_cents: -Number(amountCents),
    type: 'subscription',
    description,
  });

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

