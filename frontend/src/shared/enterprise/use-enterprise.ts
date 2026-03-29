import { useContext } from 'react';
import type { EnterpriseContextValue } from './types';
import { EnterpriseContext } from './enterprise-context';

/**
 * Hook to access enterprise context values.
 *
 * In community mode:
 * - ui = null
 * - license = null
 * - isEnterprise = false
 * - hasFeature() always returns false
 * - isLoading = false (after initial load)
 */
export function useEnterprise(): EnterpriseContextValue {
  return useContext(EnterpriseContext);
}
