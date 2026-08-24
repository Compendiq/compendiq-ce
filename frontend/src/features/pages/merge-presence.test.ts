import { describe, it, expect } from 'vitest';
import { mergePresence } from './merge-presence';
import type { PresenceViewer } from './use-presence';

const alice: PresenceViewer = { userId: 'u1', name: 'Alice', role: 'editor', isEditing: true };
const bob: PresenceViewer = { userId: 'u2', name: 'Bob', role: 'viewer', isEditing: false };

describe('mergePresence', () => {
  it('clears SSE isEditing when awareness is empty (collab live, no editors in the room)', () => {
    const merged = mergePresence([alice, bob], []);
    expect(merged.map((v) => v.userId)).toEqual(['u1', 'u2']);
    expect(merged.every((v) => v.isEditing === false)).toBe(true);
  });

  it('marks awareness users as editing and merges by userId', () => {
    const merged = mergePresence(
      [alice, bob],
      [{ id: 'u1', name: 'Alice', color: '#5C6B8A' }],
    );
    const a = merged.find((v) => v.userId === 'u1');
    const b = merged.find((v) => v.userId === 'u2');
    expect(a?.isEditing).toBe(true);
    expect(a?.caretColor).toBe('#5C6B8A');
    expect(b?.isEditing).toBe(false);
  });

  it('adds an awareness-only editor who is not on the SSE list', () => {
    const merged = mergePresence(
      [bob],
      [{ id: 'u9', name: 'Nia', color: '#3F6F64' }],
    );
    expect(merged[0]?.userId).toBe('u9');
    expect(merged[0]?.isEditing).toBe(true);
    expect(merged[1]?.userId).toBe('u2');
  });

  it('sorts editors first, then by userId', () => {
    const merged = mergePresence(
      [
        { userId: 'u-z', name: 'Zed', role: 'viewer', isEditing: false },
        { userId: 'u-a', name: 'Ann', role: 'viewer', isEditing: false },
      ],
      [{ id: 'u-m', name: 'Mo', color: '#8A5A3C' }],
    );
    expect(merged.map((v) => v.userId)).toEqual(['u-m', 'u-a', 'u-z']);
  });
});
