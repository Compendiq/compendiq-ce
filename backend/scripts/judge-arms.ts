/**
 * #1614 PR2 — the arm-blinded judgment sheet and the un-blinded verdict
 * (ADR-027 "Judging protocol", "Decision rule").
 *
 *   --merge   --answers artifacts/answers-A-1.jsonl,artifacts/answers-B-1.jsonl,artifacts/answers-C-1.jsonl
 *             --mappings artifacts/mapping-A-1.json,artifacts/mapping-B-1.json,artifacts/mapping-C-1.json
 *             --run-id sheet-1 --out-dir ./artifacts
 *             (every answers-<runId>.jsonl must have its provenance-<runId>.json beside it)
 *   --check   --answers artifacts/answers-sheet-1.jsonl --judgments artifacts/judgments-sheet-1.jsonl
 *             [--mapping artifacts/mapping-sheet-1.json]   ← the pilot ψ, aggregate only
 *   --unblind --run-id sheet-1 --out-dir ./artifacts --arm-report B=arm-B.json,C=arm-C.json
 *             [--control-b en-B.json,de-B.json --control-c en-C.json,de-C.json
 *              --control-legacy-c en-legacy.json,de-legacy.json]
 *             --out verdict-sheet-1.json
 *
 * The judge sees `answers-<id>.jsonl` and nothing else; `mapping-<id>.json`
 * and `sheet-<id>.json` (which recorded both files' sha256 before judging
 * started) stay with the operator. `--check` reports progress, says in one
 * line whether `--unblind` will refuse the sheet, and — where the operator's
 * `sheet-<id>.json` is in `--out-dir` — holds the judge's file to it; with
 * `--mapping` it also prints the ADR's pilot, ψ over the first 30
 * image-dependent A/B pairs in judgedAt order, so a run below 0.20 STOPS
 * there (exit code 3) rather than after 714 rows; it prints one aggregate
 * number and nothing per item. `--unblind` refuses a sheet whose answers file
 * no longer hashes to the merge's record or no longer re-derives from the
 * arms' own answers files, refuses until every item has exactly one judgment
 * by one judge, re-reads every answer run's provenance-<runId>.json from
 * --out-dir and holds it to its arm's retrieval report, then joins the
 * mapping, pairs the arms, runs McNemar exact and the page-cluster bootstrap,
 * applies the three-part rule and writes the verdict document — labelled
 * single-judge throughout, labelled REDUCED POWER when the sample is between
 * O2's hard floor and its pre-registered N (it still decides), and labelled
 * TOOLING VERIFICATION ONLY when the sample is below what O2 makes decidable
 * at all. No database is touched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertKnownFlags, flagValue, wantsHelp, JUDGE_KNOWN_FLAGS, JUDGE_USAGE, JUDGE_VALUELESS_FLAGS } from '../src/domains/llm/eval/cli-flags.js';
import { ARM_MARGINS, EVAL_ARMS, commandLine, parseArmRunReport, querySetSha, type ArmRunReport, type EvalArm } from '../src/domains/llm/eval/arms.js';
import { readAnswers, readMapping, runIdOfAnswersFile } from '../src/domains/llm/eval/answers.js';
import { loadImageFixture } from '../src/domains/llm/eval/fixture.js';
import {
  assertSheetIntegrity,
  buildArmVerdict,
  formatArmVerdict,
  judgmentProgress,
  mergeSheets,
  pilotCheck,
  readJudgments,
  readSheet,
  sheetPath,
  type TextGateControl,
} from '../src/domains/llm/eval/judgments.js';

const arg = (name: string): string | undefined => flagValue(process.argv, name);
const list = (name: string): string[] => (arg(name) ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
/** `--check --mapping` stops the judge: the pilot ψ is below the floor. */
const PILOT_STOP_EXIT_CODE = 3;

function readControls(name: string): TextGateControl[] | null {
  const files = list(name);
  if (files.length === 0) return null;
  return files.map((file) => {
    const json = JSON.parse(readFileSync(file, 'utf8')) as Partial<TextGateControl> & { axis?: string };
    if ((json.axis ?? 'text') !== 'text' || !Array.isArray(json.runs) || typeof json.model !== 'string') {
      throw new Error(`${file} is not a text-gate report (run-retrieval-eval.ts on the text gate, not the image corpus)`);
    }
    return {
      language: json.language ?? 'en',
      ftsLanguage: json.ftsLanguage ?? 'simple',
      corpusManifestSha: json.corpusManifestSha ?? '',
      model: json.model,
      // Recorded since #1619 wherever git could answer for the tree that
      // produced the report; `scoreLegacyRevisionControls` refuses a legacy
      // pair whose sides do not BOTH carry one and differ.
      ...(typeof json.revisionSha === 'string' ? { revisionSha: json.revisionSha } : {}),
      runs: json.runs,
    };
  });
}

