# Lain IO

Lain IO is an Expo / React Native starter for a Serial Experiments Lain-inspired social space. It includes a username onboarding screen, a feed, a Three.js avatar scene, a connections list, settings, and a GunDB feed adapter.

## Run

1. Copy `.env.example` to `.env` and add a reachable Gun relay URL.
2. Install dependencies with `npm install`.
3. Start Expo with `npx expo start`.

Accounts are username + password, with email used only for recovery. All storage runs on GunDB through the database layer in `src/db/` (guide: `docs/DB-LAYER.md`, test: `npm run test:db`). The relay lives in `relay/` (`npm run relay` for development). The onboarding screen in `App.tsx` still uses the older username-only `src/identity.ts` until the GUI is linked to `src/db`.

The 3D view loads the bundled `lain.glb` model with Three.js through `expo-gl`. The current GLB has no image textures; its Japanese material names are mapped to the app palette at runtime. Keep the model at the project root or update the asset path in `src/AvatarScene.tsx` and `metro.config.js` if you move it. Three.js is pinned to 0.162.0 because Expo GL exposes WebGL 1.

Gun posts publish to the `lain-io/feed` graph and incoming peer posts are observed in the feed. Add a Gun relay URL to `EXPO_PUBLIC_GUN_PEERS` for cross-device sync. The starter does not include a relay server, account graph, encrypted messaging, or production persistence configuration; deploy and secure a relay before sharing real user data.
# Android on-device Lain

The Android build now has a local Expo module for Google LiteRT-LM. It downloads the official Gemma 4 E2B LiteRT-LM mobile-quantized artifact on demand (about 2.6 GB on disk), keeps it in the app's private files, and runs chat inference on device. The artifact uses mixed 2-bit, 4-bit, and 8-bit weights; no extra quantization step is needed for this runtime. Voice input uses Android's on-device speech recognizer when the device provides one; spoken replies use an installed offline Android voice in the phone's language. If either local speech service is unavailable, typed chat remains available. The chat is kept in app memory and is not written to GunDB.

LiteRT-LM needs a custom Android app binary, so Expo Go cannot run this feature. After installing dependencies, build and install the Android development client with:

```sh
npx expo run:android
```

Open the Lain tab, tap **Download Gemma 4 E2B**, wait for the download and model initialization, then send a message or tap the microphone. The download can resume after a network interruption. Keep roughly 3 GB of free storage available. Android first tries the LiteRT GPU backend and falls back to CPU if that backend cannot initialize. Actual speed and memory use depend on the phone. To use voice, allow microphone access and install an offline speech recognition service and offline text-to-speech voice in Android settings.

The current `lain.glb` has a skeleton but no bundled animation clips or facial blend shapes. The app now drives subtle head, neck, and arm motion for idle, listening, thinking, and speaking states. Lip-sync will need mouth or jaw controls added to the model rig.

To inspect model download diagnostics while the Android app is open, run `adb logcat -s LainAiDownload`. The log records the request host, HTTP status, response length/range, progress every 100 MB, final file size, and failure details. The React Native log also prints the rejected native error.

The model is hosted by [LiteRT Community](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm) under Apache-2.0. The model is downloaded from Hugging Face at runtime; no model weights are committed to this repository or embedded in the app binary.
