// Lain IO database layer: the only module the GUI should import.
//
//   import { initDb, getDb } from './src/db/native';   // in the app (Expo)
//   const db = await initDb();                           // once, at startup
//   db.session                                           // null until signed in
//   await db.signUp({ username, password, email })       // email optional
//   db.social.subscribeDiscovery(setPosts)               // returns unsubscribe
//
// See docs/DB-LAYER.md for the full API and how to wire each screen.

import { setWebCrypto } from '@privacyresearch/libsignal-protocol-typescript';
import { Auth, InvalidCredentialsError, checkPassword, validateEmail } from './auth';
import { type LainDbConfig, configFromEnv } from './config';
import { type Ctx, SEA, createGun, postJson } from './graph';
import { LainData } from './lain';
import { Messenger } from './messages/messenger';
import { Moderation } from './moderation';
import type { Platform } from './platform';
import { Profiles, shortFingerprint } from './profiles';
import { Registry } from './registry';
import { SafetyStore, SettingsStore } from './settings';
import { Social } from './social';
import type { AuthResult, SEAPair, Session, Unsubscribe } from './types';
import { USERNAME_RULE, UsernameTakenError, Usernames, normalizeUsername, validateUsername } from './usernames';

export * from './types';
export { USERNAME_RULE, UsernameTakenError, InvalidCredentialsError, normalizeUsername, validateUsername, checkPassword, validateEmail, shortFingerprint };
export type { LainDbConfig } from './config';
export type { Platform } from './platform';
export { MAX_POST_LENGTH, makeRef, parseRef } from './social';
export { newId } from './encoding';

export class LainDb {
  readonly ctx: Ctx;
  readonly usernames: Usernames;
  readonly profiles: Profiles;
  readonly settings: SettingsStore;
  readonly safety: SafetyStore;
  readonly moderation: Moderation;
  readonly social: Social;
  readonly messages: Messenger;
  readonly lain: LainData;
  readonly registry: Registry;
  private auth: Auth;
  private sessionListeners = new Set<(session: Session | null) => void>();
  private extraPeers = new Set<string>();

