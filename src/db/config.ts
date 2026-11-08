// Runtime configuration. Values come from EXPO_PUBLIC_* env vars (see
// .env.example) and can be overridden in initDb() / createLainDb().

export type LainDbConfig = {
  /** Gun relay URLs, e.g. wss://relay.example.com/gun */
  peers: string[];
  /** HTTP base of the main relay's services (registrar, recovery mail, purge), e.g. https://relay.example.com */
  serviceUrl: string;
  /** Registrar account pub. When set, it is the only authority for username ownership. */
  registrarPub: string;
  /** Moderation account pub + epub. The signed moderation list lives in this account's space; reports are encrypted to the epub. */
  moderationPub: string;
  moderationEpub: string;
  /** Release account pub: signs the lain model registry and the relay list. */
  releasePub: string;
  /** PBKDF2-SHA256 iterations for new password vaults. */
  passwordIterations: number;
  /** Default wait for a single Gun read before treating it as missing. */
  readTimeoutMs: number;
  /** Mail envelopes older than this are ignored (relays drop them too). */
  mailRetentionDays: number;
};

// Expo inlines EXPO_PUBLIC_* only when written out literally as
// `process.env.EXPO_PUBLIC_NAME`, so each one is referenced explicitly.
const clean = (value: string | undefined): string => (value ?? '').trim();

export function configFromEnv(): LainDbConfig {
  return {
    peers: clean(process.env.EXPO_PUBLIC_GUN_PEERS).split(',').map((peer) => peer.trim()).filter(Boolean),
    serviceUrl: clean(process.env.EXPO_PUBLIC_LAIN_SERVICE_URL).replace(/\/+$/, ''),
    registrarPub: clean(process.env.EXPO_PUBLIC_LAIN_REGISTRAR_PUB),
    moderationPub: clean(process.env.EXPO_PUBLIC_LAIN_MODERATION_PUB),
    moderationEpub: clean(process.env.EXPO_PUBLIC_LAIN_MODERATION_EPUB),
    releasePub: clean(process.env.EXPO_PUBLIC_LAIN_RELEASE_PUB),
    passwordIterations: 600_000,
    readTimeoutMs: 3000,
    mailRetentionDays: 30,
  };
}
