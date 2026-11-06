import { useCallback, useEffect, useState } from 'react';

/**
 * The retry a "could not be read" notice owns — the `RetrievalTab` recipe,
 * adjudicated over three rounds there and carried by every settings notice
 * whose own button lives inside the strip it can unmount.
 *
 * ONE definition, in this module, because there were three surfaces wanting
 * it (#1618): `BackupTab`, `EmbeddingShadowCompareSection` and the image
 * analysis card. The two hand-copies had already drifted in their effect's
 * shape while agreeing on the semantics, and a fourth copy is how a rule with
 * three rounds of adjudication behind it quietly loses one of them.
 *
 * The defect it closes is that such notices are gated on `isError` ALONE, and
 * react-query's `fetchState` spreads
 * `...(data === undefined && { error: null, status: 'pending' })`: refetching
 * an errored query with NOTHING cached drops back to `pending`, `isError`
 * goes false, and the `role="status"` strip CONTAINING the button the admin
 * just pressed unmounts under their focus, which falls to `<body>` in a
 * settings tab with ~30 stops. The window is not a tick — `query-client.ts`
 * retries a non-4xx twice more with backoff — so this is seconds of a panel
 * with focus lost and nothing saying a read is in flight.
 *
 * Three rules, each of them one of that adjudication's rounds:
 *
 *  - `retryInFlight` is set in the handler and cleared in `.finally()`, and
 *    each notice is gated on `<its own isError> || retryInFlight`, so the
 *    strip survives the request it started.
 *  - the busy state is `aria-disabled` and a label swap, NEVER a native
 *    `disabled`: per the HTML focus fixup rule a control that stops being
 *    focusable is blurred, which is the very thing the flag above exists to
 *    prevent (jsdom does not implement that, so a test can assert both and be
 *    wrong). The handler is the refusal instead. And it is `retryInFlight`
 *    alone, never `isFetching` — a window-focus refetch is not the user's
 *    action and must not be labelled as one.
 *  - the ORDINARY outcome is that the retry SUCCEEDS and the notice is
 *    removed with focus still on it, so a successful retry rehomes focus to
 *    the nearest surviving prose. Guarded twice: only for a retry this control
 *    started, and only if focus really did fall to `<body>`.
 */
export function useNoticeRetry(
  refetch: () => Promise<{ isError: boolean }>,
  stillFailing: boolean,
  focusTarget: React.RefObject<HTMLElement | null>,
): { retryInFlight: boolean; onRetry: () => void } {
  const [retryInFlight, setRetryInFlight] = useState(false);
  const [restoreFocusAfterRetry, setRestoreFocusAfterRetry] = useState(false);

  useEffect(() => {
    if (!restoreFocusAfterRetry) return;
    // The notice is still up (the retry failed, or is still out) — the button
    // is still under the admin's focus, which is where it belongs.
    if (stillFailing || retryInFlight) return;
    setRestoreFocusAfterRetry(false);
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusTarget.current?.focus();
  }, [restoreFocusAfterRetry, stillFailing, retryInFlight, focusTarget]);

  const onRetry = useCallback(() => {
    // The refusal `aria-disabled` cannot perform.
    if (retryInFlight) return;
    setRetryInFlight(true);
    setRestoreFocusAfterRetry(true);
    void refetch()
      .then(
        (result) => setRestoreFocusAfterRetry(!result.isError),
        () => setRestoreFocusAfterRetry(false),
      )
      .finally(() => setRetryInFlight(false));
  }, [refetch, retryInFlight]);

  return { retryInFlight, onRetry };
}
