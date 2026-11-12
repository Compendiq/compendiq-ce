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

// The backend job passes its smoke script to the reusable docker-image.yml
// as the `smoke_test` input; capture that block up to the next job key.
function smokeStep(workflow: string): string {
  const match = workflow.match(/\n\s+smoke_test:\s*\|[\s\S]*?(?=\n {2}[a-z]|$)/);
  expect(match, 'backend smoke_test input not found').not.toBeNull();
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

describe('backend image provisions ATTACHMENTS_DIR for the node user', () => {
  it('creates /opt/app/data/attachments in the CE image so a named volume copies a writable tree', () => {
    expect(dockerfile).toMatch(/mkdir -p \/opt\/app\/data\/attachments/);
  });

  it('creates /app/data/attachments in the enterprise image', () => {
    expect(dockerfileEnterprise).toMatch(/mkdir -p \/app\/data\/attachments/);
  });
});

describe('backend images ship the PDF export fonts (#1729)', () => {
  // pdf-fonts.ts reads dist/core/services/fonts; tsc emits no assets, so the backend build copies
  // them. Every image that copies a built backend dist then has them — no Dockerfile COPY to forget.
  const backendPackage: { scripts: { build: string } } = JSON.parse(readFileSync(join(backendDir, 'package.json'), 'utf8'));

  it('copies the vendored fonts into dist when the backend builds', () => {
    expect(backendPackage.scripts.build).toMatch(
      /^tsc -p tsconfig\.build\.json && .*cpSync\('src\/core\/services\/fonts','dist\/core\/services\/fonts',\{recursive:true\}\)/,
    );
  });

  it('builds the CE backend with that script and ships its whole dist', () => {
    const builder = dockerfile.slice(0, dockerfile.indexOf('AS prod-deps'));
    expect(builder.indexOf('COPY backend/src/ backend/src/')).toBeLessThan(builder.indexOf('RUN npm run build -w backend'));
    expect(runtimeStage(dockerfile)).toMatch(/COPY [^\n]*--from=builder \/app\/backend\/dist\/ dist\//);
  });

  it('builds the enterprise backend with that script and ships a dist', () => {
    // Loose on purpose: the private overlay replaces this file in EE builds and may spell it differently.
    expect(dockerfileEnterprise).toMatch(/RUN npm run build -w backend/);
    expect(runtimeStage(dockerfileEnterprise)).toMatch(/COPY [^\n]*dist\/ (\/app\/)?dist\//);
  });
});
