import { registerRootComponent } from 'expo';

import App from './App';
import { CALL_ENGINE } from './src/config';
import { setupLiveKit } from './src/livekit/setup';

// WebRTC must be installed so either engine can be used dynamically (native only).
try {
  setupLiveKit();
} catch (e) {
  console.warn('[livekit] setupLiveKit init:', e);
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
