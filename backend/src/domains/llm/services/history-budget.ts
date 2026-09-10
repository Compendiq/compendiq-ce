import type { ChatMessage } from './openai-compatible-client.js';
import { contentToText } from './prompts.js';
import { estimateTokens } from './llm-audit-hook.js';

/**
 * Token budget for replaying STORED turns into the model (#1361, decision 10).
 * A plain constant, not an env var: ~4 chars/token is a rough estimator, and
 * 4,000 is conservative for 8k-context local models sitting beside retrieved
 * context. A follow-up may derive it from the provider's window.
 */
export const HISTORY_REPLAY_TOKEN_BUDGET = 4_000;

/** A stored turn as read back from `llm_conversations.messages`. */
export type ReplayableMessage = ChatMessage & { refused?: boolean; sources?: unknown };

export interface ReplaySelection {
  /** Oldest → newest, `{ role, content }` only — the shape the provider wire takes. */
  replay: ChatMessage[];
  /** True when at least one EXCHANGE was left out for budget. Refused turns and
   *  orphan questions are never replay material and do not count. */
  truncated: boolean;
}

const strip = ({ role, content }: ChatMessage): ChatMessage => ({ role, content });

/**
 * Select the newest whole exchanges that fit the budget.
 *
 * Pairing is by ROLE, not by index stride: an assistant turn and the user turn
 * immediately before it are one exchange. A user turn with no assistant after
 * it — exactly what a refused exchange leaves behind once the refused
 * assistant half is filtered — is dropped unconditionally and never counted
 * (some providers reject consecutive same-role messages, and the honest-refusal
 * gate's history exemption never counted it either). Walk newest → oldest,
 * stop before the exchange that would exceed the budget, restore order.
 */
export function selectReplayableHistory(
  history: ReplayableMessage[],
  budget: number = HISTORY_REPLAY_TOKEN_BUDGET,
): ReplaySelection {
  const live = history.filter((m) => !m.refused);

  const exchangesNewestFirst: ChatMessage[][] = [];
  let i = live.length - 1;
  while (i >= 0) {
    const m = live[i]!;
    if (m.role === 'assistant') {
      const prev = live[i - 1];
      if (prev && prev.role === 'user') {
        exchangesNewestFirst.push([strip(prev), strip(m)]);
        i -= 2;
      } else {
        exchangesNewestFirst.push([strip(m)]);
        i -= 1;
      }
    } else {
      i -= 1; // orphan user/system turn: dropped, not counted
    }
  }

  const kept: ChatMessage[][] = [];
  let used = 0;
  let truncated = false;
  for (const exchange of exchangesNewestFirst) {
    const cost = exchange.reduce((n, m) => n + estimateTokens(contentToText(m.content)), 0);
    if (used + cost > budget) {
      truncated = true;
      break;
    }
    used += cost;
    kept.push(exchange);
  }

  return { replay: kept.reverse().flat(), truncated };
}
