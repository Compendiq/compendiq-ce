import { describe, it, expect } from 'vitest';
import {
  detectIdentifiers,
  MAX_BARE_QUERY_TOKENS,
  MAX_CUED_QUERY_TOKENS,
} from './identifier-shortcircuit.js';

// #1107 — the pure DETECTION half. Every shape and guard here comes from
// the issue's Corrections section and the design-of-record comment: the
// false-positive risk IS the issue, so the guards are the tests. The DB
// verification and pin mechanics live in rag-service and are tested there.

describe('detectIdentifiers (#1107)', () => {
  describe('numeric page id', () => {
    it('detects a whole-query numeric id', () => {
      expect(detectIdentifiers('182')).toContainEqual({ kind: 'pageId', value: '182' });
    });

    it('detects a cued numeric id inside a short query', () => {
      expect(detectIdentifiers('page 182')).toContainEqual({ kind: 'pageId', value: '182' });
      expect(detectIdentifiers('id #4711')).toContainEqual({ kind: 'pageId', value: '4711' });
    });

    it('ignores bare numbers embedded in natural language', () => {
      // "we have 3 environments" must not trigger a page-id lookup.
      expect(detectIdentifiers('we have 3 environments for testing today')).toEqual([]);
    });
  });

  describe('issue-style key (INC-2203 shapes)', () => {
    it('detects the planted corpus shapes case-sensitively', () => {
      for (const key of ['INC-2203', 'INC-2417', 'CAP-2026', 'SEC-0731']) {
        expect(detectIdentifiers(`what is ${key} about`)).toContainEqual({ kind: 'issueKey', value: key });
      }
    });

    it('rejects lowercase lookalikes — case is the signal', () => {
      expect(detectIdentifiers('what is inc-2203 about')).toEqual([]);
    });

    it('rejects keys in long natural-language queries — the token limit guards dilution', () => {
      const long = 'please give me a detailed summary of everything that happened around INC-2203 last week and who was involved';
      expect(detectIdentifiers(long)).toEqual([]);
    });
  });

  describe('space key — the highest-ambiguity shape', () => {
    it('never fires on a bare uppercase token in natural language', () => {
      // The Corrections name this exact trap: DEV/IT/OPS/HR appear
      // constantly in ordinary questions.
      expect(detectIdentifiers('how does DEV deploy to production')).toEqual([]);
      expect(detectIdentifiers('ask HR about onboarding')).toEqual([]);
    });

    it('fires only whole-query, quoted, or cue-adjacent', () => {
      expect(detectIdentifiers('OPS')).toContainEqual({ kind: 'spaceKey', value: 'OPS' });
      expect(detectIdentifiers('space OPS')).toContainEqual({ kind: 'spaceKey', value: 'OPS' });
      expect(detectIdentifiers('"OPS"')).toContainEqual({ kind: 'spaceKey', value: 'OPS' });
    });
  });

  describe('quoted title / called-cue', () => {
    it('detects a quoted title fragment', () => {
      expect(detectIdentifiers('find "Deployment Runbook"')).toContainEqual({ kind: 'title', value: 'Deployment Runbook' });
    });

    it('detects the called/named cue', () => {
      expect(detectIdentifiers('find the page called Deployment Runbook')).toContainEqual({ kind: 'title', value: 'Deployment Runbook' });
      expect(detectIdentifiers('the page named Onboarding')).toContainEqual({ kind: 'title', value: 'Onboarding' });
    });

    it('ignores quotes in long queries — the cued token limit still applies', () => {
      const long = 'in our last retro someone mentioned a document "Deployment Runbook" that apparently explains the whole release process in detail';
      expect(detectIdentifiers(long)).toEqual([]);
    });
  });

  describe('guards', () => {
    it('exports the token limits the design pins', () => {
      expect(MAX_BARE_QUERY_TOKENS).toBe(4);
      expect(MAX_CUED_QUERY_TOKENS).toBe(6);
    });

    it('returns at most two identifiers, strongest kind first', () => {
      const out = detectIdentifiers('page 182 "Runbook"');
      expect(out.length).toBeLessThanOrEqual(2);
      expect(out[0]!.kind).toBe('pageId');
    });

    it('detects nothing in an ordinary natural-language question', () => {
      expect(detectIdentifiers('how do I restart the embedding queue safely')).toEqual([]);
    });
  });
});
