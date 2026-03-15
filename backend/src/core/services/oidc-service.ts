import { randomBytes, createHash } from 'crypto';
import * as jose from 'jose';
import { query } from '../db/postgres.js';
import { encryptPat, decryptPat } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { validateUrl } from '../utils/ssrf-guard.js';
import { getRedisClient } from './redis-cache.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OidcProviderConfig {
  id: number;
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
  redirectUri: string;
  groupsClaim: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export interface OidcTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OidcIdTokenClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  groups?: string[];
  [key: string]: unknown;
}

interface OidcAuthSession {
  state: string;
  nonce: string;
  codeVerifier: string;
  providerId: number;
  redirectUri: string;
}

// ── PKCE helpers ───────────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random code verifier for PKCE (RFC 7636).
 * 43-128 characters from the unreserved character set.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Computes the S256 code challenge from a code verifier.
 */
export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Generates a cryptographically random state or nonce parameter.
 */
export function generateRandomState(): string {
  return randomBytes(32).toString('base64url');
}

// ── Discovery ──────────────────────────────────────────────────────────────────

const DISCOVERY_CACHE_TTL = 3600; // 1 hour in seconds
const DISCOVERY_CACHE_PREFIX = 'oidc:discovery:';

/**
 * Fetches and caches the OIDC discovery document from the issuer.
 * Caches in Redis for 1 hour to avoid hitting the IdP on every auth attempt.
 */
export async function getDiscoveryDocument(
  issuerUrl: string,
): Promise<OidcDiscoveryDocument> {
  const redis = getRedisClient();
  const cacheKey = `${DISCOVERY_CACHE_PREFIX}${issuerUrl}`;

  // Try cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as OidcDiscoveryDocument;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read OIDC discovery from cache');
    }
  }

  // Fetch from IdP — validate URL to prevent SSRF attacks
  const discoveryUrl = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  validateUrl(discoveryUrl);
  const response = await fetch(discoveryUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed: ${response.status} ${response.statusText} from ${discoveryUrl}`,
    );
  }

  const doc = (await response.json()) as OidcDiscoveryDocument;

  // Validate required fields
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery document missing required fields');
  }

  // Per OIDC Discovery spec Section 4.3: the issuer in the discovery document
  // MUST exactly match the issuer URL used to retrieve the document.
  const normalizedIssuer = issuerUrl.replace(/\/$/, '');
  const normalizedDocIssuer = doc.issuer.replace(/\/$/, '');
  if (normalizedDocIssuer !== normalizedIssuer) {
    throw new Error(
      `OIDC issuer mismatch: expected '${normalizedIssuer}' but discovery document returned '${normalizedDocIssuer}'`,
    );
  }

  // Cache in Redis
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(doc), { EX: DISCOVERY_CACHE_TTL });
    } catch (err) {
      logger.warn({ err }, 'Failed to cache OIDC discovery document');
    }
  }

  return doc;
}

// ── Provider CRUD ──────────────────────────────────────────────────────────────

/**
 * Returns the enabled OIDC provider, or null if none is configured/enabled.
 * We support a single active provider for now (can be extended to multi-IdP later).
 */
export async function getEnabledProvider(): Promise<OidcProviderConfig | null> {
  const result = await query<{
    id: number;
    name: string;
    issuer_url: string;
    client_id: string;
    client_secret_encrypted: string;
    redirect_uri: string;
    groups_claim: string;
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, name, issuer_url, client_id, client_secret_encrypted, redirect_uri,
            groups_claim, enabled, created_at, updated_at
     FROM oidc_providers
     WHERE enabled = TRUE
     LIMIT 1`,
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecretEncrypted: row.client_secret_encrypted,
    redirectUri: row.redirect_uri,
    groupsClaim: row.groups_claim,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Returns the first OIDC provider regardless of enabled status.
 */
export async function getProvider(): Promise<OidcProviderConfig | null> {
  const result = await query<{
    id: number;
    name: string;
    issuer_url: string;
    client_id: string;
    client_secret_encrypted: string;
    redirect_uri: string;
    groups_claim: string;
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, name, issuer_url, client_id, client_secret_encrypted, redirect_uri,
            groups_claim, enabled, created_at, updated_at
     FROM oidc_providers
     ORDER BY id ASC
     LIMIT 1`,
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecretEncrypted: row.client_secret_encrypted,
    redirectUri: row.redirect_uri,
    groupsClaim: row.groups_claim,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates or updates the OIDC provider configuration.
 * Client secret is encrypted at rest using the same AES-256-GCM pattern as PATs.
 */
export async function upsertProvider(config: {
  name?: string;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  groupsClaim?: string;
  enabled?: boolean;
}): Promise<OidcProviderConfig> {
  const name = config.name ?? 'default';
  // Only encrypt the secret when a new value is provided (not undefined/null/empty).
  // When the frontend omits the secret, we preserve the existing encrypted value in the DB.
  const encryptedSecret = config.clientSecret ? encryptPat(config.clientSecret) : null;
  const groupsClaim = config.groupsClaim ?? 'groups';
  const enabled = config.enabled ?? false;

  const result = await query<{
    id: number;
    name: string;
    issuer_url: string;
    client_id: string;
    client_secret_encrypted: string;
    redirect_uri: string;
    groups_claim: string;
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO oidc_providers (name, issuer_url, client_id, client_secret_encrypted, redirect_uri, groups_claim, enabled)
     VALUES ($1, $2, $3, COALESCE($4, ''), $5, $6, $7)
     ON CONFLICT (name)
     DO UPDATE SET
       issuer_url = EXCLUDED.issuer_url,
       client_id = EXCLUDED.client_id,
       client_secret_encrypted = CASE WHEN $4 IS NULL THEN oidc_providers.client_secret_encrypted ELSE $4 END,
       redirect_uri = EXCLUDED.redirect_uri,
       groups_claim = EXCLUDED.groups_claim,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()
     RETURNING id, name, issuer_url, client_id, client_secret_encrypted, redirect_uri,
               groups_claim, enabled, created_at, updated_at`,
    [name, config.issuerUrl, config.clientId, encryptedSecret, config.redirectUri, groupsClaim, enabled],
  );

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecretEncrypted: row.client_secret_encrypted,
    redirectUri: row.redirect_uri,
    groupsClaim: row.groups_claim,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Auth session storage (Redis) ───────────────────────────────────────────────

const AUTH_SESSION_PREFIX = 'oidc:session:';
const AUTH_SESSION_TTL = 600; // 10 minutes

/**
 * Stores OIDC auth session data (state, nonce, code verifier) in Redis.
 * Keyed by the state parameter for lookup during callback.
 */
export async function storeAuthSession(session: OidcAuthSession): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis not available for OIDC session storage');
  }

  await redis.set(
    `${AUTH_SESSION_PREFIX}${session.state}`,
    JSON.stringify(session),
    { EX: AUTH_SESSION_TTL },
  );
}

