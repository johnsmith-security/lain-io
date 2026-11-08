import { fromByteArray, toByteArray } from 'base64-js';

export const bytesToB64 = (bytes: Uint8Array): string => fromByteArray(bytes);
export const b64ToBytes = (text: string): Uint8Array => toByteArray(text);
export const abToB64 = (buffer: ArrayBuffer): string => fromByteArray(new Uint8Array(buffer));
export const b64ToAb = (text: string): ArrayBuffer => {
  const bytes = toByteArray(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
export const b64url = (b64: string): string => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const binaryStringToBytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
};

// UTF-8 without relying on TextDecoder, which Hermes may not provide.
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00); i++; }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let code: number;
    if (b < 0x80) code = b;
    else if (b < 0xe0) code = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) code = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else code = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (code > 0xffff) { code -= 0x10000; out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023)); }
    else out += String.fromCharCode(code);
  }
  return out;
}

export const textToAb = (text: string): ArrayBuffer => {
  const bytes = utf8Encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
export const abToText = (buffer: ArrayBuffer): string => utf8Decode(new Uint8Array(buffer));

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Time-sortable unique id: base36 millis + random suffix. */
export function newId(): string {
  const rand = Array.from(randomBytes(6), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
  return `${Date.now().toString(36).padStart(9, '0')}-${rand}`;
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
/** Human-friendly recovery code: 160 bits in 8 groups of 4. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(20);
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{1,4}/g)!.join('-');
}
export const normalizeRecoveryCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g)?.join('-') ?? '';

export const dayBucket = (at: number = Date.now()): string => new Date(at).toISOString().slice(0, 10);
export const recentDays = (count: number, now: number = Date.now()): string[] =>
  Array.from({ length: count }, (_, i) => dayBucket(now - i * 86_400_000));

export function safeJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}
