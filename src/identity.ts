import { File, Paths } from 'expo-file-system';

// Local identity for this device. For now it only holds the username.
// Phase P1 of docs/PLAN-gundb-and-lain-000.md adds the SEA key pair (kept in
// secure storage, not in this file) once SEA's WebCrypto support is confirmed
// on Hermes. Until then the username is not published to Gun, because an
// unsigned public write could be overwritten by anyone.

export type Identity = { username: string; createdAt: number };

const identityFile = () => new File(Paths.document, 'lain-identity.json');

export const USERNAME_RULE = '3–20 characters: lowercase letters, numbers, underscore.';

export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

export function validateUsername(input: string): string | null {
  const username = normalizeUsername(input);
  if (!username) return 'Choose a username.';
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return `Use ${USERNAME_RULE.toLowerCase()}`;
  return null;
}

export function loadIdentity(): Identity | null {
  try {
    const file = identityFile();
    if (!file.exists) return null;
    const parsed = JSON.parse(file.textSync()) as Partial<Identity>;
    if (typeof parsed.username !== 'string' || validateUsername(parsed.username)) return null;
    return { username: parsed.username, createdAt: Number(parsed.createdAt) || Date.now() };
  } catch {
    return null;
  }
}

export function createIdentity(input: string): Identity {
  const error = validateUsername(input);
  if (error) throw new Error(error);
  const identity: Identity = { username: normalizeUsername(input), createdAt: Date.now() };
  const file = identityFile();
  if (!file.exists) file.create();
  file.writeSync(JSON.stringify(identity));
  return identity;
}

export function forgetIdentity() {
  try {
    const file = identityFile();
    if (file.exists) file.delete();
  } catch {
    // Nothing stored, or already removed.
  }
}
