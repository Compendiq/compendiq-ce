/**
 * #1955, review r1 R5: the reader stops at its first refusal. The parser is
 * wrapped so every event it hands to the reader is counted: a refused string
 * costs the events up to the refusal, never the rest of the chunk it sits in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Saxes from 'saxes';

const EVENTS = vi.hoisted(() => ({ opentag: 0, text: 0, closetag: 0 }));

vi.mock('saxes', async (importOriginal) => {
  const actual = await importOriginal<typeof Saxes>();
  class CountingParser extends actual.SaxesParser {
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
    EVENTS.opentag = 0;
    EVENTS.text = 0;
    EVENTS.closetag = 0;
  });

  // 5,000 further elements in the same 65,536-unit chunk as the refusal.
  const TAIL = '<x>t</x>'.repeat(5_000);

  it('hands the reader no event after the node limit is passed', () => {
    expect(readConfluenceStorage(`<a/><b/><c/><d/>${TAIL}`, { length: 1_000_000, depth: 8, nodes: 3 }))
      .toEqual({ ok: false, reason: 'too-many-nodes' });
    expect(EVENTS).toEqual({ opentag: 4, text: 0, closetag: 3 });
  });

  it('hands the reader no event after the depth limit is passed', () => {
    expect(readConfluenceStorage(`<a><b><c>${TAIL}</c></b></a>`, { length: 1_000_000, depth: 2, nodes: 1_000_000 }))
      .toEqual({ ok: false, reason: 'too-deep' });
    expect(EVENTS).toEqual({ opentag: 3, text: 0, closetag: 0 });
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
    expect(EVENTS).toEqual({ opentag: 1, text: 0, closetag: 0 });
  });

  it('still reads a whole string within its limits', () => {
    const result = readConfluenceStorage(`<a>t</a>${TAIL}`);
    expect(result.ok).toBe(true);
    expect(EVENTS).toEqual({ opentag: 5_001, text: 5_001, closetag: 5_001 });
  });
});
