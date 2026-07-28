import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Legibility floor for functional UI text.
 *
 * The July-2026 design critique measured 10px rendered text in 53 places —
 * page counts, source pills, and (worst) every settings-rail group label. It
 * was the one finding both the static scan and the live DOM measurement agreed
 * on, and it landed on structural navigation: the text a lost user needs most.
 *
 * The floor is 11px for incidental UI text and 12px for uppercase labels,
 * which lose additional legibility to letter-spacing and the absence of
 * ascender/descender cues.
 *
 * This walks source rather than computed styles on purpose: it fails on the
 * line that introduced the regression, in the file that owns it.
 */

const SRC = join(import.meta.dirname, '.');
const EXTENSIONS = ['.tsx', '.ts'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (EXTENSIONS.some((e) => entry.endsWith(e)) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

interface Offence {
  file: string;
  line: number;
  snippet: string;
}

function findOffences(predicate: (className: string) => boolean): Offence[] {
  const offences: Offence[] = [];
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (predicate(line)) {
        offences.push({
          file: file.slice(SRC.length + 1),
          line: i + 1,
          snippet: line.trim().slice(0, 100),
        });
      }
    });
  }
  return offences;
}

function format(offences: Offence[]): string {
  return offences.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`).join('\n');
}

describe('UI text legibility floor', () => {
  it('uses no arbitrary font size below 11px', () => {
    // Matches text-[10px], text-[9px], text-[8.5px], etc.
    const offences = findOffences((line) => {
      const matches = line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g);
      for (const m of matches) {
        if (Number(m[1]) < 11) return true;
      }
      return false;
    });

    expect(
      offences,
      `Functional UI text below the 11px legibility floor:\n${format(offences)}`,
    ).toEqual([]);
  });

  it('sets uppercase labels no smaller than 12px', () => {
    // Uppercase + letter-spacing costs legibility that lowercase does not,
    // so structural labels get an extra pixel over the general floor.
    const offences = findOffences((line) => {
      if (!line.includes('uppercase')) return false;
      const matches = line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g);
      for (const m of matches) {
        if (Number(m[1]) < 12) return true;
      }
      return false;
    });

    expect(
      offences,
      `Uppercase labels below the 12px floor:\n${format(offences)}`,
    ).toEqual([]);
  });
});
