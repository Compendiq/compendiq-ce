import { describe, expect, it } from 'vitest';
import {
  ConnectNotionSchema,
  NOTION_UNSUPPORTED_LABEL,
  NotionConnectionResponseSchema,
  NotionTreeResponseSchema,
} from './notion.js';

describe('ConnectNotionSchema', () => {
  it('accepts a non-empty token', () => {
    expect(ConnectNotionSchema.parse({ token: 'secret_test_token' })).toEqual({
      token: 'secret_test_token',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(ConnectNotionSchema.parse({ token: '  ntn_abc  ' })).toEqual({ token: 'ntn_abc' });
  });

  it('rejects an empty or whitespace-only token', () => {
    expect(() => ConnectNotionSchema.parse({ token: '' })).toThrow();
    expect(() => ConnectNotionSchema.parse({ token: '   ' })).toThrow();
  });
});

describe('NotionConnectionResponseSchema', () => {
  it('exposes only hasToken — never a token field', () => {
    expect(NotionConnectionResponseSchema.parse({ hasToken: true })).toEqual({ hasToken: true });
    expect(Object.keys(NotionConnectionResponseSchema.shape)).toEqual(['hasToken']);
  });

  it('strips unknown keys including a leaked token (strict)', () => {
    expect(() =>
      NotionConnectionResponseSchema.parse({ hasToken: true, token: 'secret_should_not_pass' }),
    ).toThrow();
  });
});

describe('NotionTreeResponseSchema', () => {
  const page = {
    id: 'page-1',
    title: 'Handbook',
    type: 'page' as const,
    selectable: true as const,
    children: [],
  };

  it('uses the exact skip label on non-selectable nodes', () => {
    expect(NOTION_UNSUPPORTED_LABEL).toBe('Not supported — stays in Notion');
    const tree = NotionTreeResponseSchema.parse({
      nodes: [
        {
          ...page,
          children: [
            {
              id: 'db-1',
              title: 'CRM',
              type: 'database',
              selectable: false,
              skipReason: NOTION_UNSUPPORTED_LABEL,
              children: [],
            },
          ],
        },
      ],
    });
    const skipped = tree.nodes[0]!.children[0]!;
    expect(skipped.type).toBe('database');
    expect(skipped.selectable).toBe(false);
    if (skipped.selectable) throw new Error('expected skipped node');
    expect(skipped.skipReason).toBe(NOTION_UNSUPPORTED_LABEL);
  });

  it('rejects a selectable database and a page carrying skipReason', () => {
    expect(() =>
      NotionTreeResponseSchema.parse({
        nodes: [
          {
            id: 'db-1',
            title: 'CRM',
            type: 'database',
            selectable: true,
            children: [],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      NotionTreeResponseSchema.parse({
        nodes: [
          {
            id: 'page-1',
            title: 'Handbook',
            type: 'page',
            selectable: true,
            skipReason: NOTION_UNSUPPORTED_LABEL,
            children: [],
          },
        ],
      }),
    ).toThrow();
  });

  it('strips a leaked token on the tree document (strict)', () => {
    expect(() =>
      NotionTreeResponseSchema.parse({
        nodes: [page],
        token: 'secret_should_not_pass',
      }),
    ).toThrow();
  });
});
