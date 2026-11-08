// MUST be the first import of the app (see index.js). Gun SEA and libsignal
// grab `globalThis.crypto` when their modules load, so WebCrypto has to exist
// before either is imported. react-native-quick-crypto provides a native
// crypto.subtle (ECDSA/ECDH P-256, AES-GCM, AES-CBC, HMAC, HKDF, PBKDF2) and Buffer.
import { install } from 'react-native-quick-crypto';
import { utf8Decode, utf8Encode } from './encoding';

install();

// SEA falls back to `require('./lib/text-encoding')` through a computed path
// when these are missing, which Metro can't bundle. Provide UTF-8 versions.
const g = globalThis as any;
if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class TextEncoder {
    readonly encoding = 'utf-8';
    encode(input = ''): Uint8Array { return utf8Encode(String(input)); }
  };
}
if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class TextDecoder {
    readonly encoding = 'utf-8';
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return utf8Decode(bytes);
    }
  };
}
