// Username + password accounts on Gun, with optional email recovery.
//
// - The account is a random SEA key pair (never derived from the password).
// - The pair is stored in the user's own Gun space, encrypted with a key
//   stretched from the password (PBKDF2-SHA256, 600k iterations): `~pub/auth/vault`.
//   Any device can sign in with username + password; no server is involved.
// - Email is used only for recovery: a random 160-bit recovery code encrypts a
//   second copy of the pair (`~pub/auth/recovery`). The code is emailed through
//   the relay's mail service (which does not store it) and shown once in the app.
//   Anyone who controls the inbox can reset the password, as with any email reset.
// - The encrypted vault is public, so a weak password can be guessed offline.
//   That is why passwords must be at least 12 characters.
// - Changing the password does not rotate the key pair. If an old password
//   leaked while the old vault was copied, the attacker keeps access. Key
//   rotation means a new account, which is out of scope for v1.

import { newRecoveryCode, normalizeRecoveryCode, randomBytes, safeJson, bytesToB64 } from './encoding';
import { type Ctx, SEA, decryptWith, encryptFor, meNode, postJson, putAck, readOnce, requirePair, userNode } from './graph';
import type { SEAPair } from './types';
import { normalizeUsername, validateUsername, UsernameTakenError, type Usernames } from './usernames';

const SESSION_KEY = 'lain.session.v1';

type Vault = { v: 1; kdf: 'PBKDF2-SHA256'; iter: number; salt: string; ct: string };

const COMMON = new Set(['password1234', '123456789012', 'qwertyuiop12', 'iloveyou1234', 'lainiwakura1', 'letmein12345', 'passwordpassword', 'wiredwired12']);

export function checkPassword(password: string, username = ''): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 256) return 'Use at most 256 characters.';
  if (/^(.)\1+$/.test(password)) return 'Avoid repeating a single character.';
  if (COMMON.has(password.toLowerCase())) return 'That password is too common.';
  const name = normalizeUsername(username);
  if (name && password.toLowerCase().includes(name)) return 'Don’t include your username in the password.';
  return null;
}

export function validateEmail(email: string): string | null {
  const value = email.trim();
  if (!value) return 'Enter an email address.';
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address.';
  return null;
}

export class InvalidCredentialsError extends Error {
  constructor() { super('Username or password is incorrect.'); this.name = 'InvalidCredentialsError'; }
}

export class Auth {
  constructor(private ctx: Ctx, private usernames: Usernames) {}

  // ---------- session ----------

  async restore(): Promise<{ pair: SEAPair; username: string } | null> {
    const saved = safeJson<{ pair: SEAPair; username: string }>(await this.ctx.platform.secure.get(SESSION_KEY));
    if (!saved?.pair?.pub || !saved.username) return null;
    await this.authGun(saved.pair);
    return saved;
  }

  async signUp(input: { username: string; password: string; email?: string }): Promise<{ pair: SEAPair; username: string }> {
    const username = normalizeUsername(input.username);
    const nameError = validateUsername(username);
    if (nameError) throw new Error(nameError);
    const passwordError = checkPassword(input.password, username);
    if (passwordError) throw new Error(passwordError);
    if (input.email) { const emailError = validateEmail(input.email); if (emailError) throw new Error(emailError); }
    if (!(await this.usernames.isAvailable(username))) throw new UsernameTakenError(username);

    const pair: SEAPair = await SEA.pair();
    await this.usernames.claim(username, pair); // registrar decides; throws if taken
    await this.authGun(pair);
    await this.writeVault(pair, input.password);
    await this.saveSession(pair, username);
    return { pair, username };
  }

  async signIn(input: { username: string; password: string }): Promise<{ pair: SEAPair; username: string }> {
    const username = normalizeUsername(input.username);
    if (validateUsername(username)) throw new InvalidCredentialsError();
    const pub = await this.usernames.resolve(username, { fresh: true });
    if (!pub) throw new InvalidCredentialsError();
    const vault = safeJson<Vault>(await readOnce(userNode(this.ctx, pub).get('auth').get('vault'), this.ctx.config.readTimeoutMs * 2));
    if (!vault) throw new Error('Your account data hasn’t synced yet. Check your connection and try again.');
    const pair = await this.openVault(vault, input.password);
    if (!pair || pair.pub !== pub) throw new InvalidCredentialsError();
    await this.authGun(pair);
    await this.saveSession(pair, username);
    return { pair, username };
  }

  async signOut(): Promise<void> {
    try { this.ctx.gun.user().leave(); } catch { /* not signed in */ }
    await this.ctx.platform.secure.del(SESSION_KEY);
  }