/**
 * Retrieves and deletes an OIDC auth session from Redis (one-time use).
 */
export async function consumeAuthSession(state: string): Promise<OidcAuthSession | null> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis not available for OIDC session storage');
  }

  const key = `${AUTH_SESSION_PREFIX}${state}`;
  // Atomic get-and-delete prevents TOCTOU race (double-use of auth sessions)
  const data = await redis.getDel(key);
  if (!data) return null;

  return JSON.parse(data) as OidcAuthSession;
}

// ── Authorization URL ──────────────────────────────────────────────────────────

/**
 * Builds the authorization URL for the OIDC authorization code flow with PKCE.
 * Stores session data (state, nonce, code_verifier) in Redis.
 */
export async function buildAuthorizationUrl(
  provider: OidcProviderConfig,
): Promise<{ url: string; state: string }> {
  const discovery = await getDiscoveryDocument(provider.issuerUrl);

  const state = generateRandomState();
  const nonce = generateRandomState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Store session for callback validation
  await storeAuthSession({
    state,
    nonce,
    codeVerifier,
    providerId: provider.id,
    redirectUri: provider.redirectUri,
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const url = `${discovery.authorization_endpoint}?${params.toString()}`;
  return { url, state };
}

// ── Token Exchange ─────────────────────────────────────────────────────────────

/**
 * Exchanges an authorization code for tokens at the IdP token endpoint.
 */
export async function exchangeCodeForTokens(
  provider: OidcProviderConfig,
  code: string,
  codeVerifier: string,
): Promise<OidcTokenResponse> {
  const discovery = await getDiscoveryDocument(provider.issuerUrl);
  const clientSecret = decryptPat(provider.clientSecretEncrypted);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: provider.redirectUri,
    client_id: provider.clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });

  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, body: errorBody }, 'OIDC token exchange failed');
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return (await response.json()) as OidcTokenResponse;
}

// ── ID Token Verification ──────────────────────────────────────────────────────

// Cache JWKS resolvers per issuer to avoid re-fetching on every verification
const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(jwksUri: string): ReturnType<typeof jose.createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

/**
 * Verifies an OIDC ID token using the IdP's JWKS.
 * Validates signature, issuer, audience, expiry, and nonce.
 */
