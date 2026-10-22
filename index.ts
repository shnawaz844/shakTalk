import { registerRootComponent } from 'expo';

import App from './App';
import { CALL_ENGINE } from './src/config';
import { setupLiveKit } from './src/livekit/setup';

// WebRTC must be installed before any LiveKit code runs (native only).
if (CALL_ENGINE === 'livekit') setupLiveKit();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
