/**
 * Schema ratchet for the collab Y.Doc (#1445 / Decision K).
 *
 * Fails if Editor.tsx / article-extensions / comment-extension gain a
 * node or mark the server schema omits, or if content / atom / isolating /
 * defining / attr names drift. CommentMark is required. pngDataUri is not.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { generateJSON } from '@tiptap/html';
import { collabExtensions, getCollabSchema, htmlToYDoc, yDocToHtml } from './collab-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');
const articleDir = join(repoRoot, 'frontend/src/shared/components/article');

const EDITOR_ONLY_EXTENSION_NAMES = new Set([
  'placeholder',
  'searchAndReplace',
  'blockShortcuts',
  'slashCommand',
  'inlineCompletion',
  'vim',
  'dropcursor',
  'gapcursor',
  'undoRedo',
  'dropCursor',
  'gapCursor',
]);

type Spec = {
  name: string;
  content: string | null;
  atom: boolean;
  isolating: boolean;
  defining: boolean;
  attrs: string[];
  kind: 'node' | 'mark';
};

function braceEnd(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function attrKeysFromAddAttributes(block: string): string[] {
  const idx = block.search(/addAttributes\s*\(\s*\)\s*\{/);
  if (idx < 0) return [];
  const ret = block.indexOf('return', idx);
  if (ret < 0) return [];
  const open = block.indexOf('{', ret);
  if (open < 0) return [];
  const close = braceEnd(block, open);
  if (close < 0) return [];
  const body = block.slice(open + 1, close);
  const keys: string[] = [];
  let depth = 0;
  // Top-level keys only — nested renderHTML objects must not count as attrs.
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) {
      const slice = body.slice(i);
      const km = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w-]*))\s*:/.exec(slice);
      if (km) {
        const key = km[1] ?? km[2] ?? km[3];
        if (key) keys.push(key);
        i += km[0].length;
        continue;
      }
    }
    i += 1;
  }
  return [...new Set(keys)];
}

function parseCreateBlocks(src: string): Spec[] {
  const specs: Spec[] = [];
  const re = /(Node|Mark)\.create(?:<[^>]+>)?\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    const close = braceEnd(src, open);
    if (close < 0) continue;
    const block = src.slice(open, close + 1);
    const name = block.match(/\bname:\s*'([^']+)'/)?.[1];
    if (!name) continue;
    specs.push({
      name,
      content: block.match(/\bcontent:\s*'([^']+)'/)?.[1] ?? null,
      atom: /\batom:\s*true\b/.test(block),
      isolating: /\bisolating:\s*true\b/.test(block),
      defining: /\bdefining:\s*true\b/.test(block),
      attrs: attrKeysFromAddAttributes(block),
      kind: m[1] === 'Mark' ? 'mark' : 'node',
    });
  }
  return specs;
}

function parseNamedExtend(src: string, extendOf: string, name: string, kind: 'node' | 'mark'): Spec | null {
  const re = new RegExp(`${extendOf}\\.extend\\(\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  const close = braceEnd(src, open);
  if (close < 0) return null;
  const block = src.slice(open, close + 1);
  return {
    name,
    content: block.match(/\bcontent:\s*'([^']+)'/)?.[1] ?? null,
    atom: /\batom:\s*true\b/.test(block),
    isolating: /\bisolating:\s*true\b/.test(block),
    defining: /\bdefining:\s*true\b/.test(block),
    attrs: attrKeysFromAddAttributes(block),
    kind,
  };
}

function frontendDocumentSpecs(): Spec[] {
  const article = readFileSync(join(articleDir, 'article-extensions.ts'), 'utf8');
  const comment = readFileSync(join(articleDir, 'comment-extension.ts'), 'utf8');
  const editor = readFileSync(join(articleDir, 'Editor.tsx'), 'utf8');
  const titled = readFileSync(join(articleDir, 'TitledCodeBlock.ts'), 'utf8');
  const lucide = readFileSync(join(articleDir, 'inline-lucide-icon.ts'), 'utf8');
  const mermaid = readFileSync(join(articleDir, 'MermaidBlockExtension.tsx'), 'utf8');

  const specs = [
    ...parseCreateBlocks(article),
    ...parseCreateBlocks(comment),
    ...parseCreateBlocks(lucide),
    ...parseCreateBlocks(mermaid),
  ];
  const image = parseNamedExtend(editor, 'Image', 'image', 'node');
  const table = parseNamedExtend(article, 'Table', 'table', 'node');
  const code = parseNamedExtend(titled, 'CodeBlockLowlight', 'codeBlock', 'node');
  const highlight = parseNamedExtend(article, 'Highlight', 'highlight', 'mark');
  for (const extra of [image, table, code, highlight]) {
    if (extra) specs.push(extra);
  }
  return specs.filter((s) => !EDITOR_ONLY_EXTENSION_NAMES.has(s.name));
}

function collectTypes(json: unknown, acc: Set<string>): void {
  if (!json || typeof json !== 'object') return;
  const node = json as { type?: string; content?: unknown[]; marks?: { type: string }[] };
  if (typeof node.type === 'string') acc.add(node.type);
  for (const mark of node.marks ?? []) acc.add(mark.type);
  for (const child of node.content ?? []) collectTypes(child, acc);
}

const GOLDEN: Array<{ name: string; html: string; expectTypes: string[] }> = [
  {
    name: 'panel',
    html: '<div class="panel-info"><p>Info panel body</p></div>',
    expectTypes: ['panel'],
  },
  {
    name: 'table',
    html: '<table><tbody><tr><th><p>Head</p></th></tr><tr><td><p>Cell</p></td></tr></tbody></table>',
    expectTypes: ['table', 'tableRow'],
  },
  {
    name: 'layout',
    html:
      '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal">'
      + '<div class="confluence-layout-cell"><p>Left</p></div>'
      + '<div class="confluence-layout-cell"><p>Right</p></div>'
      + '</div></div>',
    expectTypes: ['confluenceLayout', 'confluenceLayoutSection', 'confluenceLayoutCell'],
  },
  {
    name: 'mention',
    html: '<p><span class="confluence-user-mention" data-username="jdoe">@jdoe</span></p>',
    expectTypes: ['confluenceUserMention'],
  },
  {
    name: 'status',
    html: '<p><span class="confluence-status" data-color="green">DONE</span></p>',
    expectTypes: ['confluenceStatus'],
  },
  {
    name: 'expand',
    html: '<details data-macro-name="expand"><summary>Title</summary><p>Hidden</p></details>',
    expectTypes: ['details', 'detailsSummary'],
  },
  {
    name: 'unknown-macro',
    html: '<div class="confluence-macro-unknown" data-macro-name="foo" data-macro-params="{}"><p>body</p></div>',
    expectTypes: ['unknownMacro'],
  },
  {
    name: 'draw.io',
    html:
      '<div class="confluence-drawio" data-diagram-name="arch" data-drawio-xml="<mxfile/>">'
      + '<img src="/api/attachments/1/d.png" alt="Diagram"></div>',
    expectTypes: ['drawioDiagram'],
  },
  {
    name: 'comment',
    html: '<p><mark data-comment-id="42">annotated</mark></p>',
    expectTypes: ['comment'],
  },
];

describe('collab schema parity (#1445)', () => {
  it('includes CommentMark and excludes pngDataUri', () => {
    const schema = getCollabSchema();
    expect(schema.marks.comment).toBeDefined();
    expect(schema.nodes.drawioDiagram).toBeDefined();
    expect(schema.nodes.drawioDiagram!.spec.attrs).not.toHaveProperty('pngDataUri');
    const names = collabExtensions().map((e) => e.name);
    expect(names).toContain('comment');
    expect(names).not.toContain('pngDataUri');
  });

  it('matches Editor document nodes/marks on names, content, atom/isolating/defining, attrs', () => {
    const schema = getCollabSchema();
    const frontend = frontendDocumentSpecs();
    expect(frontend.some((s) => s.name === 'comment')).toBe(true);
    expect(frontend.some((s) => s.name === 'drawioDiagram')).toBe(true);

    for (const spec of frontend) {
      if (spec.name === 'blockShortcuts') continue;
      const pm = spec.kind === 'mark' ? schema.marks[spec.name] : schema.nodes[spec.name];
      expect(pm, `collab schema missing ${spec.kind} '${spec.name}'`).toBeDefined();
      const pmSpec = pm!.spec;
      if (spec.content !== null) {
        expect(pmSpec.content, `${spec.name}.content`).toBe(spec.content);
      }
      // One-way: a flag the frontend source sets must be present. TipTap
      // parent defaults (Table.isolating, Image.atom) are inherited, not
      // restated in .extend({}).
      if (spec.atom) expect(!!pmSpec.atom, `${spec.name}.atom`).toBe(true);
      if (spec.isolating) expect(!!pmSpec.isolating, `${spec.name}.isolating`).toBe(true);
      if (spec.defining) expect(!!pmSpec.defining, `${spec.name}.defining`).toBe(true);
      const pmAttrs = Object.keys(pmSpec.attrs ?? {});
      const expectedAttrs = spec.attrs.filter((a) => a !== 'pngDataUri');
      for (const attr of expectedAttrs) {
        expect(pmAttrs, `${spec.name} attrs`).toContain(attr);
      }
      expect(pmAttrs).not.toContain('pngDataUri');
    }
  });

  it('round-trips golden HTML including draw.io and comment (structure, not bytes)', () => {
    for (const fixture of GOLDEN) {
      const doc = htmlToYDoc(fixture.html);
      const html2 = yDocToHtml(doc);
      const json = generateJSON(html2, collabExtensions());
      const types = new Set<string>();
      collectTypes(json, types);
      for (const t of fixture.expectTypes) {
        expect(types, `${fixture.name} missing ${t} after round-trip; got ${[...types].join(',')}`).toContain(t);
      }
      if (fixture.name === 'comment') {
        expect(html2).toContain('data-comment-id');
      }
      if (fixture.name === 'draw.io') {
        expect(html2).toContain('confluence-drawio');
        expect(html2).not.toContain('data:image/png');
      }
    }
  });
});