export async function verifyIdToken(
  idToken: string,
  provider: OidcProviderConfig,
  expectedNonce: string,
): Promise<OidcIdTokenClaims> {
  const discovery = await getDiscoveryDocument(provider.issuerUrl);
  const jwks = getJwks(discovery.jwks_uri);

  const { payload } = await jose.jwtVerify(idToken, jwks, {
    issuer: discovery.issuer,
    audience: provider.clientId,
    clockTolerance: 30, // 30 seconds tolerance
  });

  // Validate nonce manually (jose does not validate custom claims)
  if (payload.nonce !== expectedNonce) {
    throw new Error('ID token nonce mismatch');
  }

  // Validate sub claim is present
  if (!payload.sub) {
    throw new Error('ID token missing sub claim');
  }

  return payload as unknown as OidcIdTokenClaims;
}

// ── User Provisioning ──────────────────────────────────────────────────────────

/**
 * Finds or creates a user based on OIDC claims.
 *
 * - Looks up by oidc_sub + oidc_issuer
 * - If not found, auto-creates with auth_provider = 'oidc'
 * - If found, updates last login metadata
 *
 * Returns the user record for JWT generation.
 */
export async function provisionOidcUser(claims: OidcIdTokenClaims): Promise<{
  id: string;
  username: string;
  role: 'user' | 'admin';
}> {
  // 1. Look up existing user by OIDC subject + issuer
  const existing = await query<{ id: string; username: string; role: string }>(
    `SELECT id, username, role FROM users
     WHERE oidc_sub = $1 AND oidc_issuer = $2`,
    [claims.sub, claims.iss],
  );

  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    // Update last login timestamp
    await query(
      `UPDATE users SET updated_at = NOW() WHERE id = $1`,
      [user.id],
    );
    logger.info({ userId: user.id, sub: claims.sub }, 'OIDC user logged in');
    return {
      id: user.id,
      username: user.username,
      role: user.role as 'user' | 'admin',
    };
  }

  // 2. Auto-create new user
  const username = claims.preferred_username
    ?? claims.email
    ?? `oidc-${claims.sub.slice(0, 12)}`;

  // Ensure uniqueness by appending random suffix if username is taken
  let finalUsername = username;
  const usernameCheck = await query(
    'SELECT 1 FROM users WHERE username = $1',
    [username],
  );
  if (usernameCheck.rows.length > 0) {
    finalUsername = `${username}-${randomBytes(3).toString('hex')}`;
  }

  // OIDC users get a random unusable password hash (they authenticate via IdP)
  const unusablePasswordHash = `$oidc$${randomBytes(32).toString('hex')}`;

  const result = await query<{ id: string; username: string; role: string }>(
    `INSERT INTO users (username, password_hash, role, auth_provider, oidc_sub, oidc_issuer)
     VALUES ($1, $2, 'user', 'oidc', $3, $4)
     RETURNING id, username, role`,
    [finalUsername, unusablePasswordHash, claims.sub, claims.iss],
  );

  const newUser = result.rows[0];

  // Create default user_settings row
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [newUser.id]);

  logger.info(
    { userId: newUser.id, username: finalUsername, sub: claims.sub },
    'OIDC user auto-provisioned',
  );

  return {
    id: newUser.id,
    username: newUser.username,
    role: newUser.role as 'user' | 'admin',
  };
}

// ── Group Sync ─────────────────────────────────────────────────────────────────

/**
 * Synchronizes a user's OIDC group memberships:
 * 1. Extract groups from ID token claims
 * 2. For each group, find or create a matching group (source='oidc')
 * 3. Add user to new groups, remove from stale ones
 * 4. Apply oidc_group_role_mappings to create space_role_assignments
 */
