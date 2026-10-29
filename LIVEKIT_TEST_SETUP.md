# `test` branch: WebRTC call + Gemini Live Translate

This branch changes how a ShakTalk call works:

| | Before (legacy engine) | This branch (LiveKit engine) |
|---|---|---|
| Partner's real voice | Not heard | Heard right away (WebRTC, like WhatsApp), at 25% volume |
| Translation model | `gemini-live-2.5-flash-native-audio` (waits for the speaker to pause) | `gemini-3.5-live-translate-preview` (translates while the speaker talks) |
| Translated voice | Arrives after the turn ends (3–24 s in tests) | Streams continuously; Google says it stays "a few seconds" behind |
| Echo handling | App mutes the mic while translation plays | Phone's built-in echo cancellation (WebRTC); mic never muted |
| Android mic | Raw mic, no noise suppression | Voice-call mode with echo cancellation + noise suppression |

The UI is unchanged. The old engine is still in the code and can be switched back on (see the end of this file).

## How it works

```
Phone A (host) ──mic──►┐                      ┌──► Phone B hears: A's voice (25%) + "translation-of-host" (100%)
                       │   LiveKit room       │
Phone B (guest) ─mic──►┤  (named = session)   ├──► Phone A hears: B's voice (25%) + "translation-of-guest" (100%)
                       │                      │
     translator bot ◄──┘  (runs inside our    └── bot publishes the two translation tracks
     backend: mic → Gemini Live Translate → track)
```

The existing WebSocket server still handles session create/join, subtitles, transcripts and the database. New files:

- `backend/translatorBot.js`: joins the room and pipes each mic through Gemini into a translation track.
- `backend/liveTranslate.js`: Gemini Live Translate connection, with reconnect/resume and latency logging.
- `src/livekit/useLiveKitCall.ts`: the call (join, publish mic, play partner voice + translation).
- `src/screens/LiveCallScreen.tsx`: the call screen for this engine. It uses the same layout and styles as `SessionScreen`.

## 1. LiveKit server (pick one)

**A. LiveKit Cloud (fastest for testing).** Create a project at cloud.livekit.io. From the project settings, copy the WebSocket URL (`wss://<project>.livekit.cloud`), the API key and the API secret.

**B. Self-host on our EC2.** Run `livekit-server` (Docker image `livekit/livekit-server`) next to the backend. It needs:
- TLS in front of port 7880 (for example `wss://lk.shaktalk.com` via nginx/Caddy)
- port 7881/tcp and 50000–60000/udp open in the security group
- TURN enabled in its config, for phones on strict mobile networks

See docs.livekit.io → Self-hosting.

## 2. Backend environment variables

Add to the backend `.env` (the existing Vertex variables stay as they are):

```env
# LiveKit (required for the new engine)
LIVEKIT_URL=wss://<your-livekit-host>
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
# Optional: internal address for the bot if LiveKit runs on the same machine
# LIVEKIT_BOT_URL=ws://127.0.0.1:7880

# Gemini Live Translate (defaults shown)
GEMINI_TRANSLATE_MODEL=gemini-3.5-live-translate-preview
GEMINI_TRANSLATE_BACKEND=vertex          # or "apikey"
# GEMINI_TRANSLATE_LOCATION=asia-south1  # defaults to GOOGLE_CLOUD_LOCATION
# GEMINI_API_KEY=...                     # only for GEMINI_TRANSLATE_BACKEND=apikey
# GEMINI_TRANSLATE_ECHO_TARGET=false     # default false (true caused wrong translations in tests): also speak words already in the listener's language
#                                        # (replaces the old GEMINI_TRANSLATE_ECHO, whose value was read inverted)
# GEMINI_TRANSLATE_SKIP_SILENCE=false    # true = don't stream silence to Gemini (saves input cost)

# Login checks (see backend/auth.js)
# AUTH_ENFORCE=true                      # set false ONLY while old app builds without login tokens are in use
# CLERK_JWT_KEY=...                      # optional: Clerk JWT public key, verifies tokens without a network call
# DIAGNOSTICS_KEY=...                    # optional: protects /gemini-test (call /gemini-test?key=...)
```

Then `cd backend && npm install` and restart.

- The Docker image now uses `node:20-bookworm-slim`, because LiveKit's native library doesn't run on Alpine.
- On plain EC2 (Ubuntu or Amazon Linux), nothing extra is needed.

**If the server log shows `[liveTranslate] ... connect failed`:** the preview model may not be on Vertex in our region yet. Try `GEMINI_TRANSLATE_LOCATION=us-central1` first. If that also fails, use `GEMINI_TRANSLATE_BACKEND=apikey` with a key from Google AI Studio, which is where Google launched the model. Google's announcements only mention the Gemini API and AI Studio, not Vertex.

