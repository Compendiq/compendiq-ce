import { type ImprovementType } from '../improvement-types';

export type DockChipId = 'improve' | 'diagram';

interface ChipMessageOptions {
  improvementType: ImprovementType;
  diagramType: string;
  /** Free text sitting in the composer, used as action-specific instructions. */
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
    case 'diagram':
      return opts.instruction?.trim() || `Draw a ${opts.diagramType} diagram of this page.`;
  }
}
