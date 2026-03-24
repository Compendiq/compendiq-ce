# Enterprise Architecture: Two-Repository Open-Core Model

**Status**: Proposed
**Authors**: Chief Architect
**Date**: 2026-03-24
**Related**: ADR-001 (Project Structure), PR #549 (to be reworked), PR #553 (depends on #549)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Repository Structure](#2-repository-structure)
3. [Package Design](#3-package-design)
4. [Integration Layer (Plugin Loader)](#4-integration-layer-plugin-loader)
5. [License System (Ed25519)](#5-license-system-ed25519)
6. [Route Gating](#6-route-gating)
7. [Frontend Integration](#7-frontend-integration)
8. [Build and Deploy](#8-build-and-deploy)
9. [Migration Plan](#9-migration-plan)
10. [Security Considerations](#10-security-considerations)
11. [Testing Strategy](#11-testing-strategy)
12. [Enterprise Feature Roadmap](#12-enterprise-feature-roadmap)
13. [ADR: Enterprise Separation](#13-adr-enterprise-separation)

---

## 1. Executive Summary

AtlasMind adopts an **open-core** model with two repositories:

| Repository | Visibility | Purpose |
|-----------|-----------|---------|
| `atlasmind` (existing) | **Public** | Open-source core product. All features except enterprise-gated ones. |
| `atlasmind-enterprise` (new) | **Private** | Enterprise features, license verification, enterprise UI components. Published as `@atlasmind/enterprise` via GitHub Packages. |

**Principle**: The open repository must contain zero enterprise logic. It defines extension points (hooks, slots, plugin contracts) that the enterprise package fills. If `@atlasmind/enterprise` is not installed, the app runs in community mode with no degradation, no error messages, and no awareness that enterprise features even exist.

**Integration mechanism**: Optional dynamic `import()` with a thin loader abstraction in the open repo. The enterprise package is never listed in `package.json` dependencies. It is installed separately (via `.npmrc` with GitHub Packages registry) and discovered at runtime.

---

## 2. Repository Structure

### 2.1 Open Repository (`atlasmind`)

Changes to the existing structure are minimal. We add a thin plugin loader layer:

```
atlasmind/                           # PUBLIC REPO (existing)
├── backend/src/
│   ├── core/
│   │   ├── enterprise/              # NEW: Plugin loader + type contracts
│   │   │   ├── loader.ts            # Dynamic import, caches result
│   │   │   ├── types.ts             # EnterprisePlugin interface (exported)
│   │   │   └── noop.ts              # Community-mode stub (all features disabled)
│   │   ├── plugins/
│   │   ├── services/
│   │   └── ...
│   ├── routes/
│   │   └── foundation/
│   │       ├── oidc.ts              # UNCHANGED (OIDC implementation stays here)
│   │       ├── admin.ts             # Adds GET /api/admin/license via loader
│   │       └── ...
│   └── app.ts                       # Calls enterprise loader during bootstrap
├── frontend/src/
│   ├── shared/
│   │   ├── enterprise/              # NEW: Frontend plugin loader
│   │   │   ├── context.tsx          # EnterpriseContext provider
│   │   │   ├── types.ts             # EnterpriseUI interface
│   │   │   └── loader.ts            # Dynamic import of frontend components
│   │   └── ...
│   └── ...
├── packages/contracts/src/
│   └── schemas/
│       └── enterprise.ts            # NEW: Shared Zod schemas for license API
└── ...
```

### 2.2 Private Repository (`atlasmind-enterprise`)

```
atlasmind-enterprise/                # PRIVATE REPO (new)
├── src/
│   ├── index.ts                     # Main entry: exports EnterprisePlugin impl
│   ├── license/
│   │   ├── types.ts                 # LicenseInfo, LicenseTier, feature flags
│   │   ├── verify.ts                # Ed25519 verification (public key embedded)
│   │   ├── keys/
│   │   │   └── public.ts            # Embedded Ed25519 public key (base64)
│   │   └── constants.ts             # Feature flag definitions per tier
│   ├── middleware/
│   │   ├── license-gate.ts          # Fastify preHandler: 403 if feature not licensed
│   │   └── seat-check.ts            # Seat count enforcement (future)
│   ├── routes/
│   │   └── license-routes.ts        # GET /api/admin/license implementation
│   ├── frontend/
│   │   ├── index.ts                 # Exports EnterpriseUI implementation
│   │   ├── LicenseStatusCard.tsx    # Admin UI: license info display
│   │   ├── EnterpriseBanner.tsx     # "Enterprise required" banner component
│   │   └── EnterpriseGate.tsx       # Wrapper: renders children only if licensed
│   └── peer-types.d.ts             # Type-only imports from @atlasmind/contracts
├── scripts/
│   ├── generate-keypair.ts          # One-time: generates Ed25519 key pair
│   ├── create-license.ts            # CLI: signs a license key
│   └── verify-license.ts            # CLI: validates a license key (testing)
├── keys/
│   └── .gitignore                   # Private key NEVER committed (see README)
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── .github/
│   └── workflows/
│       └── publish.yml              # CI: build + publish to GitHub Packages
├── CHANGELOG.md
└── README.md
```

### 2.3 Key Design Decisions

**OIDC code stays in the open repo.** The OIDC implementation (`oidc-service.ts`, `oidc.ts` routes, `OidcSettingsPage.tsx`) is substantial (~700 lines) and deeply integrated with core auth, Redis, and the database. Moving it to the enterprise package would create a massive coupling surface. Instead:

- The OIDC *code* remains in the open repo (anyone can read it, audit it, contribute fixes).
- The enterprise package provides a *gate function* that the open repo calls before registering OIDC routes.
- Without a valid enterprise license, OIDC routes are simply not registered. The admin UI hides the OIDC settings page.

This is the same pattern used by GitLab (OIDC code is open-source, but EE license gates access to it).

---

## 3. Package Design

### 3.1 Package Identity

```json
{
  "name": "@atlasmind/enterprise",
  "version": "1.0.0",
  "license": "BUSL-1.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./frontend": {
      "import": "./dist/frontend/index.js",
      "types": "./dist/frontend/index.d.ts"
    }
  },
  "peerDependencies": {
    "fastify": "^5.0.0"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

### 3.2 Exports Surface

The package exports exactly two things:

```typescript
// @atlasmind/enterprise (backend)
export interface EnterprisePlugin {
  /** Validate the license key and return parsed info, or null if invalid/missing. */
  validateLicense(key: string | undefined): LicenseInfo | null;

  /** Check if a specific feature is available under the current license. */
  isFeatureEnabled(feature: string, license: LicenseInfo | null): boolean;

  /** Fastify preHandler that returns 403 if the feature is not licensed. */
  requireFeature(feature: string): FastifyPreHandler;

  /** Register enterprise-specific routes (e.g., GET /api/admin/license). */
  registerRoutes(fastify: FastifyInstance, license: LicenseInfo | null): Promise<void>;

  /** Version of the enterprise package. */
  version: string;
}

// @atlasmind/enterprise/frontend
export interface EnterpriseUI {
  /** License status card for the admin panel. */
  LicenseStatusCard: React.ComponentType<{ license: LicenseInfo | null }>;

  /** Banner shown when an enterprise feature is required. */
  EnterpriseBanner: React.ComponentType<{ feature: string }>;

  /** Gate component: renders children only if feature is licensed. */
  EnterpriseGate: React.ComponentType<{
    feature: string;
    fallback?: React.ReactNode;
    children: React.ReactNode;
  }>;

  /** Version of the enterprise frontend package. */
  version: string;
}
```

### 3.3 Versioning Strategy

- Enterprise package version tracks the open repo version: `1.x.y` where `x.y` matches the AtlasMind release it targets.
- The enterprise package declares the open repo's contracts package as a peer dependency for type compatibility.
- Breaking changes to the plugin interface require a major version bump in both repos.

**Version compatibility matrix** (maintained in the enterprise repo's README):

| @atlasmind/enterprise | AtlasMind | Notes |
|-----------------------|-----------|-------|
| 1.0.x | 1.0.x | Initial release |
| 1.1.x | 1.1.x | Added seat enforcement |

---

## 4. Integration Layer (Plugin Loader)

### 4.1 Backend Loader (`backend/src/core/enterprise/loader.ts`)

```typescript
import type { EnterprisePlugin } from './types.js';
import { noopPlugin } from './noop.js';
import { logger } from '../utils/logger.js';

let cached: EnterprisePlugin | null = null;
let loaded = false;

/**
 * Attempts to load the enterprise plugin via dynamic import.
 * Returns the noop (community) plugin if the package is not installed.
 * Result is cached after first call.
 */
export async function loadEnterprisePlugin(): Promise<EnterprisePlugin> {
  if (loaded) return cached ?? noopPlugin;

  try {
    const mod = await import('@atlasmind/enterprise');
    // Validate the module exports the expected interface
    if (mod && typeof mod.validateLicense === 'function') {
      cached = mod as EnterprisePlugin;
      logger.info(
        { version: mod.version },
        'Enterprise plugin loaded',
      );
    } else {
      logger.warn('Enterprise package found but exports are invalid');
      cached = null;
    }
  } catch {
    // Package not installed - this is normal for community edition
    cached = null;
  }

  loaded = true;
  return cached ?? noopPlugin;
}

/**
 * Synchronous getter. Only valid after loadEnterprisePlugin() has been called.
 * Returns noopPlugin if enterprise is not loaded.
 */
export function getEnterprisePlugin(): EnterprisePlugin {
  return cached ?? noopPlugin;
}
```

### 4.2 Noop Plugin (`backend/src/core/enterprise/noop.ts`)

```typescript
import type { EnterprisePlugin } from './types.js';

/**
 * Community-mode stub. All features are disabled.
 * No error logging, no degradation messages. Community IS the default.
 */
export const noopPlugin: EnterprisePlugin = {
  validateLicense: () => null,
  isFeatureEnabled: () => false,
  requireFeature: () => async (_req, reply) => {
    reply.status(403).send({
      error: 'EnterpriseRequired',
      message: 'This feature requires an enterprise license',
      statusCode: 403,
    });
  },
  registerRoutes: async () => {},
  version: 'community',
};
```

### 4.3 Type Contracts (`backend/src/core/enterprise/types.ts`)

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export type FastifyPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export type LicenseTier = 'community' | 'team' | 'enterprise';

export interface LicenseInfo {
  tier: LicenseTier;
  seats: number;
  expiresAt: Date;
  isValid: boolean;
  /** Raw license key string (for display, not for verification) */
  displayKey: string;
}

export interface EnterprisePlugin {
  validateLicense(key: string | undefined): LicenseInfo | null;
  isFeatureEnabled(feature: string, license: LicenseInfo | null): boolean;
  requireFeature(feature: string): FastifyPreHandler;
  registerRoutes(
    fastify: FastifyInstance,
    license: LicenseInfo | null,
  ): Promise<void>;
  version: string;
}

/**
 * Feature flag constants. Defined in the open repo so both repos share
 * the same string identifiers. The enterprise package maps these to tiers.
 *
 * See docs/ENTERPRISE-ROADMAP.md for implementation timeline.
 */
export const ENTERPRISE_FEATURES = {
  // ── Identity & Access Management ──
  OIDC_SSO: 'oidc_sso',
  OIDC_GROUP_MAPPINGS: 'oidc_group_mappings',
  SCIM_PROVISIONING: 'scim_provisioning',
  ADVANCED_RBAC: 'advanced_rbac',
  ABAC_PERMISSIONS: 'abac_permissions',
  IP_ALLOWLISTING: 'ip_allowlisting',
  LDAP_GROUP_SYNC: 'ldap_group_sync',

  // ── AI Governance ──
  RAG_PERMISSION_ENFORCEMENT: 'rag_permission_enforcement',
  LLM_AUDIT_TRAIL: 'llm_audit_trail',
  ORG_LLM_POLICY: 'org_llm_policy',
  AI_OUTPUT_REVIEW: 'ai_output_review',
  PII_DETECTION: 'pii_detection',

  // ── Compliance & Audit ──
  AUDIT_LOG_EXPORT: 'audit_log_export',
  DATA_RETENTION_POLICIES: 'data_retention_policies',
  COMPLIANCE_REPORTS: 'compliance_reports',
  VERSION_SNAPSHOT_ARCHIVAL: 'version_snapshot_archival',

  // ── Analytics & Reporting ──
  ADVANCED_ANALYTICS: 'advanced_analytics',
  AI_USAGE_ANALYTICS: 'ai_usage_analytics',

  // ── Organizational Scale ──
  SEAT_ENFORCEMENT: 'seat_enforcement',
  UNLIMITED_SPACES: 'unlimited_spaces',
  MULTI_INSTANCE: 'multi_instance',
  BULK_USER_OPERATIONS: 'bulk_user_operations',
  BATCH_PAGE_OPERATIONS: 'batch_page_operations',

  // ── Integrations ──
  SLACK_TEAMS_DEEP: 'slack_teams_deep',
  WEBHOOK_PUSH: 'webhook_push',
} as const;

export type EnterpriseFeature =
  (typeof ENTERPRISE_FEATURES)[keyof typeof ENTERPRISE_FEATURES];
```

### 4.4 Bootstrap Integration (`app.ts` changes)

```typescript
// In buildApp(), after registering core plugins:

import { loadEnterprisePlugin, getEnterprisePlugin } from './core/enterprise/loader.js';

export async function buildApp() {
  const app = Fastify({ ... });

  // ... existing plugin registration ...

  // ── Enterprise Plugin Bootstrap ──────────────────────────────
  const enterprise = await loadEnterprisePlugin();
  const licenseKey = process.env.ATLASMIND_LICENSE_KEY;
  const license = enterprise.validateLicense(licenseKey);

  // Store license info for route handlers to access
  app.decorate('license', license);
  app.decorate('enterprise', enterprise);

  // Register enterprise routes (e.g., GET /api/admin/license)
  await enterprise.registerRoutes(app, license);

  // ── Conditional OIDC Registration ────────────────────────────
  if (enterprise.isFeatureEnabled(ENTERPRISE_FEATURES.OIDC_SSO, license)) {
    await app.register(oidcRoutes, { prefix: '/api' });
    await app.register(oidcAdminRoutes, { prefix: '/api' });
    logger.info('OIDC routes registered (enterprise license active)');
  }

  // ... rest of route registration ...
}
```

### 4.5 Fastify Type Augmentation

```typescript
// In backend/src/core/enterprise/types.ts
declare module 'fastify' {
  interface FastifyInstance {
    license: LicenseInfo | null;
    enterprise: EnterprisePlugin;
  }
}
```

---

## 5. License System (Ed25519)

### 5.1 Architecture Overview

```
                    PRIVATE REPO                              OPEN REPO / DEPLOYED
                    (atlasmind-enterprise)                    (atlasmind + @atlasmind/enterprise)

   ┌─────────────────────────┐              ┌──────────────────────────────────────┐
   │ scripts/generate-keypair│              │                                      │
   │  - Ed25519 key pair     │              │  @atlasmind/enterprise package       │
   │  - private.pem (SECRET) │              │  ┌──────────────────────────┐        │
   │  - public.pem           │──embeds──▶   │  │ license/keys/public.ts  │        │
   │                         │              │  │ (public key as base64)  │        │
   └────────┬────────────────┘              │  └──────────┬───────────────┘        │
            │                               │             │                        │
   ┌────────▼────────────────┐              │  ┌──────────▼───────────────┐        │
   │ scripts/create-license  │              │  │ license/verify.ts        │        │
   │                         │              │  │ - crypto.verify(ed25519) │        │
   │ Input:                  │              │  │ - parse ATM- format      │        │
   │   --tier enterprise     │              │  │ - check expiry/seats     │        │
   │   --seats 50            │              │  └──────────────────────────┘        │
   │   --expires 2027-12-31  │              │                                      │
   │                         │              └──────────────────────────────────────┘
   │ Output:                 │
   │   ATM-enterprise-50-    │              Environment variable:
   │   20271231.{signature}  │──────────▶   ATLASMIND_LICENSE_KEY=ATM-enterprise-50-20271231.{sig}
   └─────────────────────────┘
```

### 5.2 Key Generation (one-time, in private repo)

```typescript
// scripts/generate-keypair.ts
import { generateKeyPairSync } from 'crypto';
import { writeFileSync } from 'fs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

writeFileSync(
  'keys/private.pem',
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
);
writeFileSync(
  'keys/public.pem',
  publicKey.export({ type: 'spki', format: 'pem' }),
);

// Also output the public key as base64 for embedding
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
console.log('Embed this in src/license/keys/public.ts:');
console.log(`export const PUBLIC_KEY_DER = '${pubDer.toString('base64')}';`);
```

**Security**: `keys/private.pem` is in `.gitignore`. It lives only on the developer's machine (or in a secrets manager for CI). It is NEVER in a Docker image, NEVER deployed, NEVER in the npm package.

### 5.3 License Key Format

```
ATM-{tier}-{seats}-{expiryYYYYMMDD}.{base64url_ed25519_signature}
```

Examples:
```
ATM-enterprise-50-20271231.MEUCIQDp7a... (truncated)
ATM-team-10-20270630.MEQCIG3b...
```

The **payload** (everything before the `.`) is the data that is signed. The **signature** (everything after the `.`) is a base64url-encoded Ed25519 signature of the payload bytes.

### 5.4 License Creation CLI (private repo)

```typescript
// scripts/create-license.ts
import { readFileSync } from 'fs';
import { createPrivateKey, sign } from 'crypto';
import { parseArgs } from 'util';

const { values } = parseArgs({
  options: {
    tier: { type: 'string', short: 't' },
    seats: { type: 'string', short: 's' },
    expires: { type: 'string', short: 'e' }, // YYYY-MM-DD
  },
});

const tier = values.tier as string;
const seats = parseInt(values.seats as string, 10);
const expiryDate = (values.expires as string).replace(/-/g, '');

// Validate
if (!['team', 'enterprise'].includes(tier)) {
  throw new Error('Tier must be "team" or "enterprise"');
}
if (isNaN(seats) || seats < 1) {
  throw new Error('Seats must be a positive integer');
}
if (!/^\d{8}$/.test(expiryDate)) {
  throw new Error('Expiry must be YYYY-MM-DD format');
}

const payload = `ATM-${tier}-${seats}-${expiryDate}`;
const privateKeyPem = readFileSync('keys/private.pem', 'utf-8');
const privateKey = createPrivateKey(privateKeyPem);

const signature = sign(null, Buffer.from(payload, 'utf-8'), privateKey);
const signatureB64 = signature
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const licenseKey = `${payload}.${signatureB64}`;
console.log(licenseKey);
```

### 5.5 License Verification (enterprise package)

```typescript
// src/license/verify.ts
import { createPublicKey, verify } from 'crypto';
import { PUBLIC_KEY_DER } from './keys/public.js';
import type { LicenseInfo, LicenseTier } from './types.js';

const VALID_TIERS: Set<string> = new Set(['community', 'team', 'enterprise']);
const LICENSE_REGEX = /^ATM-(community|team|enterprise)-(\d+)-(\d{8})\.(.+)$/;

function base64urlToBuffer(str: string): Buffer {
  // Restore standard base64 padding
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export function verifyLicenseKey(key: string | undefined): LicenseInfo | null {
  if (!key || typeof key !== 'string') return null;

  const match = key.match(LICENSE_REGEX);
  if (!match) return null;

  const [, tier, seatsStr, expiryStr, signatureB64] = match;
  if (!VALID_TIERS.has(tier)) return null;

  // Reconstruct the payload (everything before the last dot)
  const lastDot = key.lastIndexOf('.');
  const payload = key.substring(0, lastDot);
  const signatureBuffer = base64urlToBuffer(signatureB64);

  // Ed25519 verification
  const publicKey = createPublicKey({
    key: Buffer.from(PUBLIC_KEY_DER, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const isSignatureValid = verify(
    null, // Ed25519 does not use a separate hash algorithm
    Buffer.from(payload, 'utf-8'),
    publicKey,
    signatureBuffer,
  );

  if (!isSignatureValid) return null;

  // Parse expiry
  const year = parseInt(expiryStr.substring(0, 4), 10);
  const month = parseInt(expiryStr.substring(4, 6), 10) - 1;
  const day = parseInt(expiryStr.substring(6, 8), 10);
  const expiresAt = new Date(year, month, day, 23, 59, 59, 999);
  const isExpired = expiresAt < new Date();

  return {
    tier: tier as LicenseTier,
    seats: parseInt(seatsStr, 10),
    expiresAt,
    isValid: !isExpired,
    displayKey: `ATM-${tier}-${seatsStr}-${expiryStr}`,
  };
}
```

### 5.6 Environment Variable

```bash
# .env (never committed)
ATLASMIND_LICENSE_KEY=ATM-enterprise-50-20271231.MEUCIQDp7a...
```

The license key is passed as a single environment variable. The open repo's loader reads `process.env.ATLASMIND_LICENSE_KEY` and passes it to the enterprise plugin's `validateLicense()`.

---

## 6. Route Gating

### 6.1 Pattern: Conditional Route Registration

Instead of attaching middleware to every enterprise route, we use **conditional registration** -- enterprise routes are only registered on the Fastify instance if the license permits them.

This is cleaner than per-route middleware because:
- Routes don't exist in community mode (no 403 noise in logs)
- No performance overhead for community users
- Swagger/OpenAPI docs only show available routes
- The OIDC code itself doesn't need to know about licensing

```typescript
// In app.ts - buildApp()

const enterprise = await loadEnterprisePlugin();
const license = enterprise.validateLicense(process.env.ATLASMIND_LICENSE_KEY);

// OIDC routes: only registered if enterprise license includes OIDC feature
if (enterprise.isFeatureEnabled(ENTERPRISE_FEATURES.OIDC_SSO, license)) {
  await app.register(oidcRoutes, { prefix: '/api' });
  await app.register(oidcAdminRoutes, { prefix: '/api' });
}

// Future: Advanced RBAC routes
if (enterprise.isFeatureEnabled(ENTERPRISE_FEATURES.ADVANCED_RBAC, license)) {
  // await app.register(advancedRbacRoutes, { prefix: '/api' });
}
```

### 6.2 License Status Endpoint

The enterprise package registers a single route for querying license status:

```typescript
// In the enterprise package: src/routes/license-routes.ts
export async function registerLicenseRoutes(
  fastify: FastifyInstance,
  license: LicenseInfo | null,
) {
  fastify.get('/admin/license', {
    onRequest: [fastify.requireAdmin],
  }, async () => {
    if (!license) {
      return {
        edition: 'community',
        tier: 'community',
        features: [],
      };
    }

    return {
      edition: 'enterprise',
      tier: license.tier,
      seats: license.seats,
      expiresAt: license.expiresAt.toISOString(),
      isValid: license.isValid,
      displayKey: license.displayKey,
      features: getEnabledFeatures(license),
    };
  });
}
```

When the enterprise package is not installed, the noop plugin's `registerRoutes` is a no-op. The open repo adds a simple fallback:

```typescript
// In admin.ts - always registered
fastify.get('/admin/license', ADMIN_RATE_LIMIT, async () => {
  // Enterprise package may override this route.
  // If not, return community status.
  return {
    edition: 'community',
    tier: 'community',
    features: [],
  };
});
```

### 6.3 Feature-to-Tier Mapping (enterprise package)

```typescript
// src/license/constants.ts (in enterprise package)
const FEATURE_TIERS: Record<string, LicenseTier[]> = {
  // Identity & Access Management
  oidc_sso: ['enterprise'],
  oidc_group_mappings: ['enterprise'],
  scim_provisioning: ['enterprise'],
  advanced_rbac: ['enterprise'],
  abac_permissions: ['enterprise'],
  ip_allowlisting: ['enterprise'],
  ldap_group_sync: ['enterprise'],

  // AI Governance
  rag_permission_enforcement: ['enterprise'],
  llm_audit_trail: ['enterprise'],
  org_llm_policy: ['enterprise'],
  ai_output_review: ['enterprise'],
  pii_detection: ['enterprise'],

  // Compliance & Audit
  audit_log_export: ['enterprise'],
  data_retention_policies: ['enterprise'],
  compliance_reports: ['enterprise'],
  version_snapshot_archival: ['enterprise'],

  // Analytics & Reporting
  advanced_analytics: ['team', 'enterprise'],
  ai_usage_analytics: ['enterprise'],

  // Organizational Scale
  seat_enforcement: ['team', 'enterprise'],
  unlimited_spaces: ['team', 'enterprise'],
  multi_instance: ['enterprise'],
  bulk_user_operations: ['enterprise'],
  batch_page_operations: ['enterprise'],

  // Integrations
  slack_teams_deep: ['enterprise'],
  webhook_push: ['enterprise'],
};

export function isFeatureAvailable(
  feature: string,
  license: LicenseInfo | null,
): boolean {
  if (!license || !license.isValid) return false;
  const allowedTiers = FEATURE_TIERS[feature];
  if (!allowedTiers) return false;
  return allowedTiers.includes(license.tier);
}
```

---

## 7. Frontend Integration

### 7.1 Frontend Plugin Loader

```typescript
// frontend/src/shared/enterprise/loader.ts
import type { EnterpriseUI } from './types';

let cached: EnterpriseUI | null = null;
let loaded = false;

export async function loadEnterpriseUI(): Promise<EnterpriseUI | null> {
  if (loaded) return cached;

  try {
    const mod = await import('@atlasmind/enterprise/frontend');
    if (mod && typeof mod.LicenseStatusCard === 'function') {
      cached = mod as EnterpriseUI;
    }
  } catch {
    // Not installed - community mode
    cached = null;
  }

  loaded = true;
  return cached;
}
```

### 7.2 Enterprise Context

```typescript
// frontend/src/shared/enterprise/context.tsx
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { EnterpriseUI, LicenseInfo } from './types';
import { loadEnterpriseUI } from './loader';
import { apiFetch } from '../lib/api';

interface EnterpriseContextValue {
  /** null = community mode, object = enterprise loaded */
  ui: EnterpriseUI | null;
  /** License info from the backend */
  license: LicenseInfo | null;
  /** Whether the enterprise plugin is available (even if license is invalid) */
  isEnterprise: boolean;
  /** Whether a specific feature is enabled */
  hasFeature: (feature: string) => boolean;
  /** Loading state */
  isLoading: boolean;
}

const EnterpriseContext = createContext<EnterpriseContextValue>({
  ui: null,
  license: null,
  isEnterprise: false,
  hasFeature: () => false,
  isLoading: true,
});

export function EnterpriseProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<EnterpriseUI | null>(null);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Load enterprise UI module (fast, just a dynamic import)
      const enterpriseUi = await loadEnterpriseUI();
      if (cancelled) return;
      setUi(enterpriseUi);

      // Fetch license info from backend
      if (enterpriseUi) {
        try {
          const info = await apiFetch<LicenseInfo>('/admin/license');
          if (!cancelled) setLicense(info);
        } catch {
          // Not admin or endpoint not available
        }
      }

      if (!cancelled) setIsLoading(false);
    }

    init();
    return () => { cancelled = true; };
  }, []);

  const hasFeature = (feature: string): boolean => {
    if (!license || !license.isValid) return false;
    return (license.features ?? []).includes(feature);
  };

  return (
    <EnterpriseContext.Provider value={{
      ui,
      license,
      isEnterprise: !!ui,
      hasFeature,
      isLoading,
    }}>
      {children}
    </EnterpriseContext.Provider>
  );
}

export function useEnterprise() {
  return useContext(EnterpriseContext);
}
```

### 7.3 Conditional UI Rendering

The frontend uses the context to conditionally render enterprise UI:

```tsx
// In App.tsx - OIDC settings route
import { useEnterprise } from './shared/enterprise/context';

// Inside the router:
const { hasFeature } = useEnterprise();

// Only show OIDC settings if feature is enabled
{hasFeature('oidc_sso') && (
  <Route
    path="/settings/oidc"
    element={<AdminRoute><OidcSettingsPage /></AdminRoute>}
  />
)}
```

```tsx
// In the admin settings sidebar navigation
function AdminNav() {
  const { hasFeature, ui } = useEnterprise();

  return (
    <nav>
      <NavLink to="/settings">General</NavLink>
      {hasFeature('oidc_sso') && (
        <NavLink to="/settings/oidc">SSO / OIDC</NavLink>
      )}
      {/* License status card in admin panel */}
      {ui?.LicenseStatusCard && (
        <ui.LicenseStatusCard license={license} />
      )}
    </nav>
  );
}
```

### 7.4 Enterprise Gate Component (provided by enterprise package)

```tsx
// Usage in the open repo:
import { useEnterprise } from './shared/enterprise/context';

function SomeAdminPage() {
  const { ui } = useEnterprise();
  const Gate = ui?.EnterpriseGate;

  return (
    <div>
      <h1>Admin Settings</h1>
      {Gate ? (
        <Gate feature="audit_log_export" fallback={null}>
          <AuditLogExportButton />
        </Gate>
      ) : null}
    </div>
  );
}
```

---

## 8. Build and Deploy

### 8.1 Community Build (no enterprise package)

Nothing changes. `npm install` from the repo root installs only the declared dependencies. The dynamic `import('@atlasmind/enterprise')` fails silently, and the noop plugin takes over.

```bash
# Standard community build
npm install
npm run build
docker compose -f docker/docker-compose.yml up -d
```

### 8.2 Enterprise Build

#### Step 1: Configure GitHub Packages Access

Add to the project-level `.npmrc` (or instruct enterprise customers to):

```ini
# .npmrc (not committed to the open repo)
@atlasmind:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

#### Step 2: Install Enterprise Package

```bash
npm install @atlasmind/enterprise@^1.0.0
```

This installs the package into `node_modules/@atlasmind/enterprise`. Because it is NOT in `package.json`, `npm ci` on the open repo alone will not install it. Enterprise customers either:

1. Add it to their own fork's `package.json`, OR
2. Use a post-install script or Docker build step that installs it separately.

#### Step 3: Set License Key

```bash
# In .env or Docker environment
ATLASMIND_LICENSE_KEY=ATM-enterprise-50-20271231.MEUCIQDp7a...
```

### 8.3 Docker Build Variants

#### Community Dockerfile (unchanged)

The existing `backend/Dockerfile` works as-is. No enterprise package present.

#### Enterprise Dockerfile (overlay)

Enterprise customers use a thin Dockerfile that extends the base:

```dockerfile
# docker/Dockerfile.enterprise
# Builds on the standard backend image with enterprise package added

FROM dhi.io/node:24-alpine3.23-dev AS enterprise-deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY packages/contracts/package.json ./packages/contracts/
COPY .npmrc.enterprise ./.npmrc

# Install all deps including enterprise
ARG GITHUB_TOKEN
RUN --mount=type=cache,target=/root/.npm \
    GITHUB_TOKEN=${GITHUB_TOKEN} npm ci -w backend -w @atlasmind/contracts && \
    npm install @atlasmind/enterprise@^1.0.0

# Continue with standard build...
```

Alternatively, use a `docker-compose.enterprise.yml` overlay:

```yaml
# docker/docker-compose.enterprise.yml
# Use with: docker compose -f docker-compose.yml -f docker-compose.enterprise.yml up
services:
  backend:
    build:
      context: ..
      dockerfile: docker/Dockerfile.enterprise
      args:
        GITHUB_TOKEN: ${GITHUB_TOKEN}
    environment:
      ATLASMIND_LICENSE_KEY: ${ATLASMIND_LICENSE_KEY}
```

### 8.4 GitHub Packages Publishing (CI in private repo)

```yaml
# .github/workflows/publish.yml (in atlasmind-enterprise repo)
name: Publish to GitHub Packages
on:
  push:
    tags: ['v*']

permissions:
  packages: write
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://npm.pkg.github.com
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 9. Migration Plan

### 9.1 Overview: From PR #549 to Two-Repo System

This is a 6-phase migration executed over approximately 1-2 sprints.

### Phase 1: Close/Rework PR #549 (Day 1)

**Goal**: Remove enterprise code from the open repo branch, extract the useful patterns.

1. **Do NOT merge PR #549** as-is. The enterprise code belongs in the private repo.
2. Create a new branch `feature/enterprise-plugin-loader` from `dev`.
3. From PR #549, extract and keep ONLY:
   - The type definitions (`LicenseInfo`, `LicenseTier`, feature constants)
   - The general pattern of how OIDC routes were gated
4. Discard from PR #549:
   - `backend/src/enterprise/license-service.ts` (HMAC logic -- replaced by Ed25519 in private repo)
   - `backend/src/enterprise/license-middleware.ts` (replaced by plugin pattern)
   - `frontend/src/features/admin/LicenseStatusCard.tsx` (moves to private repo)
   - `frontend/src/shared/hooks/use-license-status.ts` (replaced by EnterpriseContext)
5. Close PR #549 with a comment explaining the architectural pivot.
6. If PR #553 has no enterprise dependencies beyond types, it can likely proceed independently after minor adjustments.

### Phase 2: Add Plugin Loader to Open Repo (Day 1-2)

**Goal**: The open repo has a clean extension point for enterprise features.

1. Create `backend/src/core/enterprise/` directory with:
   - `types.ts` -- EnterprisePlugin interface, LicenseInfo, feature constants
   - `loader.ts` -- Dynamic import loader with caching
   - `noop.ts` -- Community-mode stub
2. Create `frontend/src/shared/enterprise/` directory with:
   - `types.ts` -- EnterpriseUI interface, LicenseInfo
   - `loader.ts` -- Dynamic import loader
   - `context.tsx` -- EnterpriseContext provider
3. Add `packages/contracts/src/schemas/enterprise.ts` with shared Zod schemas for the license API response.
4. Modify `backend/src/app.ts`:
   - Add enterprise loader bootstrap
   - Make OIDC route registration conditional on `isFeatureEnabled('oidc_sso')`
   - Add fallback `GET /api/admin/license` endpoint (returns community status)
5. Modify `frontend/src/App.tsx`:
   - Wrap app in `EnterpriseProvider`
   - Make OIDC settings route conditional on `hasFeature('oidc_sso')`
6. Augment Fastify types to include `license` and `enterprise` decorators.
7. Write tests:
   - Loader returns noop when package not installed
   - OIDC routes not registered in community mode
   - License endpoint returns community status without enterprise package
   - Frontend context provides `isEnterprise: false` without package

**PR**: `feature/enterprise-plugin-loader` -> `dev`

### Phase 3: Create Private Repository (Day 2-3)

**Goal**: `atlasmind-enterprise` repo exists with license system and enterprise plugin.

1. Create `atlasmind-enterprise` GitHub repository (private).
2. Initialize npm package with `@atlasmind/enterprise` name.
3. Implement:
   - `scripts/generate-keypair.ts` -- Ed25519 key generation
   - `scripts/create-license.ts` -- License creation CLI
   - `src/license/verify.ts` -- Ed25519 verification
   - `src/license/constants.ts` -- Feature-to-tier mapping
   - `src/index.ts` -- EnterprisePlugin implementation
   - `src/middleware/license-gate.ts` -- Fastify preHandler
   - `src/routes/license-routes.ts` -- License status endpoint
4. Generate the Ed25519 key pair. Store private key securely. Embed public key.
5. Write comprehensive tests:
   - Valid license parsing and verification
   - Expired license detection
   - Invalid signature rejection
   - Tampered payload rejection
   - Feature-to-tier mapping
6. Publish `@atlasmind/enterprise@1.0.0-alpha.1` to GitHub Packages.

### Phase 4: Enterprise Frontend Components (Day 3-4)

**Goal**: Enterprise UI components in the private repo.

1. Add frontend components to `atlasmind-enterprise`:
   - `src/frontend/LicenseStatusCard.tsx`
   - `src/frontend/EnterpriseBanner.tsx`
   - `src/frontend/EnterpriseGate.tsx`
   - `src/frontend/index.ts` (exports EnterpriseUI implementation)
2. Configure the build to produce both backend and frontend bundles.
3. Publish `@atlasmind/enterprise@1.0.0-alpha.2`.

### Phase 5: Integration Testing (Day 4-5)

**Goal**: Both repos work together correctly.

1. In a test environment, install `@atlasmind/enterprise` alongside the open repo.
2. Verify:
   - Community mode: OIDC routes absent, license endpoint returns community
   - Enterprise mode (valid key): OIDC routes present, license endpoint returns enterprise info
   - Enterprise mode (expired key): OIDC routes absent, license endpoint reports expired
   - Enterprise mode (no key): OIDC routes absent, license endpoint returns community
   - Frontend: OIDC settings page visible only with valid enterprise license
   - Frontend: LicenseStatusCard renders correctly
3. Docker build: verify community and enterprise Dockerfile variants both work.
4. Run full test suite of the open repo (should pass with and without enterprise package).

### Phase 6: Cleanup and Release (Day 5-6)

1. Publish `@atlasmind/enterprise@1.0.0` (stable).
2. Update open repo documentation:
   - Add ADR-012 (or next number) documenting the enterprise separation decision
   - Update CLAUDE.md with enterprise-related env vars
   - Update `.env.example` with `ATLASMIND_LICENSE_KEY`
   - Update `docker-compose.yml` with enterprise env var passthrough
3. Close PR #549 with reference to the new architecture.
4. Update PR #553 if it has any enterprise dependencies.
5. Create a customer-facing doc explaining enterprise setup.

### 9.2 What Happens to PR #549 and #553

| PR | Action | Reason |
|----|--------|--------|
| #549 | **Close without merging.** | HMAC-based license system is replaced by Ed25519. Enterprise code must not be in the open repo. Type definitions and patterns are extracted into the plugin loader. |
| #553 | **Review for enterprise dependencies.** | If it only uses `LicenseInfo` types, adapt to import from `core/enterprise/types.ts` instead. If it depends on HMAC middleware, extract that dependency. |

---

## 10. Security Considerations

### 10.1 Key Management

| Key | Location | Protection |
|-----|----------|-----------|
| Ed25519 **private key** | Developer machine only. NEVER in git, Docker images, npm packages, or CI artifacts. | File permissions (600). Consider hardware security module (HSM) for production key signing. |
| Ed25519 **public key** | Embedded in `@atlasmind/enterprise` npm package as base64 constant. | Not secret. Changing it requires a new package version. |
| License key (signed string) | `ATLASMIND_LICENSE_KEY` env var in the deployed environment. | Same protection as other secrets (JWT_SECRET, etc.). Not in source control. |

### 10.2 Preventing Bypass

**Threat**: Someone removes the enterprise check and uses OIDC without a license.

**Mitigations**:
- The OIDC routes are not registered without the enterprise plugin confirming the feature is enabled. There is no code path that accidentally registers them.
- The check is in `app.ts` (the application bootstrap), not in middleware. You cannot bypass it by manipulating request headers.
- Someone who forks the open repo can always remove the check. This is acceptable for an open-core model. The license system prevents unauthorized use of the *packaged product*, not of the *source code* (which is open anyway).

**Threat**: Someone forges a license key.

**Mitigations**:
- Ed25519 signatures are unforgeable without the private key (128-bit security level).
- The public key is embedded in compiled code, not loaded from environment/config.
- No HMAC shared secrets to leak (unlike PR #549's approach).

**Threat**: Someone extracts the enterprise npm package and redistributes it.

**Mitigations**:
- GitHub Packages access requires authentication.
- The package is scoped to the organization.
- License key still required even if the package is obtained.
- BUSL-1.1 license provides legal protection.

### 10.3 Package Integrity

- GitHub Packages provides provenance attestation.
- The enterprise package is built in CI from a tagged commit, ensuring reproducibility.
- npm `integrity` field in `package-lock.json` provides tamper detection.

### 10.4 Constant-Time Comparison

The Ed25519 `verify()` in Node.js `crypto` module is already constant-time at the native level. No additional timing-safe comparison is needed (unlike HMAC where `timingSafeEqual` was necessary in PR #549).

### 10.5 Defense in Depth

Even if the license check were somehow bypassed:
- OIDC still requires a working IdP, client credentials, and correct configuration.
- Admin endpoints require admin role authentication.
- Database-level RBAC still applies.
- The license is a commercial gate, not a security gate.

---

## 11. Testing Strategy

### 11.1 Open Repo Tests (always pass without enterprise package)

```typescript
// backend/src/core/enterprise/loader.test.ts
describe('Enterprise Loader', () => {
  it('returns noop plugin when enterprise package is not installed', async () => {
    const plugin = await loadEnterprisePlugin();
    expect(plugin.version).toBe('community');
    expect(plugin.validateLicense('anything')).toBeNull();
    expect(plugin.isFeatureEnabled('oidc_sso', null)).toBe(false);
  });
});

// backend/src/app.test.ts (or routes/foundation/oidc.test.ts)
describe('OIDC route registration', () => {
  it('does not register OIDC routes in community mode', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/config' });
    expect(res.statusCode).toBe(404);
  });
});

// backend/src/routes/foundation/admin.test.ts
describe('GET /api/admin/license', () => {
  it('returns community edition without enterprise package', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/license',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.json()).toEqual({
      edition: 'community',
      tier: 'community',
      features: [],
    });
  });
});
```

### 11.2 Enterprise Repo Tests

```typescript
// src/license/verify.test.ts
describe('License Verification', () => {
  it('verifies a valid license key', () => {
    const license = verifyLicenseKey(VALID_TEST_KEY);
    expect(license).not.toBeNull();
    expect(license!.tier).toBe('enterprise');
    expect(license!.isValid).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const tampered = VALID_TEST_KEY.replace('enterprise', 'community');
    expect(verifyLicenseKey(tampered)).toBeNull();
  });

  it('rejects an expired license', () => {
    const license = verifyLicenseKey(EXPIRED_TEST_KEY);
    expect(license).not.toBeNull();
    expect(license!.isValid).toBe(false);
  });

  it('rejects a key with invalid signature', () => {
    const badSig = VALID_TEST_KEY.slice(0, -10) + 'AAAAAAAAAA';
    expect(verifyLicenseKey(badSig)).toBeNull();
  });

  it('rejects null, undefined, and empty string', () => {
    expect(verifyLicenseKey(undefined)).toBeNull();
    expect(verifyLicenseKey('')).toBeNull();
  });
});
```

### 11.3 Integration Tests (CI in enterprise repo)

The enterprise repo's CI installs both the open repo and the enterprise package, then runs integration tests:

```yaml
# In enterprise repo CI
- name: Integration test
  run: |
    git clone https://github.com/yourorg/atlasmind.git /tmp/atlasmind
    cd /tmp/atlasmind
    npm install
    npm install /path/to/enterprise/dist  # Install local build
    ATLASMIND_LICENSE_KEY=${{ secrets.TEST_LICENSE_KEY }} npm test
```

---

## 12. Enterprise Feature Roadmap

Implementation roadmap for enterprise features. Derived from the [Open-Core Business Model](../../Documentation-Research/AtlasMind/Open-Core%20Business%20Model.md) research document (2026-03-21).

### Phase 0: Infrastructure (Pre-launch)

| Feature | Flag | Pillar | Notes |
|---|---|---|---|
| Plugin loader + noop stub | — | Infra | Open repo extension points |
| Ed25519 license system | — | Infra | Key generation, verification, CLI |
| License status API + frontend | — | Infra | Admin panel card |
| Confluence space limit (5) in community | `unlimited_spaces` | Scale | Natural upgrade path |

### Phase 1: Launch Gate (Immediate — before first enterprise customer)

| Feature | Flag | Pillar | Notes |
|---|---|---|---|
| OIDC/SAML SSO | `oidc_sso` | Identity | Already implemented, needs gating only |
| OIDC group mappings | `oidc_group_mappings` | Identity | Already implemented |
| Basic audit log export | `audit_log_export` | Compliance | Audit events already collected; export is the gate |
| RAG permission enforcement | `rag_permission_enforcement` | AI Governance | AI respects per-user space permissions. Highest-value differentiator |
| Seat enforcement | `seat_enforcement` | Scale | Cap active users per license |

### Phase 2: Short-term (First 6 months)

| Feature | Flag | Pillar | Notes |
|---|---|---|---|
| LLM audit trail | `llm_audit_trail` | AI Governance | Log who queried AI, context retrieved, output generated |
| SCIM provisioning | `scim_provisioning` | Identity | Auto user create/deactivate from IdP |
| Organizational LLM policy | `org_llm_policy` | AI Governance | Admin locks LLM provider, blocks personal API keys |
| Advanced analytics dashboards | `advanced_analytics` | Analytics | Team/dept knowledge health, content gaps |
| AI usage analytics | `ai_usage_analytics` | Analytics | Which AI features used, by whom, quality |
| Data retention policies | `data_retention_policies` | Compliance | Auto-purge content older than N days |
| Advanced RBAC | `advanced_rbac` | Identity | Custom roles beyond Admin/Editor/Viewer |

### Phase 3: Medium-term (6-18 months)

| Feature | Flag | Pillar | Notes |
|---|---|---|---|
| AI output review workflow | `ai_output_review` | AI Governance | Human-in-the-loop before AI content published to Confluence |
| PII detection in AI output | `pii_detection` | AI Governance | Flag sensitive personal info before publication |
| Compliance report generator | `compliance_reports` | Compliance | User access reports, content modification reports (SOC2, ISO 27001) |
| Version snapshot archival | `version_snapshot_archival` | Compliance | Tamper-evident storage |
| ABAC permissions | `abac_permissions` | Identity | Fine-grained attribute-based space permissions |
| IP allowlisting | `ip_allowlisting` | Identity | Restrict instance access by IP range |
| AD/LDAP group sync | `ldap_group_sync` | Identity | Map AD/LDAP groups to AtlasMind roles |
| Slack/Teams deep integration | `slack_teams_deep` | Integrations | Deep links, content previews, interactive notifications |
| Webhook push | `webhook_push` | Integrations | Push events to external systems |
| Multi-instance management | `multi_instance` | Scale | Single pane of glass for multiple AtlasMind instances |
| Bulk user operations | `bulk_user_operations` | Scale | CSV import/export, batch role changes |
| Batch page operations | `batch_page_operations` | Scale | Bulk tag, archive, permission changes |

### Architectural Notes

**Features that require code in the enterprise package** (not just a boolean gate):
- `rag_permission_enforcement` — Hooks into embedding queries to filter by user's space ACL
- `llm_audit_trail` — Hooks into LLM service layer to log queries/responses
- `org_llm_policy` — Hooks into LLM provider selection to enforce admin policy
- `ai_output_review` — Adds a review queue workflow before Confluence push-back
- `pii_detection` — Runs a classification pass on AI output before display
- `scim_provisioning` — New SCIM 2.0 API endpoints in the enterprise package

**Features that are pure gates** (route registration or UI conditional):
- `oidc_sso`, `oidc_group_mappings` — Conditional route registration
- `audit_log_export` — Conditional export endpoint
- `advanced_rbac`, `abac_permissions` — Conditional RBAC admin routes
- `unlimited_spaces` — Limit check in sync service
- `seat_enforcement` — Limit check in user registration

---

## 13. ADR: Enterprise Separation

### ADR-013: Enterprise Feature Separation

#### Context

AtlasMind needs to offer enterprise features (OIDC/SSO, advanced RBAC, audit log export) under a paid license while keeping the core product open-source. PR #549 implemented enterprise gating as in-repo code with HMAC license validation. This has several issues:

1. Enterprise logic pollutes the open-source codebase.
2. HMAC requires a shared secret, which means the signing key must be kept secret but also present in the deployed application.
3. No clean separation between open-source and commercial code for licensing purposes.

#### Options

| Option | Pros | Cons |
|--------|------|------|
| **A: In-repo enterprise folder** (PR #549 approach) | Simple, single repo | Enterprise code visible in open repo, HMAC shared secret issues |
| **B: Git submodule** | Code isolation | Complex workflow, submodule pain, still visible in repo structure |
| **C: Separate npm package via GitHub Packages** | True isolation, clean boundary, standard npm workflow | Two repos to maintain, need plugin loader |
| **D: Feature flags only (no code separation)** | Simplest | No code protection, no commercial licensing boundary |

#### Decision: Option C - Separate npm package

Use a private GitHub repository that publishes `@atlasmind/enterprise` to GitHub Packages. The open repo uses optional dynamic `import()` with a plugin loader pattern.

#### Rationale

- **True isolation**: Enterprise code is never in the open-source repository.
- **Ed25519 asymmetric signing**: Private key stays with the issuer, public key ships in the package. No shared secrets.
- **Standard npm workflow**: `npm install @atlasmind/enterprise` -- familiar to developers.
- **Clean legal boundary**: Open repo under one license, enterprise package under BUSL-1.1.
- **Zero degradation**: Community edition has no awareness of enterprise features. No 403s, no "upgrade" nags, no dead code.

#### Consequences

- Requires maintaining two repositories.
- Enterprise package version must track the open repo version.
- Breaking changes to the plugin interface require coordinated releases.
- Docker builds for enterprise customers need an additional npm install step.

---

## Appendix A: File Change Summary

### Files ADDED to Open Repo

| File | Purpose |
|------|---------|
| `backend/src/core/enterprise/types.ts` | EnterprisePlugin interface, LicenseInfo, feature constants |
| `backend/src/core/enterprise/loader.ts` | Dynamic import loader with caching |
| `backend/src/core/enterprise/noop.ts` | Community-mode noop stub |
| `backend/src/core/enterprise/loader.test.ts` | Tests for the loader |
| `frontend/src/shared/enterprise/types.ts` | EnterpriseUI interface |
| `frontend/src/shared/enterprise/loader.ts` | Frontend dynamic import loader |
| `frontend/src/shared/enterprise/context.tsx` | EnterpriseContext provider + hook |
| `packages/contracts/src/schemas/enterprise.ts` | Shared Zod schemas for license API |

### Files MODIFIED in Open Repo

| File | Change |
|------|--------|
| `backend/src/app.ts` | Add enterprise loader bootstrap, conditional OIDC registration |
| `backend/src/routes/foundation/admin.ts` | Add fallback `GET /api/admin/license` endpoint |
| `frontend/src/App.tsx` | Wrap in EnterpriseProvider, conditional OIDC route |
| `docker/docker-compose.yml` | Add `ATLASMIND_LICENSE_KEY` env var passthrough |
| `.env.example` | Add `ATLASMIND_LICENSE_KEY` documentation |
| `CLAUDE.md` | Document enterprise env var |
| `docs/ARCHITECTURE-DECISIONS.md` | Add ADR-012 |

### Files NOT Changed

| File | Reason |
|------|--------|
| `backend/src/routes/foundation/oidc.ts` | OIDC code stays as-is. Gating is at registration level, not inside routes. |
| `backend/src/core/services/oidc-service.ts` | No changes needed. |
| `frontend/src/features/admin/OidcSettingsPage.tsx` | No changes needed. Page is simply not routed to in community mode. |
| `backend/package.json` | Enterprise package is NOT a dependency. |

### New Repository Files (atlasmind-enterprise)

| File | Purpose |
|------|---------|
| `src/index.ts` | EnterprisePlugin implementation |
| `src/license/verify.ts` | Ed25519 license verification |
| `src/license/types.ts` | License types (re-exports from contracts) |
| `src/license/constants.ts` | Feature-to-tier mapping |
| `src/license/keys/public.ts` | Embedded Ed25519 public key |
| `src/middleware/license-gate.ts` | Fastify preHandler for route-level gating |
| `src/routes/license-routes.ts` | GET /api/admin/license with full info |
| `src/frontend/index.ts` | EnterpriseUI implementation |
| `src/frontend/LicenseStatusCard.tsx` | License status admin card |
| `src/frontend/EnterpriseBanner.tsx` | "Enterprise required" banner |
| `src/frontend/EnterpriseGate.tsx` | Conditional rendering gate |
| `scripts/generate-keypair.ts` | Ed25519 key pair generation |
| `scripts/create-license.ts` | License creation CLI |
| `scripts/verify-license.ts` | License verification CLI (testing) |
| `.github/workflows/publish.yml` | CI: build, test, publish to GitHub Packages |

---

## Appendix B: Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATLASMIND_LICENSE_KEY` | No | (none) | Enterprise license key. Format: `ATM-{tier}-{seats}-{expiry}.{signature}`. Omit for community edition. |
| `GITHUB_TOKEN` | For enterprise Docker build | (none) | GitHub PAT with `read:packages` scope for installing `@atlasmind/enterprise`. |

---

## Appendix C: Decision Log

| Decision | Rationale |
|----------|-----------|
| OIDC code stays in open repo | Too deeply integrated to extract cleanly. Gate at route registration level instead. |
| Ed25519 over HMAC | Asymmetric: private key never deployed. No shared secret risk. |
| Dynamic import over dependency | Open repo `package.json` has no enterprise references. Truly optional. |
| Plugin loader over Fastify plugin | More explicit control over initialization order. Enterprise routes need license info during registration. |
| Conditional registration over middleware | Routes don't exist in community mode (cleaner than 403 on every request). |
| Public key embedded in code, not env var | Prevents accidental replacement. Changing the public key requires a new package version (intentional friction). |
| noop plugin over null checks | Every call site gets a valid object. No `if (enterprise)` scattered through the codebase. |
