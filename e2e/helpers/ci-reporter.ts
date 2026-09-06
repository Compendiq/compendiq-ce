import { appendFile } from 'node:fs/promises';
import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';

/** The CI selection excludes external integrations before discovery, never by skip. */
export default class CiReporter implements Reporter {
  private suite?: Suite;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] }> {
    let executed = 0;
    let skipped = 0;
    for (const test of this.suite?.allTests() ?? []) {
      // Count tests, not retry attempts. Dependency-blocked and never-started
      // tests also cannot provide evidence that the selected suite ran.
      const lastResult = test.results.at(-1);
      if (!lastResult || lastResult.status === 'skipped') skipped += 1;
      else executed += 1;
    }

    const invalidSelection = executed === 0 || skipped > 0;
    let status = result.status === 'passed' && invalidSelection ? 'failed' as const : result.status;
    const summary = `## Playwright E2E\n\nExecuted: ${executed}\n\nSkipped: ${skipped}\n\nStatus: ${status}\n`;
    console.log(summary);
    if (invalidSelection) {
      console.error('E2E CI requires at least one executed test and zero skipped tests in the selected suite.');
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      } catch (error) {
        console.error('Could not write the E2E step summary:', error);
        if (status === 'passed') status = 'failed';
      }
    }
    return { status };
  }
}
