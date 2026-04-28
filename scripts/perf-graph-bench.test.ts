import { describe, it, expect } from 'vitest';
import {
  neighbours,
  decide,
  benchInitScriptBody,
  EDGES_PER_NODE,
  type BenchSample,
} from './perf-graph-bench';

describe('perf-graph-bench helpers (#380 Phase 1)', () => {
  describe('neighbours', () => {
    it('returns at most EDGES_PER_NODE neighbours for any node', () => {
      for (const n of [10, 100, 500, 2000]) {
        for (const i of [0, Math.floor(n / 2), n - 1]) {
          expect(neighbours(i, n).length).toBeLessThanOrEqual(EDGES_PER_NODE);
        }
      }
    });

    it('never returns the source node as its own neighbour', () => {
      for (const n of [10, 100, 1000]) {
        for (let i = 0; i < n; i++) {
          expect(neighbours(i, n)).not.toContain(i);
        }
      }
    });

    it('produces unique neighbours per call', () => {
      const result = neighbours(50, 1000);
      expect(new Set(result).size).toBe(result.length);
    });

    it('wraps around so first/last nodes still get neighbours', () => {
      // Node 0 should still produce neighbours via the modular wrap
      // (offset -1 wraps to n-1) — otherwise the head of the graph would
      // be a sink.
      expect(neighbours(0, 100).length).toBeGreaterThan(0);
      expect(neighbours(99, 100).length).toBeGreaterThan(0);
    });

    it('includes a long-range hop (~sqrt(n)) so the graph is not just a ring', () => {
      // For n=2000, sqrt is ~44 — neighbours(0, 2000) should include
      // either 44 or, where collisions happen, a sibling. We just assert
      // that one of the neighbours is far away from i.
      const out = neighbours(0, 2000);
      const hasLongRange = out.some((j) => Math.min(j, 2000 - j) >= 10);
      expect(hasLongRange).toBe(true);
    });
  });

  describe('decide', () => {
    function sample(overrides: Partial<BenchSample>): BenchSample {
      return {
        size: 2000,
        pageCount: 2000,
        edgeCount: 5000,
        samplePageId: 1,
        timeToFirstPaintMs: 500,
        layoutConvergenceMs: 2000,
        fpsDuringInteraction: 60,
        jsHeapUsedMb: 100,
        ...overrides,
      };
    }

    it('says Phase 2 is NOT justified when 2000-node sample is healthy', () => {
      const verdict = decide([sample({ size: 2000 })]);
      expect(verdict.phase2Justified).toBe(false);
      expect(verdict.reasons).toEqual([]);
    });

    it('flags fps < 30 at 2000 nodes', () => {
      const verdict = decide([sample({ size: 2000, fpsDuringInteraction: 22 })]);
      expect(verdict.phase2Justified).toBe(true);
      expect(verdict.reasons.some((r) => r.includes('fps'))).toBe(true);
    });

    it('flags convergence > 5000 ms at 2000 nodes', () => {
      const verdict = decide([sample({ size: 2000, layoutConvergenceMs: 6500 })]);
      expect(verdict.phase2Justified).toBe(true);
      expect(verdict.reasons.some((r) => r.includes('convergence'))).toBe(true);
    });

    it('reports both reasons when both thresholds breach', () => {
      const verdict = decide([
        sample({ size: 2000, layoutConvergenceMs: 7000, fpsDuringInteraction: 18 }),
      ]);
      expect(verdict.phase2Justified).toBe(true);
      expect(verdict.reasons.length).toBe(2);
    });

    it('returns phase2Justified=false with an explanation when no 2000-node sample exists', () => {
      const verdict = decide([sample({ size: 1000 })]);
      expect(verdict.phase2Justified).toBe(false);
      expect(verdict.reasons[0]).toMatch(/2000-node/);
    });

    it('uses the 2000-node sample even when other sizes also breach', () => {
      // 5000 with bad fps must NOT trigger Phase 2 on its own — the
      // decision rule is anchored on the 2000 sample (issue #380).
      const verdict = decide([
        sample({ size: 1000, fpsDuringInteraction: 55 }),
        sample({ size: 2000, fpsDuringInteraction: 55, layoutConvergenceMs: 2500 }),
        sample({ size: 5000, fpsDuringInteraction: 12 }),
      ]);
      expect(verdict.phase2Justified).toBe(false);
    });
  });

  // ---- benchInitScriptBody single-shot guarantee ----
  // Playwright's addInitScript replays the script on every navigation,
  // and the prior bug shipped a fresh rAF wrapper layer on each replay.
  // The fix relies on a window-level `__benchInstalled` flag. These
  // tests pin that contract in a fake-DOM so a regression can't slip
  // through without the full Playwright lane catching it.
  describe('benchInitScriptBody single-shot guarantee', () => {
    function buildFakeWindow(): {
      rafCalls: Array<(t: number) => void>;
      windowProxy: Record<string, unknown>;
    } {
      const rafCalls: Array<(t: number) => void> = [];
      const baseRaf = (cb: (t: number) => void) => {
        rafCalls.push(cb);
        return rafCalls.length;
      };
      const ls = new Map<string, string>();
      const windowProxy: Record<string, unknown> = {
        requestAnimationFrame: baseRaf,
        localStorage: {
          setItem: (k: string, v: string) => ls.set(k, v),
          getItem: (k: string) => ls.get(k) ?? null,
        },
        performance: { now: () => 0 },
      };
      return { rafCalls, windowProxy };
    }

    function runScript(windowProxy: Record<string, unknown>) {
      // Simulate Playwright's evaluation: the script body sees the page
      // window as `window`. Bind a tiny shim so the function body's
      // `window` references resolve to our fake.
      const fn = new Function(
        'window',
        'localStorage',
        'performance',
        `(${benchInitScriptBody.toString()})({ token: 'tok' });`,
      );
      fn(windowProxy, windowProxy.localStorage, windowProxy.performance);
    }

    it('wraps requestAnimationFrame exactly once across multiple replays', () => {
      const { windowProxy } = buildFakeWindow();
      const original = windowProxy.requestAnimationFrame;

      // First replay (initial page load).
      runScript(windowProxy);
      const afterFirst = windowProxy.requestAnimationFrame;
      expect(afterFirst).not.toBe(original);
      expect(windowProxy.__benchInstalled).toBe(true);

      // Second replay (a goto in the same page lifetime).
      runScript(windowProxy);
      expect(windowProxy.requestAnimationFrame).toBe(afterFirst);

      // Third replay (next iteration of the size sweep).
      runScript(windowProxy);
      expect(windowProxy.requestAnimationFrame).toBe(afterFirst);
    });

    it('resets the rAF counter on every replay', () => {
      const { windowProxy } = buildFakeWindow();

      runScript(windowProxy);
      const bench1 = windowProxy.__bench as Record<string, number>;
      bench1.rafCount = 42;
      bench1.lastRaf = 9999;

      runScript(windowProxy);
      const bench2 = windowProxy.__bench as Record<string, number>;
      expect(bench2.rafCount).toBe(0);
      expect(bench2.lastRaf).toBe(0);
      expect(bench2.startedAt).toBe(0);
    });

    it('seeds the auth token into localStorage so the SPA boots authenticated', () => {
      const { windowProxy } = buildFakeWindow();
      runScript(windowProxy);

      const stored = (windowProxy.localStorage as { getItem: (k: string) => string | null }).getItem(
        'compendiq-auth',
      );
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.state.accessToken).toBe('tok');
      expect(parsed.state.isAuthenticated).toBe(true);
    });
  });
});
