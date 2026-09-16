/**
 * #1619 — the returned O15 labelling packet, checked and (with `--write`)
 * recorded in the fixture (ADR-027 O2/O3/O15).
 *
 *   npx tsx scripts/validate-label-packet.ts --file artifacts/label-packet.csv
 *   npx tsx scripts/validate-label-packet.ts --file artifacts/label-packet.csv --write
 *
 * Two kinds of finding, kept apart because they need different actions:
 *
 * - **Refusals** — the file is unusable: an unknown, duplicated or missing
 *   label id, a value outside `true|false` or the class list, a class without
 *   a `true`, a `true` without a class, a `true` on a label whose correct
 *   image answer is "none of them", or more than 5 image-dependent labels on
 *   one page. Nothing is written while one stands.
 * - **Shortfalls** — the file is fine and the SAMPLE is short: each one says
 *   how far, because a pass that is six labels from deciding and one that is
 *   sixty need different answers and "refused" tells them apart from neither.
 *
 * Whatever it finds, it then prints what `auditSample` — the same function
 * `judge-arms.ts --unblind` decides under — would make of these labels: full
 * power, REDUCED POWER, or a document that decides nothing. No database, no
 * model, no network.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  assertKnownFlags,
  flagValue,
  wantsHelp,
  VALIDATE_LABEL_PACKET_KNOWN_FLAGS,
  VALIDATE_LABEL_PACKET_USAGE,
  VALIDATE_LABEL_PACKET_VALUELESS_FLAGS,
} from '../src/domains/llm/eval/cli-flags.js';
import { ARM_SAMPLE } from '../src/domains/llm/eval/arms.js';
import { IMAGE_FIXTURE_PATH, loadImageFixture } from '../src/domains/llm/eval/fixture.js';
import { auditSample } from '../src/domains/llm/eval/judgments.js';
import {
  applyDecisions,
  controlQuerySets,
  parseDecisions,
  parseWrittenFixture,
  serializeFixture,
  validateDecisions,
} from '../src/domains/llm/eval/label-packet.js';

function main(): void {
  if (wantsHelp(process.argv.slice(2))) {
    console.log(VALIDATE_LABEL_PACKET_USAGE);
    return;
  }
  assertKnownFlags(
    process.argv.slice(2),
    VALIDATE_LABEL_PACKET_KNOWN_FLAGS,
    VALIDATE_LABEL_PACKET_USAGE,
    VALIDATE_LABEL_PACKET_VALUELESS_FLAGS,
  );

  const file = flagValue(process.argv, 'file');
  if (!file) throw new Error('--file <the returned packet, CSV or JSONL> is required');
  const fixturePath = flagValue(process.argv, 'fixture') ?? IMAGE_FIXTURE_PATH;
  const write = process.argv.includes('--write');

  const fixture = loadImageFixture(fixturePath);
  const parsed = parseDecisions(readFileSync(file, 'utf8'));
  const validation = validateDecisions(fixture, parsed.decisions, controlQuerySets(), parsed.labelIdsSeen);
  const problems = [...parsed.problems, ...validation.problems];

  console.log(`fixture: ${fixturePath} (${fixture.labels.length} labels)`);
  console.log(`returned: ${file} — ${validation.decided} decided, ${validation.undecided} open`);
  console.log(
    `image-dependent: ${validation.imageDependent} (O2: ${ARM_SAMPLE.imageDependent}, hard floor ` +
      `${ARM_SAMPLE.imageDependentFloor}) on ${validation.pages} pages (O2: >= ${ARM_SAMPLE.minPages}), at most ` +
      `${validation.maxLabelsPerPage} per page (O2/O3: <= ${ARM_SAMPLE.maxLabelsPerPage})`,
  );
  console.log(`  per class: ${Object.entries(validation.perClass).map(([c, n]) => `${c} ${n}`).join(', ')}`);
  console.log(
    `  per language: ${Object.entries(validation.perLanguage).map(([l, n]) => `${l} ${n}`).join(', ')} ` +
      '(O2: EN:DE ~ 1:2, approximate — reported, never refused)',
  );
  console.log(`image-negative: ${validation.imageNegative} (O2: ${ARM_SAMPLE.imageNegative})`);
  console.log(
    `controls: ${validation.controls.map((c) => `${c.language} ${c.file} ${c.queries}`).join(', ')} ` +
      `(O2: ${ARM_SAMPLE.controlPerLanguage} per language)`,
  );

  if (problems.length > 0) {
    console.error(`\nREFUSED — ${problems.length} problem(s) in the returned file:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nNothing was written. Fix these and run it again.');
    process.exitCode = 1;
    return;
  }

  // The audit is computed on the fixture these decisions WOULD produce, so a
  // dry run and a `--write` report the same verdict. `auditSample` takes no
  // control reports here: none exist before the arms are run, and the control
  // query sets are checked above against the fixtures those runs will pair.
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  const updated = applyDecisions(raw, parsed.decisions);
  const audit = auditSample(parseWrittenFixture(updated), []);

  if (write) {
    writeFileSync(fixturePath, serializeFixture(updated));
    console.log(`\nwritten: ${fixturePath} — ${validation.imageDependent} image-dependent labels recorded`);
  } else {
    console.log('\nnot written (no --write): this is what --write would record.');
  }

  if (validation.shortfalls.length > 0) {
    console.error(`\nO2 is not met — ${validation.shortfalls.length} shortfall(s), each with the distance left:`);
    for (const shortfall of validation.shortfalls) console.error(`  - ${shortfall}`);
  }
  if (validation.reducedPower) console.log(`\nREDUCED POWER: ${validation.reducedPower}`);

  console.log(`\nauditSample: ${audit.powerMode}`);
  if (audit.powerNote) console.log(`  ${audit.powerNote}`);
  for (const shortfall of audit.shortfalls) console.log(`  - ${shortfall}`);
  if (audit.primaryPower !== null) {
    console.log(`  power ~ ${audit.primaryPower.toFixed(3)} against the pre-registered ~ ${audit.targetPower.toFixed(3)}`);
  }

  if (audit.powerMode === 'undecidable' || validation.shortfalls.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
