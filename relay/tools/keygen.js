#!/usr/bin/env node
// Generate the LainCorp service accounts (registrar, moderation, release, archivist) and print the env lines.
//   node relay/tools/keygen.js [outDir=relay/keys]
// Keep the *.json files offline / in a secrets manager. Only the public keys go
// in the app's .env.

'use strict';

const fs = require('fs');
const path = require('path');
const SEA = require('gun/sea');

(async () => {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'keys'));
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const pairs = {};
  for (const name of ['registrar', 'moderation', 'release', 'archivist']) {
    const file = path.join(outDir, `${name}.json`);
    if (fs.existsSync(file)) { pairs[name] = JSON.parse(fs.readFileSync(file, 'utf8')); continue; }
    pairs[name] = await SEA.pair();
    fs.writeFileSync(file, JSON.stringify(pairs[name], null, 2), { mode: 0o600 });
  }
  console.log(`Key files in ${outDir} (private — never commit).\n`);
  console.log('# App (.env)');
  console.log(`EXPO_PUBLIC_LAIN_REGISTRAR_PUB=${pairs.registrar.pub}`);
  console.log(`EXPO_PUBLIC_LAIN_MODERATION_PUB=${pairs.moderation.pub}`);
  console.log(`EXPO_PUBLIC_LAIN_MODERATION_EPUB=${pairs.moderation.epub}`);
  console.log(`EXPO_PUBLIC_LAIN_RELEASE_PUB=${pairs.release.pub}`);
  console.log(`EXPO_PUBLIC_LAIN_ARCHIVIST_PUB=${pairs.archivist.pub}`);
  console.log('\n# Cloudflare relay (archivist signs the keep list of top posts)');
  console.log(`ARCHIVIST_PUB=${pairs.archivist.pub}   (wrangler vars)`);
  console.log('ARCHIVIST_PAIR: printf %s "$(cat relay/keys/archivist.json)" | npx wrangler secret put ARCHIVIST_PAIR');
  console.log('\n# Main relay (registrar node)');
  console.log(`REGISTRAR_PAIR='${JSON.stringify(pairs.registrar)}'`);
  console.log(`MODERATION_PUB=${pairs.moderation.pub}`);
  process.exit(0);
})();
