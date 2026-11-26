import { describe, expect, it } from 'vitest';
import { PageWriterQuiesceBlockedSchema } from './page-write-recovery.js';

const body = {
  error: 'PageWriteError',
  reason: 'runtime_quiesce_blocked_by_collab_commit',
  code: 'runtime_quiesce_blocked_by_collab_commit',
  message: 'Terminate the process and fence it with verified_local_termination.',
  blockingIntents: [
    { intentId: '0b5f7c1e-6f2d-4c39-9a0e-2a7f1b3c4d5e', kind: 'collab.commit.confluence.media', pageIds: [42] },
  ],
  runbook: 'docs/runbooks/immutable-page-baselines.md',
};

describe('quiescence blocked by its own collaborative Save (#1934)', () => {
  it('accepts ids and kinds only', () => {
    expect(PageWriterQuiesceBlockedSchema.parse(body)).toEqual(body);
  });

  it('refuses an effect descriptor, actor or other kind instead of disclosing it', () => {
    const intent = body.blockingIntents[0]!;
    for (const leaked of [
      { ...body, blockingIntents: [{ ...intent, effect: { confluenceId: 'cf-1' } }] },
      { ...body, blockingIntents: [{ ...intent, actorId: '0b5f7c1e-6f2d-4c39-9a0e-2a7f1b3c4d5f' }] },
      { ...body, blockingIntents: [{ ...intent, kind: 'page.labels' }] },
      { ...body, runtimeId: 'runtime-1' },
      { ...body, blockingIntents: [] },
    ]) {
      expect(() => PageWriterQuiesceBlockedSchema.parse(leaked)).toThrow();
    }
  });
});
