import { storage } from './storageCompat';
import { CALL_ENGINE } from '../config';

const ENGINE_STORAGE_KEY = 'shak_call_engine_preference';

export type CallEngine = 'legacy' | 'livekit';

let currentEngine: CallEngine = CALL_ENGINE;

// Listeners for live state updates across screens
const listeners = new Set<(engine: CallEngine) => void>();

export async function getStoredEngine(): Promise<CallEngine> {
  try {
    const saved = await storage.getItem(ENGINE_STORAGE_KEY);
    if (saved === 'legacy' || saved === 'livekit') {
      currentEngine = saved;
      return saved;
    }
  } catch (_) {}
  return currentEngine;
}

export async function setStoredEngine(engine: CallEngine): Promise<void> {
  currentEngine = engine;
  listeners.forEach(cb => cb(engine));
  try {
    await storage.setItem(ENGINE_STORAGE_KEY, engine);
  } catch (_) {}
}

export function getCurrentEngine(): CallEngine {
  return currentEngine;
}

export function subscribeEngineChange(cb: (engine: CallEngine) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
