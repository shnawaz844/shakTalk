import { storage } from './storageCompat';
import { CALL_ENGINE } from '../config';

const ENGINE_STORAGE_KEY = 'shak_call_engine_preference';
const PLAN_TIER_STORAGE_KEY = 'shak_subscription_tier_preference';

export type CallEngine = 'legacy' | 'livekit';
export type PlanTier = 'payg' | 'starter' | 'pro' | 'business' | 'trial';

let currentEngine: CallEngine = CALL_ENGINE;
let currentPlanTier: PlanTier = 'starter';

// Listeners for live state updates across screens
const listeners = new Set<(engine: CallEngine) => void>();
const tierListeners = new Set<(tier: PlanTier) => void>();

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

export async function getStoredPlanTier(): Promise<PlanTier> {
  try {
    const saved = await storage.getItem(PLAN_TIER_STORAGE_KEY);
    if (saved === 'payg' || saved === 'starter' || saved === 'pro' || saved === 'business' || saved === 'trial') {
      currentPlanTier = saved;
      return saved;
    }
  } catch (_) {}
  return currentPlanTier;
}

export async function setStoredPlanTier(tier: PlanTier): Promise<void> {
  currentPlanTier = tier;
  tierListeners.forEach(cb => cb(tier));
  try {
    await storage.setItem(PLAN_TIER_STORAGE_KEY, tier);
  } catch (_) {}
}

export function getCurrentPlanTier(): PlanTier {
  return currentPlanTier;
}

export function subscribePlanTierChange(cb: (tier: PlanTier) => void): () => void {
  tierListeners.add(cb);
  return () => tierListeners.delete(cb);
}
