# Lain IO

Lain IO is an Expo / React Native starter for a Serial Experiments Lain-inspired social space. It includes a sign-in landing screen, a feed, a Three.js avatar scene, a connections list, settings, and a GunDB feed adapter.

## Run

1. Copy `.env.example` to `.env` and add Google OAuth client IDs and a reachable Gun relay URL.
2. Install dependencies with `npm install`.
3. Start Expo with `npx expo start`.

The Apple sign-in capability is configured for iOS in `app.json`; Apple sign-in requires an iOS development build with the entitlement enabled. The Google flow uses Expo AuthSession and requires OAuth client IDs plus a development build/deep-link configuration for production use. Both providers currently unlock the local app session; a trusted backend still needs to validate provider tokens and issue durable app sessions before production.

The 3D view loads the bundled `lain.glb` model with Three.js through `expo-gl`. The current GLB has no image textures; its Japanese material names are mapped to the app palette at runtime. Keep the model at the project root or update the asset path in `src/AvatarScene.tsx` and `metro.config.js` if you move it. Three.js is pinned to 0.162.0 because Expo GL exposes WebGL 1.

Gun posts publish to the `lain-io/feed` graph and incoming peer posts are observed in the feed. Add a Gun relay URL to `EXPO_PUBLIC_GUN_PEERS` for cross-device sync. The starter does not include a relay server, account graph, encrypted messaging, or production persistence configuration; deploy and secure a relay before sharing real user data.
