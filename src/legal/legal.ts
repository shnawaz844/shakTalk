import { APP_DOMAIN } from '../config';
import { storage } from '../utils/storageCompat';

/**
 * Legal texts the user agrees to. Bump CONSENT_VERSION whenever the Terms or
 * Privacy Policy change in a way users must re-accept: everyone is then shown
 * the consent screen again on their next app start.
 */
export const CONSENT_VERSION = '2026-11-02';
export const LOCAL_CONSENT_KEY = 'shak_consent_accepted_version';

export const SITE_URL = `https://${APP_DOMAIN}`;
export const TERMS_URL = `${SITE_URL}/terms`;
export const PRIVACY_URL = `${SITE_URL}/privacy`;
export const SUPPORT_URL = `${SITE_URL}/support`;

/** True when the signed-in user has accepted the current terms. */
export function hasAcceptedCurrentTerms(unsafeMetadata: any): boolean {
  return unsafeMetadata?.consent?.version === CONSENT_VERSION;
}

/** Check if device has accepted current terms on install/open */
export async function hasAcceptedLocalConsent(): Promise<boolean> {
  try {
    const val = await storage.getItem(LOCAL_CONSENT_KEY);
    return val === CONSENT_VERSION;
  } catch (_) {
    return false;
  }
}

/** Save acceptance to device local storage */
export async function saveLocalConsent(): Promise<void> {
  try {
    await storage.setItem(LOCAL_CONSENT_KEY, CONSENT_VERSION);
  } catch (_) {}
}

/**
 * Set when the user ticks the agreement box on the sign-in screen or on the initial consent screen.
 * Right after sign-in, App saves it as their consent (so they aren't asked twice).
 */
export const pendingAgreement = { acceptedAt: null as string | null };
