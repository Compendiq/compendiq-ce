import { useAiContext } from './AiContext';

/**
 * #283 — the assistant's policy notices. Three sources, one neutral box:
 *
 * - `ai_history_not_replayable` (server): this thread's history cannot be
 *   sent under the current article policy. Thread and draft stay; New chat
 *   starts a fresh thread WITHOUT the restricted history.
 * - `ai_policy_unavailable` (server, transient): the policy could not be
 *   read. Draft stays; Retry only re-arms Send, it does not classify the
 *   history as safe.
 * - a local denial (`runStream`'s fail-closed guard): the open article's
 *   policy refuses page-derived work, or could not be read. Nothing was
 *   sent; the reason is the server's stated policy, never a guess.
 *
 * Visible prose in a status region, not a tooltip: reachable by keyboard,
 * touch and assistive tech.
 */
export function PolicyRefusalNotice() {
  const { policyRefusal, policyDenial, startNewConversation, clearPolicyRefusal } = useAiContext();
  if (!policyRefusal && !policyDenial) return null;
  return <div role="status" className="my-2 space-y-2 rounded-md border border-border p-3 text-xs text-muted-foreground" data-testid="policy-refusal-notice">
    {policyRefusal ? (
      <>
        <p>{policyRefusal === 'ai_history_not_replayable'
          ? 'Nothing was sent. This history cannot be sent under the current article AI policy. The visible thread and your draft are kept. New chat starts without historical context; your draft remains in this thread.'
          : 'Nothing was sent. Article AI policy could not be checked. Your draft is kept. Retry does not classify the history as safe; Send will check it again.'}</p>
        {policyRefusal === 'ai_history_not_replayable'
          ? <button type="button" className="nm-button-ghost px-3 py-2" onClick={startNewConversation}>New chat</button>
          : <button type="button" className="nm-button-ghost px-3 py-2" onClick={clearPolicyRefusal}>Retry — review draft and Send</button>}
      </>
    ) : (
      <>
        <p data-testid="policy-denial-reason">Nothing was sent. {policyDenial}</p>
        <button type="button" className="nm-button-ghost px-3 py-2" onClick={clearPolicyRefusal}>Dismiss</button>
      </>
    )}
  </div>;
}
