import type { AiPolicy, ProviderLocality, AiPolicyBlockReason } from '@compendiq/contracts';

/**
 * Client-side helpers for article AI policy (SPEC-UI-001). These never claim
 * protection: the server is the enforcement point and the UI only reflects
 * what the server said, refusing locally where a request would be refused.
 */

export const AI_POLICY_CHIP_LABEL: Record<AiPolicy, string> = {
  all: 'AI: all providers',
  local_only: 'AI: local providers only',
  none: 'AI: no processing',
};

/** Neutral locality wording; never "verified" or "secure". */
export const LOCALITY_CHIP_LABEL: Record<ProviderLocality, string> = {
  local: 'Declared local',
  external: 'External',
};

/** Library filter: the query param and cache key are the real API ones. */
export type AiPolicyFilter = AiPolicy | 'any';
export function pagesQueryKey(base: Record<string, unknown>, filter: AiPolicyFilter) {
  const params = filter === 'any' ? base : { ...base, aiPolicy: filter };
  return ['pages', params] as const;
}
export function pagesSearchParams(filter: AiPolicyFilter): Record<string, string> {
  return filter === 'any' ? {} : { aiPolicy: filter };
}

/** Selector is shown only when the server advertised the mutation capability. */
export function canShowPolicySelector(capabilities: readonly string[] | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes('page.ai_policy.update');
}

/** Moving to `none` needs explicit confirmation. */
export function requiresConfirmation(from: AiPolicy, to: AiPolicy): boolean {
  return to === 'none' && from !== 'none';
}

export interface SelectorState {
  saved: AiPolicy;
  draft: AiPolicy;
  revision: number;
  conflict: boolean;
  pending: boolean;
}

export type SelectorEvent =
  | { type: 'choose'; policy: AiPolicy }
  | { type: 'submit' }
  | { type: 'success'; policy: AiPolicy; revision: number }
  | { type: 'conflict' }
  | { type: 'error' }
  | { type: 'reload'; policy: AiPolicy; revision: number };

/** No optimistic update: `saved` changes only when the server confirms. A 409 keeps the draft. */
export function selectorReducer(state: SelectorState, event: SelectorEvent): SelectorState {
  switch (event.type) {
    case 'choose':
      return { ...state, draft: event.policy, conflict: false };
    case 'submit':
      return { ...state, pending: true };
    case 'success':
      return { saved: event.policy, draft: event.policy, revision: event.revision, conflict: false, pending: false };
    case 'conflict':
      return { ...state, conflict: true, pending: false };
    case 'error':
      return { ...state, pending: false };
    case 'reload':
      return { ...state, saved: event.policy, revision: event.revision, pending: false };
  }
}

/** Editor AI paths: mouse, keyboard and programmatic share one gate. */
export type EditorAiTrigger = 'mouse' | 'keyboard' | 'programmatic';
export function isEditorAiAllowed(policy: AiPolicy | undefined, trigger: EditorAiTrigger): boolean {
  // Every trigger is gated identically; unknown policy fails closed.
  void trigger;
  return policy === 'all' || policy === 'local_only';
}

/** Ghost text must be cleared when its policy/revision snapshot is invalidated. */
export interface GhostText { text: string; policy: AiPolicy; revision: number }
export function reconcileGhostText(
  ghost: GhostText | null,
  current: { policy: AiPolicy | undefined; revision: number },
): GhostText | null {
  if (!ghost) return null;
  if (!isEditorAiAllowed(current.policy, 'programmatic')) return null;
  if (ghost.policy !== current.policy || ghost.revision !== current.revision) return null;
  return ghost;
}

/** History refusal keeps the draft and offers a fresh conversation. */
export interface ChatSendOutcome { draft: string; offerNewChat: boolean; message: string | null }
export function handleChatRefusal(draft: string, errorCode: string | undefined): ChatSendOutcome {
  if (errorCode === 'ai_history_not_replayable') {
    return {
      draft,
      offerNewChat: true,
      message: 'This conversation includes content that can no longer be sent under the current article AI policy. Start a new chat to continue.',
    };
  }
  if (errorCode === 'ai_policy_unavailable') {
    return { draft, offerNewChat: false, message: 'Article AI policy could not be checked. Try again later.' };
  }
  return { draft, offerNewChat: false, message: null };
}

/** Provider locality declaration: never auto-selected; endpoint change resets it. */
export interface LocalityDeclaration {
  locality: ProviderLocality | null;
  confirmedForEndpoint: string | null;
}
export function initialLocalityDeclaration(): LocalityDeclaration {
  return { locality: null, confirmedForEndpoint: null };
}
export function declareLocality(state: LocalityDeclaration, locality: ProviderLocality, endpoint: string): LocalityDeclaration {
  return { ...state, locality, confirmedForEndpoint: endpoint };
}
export function needsLocalityConfirmation(state: LocalityDeclaration, endpoint: string): boolean {
  return state.locality === null || state.confirmedForEndpoint !== endpoint;
}
export function onEndpointChange(state: LocalityDeclaration, endpoint: string): LocalityDeclaration {
  return state.confirmedForEndpoint === endpoint ? state : { locality: null, confirmedForEndpoint: null };
}

/** Worker statuses (SPEC-WORK-001). Policy states are neither success nor failure. */
export type WorkerStatusTone = 'success' | 'failure' | 'policy' | 'recovering' | 'neutral';
export function workerStatusTone(status: string): WorkerStatusTone {
  switch (status) {
    case 'completed': case 'succeeded': case 'success': return 'success';
    case 'failed': case 'error': return 'failure';
    case 'policy_blocked': return 'policy';
    case 'recovering': return 'recovering';
    default: return 'neutral';
  }
}
export const BLOCK_REASON_LABEL: Record<AiPolicyBlockReason, string> = {
  policy_none: 'Skipped: article AI policy is "no processing"',
  provider_not_local: 'Skipped: provider is not declared local',
  policy_changed: 'Skipped: article AI policy changed',
};
