import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomBytes, createCipheriv } from 'crypto';
import {
  encryptPat,
  decryptPat,
  reEncryptPat,
  getEncryptionKeys,
  getLatestEncryptionKey,
  isEncryptedSecretFormat,
  isValidEncryptionKey,
} from './crypto.js';

/**
 * Reproduces the pre-#738 encryption path: AES key = first 32 *chars* of the
 * passphrase as UTF-8 (no KDF). Used to create fixtures representing data
 * already at rest, so back-compat is proven against the real old algorithm.
 */
function encryptWithLegacyDerivation(
  plaintext: string,
  passphrase: string,
  version: number | null,
): string {
  const key = Buffer.from(passphrase.slice(0, 32), 'utf-8');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  const body = `${iv.toString('hex')}:${authTag}:${encrypted}`;
  return version === null ? body : `v${version}:${body}`;
}

describe('PAT encryption', () => {
  it('should encrypt and decrypt a PAT', () => {
    const pat = 'NjYwOTUxMjI4OTA2OkZG5Kz+TnfP7gGZ7';
    const encrypted = encryptPat(pat);
    expect(encrypted).not.toBe(pat);
    expect(encrypted).toContain(':'); // versioned format

    const decrypted = decryptPat(encrypted);
    expect(decrypted).toBe(pat);
  });

  it('should produce different ciphertexts for the same input', () => {
    const pat = 'same-pat-value';
    const a = encryptPat(pat);
    const b = encryptPat(pat);
    expect(a).not.toBe(b); // Random IV ensures different ciphertext
    expect(decryptPat(a)).toBe(pat);
    expect(decryptPat(b)).toBe(pat);
  });

  it('should fail on invalid encrypted format', () => {
    expect(() => decryptPat('invalid')).toThrow();
  });

  it('should produce HKDF-versioned format (h0:iv:authTag:ciphertext)', () => {
    // 'h' prefix = HKDF-SHA256 key derivation (#738); the legacy 'v' prefix
    // marks pre-HKDF (truncation-derived) ciphertexts and is decrypt-only.
    const encrypted = encryptPat('test-pat');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatch(/^h\d+$/);
  });
});

describe('PAT encryption key versioning', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    delete process.env.PAT_ENCRYPTION_KEYS;
    delete process.env.PAT_ENCRYPTION_KEY_V1;
    delete process.env.PAT_ENCRYPTION_KEY_V2;
    process.env.PAT_ENCRYPTION_KEY = originalEnv.PAT_ENCRYPTION_KEY;
  });

  it('should use legacy PAT_ENCRYPTION_KEY as version 0', () => {
    const keys = getEncryptionKeys();
    expect(keys.some((k) => k.version === 0)).toBe(true);
  });

  it('should support numbered env vars (PAT_ENCRYPTION_KEY_V1)', () => {
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const keys = getEncryptionKeys();
    expect(keys.some((k) => k.version === 1)).toBe(true);
  });

  it('should use highest version for encryption', () => {
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const latest = getLatestEncryptionKey();
    expect(latest.version).toBe(1);
  });

  it('should encrypt with versioned format', () => {
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const encrypted = encryptPat('my-secret-pat');
    expect(encrypted).toMatch(/^h1:/);
  });

  it('should decrypt versioned format', () => {
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const encrypted = encryptPat('my-secret-pat');
    const decrypted = decryptPat(encrypted);
    expect(decrypted).toBe('my-secret-pat');
  });

  it('should support JSON-based PAT_ENCRYPTION_KEYS', () => {
    process.env.PAT_ENCRYPTION_KEYS = JSON.stringify([
      { version: 1, key: 'json-key-version-one-32-chars-long!!' },
      { version: 2, key: 'json-key-version-two-32-chars-long!!' },
    ]);
    const keys = getEncryptionKeys();
    expect(keys.some((k) => k.version === 1)).toBe(true);
    expect(keys.some((k) => k.version === 2)).toBe(true);
    const latest = getLatestEncryptionKey();
    expect(latest.version).toBe(2);
  });

  it('should encrypt with latest version from JSON keys', () => {
    process.env.PAT_ENCRYPTION_KEYS = JSON.stringify([
      { version: 1, key: 'json-key-version-one-32-chars-long!!' },
      { version: 2, key: 'json-key-version-two-32-chars-long!!' },
    ]);
    const encrypted = encryptPat('json-pat');
    expect(encrypted).toMatch(/^h2:/);
    expect(decryptPat(encrypted)).toBe('json-pat');
  });

  it('should decrypt data encrypted with older key version', () => {
    // First encrypt with v1
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const encrypted = encryptPat('old-pat');
    expect(encrypted).toMatch(/^h1:/);

    // Now add v2 and verify v1 data can still be decrypted
    process.env.PAT_ENCRYPTION_KEY_V2 = 'versioned-key-two-at-least-32-chars!!';
    const decrypted = decryptPat(encrypted);
    expect(decrypted).toBe('old-pat');
  });
});

