import { getEnterprisePlugin } from './loader.js';
import { logger } from '../utils/logger.js';

export type AiPolicyEvent =
  | { type: 'admitted'; pageId: number; usecase: string; providerId: string; configRevision: number; policy: string; policyRevision: number }
  | { type: 'blocked'; pageId: number; usecase: string; providerId: string | null; reason: 'policy_none' | 'provider_not_local' | 'policy_changed'; policy: string }
  | { type: 'policy_changed'; pageId: number; userId: string; from: string; to: string; revision: number };

/**
 * Inert event sink. CE does nothing with these beyond debug logging; an EE
 * plugin may observe them. A failing observer never affects the caller.
 */
export function emitAiPolicyEvent(event: AiPolicyEvent): void {
  try {
    getEnterprisePlugin().onAiPolicyEvent?.(event);
  } catch (err) {
    logger.warn({ err, type: event.type }, 'ai-policy event observer failed');
  }
}
