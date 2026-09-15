/**
 * #1614 PR2 — the arm-blinded judgment sheet and the un-blinded verdict
 * (ADR-027 "Judging protocol", "Decision rule").
 *
 *   --merge   --answers answers-A.jsonl,answers-B.jsonl,answers-C.jsonl
 *             --mappings mapping-A.json,mapping-B.json,mapping-C.json --run-id sheet-1 --out-dir ./artifacts
 *   --check   --answers artifacts/answers-sheet-1.jsonl --judgments artifacts/judgments-sheet-1.jsonl
 *   --unblind --run-id sheet-1 --out-dir ./artifacts --arm-report A=arm-A.json,B=arm-B.json,C=arm-C.json
 *             [--control-b en-B.json,de-B.json --control-c en-C.json,de-C.json] --out verdict-sheet-1.json
 *
 * The judge sees `answers-<id>.jsonl` and nothing else; `mapping-<id>.json`
 * and `sheet-<id>.json` (which recorded its sha256 before judging started)
 * stay with the operator. `--unblind` refuses until every item has exactly
 * one judgment by one judge, then joins the mapping, pairs the arms, runs
 * McNemar exact and the page-cluster bootstrap, applies the three-part rule
 * and writes the verdict document — labelled single-judge throughout, and
 * labelled TOOLING VERIFICATION ONLY when the sample is below O2's counts.
 * No database is touched.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { assertKnownFlags, flagValue, wantsHelp, JUDGE_KNOWN_FLAGS, JUDGE_USAGE, JUDGE_VALUELESS_FLAGS } from '../src/domains/llm/eval/cli-flags.js';
import { EVAL_ARMS, parseArmRunReport, querySetSha, type ArmRunReport, type EvalArm } from '../src/domains/llm/eval/arms.js';
import { readAnswers } from '../src/domains/llm/eval/answers.js';
import { loadImageFixture } from '../src/domains/llm/eval/fixture.js';
import {
  buildArmVerdict,
  formatArmVerdict,
  judgmentProgress,
  mergeSheets,
  readJudgments,
  type TextGateControl,
} from '../src/domains/llm/eval/judgments.js';

const arg = (name: string): string | undefined => flagValue(process.argv, name);
const list = (name: string): string[] => (arg(name) ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);

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
    const provenance = mergeSheets(
      outDir,
      runId,
      answers.map((answersPath, i) => ({ runId: answersPath, answersPath, mappingPath: mappings[i]! })),
    );
    console.log(`sheet ${runId}: ${provenance.items} items from ${provenance.sources.map((s) => `arm ${s.arm} (${s.items})`).join(', ')}`);
    console.log(`answers sha256 ${provenance.answersSha256}`);
    console.log(`mapping sha256 ${provenance.mappingSha256} — recorded in sheet-${runId}.json before judging starts; keep the mapping away from the judge`);
    return;
  }

  if (mode === 'check') {
    const answersFile = list('answers')[0];
    const judgmentsFile = arg('judgments');
    if (!answersFile || !judgmentsFile) throw new Error('--check needs --answers <sheet> and --judgments <file>');
    const progress = judgmentProgress(readAnswers(answersFile), readJudgments(judgmentsFile));
    console.log(`${progress.judged}/${progress.total} items judged by ${progress.judges.join(', ') || 'nobody yet'}`);
    if (progress.duplicates.length > 0) console.log(`${progress.duplicates.length} items judged more than once: ${progress.duplicates.slice(0, 5).join(', ')}`);
    if (progress.unknown.length > 0) console.log(`${progress.unknown.length} judgments name items not on the sheet: ${progress.unknown.slice(0, 5).join(', ')}`);
    if (progress.judges.length > 1) console.log('WARNING: more than one judge signed rows — the protocol is one judge (O12); --unblind will refuse');
    console.log(progress.missing.length === 0 && progress.duplicates.length === 0 && progress.unknown.length === 0
      ? 'every item has exactly one judgment — --unblind may run'
      : `${progress.missing.length} items still unjudged`);
    return;
  }

  const runId = arg('run-id');
  const out = arg('out');
  if (!runId || !out) throw new Error('--unblind needs --run-id and --out');
  const armReports: Partial<Record<EvalArm, ArmRunReport>> = {};
  for (const entry of list('arm-report')) {
    const [armRaw, file] = entry.split('=');
    if (!armRaw || !file || !(EVAL_ARMS as readonly string[]).includes(armRaw)) {
      throw new Error(`--arm-report entries are <A|B|C>=<file>, got "${entry}"`);
    }
    armReports[armRaw as EvalArm] = parseArmRunReport(JSON.parse(readFileSync(file, 'utf8')), file);
  }
  const controlB = readControls('control-b');
  const controlC = readControls('control-c');
  if ((controlB === null) !== (controlC === null)) throw new Error('--control-b and --control-c come together or not at all');

  const report = buildArmVerdict({
    dir: outDir,
    runId,
    fixture: loadImageFixture(),
    querySetSha: querySetSha(),
    armReports,
    controls: controlB && controlC ? { b: controlB, c: controlC } : null,
    allowUnderpowered: process.argv.includes('--allow-underpowered'),
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
