import { useCallback } from 'react';
import { useAuth } from '@clerk/clerk-expo';

/**
 * `fetch` that adds the logged-in user's Clerk session token:
 *   Authorization: Bearer <token>
 *
 * The server checks this token's signature to know who is asking, and only
 * returns that user's own conversations and recordings. Use it for every
 * request to our backend that reads or changes user data.
 */
export function useAuthFetch() {
  const { getToken } = useAuth();
  return useCallback(async (url: string, init: RequestInit = {}) => {
    const token = await getToken().catch(() => null);
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }, [getToken]);
}
