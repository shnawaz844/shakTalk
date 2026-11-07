require('dotenv').config();
const { supabase } = require('./supabaseClient');

const BUCKET = 'audio-recordings';

/**
 * Uploads a base64-encoded WAV buffer to Supabase Storage.
 *
 * NOTE: Voice recording for calls has been permanently disabled.
 * Audio is ephemeral and not recorded or stored. Always returns null.
 */
async function uploadAudio(sessionId, messageId, suffix, base64Wav) {
  return null;
}

const SIGNED_URL_SECONDS = 60 * 60; // links the app gets are valid for 1 hour

/**
 * Turns a stored recording URL (".../object/public/audio-recordings/<path>")
 * or a bare storage path into a signed URL that expires. Returns null if the
 * file can't be signed (missing, or not in our bucket).
 */
async function signedUrlFor(storedUrlOrPath) {
  if (!storedUrlOrPath) return null;
  const marker = `/${BUCKET}/`;
  const i = storedUrlOrPath.indexOf(marker);
  const path = i >= 0 ? storedUrlOrPath.slice(i + marker.length).split('?')[0] : storedUrlOrPath;
  if (!path || path.includes('..')) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(decodeURIComponent(path), SIGNED_URL_SECONDS);
    if (error) { console.warn('[storageService] sign failed:', error.message); return null; }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.warn('[storageService] sign failed:', err.message);
    return null;
  }
}

module.exports = { uploadAudio, signedUrlFor };
