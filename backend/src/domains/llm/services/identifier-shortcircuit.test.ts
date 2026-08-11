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

    it('detects a cued numeric id of five or more digits', () => {
      expect(detectIdentifiers('page 43561')).toContainEqual({ kind: 'pageId', value: '43561' });
      expect(detectIdentifiers('id #4285005824')).toContainEqual({ kind: 'pageId', value: '4285005824' });
    });

    it('NEVER fires the cued shape on small integers — dense-SERIAL prose traps (#1273 B1)', () => {
      // pages.id is a dense SERIAL: "page 2" would verify against SOME row
      // on every instance, so verification cannot save this shape.
      for (const q of ['see page 12 above', 'page 2 of the deployment guide', 'what does page 7 say', 'id 500 error meaning', 'page2 formatting issue']) {
        expect(detectIdentifiers(q).filter((d) => d.kind === 'pageId')).toEqual([]);
      }
    });

    it('a whole-query bare number of any length stays deliberate intent', () => {
      expect(detectIdentifiers('182')).toContainEqual({ kind: 'pageId', value: '182' });
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

    it('captures a multi-segment key WHOLE (#1273 fork F7)', () => {
      // Truncating at the second hyphen turned CVE-2024-1234 into
      // CVE-2024, a key that title-matches any page naming a different
      // 2024 CVE — a confident pin on the wrong identifier.
      expect(detectIdentifiers('CVE-2024-1234 remediation status')).toContainEqual({
        kind: 'issueKey',
        value: 'CVE-2024-1234',
      });
      expect(detectIdentifiers('CVE-2024-1234 remediation status')).not.toContainEqual({
        kind: 'issueKey',
        value: 'CVE-2024',
      });
    });

    it('still DETECTS technical acronym compounds — the safety net is the title-only lookup, not the shape (#1273 fork F1)', () => {
      // No structural test separates INC-2203 from SHA-256, and a prefix
      // denylist would be exactly the probabilistic guard this design
      // rejects. Detection stays cheap and permissive; verification is
      // what refuses, by probing TITLES only.
      expect(detectIdentifiers('SHA-256 vs MD5')).toContainEqual({ kind: 'issueKey', value: 'SHA-256' });
      expect(detectIdentifiers('UTF-8 encoding issues')).toContainEqual({ kind: 'issueKey', value: 'UTF-8' });
    });
  });

  describe('space key — the highest-ambiguity shape', () => {
    it('never fires on a bare uppercase token in natural language', () => {
      // The Corrections name this exact trap: DEV/IT/OPS/HR appear
      // constantly in ordinary questions.
      expect(detectIdentifiers('how does DEV deploy to production')).toEqual([]);
      expect(detectIdentifiers('ask HR about onboarding')).toEqual([]);
    });

    it('fires only whole-query or cue-adjacent', () => {
      expect(detectIdentifiers('OPS')).toContainEqual({ kind: 'spaceKey', value: 'OPS' });
      expect(detectIdentifiers('space OPS')).toContainEqual({ kind: 'spaceKey', value: 'OPS' });
    });

    it('a QUOTED all-caps string is a title, not a space key (#1273 fork F10)', () => {
      // Pages genuinely titled 'FAQ' / 'SLA' / 'API' / 'OKR' exist, and
      // reclassifying the quoted form as a space key made them unpinnable:
      // space-key detections verify nothing, so the one gesture that names
      // a short title exactly went nowhere.
      expect(detectIdentifiers('"OPS"')).toEqual([{ kind: 'title', value: 'OPS' }]);
      expect(detectIdentifiers('find "SLA"')).toContainEqual({ kind: 'title', value: 'SLA' });
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

    it('accepts the typographic quotes macOS and iOS substitute by default (#1273 fork F14)', () => {
      // An ASCII-only pattern left the primary gesture dead for anyone
      // typing quotes on an Apple keyboard, and the miss was invisible.
      expect(detectIdentifiers('find “Deployment Runbook”')).toContainEqual({ kind: 'title', value: 'Deployment Runbook' });
      expect(detectIdentifiers('«Onboarding»')).toContainEqual({ kind: 'title', value: 'Onboarding' });
    });

    it('strips trailing punctuation from the called-cue capture (#1273 fork F13)', () => {
      // Measured on Postgres: similarity('FAQ', 'FAQ?') = 0.286, under
      // pg_trgm's 0.3 threshold — the question mark alone killed the pin.
      expect(detectIdentifiers('the page called FAQ?')).toContainEqual({ kind: 'title', value: 'FAQ' });
      expect(detectIdentifiers('page named Deployment Runbook.')).toContainEqual({ kind: 'title', value: 'Deployment Runbook' });
    });
  });

  describe('guards', () => {
    it('exports the token limits the design pins', () => {
      expect(MAX_BARE_QUERY_TOKENS).toBe(4);
      expect(MAX_CUED_QUERY_TOKENS).toBe(6);
    });

    it('returns at most two identifiers, strongest kind first', () => {
      const out = detectIdentifiers('page 43561 "Runbook"');
      expect(out.length).toBeLessThanOrEqual(2);
      expect(out[0]!.kind).toBe('pageId');
    });

    it('detects nothing in an ordinary natural-language question', () => {
      expect(detectIdentifiers('how do I restart the embedding queue safely')).toEqual([]);
    });
  });
});