// issue #738 — data already at rest was encrypted with a key derived by
// truncating the passphrase to its first 32 chars. The HKDF migration must
// keep every one of those ciphertexts decryptable.
describe('pre-HKDF ciphertext back-compat (#738)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    delete process.env.PAT_ENCRYPTION_KEY_V1;
    process.env.PAT_ENCRYPTION_KEY = originalEnv.PAT_ENCRYPTION_KEY;
  });

  it('decrypts v{N}-format data encrypted with the old truncation derivation', () => {
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const legacy = encryptWithLegacyDerivation(
      'old-at-rest-pat',
      process.env.PAT_ENCRYPTION_KEY_V1,
      1,
    );
    expect(decryptPat(legacy)).toBe('old-at-rest-pat');
  });

  it('decrypts unversioned (iv:authTag:ct) data encrypted with the old derivation', () => {
    const legacy = encryptWithLegacyDerivation('really-old-pat', process.env.PAT_ENCRYPTION_KEY!, null);
    expect(decryptPat(legacy)).toBe('really-old-pat');
  });

  it('decrypts v0-format data encrypted with the old derivation of PAT_ENCRYPTION_KEY', () => {
    const legacy = encryptWithLegacyDerivation('old-v0-pat', process.env.PAT_ENCRYPTION_KEY!, 0);
    expect(decryptPat(legacy)).toBe('old-v0-pat');
  });

  it('reEncryptPat upgrades old-derivation data to the HKDF format even at the same key version', () => {
    const legacy = encryptWithLegacyDerivation('upgrade-me', process.env.PAT_ENCRYPTION_KEY!, 0);
    const upgraded = reEncryptPat(legacy);
    expect(upgraded).not.toBeNull();
    expect(upgraded).toMatch(/^h0:/);
    expect(decryptPat(upgraded!)).toBe('upgrade-me');
  });
});

// issue #738 — keys are now derived via HKDF-SHA256 over the FULL passphrase
// bytes instead of `Buffer.from(key.slice(0, 32), 'utf-8')`.
describe('HKDF key derivation (#738)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    delete process.env.PAT_ENCRYPTION_KEY_V1;
    process.env.PAT_ENCRYPTION_KEY = originalEnv.PAT_ENCRYPTION_KEY;
  });

  it('round-trips with multi-byte chars in the first 32 chars (old path threw "Invalid key length")', () => {
    const multiByteKey = '🔑🔑🔑🔑-multibyte-passphrase-with-32-bytes!';
    // Sanity: the old truncation derivation cannot produce a 32-byte AES key here.
    expect(Buffer.from(multiByteKey.slice(0, 32), 'utf-8').length).not.toBe(32);

    process.env.PAT_ENCRYPTION_KEY_V1 = multiByteKey;
    const encrypted = encryptPat('multi-byte-pat');
    expect(encrypted).toMatch(/^h1:/);
    expect(decryptPat(encrypted)).toBe('multi-byte-pat');
  });

  it('uses the full passphrase — keys sharing the first 32 chars are distinct', () => {
    const sharedPrefix = 'A'.repeat(32);
    process.env.PAT_ENCRYPTION_KEY_V1 = `${sharedPrefix}-tail-one`;
    const encrypted = encryptPat('full-passphrase-pat');
    expect(decryptPat(encrypted)).toBe('full-passphrase-pat');

    // The old derivation truncated to 32 chars, so these two keys collided.
    process.env.PAT_ENCRYPTION_KEY_V1 = `${sharedPrefix}-tail-two`;
    expect(() => decryptPat(encrypted)).toThrow();
  });

  it('accepts a key that is >= 32 bytes but < 32 chars (byte-based validation)', () => {
    const key = 'パスワードパスワードパスワー'; // 14 chars, 42 UTF-8 bytes
    expect(key.length).toBeLessThan(32);
    expect(Buffer.byteLength(key, 'utf-8')).toBeGreaterThanOrEqual(32);

    process.env.PAT_ENCRYPTION_KEY_V1 = key;
    const keys = getEncryptionKeys();
    expect(keys.some((k) => k.version === 1)).toBe(true);
    expect(decryptPat(encryptPat('cjk-key-pat'))).toBe('cjk-key-pat');
  });

  it('rejects keys shorter than 32 bytes', () => {
    process.env.PAT_ENCRYPTION_KEY_V1 = 'only-31-ascii-chars-aaaaaaaaaa!'; // 31 bytes
    const keys = getEncryptionKeys();
    expect(keys.some((k) => k.version === 1)).toBe(false);
  });
});

