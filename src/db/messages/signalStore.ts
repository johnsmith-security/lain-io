// Signal protocol storage, kept ONLY on this device (encrypted SQLite on the
// phone). Ratchet state must never sync through Gun; syncing it would undo
// forward secrecy.
//
// Addresses: name = "<accountPub>|<deviceId>", deviceId field = 1. Each
// physical device has its own identity key, and libsignal keys identities by
// name, so the device id has to be part of the name.

import { Direction, type KeyPairType, type StorageType } from '@privacyresearch/libsignal-protocol-typescript';
import { abToB64, b64ToAb } from '../encoding';
import type { LocalKV } from '../platform';

export class IdentityMismatchError extends Error {
  constructor(public name_: string) { super(`Identity key changed for ${name_}.`); this.name = 'IdentityMismatchError'; }
}

type StoredPair = { pub: string; priv: string };
const toStored = (pair: KeyPairType): StoredPair => ({ pub: abToB64(pair.pubKey), priv: abToB64(pair.privKey) });
const fromStored = (pair: StoredPair): KeyPairType => ({ pubKey: b64ToAb(pair.pub), privKey: b64ToAb(pair.priv) });
const safeOld = (raw: string | null): string | null => {
  if (!raw) return null;
  try { return (JSON.parse(raw) as { pair: string }).pair; } catch { return null; }
};
/** libsignal passes either "name" or "name.deviceId"; normalize to name. */
export const identityName = (address: string) => address.replace(/\.\d+$/, '');

export type DeviceSecrets = {
  deviceId: number;
  registrationId: number;
  identity: StoredPair;
  createdAt: number;
};

export class SignalStore implements StorageType {
  /** Called when a prekey was consumed, so the published copy can be removed and refilled. */
  onPreKeyRemoved: (keyId: number) => void = () => {};

  constructor(private kv: LocalKV, private ns: string, private device: DeviceSecrets) {}

  // ----- identity -----
  async getIdentityKeyPair() { return fromStored(this.device.identity); }
  async getLocalRegistrationId() { return this.device.registrationId; }

  /** Pin a peer device's identity key from its account-signed device record. */
  pinIdentity(name: string, key: ArrayBuffer): 'new' | 'same' | 'changed' {
    const existing = this.kv.get(this.ns, `idk:${name}`);
    if (!existing) { this.kv.set(this.ns, `idk:${name}`, abToB64(key)); return 'new'; }
    return existing === abToB64(key) ? 'same' : 'changed';
  }
  getPinned(name: string): string | null { return this.kv.get(this.ns, `idk:${name}`); }
  /** Explicitly accept a changed key (after the user checked the safety number). */
  replacePinned(name: string, key: ArrayBuffer) {
    this.kv.set(this.ns, `idk:${name}`, abToB64(key));
    this.kv.del(this.ns, `sess:${name}.1`);
  }

  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, _direction: Direction) {
    const pinned = this.kv.get(this.ns, `idk:${identityName(identifier)}`);
    return !pinned || pinned === abToB64(identityKey);
  }

  /**
   * libsignal 0.0.16 doesn't await isTrustedIdentity when it receives a PreKey
   * message (session-builder processV3), so the real check happens here:
   * saving a key that differs from the pinned one throws, and the decrypt fails
   * before the session is stored.
   */
  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer) {
    const name = identityName(encodedAddress);
    const pinned = this.kv.get(this.ns, `idk:${name}`);
    if (pinned && pinned !== abToB64(publicKey)) throw new IdentityMismatchError(name);
    if (!pinned) this.kv.set(this.ns, `idk:${name}`, abToB64(publicKey));
    return false;
  }

  // ----- one-time prekeys -----
  // Gun can't hand out a prekey atomically, so two senders may grab the same
  // one. A used prekey stays usable for a 24 h grace period (then it's deleted)
  // so the second sender's first message still decrypts. Forward secrecy for
  // that one key starts after the grace period instead of immediately.
  async loadPreKey(keyId: string | number) {
    const raw = this.kv.get(this.ns, `pk:${keyId}`) ?? safeOld(this.kv.get(this.ns, `pkold:${keyId}`));
    return raw ? fromStored(JSON.parse(raw)) : undefined;
  }
  async storePreKey(keyId: number | string, keyPair: KeyPairType) { this.kv.set(this.ns, `pk:${keyId}`, JSON.stringify(toStored(keyPair))); }
  async removePreKey(keyId: number | string) {
    const raw = this.kv.get(this.ns, `pk:${keyId}`);
    if (raw) this.kv.set(this.ns, `pkold:${keyId}`, JSON.stringify({ pair: raw, at: Date.now() }));
    this.kv.del(this.ns, `pk:${keyId}`);
    this.onPreKeyRemoved(Number(keyId));
  }
  preKeyCount(): number { return this.kv.list(this.ns, 'pk:').length; }
  pruneUsedPreKeys(maxAgeMs = 86_400_000) {
    for (const { key, value } of this.kv.list(this.ns, 'pkold:')) {
      if (Date.now() - Number(JSON.parse(value).at) > maxAgeMs) this.kv.del(this.ns, key);
    }
  }

  // ----- signed prekeys -----
  async loadSignedPreKey(keyId: number | string) {
    const raw = this.kv.get(this.ns, `spk:${keyId}`);
    return raw ? fromStored(JSON.parse(raw).pair) : undefined;
  }
  async storeSignedPreKey(keyId: number | string, keyPair: KeyPairType) {
    this.kv.set(this.ns, `spk:${keyId}`, JSON.stringify({ pair: toStored(keyPair), at: Date.now() }));
  }
  async removeSignedPreKey(keyId: number | string) { this.kv.del(this.ns, `spk:${keyId}`); }
  /** Drop signed prekeys older than `maxAgeMs`, except `keepId`. */
  pruneSignedPreKeys(keepId: number, maxAgeMs: number) {
    for (const { key, value } of this.kv.list(this.ns, 'spk:')) {
      const id = Number(key.slice(4));
      if (id !== keepId && Date.now() - Number(JSON.parse(value).at) > maxAgeMs) this.kv.del(this.ns, key);
    }
  }

  // ----- sessions -----
  async loadSession(encodedAddress: string) { return this.kv.get(this.ns, `sess:${encodedAddress}`) ?? undefined; }
  async storeSession(encodedAddress: string, record: string) { this.kv.set(this.ns, `sess:${encodedAddress}`, record); }
}
