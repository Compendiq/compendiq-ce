import { createContext } from 'react';
import type { EnterpriseContextValue } from './types';

/**
 * React context for enterprise state.
 *
 * Default values represent community mode: no enterprise UI,
 * no license, all features disabled.
 */
export const EnterpriseContext = createContext<EnterpriseContextValue>({
  ui: null,
  license: null,
  isEnterprise: false,
  hasFeature: () => false,
  isLoading: true,
});
