#!/usr/bin/env node
// Local device-testing setup:
//   1. creates (or reuses) the registrar / moderation / release keys in relay/keys
//   2. writes relay/.env.relay for docker compose
//   3. sets the EXPO_PUBLIC_* lines in the app's .env (other lines are kept)
// The phone reaches the relay through `adb reverse tcp:8765 tcp:8765`, so the
// app points at localhost.
//   node relay/tools/dev-setup.js [relayUrlBase=http://localhost:8765]

'use strict';

const fs = require('fs');
const path = require('path');
const SEA = require('gun/sea');

(async () => {
  const base = (process.argv[2] || 'http://localhost:8765').replace(/\/+$/, '');
  const relayDir = path.join(__dirname, '..');
  const appDir = path.join(relayDir, '..');
  const keysDir = path.join(relayDir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });

  const pairs = {};
  for (const name of ['registrar', 'moderation', 'release']) {
    const file = path.join(keysDir, `${name}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(await SEA.pair(), null, 2), { mode: 0o600 });
    pairs[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  fs.writeFileSync(path.join(relayDir, '.env.relay'), [
    `REGISTRAR_PAIR=${JSON.stringify(pairs.registrar)}`,
    `MODERATION_PUB=${pairs.moderation.pub}`,
    '',
  ].join('\n'), { mode: 0o600 });

  const appEnv = {
    EXPO_PUBLIC_GUN_PEERS: `${base}/gun`,
    EXPO_PUBLIC_LAIN_SERVICE_URL: base,
    EXPO_PUBLIC_LAIN_REGISTRAR_PUB: pairs.registrar.pub,
    EXPO_PUBLIC_LAIN_MODERATION_PUB: pairs.moderation.pub,
    EXPO_PUBLIC_LAIN_MODERATION_EPUB: pairs.moderation.epub,
    EXPO_PUBLIC_LAIN_RELEASE_PUB: pairs.release.pub,
  };
  const envFile = path.join(appDir, '.env');
  const kept = (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '')
    .split('\n').filter((line) => line.trim() && !Object.keys(appEnv).some((k) => line.startsWith(`${k}=`)));
  fs.writeFileSync(envFile, [...kept, ...Object.entries(appEnv).map(([k, v]) => `${k}=${v}`), ''].join('\n'));

  console.log(`Keys:            ${keysDir}`);
  console.log(`Relay env:       ${path.join(relayDir, '.env.relay')}`);
  console.log(`App env:         ${envFile}  (relay at ${base})`);
  process.exit(0);
})();
