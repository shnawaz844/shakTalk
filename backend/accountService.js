/**
 * Account deletion (Apple App Store and Google Play require it in the app).
 *
 * What happens, in this order:
 *  1. Conversations the user took part in:
 *     - if nobody else is left in the conversation → the conversation, all its
 *       messages and its recordings are deleted;
 *     - if the other person still has an account → the user is removed from it,
 *       recordings of the user's own speech are deleted, and the user's id is
 *       removed from their messages. The text stays in the PARTNER's history,
 *       because they took part in the call (this is what the privacy policy
 *       and /delete-account page say).
 *  2. The user's plan row.
 *  3. The Clerk account itself (name, email, photo, profile settings).
 *
 * Each step logs and continues if one item fails, then the whole result is
 * reported, so a partial failure can be finished by hand.
 */

const { supabase } = require('./supabaseClient');

const BUCKET = 'audio-recordings';
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

/** Storage path inside the bucket from a stored public/signed URL, or null. */
function storagePath(url) {
  if (!url) return null;
  const marker = `/${BUCKET}/`;
  const i = url.indexOf(marker);
  if (i < 0) return null;
  return decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
}

async function removeFiles(paths) {
  const list = paths.filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await supabase.storage.from(BUCKET).remove(list.slice(i, i + 100));
    if (error) throw error;
  }
  return list.length;
}

async function removeFolder(prefix) {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw error;
  return removeFiles((data || []).map((f) => `${prefix}/${f.name}`));
}

async function deleteClerkUser(userId) {
  if (!CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY not configured on server');
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.errors?.[0]?.message ?? `Clerk delete failed (${res.status})`);
  }
}

async function deleteAccount(userId) {
  const result = { conversationsDeleted: 0, conversationsLeft: 0, filesDeleted: 0, errors: [] };
  const note = (where, err) => {
    result.errors.push(`${where}: ${err.message || err}`);
    console.error(`[account] ${userId} ${where}:`, err.message || err);
  };

  if (supabase) {
    let convs = [];
    try {
      const { data, error } = await supabase
        .from('conversations')
        .select('id, session_id, host_user_id, guest_user_id')
        .or(`host_user_id.eq.${userId},guest_user_id.eq.${userId}`);
      if (error) throw error;
      convs = data || [];
    } catch (err) { note('list conversations', err); }

    for (const c of convs) {
      const partner = c.host_user_id === userId ? c.guest_user_id : c.host_user_id;
      try {
        if (!partner) {
          result.filesDeleted += await removeFolder(c.session_id).catch((e) => { note(`files ${c.session_id}`, e); return 0; });
          const { error } = await supabase.from('conversations').delete().eq('id', c.id);
          if (error) throw error;
          result.conversationsDeleted++;
        } else {
          const { data: mine, error: mErr } = await supabase
            .from('messages')
            .select('id, original_audio_url, translated_audio_url')
            .eq('conversation_id', c.id)
            .eq('sender_user_id', userId);
          if (mErr) throw mErr;
          const files = (mine || []).flatMap((m) => [storagePath(m.original_audio_url), storagePath(m.translated_audio_url)]);
          result.filesDeleted += await removeFiles(files).catch((e) => { note(`files ${c.session_id}`, e); return 0; });
          const { error: uErr } = await supabase
            .from('messages')
            .update({ sender_user_id: null, original_audio_url: null, translated_audio_url: null })
            .eq('conversation_id', c.id)
            .eq('sender_user_id', userId);
          if (uErr) throw uErr;
          const unlink = c.host_user_id === userId ? { host_user_id: null } : { guest_user_id: null };
          const { error: cErr } = await supabase.from('conversations').update(unlink).eq('id', c.id);
          if (cErr) throw cErr;
          result.conversationsLeft++;
        }
      } catch (err) { note(`conversation ${c.id}`, err); }
    }

    try {
      const { error } = await supabase.from('user_plans').delete().eq('user_id', userId);
      if (error) throw error;
    } catch (err) { note('plan', err); }
  }

  // Last: once the login is gone the user can't retry, so data goes first.
  try { await deleteClerkUser(userId); } catch (err) { note('clerk user', err); }

  console.log(`[account] deleted ${userId}: ${JSON.stringify(result)}`);
  return result;
}

module.exports = { deleteAccount };
