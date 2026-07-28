import { Wand2, ListCollapse, GitBranch, ShieldCheck } from 'lucide-react';

export type DockChipId = 'improve' | 'summarize' | 'diagram' | 'quality';

export interface DockChip {
  id: DockChipId;
  label: string;
  Icon: typeof Wand2;
  /** Tooltip. Names what the chip will do, in the product's own language. */
  hint: string;
}

/**
 * The four document actions, as chips that seed one conversation rather than
 * modes you switch into (#1126).
 *
 * `/ai`'s six-mode tablist made the user pick a mode *and*, separately,
 * establish a page context, with nothing connecting the two axes. In the dock
 * the open document is the context, so the second axis is gone and what is left
 * is four verbs. Generate is deliberately absent: it creates a *new* document
 * rather than acting on the open one, and its upload zone and long-form prompt
 * do not fit a 420px column. It stays on `/ai`.
 */
export const DOCK_CHIPS: readonly DockChip[] = [
  {
    id: 'improve',
    label: 'Improve',
    Icon: Wand2,
    hint: 'Rewrite this page. Anything typed below is used as extra instructions.',
  },
  { id: 'summarize', label: 'Summarize', Icon: ListCollapse, hint: 'Summarize this page.' },
  { id: 'diagram', label: 'Diagram', Icon: GitBranch, hint: 'Draw a diagram of this page.' },
  { id: 'quality', label: 'Quality', Icon: ShieldCheck, hint: 'Score this page across five quality dimensions.' },
] as const;

interface ChipMessageOptions {
  improvementType: string;
  diagramType: string;
  /** Free text sitting in the composer. Only Improve can carry it. */
  instruction?: string;
}

/**
 * The user turn a chip writes into the thread.
 *
 * These read as things a person would say, not as machine labels. `/ai`'s
 * equivalents name the page ("Improve (grammar): Onboarding Guide") because on
 * that route the document is not on screen and the title is the only clue what
 * was operated on. In the dock the document is *right there*, so repeating its
 * title in every turn is noise in a 420px column.
 */
export function chipUserMessage(id: DockChipId, opts: ChipMessageOptions): string {
  switch (id) {
    case 'improve': {
      const instruction = opts.instruction?.trim();
      // When the user typed something, that IS the request — showing them a
      // generated label instead of their own words is the thing that makes a
      // chat surface feel like it did not listen.
      return instruction || `Improve this page (${opts.improvementType}).`;
    }
    case 'summarize':
      return 'Summarize this page.';
    case 'diagram':
      return `Draw a ${opts.diagramType} diagram of this page.`;
    case 'quality':
      return 'Analyze this page’s quality.';
  }
}
