import { describe, it, expect } from 'vitest';
import {
  CreateCommentSchema,
  EditCommentSchema,
  CommentReactionSchema,
  CommentSchema,
  ListCommentsQuerySchema,
  CommentAnchorDataSchema,
} from './comments.js';

describe('Comments contracts schemas', () => {
  it('validates CreateCommentSchema with anchorData', () => {
    const valid = {
      body: 'Review this paragraph',
      bodyHtml: '<p>Review this paragraph</p>',
      anchorType: 'selection',
      anchorData: {
        text: 'highlighted phrase',
        quote: 'highlighted phrase',
        from: 10,
        to: 28,
        commentId: 'c-123',
      },
    };
    const parsed = CreateCommentSchema.parse(valid);
    expect(parsed.anchorType).toBe('selection');
    expect(parsed.anchorData?.quote).toBe('highlighted phrase');
  });

  it('validates CreateCommentSchema without anchorData (page-level comment)', () => {
    const valid = {
      body: 'General comment on the page',
    };
    const parsed = CreateCommentSchema.parse(valid);
    expect(parsed.body).toBe('General comment on the page');
    expect(parsed.anchorType).toBeUndefined();
  });

  it('validates EditCommentSchema', () => {
    const valid = {
      body: 'Updated body text',
    };
    const parsed = EditCommentSchema.parse(valid);
    expect(parsed.body).toBe('Updated body text');
  });

  it('validates CommentReactionSchema', () => {
    const valid = { emoji: '👍' };
    const parsed = CommentReactionSchema.parse(valid);
    expect(parsed.emoji).toBe('👍');
  });

  it('validates CommentSchema and nested replies', () => {
    const comment = {
      id: 1,
      pageId: 42,
      userId: '11111111-1111-1111-1111-111111111111',
      username: 'alice',
      body: 'Top note',
      bodyHtml: '<p>Top note</p>',
      isResolved: false,
      anchorType: 'selection',
      anchorData: {
        text: 'selected text',
        from: 10,
        to: 23,
      },
      createdAt: '2026-08-21T00:00:00Z',
      updatedAt: '2026-08-21T00:00:00Z',
      reactions: { '👍': ['bob'] },
      replies: [
        {
          id: '2',
          pageId: '42',
          userId: '22222222-2222-2222-2222-222222222222',
          username: 'bob',
          parentId: '1',
          body: 'Replying here',
          bodyHtml: '<p>Replying here</p>',
          isResolved: false,
          createdAt: '2026-08-21T00:01:00Z',
          updatedAt: '2026-08-21T00:01:00Z',
          reactions: {},
        },
      ],
    };

    const parsed = CommentSchema.parse(comment);
    expect(parsed.id).toBe('1');
    expect(parsed.pageId).toBe('42');
    expect(parsed.replies?.[0]?.parentId).toBe('1');
  });

  it('validates ListCommentsQuerySchema', () => {
    expect(ListCommentsQuerySchema.parse({}).includeResolved).toBe('false');
    expect(ListCommentsQuerySchema.parse({ includeResolved: 'true' }).includeResolved).toBe('true');
  });
});
