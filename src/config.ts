// Central config
// WS_URL/CLERK_PUBLISHABLE_KEY are read from the environment (EXPO_PUBLIC_*
// vars are inlined at build time by Expo) so each EAS build profile
// (development/preview/production in eas.json) actually points at its own
// backend and Clerk instance, instead of every build silently shipping
// whatever was last hardcoded here for local testing.

// ── App branding ─────────────────────────────────────────────────────────────
// Re-exported from the root app-config.ts so all UI code has a single import
// path: `import { APP_NAME, APP_NAME_PREFIX, APP_NAME_SUFFIX } from '../config'`
export {
  APP_NAME,
  APP_NAME_PREFIX,
  APP_NAME_SUFFIX,
  APP_NAME_LOWER,
  APP_BUNDLE_ID,
  APP_LOGO,
  APP_OPENING_SCREEN,
} from '../app-config';
const wsUrl = process.env.EXPO_PUBLIC_WS_URL || 'wss://www.shaktalk.com';
export const WS_URL = wsUrl;

// Call engine configuration:
// - 'legacy' (DEFAULT): Gemini 2.5 Flash Native Audio on Vertex AI (geminiService.js).
// - 'livekit': Gemini 3.5 Live Translate preview bot via LiveKit (liveTranslate.js).
// Configurable via EXPO_PUBLIC_CALL_ENGINE ('legacy' | 'livekit') or EXPO_PUBLIC_TRANSLATION_MODEL ('gemini-2.5' | 'gemini-3.5').
const configuredEngine = (process.env.EXPO_PUBLIC_CALL_ENGINE || process.env.EXPO_PUBLIC_TRANSLATION_MODEL || '').toLowerCase();
export const CALL_ENGINE: 'livekit' | 'legacy' =
  configuredEngine === 'livekit' || configuredEngine === 'gemini-3.5' || configuredEngine === '3.5'
    ? 'livekit'
    : 'legacy';

export const ACTIVE_TRANSLATION_MODEL =
  CALL_ENGINE === 'livekit'
    ? (process.env.EXPO_PUBLIC_GEMINI_TRANSLATE_MODEL || 'gemini-3.5-live-translate-preview')
    : (process.env.EXPO_PUBLIC_GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-native-audio');

// HTTP equivalent of WS_URL, for plain REST calls (e.g. /clerk/update-profile).
// Derived from WS_URL so both always point at the same backend.
export const API_URL = WS_URL.replace(/^ws/, 'http');

// Shareable domain & join link for WhatsApp and QR invites....
export const APP_DOMAIN = process.env.EXPO_PUBLIC_APP_DOMAIN || 'www.shaktalk.com';
export const JOIN_BASE_URL = `https://${APP_DOMAIN}/join`;

export const LANGUAGES = [
  { code: 'en-US', name: 'English' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'ru-RU', name: 'Russian' },
  { code: 'uk-UA', name: 'Ukrainian' },
  // China
  { code: 'zh-CN', name: 'Mandarin' },
  { code: 'zh-HK', name: 'Cantonese' },

  // GCC Countries (Gulf Cooperation Council)
  { code: 'ar-SA', name: 'Arabic' },
  // Global & Regional Languages
  { code: 'ur-PK', name: 'Urdu' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
] as const;

export type LanguageCode = typeof LANGUAGES[number]['code'];
export type LanguageName = typeof LANGUAGES[number]['name'];
