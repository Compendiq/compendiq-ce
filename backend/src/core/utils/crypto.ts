import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'crypto';
import { logger } from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256 requires exactly 32 key bytes
const MIN_KEY_BYTES = 32;

// Fixed, non-secret HKDF context parameters (issue #738). Domain-separation
// only — the secrecy of the derived key comes entirely from the passphrase.
const HKDF_SALT = Buffer.from('compendiq-pat-encryption', 'utf-8');
const HKDF_INFO = Buffer.from('aes-256-gcm', 'utf-8');

/**
 * Versioned encryption key support for zero-downtime key rotation.
 *
 * Key sources (checked in order):
 * 1. PAT_ENCRYPTION_KEYS - JSON array of { version, key } objects
 * 2. PAT_ENCRYPTION_KEY_V1, PAT_ENCRYPTION_KEY_V2, etc.
 * 3. PAT_ENCRYPTION_KEY - legacy single key (treated as version 0)
 *
 * Ciphertext formats (issue #738 introduced the `h` prefix):
 * - `h{N}:iv:authTag:ciphertext` — current. AES key = HKDF-SHA256 over the
 *   FULL passphrase bytes of key version N. Used for all new encryptions.
 * - `v{N}:iv:authTag:ciphertext` — pre-HKDF. AES key = first 32 *chars* of
 *   the passphrase as UTF-8 (no KDF). Decrypt-only, kept for data at rest.
 * - `iv:authTag:ciphertext` — legacy unversioned; same truncation derivation
 *   with key version 0. Decrypt-only.
 */

interface VersionedKey {
  version: number;
  /** HKDF-SHA256-derived key (32 bytes) — used for all new encryptions. */
  key: Buffer;
  /**
   * Pre-#738 truncation-derived key, used only to decrypt `v{N}`/unversioned
   * data already at rest. `null` when the first 32 chars of the passphrase
   * are not exactly 32 UTF-8 bytes — such a key could never have encrypted
   * anything (createCipheriv would have thrown "Invalid key length").
   */
  legacyKey: Buffer | null;
}

/**
 * True when the key has at least 32 bytes of UTF-8 key material. Measured in
 * BYTES, not UTF-16 chars (issue #738): for ASCII keys this is identical to
 * the historical `length >= 32` check, but multi-byte passphrases are judged
 * by what actually feeds the KDF.
 */
export function isValidEncryptionKey(key: string): boolean {
  return Buffer.byteLength(key, 'utf-8') >= MIN_KEY_BYTES;
}

/** Current derivation (#738): HKDF-SHA256 over the full passphrase bytes. */
function deriveKey(passphrase: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(passphrase, 'utf-8'), HKDF_SALT, HKDF_INFO, KEY_LENGTH));
}

/** Pre-#738 derivation: first 32 chars as UTF-8 (only valid when that is exactly 32 bytes). */
function deriveLegacyKey(passphrase: string): Buffer | null {
  const key = Buffer.from(passphrase.slice(0, 32), 'utf-8');
  return key.length === KEY_LENGTH ? key : null;
}

function toVersionedKey(version: number, passphrase: string): VersionedKey {
  return { version, key: deriveKey(passphrase), legacyKey: deriveLegacyKey(passphrase) };
}

// Warn once per process, not on every encrypt/decrypt call.
let warnedInvalidKeysJson = false;

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
        if (entry.key && isValidEncryptionKey(entry.key)) {
          keys.push(toVersionedKey(entry.version, entry.key));
        }
      }
    } catch (err) {
      // Invalid JSON, fall through to other sources — but tell the operator
      // their rotation keys are being ignored (issue #738).
      if (!warnedInvalidKeysJson) {
        warnedInvalidKeysJson = true;
        logger.warn(
          { err },
          'PAT_ENCRYPTION_KEYS is not valid JSON — ignoring it and falling back to PAT_ENCRYPTION_KEY / PAT_ENCRYPTION_KEY_V{n}',
        );
      }
    }
  }

  // Source 2: Numbered env vars PAT_ENCRYPTION_KEY_V1, _V2, etc.
  for (let v = 1; v <= 10; v++) {
    const envKey = process.env[`PAT_ENCRYPTION_KEY_V${v}`];
    if (envKey && isValidEncryptionKey(envKey)) {
      // Only add if not already present from JSON source
      if (!keys.some((k) => k.version === v)) {
        keys.push(toVersionedKey(v, envKey));
      }
    }
  }

  // Source 3: Legacy single key (version 0)
  const legacyKey = process.env.PAT_ENCRYPTION_KEY;
  if (legacyKey && isValidEncryptionKey(legacyKey)) {
    if (!keys.some((k) => k.version === 0)) {
      keys.push(toVersionedKey(0, legacyKey));
    }
  }

  if (keys.length === 0) {
    throw new Error('No PAT encryption key configured. Set PAT_ENCRYPTION_KEY (>= 32 bytes).');
  }

  // Sort by version descending (latest first)
  keys.sort((a, b) => b.version - a.version);
  return keys;
}

/**
 * Returns the latest (highest version) encryption key for encrypting new data.
 */
