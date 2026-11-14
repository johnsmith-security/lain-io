// Runtime configuration. Values come from EXPO_PUBLIC_* env vars (see
// .env.example) and can be overridden in initDb() / createLainDb().

export type LainDbConfig = {
  /** Gun relay URLs, e.g. wss://relay.example.com/gun */
  peers: string[];
  /** HTTP base of the main relay's services (registrar, recovery mail, purge), e.g. https://relay.example.com */
  serviceUrl: string;
  /** HTTP base for image/video upload and download. Empty: same as serviceUrl. */
  mediaUrl: string;
  /** Registrar account pub. When set, it is the only authority for username ownership. */
  registrarPub: string;
  /** Moderation account pub + epub. The signed moderation list lives in this account's space; reports are encrypted to the epub. */
  moderationPub: string;
  moderationEpub: string;
  /**
   * Single source of truth for moderation: the Cloudflare relay's signed list, e.g.
   * https://relay.lain.xn--tckwe/lain/moderation. Pulled at start and every few minutes, then
   * verified value by value against moderationPub, so the endpoint can't forge or alter bans.
   */
  moderationUrl: string;
  /**
   * Archivist account: signs the keep list (~ARCHIVIST/keep) of top posts that outlive retention.
   * Empty: retention isn't enforced by this client (nothing is hidden for age).
   */
  archivistPub: string;
  /** Posts last this long unless kept (plan §2b). */
  retentionDays: number;
  /** Day 0 of retention: posts created earlier count as created at this time (epoch ms). */
  retentionEpoch: number;
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
/** 2026-11-13T00:00:00Z: retention went live; posts from before count as made that day. */
export const RETENTION_EPOCH = 1_794_528_000_000;

export function configFromEnv(): LainDbConfig {
  return {
    peers: clean(process.env.EXPO_PUBLIC_GUN_PEERS).split(',').map((peer) => peer.trim()).filter(Boolean),
    serviceUrl: clean(process.env.EXPO_PUBLIC_LAIN_SERVICE_URL).replace(/\/+$/, ''),
    mediaUrl: clean(process.env.EXPO_PUBLIC_LAIN_MEDIA_URL).replace(/\/+$/, ''),
    registrarPub: clean(process.env.EXPO_PUBLIC_LAIN_REGISTRAR_PUB),
    moderationPub: clean(process.env.EXPO_PUBLIC_LAIN_MODERATION_PUB),
    moderationEpub: clean(process.env.EXPO_PUBLIC_LAIN_MODERATION_EPUB),
    moderationUrl: clean(process.env.EXPO_PUBLIC_LAIN_MODERATION_URL),
    archivistPub: clean(process.env.EXPO_PUBLIC_LAIN_ARCHIVIST_PUB),
    retentionDays: 30,
    retentionEpoch: RETENTION_EPOCH,
    releasePub: clean(process.env.EXPO_PUBLIC_LAIN_RELEASE_PUB),
    passwordIterations: 600_000,
    readTimeoutMs: 3000,
    mailRetentionDays: 30,
  };
}
