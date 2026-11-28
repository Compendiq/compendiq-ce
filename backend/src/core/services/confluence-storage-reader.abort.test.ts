/**
 * #1955, review r1 R5: the reader stops at its first refusal. The parser is
 * wrapped so every event it hands to the reader is counted: a refused string
 * costs the events up to the refusal, never the rest of the chunk it sits in.
 * Review r2 R13: the start of a tag and each attribute are events of their
 * own, counted whether the reader listens to them or not, so a tag's
 * attributes after the refusal are seen to be never read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Saxes from 'saxes';

const EVENTS = vi.hoisted(() => ({ opentagstart: 0, attribute: 0, opentag: 0, text: 0, closetag: 0 }));

vi.mock('saxes', async (importOriginal) => {
  const actual = await importOriginal<typeof Saxes>();
  class CountingParser extends actual.SaxesParser {
    constructor(...args: ConstructorParameters<typeof actual.SaxesParser>) {
      super(...args);
      // Counted even when the reader does not listen: the parser still produces them.
      super.on('opentagstart', () => { EVENTS.opentagstart += 1; });
      super.on('attribute', () => { EVENTS.attribute += 1; });
    }

    override on(name: never, handler: never): void {
      const counted = (...args: unknown[]): unknown => {
        if (name in EVENTS) EVENTS[name as keyof typeof EVENTS] += 1;
        return (handler as (...values: unknown[]) => unknown)(...args);
      };
      super.on(name, counted as never);
    }
  }
  return { ...actual, SaxesParser: CountingParser };
});

const { readConfluenceStorage } = await import('./confluence-storage-reader.js');

describe('confluence-storage-reader: reading stops at the first refusal (R5)', () => {
  beforeEach(() => {
    for (const name of Object.keys(EVENTS) as Array<keyof typeof EVENTS>) EVENTS[name] = 0;
  });

  // 5,000 further elements in the same 65,536-unit chunk as the refusal.
  const TAIL = '<x>t</x>'.repeat(5_000);

  it('hands the reader no event after the node limit is passed', () => {
    expect(readConfluenceStorage(`<a/><b/><c/><d/>${TAIL}`, { length: 1_000_000, depth: 8, nodes: 3 }))
      .toEqual({ ok: false, reason: 'too-many-nodes' });
    expect(EVENTS).toEqual({ opentagstart: 4, attribute: 0, opentag: 3, text: 0, closetag: 3 });
  });

  it('hands the reader no event after the depth limit is passed', () => {
    expect(readConfluenceStorage(`<a><b><c>${TAIL}</c></b></a>`, { length: 1_000_000, depth: 2, nodes: 1_000_000 }))
      .toEqual({ ok: false, reason: 'too-deep' });
    expect(EVENTS).toEqual({ opentagstart: 3, attribute: 0, opentag: 2, text: 0, closetag: 0 });
  });

  it('hands the reader no event after the string stops being well-formed', () => {
    expect(readConfluenceStorage(`<a>t</a><p>&bogus;</p>${TAIL}`)).toEqual({ ok: false, reason: 'not-well-formed' });
    expect(EVENTS.opentag).toBe(2);
    expect(EVENTS.closetag).toBe(1);
  });

  it('counts the attributes of a tag before it keeps any of them', () => {
    const attributes = Array.from({ length: 50 }, (_, index) => `a${index}="v"`).join(' ');
    expect(readConfluenceStorage(`<a ${attributes}/>${TAIL}`, { length: 1_000_000, depth: 8, nodes: 10 }))
      .toEqual({ ok: false, reason: 'too-many-nodes' });
    // The element and nine attributes fit; the tenth attribute passes the limit, and no later one is read.
    expect(EVENTS).toEqual({ opentagstart: 1, attribute: 10, opentag: 0, text: 0, closetag: 0 });
  });

  it.each([16, 64])('reads no attribute of a %i-attribute tag after the one that passes the node limit (R13)', (count) => {
    const attributes = Array.from({ length: count }, (_, index) => `a${index}="v"`).join(' ');
    expect(readConfluenceStorage(`<a ${attributes}/>${TAIL}`, { length: 1_000_000, depth: 8, nodes: 3 }))
      .toEqual({ ok: false, reason: 'too-many-nodes' });
    // At e084eeae every attribute of the tag was read before the refusal: 16 and 64.
    expect(EVENTS).toEqual({ opentagstart: 1, attribute: 3, opentag: 0, text: 0, closetag: 0 });
  });

  it('refuses a tag past the depth limit when it starts, before any attribute of it is read (R13)', () => {
    const attributes = Array.from({ length: 64 }, (_, index) => `a${index}="v"`).join(' ');
    expect(readConfluenceStorage(`<a><b ${attributes}/></a>`, { length: 1_000_000, depth: 1, nodes: 1_000_000 }))
      .toEqual({ ok: false, reason: 'too-deep' });
    expect(EVENTS).toEqual({ opentagstart: 2, attribute: 0, opentag: 1, text: 0, closetag: 0 });
  });

  it('still reads a whole string within its limits', () => {
    const result = readConfluenceStorage(`<a>t</a>${TAIL}`);
    expect(result.ok).toBe(true);
    expect(EVENTS).toEqual({ opentagstart: 5_001, attribute: 0, opentag: 5_001, text: 5_001, closetag: 5_001 });
  });
});
