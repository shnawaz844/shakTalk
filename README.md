# ShakTranslate 🌍

ShakTranslate is a real-time, two-user AI voice translation application built with React Native (Expo) and Node.js. It leverages Google's Gemini Multimodal API to provide low-latency, bidirectional audio translation between users in different languages.

## 🚀 Features

- **Real-time Voice Translation**: Send audio chunks and receive translated audio instantly.
- **Two-User Sessions**: QR-based pairing allows two users to join a private translation session.
- **Gemini AI Integration**: Uses the latest Gemini 2.0 Flash models for high-quality translation and TTS.
- **Bidirectional Support**: Both users can speak and hear translations in their respective languages.

---

## 🛠️ Project Structure

- `/` (Root): Expo React Native application (Frontend).
- `/backend`: Node.js WebSocket relay and AI processing server.
- `/src`: Frontend source code, components, and services.

---

## ⚙️ Setup & Installation

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended)
- [Expo Go](https://expo.dev/go) app on your mobile device OR an Android/iOS emulator.
- [Google Gemini API Key](https://aistudio.google.com/)

### 2. Backend Setup
1. Navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables:
   - Create a `.env` file in `/backend` (if not already present).
   - Add your Gemini API key and desired port:
     ```env
     GEMINI_API_KEY=your_api_key_here
     PORT=8080
     ```
4. Start the backend server:
   ```bash
   npm start
   # Or for development with auto-reload:
   npm run dev
   ```

### 3. Frontend Setup
1. Navigate back to the root directory:
   ```bash
   cd ..
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables:
   - Create a `.env` file in the root directory.
   - Add the Expo public API key:
     ```env
     EXPO_PUBLIC_GEMINI_API_KEY=your_api_key_here
     ```
4. **Important: Update WebSocket URL**
   - Open `src/config.ts`.
   - Update `WS_URL` to match your machine's local IP address if testing on a real device (e.g., `ws://192.168.1.XX:8080`).
5. Start the Expo app:
   ```bash
   npx expo start
   ```

---

## 📱 How to Use

1. **Start the Backend**: Ensure the Node.js server is running and accessible.
2. **Launch the App**: Open the app using Expo Go or an emulator.
3. **Host a Session**:
   - One user taps "Host Session".
   - Select the target languages.
   - A QR code will be generated.
4. **Join a Session**:
   - The second user taps "Join Session".
   - Scan the host's QR code.
5. **Translate**:
   - Press and hold the "Push to Talk" button to speak.
   - The app will stream your audio to the backend, translate it via Gemini, and play it back for the other user.

---

## 📄 License
MIT


## ⚙️ Translation Engine & Model Configuration

The project supports both engines, configurable via environment variables:

| Engine | Model | Backend | How to enable |
|---|---|---|---|
| **Legacy (DEFAULT)** | `gemini-live-2.5-flash-native-audio` | Google Cloud Vertex AI (GCP Service Account) | Default (No env needed, or set `EXPO_PUBLIC_CALL_ENGINE=legacy`) |
| **LiveKit** | `gemini-3.5-live-translate-preview` | LiveKit Bot + Google AI Studio (API Key) | Set `EXPO_PUBLIC_CALL_ENGINE=livekit` |

### Switching via Environment:
- **In Mobile App (`.env` or EAS build profile):**
  - Default: Uses `gemini-live-2.5-flash-native-audio`
  - To test Gemini 3.5: `EXPO_PUBLIC_CALL_ENGINE=livekit` (or `EXPO_PUBLIC_TRANSLATION_MODEL=gemini-3.5`)
- **In Backend (`backend/.env`):**
  - `DEFAULT_CALL_ENGINE=legacy` (or `livekit`)
  - `GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio`
  - `GEMINI_TRANSLATE_MODEL=gemini-3.5-live-translate-preview`

---

## BUILD COMMAND 

For development = eas build --profile development --platform android  --clear-cache
For proview = eas build --profile preview --platform android  --clear-cache *
For Production = eas build --profile production --platform android  --clear-cache

For development = eas build --profile development --platform ios  --clear-cache
For proview = eas build --profile preview --platform ios  --clear-cache
For Production = eas build --profile production --platform ios  --clear-cache *



## Submit Build to IOS (app specific password)

$env:EXPO_APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"; eas submit --platform ios --latest ....