export function getLatestEncryptionKey(): VersionedKey {
  const key = getEncryptionKeys()[0];
  if (!key) throw new Error('No encryption keys available');
  return key;
}

/**
 * Returns the encryption key for a specific version.
 * @throws if the requested version is not configured
 */
function getEncryptionKeyByVersion(version: number): VersionedKey {
  const keys = getEncryptionKeys();
  const found = keys.find((k) => k.version === version);
  if (!found) {
    throw new Error(`Encryption key version ${version} not found`);
  }
  return found;
}

/**
 * Encrypts a PAT using the latest key version.
 * Format: h{version}:iv:authTag:ciphertext (all hex except version prefix;
 * `h` = HKDF-SHA256 key derivation, see module doc).
 */
export function encryptPat(plaintext: string): string {
  const { version, key } = getLatestEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `h${version}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a PAT. Supports all historical formats:
 *
 * - `h{N}:iv:authTag:ciphertext` — HKDF-derived key (current)
 * - `v{N}:iv:authTag:ciphertext` — pre-HKDF truncation-derived key
 * - `iv:authTag:ciphertext`      — legacy unversioned (version 0, truncation)
 */
export function decryptPat(encrypted: string): string {
  const parts = encrypted.split(':');

  let version: number;
  let useLegacyDerivation: boolean;
  let ivHex: string;
  let authTagHex: string;
  let ciphertext: string;

  if (parts.length === 4 && /^[hv]\d+$/.test(parts[0]!)) {
    // Versioned format: h{N}|v{N}:iv:authTag:ciphertext
    version = parseInt(parts[0]!.slice(1), 10);
    useLegacyDerivation = parts[0]!.startsWith('v');
    ivHex = parts[1]!;
    authTagHex = parts[2]!;
    ciphertext = parts[3]!;
  } else if (parts.length === 3) {
    // Legacy format: iv:authTag:ciphertext (version 0, truncation derivation)
    version = 0;
    useLegacyDerivation = true;
    ivHex = parts[0]!;
    authTagHex = parts[1]!;
    ciphertext = parts[2]!;
  } else {
    throw new Error('Invalid encrypted PAT format');
  }

  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('Invalid encrypted PAT format');
  }

  const versionedKey = getEncryptionKeyByVersion(version);
  const key = useLegacyDerivation ? versionedKey.legacyKey : versionedKey.key;
  if (!key) {
    throw new Error(
      `Encryption key version ${version} cannot decrypt pre-HKDF data: the first 32 chars of the passphrase are not exactly 32 UTF-8 bytes`,
    );
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

/**
 * Re-encrypts a PAT with the latest key version and the current (HKDF) key
 * derivation. Returns the new encrypted string, or null if the input already
 * uses both. Pre-HKDF (`v{N}`/unversioned) data is always upgraded, even when
 * its key version is already the latest.
 */
export function reEncryptPat(encrypted: string): string | null {
  const latest = getLatestEncryptionKey();
  const parts = encrypted.split(':');

  // Already using the latest key version AND the HKDF derivation
  if (parts.length === 4 && parts[0] === `h${latest.version}`) {
    return null; // Already up to date
  }

  // Decrypt with current key, re-encrypt with latest
  const plaintext = decryptPat(encrypted);
  return encryptPat(plaintext);
}

const HEX_RE = /^[0-9a-f]+$/;

function isHexOfLength(value: string | undefined, length: number): boolean {
  return value !== undefined && value.length === length && HEX_RE.test(value);
}

/**
 * True when `value` is structurally a ciphertext produced by `encryptPat()`
 * (any historical format). Used to tell encrypted-at-rest secrets apart from
 * legacy plaintext values stored before encryption landed (issue #738, e.g.
 * `smtp_pass` in `admin_settings`). A plaintext secret can only collide by
 * containing colon-separated lowercase-hex groups of the exact IV / auth-tag
 * sizes, which is implausible for a human- or generator-chosen password.
 *
 * Limitation: rejects the output of `encryptPat('')` — an empty plaintext
 * yields an EMPTY ciphertext segment (`h{N}:iv:tag:`), and every segment
 * here must be non-empty hex. Unreachable today (callers persist empty
 * secrets as `''` instead of encrypting them), but a future caller must not
 * rely on this predicate to recognise an encrypted-empty secret — it would
 * be misclassified as plaintext and double-encrypted.
 */
export function isEncryptedSecretFormat(value: string): boolean {
  const parts = value.split(':');
  if (parts.length === 4) {
    return (
      /^[hv]\d+$/.test(parts[0]!) &&
      isHexOfLength(parts[1], IV_LENGTH * 2) &&
      isHexOfLength(parts[2], AUTH_TAG_LENGTH * 2) &&
      HEX_RE.test(parts[3]!)
    );
  }
  if (parts.length === 3) {
    return (
      isHexOfLength(parts[0], IV_LENGTH * 2) &&
      isHexOfLength(parts[1], AUTH_TAG_LENGTH * 2) &&
      HEX_RE.test(parts[2]!)
    );
  }
  return false;
}
