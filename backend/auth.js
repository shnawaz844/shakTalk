require('dotenv').config();
const { verifyToken } = require('@clerk/backend');

/**
 * Login checks for the HTTP API and the WebSocket.
 *
 * Every request that touches a user's data must carry the Clerk session
 * token the app already has (`getToken()` from @clerk/clerk-expo):
 *   HTTP:      header  Authorization: Bearer <token>
 *   WebSocket: field   authToken: <token>   in create_session / join_session
 *
 * The token's SIGNATURE is verified with Clerk, so the user id ("sub") can
 * be trusted. Never trust a userId the app sends in a query string or body.
 *
 * Env:
 *   CLERK_SECRET_KEY  (already set)  used to verify tokens (fetches Clerk's
 *                     public keys once and caches them)
 *   CLERK_JWT_KEY     optional. Clerk Dashboard → API Keys → "JWT public
 *                     key" (PEM). When set, verification needs no network call.
 *   AUTH_ENFORCE      default 'true'. Set to 'false' ONLY during rollout, while
 *                     older app builds that don't send a token are still in
 *                     use: requests without a token are then still served the
 *                     old way (but forged/invalid tokens are always rejected).
 */

const AUTH_ENFORCE = process.env.AUTH_ENFORCE !== 'false';
// Clerk user ids look like "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb".
const USER_ID_RE = /^user_[A-Za-z0-9]{10,64}$/;

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

/** Verifies a Clerk session token and returns the user id. Throws AuthError. */
async function verifyClerkToken(token) {
  if (!token || typeof token !== 'string') throw new AuthError('Missing login token.');
  if (!process.env.CLERK_SECRET_KEY && !process.env.CLERK_JWT_KEY) {
    throw new AuthError('Server is missing CLERK_SECRET_KEY / CLERK_JWT_KEY.', 503);
  }
  let result;
  try {
    result = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
      jwtKey: process.env.CLERK_JWT_KEY || undefined,
    });
  } catch (err) {
    console.warn('[auth] verifyToken failed:', err.message);
    throw new AuthError('Invalid or expired login token.');
  }
  // @clerk/backend returns { data } or { errors } depending on version.
  if (result && result.errors && result.errors.length) throw new AuthError('Invalid or expired login token.');
  const payload = (result && result.data) || result;
  const userId = payload && payload.sub;
  if (!isValidUserId(userId)) throw new AuthError('Login token has no valid user.');
  return userId;
}

function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

/** Reads "Authorization: Bearer <token>" from an HTTP request. */
function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/**
 * Who is calling this HTTP endpoint?
 *   - valid token          → their verified user id
 *   - invalid/forged token → AuthError (always)
 *   - no token             → AuthError, unless AUTH_ENFORCE=false (rollout),
 *                            in which case `fallbackUserId` is used if it is a
 *                            well-formed id (old app builds)
 */
async function requireUser(req, fallbackUserId) {
  const token = bearerToken(req);
  if (token) {
    try {
      return await verifyClerkToken(token);
    } catch (err) {
      if (!AUTH_ENFORCE && isValidUserId(fallbackUserId)) {
        console.warn(`[auth] Clerk token verification failed, falling back to query userId: ${fallbackUserId}`);
        return fallbackUserId;
      }
      throw err;
    }
  }
  if (!AUTH_ENFORCE && isValidUserId(fallbackUserId)) return fallbackUserId;
  throw new AuthError('Login required.');
}

module.exports = { verifyClerkToken, requireUser, bearerToken, isValidUserId, AuthError, AUTH_ENFORCE };
