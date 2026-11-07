require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { warmupSession, feedAudioChunk, closeSession } = require('./geminiService');
const { supabase } = require('./supabaseClient');
const { uploadAudio } = require('./storageService');
const { APP_NAME } = require('./app-config');
const { serveWebsite, storeButtons, SITE } = require('./website');
const crypto = require('crypto');
const { deleteAccount } = require('./accountService');
const { TranslatorBot, createToken, LIVEKIT_ENABLED, LIVEKIT_URL } = require('./translatorBot');
const { verifyClerkToken, requireUser, bearerToken, isValidUserId, AuthError, AUTH_ENFORCE } = require('./auth');
const { signedUrlFor } = require('./storageService');
const { SUPPORTED_LANGUAGES } = require('./liveTranslate');
const paymentService = require('./paymentService');
const walletService = require('./walletService');
const billingService = require('./billingService');
const adminService = require('./adminService');

const PORT = process.env.PORT || 8080;
const LATEST_ANDROID_APK_URL = process.env.LATEST_ANDROID_APK_URL || 'https://expo.dev/accounts/shahahmad/projects/shak-translate/builds/bb9de5af-858f-4444-948e-8a1a54ca988f';

// The plain WebRTC call (src/hooks/useWebRTCCall.ts) validated that call
// quality/latency is solid without Gemini in the loop. AI translation is
// back on for real: audio_stream_chunk now feeds Gemini as before.
const AI_TRANSLATION_ENABLED = true;
const DEFAULT_CALL_ENGINE = process.env.DEFAULT_CALL_ENGINE || 'legacy';

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.error('[server] CLERK_SECRET_KEY is not set — /clerk/update-profile will not work.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Login tokens are verified in auth.js (signature checked with Clerk).
// The old local verifyClerkToken only decoded the token, so anyone could
// create a token for any user — never decode-only again.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Short join codes ("K7P2QX") that people can type, mapped to the session id.
// No 0/O, 1/I/L: easy to read out over the phone. ~887 million combinations;
// codes live only while the call exists.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SAMPLE_CODES = new Set(['P8FYR6']); // Marketing sample code in how-qr.png must never join real session
const shortCodes = new Map(); // code -> sessionId
function newShortCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!shortCodes.has(code) && !SAMPLE_CODES.has(code)) return code;
  }
  return null;
}
/** Session id from either a full session id or a short code (any case, spaces/dashes ignored). */
function resolveSessionId(input) {
  if (typeof input !== 'string') return null;
  if (UUID_RE.test(input)) return input;
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (SAMPLE_CODES.has(code)) return null;
  return shortCodes.get(code) || null;
}
const MAX_BODY_BYTES = 64 * 1024;

/** Reads a JSON request body, refusing anything larger than MAX_BODY_BYTES. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return; // keep draining, but stop storing: memory stays bounded
      data += chunk;
      if (data.length > MAX_BODY_BYTES) { tooBig = true; data = ''; }
    });
    req.on('end', () => {
      if (tooBig) { reject(Object.assign(new Error('Request body too large.'), { status: 413 })); return; }
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Sends a JSON error. Internal error details stay in the server log, not in the response. */
function sendHttpError(res, err, where) {
  const status = err.status || (err instanceof AuthError ? 401 : 500);
  if (status >= 500) console.error(`[server] ${where} error:`, err.message);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: status >= 500 ? 'Server error.' : err.message }));
}

/**
 * Returns the conversation if `userId` took part in it, otherwise throws 404.
 * (404 rather than 403 so outsiders can't tell which conversation ids exist.)
 * When AUTH_ENFORCE=false and the request had no token (old app builds),
 * userId is null and the check is skipped — rollout mode only.
 */
async function requireConversationMember(convId, userId) {
  if (!UUID_RE.test(convId)) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  const { data: conv, error } = await supabase
    .from('conversations')
    .select('id, host_user_id, guest_user_id')
    .eq('id', convId)
    .maybeSingle();
  if (error) throw error;
  if (!conv) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  if (userId && conv.host_user_id !== userId && conv.guest_user_id !== userId) {
    throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  }
  return conv;
}

/** Caller's verified user id; null only in rollout mode for old app builds without a token. */
async function callerOrLegacy(req) {
  if (bearerToken(req) || AUTH_ENFORCE) return requireUser(req);
  return null;
}

async function updateClerkMetadata(userId, metadata) {
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ public_metadata: metadata }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.errors?.[0]?.message ?? `Metadata update failed (${res.status})`);
  }
  return res.json();
}