  // ---------- password ----------

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const { pair, session } = requirePair(this.ctx);
    const error = checkPassword(nextPassword, session.username);
    if (error) throw new Error(error);
    if (!(await this.verifyPassword(currentPassword))) throw new InvalidCredentialsError();
    await this.writeVault(pair, nextPassword);
  }

  async verifyPassword(password: string): Promise<boolean> {
    const { pair } = requirePair(this.ctx);
    const vault = safeJson<Vault>(await readOnce(this.me().get('auth').get('vault'), this.ctx.config.readTimeoutMs));
    if (!vault) return false;
    const opened = await this.openVault(vault, password);
    return opened?.pub === pair.pub;
  }

  // ---------- email recovery ----------

  /** Set or change the recovery email. Creates a new recovery code (old codes stop working) and emails it. */
  async setRecoveryEmail(email: string): Promise<{ recoveryCode: string; emailSent: boolean }> {
    const { pair, session } = requirePair(this.ctx);
    const error = validateEmail(email);
    if (error) throw new Error(error);
    const value = email.trim();
    const recoveryCode = newRecoveryCode();
    await this.writeRecovery(pair, recoveryCode);
    await putAck(this.me().get('private').get('account'), await encryptFor({ email: value }, pair));
    const emailSent = await this.sendRecoveryMail(pair, session.username, value, recoveryCode);
    return { recoveryCode, emailSent };
  }

  async getRecoveryEmail(): Promise<string | null> {
    const { pair } = requirePair(this.ctx);
    const data = await decryptWith<{ email?: string }>(await readOnce(this.me().get('private').get('account'), this.ctx.config.readTimeoutMs), pair);
    return data?.email ?? null;
  }

  async removeRecoveryEmail(): Promise<void> {
    requirePair(this.ctx);
    await putAck(this.me().get('auth').get('recovery'), null);
    await putAck(this.me().get('private').get('account'), null);
  }

  /** Forgot password: use the emailed code to set a new password. Signs in on success. */
  async recover(input: { username: string; code: string; newPassword: string }): Promise<{ pair: SEAPair; username: string; newRecoveryCode?: string; emailSent?: boolean }> {
    const username = normalizeUsername(input.username);
    const passwordError = checkPassword(input.newPassword, username);
    if (passwordError) throw new Error(passwordError);
    const pub = await this.usernames.resolve(username, { fresh: true });
    if (!pub) throw new Error('That recovery code doesn’t match this username.');
    const record = safeJson<Vault>(await readOnce(userNode(this.ctx, pub).get('auth').get('recovery'), this.ctx.config.readTimeoutMs * 2));
    const pair = record ? await this.openVault(record, normalizeRecoveryCode(input.code)) : undefined;
    if (!pair || pair.pub !== pub) throw new Error('That recovery code doesn’t match this username.');
    await this.authGun(pair);
    await this.writeVault(pair, input.newPassword);
    await this.saveSession(pair, username);
    // The code just travelled through email and was typed in; replace it.
    const email = (await decryptWith<{ email?: string }>(await readOnce(this.me().get('private').get('account'), this.ctx.config.readTimeoutMs), pair))?.email;
    if (!email) return { pair, username };
    const rotated = newRecoveryCode();
    await this.writeRecovery(pair, rotated);
    const emailSent = await this.sendRecoveryMail(pair, username, email, rotated);
    return { pair, username, newRecoveryCode: rotated, emailSent };
  }

  // ---------- account deletion helpers ----------

  async wipeAuthRecords(): Promise<void> {
    await putAck(this.me().get('auth').get('vault'), null);
    await putAck(this.me().get('auth').get('recovery'), null);
    await putAck(this.me().get('private').get('account'), null);
  }

  // ---------- internals ----------

  /** The authenticated Gun user node (valid right after authGun, before the session object exists). */
  private me(): any { return this.ctx.gun.user(); }

  private authGun(pair: SEAPair): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ctx.gun.user().auth(pair, (ack: { err?: string }) => (ack?.err ? reject(new Error(ack.err)) : resolve()));
    });
  }

  private async saveSession(pair: SEAPair, username: string) {
    await this.ctx.platform.secure.set(SESSION_KEY, JSON.stringify({ pair, username }));
  }

  private async derive(secret: string, salt: string, iter: number): Promise<string> {
    const key = await SEA.work(secret, salt, null, { name: 'PBKDF2', iterations: iter, hash: { name: 'SHA-256' } });
    if (!key) throw new Error('Key derivation failed. Check the crypto polyfill.');
    return key;
  }

  private async seal(pair: SEAPair, secret: string, iter: number): Promise<Vault> {
    const salt = bytesToB64(randomBytes(24));
    const key = await this.derive(secret, salt, iter);
    return { v: 1, kdf: 'PBKDF2-SHA256', iter, salt, ct: await encryptFor(pair, key) };
  }

  private async openVault(vault: Vault, secret: string): Promise<SEAPair | undefined> {
    if (vault.v !== 1 || !vault.salt || !vault.ct || !(vault.iter >= 1000)) return undefined;
    const key = await this.derive(secret, vault.salt, vault.iter);
    const pair = await decryptWith<SEAPair>(vault.ct, key);
    return pair?.pub && pair.priv && pair.epub && pair.epriv ? pair : undefined;
  }

  private async writeVault(pair: SEAPair, password: string) {
    const vault = await this.seal(pair, password, this.ctx.config.passwordIterations);
    await putAck(this.me().get('auth').get('vault'), JSON.stringify(vault));
  }

  private async writeRecovery(pair: SEAPair, code: string) {
    // 160-bit random code: a modest iteration count is enough.
    const record = await this.seal(pair, normalizeRecoveryCode(code), 10_000);
    await putAck(this.me().get('auth').get('recovery'), JSON.stringify(record));
  }

  private async sendRecoveryMail(pair: SEAPair, username: string, email: string, code: string): Promise<boolean> {
    const request = await SEA.sign({ email, username, code, at: Date.now() }, pair);
    const res = await postJson(this.ctx, '/lain/recovery/send', { pub: pair.pub, request });
    return res.ok;
  }
}
