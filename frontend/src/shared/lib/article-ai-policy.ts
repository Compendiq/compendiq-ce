import type { AiPolicy, ProviderLocality, AiPolicyBlockReason } from '@compendiq/contracts';

/**
 * Client-side helpers for article AI policy (SPEC-UI-001). These never claim
 * protection: the server is the enforcement point and the UI only reflects
 * what the server said, refusing locally where a request would be refused.
 */

/** Issue wording: a category, never a connection state or a trust seal. */
export const AI_POLICY_CHIP_LABEL: Record<AiPolicy, string> = {
  all: 'All AI allowed',
  local_only: 'Local AI only',
  none: 'No AI allowed',
};

/** Concise Details explanation beside each policy. */
export const AI_POLICY_EXPLANATION: Record<AiPolicy, string> = {
  all: 'Any configured provider may process this article, subject to existing permissions and provider policy.',
  local_only: 'Only a provider an administrator declared local, or the supported local browser inference path, may process this article.',
  none: 'No embedding, vision analysis, summary, quality analysis, auto-tagging, rewrite, completion or AI prompt context is derived from this article.',
};

/** Neutral locality wording; never "verified" or "secure". */
export const LOCALITY_CHIP_LABEL: Record<ProviderLocality, string> = {
  local: 'Declared local',
  external: 'External',
};

/** Help copy mandated by the issue for the provider editor's locality control. */
export const LOCALITY_HELP_TEXT =
  'Local is an administrator declaration about this endpoint and any upstream forwarding; '
  + 'Compendiq does not independently verify residency. '
  + 'Declaring a provider Local authorizes it to process articles whose policy is Local AI only.';

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

/**
 * The `no_ai` confirmation names the actual atomic effect and its limits. It
 * promises neither global erasure nor instant cancellation of in-flight work.
 */
export const NO_AI_CONFIRMATION = {
  title: 'Set this article to No AI allowed?',
  removes: [
    'generated vectors (live and shadow embeddings)',
    'stored image analyses',
    'generated summaries',
    'quality analysis results',
  ],
  remains: [
    'authored content and titles',
    'original attachments',
    'version history',
    'ordinary keyword search',
  ],
  limits: [
    'Historical conversations are not erased; they may no longer be replayable as AI context.',
    'Work already admitted or sent to a provider cannot be recalled.',
    'New AI work is refused from the moment the change is committed; nothing is promised about requests already in flight.',
  ],
  confirmLabel: 'Set No AI allowed',
} as const;

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

/**
 * No optimistic update: `saved` changes only when the server confirms. A 409
 * keeps the draft; a reload (the refresh/review the conflict offers) adopts
 * the server's committed policy and revision, keeps the draft for review, and
 * clears the stale-revision conflict because the revision is now current.
 */
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
      return { ...state, saved: event.policy, revision: event.revision, conflict: false, pending: false };
  }
}

/** Editor AI paths: mouse, keyboard and programmatic share one gate. */
export type EditorAiTrigger = 'mouse' | 'keyboard' | 'programmatic';
export function isEditorAiAllowed(policy: AiPolicy | undefined, trigger: EditorAiTrigger): boolean {
  // Every trigger is gated identically; unknown policy fails closed.
  void trigger;
  return policy === 'all' || policy === 'local_only';
}

/** Accessible reason for an unavailable editor action; prose, never a tooltip alone. */
export function editorAiUnavailableReason(policy: AiPolicy | undefined): string | null {
  if (policy === 'none') return 'Unavailable: this article\u2019s AI policy is No AI allowed.';
  if (policy === undefined) return 'Unavailable: this article\u2019s AI policy could not be read.';
  return null;
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

/**
 * History refusal keeps the draft and offers a fresh conversation. A
 * transient policy read failure offers retry instead, without reclassifying
 * the history as safe. Neither outcome sent anything.
 */
export interface ChatSendOutcome {
  draft: string;
  offerNewChat: boolean;
  offerRetry: boolean;
  message: string | null;
}
export function handleChatRefusal(draft: string, errorCode: string | undefined): ChatSendOutcome {
  if (errorCode === 'ai_history_not_replayable') {
    return {
      draft,
      offerNewChat: true,
      offerRetry: false,
      message: 'Nothing was sent. This conversation\u2019s history cannot be sent under the current article AI policy. '
        + 'Your draft is kept; start a new chat to continue without that history.',
    };
  }
  if (errorCode === 'ai_policy_unavailable') {
    return {
      draft,
      offerNewChat: false,
      offerRetry: true,
      message: 'Nothing was sent. The article AI policy could not be checked right now. Your draft is kept; try again.',
    };
  }
  return { draft, offerNewChat: false, offerRetry: false, message: null };
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
/**
 * What a provider save submits for locality: `local` only when Local was
 * explicitly chosen for exactly this endpoint in the current draft; anything
 * else — no choice, a choice for a previous endpoint — saves External.
 */
export function localityToSubmit(state: LocalityDeclaration, endpoint: string): ProviderLocality {
  return state.locality === 'local' && state.confirmedForEndpoint === endpoint ? 'local' : 'external';
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
  policy_none: 'Blocked by policy: this article is No AI allowed',
  provider_not_local: 'Blocked by policy: the assigned provider is not declared local',
  policy_changed: 'Blocked by policy: the article AI policy changed before this work was published',
};
