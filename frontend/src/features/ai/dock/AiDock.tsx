import { useIsMobileLayout } from '../../../shared/hooks/use-media-query';
import { AiDockSheet } from './AiDockSheet';

/**
 * The docked AI assistant — mobile form only.
 *
 * #1126 shipped this as two containers around one panel: a third column beside
 * `ArticleRightPane` at md and up, and a bottom sheet below it. The column is
 * retired (owner decision, 2026-08-06): at md and up the assistant is now the
 * first TAB inside `ArticleRightPane`, switching instantly like Outline and
 * Details rather than opening a separate column with its own animation. One
 * right-hand edge, one interaction to learn.
 *
 * The sheet survives unchanged and is the reason this component still exists.
 * Below `md` there is no right side to dock into — the inspector pane is
 * `hidden md:flex` — so the sheet is the assistant's only form on a phone,
 * mirroring the way the left sidebar becomes a slide-over there.
 *
 * The column's width preference (`aiDockWidth`), its resize handle and its
 * open/close spring went with it; inside the inspector the assistant inherits
 * that pane's own width and resize.
 */
export function AiDock() {
  const mobile = useIsMobileLayout();
  return mobile ? <AiDockSheet /> : null;
}
