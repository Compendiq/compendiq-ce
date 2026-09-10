import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runtime module-graph invariants for the backend image.
 *
 * npm workspaces can demote a backend production dependency into
 * `backend/node_modules/` (overlapping TipTap versions with the frontend
 * workspace are the live case). The process cwd is `/app` and ESM resolves
 * from `/app/dist`, so a copy to `./backend/node_modules` is invisible at
 * boot — the container crash-loops with ERR_MODULE_NOT_FOUND while the
 * image build still succeeds.
 *
 * The Docker workflow smoke step used to import only packages that happen
 * to hoist (`p-limit`, `ipaddr.js`, two OpenTelemetry packages). Those
 * stayed green on `dev` while `@tiptap/extension-code-block` (imported
 * from `collab-schema.js` on boot) was nested under starter-kit and
 * missing from the runtime tree.
 */

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(backendDir, '..');

const dockerfile = readFileSync(join(backendDir, 'Dockerfile'), 'utf8');
const dockerfileEnterprise = readFileSync(
  join(repoRoot, 'docker', 'Dockerfile.enterprise'),
  'utf8',
);
const dockerBuildWorkflow = readFileSync(
  join(repoRoot, '.github', 'workflows', 'docker-build.yml'),
  'utf8',
);

const DEMOTED_TREE_COPY =
  /COPY [^\n]*--from=prod-deps[^\n]*\/app\/backend\/node_modules\/\.[^\n]*\.\/node_modules\//;

function runtimeStage(text: string): string {
  const match = text.match(/AS runtime[\s\S]*$/);
  expect(match, 'runtime stage not found').not.toBeNull();
  return match![0];
}

function smokeStep(workflow: string): string {
  const match = workflow.match(
    /name:\s*Smoke-test runtime module resolution[\s\S]*?(?=\n {2}[a-z]|\njobs:|$)/,
  );
  expect(match, 'Smoke-test runtime module resolution step not found').not.toBeNull();
  return match![0];
}

describe('backend Dockerfile ships workspace-demoted prod deps', () => {
  it('creates backend/node_modules in prod-deps so the merge COPY cannot miss', () => {
    expect(dockerfile).toMatch(/mkdir -p backend\/node_modules/);
  });

  it('merges backend/node_modules onto the runtime /app/node_modules tree', () => {
    expect(runtimeStage(dockerfile)).toMatch(DEMOTED_TREE_COPY);
  });

  it('does not copy the demoted tree to ./backend/node_modules (unresolvable from /app/dist)', () => {
    expect(runtimeStage(dockerfile)).not.toMatch(
      /COPY [^\n]*--from=prod-deps[^\n]*backend\/node_modules[^\n]*\.\/backend\/node_modules/,
    );
  });
});

describe('enterprise Dockerfile ships workspace-demoted prod deps', () => {
  it('creates backend/node_modules in prod-deps so the merge COPY cannot miss', () => {
    expect(dockerfileEnterprise).toMatch(/mkdir -p backend\/node_modules/);
  });

  it('merges backend/node_modules onto the runtime /app/node_modules tree', () => {
    expect(runtimeStage(dockerfileEnterprise)).toMatch(DEMOTED_TREE_COPY);
  });
});

describe('Docker workflow smoke-test catches demoted collab TipTap packages', () => {
  it('imports collab-schema, not only historically-hoisted packages', () => {
    const smoke = smokeStep(dockerBuildWorkflow);
    expect(smoke).toMatch(/collab-schema/);
    expect(smoke).toMatch(/@tiptap\/extension-code-block/);
  });
});
