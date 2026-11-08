// Device implementation of the platform adapters.
//  - LocalKV: one SQLite database, encrypted with SQLCipher (enabled by the
//    expo-sqlite config plugin, `useSQLCipher: true` in app.json). The 256-bit
//    database key is generated once and kept in the OS keystore.
//  - SecureKV: expo-secure-store (Keychain / Android Keystore), this device only.

import * as SecureStore from 'expo-secure-store';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { randomBytes } from './encoding';
import type { LocalKV, Platform, SecureKV } from './platform';

const DB_KEY = 'lain.dbkey.v1';
const secureOptions: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const expoSecure: SecureKV = {
  get: (key) => SecureStore.getItemAsync(key, secureOptions),
  set: (key, value) => SecureStore.setItemAsync(key, value, secureOptions),
  del: (key) => SecureStore.deleteItemAsync(key, secureOptions),
};

function sqliteKV(db: SQLiteDatabase): LocalKV {
  db.execSync('CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (ns, k)) WITHOUT ROWID;');
  return {
    get: (ns, key) => db.getFirstSync<{ v: string }>('SELECT v FROM kv WHERE ns = ? AND k = ?', ns, key)?.v ?? null,
    set: (ns, key, value) => { db.runSync('INSERT OR REPLACE INTO kv (ns, k, v) VALUES (?, ?, ?)', ns, key, value); },
    del: (ns, key) => { db.runSync('DELETE FROM kv WHERE ns = ? AND k = ?', ns, key); },
    list: (ns, prefix = '') => db.getAllSync<{ k: string; v: string }>(
      "SELECT k, v FROM kv WHERE ns = ? AND substr(k, 1, ?) = ? ORDER BY k", ns, prefix.length, prefix,
    ).map((row) => ({ key: row.k, value: row.v })),
    clear: (ns) => { db.runSync('DELETE FROM kv WHERE ns = ?', ns); },
    clearPrefix: (nsPrefix) => { db.runSync('DELETE FROM kv WHERE substr(ns, 1, ?) = ?', nsPrefix.length, nsPrefix); },
  };
}

export async function createExpoPlatform(): Promise<Platform> {
  let key = await expoSecure.get(DB_KEY);
  if (!key) {
    key = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
    await expoSecure.set(DB_KEY, key);
  }
  const db = openDatabaseSync('lain.db');
  // Must be the first statement on the connection. Ignored when SQLCipher isn't compiled in.
  db.execSync(`PRAGMA key = "x'${key}'";`);
  return { kv: sqliteKV(db), secure: expoSecure, persistGun: true, fetch: globalThis.fetch.bind(globalThis) };
}