## 3. App build

The branch adds native modules (WebRTC), so **a new build is required. An OTA update (`eas update`) won't work.**

- The app version is bumped to **1.1.0**, so OTA updates from this branch can't reach older installs and crash them.
- **Both phones must run the new build.** If an old build tries to call a new one, it gets a clear "same app version" error.

```sh
npm install
eas build --profile development --platform android   # and/or ios
```

## 4. What to test

1. **Call and voices:** start a call between two phones (for example Hindi ↔ English). Each person should hear the other's real voice immediately and quietly, with the translation on top.
2. **Long speech:** talk for 10–20 s without stopping. The translation should start while you're still talking.
3. **Echo:** both phones on loudspeaker. Nothing should get re-translated.
4. **Controls:** mute, speaker/earpiece, end call, subtitles and the transcript panel.
5. **Long call:** stay on a call for 15+ minutes.

Server log lines to collect:

- `[LATENCY][translate] <session>:host→English: translated audio started 1234ms after the speaker started talking`. This is the number to report: speech start → first translated audio.
- `[liveTranslate] ... ready (Xms)`: connection time to Gemini.
- `[translatorBot] ... receiving host mic`: the bot is hearing each phone.

## Echo protection (loudspeaker)

Two layers stop a phone's loudspeaker from being picked up by its own mic and translated again:

1. **On the phone (Android):** `patches/@livekit+react-native+3.0.0.patch` makes LiveKit use WebRTC's software echo canceller (AEC3) instead of the phone's hardware one, whose quality varies by brand. `patch-package` applies it automatically on `npm install` (`postinstall`), so EAS builds include it. A new app build is needed. iOS already uses Apple's voice-processing echo canceller.
2. **On the server:** `backend/echoGuard.js`. While the server is playing translation to someone (plus a short tail), it replaces that person's mic with silence before it reaches Gemini. If they clearly talk over the translation, their voice gets through (barge-in), including their first words.

Server log: `[echoGuard] <session>:host: guarded N mic frames during playback, let M barge-in frames through (echo level ~X)`.

Tuning (backend `.env`, all optional):

| Variable | Default | When to change |
|---|---|---|
| `ECHO_GUARD` | on | `off` to disable it for comparison |
| `ECHO_GUARD_TAIL_MS` | 700 | Raise (for example to 1000) if echo still leaks right after a translation ends |
| `ECHO_GUARD_BARGE_RMS` | 2500 | Raise if echo still gets through as "barge-in"; lower if people can't interrupt |
| `ECHO_GUARD_BARGE_RATIO` | 3 | How much louder than the measured echo real speech must be |

## Known limits of this branch

- **Preview model.** Developers report three problems:
  - occasional wrong output language
  - the voice drifting during long sessions
  - no way to pin the voice

  The gender/age voice setting from onboarding isn't used by this engine; the model imitates the speaker's voice instead.
- **Recordings.** Call audio isn't saved to storage in this engine. Text transcripts are still saved to the database.
- **Cantonese** maps to Traditional Chinese (`zh-Hant`), because the model has no separate Cantonese target.

## Switching back to the old engine

Set `EXPO_PUBLIC_CALL_ENGINE=legacy` in the EAS build profile's `env` and rebuild. The app then uses the original `SessionScreen` path, which includes the fixes from PR #2.

## Website (www.shaktalk.com)

The backend now also serves the public website from `backend/public/` (`backend/website.js`):
`/`, `/privacy`, `/terms`, `/support`, `/delete-account`, plus the join page `/join/<id>`.

Set these in the backend `.env` before launch:

```env
SUPPORT_EMAIL=support@shaktalk.com
COMPANY_NAME=...                 # legal entity shown in Privacy/Terms
COMPANY_ADDRESS=...              # registered address
GRIEVANCE_OFFICER=...            # name (required in India)
GOVERNING_LAW=India
POLICY_DATE=1 November 2026
APP_STORE_URL=                   # set once Apple approves; until then the button says "Coming soon"
# PLAY_STORE_URL defaults to the com.cis.shaktranslate listing
APPLE_TEAM_ID=...                # developer.apple.com > Membership: makes iOS open /join links in the app
ANDROID_SHA256_FINGERPRINTS=...  # Play Console > App integrity > App signing key SHA-256 (comma-separate several)
```

Store listing URLs: Privacy `https://www.shaktalk.com/privacy`, Support `https://www.shaktalk.com/support`,
Account deletion (Google Play) `https://www.shaktalk.com/delete-account`, Marketing `https://www.shaktalk.com`.
