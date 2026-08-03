import { describe, it, expect } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
  TEXT_BLOCK_TYPES,
  blockLabel,
  containsStructuredInline,
  supportsTextActions,
} from './block-menu-nodes';

/**
 * #1179 — which blocks may be offered text actions, and what they are called.
 * A tiny hand-rolled schema keeps this a pure unit test: only the node *name*
 * (and `heading`'s level / `unknownMacro`'s macro name) feed either decision.
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*' },
    hardBreak: { group: 'inline', inline: true },
    confluenceStatus: { group: 'inline', inline: true, atom: true },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    blockquote: { group: 'block', content: 'block+' },
    listItem: { group: 'block', content: 'paragraph+' },
    codeBlock: { group: 'block', content: 'inline*' },
    bulletList: { group: 'block', content: 'listItem+' },
    drawioDiagram: { group: 'block', atom: true },
    confluenceLayout: { group: 'block', content: 'block+' },
    unknownMacro: { group: 'block', content: 'block*', attrs: { macroName: { default: null } } },
    figure: { group: 'block', content: 'paragraph*' },
    confluenceRoadmapPlanner: { group: 'block', atom: true },
  },
});

const node = (name: string, attrs?: Record<string, unknown>) =>
  schema.nodes[name]!.createAndFill(attrs)!;

describe('supportsTextActions', () => {
  it.each(['paragraph', 'heading', 'blockquote', 'listItem'])(
    'allows text actions on %s',
    (name) => {
      expect(supportsTextActions(node(name))).toBe(true);
    },
  );

  // The load-bearing half. Improve ends in `insertContentAt(range, html)`; on
  // any of these that would replace a structured Confluence node with
  // Markdown-derived HTML and the next Save would push the loss upstream.
  it.each([
    'codeBlock',
    'bulletList',
    'drawioDiagram',
    'confluenceLayout',
    'unknownMacro',
    'figure',
  ])('refuses text actions on %s', (name) => {
    expect(supportsTextActions(node(name))).toBe(false);
  });

  it('refuses a node type it has never seen — the list is an allow-list', () => {
    expect(supportsTextActions(node('confluenceRoadmapPlanner'))).toBe(false);
  });

  it('allows exactly four types, matching the decision on the issue', () => {
    expect([...TEXT_BLOCK_TYPES].sort()).toEqual(
      ['blockquote', 'heading', 'listItem', 'paragraph'],
    );
  });
});

describe('blockLabel', () => {
  it('names a paragraph', () => {
    expect(blockLabel(node('paragraph'))).toBe('Paragraph');
  });

  it('includes the heading level', () => {
    expect(blockLabel(node('heading', { level: 2 }))).toBe('Heading 2');
  });

  it('uses the real macro name for an unknown macro', () => {
    expect(blockLabel(node('unknownMacro', { macroName: 'roadmap' }))).toBe('roadmap macro');
  });

  it('falls back to a generic name for an unknown macro with no name', () => {
    expect(blockLabel(node('unknownMacro'))).toBe('Macro');
  });

  it('names the Confluence and diagram nodes in human words', () => {
    expect(blockLabel(node('drawioDiagram'))).toBe('Draw.io diagram');
    expect(blockLabel(node('confluenceLayout'))).toBe('Layout');
    expect(blockLabel(node('blockquote'))).toBe('Quote');
  });

  it('humanises a node type it has no entry for', () => {
    expect(blockLabel(node('confluenceRoadmapPlanner'))).toBe('Confluence roadmap planner');
  });
});


describe('containsStructuredInline', () => {
  const doc = (...content: PMNode[]) => schema.nodes.doc!.create(null, content);
  const para = (...content: PMNode[]) => schema.nodes.paragraph!.create(null, content);
  const text = (t: string) => schema.text(t);

  /** Range covering the first paragraph's inline content. */
  const contentRange = (d: ReturnType<typeof doc>) => ({ from: 1, to: d.child(0).nodeSize - 1 });

  it('is false for plain text', () => {
    const d = doc(para(text('Just prose')));
    const { from, to } = contentRange(d);
    expect(containsStructuredInline(d, from, to)).toBe(false);
  });

  // The real defect: `textBetween` omits these, so the model never sees them,
  // and Replace overwrites the range and deletes the nodes.
  it('is true when an inline Confluence atom sits in the range', () => {
    const d = doc(para(text('Release '), schema.nodes.confluenceStatus!.create(), text(' now')));
    const { from, to } = contentRange(d);
    expect(containsStructuredInline(d, from, to)).toBe(true);
  });

  it('ignores a hard break — losing one is cosmetic, not Confluence content', () => {
    const d = doc(para(text('One'), schema.nodes.hardBreak!.create(), text('two')));
    const { from, to } = contentRange(d);
    expect(containsStructuredInline(d, from, to)).toBe(false);
  });

  it('does not look outside the range it was given', () => {
    const d = doc(
      para(text('Clean paragraph')),
      para(text('Has '), schema.nodes.confluenceStatus!.create()),
    );
    expect(containsStructuredInline(d, 1, d.child(0).nodeSize - 1)).toBe(false);
  });
});