// issue #738 — startup validation must measure UTF-8 bytes, not UTF-16 chars,
// so that what passes boot is exactly what the crypto module accepts.
describe('isValidEncryptionKey (#738)', () => {
  it('accepts 32 ASCII chars (32 bytes) — existing deployments keep working', () => {
    expect(isValidEncryptionKey('a'.repeat(32))).toBe(true);
  });

  it('rejects 31 ASCII chars', () => {
    expect(isValidEncryptionKey('a'.repeat(31))).toBe(false);
  });

  it('measures bytes, not chars: 11 three-byte chars (33 bytes) pass', () => {
    expect(isValidEncryptionKey('あ'.repeat(11))).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidEncryptionKey('')).toBe(false);
  });
});

// issue #738 — used to tell encrypted-at-rest secrets apart from legacy
// plaintext values (e.g. smtp_pass rows written before encryption landed).
describe('isEncryptedSecretFormat (#738)', () => {
  it('matches current encryptPat output', () => {
    expect(isEncryptedSecretFormat(encryptPat('some-secret'))).toBe(true);
  });

  it('matches pre-HKDF v{N}-format ciphertexts', () => {
    const legacy = encryptWithLegacyDerivation('s', process.env.PAT_ENCRYPTION_KEY!, 0);
    expect(isEncryptedSecretFormat(legacy)).toBe(true);
  });

  it('matches legacy unversioned (iv:authTag:ct) ciphertexts', () => {
    const legacy = encryptWithLegacyDerivation('s', process.env.PAT_ENCRYPTION_KEY!, null);
    expect(isEncryptedSecretFormat(legacy)).toBe(true);
  });

  it('does not match plaintext passwords', () => {
    expect(isEncryptedSecretFormat('hunter2')).toBe(false);
    expect(isEncryptedSecretFormat('pass:with:colons')).toBe(false);
    expect(isEncryptedSecretFormat('a:b:c:d')).toBe(false);
    expect(isEncryptedSecretFormat('')).toBe(false);
    expect(isEncryptedSecretFormat('••••••••')).toBe(false);
  });

  it('limitation (pinned): rejects the ciphertext of the EMPTY string', () => {
    // `encryptPat('')` yields `h{N}:iv:tag:` with an empty ciphertext
    // segment, which this predicate rejects. Unreachable today — callers
    // persist empty secrets as `''` — but pinned so a future caller does
    // not rely on it to recognise an encrypted-empty secret (it would be
    // treated as plaintext and double-encrypted). See crypto.ts.
    expect(isEncryptedSecretFormat(encryptPat(''))).toBe(false);
  });
});

// issue #738 — a malformed PAT_ENCRYPTION_KEYS used to be swallowed silently,
// leaving the operator unaware their rotation keys were being ignored.
describe('PAT_ENCRYPTION_KEYS parse warning (#738)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    delete process.env.PAT_ENCRYPTION_KEYS;
    process.env.PAT_ENCRYPTION_KEY = originalEnv.PAT_ENCRYPTION_KEY;
    vi.doUnmock('./logger.js');
    vi.resetModules();
  });

  it('logs a warning once when PAT_ENCRYPTION_KEYS is invalid JSON', async () => {
    vi.resetModules();
    const warn = vi.fn();
    vi.doMock('./logger.js', () => ({
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    process.env.PAT_ENCRYPTION_KEYS = '{not-valid-json';
    const fresh = await import('./crypto.js');

    // Falls back to the other key sources...
    const keys = fresh.getEncryptionKeys();
    expect(keys.some((k) => k.version === 0)).toBe(true);
    // ...but tells the operator about it (once per process, not per call).
    expect(warn).toHaveBeenCalledTimes(1);
    fresh.getEncryptionKeys();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('reEncryptPat', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    delete process.env.PAT_ENCRYPTION_KEYS;
    delete process.env.PAT_ENCRYPTION_KEY_V1;
    delete process.env.PAT_ENCRYPTION_KEY_V2;
    process.env.PAT_ENCRYPTION_KEY = originalEnv.PAT_ENCRYPTION_KEY;
  });

  it('should return null if already using latest version', () => {
    const encrypted = encryptPat('test-pat');
    const result = reEncryptPat(encrypted);
    expect(result).toBeNull();
  });

  it('should re-encrypt with newer key version', () => {
    // Encrypt with v0 (legacy)
    const encrypted = encryptPat('rotate-me');
    expect(encrypted).toMatch(/^h0:/);

    // Add v1 key
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

    // Re-encrypt
    const reEncrypted = reEncryptPat(encrypted);
    expect(reEncrypted).not.toBeNull();
    expect(reEncrypted).toMatch(/^h1:/);

    // Verify data is preserved
    expect(decryptPat(reEncrypted!)).toBe('rotate-me');
  });

  it('should re-encrypt legacy (unversioned) format', () => {
    // Old-derivation, unversioned data at rest
    const legacyFormat = encryptWithLegacyDerivation('legacy', process.env.PAT_ENCRYPTION_KEY!, null);

    // Add v1 key
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

    const reEncrypted = reEncryptPat(legacyFormat);
    expect(reEncrypted).not.toBeNull();
    expect(reEncrypted).toMatch(/^h1:/);
    expect(decryptPat(reEncrypted!)).toBe('legacy');
  });
});
