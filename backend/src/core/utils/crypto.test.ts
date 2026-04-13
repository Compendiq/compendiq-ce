import { describe, it, expect, afterEach } from 'vitest';
import { encryptPat, decryptPat, reEncryptPat, getEncryptionKeys, getLatestEncryptionKey } from './crypto.js';

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

  it('should produce versioned format (v0:iv:authTag:ciphertext)', () => {
    const encrypted = encryptPat('test-pat');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatch(/^v\d+$/);
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
    expect(encrypted).toMatch(/^v1:/);
  });

  it('should decrypt versioned format', () => {
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const encrypted = encryptPat('my-secret-pat');
    const decrypted = decryptPat(encrypted);
    expect(decrypted).toBe('my-secret-pat');
  });

  it('should support decrypting legacy (unversioned) format', () => {
    // Legacy format: just iv:authTag:ciphertext (no version prefix)
    // First encrypt with the current key (version 0)
    // Simulate legacy format by removing version prefix
    const encrypted = encryptPat('legacy-pat');
    // The new format is v0:iv:authTag:ciphertext
    // Legacy would be iv:authTag:ciphertext
    const parts = encrypted.split(':');
    expect(parts[0]).toBe('v0'); // Current default is v0
    const legacyFormat = parts.slice(1).join(':');
    const decrypted = decryptPat(legacyFormat);
    expect(decrypted).toBe('legacy-pat');
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
    expect(encrypted).toMatch(/^v2:/);
    expect(decryptPat(encrypted)).toBe('json-pat');
  });

  it('should decrypt data encrypted with older key version', () => {
    // First encrypt with v1
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';
    const encrypted = encryptPat('old-pat');
    expect(encrypted).toMatch(/^v1:/);

    // Now add v2 and verify v1 data can still be decrypted
    process.env.PAT_ENCRYPTION_KEY_V2 = 'versioned-key-two-at-least-32-chars!!';
    const decrypted = decryptPat(encrypted);
    expect(decrypted).toBe('old-pat');
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
    expect(encrypted).toMatch(/^v0:/);

    // Add v1 key
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

    // Re-encrypt
    const reEncrypted = reEncryptPat(encrypted);
    expect(reEncrypted).not.toBeNull();
    expect(reEncrypted).toMatch(/^v1:/);

    // Verify data is preserved
    expect(decryptPat(reEncrypted!)).toBe('rotate-me');
  });

  it('should re-encrypt legacy (unversioned) format', () => {
    // Create legacy format manually
    const encrypted = encryptPat('legacy');
    const parts = encrypted.split(':');
    const legacyFormat = parts.slice(1).join(':');

    // Add v1 key
    process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

    const reEncrypted = reEncryptPat(legacyFormat);
    expect(reEncrypted).not.toBeNull();
    expect(reEncrypted).toMatch(/^v1:/);
    expect(decryptPat(reEncrypted!)).toBe('legacy');
  });
});
