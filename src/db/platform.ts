// Platform adapters. The database layer never imports Expo modules directly,
// so it runs the same in the app (expoPlatform.ts) and in Node tests.

/** Synchronous local key/value storage, namespaced. On device: SQLCipher-encrypted SQLite. */
export interface LocalKV {
  get(ns: string, key: string): string | null;
  set(ns: string, key: string, value: string): void;
  del(ns: string, key: string): void;
  list(ns: string, prefix?: string): Array<{ key: string; value: string }>;
  clear(ns: string): void;
  /** Delete every namespace that starts with `nsPrefix`. */
  clearPrefix(nsPrefix: string): void;
}

/** OS secure storage (Keychain / Android Keystore). Small values only (< 2 KB). */
export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface Platform {
  kv: LocalKV;
  secure: SecureKV;
  /** Persist Gun's graph locally (radisk). Off in tests. */
  persistGun: boolean;
  fetch: typeof fetch;
}

export function memoryKV(): LocalKV {
  const data = new Map<string, Map<string, string>>();
  const bucket = (ns: string) => {
    let b = data.get(ns);
    if (!b) data.set(ns, (b = new Map()));
    return b;
  };
  return {
    get: (ns, key) => bucket(ns).get(key) ?? null,
    set: (ns, key, value) => { bucket(ns).set(key, value); },
    del: (ns, key) => { bucket(ns).delete(key); },
    list: (ns, prefix = '') => [...bucket(ns).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value })),
    clear: (ns) => { data.delete(ns); },
    clearPrefix: (nsPrefix) => { for (const ns of [...data.keys()]) if (ns.startsWith(nsPrefix)) data.delete(ns); },
  };
}

export function memorySecure(): SecureKV {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => { data.set(key, value); },
    del: async (key) => { data.delete(key); },
  };
}
