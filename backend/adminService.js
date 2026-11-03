/**
 * ShakTalk - Admin & Dynamic Pricing Service
 * Single source of truth for dynamic plans, pricing, discounts, and demo user management.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('./supabaseClient');

const DATA_DIR = path.join(__dirname, 'data');
const PLANS_FILE = path.join(DATA_DIR, 'plans_config.json');
const COUPONS_FILE = path.join(DATA_DIR, 'coupons_config.json');

// Default initial plans configuration
const DEFAULT_PLANS = {
  trial: {
    id: 'trial',
    name: 'Free Trial',
    subtitle: '10 min (one-time trial)',
    modelName: 'Gemini 3.5 Live',
    engine: 'livekit',
    currency: 'INR',
    originalPriceINR: 0,
    priceINR: 0,
    originalPriceUSD: 0,
    priceUSD: 0,
    minutes: 10,
    badge: '10 MINS FREE',
    discountActive: false,
    discountPercentage: 0,
    description: 'Real-Time Live Translation (One-Time Trial)',
    isActive: true,
  },
  starter: {
    id: 'starter',
    name: 'Basic Plan',
    subtitle: 'Turn-by-Turn Translation',
    modelName: 'Gemini 2.5 Live',
    engine: 'legacy',
    currency: 'INR',
    originalPriceINR: 499,
    priceINR: 499,
    originalPriceUSD: 4.99,
    priceUSD: 4.99,
    minutes: 100,
    badge: '',
    discountActive: false,
    discountPercentage: 0,
    description: '100 min/month Turn-by-Turn Translation (Gemini 2.5 Live)',
    isActive: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro Plan',
    subtitle: 'Real-Time Live Translation',
    modelName: 'Gemini 3.5 Live',
    engine: 'livekit',
    currency: 'INR',
    originalPriceINR: 1499,
    priceINR: 1000,
    originalPriceUSD: 19.99,
    priceUSD: 14.99,
    minutes: 110,
    badge: 'SAVE 33%',
    discountActive: true,
    discountPercentage: 33,
    description: '110 min/month Real-Time Simultaneous Live Translation (Gemini 3.5 Live)',
    isActive: true,
  },
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonSafe(file, def) {
  ensureDir();
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.warn(`[adminService] Error reading ${file}:`, err.message);
  }
  return def;
}

function writeJsonSafe(file, data) {
  ensureDir();
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[adminService] Error writing ${file}:`, err.message);
  }
}

// ── Helper: Evaluate Dynamic Discount & Date Validity ───────────────────────
function evaluateDiscount(plan) {
  if (plan.id === 'trial') {
    return { ...plan, isCurrentlyDiscounted: false, effectivePriceINR: 0, effectivePriceUSD: 0 };
  }

  const origINR = Number(plan.originalPriceINR !== undefined ? plan.originalPriceINR : plan.priceINR);
  const origUSD = Number(plan.originalPriceUSD !== undefined ? plan.originalPriceUSD : plan.priceUSD);
  const sellINR = Number(plan.priceINR);
  const sellUSD = Number(plan.priceUSD);

  // If a time-limited promotional schedule is active, verify date range
  if (plan.discountActive) {
    const now = Date.now();
    const start = plan.discountStartDate ? new Date(plan.discountStartDate).getTime() : null;
    const end = plan.discountEndDate ? new Date(plan.discountEndDate).getTime() : null;

    let inRange = true;
    if (start && !isNaN(start) && now < start) inRange = false;
    if (end && !isNaN(end) && now > end) inRange = false;

    if (inRange) {
      return {
        ...plan,
        isCurrentlyDiscounted: true,
        effectivePriceINR: sellINR,
        effectivePriceUSD: sellUSD,
        activeBadge: plan.badge || (origINR > sellINR ? `${Math.round((1 - sellINR / origINR) * 100)}% OFF` : 'SPECIAL DISCOUNT'),
      };
    } else {
      // Promotion expired or not yet started: revert to base/strikethrough price
      return {
        ...plan,
        isCurrentlyDiscounted: false,
        effectivePriceINR: origINR,
        effectivePriceUSD: origUSD,
        activeBadge: '',
      };
    }
  }

  // Standard pricing: Selling Price is always the effective customer price
  const hasStrikethrough = origINR > sellINR && sellINR > 0;
  return {
    ...plan,
    isCurrentlyDiscounted: hasStrikethrough,
    effectivePriceINR: sellINR,
    effectivePriceUSD: sellUSD,
    activeBadge: hasStrikethrough ? (plan.badge || `${Math.round((1 - sellINR / origINR) * 100)}% OFF`) : (plan.badge || ''),
  };
}

// ── Plans Management ────────────────────────────────────────────────────────
async function getPlans(raw = false) {
  let plansObj = {};
  // 1. Try Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('app_plans')
        .select('*');
      if (!error && data && data.length > 0) {
        data.forEach(p => {
          plansObj[p.id] = p;
        });
      }
    } catch (e) {
      // Supabase table fallback
    }
  }

  // 2. Fallback to Local JSON
  if (Object.keys(plansObj).length === 0) {
    let plans = readJsonSafe(PLANS_FILE, null);
    if (!plans || Object.keys(plans).length === 0) {
      plans = DEFAULT_PLANS;
      writeJsonSafe(PLANS_FILE, plans);
    }
    plansObj = plans;
  }

  if (raw) return plansObj;

  // Process effective prices and date validation for clients
  const evaluated = {};
  Object.keys(plansObj).forEach(id => {
    evaluated[id] = evaluateDiscount(plansObj[id]);
  });
  return evaluated;
}

async function updatePlan(planId, updates) {
  const currentPlans = await getPlans();
  if (!currentPlans[planId]) {
    throw new Error(`Plan "${planId}" not found.`);
  }

  const updatedPlan = {
    ...currentPlans[planId],
    ...updates,
    id: planId,
    updatedAt: new Date().toISOString(),
  };

  currentPlans[planId] = updatedPlan;

  // Sync Local
  writeJsonSafe(PLANS_FILE, currentPlans);

  // Sync Supabase if available
  if (supabase) {
    try {
      await supabase.from('app_plans').upsert(updatedPlan, { onConflict: 'id' });
    } catch (e) {
      console.warn('[adminService] Supabase updatePlan fallback:', e.message);
    }
  }

  return updatedPlan;
}

// ── Database-Backed Admin Authentication ──────────────────────────────────────

/**
 * PBKDF2 Password Hashing (Cryptographically Secure)
 */
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

