import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * #1347 — the domain-boundary rule (`eslint-plugin-boundaries`) was inert
 * for every file directly inside `src/routes/<domain>/`.
 *
 * `boundaries/elements` patterned each route element as `src/routes/<x>/*`
 * with `mode: 'folder'`, which classifies a SUBFOLDER of that directory —
 * not files sitting directly in it. Every route file lives directly in
 * `src/routes/<x>/` (there are zero nested route files), so none of them
 * ever matched an element, `boundaries/dependencies` never applied to them,
 * and `routes/foundation` importing from `domains/llm` (or any other
 * disallowed domain) passed `npm run lint` clean.
 *
 * This guard lints synthetic probe SOURCE via ESLint's Node API — it never
 * writes a file to disk (`lintText` + a virtual `filePath`) — and pins both
 * directions: a probe that should be rejected must report
 * `boundaries/dependencies`, and a probe that is legitimately allowed must
 * report nothing. The probe paths sit directly in `src/routes/<x>/`
 * (never a nested subfolder) because a nested path already passed under the
 * pre-fix config and would pin nothing.
 *
 * Precedents for a config-reading guard test: `docker-compose-invariants.test.ts`,
 * `core/services/attachment-store.test.ts`.
 */

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function ruleMessages(results: ESLint.LintResult[], ruleId: string): string[] {
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === ruleId)
    .map((m) => m.message);
}

async function lintProbe(filePath: string, source: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({
    cwd: backendDir,
    overrideConfigFile: 'eslint.config.js',
  });
  return eslint.lintText(source, { filePath });
}

describe('eslint boundaries — routes elements fire (#1347)', () => {
  // Sanity: fail loudly (not silently, e.g. via a typo) if the plugin/rule
  // configuration this suite exercises goes missing entirely.
  beforeAll(async () => {
    const eslint = new ESLint({ cwd: backendDir, overrideConfigFile: 'eslint.config.js' });
    const config = await eslint.calculateConfigForFile('src/routes/foundation/probe.ts');
    expect(config.rules?.['boundaries/dependencies']).toBeTruthy();
  });

  // Import specifiers must resolve to a REAL file on disk: `boundaries/dependencies`
  // classifies the import's target only after the resolver has found it, so a
  // fictitious specifier (e.g. `.../some-service.js` that does not exist) never
  // gets an element type and the rule silently reports nothing regardless of the
  // config under test — that would pin nothing. Each probe below imports an
  // actual, already-exported symbol from a real module in the target domain.

  it('(a) routes-foundation -> domains/knowledge reports boundaries/dependencies', async () => {
    const results = await lintProbe(
      'src/routes/foundation/__probe.ts',
      "import { ALLOWED_TAGS } from '../../domains/knowledge/services/auto-tagger.js';\nexport const probe = ALLOWED_TAGS;\n",
    );
    expect(ruleMessages(results, 'boundaries/dependencies').length).toBeGreaterThan(0);
  });

  it('(b) routes-confluence -> domains/llm reports boundaries/dependencies', async () => {
    const results = await lintProbe(
      'src/routes/confluence/__probe.ts',
      "import { SHADOW_JOB_QUEUE } from '../../domains/llm/services/shadow-migration-service.js';\nexport const probe = SHADOW_JOB_QUEUE;\n",
    );
    expect(ruleMessages(results, 'boundaries/dependencies').length).toBeGreaterThan(0);
  });

  it('(c) core -> domains/llm reports boundaries/dependencies', async () => {
    const results = await lintProbe(
      'src/core/services/__probe.ts',
      "import { SHADOW_JOB_QUEUE } from '../../domains/llm/services/shadow-migration-service.js';\nexport const probe = SHADOW_JOB_QUEUE;\n",
    );
    expect(ruleMessages(results, 'boundaries/dependencies').length).toBeGreaterThan(0);
  });

  it('(d) allowed imports report nothing: routes-foundation -> core, and routes-foundation -> domains/llm', async () => {
    const toCore = await lintProbe(
      'src/routes/foundation/__probe_core.ts',
      "import { RAG_FETCH_WIDTH_DEFAULT } from '../../core/services/admin-settings-service.js';\nexport const probe = RAG_FETCH_WIDTH_DEFAULT;\n",
    );
    expect(ruleMessages(toCore, 'boundaries/dependencies')).toEqual([]);

    // Widened by the #1347 ruling: routes-foundation genuinely needs
    // provider health / list-models / queue knobs / the confidence resolver.
    const toLlm = await lintProbe(
      'src/routes/foundation/__probe_llm.ts',
      "import { SHADOW_JOB_QUEUE } from '../../domains/llm/services/shadow-migration-service.js';\nexport const probe = SHADOW_JOB_QUEUE;\n",
    );
    expect(ruleMessages(toLlm, 'boundaries/dependencies')).toEqual([]);
  });

  it('(e) a file outside the element map reports boundaries/no-unknown-files', async () => {
    const results = await lintProbe('src/__stray.ts', 'export const probe = 1;\n');
    expect(ruleMessages(results, 'boundaries/no-unknown-files').length).toBeGreaterThan(0);
  });
});