export async function syncOidcGroups(
  userId: string,
  claims: OidcIdTokenClaims,
  groupsClaim: string,
): Promise<void> {
  const oidcGroups = (claims[groupsClaim] as string[] | undefined) ?? [];

  if (oidcGroups.length === 0) {
    // Remove all OIDC group memberships for this user
    await query(
      `DELETE FROM group_memberships
       WHERE user_id = $1 AND source = 'oidc'`,
      [userId],
    );
    logger.debug({ userId }, 'No OIDC groups in token — cleared OIDC memberships');
    return;
  }

  // 1. Ensure all OIDC groups exist in the groups table
  for (const groupName of oidcGroups) {
    await query(
      `INSERT INTO groups (name, source, oidc_claim, description)
       VALUES ($1, 'oidc', $1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [groupName, `Auto-created from OIDC claim`],
    );
  }

  // 2. Get IDs of the OIDC groups the user should be in
  const groupsResult = await query<{ id: number; name: string }>(
    `SELECT id, name FROM groups WHERE source = 'oidc' AND name = ANY($1)`,
    [oidcGroups],
  );
  const desiredGroupIds = new Set(groupsResult.rows.map((r) => r.id));

  // 3. Get current OIDC memberships
  const currentResult = await query<{ group_id: number }>(
    `SELECT group_id FROM group_memberships
     WHERE user_id = $1 AND source = 'oidc'`,
    [userId],
  );
  const currentGroupIds = new Set(currentResult.rows.map((r) => r.group_id));

  // 4. Add missing memberships
  for (const groupId of desiredGroupIds) {
    if (!currentGroupIds.has(groupId)) {
      await query(
        `INSERT INTO group_memberships (group_id, user_id, source)
         VALUES ($1, $2, 'oidc')
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, userId],
      );
    }
  }

  // 5. Remove stale memberships (groups user is no longer part of)
  for (const groupId of currentGroupIds) {
    if (!desiredGroupIds.has(groupId)) {
      await query(
        `DELETE FROM group_memberships
         WHERE group_id = $1 AND user_id = $2 AND source = 'oidc'`,
        [groupId, userId],
      );
    }
  }

  // 6. Apply oidc_group_role_mappings → space_role_assignments
  await applyOidcRoleMappings(userId, oidcGroups);

  logger.info(
    { userId, groupCount: oidcGroups.length },
    'OIDC group memberships synced',
  );
}

/**
 * Applies OIDC group role mappings to create/update space role assignments.
 * For each mapping, ensures the user has the mapped role in the mapped space.
 */
async function applyOidcRoleMappings(
  userId: string,
  oidcGroups: string[],
): Promise<void> {
  if (oidcGroups.length === 0) return;

  // Get all mappings for the user's OIDC groups
  const mappings = await query<{
    oidc_group: string;
    role_id: number;
    space_key: string | null;
  }>(
    `SELECT oidc_group, role_id, space_key
     FROM oidc_group_role_mappings
     WHERE oidc_group = ANY($1) AND role_id IS NOT NULL`,
    [oidcGroups],
  );

  for (const mapping of mappings.rows) {
    if (!mapping.space_key) continue; // Skip mappings without a space

    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT (space_key, principal_type, principal_id)
       DO UPDATE SET role_id = EXCLUDED.role_id`,
      [mapping.space_key, userId, mapping.role_id],
    );
  }
}

// ── Group Role Mapping CRUD ────────────────────────────────────────────────────

export interface OidcGroupRoleMapping {
  id: number;
  oidcGroup: string;
  roleId: number | null;
  roleName: string | null;
  spaceKey: string | null;
}

export async function listOidcGroupRoleMappings(): Promise<OidcGroupRoleMapping[]> {
  const result = await query<{
    id: number;
    oidc_group: string;
    role_id: number | null;
    role_name: string | null;
    space_key: string | null;
  }>(
    `SELECT m.id, m.oidc_group, m.role_id, r.name AS role_name, m.space_key
     FROM oidc_group_role_mappings m
     LEFT JOIN roles r ON r.id = m.role_id
     ORDER BY m.oidc_group, m.space_key`,
  );

  return result.rows.map((r) => ({
    id: r.id,
    oidcGroup: r.oidc_group,
    roleId: r.role_id,
    roleName: r.role_name,
    spaceKey: r.space_key,
  }));
}

export async function createOidcGroupRoleMapping(mapping: {
  oidcGroup: string;
  roleId: number;
  spaceKey: string | null;
}): Promise<OidcGroupRoleMapping> {
  const result = await query<{
    id: number;
    oidc_group: string;
    role_id: number | null;
    space_key: string | null;
  }>(
    `INSERT INTO oidc_group_role_mappings (oidc_group, role_id, space_key)
     VALUES ($1, $2, $3)
     RETURNING id, oidc_group, role_id, space_key`,
    [mapping.oidcGroup, mapping.roleId, mapping.spaceKey ?? null],
  );

  const row = result.rows[0];

  // Look up role name
  const roleResult = await query<{ name: string }>(
    'SELECT name FROM roles WHERE id = $1',
    [row.role_id],
  );

  return {
    id: row.id,
    oidcGroup: row.oidc_group,
    roleId: row.role_id,
    roleName: roleResult.rows[0]?.name ?? null,
    spaceKey: row.space_key,
  };
}

export async function deleteOidcGroupRoleMapping(id: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM oidc_group_role_mappings WHERE id = $1 RETURNING id',
    [id],
  );
  return result.rows.length > 0;
}

// ── Clear cached JWKS (for testing) ────────────────────────────────────────────

export function clearJwksCache(): void {
  jwksCache.clear();
}
