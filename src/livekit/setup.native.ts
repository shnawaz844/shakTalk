import { registerGlobals } from '@livekit/react-native';

/** Installs WebRTC into the JS runtime (native only). Call once, before rendering. */
export function setupLiveKit() {
  registerGlobals();
}
