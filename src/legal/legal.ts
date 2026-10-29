import { APP_DOMAIN } from '../config';

/**
 * Legal texts the user agrees to. Bump CONSENT_VERSION whenever the Terms or
 * Privacy Policy change in a way users must re-accept: everyone is then shown
 * the consent screen again on their next app start.
 */
export const CONSENT_VERSION = '2026-11-01';

export const SITE_URL = `https://${APP_DOMAIN}`;
export const TERMS_URL = `${SITE_URL}/terms`;
export const PRIVACY_URL = `${SITE_URL}/privacy`;
export const SUPPORT_URL = `${SITE_URL}/support`;

/** True when the signed-in user has accepted the current terms. */
export function hasAcceptedCurrentTerms(unsafeMetadata: any): boolean {
  return unsafeMetadata?.consent?.version === CONSENT_VERSION;
}

/**
 * Set when the user ticks the agreement box on the sign-in screen. Right
 * after sign-in, App saves it as their consent (so they aren't asked twice).
 * In memory only: if the app restarts before that, the consent screen asks.
 */
export const pendingAgreement = { acceptedAt: null as string | null };
