import { afterEach, describe, expect, it } from 'vitest';
import { assertDisposableDatabase } from './disposable-db.js';

// The guard used to live inside run-retrieval-eval.ts behind its main() call,
// so importing it ran a destructive eval. #1114's latency benchmark needs the
// same protection, and a second copy of a refusal rule is how the two drift.

const ORIGINAL = process.env.EVAL_ALLOW_DESTRUCTIVE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EVAL_ALLOW_DESTRUCTIVE;
  else process.env.EVAL_ALLOW_DESTRUCTIVE = ORIGINAL;
});

describe('assertDisposableDatabase', () => {
  it('admits a database whose name looks disposable', () => {
    for (const name of ['kb_eval', 'kb_creator_test', 'scratch', 'sandbox-1']) {
      expect(() => assertDisposableDatabase(`postgresql://u:p@localhost:5433/${name}`)).not.toThrow();
    }
  });

  it('refuses a name that does not look disposable', () => {
    expect(() => assertDisposableDatabase('postgresql://u:p@localhost:5432/compendiq')).toThrow(/does not look disposable/);
  });

  it('refuses a production word even when a disposable word is also present', () => {
    // Widening the allow-list to a substring admits `production_eval`; the
    // production words therefore win over the allow-list.
    expect(() => assertDisposableDatabase('postgresql://u:p@h/production_eval')).toThrow(/does not look disposable/);
    expect(() => assertDisposableDatabase('postgresql://u:p@h/staging_test')).toThrow(/does not look disposable/);
  });

  it('refuses a URL it cannot parse rather than assuming it is safe', () => {
    expect(() => assertDisposableDatabase('')).toThrow(/not a valid URL/);
  });

  it('honours the explicit override, which is what a restored copy needs', () => {
    process.env.EVAL_ALLOW_DESTRUCTIVE = 'yes-wipe-this-database';
    expect(() => assertDisposableDatabase('postgresql://u:p@h/compendiq')).not.toThrow();
  });

  // #1114 review r2 — the guard is shared by a destructive script and a
  // read-only one, and the message described only the destructive one. An
  // operator pointing the LATENCY BENCHMARK at the wrong database was told it
  // truncates tables and retypes columns, which it never does; the sentence
  // that follows then invites EVAL_ALLOW_DESTRUCTIVE, a far bigger commitment
  // than a timing run needs, in a shell they may reuse for the real eval.
  it('describes what the CALLING script does, not what the eval rig does', () => {
    const readOnly = () => assertDisposableDatabase('postgresql://u:p@h/compendiq', {
      what: 'The latency benchmark only READS a seeded corpus.',
    });
    expect(readOnly).toThrow(/does not look disposable/);
    expect(readOnly).toThrow(/only READS a seeded corpus/);
    expect(readOnly).not.toThrow(/TRUNCATES/);
    expect(readOnly).not.toThrow(/RETYPES/);
  });

  it('still names the destructive behaviour by default — the eval rig is the common caller', () => {
    expect(() => assertDisposableDatabase('postgresql://u:p@h/compendiq')).toThrow(/TRUNCATES/);
    expect(() => assertDisposableDatabase('postgresql://u:p@h/compendiq')).toThrow(/RETYPES/);
  });
});
