import { useIsMobileLayout } from '../../../shared/hooks/use-media-query';
import { AiDockSheet } from './AiDockSheet';

/**
 * The docked AI assistant — assistant-only mobile sheet.
 *
 * #1126 shipped this as two containers around one panel: a third column beside
 * `ArticleRightPane` at md and up, and a bottom sheet below it. The column is
 * retired (owner decision, 2026-08-06): at md and up the assistant is now the
 * first TAB inside `ArticleRightPane`. Below `md` AppLayout now hosts that
 * same pane as a page-inspector sheet (Outline / Details / Assistant), so this
 * component is no longer mounted from the shell. It remains as the
 * assistant-only sheet used by its own tests.
 *
 * The column's width preference, its resize handle and its open/close spring
 * went with it; inside the inspector the assistant inherits that pane's own
 * width and resize. `ui-store`'s `aiDockWidth` is deleted rather than left
 * dormant — nothing read it any more, and a persisted key that only tests
 * write is indistinguishable from one that still means something.
 */
export function AiDock() {
  const mobile = useIsMobileLayout();
  return mobile ? <AiDockSheet /> : null;
}
