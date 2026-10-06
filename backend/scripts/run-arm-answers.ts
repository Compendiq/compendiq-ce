/**
 * #1614 PR2 — per-arm answer generation for ADR-027's judged endpoints.
 *
 *   --arm C --run-id C-2026-09-15 --out-dir ./artifacts --report retrieval-eval-arm-C.json
 *
 * Runs on the SAME disposable database the arm's retrieval run seeded
 * (`run-retrieval-eval.ts --images --arm X`): the pages, the index state and
 * the assignments are that arm's, so what this script measures is what the
 * ask route does with them. It builds the real app (`buildApp()`), signs a
 * token for the eval user, and injects `POST /api/llm/ask` per fixture label
 * with `rag_answer_max_images = 0` written to admin_settings for the run,
 * `deepSearch: false` and no conversation — the answer model is text-only by
 * construction in every arm (ADR-027 O10), at the provider's default
 * temperature (the ask path exposes none; recorded, not set).
 *
 * It writes answers-<id>.jsonl (arm-blinded — see eval/answers.ts),
 * mapping-<id>.json and provenance-<id>.json (both files' sha256, the
 * configuration, the revision of a CLEAN checkout, the command line, and
 * the route's refusal reasons as counts — never on a judged row). A
 * `semantic_index_unavailable` refusal is an outage, not the protocol's
 * refusal: the run aborts on the first one and writes nothing (exit ≠ 0).
 * The chat model is REAL: a mocked one can only verify this tooling and
 * produces no number anyone may quote.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { closePool, closeVectorPool, query, runMigrations } from '../src/core/db/postgres.js';
import { generateAccessToken } from '../src/core/plugins/auth.js';
import { invalidateRagAnswerMaxImagesCache } from '../src/core/services/admin-settings-service.js';
import { assertKnownFlags, flagValue, wantsHelp, ARM_ANSWERS_KNOWN_FLAGS, ARM_ANSWERS_USAGE, ARM_ANSWERS_VALUELESS_FLAGS } from '../src/domains/llm/eval/cli-flags.js';
import { assertDisposableDatabase } from '../src/domains/llm/eval/disposable-db.js';
import { EVAL_ARMS, commandLine, parseArmRunReport, querySetSha, readHeldFixedProvenance, readRevisionSha, type EvalArm } from '../src/domains/llm/eval/arms.js';
import { askThroughRoute, generateArmAnswers, writeAnswerArtifacts, writeAnswerProvenance, type AnswerRunProvenance } from '../src/domains/llm/eval/answers.js';
import { loadImageFixture } from '../src/domains/llm/eval/fixture.js';
import { EVAL_USER_ID } from '../src/domains/llm/eval/seed.js';
import { flushSearchAnalytics } from '../src/domains/llm/services/rag-service.js';

const arg = (name: string): string | undefined => flagValue(process.argv, name);

async function main(): Promise<void> {
  if (wantsHelp(process.argv.slice(2))) {
    console.log(ARM_ANSWERS_USAGE);
    return;
  }
  assertKnownFlags(process.argv.slice(2), ARM_ANSWERS_KNOWN_FLAGS, ARM_ANSWERS_USAGE, ARM_ANSWERS_VALUELESS_FLAGS);

  const armRaw = arg('arm');
  if (!armRaw || !(EVAL_ARMS as readonly string[]).includes(armRaw)) {
    throw new Error(`--arm must be one of ${EVAL_ARMS.join('|')} — the mapping records it; the answers file never does`);
  }
  const arm = armRaw as EvalArm;
  const runId = arg('run-id') ?? `${arm}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`--run-id "${runId}" must be a file-name-safe token`);
  const outDir = arg('out-dir') ?? '.';
  const reportPath = arg('report');
  const hardware = process.env.EVAL_HARDWARE?.trim() || null;
  if (!hardware) console.log('NOTE: EVAL_HARDWARE is unset — provenance records hardware: null (O9).');

  assertDisposableDatabase(process.env.POSTGRES_URL ?? '', { what: 'run-arm-answers.ts writes admin_settings.rag_answer_max_images and asks every fixture question through the real route on this database' });
  if (!process.env.REDIS_URL || !process.env.JWT_SECRET) {
    throw new Error('REDIS_URL and JWT_SECRET are required — the answers come out of the real app (buildApp), which needs both');
  }

  const sha = readRevisionSha();
  const fixture = loadImageFixture();
  const querySha = querySetSha();

  // The retrieval report of the same arm on the same database, when given:
  // the answers are only that arm's if they were made in that arm's state.
  if (reportPath) {
    const report = parseArmRunReport(JSON.parse(readFileSync(reportPath, 'utf8')), reportPath);
    const problems: string[] = [];
    if (report.arm !== arm) problems.push(`report is arm ${report.arm}, this run is --arm ${arm}`);
    if (report.revisionSha !== sha) problems.push(`report revision ${report.revisionSha}, this checkout ${sha}`);
    if (report.corpusManifestSha !== fixture.corpusManifestSha) problems.push('corpus manifest sha differs');
    if (report.querySetSha !== querySha) problems.push('query-set sha differs');
    if (problems.length > 0) throw new Error(`--report does not describe this run: ${problems.join('; ')}`);
  }

  await runMigrations();
  // rag_answer_max_images = 0 in EVERY arm (ADR-027 O10): no image byte
  // reaches the chat model, so the endpoint measures text-only grounding.
  // Written to the run's database and the reader's cache dropped, so the
  // first request already sees it.
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ('rag_answer_max_images', '0', NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = '0', updated_at = NOW()`,
  );
  invalidateRagAnswerMaxImagesCache();
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1::uuid, 'eval-runner', 'eval@local', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
    [EVAL_USER_ID],
  );

  const held = await readHeldFixedProvenance();
  if (!held.answerModel) {
    throw new Error('No `chat` assignment resolves on this database — the answer model is the production chat assignment at freeze time (O10); assign it in Settings → AI Models on this eval DB');
  }
  if (held.retrieval.rag_answer_max_images !== 0) {
    throw new Error(`rag_answer_max_images reads ${held.retrieval.rag_answer_max_images} after being written as 0 — refusing to generate answers the chat model could see images for`);
  }

  const app = await buildApp();
  await app.ready();
  try {
    const token = await generateAccessToken({ sub: EVAL_USER_ID, username: 'eval-runner', role: 'admin' });
    console.log(`arm ${arm} · run ${runId} · ${fixture.labels.length} questions · answer model ${held.answerModel.identity} · revision ${sha}`);
    const generated = await generateArmAnswers(askThroughRoute(app, token), fixture, {
      arm,
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) console.log(`  answered ${done}/${total}`);
      },
    });
    mkdirSync(outDir, { recursive: true });
    const written = writeAnswerArtifacts(outDir, runId, generated);
    const provenance: AnswerRunProvenance = {
      runId,
      arm,
      revisionSha: sha,
      command: commandLine(),
      capturedAt: new Date().toISOString(),
      hardware,
      corpusManifestSha: fixture.corpusManifestSha,
      querySetSha: querySha,
      answerModel: held.answerModel,
      temperature: 'provider default',
      ragAnswerMaxImages: 0,
      deepSearch: false,
      retrieval: held.retrieval,
      items: generated.answers.length,
      refused: generated.refused,
      refusalReasons: generated.refusalReasons,
      answersSha256: written.answersSha256,
      mappingSha256: written.mappingSha256,
    };
    const provenanceFile = writeAnswerProvenance(outDir, runId, provenance);
    console.log(`wrote ${written.answersPath} (sha256 ${written.answersSha256})`);
    console.log(`wrote ${written.mappingPath} (sha256 ${written.mappingSha256}) — keep it away from the judge`);
    console.log(`wrote ${provenanceFile} · ${generated.refused}/${generated.answers.length} refused${generated.refused > 0 ? ` (${Object.entries(generated.refusalReasons).map(([r, n]) => `${r}: ${n}`).join(', ')})` : ''}`);
  } finally {
    await app.close();
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await flushSearchAnalytics().catch(() => {});
    await closeVectorPool().catch(() => {});
    await closePool();
  });
