/**
 * Type stub for the @compendiq/enterprise package.
 *
 * This package is optional — it is only installed in the Enterprise Edition.
 * This declaration allows TypeScript to compile the dynamic import() call
 * in loader.ts without errors when the package is not present.
 *
 * When the package IS installed, its own type declarations take precedence.
 */
declare module '@compendiq/enterprise' {
  import type { EnterprisePlugin } from '../enterprise/types.js';

  const validateLicense: EnterprisePlugin['validateLicense'];
  const isFeatureEnabled: EnterprisePlugin['isFeatureEnabled'];
  const requireFeature: EnterprisePlugin['requireFeature'];
  const registerRoutes: EnterprisePlugin['registerRoutes'];
  const version: string;

  export { validateLicense, isFeatureEnabled, requireFeature, registerRoutes, version };
}
