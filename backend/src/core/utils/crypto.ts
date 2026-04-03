import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Versioned encryption key support for zero-downtime key rotation.
 *
 * Key sources (checked in order):
 * 1. PAT_ENCRYPTION_KEYS - JSON array of { version, key } objects
 * 2. PAT_ENCRYPTION_KEY_V1, PAT_ENCRYPTION_KEY_V2, etc.
 * 3. PAT_ENCRYPTION_KEY - legacy single key (treated as version 0)
 */

interface VersionedKey {
  version: number;
  key: Buffer;
}

/**
 * Returns all configured encryption keys sorted by version (highest first).
 */
export function getEncryptionKeys(): VersionedKey[] {
  const keys: VersionedKey[] = [];

  // Source 1: JSON array in PAT_ENCRYPTION_KEYS
  const keysJson = process.env.PAT_ENCRYPTION_KEYS;
  if (keysJson) {
    try {
      const parsed = JSON.parse(keysJson) as Array<{ version: number; key: string }>;
      for (const entry of parsed) {
        if (entry.key && entry.key.length >= 32) {
          keys.push({ version: entry.version, key: Buffer.from(entry.key.slice(0, 32), 'utf-8') });
        }
      }
    } catch {
      // Invalid JSON, fall through to other sources
    }
  }

  // Source 2: Numbered env vars PAT_ENCRYPTION_KEY_V1, _V2, etc.
  for (let v = 1; v <= 10; v++) {
    const envKey = process.env[`PAT_ENCRYPTION_KEY_V${v}`];
    if (envKey && envKey.length >= 32) {
      // Only add if not already present from JSON source
      if (!keys.some((k) => k.version === v)) {
        keys.push({ version: v, key: Buffer.from(envKey.slice(0, 32), 'utf-8') });
      }
    }
  }

  // Source 3: Legacy single key (version 0)
  const legacyKey = process.env.PAT_ENCRYPTION_KEY;
  if (legacyKey && legacyKey.length >= 32) {
    if (!keys.some((k) => k.version === 0)) {
      keys.push({ version: 0, key: Buffer.from(legacyKey.slice(0, 32), 'utf-8') });
    }
  }

  if (keys.length === 0) {
    throw new Error('No PAT encryption key configured. Set PAT_ENCRYPTION_KEY (>= 32 chars).');
  }

  // Sort by version descending (latest first)
  keys.sort((a, b) => b.version - a.version);
  return keys;
}

/**
 * Returns the latest (highest version) encryption key for encrypting new data.
 */
export function getLatestEncryptionKey(): VersionedKey {
  return getEncryptionKeys()[0];
}

/**
 * Returns the encryption key for a specific version.
 * @throws if the requested version is not configured
 */
export function getEncryptionKeyByVersion(version: number): VersionedKey {
  const keys = getEncryptionKeys();
  const found = keys.find((k) => k.version === version);
  if (!found) {
    throw new Error(`Encryption key version ${version} not found`);
  }
  return found;
}

/**
 * Encrypts a PAT using the latest key version.
 * Format: v{version}:iv:authTag:ciphertext (all hex except version prefix)
 */
export function encryptPat(plaintext: string): string {
  const { version, key } = getLatestEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `v${version}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a PAT. Supports both versioned and legacy (unversioned) formats.
 *
 * Versioned format: v{N}:iv:authTag:ciphertext
 * Legacy format: iv:authTag:ciphertext (uses version 0 / PAT_ENCRYPTION_KEY)
 */
export function decryptPat(encrypted: string): string {
  const parts = encrypted.split(':');

  let version: number;
  let ivHex: string;
  let authTagHex: string;
  let ciphertext: string;

  if (parts[0].startsWith('v') && parts.length === 4) {
    // Versioned format: v{N}:iv:authTag:ciphertext
    version = parseInt(parts[0].slice(1), 10);
    ivHex = parts[1];
    authTagHex = parts[2];
    ciphertext = parts[3];
  } else if (parts.length === 3) {
    // Legacy format: iv:authTag:ciphertext (version 0)
    version = 0;
    ivHex = parts[0];
    authTagHex = parts[1];
    ciphertext = parts[2];
  } else {
    throw new Error('Invalid encrypted PAT format');
  }

  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('Invalid encrypted PAT format');
  }

  const { key } = getEncryptionKeyByVersion(version);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

/**
 * Re-encrypts a PAT with the latest key version.
 * Returns the new encrypted string, or null if already using the latest version.
 */
export function reEncryptPat(encrypted: string): string | null {
  const latest = getLatestEncryptionKey();
  const parts = encrypted.split(':');

  // Check if already using latest version
  if (parts[0].startsWith('v') && parts.length === 4) {
    const currentVersion = parseInt(parts[0].slice(1), 10);
    if (currentVersion === latest.version) {
      return null; // Already up to date
    }
  }

  // Decrypt with current key, re-encrypt with latest
  const plaintext = decryptPat(encrypted);
  return encryptPat(plaintext);
}