// ── HTTP.. Server ───────────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /api/waitlist — iOS waitlist email capture ────────────────────────
  if (req.method === 'POST' && req.url === '/api/waitlist') {
    try {
      const body = await readJsonBody(req);
      const email = (body.email || '').toString().trim().toLowerCase();
      const source = (body.source || 'ios-waitlist').toString().trim().slice(0, 50);
      // Basic email format check
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email required.' }));
        return;
      }

      // Save to Supabase database (primary)
      try {
        await supabase
          .from('waitlist_leads')
          .upsert({ email, source }, { onConflict: 'email' });
      } catch (dbErr) {
        console.warn('[waitlist] Supabase insert note:', dbErr.message);
      }

      // Fallback local file backup
      try {
        const FILE = path.join(__dirname, 'data', 'waitlist.json');
        let list = [];
        try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
        if (!list.some(e => e.email === email)) {
          list.push({ email, source, ts: new Date().toISOString() });
          fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
        }
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: "You're on the list! We'll notify you when ShakTalk launches on iPhone." }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error. Please try again.' }));
    }
    return;
  }

  // ── GET /api/waitlist/export — download waitlist CSV (admin only) ──────────
  if (req.method === 'GET' && req.url === '/api/waitlist/export') {
    try {
      let list = [];
      try {
        const { data } = await supabase.from('waitlist_leads').select('*').order('created_at', { ascending: false });
        if (data && data.length) list = data;
      } catch {}
      if (!list.length) {
        try { list = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'waitlist.json'), 'utf8')); } catch {}
      }
      const csv = 'email,source,timestamp\n' + list.map(e => `${e.email},${e.source},${e.created_at || e.ts}`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="shaktalk-ios-waitlist.csv"' });
      res.end(csv);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not export waitlist.' }));
    }
    return;
  }

  // ── POST /api/pilot — Company & Industry Pilot lead generation ─────────────
  if (req.method === 'POST' && req.url === '/api/pilot') {
    try {
      const body = await readJsonBody(req);
      // Honeypot spam check: if filled by bot, silently return 200 without saving
      if (body.pilot_hp_website) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: "Thanks, we'll contact you within one working day." }));
        return;
      }
      const name = (body.name || '').toString().trim().slice(0, 100);
      const company = (body.company || '').toString().trim().slice(0, 120);
      const country = (body.country || '').toString().trim().slice(0, 80);
      const languagePair = (body.languagePair || '').toString().trim().slice(0, 120);
      const teamSize = (body.teamSize || '1–10').toString().trim().slice(0, 30);
      const contact = (body.contact || '').toString().trim().slice(0, 120);

      if (!name || !company || !contact) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Name, Company, and Contact info (Email or WhatsApp) are required.' }));
        return;
      }

      // Save to Supabase database (primary)
      try {
        await supabase.from('pilot_requests').insert({
          name,
          company,
          country,
          language_pair: languagePair,
          team_size: teamSize,
          contact,
          assigned_to: 'sales@shaktalk.com'
        });
      } catch (dbErr) {
        console.warn('[pilot] Supabase insert note:', dbErr.message);
      }

      // Fallback local file backup
      try {
        const FILE = path.join(__dirname, 'data', 'pilots.json');
        let list = [];
        try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
        list.push({
          name,
          company,
          country,
          languagePair,
          teamSize,
          contact,
          assignedTo: 'sales@shaktalk.com',
          ts: new Date().toISOString()
        });
        fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: "Thanks, we'll contact you within one working day." }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error. Please try again or email sales@shaktalk.com directly.' }));
    }
    return;
  }

  // ── GET /api/pilot/export — download pilot requests CSV (sales only) ────────
  if (req.method === 'GET' && req.url === '/api/pilot/export') {
    try {
      let list = [];
      try {
        const { data } = await supabase.from('pilot_requests').select('*').order('created_at', { ascending: false });
        if (data && data.length) {
          list = data.map(p => ({
            name: p.name,
            company: p.company,
            country: p.country,
            languagePair: p.language_pair,
            teamSize: p.team_size,
            contact: p.contact,
            ts: p.created_at
          }));
        }
      } catch {}
      if (!list.length) {
        try { list = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'pilots.json'), 'utf8')); } catch {}
      }
      const header = 'Name,Company,Country,Language Pair,Team Size,Contact,Timestamp\n';
      const rows = list.map(p => `"${(p.name||'').replace(/"/g, '""')}","${(p.company||'').replace(/"/g, '""')}","${(p.country||'').replace(/"/g, '""')}","${(p.languagePair||'').replace(/"/g, '""')}","${p.teamSize||''}","${(p.contact||'').replace(/"/g, '""')}",${p.ts}`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="shaktalk-pilot-requests.csv"' });
      res.end(header + rows);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not export pilot requests.' }));
    }
    return;
  }

  // ── POST /api/demo — Book a Live Demo lead generation ──────────────────────
  if (req.method === 'POST' && req.url === '/api/demo') {
    try {
      const body = await readJsonBody(req);
      // Honeypot spam check: if filled by bot, silently return 200 without saving
      if (body.demo_hp_website) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: "Thanks, we'll contact you within one working day to confirm your live demo." }));
        return;
      }
      const name = (body.name || '').toString().trim().slice(0, 100);
      const company = (body.company || '').toString().trim().slice(0, 120);
      const country = (body.country || '').toString().trim().slice(0, 80);
      const languagePair = (body.languagePair || '').toString().trim().slice(0, 120);
      const email = (body.email || '').toString().trim().toLowerCase().slice(0, 120);
      const phone = (body.phone || '').toString().trim().slice(0, 60);
      const date1 = (body.date1 || '').toString().trim().slice(0, 30);
      const date2 = (body.date2 || '').toString().trim().slice(0, 30);
      const date3 = (body.date3 || '').toString().trim().slice(0, 30);

      if (!name || !company || !email || !date1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Name, Company, Work Email, and Preferred Demo Date 1 are required.' }));
        return;
      }

      // Basic email validation
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email address required.' }));
        return;
      }

      // Save to Supabase database (primary)
      let savedToDb = false;
      try {
        const { error } = await supabase.from('demo_requests').insert({
          name,
          company,
          country,
          language_pair: languagePair,
          email,
          phone,
          demo_date_1: date1,
          demo_date_2: date2 || null,
          demo_date_3: date3 || null,
          assigned_to: 'sales@shaktalk.com'
        });
        if (!error) savedToDb = true;
        else console.warn('[demo] Supabase insert warning:', error.message);
      } catch (dbErr) {
        console.warn('[demo] Supabase insert note:', dbErr.message);
      }

      // Fallback local file backup
      try {
        const FILE = path.join(__dirname, 'data', 'demos.json');
        let list = [];
        try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
        list.push({
          name,
          company,
          country,
          languagePair,
          email,
          phone,
          demo_date_1: date1,
          demo_date_2: date2,
          demo_date_3: date3,
          savedToDb,
          ts: new Date().toISOString()
        });
        fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: "Thanks! We'll contact you within one working day to confirm your live demo slot." }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error. Please try again or email sales@shaktalk.com directly.' }));
    }
    return;
  }

  // ── GET /api/demo/export — download demo requests CSV (sales only) ──────────
  if (req.method === 'GET' && req.url === '/api/demo/export') {
    try {
      let list = [];
      try {
        const { data } = await supabase.from('demo_requests').select('*').order('created_at', { ascending: false });
        if (data && data.length) {
          list = data.map(d => ({
            name: d.name,
            company: d.company,
            country: d.country,
            languagePair: d.language_pair,
            email: d.email,
            phone: d.phone,
            date1: d.demo_date_1,
            date2: d.demo_date_2,
            date3: d.demo_date_3,
            ts: d.created_at
          }));
        }
      } catch {}
      if (!list.length) {
        try { list = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'demos.json'), 'utf8')); } catch {}
      }
      const header = 'Name,Company,Country,Language Pair,Email,Phone,Date 1,Date 2,Date 3,Timestamp\n';
      const rows = list.map(d => `"${(d.name||'').replace(/"/g, '""')}","${(d.company||'').replace(/"/g, '""')}","${(d.country||'').replace(/"/g, '""')}","${(d.languagePair||'').replace(/"/g, '""')}","${(d.email||'').replace(/"/g, '""')}","${(d.phone||'').replace(/"/g, '""')}","${d.date1||d.demo_date_1||''}","${d.date2||d.demo_date_2||''}","${d.date3||d.demo_date_3||''}",${d.ts}`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="shaktalk-demo-requests.csv"' });
      res.end(header + rows);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not export demo requests.' }));
    }
    return;
  }

  // ── POST /clerk/update-profile ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/clerk/update-profile') {
    try {
      if (!CLERK_SECRET_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CLERK_SECRET_KEY not configured on server.' }));
        return;
      }
      const body = await readJsonBody(req);
      const { age, gender } = body;
      const ageNum = Number(age);
      if (!Number.isFinite(ageNum) || ageNum < 1 || ageNum > 120 || typeof gender !== 'string' || gender.length > 20) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'age and gender are required.' }));
        return;
      }
      // Signature-verified: the user id comes from Clerk, not from the request.
      const userId = await verifyClerkToken(bearerToken(req));
      await updateClerkMetadata(userId, { age: ageNum, gender, onboardingComplete: true });
      console.log(`[server] Updated Clerk metadata for user ${userId}: age=${ageNum}, gender=${gender}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      sendHttpError(res, err, '/clerk/update-profile');
    }
    return;
  }

  // ── POST /user/consent ─────────────────────────────────────────────────────
  // Records that the signed-in user accepted the Terms/Privacy version shown in
  // the app. Stored in Clerk publicMetadata with the SERVER's time, which the
  // user cannot edit (the app's own copy in unsafeMetadata can be).
  if (req.method === 'POST' && req.url === '/user/consent') {
    try {
      const userId = await verifyClerkToken(bearerToken(req)); // strict: no fallback
      const body = await readJsonBody(req);
      const version = typeof body.version === 'string' ? body.version.slice(0, 32) : '';
      if (!version) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'version is required.' })); return; }
      const record = {
        version,
        acceptedAt: new Date().toISOString(),
        platform: typeof body.platform === 'string' ? body.platform.slice(0, 16) : undefined,
        source: typeof body.source === 'string' ? body.source.slice(0, 32) : undefined,
      };
      if (CLERK_SECRET_KEY) await updateClerkMetadata(userId, { consent: record });
      console.log(`[consent] ${userId} accepted terms ${version} (${record.source || 'app'}, ${record.platform || '?'})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      sendHttpError(res, err, '/user/consent');
    }
    return;
  }

  // ── DELETE /account (or POST /account/delete) ──────────────────────────────
  // Deletes the signed-in user's account and data (see accountService.js).
  if ((req.method === 'DELETE' && req.url === '/account') || (req.method === 'POST' && req.url === '/account/delete')) {
    try {
      const userId = await verifyClerkToken(bearerToken(req)); // strict: never the legacy userId fallback
      const result = await deleteAccount(userId);
      res.writeHead(result.errors.length ? 207 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !result.errors.length, ...result }));
    } catch (err) {
      sendHttpError(res, err, '/account');
    }
    return;
  }

  // ── POST /user/set-plan ────────────────────────────────────────────────────
  // Upserts the AI translation plan the user chose before login.
  // Body: { engine: 'legacy'|'livekit', modelId: string }
  // Header: Authorization: Bearer <clerk_token>
  if (req.method === 'POST' && req.url === '/user/set-plan') {
    try {
      const body = await readJsonBody(req);
      const { engine, modelId, tier } = body;
      if (!['legacy', 'livekit'].includes(engine) || typeof modelId !== 'string' || !modelId || modelId.length > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'engine and modelId are required.' }));
        return;
      }
      // Signature-verified: the user id comes from Clerk, not from the request.
      const userId = await verifyClerkToken(bearerToken(req));
      const { error } = await supabase
        .from('user_plans')
        .upsert(
          {
            user_id: userId,
            plan_engine: engine,
            model_id: modelId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );
      if (error) throw error;
      // Also sync to billingService and walletService
      try {
        const isTrial = tier === 'trial';
        const isPro = tier === 'pro' || (engine === 'livekit' && !isTrial);
        const planTier = isTrial ? 'trial' : (isPro ? 'pro' : 'standard');
        await billingService.activateSubscription({
          userId,
          planTier,
          amountCents: isTrial ? 0 : (isPro ? 1000 : 499),
        });
        walletService.activateUserPlan(userId, planTier);
      } catch (syncErr) {
        console.warn('[user/set-plan] Billing sync notice:', syncErr.message);
      }

      console.log(`[server] Saved plan for user ${userId}: engine=${engine}, model=${modelId}, tier=${tier || 'default'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      sendHttpError(res, err, '/user/set-plan');
    }
    return;
  }

  // ── USER ACCOUNT & PLAN RESTORATION ──────────────────────────────────────────
  // GET /user/account-state
  // Checks Supabase for the user's existing subscription, remaining plan minutes,
  // and wallet balance. Used upon login to restore purchased plans and credits.
  if (req.method === 'GET' && req.url === '/user/account-state') {
    try {
      const token = bearerToken(req);
      const userId = await verifyClerkToken(token);
      if (!userId) throw new AuthError('Authentication required');

      // 1. Fetch Plan from user_plans in Supabase
      let planRecord = null;
      if (supabase) {
        const { data } = await supabase
          .from('user_plans')
          .select('plan_engine, model_id, updated_at')
          .eq('user_id', userId)
          .maybeSingle();
        planRecord = data;
      }

      // 2. Fetch Wallet & Minutes Info from walletService
      const wallet = await walletService.getWallet(userId);

      const usage = walletService.loadUsageData ? walletService.loadUsageData() : null;
      const userUsage = usage && usage[userId];
      const hasPurchasedPlan = !!planRecord || !!(userUsage && userUsage.planTier);
      const planTier = wallet.planTier || 'starter';
      const planEngine = planRecord?.plan_engine || (planTier === 'starter' ? 'legacy' : 'livekit');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        userId,
        hasPurchasedPlan,
        planTier,
        planEngine,
        modelId: planRecord?.model_id || 'gemini-live-2.5-flash-native-audio',
        planMinutesRemaining: wallet.planMinutesRemaining,
        planMinutesTotal: wallet.planMinutesTotal,
        walletMinutes: wallet.walletMinutes,
        totalMinutes: wallet.totalMinutes,
        canMakeCall: wallet.canMakeCall,
        currency: 'USD',
      }));
    } catch (err) {
      sendHttpError(res, err, '/user/account-state');
    }
    return;
  }

  // ── GET /billing/me ────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url?.startsWith('/billing/me')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const deviceId = u.searchParams.get('deviceId') || null;
      let userId = u.searchParams.get('userId') || null;
      try {
        const token = bearerToken(req);
        if (token) {
          const verified = await verifyClerkToken(token);
          if (verified) userId = verified;
        }
      } catch (_) {}

      if (!userId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Authentication required' }));
        return;
      }

      const billing = await billingService.getAvailableMinutes(userId, deviceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...billing }));
    } catch (err) {
      sendHttpError(res, err, '/billing/me');
    }
    return;
  }

  // ── POST /billing/revenuecat-webhook ───────────────────────────────────────
  if (req.method === 'POST' && req.url === '/billing/revenuecat-webhook') {
    try {
      const secret = process.env.REVENUECAT_WEBHOOK_SECRET || 'shaktalk_rc_wh_sec_2026';
      const authHeader = req.headers['authorization'] || '';
      const secretHeader = req.headers['x-revenuecat-webhook-secret'] || '';
      const providedToken = authHeader.replace(/^Bearer\s+/i, '').trim();

      if (secret && providedToken !== secret && secretHeader !== secret) {
        console.warn('[billing] Unauthorized RevenueCat webhook attempt');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized webhook secret' }));
        return;
      }

      const body = await readJsonBody(req);
      const event = body?.event || body;
      const result = await billingService.applyRevenueCatEvent(event);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      console.error('[billing] RevenueCat webhook error:', err);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ── RAZORPAY PAYMENT ENDPOINTS ───────────────────────────────
  // ── WALLET ENDPOINTS ───────────────────────────────────────────────────────
  // GET /wallet/balance
  if (req.method === 'GET' && req.url?.startsWith('/wallet/balance')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      let userId = u.searchParams.get('userId') || null;
      try {
        const token = bearerToken(req);
        if (token) {
          const verified = await verifyClerkToken(token);
          if (verified) userId = verified;
        }
      } catch (_) {}

      const targetUser = userId || 'test_user_wallet';
      const wallet = await walletService.getWallet(targetUser);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...wallet }));
    } catch (err) {
      sendHttpError(res, err, '/wallet/balance');
    }
    return;
  }

  // POST /wallet/pay-with-wallet
  // Allows paying for a plan using available wallet balance
  if (req.method === 'POST' && req.url === '/wallet/pay-with-wallet') {
    try {
      const userId = await verifyClerkToken(bearerToken(req));
      const body = await readJsonBody(req);
      const { tier } = body || {};
      const plan = paymentService.PLANS[tier] || paymentService.PLANS.pro;

      const deduction = await walletService.deductWallet(
        userId,
        plan.amountCents,
        `Subscribed to ${plan.name} via Wallet Balance`
      );

      if (!deduction.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: deduction.error, currentBalance: deduction.currentBalance }));
        return;
      }

      await supabase.from('user_plans').upsert(
        {
          user_id: userId,
          plan_engine: plan.engine,
          model_id: plan.modelName,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

      walletService.activateUserPlan(userId, tier || 'starter');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan: plan.name, newBalance: deduction.balanceFormatted }));
    } catch (err) {
      sendHttpError(res, err, '/wallet/pay-with-wallet');
    }
    return;
  }

  // ── DYNAMIC PRICING & ADMIN API ───────────────────────────────────────────
  // GET /api/plans (Public - cached client pricing & active discounts)
  if (req.method === 'GET' && (req.url === '/api/plans' || req.url === '/payment/plans')) {
    try {
      const plans = await adminService.getPlans();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=15',
      });
      res.end(JSON.stringify({ ok: true, plans }));
    } catch (err) {
      sendHttpError(res, err, '/api/plans');
    }
    return;
  }

  // POST /api/admin/login
  if (req.method === 'POST' && req.url === '/api/admin/login') {
    try {
      const body = await readJsonBody(req);
      const { identifier, username, email, password } = body || {};
      const loginRes = await adminService.loginAdmin({ identifier: identifier || username || email, password });
      if (loginRes.ok) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(loginRes));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: loginRes.error || 'Invalid admin credentials' }));
      }
    } catch (err) {
      sendHttpError(res, err, '/api/admin/login');
    }
    return;
  }

  // POST /api/admin/change-password
  if (req.method === 'POST' && req.url === '/api/admin/change-password') {
    try {
      const auth = req.headers['authorization'];
      const adminUser = await adminService.verifyAdmin(auth);
      if (!adminUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const body = await readJsonBody(req);
      const { oldPassword, newPassword } = body || {};
      const result = await adminService.changeAdminPassword({ adminUser, oldPassword, newPassword });
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      sendHttpError(res, err, '/api/admin/change-password');
    }
    return;
  }

  // GET /api/admin/plans (Admin only)
  if (req.method === 'GET' && req.url === '/api/admin/plans') {
    try {
      const auth = req.headers['authorization'];
      if (!await adminService.verifyAdmin(auth)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const plans = await adminService.getPlans();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, plans }));
    } catch (err) {
      sendHttpError(res, err, '/api/admin/plans');
    }
    return;
  }

  // PUT /api/admin/plans (Admin update plan pricing/discounts)
  if (req.method === 'PUT' && req.url?.startsWith('/api/admin/plans')) {
    try {
      const auth = req.headers['authorization'];
      if (!await adminService.verifyAdmin(auth)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const parts = req.url.split('/');
      const planId = parts[parts.length - 1];
      const body = await readJsonBody(req);
      const updated = await adminService.updatePlan(planId, body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, plan: updated }));
    } catch (err) {
      sendHttpError(res, err, '/api/admin/plans');
    }
    return;
  }

  // POST /api/admin/grant-user (Elevate user / demo account to Pro with custom minutes)
  if (req.method === 'POST' && req.url === '/api/admin/grant-user') {
    try {
      const auth = req.headers['authorization'];
      if (!await adminService.verifyAdmin(auth)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const body = await readJsonBody(req);
      const result = await adminService.grantUserPlan(body || {});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      sendHttpError(res, err, '/api/admin/grant-user');
    }
    return;
  }

  // GET /api/admin/users (List accounts & remaining minutes)
  if (req.method === 'GET' && req.url === '/api/admin/users') {
    try {
      const auth = req.headers['authorization'];
      if (!await adminService.verifyAdmin(auth)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const users = await adminService.listUsers();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, users }));
    } catch (err) {
      sendHttpError(res, err, '/api/admin/users');
    }
    return;
  }

  // GET /admin (Serve the executive Admin Dashboard UI)
  const reqPath = req.url ? req.url.split('?')[0] : '';
  if (req.method === 'GET' && (reqPath === '/admin' || reqPath === '/admin/')) {
    try {
      const adminHtmlPath = path.join(__dirname, 'public', 'admin.html');
      if (fs.existsSync(adminHtmlPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(adminHtmlPath, 'utf8'));
        return;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('admin.html not found');
        return;
      }
    } catch (err) {
      sendHttpError(res, err, '/admin');
      return;
    }
  }

  // POST /payment/create-order (Supports plan or wallet topup)
  if (req.method === 'POST' && req.url === '/payment/create-order') {
    try {
      const body = await readJsonBody(req);
      const { tier, email, type, amountCents, currency } = body || {};
      let userId = null;
      try {
        const token = bearerToken(req);
        if (token) userId = await verifyClerkToken(token);
      } catch (_) {}

      const order = await paymentService.createOrder({ tier, amountCents, email, userId, type: type || 'plan', currency });
      const host = req.headers.host || 'www.shaktalk.com';
      const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
      const checkoutUrl = `${proto}://${host}/payment/checkout?order_id=${order.orderId}&tier=${order.tier}&type=${order.type || 'plan'}&amount_cents=${order.amount}`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...order, checkoutUrl }));
    } catch (err) {
      sendHttpError(res, err, '/payment/create-order');
    }
    return;
  }

  // GET /payment/checkout
  if (req.method === 'GET' && req.url?.startsWith('/payment/checkout')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const orderId = u.searchParams.get('order_id');
      const tier = u.searchParams.get('tier') || 'pro';
      const type = u.searchParams.get('type') || 'plan';
      const amountCents = u.searchParams.get('amount_cents') || 1499;
      const email = u.searchParams.get('email') || 'aabir.hussain1@gmail.com';
      const currency = u.searchParams.get('currency') || 'USD';
      if (!orderId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('order_id is required');
        return;
      }
      const returnScheme = u.searchParams.get('return_scheme') || 'shaktalk';
      const html = paymentService.renderCheckoutHtml({ orderId, tier, amountCents, email, type, returnScheme, currency });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      sendHttpError(res, err, '/payment/checkout');
    }
    return;
  }

  // POST /payment/verify
  if (req.method === 'POST' && req.url === '/payment/verify') {
    try {
      const body = await readJsonBody(req);
      const { orderId, paymentId, signature, tier, type, amountCents } = body || {};
      const isValid = paymentService.verifyPaymentSignature({ orderId, paymentId, signature });
      if (!isValid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid payment signature' }));
        return;
      }

      console.log(`[payment] Verified payment ${paymentId} for order ${orderId} (Type: ${type}, Tier: ${tier})`);

      let userId = body.userId || null;
      try {
        const token = bearerToken(req);
        if (token) {
          const verified = await verifyClerkToken(token);
          if (verified) userId = verified;
        }
      } catch (_) {}

      // Handle Wallet Top-up
      if (type === 'wallet_topup') {
        const targetUser = userId || 'test_user_wallet';
        const updated = await walletService.topUpWallet(targetUser, amountCents, paymentId);

        // Add 12-month minute pack to billing service & database
        try {
          const account = await billingService.getOrCreateAccount(targetUser);
          const packEngine = billingService.getEngineForPlan(account.plan);
          await billingService.addMinutePack(targetUser, packEngine, paymentId);
          await billingService.recordPaymentTransaction({
            userId: targetUser,
            amountCents,
            type: 'wallet_topup',
            description: `Wallet Top-up (+${billingService.TOPUP_MINUTES} mins)`,
            orderId,
            paymentId,
          });
        } catch (packErr) {
          console.warn('[payment] Minute pack record warning:', packErr.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          status: 'verified',
          type: 'wallet_topup',
          newBalance: updated.balanceFormatted,
          balanceCents: updated.balanceCents,
        }));
        return;
      }

      // Handle Plan Subscription
      let subReceipt = null;
      if (userId) {
        const plan = paymentService.PLANS[tier] || paymentService.PLANS.pro;
        await supabase.from('user_plans').upsert(
          {
            user_id: userId,
            plan_engine: plan.engine,
            model_id: plan.modelName,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );
        walletService.activateUserPlan(userId, tier || 'starter');

        // Full billing account update & receipt logging
        try {
          subReceipt = await billingService.activateSubscription({
            userId,
            planTier: tier,
            paymentId,
            orderId,
            amountCents,
            email: body.email,
          });

          await billingService.recordPaymentTransaction({
            userId,
            amountCents,
            type: 'plan_subscription',
            description: `Subscription Plan: ${tier || 'pro'}`,
            orderId,
            paymentId,
          });

          if (CLERK_SECRET_KEY) {
            await updateClerkMetadata(userId, {
              plan: tier,
              planActive: true,
              periodEnd: subReceipt?.periodEnd,
              updatedAt: new Date().toISOString(),
            }).catch(e => console.warn('[payment] Clerk metadata sync skipped:', e.message));
          }
        } catch (bErr) {
          console.warn('[payment] Billing service subscription activation warning:', bErr.message);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'verified', paymentId, tier, receipt: subReceipt }));
    } catch (err) {
      sendHttpError(res, err, '/payment/verify');
    }
    return;
  }



  // POST /billing/cancel-autopay
  if (req.method === 'POST' && req.url === '/billing/cancel-autopay') {
    try {
      let userId = null;
      try {
        const token = bearerToken(req);
        if (token) userId = await verifyClerkToken(token);
      } catch (_) {}
      if (!userId) {
        const body = await readJsonBody(req);
        userId = body?.userId;
      }
      if (!userId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const result = await billingService.setAutopayStatus(userId, false);
      if (CLERK_SECRET_KEY) {
        await updateClerkMetadata(userId, { willRenew: false, autopayEnabled: false }).catch(() => {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      sendHttpError(res, err, '/billing/cancel-autopay');
    }
    return;
  }

  if (req.method === 'GET' && req.url?.match(/^\/conversations(\?.*)?$/)) {
    try {
      const url = new URL(req.url, `http://localhost`);
      // Who is asking comes from the verified login token. The ?userId= query
      // parameter is only used in rollout mode (AUTH_ENFORCE=false) for old
      // app builds, and only if it is a well-formed Clerk id: it is pasted
      // into the database filter below, so anything else is rejected (this
      // used to allow "?userId=x,host_user_id.neq.x" to list everyone's calls).
      const userId = await requireUser(req, url.searchParams.get('userId'));
      if (!isValidUserId(userId)) throw new AuthError('Login required.');

      const { data: conversations, error } = await supabase
        .from('conversations')
        .select(`
          id, session_id, host_user_id, guest_user_id, host_lang, guest_lang, started_at, ended_at,
          messages(id, sender_user_id, role, original_text, translated_text, sent_at)
        `)
        .or(`host_user_id.eq.${userId},guest_user_id.eq.${userId}`)
        .order('started_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      const result = (conversations || [])
        .filter(conv => conv.messages && conv.messages.length > 0)
        .map(conv => {
          const msgs = (conv.messages || []).sort((a, b) =>
            new Date(a.sent_at) - new Date(b.sent_at)
          );
          const lastMsg = msgs[msgs.length - 1] || null;
          const partnerRole = conv.host_user_id === userId ? 'guest' : 'host';
          const partnerLang = partnerRole === 'guest' ? conv.guest_lang : conv.host_lang;
          const myLang = partnerRole === 'guest' ? conv.host_lang : conv.guest_lang;
          return {
            id: conv.id,
            sessionId: conv.session_id,
            myLang,
            partnerLang,
            startedAt: conv.started_at,
            endedAt: conv.ended_at,
            lastMessage: lastMsg ? {
              text: lastMsg.sender_user_id === userId ? lastMsg.original_text : lastMsg.translated_text,
              sentAt: lastMsg.sent_at,
              isMe: lastMsg.sender_user_id === userId,
            } : null,
            messageCount: msgs.length,
          };
        });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      sendHttpError(res, err, '/conversations');
    }
    return;
  }

  // ── GET /conversations/:id/messages ───────────────────────────────────────
  if (req.method === 'GET' && /^\/conversations\/[^/]+\/messages$/.test(req.url)) {
    try {
      const convId = decodeURIComponent(req.url.split('/')[2]);
      // Only people who were on this call may read it.
      await requireConversationMember(convId, await callerOrLegacy(req));
      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_user_id, role, original_text, translated_text, sent_at')
        .eq('conversation_id', convId)
        .order('sent_at', { ascending: true });

      if (error) throw error;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages || []));
    } catch (err) {
      sendHttpError(res, err, '/conversations/:id/messages');
    }
    return;
  }

  // ── GET /conversations/:id/recordings ─────────────────────────────────────
  if (req.method === 'GET' && /^\/conversations\/[^/]+\/recordings$/.test(req.url)) {
    try {
      const convId = decodeURIComponent(req.url.split('/')[2]);
      await requireConversationMember(convId, await callerOrLegacy(req));
      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, sender_user_id, role, original_text, translated_text, original_audio_url, translated_audio_url, original_audio_offset_ms, sent_at')
        .eq('conversation_id', convId)
        .order('sent_at', { ascending: true });

      if (error) throw error;
      // Recordings are served as short-lived signed links (1 hour), so the
      // storage bucket can be private. Works for old rows that stored a public URL too.
      const signed = await Promise.all((messages || []).map(async (m) => ({
        ...m,
        original_audio_url: await signedUrlFor(m.original_audio_url),
        translated_audio_url: await signedUrlFor(m.translated_audio_url),
      })));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(signed));
    } catch (err) {
      sendHttpError(res, err, '/conversations/:id/recordings');
    }
    return;
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); res.end('OK'); return; }

  // ── GET /gemini-test ───────────────────────────────────────────────────────
  // Quick connectivity check: tries to open a Gemini Live session and
  // immediately closes it, reporting success or the exact error.
  if (req.method === 'GET' && (req.url === '/gemini-test' || req.url.startsWith('/gemini-test?'))) {
    // Opens a paid Gemini session, so when DIAGNOSTICS_KEY is set it requires
    // /gemini-test?key=<DIAGNOSTICS_KEY>.
    const diagKey = process.env.DIAGNOSTICS_KEY;
    if (diagKey && new URL(req.url, 'http://localhost').searchParams.get('key') !== diagKey) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const { warmupSession, closeSession } = require('./geminiService');
    const testId = 'health-check-' + Date.now();
    try {
      await warmupSession(testId, 'host', 'English', 'Hindi', {}, {
        onAudioChunk: () => { },
        onTurnComplete: () => { },
        onInterrupted: () => { },
        onError: (e) => { console.error('[gemini-test] Error:', e.message); },
      });
      closeSession(testId, 'host');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Gemini Live connection successful' }));
    } catch (err) {
      console.error('[gemini-test] Failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ── GET /apk or /download/apk ───────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/apk' || req.url === '/download/apk')) {
    res.writeHead(302, { Location: LATEST_ANDROID_APK_URL });
    res.end();
    return;
  }

  // ── GET /join/:sessionId ───────────────────────────────────────────────────
  if (req.method === 'GET' && /^\/join\/[^/]+$/.test(req.url)) {
    const sessionId = req.url.split('/')[2];
    // The id is written into the HTML page below, so only accept a real
    // session id (UUID). Anything else could inject markup into the page.
    if (!UUID_RE.test(sessionId)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Join ${APP_NAME} Call</title>
  <meta name="description" content="Tap to join a live-translated call: you each speak your own language.">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${APP_NAME}">
  <meta property="og:title" content="Join my ${APP_NAME} call">
  <meta property="og:description" content="Tap to join. We each speak our own language and ${APP_NAME} translates live.">
  <meta property="og:image" content="${SITE.SITE_URL}/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="robots" content="noindex">
  <style>
    * { box-sizing: border-box; }
    body {
      background: #0A0D0C;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px 16px;
      text-align: center;
    }
    .card {
      background: #141917;
      border: 1px solid rgba(47, 224, 168, 0.25);
      border-radius: 24px;
      padding: 36px 24px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 16px 40px rgba(0,0,0,0.6);
    }
    .badge {
      display: inline-block;
      background: rgba(47, 224, 168, 0.12);
      color: #2FE0A8;
      border: 1px solid rgba(47, 224, 168, 0.3);
      font-size: 12px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 999px;
      margin-bottom: 16px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    h1 {
      color: #fff;
      font-size: 24px;
      margin: 0 0 8px 0;
      font-weight: 800;
    }
    h1 span { color: #2FE0A8; }
    #statusText {
      color: #9BA8A4;
      font-size: 15px;
      margin: 0 0 24px 0;
      line-height: 1.5;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-weight: 700;
      font-size: 16px;
      padding: 16px 20px;
      border-radius: 14px;
      text-decoration: none;
      width: 100%;
      margin-bottom: 12px;
      transition: all 0.2s ease;
      cursor: pointer;
    }
    .btn-primary {
      background: #2FE0A8;
      color: #0A0D0C;
      border: none;
    }
    .btn-primary:active { transform: scale(0.98); }
    .btn-secondary {
      background: #1C2421;
      color: #2FE0A8;
      border: 1px solid rgba(47, 224, 168, 0.4);
    }
    .divider {
      height: 1px;
      background: rgba(255,255,255,0.08);
      margin: 20px 0;
    }
    .session-box {
      background: #0D1210;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .session-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #7C8985;
      font-size: 12px;
      word-break: break-all;
      text-align: left;
    }
    .copy-btn {
      background: #24302C;
      color: #E2ECE8;
      border: none;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .store-row { display: flex; flex-direction: column; gap: 10px; margin-bottom: 4px; }
    .store-btn { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 11px 16px; border-radius: 14px; background: #fff; color: #0A0D0C; text-decoration: none; text-align: left; }
    .store-btn svg { width: 24px; height: 24px; flex: none; }
    .store-btn small { display: block; font-size: 11px; opacity: .75; }
    .store-btn strong { display: block; font-size: 16px; }
    .store-btn.soon { background: transparent; color: #9BA8A4; border: 1px solid rgba(255,255,255,.12); }
    .home-link { display: block; margin-top: 18px; color: #2FE0A8; font-size: 13px; text-decoration: none; }
    .instructions {
      color: #63726E;
      font-size: 13px;
      margin-top: 16px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🌐 Live Call Invite</div>
    <h1>Join <span>${APP_NAME}</span></h1>
    <p id="statusText">Opening your live translation call…</p>
    
    <a href="shaktalk://join/${sessionId}" id="openAppBtn" class="btn btn-primary">
      <span>📞</span> Open Call in ${APP_NAME}
    </a>

    <div id="downloadSection" style="display:none;">
      <p style="color:#9BA8A4;font-size:14px;margin:0 0 14px;">Install <strong style="color:#fff;">${APP_NAME}</strong>, then tap the invite link again.</p>
      ${storeButtons()}
    </div>

    <div class="divider"></div>

    <div class="session-box">
      <div class="session-code" id="codeText">${sessionId}</div>
      <button class="copy-btn" id="copyBtn" onclick="copySessionCode()">Copy Code</button>
    </div>
    
    <div class="instructions">
      If you just installed the app, open it & tap <strong>"Enter code"</strong> or scan the host's QR code.
    </div>
    <a class="home-link" href="/">What is ${APP_NAME}?</a>
  </div>

  <script>
    var sessionId = "${sessionId}";

    function copySessionCode() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(sessionId).then(function() {
          var btn = document.getElementById("copyBtn");
          btn.innerText = "Copied! ✓";
          btn.style.color = "#2FE0A8";
          setTimeout(function() { btn.innerText = "Copy Code"; btn.style.color = "#E2ECE8"; }, 2000);
        });
      }
    }

    // Attempt to open native app
    window.location.href = "shaktalk://join/" + sessionId;
    setTimeout(function() {
      window.location.href = "shaktranslate://join/" + sessionId;
    }, 400);

    // Check if app opened
    var appOpened = false;
    document.addEventListener("visibilitychange", function() {
      if (document.hidden) appOpened = true;
    });
    window.addEventListener("blur", function() {
      appOpened = true;
    });

    // If app didn't open after 2 seconds
    setTimeout(function() {
      if (!appOpened && !document.hidden) {
        var statusEl = document.getElementById("statusText");
        if (statusEl) {
          statusEl.innerHTML = "Don't have <strong>${APP_NAME}</strong> installed yet?";
        }
        var dlSection = document.getElementById("downloadSection");
        if (dlSection) {
          dlSection.style.display = "block";
        }
      }
    }, 2000);
  </script>
</body>
</html>`);
    return;
  }

  // Public website: landing page, privacy, terms, support, app-link files.
  if (serveWebsite(req, res)) return;

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

// maxPayload: the biggest real message is a ~150ms audio chunk (~7 KB base64).
// Without a limit, ws accepts messages up to 100 MB, which can exhaust memory.
const wss = new WebSocketServer({ server: httpServer, maxPayload: 512 * 1024 });

/**
 * ARCHITECTURE: Continuous streaming, not per-sentence request/response.
 *
 * Each role has a persistent Gemini Live session (see geminiService.js) that
 * stays open for the whole call. Audio the client streams in via
 * audio_stream_chunk is forwarded to Gemini immediately; Gemini's own
 * automaticActivityDetection decides turn boundaries; translated audio is
 * streamed back to the partner chunk-by-chunk as it's generated instead of
 * being buffered until the whole reply is done.
 *
 * `paused` still supports barge-in: when a listener starts talking over
 * the partner's playback, the client asks the server to stop *delivering*
 * that partner's in-flight translation (Gemini keeps generating — we just
 * don't forward it) until the listener releases the floor again.
 */

const sessions = new Map();

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function getPartnerSocket(session, role) {
  return role === 'host' ? session.guest : session.host;
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

// sessionId → conversations.id, so saving each transcript line is one query
// (insert) instead of two (look up the conversation, then insert).
const conversationIds = new Map();

async function dbCreateConversation(sessionId, hostUserId, hostLang) {
  const { data, error } = await supabase.from('conversations').insert({
    session_id: sessionId,
    host_user_id: hostUserId,
    host_lang: hostLang,
  }).select('id').single();
  if (error) console.error('[db] createConversation error:', error.message);
  else if (data) conversationIds.set(sessionId, data.id);
}

async function dbUpdateConversationGuest(sessionId, guestUserId, guestLang) {
  const { error } = await supabase.from('conversations')
    .update({ guest_user_id: guestUserId, guest_lang: guestLang })
    .eq('session_id', sessionId);
  if (error) console.error('[db] updateConversationGuest error:', error.message);
}

async function dbEndConversation(sessionId) {
  const { error } = await supabase.from('conversations')
    .update({ ended_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  if (error) console.error('[db] endConversation error:', error.message);
}

async function dbInsertMessage(sessionId, senderUserId, role, originalText, translatedText, originalAudioUrl, translatedAudioUrl) {
  if (!originalText && !translatedText) {
    console.log('[db] Skipping insertMessage: both originalText and translatedText are empty');
    return;
  }

  let convId = conversationIds.get(sessionId);
  if (!convId) {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (!conv) return;
    convId = conv.id;
    conversationIds.set(sessionId, convId);
  }

  const { error } = await supabase.from('messages').insert({
    conversation_id: convId,
    sender_user_id: senderUserId,
    role,
    original_text: originalText || '',
    translated_text: translatedText || '',
    original_audio_url: originalAudioUrl || null,
    translated_audio_url: translatedAudioUrl || null,
    original_audio_offset_ms: 0,
  });
  if (error) console.error('[db] insertMessage error:', error.message);
}

// ── Per-role Gemini session callbacks ─────────────────────────────────────────

function makeSessionCallbacks(session, sessionId, role) {
  const rs = session.roleState[role];
  const senderSocket = () => role === 'host' ? session.host : session.guest;
  const partnerSocket = () => getPartnerSocket(session, role);

  return {
    onAudioChunk(chunk) {
      if (!sessions.has(sessionId)) return;

      if (!rs.turnActive) {
        rs.turnActive = true;
        rs.turnStartedAt = Date.now();
        rs.turnSpeechStartedAt = rs.lastChunkClientSentAt || Date.now();
        send(partnerSocket(), { type: 'partner_speaking', turnId: chunk.turnId });
        send(senderSocket(), { type: 'processing_started', turnId: chunk.turnId });
      }

      if (chunk.index === 0) {
        const fromSpeechMs = Date.now() - (rs.turnSpeechStartedAt || rs.turnStartedAt);
        console.log(`[LATENCY][VOICE_TO_PARTNER] Turn ${chunk.turnId} (${role}→partner): First audio burst generated in ${fromSpeechMs}ms from speaker speech! Relaying to partner.`);
      }

      if (!rs.paused) {
        send(partnerSocket(), {
          type: 'translated_audio_chunk',
          audioBase64: chunk.audioBase64,
          mimeType: 'audio/wav',
          index: chunk.index,
          text: chunk.text,
          turnId: chunk.turnId,
          speechStartedAt: rs.turnSpeechStartedAt || rs.turnStartedAt,
          serverRelayedAt: Date.now(),
        });

        if (chunk.text) {
          send(partnerSocket(), {
            type: 'live_subtitle',
            speaker: 'partner',
            translatedText: chunk.text,
            turnId: chunk.turnId,
            isFinal: false,
            speechStartedAt: rs.turnSpeechStartedAt || rs.turnStartedAt,
            serverRelayedAt: Date.now(),
          });
        }
      }
    },

    onTranscriptionChunk(data) {
      if (!sessions.has(sessionId) || rs.paused) return;

      if (!rs.turnActive) {
        rs.turnActive = true;
        rs.turnStartedAt = Date.now();
        rs.turnSpeechStartedAt = rs.lastChunkClientSentAt || Date.now();
        send(partnerSocket(), { type: 'partner_speaking', turnId: data.turnId });
        send(senderSocket(), { type: 'processing_started', turnId: data.turnId });
      }

      const speechStart = rs.turnSpeechStartedAt || rs.turnStartedAt;
      if (speechStart) {
        const fromSpeechMs = Date.now() - speechStart;
        console.log(`[LATENCY][VOICE_TO_ME] Turn ${data.turnId} (${role}): Self transcription ready in ${fromSpeechMs}ms from speech capture.`);
      }

      send(senderSocket(), {
        type: 'live_subtitle',
        speaker: 'self',
        originalText: data.originalText,
        translatedText: data.translatedText,
        turnId: data.turnId,
        isFinal: false,
        speechStartedAt: rs.turnSpeechStartedAt || rs.turnStartedAt,
        serverRelayedAt: Date.now(),
      });

      send(partnerSocket(), {
        type: 'live_subtitle',
        speaker: 'partner',
        originalText: data.originalText,
        translatedText: data.translatedText,
        turnId: data.turnId,
        isFinal: false,
        speechStartedAt: rs.turnSpeechStartedAt || rs.turnStartedAt,
        serverRelayedAt: Date.now(),
      });
    },

    onSuppressed({ turnId }) {
      if (!sessions.has(sessionId)) return;
      console.log(`[server] Turn ${turnId || 'active'} (${role}) suppressed early — clearing partner UI immediately.`);
      rs.turnActive = false;
      send(partnerSocket(), { type: 'lock_released' });
      send(partnerSocket(), { type: 'live_subtitle_clear' });
      send(senderSocket(), { type: 'live_subtitle_clear' });
    },

    onInterrupted({ turnId }) {
      if (!sessions.has(sessionId)) return;
      console.log(`[server] Turn ${turnId || 'active'} (${role}) interrupted — resetting state.`);
      rs.turnActive = false;
      send(partnerSocket(), { type: 'lock_released' });
      send(partnerSocket(), { type: 'live_subtitle_clear' });
      send(senderSocket(), { type: 'live_subtitle_clear' });
    },

    onTurnComplete(result) {
      if (!sessions.has(sessionId)) return;
      rs.turnActive = false;
      const relayMs = rs.turnStartedAt ? Date.now() - rs.turnStartedAt : null;
      const totalTurnMs = rs.turnSpeechStartedAt ? Date.now() - rs.turnSpeechStartedAt : relayMs;
      console.log(`[LATENCY][VOICE_TO_PARTNER] Turn ${result.turnId} (${role}→partner): Complete turn processed in ${totalTurnMs}ms (Streaming relay duration: ${relayMs}ms)`);

      send(senderSocket(), { type: 'processing_done', turnId: result.turnId });

      if (result.suppressed || rs.paused || (!result.translatedAudioBase64 && !result.translatedText)) {
        console.log(`[server] Turn ${result.turnId} (${role}) suppressed/muted — suppressing delivery to partner.`);
        send(partnerSocket(), { type: 'lock_released' });
        send(senderSocket(), { type: 'live_subtitle_clear' });
        send(partnerSocket(), { type: 'live_subtitle_clear' });
        return;
      }

      send(senderSocket(), {
        type: 'transcript',
        originalText: result.originalText,
        translatedText: result.translatedText,
        turnId: result.turnId,
      });
      // Text only: the partner already received this turn's audio as
      // streamed translated_audio_chunk messages. Re-sending the whole turn's
      // WAV here (~65KB per second of speech) queued ahead of the NEXT turn's
      // live chunks on the partner's mobile connection and delayed them.
      // The full audio is still uploaded to storage below for recordings.
      send(partnerSocket(), {
        type: 'translated_audio_final',
        originalText: result.originalText,
        translatedText: result.translatedText,
        turnId: result.turnId,
      });
      send(partnerSocket(), { type: 'lock_released' });

      // Finalize live subtitles on both clients
      send(senderSocket(), {
        type: 'live_subtitle',
        speaker: 'self',
        originalText: result.originalText,
        translatedText: result.translatedText,
        turnId: result.turnId,
        isFinal: true,
      });
      send(partnerSocket(), {
        type: 'live_subtitle',
        speaker: 'partner',
        originalText: result.originalText,
        translatedText: result.translatedText,
        turnId: result.turnId,
        isFinal: true,
      });

      const senderUserId = role === 'host' ? session.hostUserId : session.guestUserId;
      if (senderUserId && (result.originalText || result.translatedText)) {
        // Voice recording disabled: save text translation only, no audio files
        dbInsertMessage(
          sessionId, senderUserId, role,
          result.originalText, result.translatedText,
          null, null
        ).catch(e => console.error('[db] insertMessage failed:', e.message));
      }
    },

    onInterrupted({ turnId }) {
      if (!sessions.has(sessionId)) return;
      rs.turnActive = false;
      console.log(`[LATENCY][server] Turn ${turnId} (${role}): interrupted, resetting turn state`);

      send(senderSocket(), { type: 'processing_done', turnId });
      send(partnerSocket(), { type: 'lock_released' });
      send(senderSocket(), { type: 'live_subtitle_clear', turnId });
      send(partnerSocket(), { type: 'live_subtitle_clear', turnId });
    },

    onError(err) {
      if (!sessions.has(sessionId)) return;
      rs.turnActive = false;
      console.error(`[server] Gemini error for ${role} in ${sessionId}:`, err.message);
      send(senderSocket(), { type: 'error', message: 'AI processing failed: ' + err.message });
      send(partnerSocket(), { type: 'lock_released' });
    },
  };
}

// ── LiveKit call engine ──────────────────────────────────────────────────────
// Both phones join a LiveKit room named after the session; a translator bot
// joins too (see translatorBot.js). This socket keeps carrying call control,
// subtitles and transcripts exactly as before.

async function startLiveKitCall(session, sessionId) {
  try {
    const [hostToken, guestToken] = await Promise.all([
      createToken(sessionId, 'host'),
      createToken(sessionId, 'guest'),
    ]);
    send(session.host, { type: 'livekit_ready', url: LIVEKIT_URL, token: hostToken, identity: 'host', partnerIdentity: 'guest' });
    send(session.guest, { type: 'livekit_ready', url: LIVEKIT_URL, token: guestToken, identity: 'guest', partnerIdentity: 'host' });

    const bot = new TranslatorBot({
      roomName: sessionId,
      langs: { host: session.hostLang, guest: session.guestLang },
      genders: { host: session.hostVoiceProfile?.gender, guest: session.guestVoiceProfile?.gender },
      onText: (role, seg) => relayTranslationText(session, sessionId, role, seg),
      onError: (err) => console.error(`[translatorBot] ${sessionId}: ${err.message}`),
    });
    session.bot = bot;
    await bot.start();
    if (!sessions.has(sessionId)) { bot.close(); return; }
    send(session.host, { type: 'gemini_ready' });
    send(session.guest, { type: 'gemini_ready' });
    startCallBilling(session, sessionId);
  } catch (err) {
    console.error(`[server] LiveKit call setup failed for ${sessionId}:`, err.message);
    send(session.host, { type: 'error', message: 'Could not start the translated call: ' + err.message });
    send(session.guest, { type: 'error', message: 'Could not start the translated call: ' + err.message });
  }
}

/** Subtitles + transcript for what `role` said, in the shapes the app already handles. */
function relayTranslationText(session, sessionId, role, seg) {
  if (!sessions.has(sessionId)) return;
  const speaker = role === 'host' ? session.host : session.guest;
  const listener = getPartnerSocket(session, role);
  const base = { originalText: seg.originalText, translatedText: seg.translatedText, turnId: seg.segId, isFinal: seg.isFinal };
  send(speaker, { type: 'live_subtitle', speaker: 'self', ...base });
  send(listener, { type: 'live_subtitle', speaker: 'partner', ...base });
  if (!seg.isFinal) return;

  send(speaker, { type: 'transcript', originalText: seg.originalText, translatedText: seg.translatedText, turnId: seg.segId });
  send(listener, { type: 'translated_audio_final', originalText: seg.originalText, translatedText: seg.translatedText, turnId: seg.segId });

  const senderUserId = role === 'host' ? session.hostUserId : session.guestUserId;
  if (senderUserId) {
    // Text only for now: the audio itself travels over LiveKit and isn't recorded.
    dbInsertMessage(sessionId, senderUserId, role, seg.originalText, seg.translatedText, null, null)
      .catch(e => console.error('[db] insertMessage failed:', e.message));
  }
}

function startCallBilling(session, sessionId) {
  if (!session || !session.hostUserId || session.billingInterval) return;
  session.connectedAt = Date.now();
  session.billedSecondsCharged = 0;
  session.sentLowMinutes = false;
  session.sentOutMinutes = false;

  console.log(`[billing] Call started for host ${session.hostUserId} in session ${sessionId} (engine=${session.hostEngine}). Waiting for partner was free.`);

  // Heartbeat every 15 seconds (Build Plan: Charge host every 15s; send minutes_low at 5 min, minutes_out at 0, end after 1 grace minute)
  session.billingInterval = setInterval(async () => {
    try {
      if (!sessions.has(sessionId)) {
        clearInterval(session.billingInterval);
        return;
      }
      const updated = await billingService.charge(session.hostUserId, 15, session.hostEngine);
      session.billedSecondsCharged = (session.billedSecondsCharged || 0) + 15;

      // 5 min remaining warning
      if (updated.totalMinutes <= 5 && !session.sentLowMinutes) {
        session.sentLowMinutes = true;
        send(session.host, { type: 'minutes_low', minutesLeft: updated.totalMinutes });
      }

      // 0 min remaining -> minutes_out + 1 grace minute
      if (updated.totalSeconds <= 0 && !session.sentOutMinutes) {
        session.sentOutMinutes = true;
        send(session.host, { type: 'minutes_out', graceSeconds: 60 });
        session.graceTimeout = setTimeout(() => {
          if (sessions.has(sessionId)) {
            console.log(`[billing] Grace minute ended for session ${sessionId}. Out of minutes.`);
            send(session.host, { type: 'call_ended', reason: 'Out of minutes' });
            if (session.guest) send(session.guest, { type: 'call_ended', reason: 'Host ran out of minutes' });
            cleanupSession(sessionId, 'system');
          }
        }, 60000);
      }
    } catch (err) {
      console.warn(`[billing] Heartbeat billing error in session ${sessionId}:`, err.message);
    }
  }, 15000);
}

function cleanupSession(sessionId, disconnectedRole) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.billingInterval) {
    clearInterval(session.billingInterval);
    session.billingInterval = null;
  }
  if (session.graceTimeout) {
    clearTimeout(session.graceTimeout);
    session.graceTimeout = null;
  }
  if (session.hostDisconnectTimeout) {
    clearTimeout(session.hostDisconnectTimeout);
    session.hostDisconnectTimeout = null;
  }

  // Bill call minutes: "From translator ready (gemini_ready) to call end; last part rounded up to 1 minute. Waiting for the partner is free."
  if (session.connectedAt && session.hostUserId) {
    const elapsedSec = Math.floor((Date.now() - session.connectedAt) / 1000);
    const callStart = session.connectedAt;
    session.connectedAt = null; // Prevent double billing

    if (elapsedSec >= 15) { // 15s drop protection
      const totalRoundedBilledSeconds = Math.ceil(elapsedSec / 60) * 60;
      const remainingToCharge = Math.max(0, totalRoundedBilledSeconds - (session.billedSecondsCharged || 0));

      if (remainingToCharge > 0) {
        billingService.charge(session.hostUserId, remainingToCharge, session.hostEngine)
          .catch(err => console.error('[billing] Final minute rounding charge failed:', err.message));
      }

      billingService.recordCallUsage({
        userId: session.hostUserId,
        sessionId,
        engine: session.hostEngine,
        startedAt: callStart,
        endedAt: Date.now(),
        billedSeconds: totalRoundedBilledSeconds,
      }).catch(err => console.error('[billing] Failed to record call usage:', err.message));

      console.log(`[billing] Call completed: ${session.hostUserId} spoke ${elapsedSec}s -> billed ${totalRoundedBilledSeconds / 60} mins (${totalRoundedBilledSeconds}s).`);
    } else {
      console.log(`[billing] Call ended quickly (${elapsedSec}s < 15s) - connection-drop protection, no final charge.`);
    }
  }

  session.roleState.host.paused = false;
  session.roleState.guest.paused = false;

  const partnerSocket = getPartnerSocket(session, disconnectedRole);
  send(partnerSocket, {
    type: 'partner_disconnected',
    message: `${disconnectedRole === 'host' ? 'Host' : 'Guest'} has disconnected.`,
  });

  if (partnerSocket && partnerSocket.readyState === partnerSocket.OPEN) {
    partnerSocket.close();
  }

  closeSession(sessionId, 'host');
  closeSession(sessionId, 'guest');
  if (session.bot) session.bot.close().catch(() => { });

  dbEndConversation(sessionId)
    .catch(e => console.error('[db] endConversation failed:', e.message))
    .finally(() => conversationIds.delete(sessionId));
  if (session && session.shortCode) shortCodes.delete(session.shortCode);
  sessions.delete(sessionId);
  console.log(`[server] Session ${sessionId} cleaned up (${disconnectedRole} disconnected).`);
}

// ── WebSocket message handler ─────────────────────────────────────────────────

/**
 * Who is this caller? Verifies `authToken` (Clerk session token) from a
 * create_session / join_session message.
 *   valid token            → verified user id
 *   invalid/forged token   → throws (always)
 *   no token               → throws, unless AUTH_ENFORCE=false (rollout for
 *                            old builds): then the app's userId is used if well-formed
 */
async function wsCaller(message) {
  if (message.authToken) {
    try {
      return await verifyClerkToken(message.authToken);
    } catch (err) {
      if (!AUTH_ENFORCE && isValidUserId(message.userId)) {
        console.warn(`[ws] Clerk token verification failed, falling back to message.userId: ${message.userId}`);
        return message.userId;
      }
      throw err;
    }
  }
  if (!AUTH_ENFORCE) return isValidUserId(message.userId) ? message.userId : null;
  throw new AuthError('Please log in again to start a call.');
}

/** Language names are written into the AI's instructions, so only accept known ones. */
function isSupportedLanguage(lang) {
  return typeof lang === 'string' && SUPPORTED_LANGUAGES.includes(lang);
}

/** The role this socket has in the session, or null if it isn't part of it. */
function roleOf(session, ws) {
  if (!session) return null;
  if (ws === session.host) return 'host';
  if (ws === session.guest) return 'guest';
  return null;
}

wss.on('connection', (ws) => {
  console.log('[server] New WebSocket connection');
  let currentSessionId = null;
  let currentRole = null;

  ws.on('message', async (data) => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch (e) { send(ws, { type: 'error', message: 'Invalid JSON message.' }); return; }

    const { type } = message;

    // ── CREATE SESSION (Host) ────────────────────────────────────────────────
    if (type === 'create_session') {
      const { lang, speakerGender, speakerAge } = message;
      // Same connection starting a new call (e.g. cancelled and retried): close the old one first.
      if (currentSessionId && sessions.has(currentSessionId)) { cleanupSession(currentSessionId, currentRole); currentSessionId = null; currentRole = null; }
      if (!isSupportedLanguage(lang)) { send(ws, { type: 'error', message: 'Unsupported language.' }); return; }
      let userId;
      try { userId = await wsCaller(message); }
      catch (err) { send(ws, { type: 'error', message: err.message }); return; }

      let hostEngine = DEFAULT_CALL_ENGINE;
      if (userId) {
        try {
          const billingInfo = await billingService.getAvailableMinutes(userId, message.deviceId);
          if (billingService.BILLING_ENFORCE && billingInfo.totalMinutes <= 0) {
            send(ws, {
              type: 'error',
              code: 'NO_MINUTES',
              message: 'You have 0 call minutes remaining. Please top up your account to make calls.',
              plan: billingInfo.plan,
            });
            return;
          }
          // Build plan: Ignore the app's engine; use the plan's (trial/pro -> livekit, standard -> legacy)
          hostEngine = billingService.getEngineForPlan(billingInfo.plan);
        } catch (err) {
          console.warn('[billing] Pre-call balance check error:', err.message);
          hostEngine = message.engine === 'livekit' ? 'livekit' : (message.engine === 'legacy' ? 'legacy' : DEFAULT_CALL_ENGINE);
        }
      } else {
        hostEngine = message.engine === 'livekit' ? 'livekit' : (message.engine === 'legacy' ? 'legacy' : DEFAULT_CALL_ENGINE);
      }
      const sessionId = message.sessionId || uuidv4();
      if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        if (session.hostDisconnectTimeout) {
          clearTimeout(session.hostDisconnectTimeout);
          session.hostDisconnectTimeout = null;
        }
        session.hostDisconnected = false;
        session.host = ws;
        currentSessionId = sessionId;
        currentRole = 'host';
        console.log(`[server] Host reattached to existing session ${sessionId}`);
        send(ws, {
          type: 'session_resumed',
          sessionId,
          shortCode: session.shortCode,
          partnerConnected: !!session.guest,
          partnerLang: session.guestLang,
          engine: session.hostEngine,
        });
        return;
      }
      sessions.set(sessionId, {
        hostEngine,
        host: ws, hostLang: lang, hostUserId: userId || null,
        hostVoiceProfile: { gender: speakerGender, age: speakerAge },
        guest: null, guestLang: null, guestUserId: null,
        guestVoiceProfile: {},
        roleState: {
          host: { paused: false, turnActive: false },
          guest: { paused: false, turnActive: false },
        },
      });
      currentSessionId = sessionId;
      currentRole = 'host';
      const session = sessions.get(sessionId);
      session.createdAt = Date.now();
      const activeModel = hostEngine === 'livekit'
        ? (process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-live-translate-preview')
        : (process.env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-native-audio');
      console.log(`[server] Host created session ${sessionId} [engine=${hostEngine}, model=${activeModel}] at ${session.createdAt} (Host lang: ${lang}, userId: ${userId})`);
      const shortCode = newShortCode();
      if (shortCode) { shortCodes.set(shortCode, sessionId); session.shortCode = shortCode; }
      send(ws, { type: 'session_created', sessionId, shortCode });

      if (userId) {
        dbCreateConversation(sessionId, userId, lang)
          .catch(e => console.error('[db] createConversation failed:', e.message));
      }
      return;
    }

    // ── JOIN SESSION (Guest) ─────────────────────────────────────────────────
    if (type === 'join_session') {
      const { lang, speakerGender, speakerAge } = message;
      // Accepts the full session id (invite link / QR) or the short code.
      const sessionId = resolveSessionId(message.sessionId);
      const session = sessionId ? sessions.get(sessionId) : null;

      if (!session) { send(ws, { type: 'error', message: 'Call not found. Ask your partner for a new invite.' }); return; }
      if (session.host === ws) { send(ws, { type: 'error', message: `Cannot join your own session as guest on the same connection.` }); return; }
      // A call has exactly two people. Without this check a third person with
      // the invite link replaced the guest, a second translator bot was
      // started and the first bot's Gemini sessions kept running (and billing).
      if (session.guest) { send(ws, { type: 'error', message: 'This call already has two people.' }); return; }
      // Same connection starting a new call (e.g. cancelled and retried): close the old one first.
      if (currentSessionId && sessions.has(currentSessionId)) { cleanupSession(currentSessionId, currentRole); currentSessionId = null; currentRole = null; }
      if (!isSupportedLanguage(lang)) { send(ws, { type: 'error', message: 'Unsupported language.' }); return; }
      let userId;
      try { userId = await wsCaller(message); }
      catch (err) { send(ws, { type: 'error', message: err.message }); return; }
      // Re-check after the await: someone else may have joined meanwhile.
      if (session.guest || !sessions.has(sessionId)) { send(ws, { type: 'error', message: 'This call already has two people.' }); return; }
      // Guest joins: automatically adopt the host's selected engine
      session.engine = session.hostEngine || DEFAULT_CALL_ENGINE;
      if (session.engine === 'livekit' && !LIVEKIT_ENABLED) {
        send(ws, { type: 'error', message: 'Server is not configured for LiveKit calls (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).' });
        return;
      }

      session.guest = ws;
      session.guestLang = lang;
      session.guestUserId = userId || null;
      session.guestVoiceProfile = { gender: speakerGender, age: speakerAge };
      currentSessionId = sessionId;
      currentRole = 'guest';
      const guestJoinAt = Date.now();
      session.connectedAt = guestJoinAt;
      const waitTime = session.createdAt ? guestJoinAt - session.createdAt : 0;
      console.log(`[LATENCY][CALL_CONNECT] Guest joined session: ${sessionId} [engine=${session.engine}] (${waitTime}ms after host creation)`);

      send(session.host, {
        type: 'session_ready',
        role: 'host',
        sessionId,
        myLang: session.hostLang,
        partnerLang: session.guestLang,
        engine: session.engine
      });
      send(session.guest, {
        type: 'session_ready',
        role: 'guest',
        sessionId,
        myLang: session.guestLang,
        partnerLang: session.hostLang,
        engine: session.engine
      });

      if (session.engine === 'livekit') {
        startLiveKitCall(session, sessionId);
        if (userId) {
          dbUpdateConversationGuest(sessionId, userId, lang)
            .catch(e => console.error('[db] updateConversationGuest failed:', e.message));
        }
        return;
      }

      // Open persistent Gemini Live sessions for BOTH directions in parallel now
      // that both voice profiles are known. We await both before sending gemini_ready
      // so clients know exactly when the AI pipeline is open and audio won't be dropped.
      if (AI_TRANSLATION_ENABLED) {
        const warmupTimeout = new Promise((resolve) => setTimeout(resolve, 5000));
        Promise.race([
          Promise.all([
            warmupSession(
              sessionId, 'host', session.hostLang, session.guestLang,
              session.hostVoiceProfile || {}, makeSessionCallbacks(session, sessionId, 'host')
            ),
            warmupSession(
              sessionId, 'guest', session.guestLang, session.hostLang,
              session.guestVoiceProfile || {}, makeSessionCallbacks(session, sessionId, 'guest')
            ),
          ]),
          warmupTimeout,
        ]).then(() => {
          const warmupDuration = Date.now() - guestJoinAt;
          console.log(`[LATENCY][CALL_CONNECT] 🎉 Session ${sessionId} FULLY CONNECTED! Gemini AI ready in ${warmupDuration}ms after guest joined.`);
          send(session.host, { type: 'gemini_ready' });
          send(session.guest, { type: 'gemini_ready' });
          startCallBilling(session, sessionId);
        }).catch((err) => {
          console.error(`[server] Gemini warmup failed for ${sessionId}:`, err.message);
          send(session.host, { type: 'gemini_ready' });
          send(session.guest, { type: 'gemini_ready' });
        });
      } else {
        // AI disabled — ready immediately
        send(session.host, { type: 'gemini_ready' });
        send(session.guest, { type: 'gemini_ready' });
      }

      if (userId) {
        dbUpdateConversationGuest(sessionId, userId, lang)
          .catch(e => console.error('[db] updateConversationGuest failed:', e.message));
      }
      return;
    }

    // ── FLOOR CONTROL (no-op) ────────────────────────────────────────────────
    if (type === 'claim_turn' || type === 'release_turn') return;

    // ── PAUSE QUEUE (mute / barge-in) ──────────────────────────────────────
    if (type === 'pause_queue') {
      const { sessionId } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      const senderRole = roleOf(session, ws); // never trust `role` from the message
      if (senderRole && session.roleState[senderRole]) {
        session.roleState[senderRole].paused = true;
        console.log(`[server] Paused/muted for ${senderRole} in ${sessionId}`);
      }
      return;
    }

    // ── RESUME QUEUE (unmute) ──────────────────────────────────────────────
    if (type === 'resume_queue') {
      const { sessionId } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      const senderRole = roleOf(session, ws); // never trust `role` from the message
      const rs = senderRole && session.roleState[senderRole];
      if (rs) {
        rs.paused = false;
        console.log(`[server] Resumed/unmuted for ${senderRole} in ${sessionId}`);
        const partnerSocket = getPartnerSocket(session, senderRole);
        send(partnerSocket, { type: 'queue_resumed' });
      }
      return;
    }

    // ── CANCEL QUEUE (backward compat — kept as alias for clear+resume) ──────
    if (type === 'cancel_queue') {
      const { sessionId } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      const senderRole = roleOf(session, ws); // never trust `role` from the message
      if (senderRole && session.roleState[senderRole]) {
        session.roleState[senderRole].paused = false;
        send(ws, { type: 'queue_cancelled' });
      }
      return;
    }

    // ── STREAMED AUDIO CHUNK (continuous, ~100-250ms of raw PCM) ────────────
    if (type === 'audio_stream_chunk') {
      if (!AI_TRANSLATION_ENABLED) return;
      const { sessionId, audioBase64, mimeType, clientSentAt } = message;
      const session = sessions.get(sessionId);

      if (!session) { send(ws, { type: 'error', message: 'Session not found.' }); return; }
      if (typeof audioBase64 !== 'string' || mimeType !== 'audio/pcm;rate=16000') return;
      if (!session.host || !session.guest) return; // not fully connected yet — drop silently
      if (session.engine === 'livekit') return; // audio travels over LiveKit, not this socket

      // Authoritative socket-based role resolution:
      const senderRole = roleOf(session, ws); // never trust `role` from the message
      if (!senderRole) return;

      const rs = session.roleState[senderRole];
      if (rs) {
        rs.lastChunkClientSentAt = clientSentAt || Date.now();
      }

      // When sender is muted/paused, drop all audio chunks immediately — never feed into Gemini!
      if (session.roleState[senderRole]?.paused) return;

      feedAudioChunk(sessionId, senderRole, audioBase64, mimeType);
      return;
    }

    // ── WEBRTC SIGNALING (pure relay — server never touches the audio) ──────
    if (type === 'webrtc_offer' || type === 'webrtc_answer' || type === 'webrtc_ice_candidate' || type === 'webrtc_ready') {
      const { sessionId } = message;
      const session = sessions.get(sessionId);
      const role = roleOf(session, ws); // only the two people on the call may signal
      if (!role) return;
      const partnerSocket = getPartnerSocket(session, role);
      console.log(`[webrtc] ${type} from ${role} in ${sessionId}: partner socket ${partnerSocket ? 'found' : 'MISSING'}`);
      if (partnerSocket) send(partnerSocket, message);
      return;
    }

    // ── END SESSION ──────────────────────────────────────────────────────────
    if (type === 'end_session') {
      const { sessionId } = message;
      const role = roleOf(sessions.get(sessionId), ws); // only someone on the call can end it
      if (role) cleanupSession(sessionId, role);
      return;
    }


    // ── PING / HEARTBEAT ─────────────────────────────────────────────────────
    if (type === 'ping') {
      send(ws, { type: 'pong', timestamp: Date.now() });
      return;
    }

    // ── RECONNECT SESSION (Host returning from WhatsApp or background) ─────────
    if (type === 'reconnect_session') {
      const { sessionId, role, lang } = message;
      const targetSessionId = resolveSessionId(sessionId);
      const session = sessions.get(targetSessionId);

      if (!session) {
        console.log(`[server] reconnect_session: session ${targetSessionId} not found`);
        send(ws, { type: 'error', message: 'Session has expired or was ended.' });
        return;
      }

      if (role === 'host') {
        if (session.hostDisconnectTimeout) {
          clearTimeout(session.hostDisconnectTimeout);
          session.hostDisconnectTimeout = null;
        }
        session.hostDisconnected = false;
        session.host = ws;
        currentSessionId = targetSessionId;
        currentRole = 'host';
        console.log(`[server] Host reconnected to session ${targetSessionId}`);
        send(ws, {
          type: 'session_resumed',
          sessionId: targetSessionId,
          shortCode: session.shortCode,
          partnerConnected: !!session.guest,
          partnerLang: session.guestLang,
          engine: session.hostEngine,
        });

        if (session.guest) {
          send(ws, {
            type: 'session_ready',
            partnerLang: session.guestLang,
            engine: session.hostEngine,
          });
        }
        return;
      }
    }

    send(ws, { type: 'error', message: `Unknown message type: ${type}` });
  });

  ws.on('close', () => {
    console.log(`[server] Connection closed. Role: ${currentRole}, Session: ${currentSessionId}`);
    if (currentSessionId && currentRole) {
      const session = sessions.get(currentSessionId);
      // If host disconnected while waiting in the lobby (no guest yet, call not started):
      // Don't kill the session immediately; give 2 minutes grace period for sharing invite (WhatsApp, etc.)
      if (session && currentRole === 'host' && !session.guest && !session.connectedAt) {
        console.log(`[server] Host disconnected while in lobby for session ${currentSessionId}. Holding session for 120s...`);
        session.hostDisconnected = true;
        session.host = null;
        if (session.hostDisconnectTimeout) clearTimeout(session.hostDisconnectTimeout);
        session.hostDisconnectTimeout = setTimeout(() => {
          console.log(`[server] Host lobby grace period expired for session ${currentSessionId}. Cleaning up.`);
          cleanupSession(currentSessionId, 'host');
        }, 120000);
        return;
      }

      cleanupSession(currentSessionId, currentRole);
    }
  });

  ws.on('error', (err) => { console.error('[server] WebSocket error:', err.message); });
});

console.log(`[server] ${APP_NAME} server starting on port ${PORT}`);

// Automated 30-day recurring subscription renewal scheduler
setInterval(() => {
  billingService.processAutopayRenewals().catch(err => {
    console.warn('[billing] Periodic autopay renewal notice:', err.message);
  });
}, 30 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`[server] HTTP + WebSocket server listening on port ${PORT}`);
});