  private constructor(platform: Platform, config: LainDbConfig) {
    const listeners = new Map<string, Set<(payload: any) => void>>();
    this.ctx = {
      gun: createGun(platform, config.peers),
      platform,
      config,
      session: null,
      pair: null,
      emit: (event, payload) => { for (const cb of listeners.get(event) ?? []) cb(payload); },
      on: (event, cb) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
        return () => { listeners.get(event)?.delete(cb); };
      },
    };
    this.usernames = new Usernames(this.ctx);
    this.auth = new Auth(this.ctx, this.usernames);
    this.profiles = new Profiles(this.ctx, this.usernames);
    this.settings = new SettingsStore(this.ctx);
    this.safety = new SafetyStore(this.ctx);
    this.moderation = new Moderation(this.ctx);
    this.social = new Social(this.ctx, this.moderation, this.safety);
    this.messages = new Messenger(this.ctx, this.safety, this.moderation);
    this.lain = new LainData(this.ctx);
    this.registry = new Registry(this.ctx);
    this.settings.subscribe((s) => this.addPeers(s.relays));
  }

  /** Create the database and restore the saved session, if any. */
  static async create(options: { platform: Platform; config?: Partial<LainDbConfig> }): Promise<LainDb> {
    if (!globalThis.crypto?.subtle) throw new Error('WebCrypto is missing. Import src/db/polyfills before anything else.');
    setWebCrypto(globalThis.crypto as any);
    const db = new LainDb(options.platform, { ...configFromEnv(), ...options.config });
    db.moderation.start();
    try {
      const saved = await db.auth.restore();
      if (saved) await db.startSession(saved.pair, saved.username, false);
    } catch (error) {
      console.warn('[lain-db] could not restore session', error);
    }
    return db;
  }

  // ---------- session ----------

  get session(): Session | null { return this.ctx.session; }

  onSession(cb: (session: Session | null) => void): Unsubscribe {
    this.sessionListeners.add(cb);
    cb(this.ctx.session);
    return () => { this.sessionListeners.delete(cb); };
  }

  async isUsernameAvailable(username: string): Promise<boolean> { return this.usernames.isAvailable(username); }

  /** Create an account. With `email`, also sets up email recovery and returns the recovery code to show once. */
  async signUp(input: { username: string; password: string; email?: string }): Promise<AuthResult> {
    const { pair, username } = await this.auth.signUp(input);
    await this.startSession(pair, username, true);
    if (!input.email) return { session: this.ctx.session! };
    const { recoveryCode, emailSent } = await this.auth.setRecoveryEmail(input.email);
    return { session: this.ctx.session!, recoveryCode, emailSent };
  }

  async signIn(input: { username: string; password: string }): Promise<AuthResult> {
    const { pair, username } = await this.auth.signIn(input);
    await this.startSession(pair, username, false);
    return { session: this.ctx.session! };
  }

  /** `wipeLocal` also deletes this device's copy of messages and Lain data (use on shared devices). */
  async signOut({ wipeLocal = false } = {}): Promise<void> {
    const pub = this.ctx.session?.pub;
    this.stopSession();
    await this.auth.signOut();
    if (wipeLocal && pub) this.ctx.platform.kv.clearPrefix(`${pub}:`);
    this.notifySession();
  }

  /** Forgot password: emailed code + new password. Signs in on success. */
  async recoverAccount(input: { username: string; code: string; newPassword: string }): Promise<AuthResult> {
    const result = await this.auth.recover(input);
    await this.startSession(result.pair, result.username, false);
    return { session: this.ctx.session!, recoveryCode: result.newRecoveryCode, emailSent: result.emailSent };
  }

  changePassword(currentPassword: string, newPassword: string) { return this.auth.changePassword(currentPassword, newPassword); }
  setRecoveryEmail(email: string) { return this.auth.setRecoveryEmail(email); }
  getRecoveryEmail() { return this.auth.getRecoveryEmail(); }
  removeRecoveryEmail() { return this.auth.removeRecoveryEmail(); }

  /** In-app account deletion (App Store 5.1.1(v) / Play). Needs the password. Irreversible. */
  async deleteAccount(password: string): Promise<void> {
    if (!(await this.auth.verifyPassword(password))) throw new InvalidCredentialsError();
    const pair = this.ctx.pair!;
    const username = this.ctx.session!.username;
    await this.social.wipeMine();
    await this.lain.wipeMine();
    await this.settings.wipe();
    await this.safety.wipe();
    await this.profiles.wipeMine();
    await this.messages.wipeMine();
    await this.auth.wipeAuthRecords();
    await this.usernames.release(username, pair);
    const request = await SEA.sign({ pub: pair.pub, action: 'purge', at: Date.now() }, pair);
    await postJson(this.ctx, '/lain/account/purge', { pub: pair.pub, request });
    await this.signOut({ wipeLocal: true });
  }

  // ---------- internals ----------

  private async startSession(pair: SEAPair, username: string, isNew: boolean) {
    this.stopSession();
    this.ctx.pair = pair;
    this.ctx.session = { pub: pair.pub, epub: pair.epub, username, deviceId: 0 };
    this.settings.start();
    this.safety.start();
    this.lain.start();
    if (isNew) await this.profiles.createMine(username);
    else if (!(await this.profiles.get(pair.pub))) await this.profiles.createMine(username);
    try {
      await this.messages.start();
    } catch (error) {
      console.warn('[lain-db] messaging could not start; retrying in 30 s', error);
      setTimeout(() => { if (this.ctx.pair === pair) void this.messages.start().catch(() => {}); }, 30_000);
    }
    this.notifySession();
  }

  private stopSession() {
    this.messages.stop();
    this.lain.stop();
    this.settings.stop();
    this.safety.stop();
    this.ctx.pair = null;
    this.ctx.session = null;
  }

  private notifySession() { for (const cb of this.sessionListeners) cb(this.ctx.session); }

  private addPeers(relays: string[]) {
    const fresh = relays.filter((url) => /^wss?:\/\//.test(url) && !this.extraPeers.has(url));
    if (!fresh.length) return;
    for (const url of fresh) this.extraPeers.add(url);
    this.ctx.gun.opt({ peers: fresh });
  }
}

let instance: LainDb | null = null;
let pending: Promise<LainDb> | null = null;

/** Create the app-wide instance once. Later calls return the same instance. */
export function initDb(options: { platform: Platform; config?: Partial<LainDbConfig> }): Promise<LainDb> {
  if (instance) return Promise.resolve(instance);
  if (!pending) pending = LainDb.create(options).then((db) => (instance = db));
  return pending;
}

/** The app-wide instance. Throws before initDb() finished. */
export function getDb(): LainDb {
  if (!instance) throw new Error('Call initDb() first.');
  return instance;
}