/**
 * Timing-safe password verification
 */
function verifyPassword(password, storedHash, salt) {
  if (!storedHash || !password) return false;
  if (!salt) return false;
  try {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch (err) {
    return false;
  }
}

/**
 * Authenticates admin directly via Supabase `admin_users` table
 */
async function loginAdmin({ identifier, password }) {
  if (!password) {
    return { ok: false, error: 'Password is required' };
  }

  const ident = (identifier || '').trim();
  if (!ident) {
    return { ok: false, error: 'Username or email is required' };
  }

  try {
    // Query directly from Supabase admin_users table
    const { data: users, error } = await supabase
      .from('admin_users')
      .select('*')
      .or(`username.ilike.${ident},email.ilike.${ident}`)
      .eq('is_active', true)
      .limit(1);

    if (error) {
      console.error('[adminService] Supabase admin_users query error:', error.message);
      return { ok: false, error: 'Database authentication service unavailable' };
    }

    if (!users || users.length === 0) {
      return { ok: false, error: 'Invalid admin username or password' };
    }

    const user = users[0];
    const isValid = verifyPassword(password, user.password_hash, user.password_salt);
    if (!isValid) {
      return { ok: false, error: 'Invalid admin username or password' };
    }

    // Generate cryptographically secure session token and persist to database
    const sessionToken = 'shak_adm_' + crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7-day session

    await supabase
      .from('admin_users')
      .update({
        session_token: sessionToken,
        token_expires_at: expiresAt,
        last_login: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    return {
      ok: true,
      token: sessionToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role || 'superadmin',
      },
    };
  } catch (dbErr) {
    console.error('[adminService] Supabase admin_users error:', dbErr.message);
    return { ok: false, error: 'Authentication error' };
  }
}

/**
 * Verifies admin session token directly against active sessions in Supabase
 * Returns database user object if valid, false otherwise.
 */
async function verifyAdmin(authHeader) {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  try {
    const { data: users, error } = await supabase
      .from('admin_users')
      .select('id, username, email, role, token_expires_at, is_active')
      .eq('session_token', token)
      .eq('is_active', true)
      .limit(1);

    if (!error && users && users.length > 0) {
      const u = users[0];
      if (u.token_expires_at && new Date(u.token_expires_at) < new Date()) {
        return false; // Session expired
      }
      return u;
    }
  } catch (err) {
    console.warn('[adminService] Token verification database check warning:', err.message);
  }

  return false;
}

/**
 * Updates admin password in the database
 */
async function changeAdminPassword({ adminUser, oldPassword, newPassword }) {
  if (!newPassword || newPassword.length < 6) {
    return { ok: false, error: 'New password must be at least 6 characters long' };
  }

  if (!adminUser) {
    return { ok: false, error: 'Unauthorized' };
  }

  try {
    // If admin has a DB id
    if (adminUser.id) {
      const { data: user, error: fetchErr } = await supabase
        .from('admin_users')
        .select('*')
        .eq('id', adminUser.id)
        .single();

      if (fetchErr || !user) {
        return { ok: false, error: 'Admin account not found in database' };
      }

      if (oldPassword && !verifyPassword(oldPassword, user.password_hash, user.password_salt)) {
        return { ok: false, error: 'Current password does not match' };
      }

      const { hash, salt } = hashPassword(newPassword);
      const { error: updateErr } = await supabase
        .from('admin_users')
        .update({
          password_hash: hash,
          password_salt: salt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', adminUser.id);

      if (updateErr) throw updateErr;
      return { ok: true, message: 'Password updated successfully in database!' };
    }
  } catch (err) {
    return { ok: false, error: 'Failed to update database password: ' + err.message };
  }

  return { ok: true, message: 'Password accepted (run migration SQL to persist directly in Supabase table).' };
}

// ── Helper: Fetch Clerk Users Map (id -> { email, name }) ───────────────────
async function getClerkUserMap() {
  const map = {};
  if (!process.env.CLERK_SECRET_KEY) return map;
  try {
    const res = await fetch('https://api.clerk.com/v1/users?limit=250', {
      headers: {
        Authorization: 'Bearer ' + process.env.CLERK_SECRET_KEY,
      },
    });
    const users = await res.json();
    if (Array.isArray(users)) {
      users.forEach(u => {
        const primaryEmail = u.email_addresses && u.email_addresses[0] ? u.email_addresses[0].email_address : '';
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
        map[u.id] = { email: primaryEmail, name };
        if (primaryEmail) {
          map[primaryEmail.toLowerCase()] = u.id; // Map email -> user_id for easy lookup
        }
      });
    }
  } catch (err) {
    console.warn('[adminService] Clerk user fetch notice:', err.message);
  }
  return map;
}

// ── Grant User / Demo Account Elevation ──────────────────────────────────────
async function grantUserPlan({ userId, planTier = 'pro', customMinutes = 110, note = 'Admin Grant' }) {
  if (!userId) throw new Error('User ID or Email is required');

  let resolvedId = userId.trim();
  // If admin provided an email, resolve it to Clerk user ID
  if (resolvedId.includes('@')) {
    const clerkMap = await getClerkUserMap();
    if (clerkMap[resolvedId.toLowerCase()]) {
      resolvedId = clerkMap[resolvedId.toLowerCase()];
    }
  }

  const allocatedSeconds = (customMinutes || 110) * 60;
  const periodEnd = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days validity

  const record = {
    user_id: resolvedId,
    plan: planTier,
    plan_seconds_left: allocatedSeconds,
    period_end: periodEnd,
    will_renew: true,
    updated_at: new Date().toISOString(),
  };

  // 1. Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('billing_accounts')
        .upsert(record, { onConflict: 'user_id' })
        .select();
      if (error) console.warn('[adminService] Supabase upsert error:', error.message);
    } catch (e) {
      console.warn('[adminService] Supabase grantUserPlan exception:', e.message);
    }
  }

  // 2. Local fallback
  const BILLING_FILE = path.join(DATA_DIR, 'billing_accounts.json');
  const accounts = readJsonSafe(BILLING_FILE, {});
  accounts[resolvedId] = {
    ...(accounts[resolvedId] || {}),
    ...record,
    admin_note: note,
  };
  writeJsonSafe(BILLING_FILE, accounts);

  return {
    success: true,
    userId: resolvedId,
    plan: planTier,
    minutesGranted: customMinutes,
    validUntil: periodEnd,
  };
}

// ── List Users for Admin ────────────────────────────────────────────────────
async function listUsers() {
  let userList = [];
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('billing_accounts')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (!error && data) userList = data;
    } catch (e) {
      // fallback
    }
  }

  if (userList.length === 0) {
    const BILLING_FILE = path.join(DATA_DIR, 'billing_accounts.json');
    const accounts = readJsonSafe(BILLING_FILE, {});
    userList = Object.values(accounts);
  }

  // Attach Clerk email and name to every account
  const clerkMap = await getClerkUserMap();
  return userList.map(u => ({
    ...u,
    email: (clerkMap[u.user_id] && clerkMap[u.user_id].email) ? clerkMap[u.user_id].email : '—',
    userName: (clerkMap[u.user_id] && clerkMap[u.user_id].name) ? clerkMap[u.user_id].name : '',
  }));
}

module.exports = {
  getPlans,
  updatePlan,
  verifyAdmin,
  loginAdmin,
  changeAdminPassword,
  hashPassword,
  grantUserPlan,
  listUsers,
};

