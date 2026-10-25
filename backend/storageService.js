require('dotenv').config();
const { supabase } = require('./supabaseClient');

const BUCKET = 'audio-recordings';

/**
 * Uploads a base64-encoded WAV buffer to Supabase Storage.
 *
 * @param {string} sessionId  - App session ID (used as folder)
 * @param {string} messageId  - Unique message/turn ID
 * @param {'original'|'translated'} suffix - Track type
 * @param {string} base64Wav  - Base64 WAV audio data
 * @returns {Promise<string|null>} Public URL or null on failure
 */
async function uploadAudio(sessionId, messageId, suffix, base64Wav) {
  if (!base64Wav || base64Wav.length < 100) return null;

  try {
    const buffer = Buffer.from(base64Wav, 'base64');
    const filePath = `${sessionId}/${messageId}_${suffix}.wav`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, buffer, {
        contentType: 'audio/wav',
        upsert: false,
      });

    if (error) {
      console.error(`[storageService] Upload failed (${suffix}):`, error.message);
      return null;
    }

    // The public-style URL is stored as the row's reference to the file. It is
    // never handed to the app directly any more: /conversations/:id/recordings
    // turns it into a short-lived signed link (signedUrlFor below), so the
    // bucket can be made private in Supabase.
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  } catch (err) {
    console.error(`[storageService] Unexpected error uploading ${suffix}:`, err.message);
    return null;
  }
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
