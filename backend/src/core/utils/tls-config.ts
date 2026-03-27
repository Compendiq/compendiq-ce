import { readFileSync, existsSync } from 'fs';
import { Agent, Dispatcher, interceptors } from 'undici';
import { logger } from './logger.js';

/**
 * Load custom CA certificates for undici (which doesn't respect NODE_EXTRA_CA_CERTS).
 * Checks NODE_EXTRA_CA_CERTS first, then common system CA bundle paths as fallback.
 */
function loadCaBundle(): string | undefined {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;

  // Try explicit path from env var first
  if (caPath) {
    try {
      const contents = readFileSync(caPath, 'utf-8');
      if (contents.includes('-----BEGIN CERTIFICATE-----')) {
        logger.info({ caPath, size: contents.length }, 'Loaded custom CA bundle from NODE_EXTRA_CA_CERTS');
        return contents;
      }
      logger.warn({ caPath }, 'CA bundle file exists but contains no PEM certificates');
    } catch (err) {
      logger.warn({ caPath, err }, 'Could not read CA bundle from NODE_EXTRA_CA_CERTS');
    }
  }

  // Fallback: try common system CA bundle paths
  const fallbackPaths = [
    '/etc/ssl/certs/ca-certificates.crt',      // Debian/Ubuntu/Alpine
    '/etc/pki/tls/certs/ca-bundle.crt',         // RHEL/CentOS
    '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL/CentOS (extracted)
  ];

  for (const path of fallbackPaths) {
    if (path === caPath) continue; // Already tried
    if (!existsSync(path)) continue;
    try {
      const contents = readFileSync(path, 'utf-8');
      if (contents.includes('-----BEGIN CERTIFICATE-----')) {
        logger.info({ caPath: path, size: contents.length }, 'Loaded CA bundle from system path');
        return contents;
      }
    } catch {
      // Try next path
    }
  }

  if (!caPath) {
    logger.info('No NODE_EXTRA_CA_CERTS set and no system CA bundle found — using Node.js defaults');
  }
  return undefined;
}

const caBundleContents = loadCaBundle();
const verifySsl = process.env.CONFLUENCE_VERIFY_SSL !== 'false';

if (!verifySsl) {
  logger.warn('CONFLUENCE_VERIFY_SSL=false — TLS certificate verification is disabled for Confluence connections');
}

/**
 * Build TLS connect options for undici.
 * Respects CONFLUENCE_VERIFY_SSL and NODE_EXTRA_CA_CERTS env vars.
 */
export function buildConnectOptions(): Record<string, unknown> | undefined {
  if (!verifySsl) {
    return { rejectUnauthorized: false };
  }
  if (caBundleContents) {
    return { ca: caBundleContents };
  }
  return undefined;
}

/**
 * Pre-configured undici Agent with TLS + redirect options for Confluence connections.
 * In undici v7, TLS connect options must be set at Agent construction time —
 * they are ignored when passed per-request to request().
 * maxRedirections was also removed from per-request options in undici v7;
 * redirect support is now provided via the redirect interceptor.
 */
const connectOpts = buildConnectOptions();
const redirectInterceptor = interceptors.redirect({ maxRedirections: 10 });

export const confluenceDispatcher: Dispatcher = connectOpts
  ? new Agent({ connect: connectOpts }).compose(redirectInterceptor)
  : new Agent().compose(redirectInterceptor);

if (connectOpts) {
  logger.info(
    { verifySsl, hasCustomCa: !!caBundleContents },
    'Created undici Agent with custom TLS configuration for Confluence',
  );
}

/**
 * Create a dispatcher that respects NODE_EXTRA_CA_CERTS but always verifies TLS.
 * For non-Confluence external services (OIDC IdPs, etc.) that may use internal CAs.
 */
export function createTlsDispatcher(): Dispatcher {
  const connectOpts = caBundleContents ? { ca: caBundleContents } : undefined;
  return connectOpts
    ? new Agent({ connect: connectOpts }).compose(redirectInterceptor)
    : new Agent().compose(redirectInterceptor);
}

/**
 * Whether SSL verification is enabled for Confluence connections.
 */
export function isVerifySslEnabled(): boolean {
  return verifySsl;
}