function main(): void {
  if (wantsHelp(process.argv.slice(2))) {
    console.log(JUDGE_USAGE);
    return;
  }
  assertKnownFlags(process.argv.slice(2), JUDGE_KNOWN_FLAGS, JUDGE_USAGE, JUDGE_VALUELESS_FLAGS);
  const modes = (['merge', 'check', 'unblind'] as const).filter((m) => process.argv.includes(`--${m}`));
  if (modes.length !== 1) throw new Error(`exactly one of --merge, --check, --unblind (got ${modes.length})\n\n${JUDGE_USAGE}`);
  const mode = modes[0]!;
  const outDir = arg('out-dir') ?? '.';

  if (mode === 'merge') {
    const answers = list('answers');
    const mappings = list('mappings');
    const runId = arg('run-id');
    if (!runId || answers.length === 0 || answers.length !== mappings.length) {
      throw new Error('--merge needs --run-id, and --answers and --mappings of the same length, in the same order');
    }
    // Each run's provenance-<runId>.json sits beside its answers file under
    // the run id the writer named it with (`run-arm-answers.ts`); the sheet
    // records its hash and `--unblind` re-reads it.
    const provenance = mergeSheets(
      outDir,
      runId,
      answers.map((answersPath, i) => ({
        answersPath,
        mappingPath: mappings[i]!,
        provenancePath: join(dirname(answersPath), `provenance-${runIdOfAnswersFile(answersPath)}.json`),
      })),
      commandLine(),
    );
    console.log(`sheet ${runId}: ${provenance.items} items from ${provenance.sources.map((s) => `arm ${s.arm} (${s.items}, run ${s.runId})`).join(', ')}`);
    console.log(`answers sha256 ${provenance.answersSha256}`);
    console.log(`mapping sha256 ${provenance.mappingSha256} — recorded in sheet-${runId}.json before judging starts; keep the mapping away from the judge`);
    return;
  }

  if (mode === 'check') {
    const answersFile = list('answers')[0];
    const judgmentsFile = arg('judgments');
    if (!answersFile || !judgmentsFile) throw new Error('--check needs --answers <sheet> and --judgments <file>');
    const answers = readAnswers(answersFile);
    const judgments = readJudgments(judgmentsFile);
    const progress = judgmentProgress(answers, judgments);
    console.log(`${progress.judged}/${progress.total} items judged by ${progress.judges.join(', ') || 'nobody yet'}`);
    if (progress.duplicates.length > 0) console.log(`${progress.duplicates.length} items judged more than once: ${progress.duplicates.slice(0, 5).join(', ')}`);
    if (progress.unknown.length > 0) console.log(`${progress.unknown.length} judgments name items not on the sheet: ${progress.unknown.slice(0, 5).join(', ')}`);
    if (progress.judges.length > 1) console.log('WARNING: more than one judge signed rows — the protocol is one judge (O12); --unblind will refuse');
    // One line, and it says what `--unblind` will do. It used to report only
    // the missing count, so a sheet with a duplicate and an unknown judgment
    // printed "0 items still unjudged" two lines under the problems that
    // will refuse it (review r2 finding 10).
    const blockers = [
      ...(progress.missing.length > 0 ? [`${progress.missing.length} items still unjudged`] : []),
      ...(progress.duplicates.length > 0 ? [`${progress.duplicates.length} items judged more than once`] : []),
      ...(progress.unknown.length > 0 ? [`${progress.unknown.length} judgments name items not on the sheet`] : []),
      ...(progress.judges.length > 1 ? [`${progress.judges.length} judges signed rows (O12: one)`] : []),
    ];
    console.log(blockers.length === 0
      ? 'every item has exactly one judgment by one judge — --unblind may run'
      : `--unblind will REFUSE this sheet: ${blockers.join('; ')}`);
    // The judge's file is the one link nothing used to read back (review r2
    // finding 1). Where the operator's `sheet-<id>.json` is at hand, hold the
    // sheet to it here too, so a rewritten row is caught while judging is
    // still under way instead of at `--unblind` — and hold the file THIS
    // command just read its judgments against, `--answers`, not the out-dir
    // copy of the same name: vouching for a file it did not read reported a
    // tampered judge's copy as intact (review r3 finding 2).
    const sheetDir = arg('out-dir') ?? dirname(answersFile);
    const sheetRunId = runIdOfAnswersFile(answersFile);
    if (existsSync(sheetPath(sheetDir, sheetRunId))) {
      assertSheetIntegrity(sheetDir, sheetRunId, readSheet(sheetDir, sheetRunId), answersFile);
      console.log(`sheet integrity: ${answersFile} still hashes to sheet-${sheetRunId}.json and re-derives from every arm's own answers file in ${sheetDir}`);
    } else {
      console.log(`sheet integrity: not checked — sheet-${sheetRunId}.json is not in ${sheetDir} (pass --out-dir <artifacts>); --unblind checks it before it decides anything`);
    }
    // The pilot (ADR-027 "Sample size"): with the operator's mapping, ψ over
    // the first 30 image-dependent A/B pairs in judgedAt order — ONE
    // aggregate number, nothing per item, so the judge can stop below 0.20
    // before judging the rest. The pair is C/B, the one the #1619 amendment
    // registers (A-1): defaulted to A/B it could only report 0/30, because
    // arm A is unobtainable and no sheet will ever carry its answers.
    const mappingFile = arg('mapping');
    if (mappingFile) {
      const pilot = pilotCheck(answers, judgments, readMapping(mappingFile), loadImageFixture(), { baseline: 'C', candidate: 'B' });
      if (!pilot.evaluated) {
        console.log(`pilot: ${pilot.pairs}/${ARM_MARGINS.pilotPairs} image-dependent pairs judged on both C and B so far (ψ so far ${pilot.psi.toFixed(2)}) — keep judging; the pilot reads at ${ARM_MARGINS.pilotPairs}`);
      } else if (pilot.stop) {
        console.log(`PILOT STOP: ψ = ${pilot.psi.toFixed(2)} (${pilot.discordant}/${pilot.pairs} discordant) over the first ${pilot.pairs} judged pairs is below ${ARM_MARGINS.pilotDiscordanceFloor} — the pre-registered power calculation does not hold. Stop judging and report the run as inconclusive by design (ADR-027 "Sample size").`);
        process.exitCode = PILOT_STOP_EXIT_CODE;
      } else {
        console.log(`pilot: ψ = ${pilot.psi.toFixed(2)} (${pilot.discordant}/${pilot.pairs} discordant) over the first ${pilot.pairs} judged pairs ≥ ${ARM_MARGINS.pilotDiscordanceFloor} — continue`);
      }
    } else {
      console.log('pilot: pass --mapping <mapping-<sheet>.json> (the operator\'s file, never the judge\'s) to read ψ over the first 30 judged pairs');
    }
    return;
  }

  const runId = arg('run-id');
  const out = arg('out');
  if (!runId || !out) throw new Error('--unblind needs --run-id and --out');
  const armReports: Partial<Record<EvalArm, ArmRunReport>> = {};
  for (const entry of list('arm-report')) {
    const [armRaw, file] = entry.split('=');
    if (!armRaw || !file || !(EVAL_ARMS as readonly string[]).includes(armRaw)) {
      throw new Error(`--arm-report entries are <${EVAL_ARMS.join('|')}>=<file>, got "${entry}"`);
    }
    armReports[armRaw as EvalArm] = parseArmRunReport(JSON.parse(readFileSync(file, 'utf8')), file);
  }
  const controlLegacyC = readControls('control-legacy-c');
  const controlB = readControls('control-b');
  const controlC = readControls('control-c');
  if ((controlB === null) !== (controlC === null)) throw new Error('--control-b and --control-c come together or not at all');
  if (controlLegacyC !== null && controlC === null) {
    throw new Error('--control-legacy-c pairs the candidate C against the legacy revision\'s C and needs --control-c (and --control-b) beside it');
  }

  const report = buildArmVerdict({
    dir: outDir,
    runId,
    fixture: loadImageFixture(),
    querySetSha: querySetSha(),
    armReports,
    controls: controlB && controlC ? { legacyC: controlLegacyC, b: controlB, c: controlC } : null,
    allowUnderpowered: process.argv.includes('--allow-underpowered'),
    command: commandLine(),
    seed: 1614,
  });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const line of formatArmVerdict(report)) console.log(line);
  console.log(`wrote ${out}`);
  if (report.decision.verdict !== 'pass') process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
