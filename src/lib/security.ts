const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const randomHex = (byteLength = 16) =>
  toHex(crypto.getRandomValues(new Uint8Array(byteLength)));

export const randomBase32 = (byteLength = 20) => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
};

export async function hashPassword(password: string, saltHex: string, iterations = 210000) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

const base32ToBytes = (value: string) => {
  const clean = value.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let buffer = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return new Uint8Array(out);
};

async function hotp(secret: string, counter: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    base32ToBytes(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1] & 15;
  const code =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(code % 1000000).padStart(6, '0');
}

/** Accepts the current 30s window plus one step either side for clock drift. */
export async function verifyTotp(secret: string, code: string) {
  const counter = Math.floor(Date.now() / 30000);
  for (const drift of [-1, 0, 1]) {
    if ((await hotp(secret, counter + drift)) === code) return true;
  }
  return false;
}

export const buildOtpAuthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`Paywai:${account}`)}?secret=${secret}` +
  '&issuer=Paywai&algorithm=SHA1&digits=6&period=30';

export function passwordIssues(password: string) {
  const issues: string[] = [];
  if (password.length < 8) issues.push('at least 8 characters');
  if (!/[a-z]/.test(password)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) issues.push('an uppercase letter');
  if (!/\d/.test(password)) issues.push('a number');
  return issues;
}
