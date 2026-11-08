#!/usr/bin/env node
// LainCorp admin CLI. Connects to a relay and signs with a service key.
//
//   node relay/tools/admin.js <command> [args]   (env RELAY=wss://host/gun, KEYS=relay/keys)
//
// Moderation (moderation key):
//   ban-user <pub> <reason>        unban-user <pub>
//   ban-post <authorPub/postId> <reason>   unban-post <authorPub/postId>
//   ban-media <sha256> <reason>    unban-media <sha256>
//   reports [YYYY-MM-DD]           decrypt and print that day's reports (default today)
// Releases (release key):
//   publish-model <file.json>      {version,url,sha256,size,minAppVersion,notes}
//   retire-model <version>
//   publish-relay <id> <wss-url> <region> <operator>
//   remove-relay <id>

'use strict';

const fs = require('fs');
const path = require('path');
const Gun = require('gun');
const SEA = require('gun/sea');

const RELAY = process.env.RELAY || 'http://127.0.0.1:8765/gun';
const KEYS = path.resolve(process.env.KEYS || path.join(__dirname, '..', 'keys'));
const loadPair = (name) => JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), 'utf8'));

const gun = Gun({ peers: [RELAY], localStorage: false, radisk: false, file: false, axe: false, multicast: false });
const auth = (pair) => new Promise((resolve, reject) => gun.user().auth(pair, (ack) => (ack.err ? reject(new Error(ack.err)) : resolve())));
const put = (node, value) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve('queued (no ack within 8 s)'), 8000);
  node.put(value, (ack) => { clearTimeout(timer); ack.err ? reject(new Error(ack.err)) : resolve('ok'); });
});
const done = (msg) => { console.log(msg); setTimeout(() => process.exit(0), 300); };

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const modKey = (ref) => ref.replace(/\//g, '|');
  const record = (reason) => JSON.stringify({ reason: reason || 'policy', at: Date.now() });

  switch (cmd) {
    case 'ban-user': case 'unban-user': case 'ban-post': case 'unban-post': case 'ban-media': case 'unban-media': {
      await auth(loadPair('moderation'));
      const kind = cmd.endsWith('user') ? 'pubs' : cmd.endsWith('post') ? 'posts' : 'media';
      const key = kind === 'posts' ? modKey(args[0]) : args[0];
      if (!key) throw new Error('missing target');
      const value = cmd.startsWith('ban') ? record(args.slice(1).join(' ')) : null;
      return done(`${cmd} ${key}: ${await put(gun.user().get('moderation').get(kind).get(key), value)}`);
    }
    case 'reports': {
      const pair = loadPair('moderation');
      const day = args[0] || new Date().toISOString().slice(0, 10);
      const seen = new Set();
      gun.get(`lain-io/reports/${day}#`).map().once(async (value, key) => {
        if (seen.has(key) || typeof value !== 'string') return;
        seen.add(key);
        try {
          const box = JSON.parse(value);
          const report = await SEA.decrypt(box.c, await SEA.secret(box.e, pair));
          console.log(JSON.stringify(report, null, 2));
        } catch { console.log(`(unreadable report ${key})`); }
      });
      return setTimeout(() => done(`${seen.size} report(s) for ${day}`), 5000);
    }
    case 'publish-model': {
      await auth(loadPair('release'));
      const m = JSON.parse(fs.readFileSync(args[0], 'utf8'));
      if (!m.version || !/^https:\/\//.test(m.url) || !/^[0-9a-f]{64}$/i.test(m.sha256) || !(m.size > 0)) throw new Error('need version, https url, sha256 (hex), size');
      const rec = { version: m.version, url: m.url, sha256: m.sha256.toLowerCase(), size: m.size, minAppVersion: m.minAppVersion || '1.0.0', notes: m.notes || '', createdAt: Date.now() };
      return done(`publish ${m.version}: ${await put(gun.user().get('models').get(m.version), JSON.stringify(rec))}`);
    }
    case 'retire-model': {
      await auth(loadPair('release'));
      return done(`retire ${args[0]}: ${await put(gun.user().get('models').get(args[0]), null)}`);
    }
    case 'publish-relay': {
      await auth(loadPair('release'));
      const [id, url, region, operator] = args;
      if (!id || !/^wss?:\/\//.test(url || '')) throw new Error('usage: publish-relay <id> <wss-url> <region> <operator>');
      return done(`relay ${id}: ${await put(gun.user().get('relays').get(id), JSON.stringify({ id, url, region: region || '', operator: operator || '' }))}`);
    }
    case 'remove-relay': {
      await auth(loadPair('release'));
      return done(`remove relay ${args[0]}: ${await put(gun.user().get('relays').get(args[0]), null)}`);
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
