import { describe, it, expect } from 'vitest';
import { getSSEContent, hasSSEDoneEvent } from './sse';
import type { SSEEvent } from './sse';

describe('SSE Helper Utilities', () => {
  describe('getSSEContent', () => {
    it('should extract content from SSE events', () => {
      const events: SSEEvent[] = [
        { data: { content: 'Hello' } },
        { data: { content: ' ' } },
        { data: { content: 'World' } },
      ];

      expect(getSSEContent(events)).toBe('Hello World');
    });

    it('should skip events without content field', () => {
      const events: SSEEvent[] = [
        { data: { content: 'Hello' } },
        { data: { done: true } },
        { data: { content: ' World' } },
        { data: { type: 'status', message: 'processing' } },
      ];

      expect(getSSEContent(events)).toBe('Hello World');
    });

    it('should return empty string for no events', () => {
      expect(getSSEContent([])).toBe('');
    });

    it('should return empty string when no events have content', () => {
      const events: SSEEvent[] = [
        { data: { done: true } },
        { data: { type: 'status' } },
      ];

      expect(getSSEContent(events)).toBe('');
    });

    it('should handle null data gracefully', () => {
      const events: SSEEvent[] = [
        { data: null },
        { data: { content: 'test' } },
      ];

      expect(getSSEContent(events)).toBe('test');
    });

    it('should handle primitive data gracefully', () => {
      const events: SSEEvent[] = [
        { data: 'string value' },
        { data: 42 },
        { data: { content: 'valid' } },
      ];

      expect(getSSEContent(events)).toBe('valid');
    });
  });

  describe('hasSSEDoneEvent', () => {
    it('should return true when done event exists', () => {
      const events: SSEEvent[] = [
        { data: { content: 'Hello' } },
        { data: { done: true } },
      ];

      expect(hasSSEDoneEvent(events)).toBe(true);
    });

    it('should return false when no done event exists', () => {
      const events: SSEEvent[] = [
        { data: { content: 'Hello' } },
        { data: { content: 'World' } },
      ];

      expect(hasSSEDoneEvent(events)).toBe(false);
    });

    it('should return false for empty events', () => {
      expect(hasSSEDoneEvent([])).toBe(false);
    });

    it('should not match done: false', () => {
      const events: SSEEvent[] = [
        { data: { done: false } },
      ];

      expect(hasSSEDoneEvent(events)).toBe(false);
    });

    it('should handle null data', () => {
      const events: SSEEvent[] = [
        { data: null },
      ];

      expect(hasSSEDoneEvent(events)).toBe(false);
    });
  });
});
