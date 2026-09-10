import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CiReporter from './ci-reporter';

function runReport(attempts: TestResult['status'][][], status: FullResult['status'] = 'passed') {
  const reporter = new CiReporter();
  const tests = attempts.map(results => ({
    results: results.map(attempt => ({ status: attempt })),
  }) as TestCase);
  reporter.onBegin({} as FullConfig, { allTests: () => tests } as Suite);
  return reporter.onEnd({ status, startTime: new Date(0), duration: 0 });
}

describe('strict CI execution evidence', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fails an empty selection', async () => {
    expect(await runReport([])).toEqual({ status: 'failed' });
  });

  it('fails an all-skipped selection', async () => {
    expect(await runReport([['skipped'], ['skipped']])).toEqual({ status: 'failed' });
  });

  it('does not let passing tests conceal a conditional skip', async () => {
    expect(await runReport([['passed'], ['skipped']])).toEqual({ status: 'failed' });
  });

  it('fails a selected test with no result, including a blocked dependency', async () => {
    expect(await runReport([['passed'], []])).toEqual({ status: 'failed' });
  });

  it('accepts a fully executed passing selection', async () => {
    expect(await runReport([['passed'], ['passed']])).toEqual({ status: 'passed' });
  });

  it.each(['failed', 'timedout', 'interrupted'] as const)('preserves the original %s result', async status => {
    expect(await runReport([['passed']], status)).toEqual({ status });
  });

  it('reports unique executed tests rather than retry attempts to stdout and the step summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ci-reporter-'));
    try {
      const summaryPath = join(directory, 'summary');
      vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);
      expect(await runReport([['failed', 'passed'], ['skipped']])).toEqual({ status: 'failed' });
      const summary = await readFile(summaryPath, 'utf8');
      expect(summary).toMatch(/Executed:\s*1\b/);
      expect(summary).toMatch(/Skipped:\s*1\b/);
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/Executed:\s*1\b[\s\S]*Skipped:\s*1\b/));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
