import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractBlock } from './test-utils';

/**
 * Inset application shell: viewport chassis → rounded app shell →
 * integrated workspace (nav + main) + detached context rail.
 *
 * Behaviour cannot be measured in jsdom (no layout). This file pins the
 * tokens, utilities and DOM structure as a proxy, the same way
 * `ai-scroll-chain.test.ts` pins the min-h-0 chain.
 */

const SRC = __dirname;

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf-8');
}

const css = read('index.css');
const appLayout = read('shared/components/layout/AppLayout.tsx');
const rightPane = read('shared/components/article/ArticleRightPane.tsx');
const sidebar = read('shared/components/layout/SidebarTreeView.tsx');
const settingsSidebar = read('shared/components/layout/SettingsSidebar.tsx');

const darkBlock = extractBlock(css, '@theme {');
const lightBlock = extractBlock(css, '[data-theme="paper"] {');

function tokenHex(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block);
  if (!m) throw new Error(`hex token not found: ${name}`);
  return m[1]!.toLowerCase();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('Inset shell tokens', () => {
  it('declares chassis as hex in both themes', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      expect(tokenHex(block, '--app-chassis'), theme).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('shell keeps the workspace ground while the rail uses the central pane surface in both themes', () => {
    for (const block of [darkBlock, lightBlock]) {
      const shell = /--app-shell-bg:\s*([^;]+);/.exec(block);
      const rail = /--app-rail-bg:\s*([^;]+);/.exec(block);
      expect(shell, '--app-shell-bg must be declared').not.toBeNull();
      expect(rail, '--app-rail-bg must be declared').not.toBeNull();
      expect(shell![1]!.trim()).toBe('var(--color-background)');
      expect(rail![1]!.trim()).toBe('var(--color-card)');
    }
  });

  it('chassis is distinguishable from the shell ground in both themes', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const chassis = tokenHex(block, '--app-chassis');
      const shell = tokenHex(block, '--color-background');
      expect(chassis, `${theme} chassis must not equal shell`).not.toBe(shell);
    }
  });

  // Graphite keeps Canvas as its darkest step. Paper does NOT rank it that way
  // either: --color-muted sits below it. The claim that matters in both themes is
  // that the document Pane is the brightest surface and the frame is a real step
  // under it, because since 2026-08-31 that step is ALL that makes the workspace
  // card read as a card — the hairline that used to trace it is gone. The
  // measured floor is asserted separately below.
  it('keeps the chassis below the pane in both themes, and darkest in Graphite', () => {
    expect(luminance(tokenHex(darkBlock, '--app-chassis'))).toBeLessThan(
      luminance(tokenHex(darkBlock, '--color-background')),
    );
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      expect(
        luminance(tokenHex(block, '--app-chassis')),
        `${theme} frame must stay below the document pane`,
      ).toBeLessThan(luminance(tokenHex(block, '--color-card')));
    }
  });

  // Since the workspace and rail hairlines came off (2026-08-31), the Pane over
  // Canvas step is the ONLY thing drawing the card. Both themes were tuned to
  // land on the same edge — 1.101:1 Graphite, 1.109:1 Paper — and the failure
  // mode this guards is silent: a chassis retune that keeps "below the pane"
  // true while flattening the edge to invisibility (#fafaf9 gave 1.044:1 and
  // was the reason the frame had to be deepened when the line went away).
  it('keeps the pane a visible step above the frame in both themes', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      expect(
        contrast(tokenHex(block, '--color-card'), tokenHex(block, '--app-chassis')),
        `${theme}: the unlined workspace card needs a readable value step`,
      ).toBeGreaterThanOrEqual(1.08);
    }
  });

  it('the context rail matches the central pane and stays off the chassis', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const pane = tokenHex(block, '--color-card');
      expect(pane, `${theme} rail vs chassis`).not.toBe(tokenHex(block, '--app-chassis'));
    }
  });

  it('body overscroll paints the chassis, not the shell', () => {
    expect(darkBlock).toMatch(/--surface-backdrop:\s*var\(--app-chassis\)/);
  });
});

describe('Inset shell utilities', () => {
  const utilities = ['app-chassis', 'app-shell', 'app-workspace', 'app-context-rail', 'app-body-with-rail'];

  it('declares the shell utilities', () => {
    for (const name of utilities) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `@utility ${name} must exist`).not.toBe('');
    }
  });

  it('the chassis utility paints the chassis token and applies inset padding', () => {
    const block = extractBlock(css, '@utility app-chassis {');
    expect(block).toMatch(/background:\s*var\(--app-chassis\)/);
    expect(block).toMatch(/padding-inline-start:\s*0/);
    expect(block).toMatch(/padding-inline-end:\s*var\(--app-inset\)/);
    expect(block).not.toMatch(/padding-inline:\s*var\(--app-inset\)/);
    expect(block).toMatch(/padding-bottom:\s*var\(--app-inset\)/);
    expect(block).toMatch(/padding-top:\s*0/);
  });

  it('the header stays a compact band independent of the chassis inset', () => {
    const block = extractBlock(css, '@utility app-header {');
    expect(block).toMatch(/height:\s*var\(--app-header-height\)/);
    expect(block).toMatch(/max-height:\s*var\(--app-header-height\)/);
    expect(block).toMatch(/overflow:\s*hidden/);
    expect(css).toMatch(/--app-header-height:\s*2\.75rem/);
    expect(appLayout).toMatch(/className="app-header[^"]*items-center/);
    expect(appLayout).not.toMatch(/<header[^>]*\bh-12\b/);
    expect(appLayout).not.toMatch(/<header[^>]*\bborder-b\b/);
    expect(appLayout).not.toMatch(/md:w-auto/);
  });

  it('the chassis destination column is 30px wider than the header is tall', () => {
    const nav = read('shared/components/layout/MainNavStrip.tsx');
    expect(css).toMatch(/--app-nav-rail-width:\s*calc\(var\(--app-header-height\) \+ 30px\)/);
    expect(nav).toContain('w-[var(--app-nav-rail-width)]');
  });

  it('completes the canvas frame across the top while panel toolbars keep Chrome', () => {
    const appHeader = extractBlock(css, '@utility app-header {');
    const panelToolbar = extractBlock(css, '@utility panel-toolbar {');
    expect(css).toMatch(/--app-header-bg:\s*#0c0c0d/);
    expect(css).toMatch(/--app-header-bg:\s*#f5f5f4/);
    expect(appHeader).toMatch(/background:\s*var\(--app-chassis\)/);
    expect(appHeader).not.toMatch(/background:\s*var\(--app-header-bg\)/);
    expect(panelToolbar).toMatch(/background:\s*var\(--app-header-bg\)/);
  });

  it('left navigation, including title and footer chrome, paints the same surface as main', () => {
    const sidebar = extractBlock(css, '@utility app-sidebar {');
    const pane = extractBlock(css, '@utility app-content-pane {');
    expect(sidebar).toMatch(/background:\s*var\(--color-card\)/);
    expect(pane).toMatch(/background:\s*var\(--color-card\)/);
    expect(css).toMatch(
      /\.app-sidebar\s+\.panel-toolbar\s*\{[^}]*background:\s*transparent/,
    );
  });

  it('the workspace utility is the detached card: unlined, radiused, unshadowed', () => {
    const block = extractBlock(css, '@utility app-workspace {');
    expect(block).toMatch(/background:\s*var\(--app-shell-bg\)/);
    expect(block).toMatch(/border-radius:\s*var\(--app-shell-radius\)/);
    // The card is inset, radiused and a value step above Canvas. A border here
    // was a third statement of the same boundary and read as a frame drawn
    // around the work; the owner removed it on 2026-08-31. Retune --app-chassis
    // if the card stops reading. The width token went with it, so a `1px`
    // reappearing anywhere in the ladder is caught too.
    expect(block).not.toMatch(/border:/);
    expect(block).not.toMatch(/border-(top|right|bottom|left|inline|block)/);
    expect(css).not.toMatch(/--app-shell-border-width/);
    expect(block).not.toMatch(/box-shadow:/);
  });

  it('the layout shell wrapper does not add a second card around the rail', () => {
    const block = extractBlock(css, '@utility app-shell {');
    expect(block).not.toMatch(/border-radius:/);
    expect(block).not.toMatch(/box-shadow:/);
  });

  it('the article rail matches the workspace card height, not the viewport floor', () => {
    const block = extractBlock(css, '@utility app-rail-beside {');
    expect(block).toMatch(/height:\s*100%/);
    expect(block).not.toMatch(/margin-bottom:\s*calc\(-1 \* var\(--app-inset\)\)/);
    expect(appLayout).toMatch(/app-rail-beside/);
    expect(appLayout).not.toMatch(/app-rail-to-floor/);
    expect(css).not.toMatch(/\.app-rail-to-floor \.app-context-rail[\s\S]*border-bottom-left-radius:\s*0/);
  });

  it('the context rail utility is an unlined, radiused, unshadowed pane', () => {
    const block = extractBlock(css, '@utility app-context-rail {');
    expect(block).toMatch(/background:\s*var\(--app-rail-bg\)/);
    expect(block).toMatch(/border-radius:\s*var\(--app-rail-radius\)/);
    // Same reasoning as the workspace card: the --app-rail-gap strip of Canvas
    // and the Pane/Canvas step carry the boundary. Below `md` this element is
    // the inspector sheet over a dimmed backdrop, where a border would be the
    // only line on screen.
    expect(block).not.toMatch(/border:/);
    expect(block).not.toMatch(/border-(top|right|bottom|left|inline|block)/);
    expect(block).not.toMatch(/box-shadow:/);
    expect(block).not.toMatch(/gradient\(/);
  });

  it('the rail wrapper owns an explicit grabbable gutter', () => {
    const bodyBlock = extractBlock(css, '@utility app-body-with-rail {');
    const railBlock = extractBlock(css, '@utility app-rail-beside {');
    expect(bodyBlock).toMatch(/gap:\s*0/);
    expect(railBlock).toMatch(/padding-left:\s*var\(--app-rail-gap\)/);
    expect(railBlock).toMatch(/position:\s*relative/);
  });

  it('mobile is edge-to-edge; md and xl step the inset, radius and rail gutter', () => {
    expect(css).toMatch(/--app-inset:\s*0px/);
    expect(css).toMatch(/--app-shell-radius:\s*0px/);
    expect(css).toMatch(/--app-rail-gap:\s*0px/);
    expect(css).toMatch(/@media \(min-width:\s*768px\)[\s\S]*?--app-inset:\s*12px[\s\S]*?--app-rail-gap:\s*4px/);
    expect(css).toMatch(/@media \(min-width:\s*1280px\)[\s\S]*?--app-inset:\s*16px[\s\S]*?--app-rail-gap:\s*6px/);
  });

  it('rail radius matches the workspace card so the two siblings share a bottom curve', () => {
    expect(css).toMatch(/@media \(min-width:\s*768px\)[\s\S]*?--app-shell-radius:\s*12px[\s\S]*?--app-rail-radius:\s*12px/);
    expect(css).toMatch(/@media \(min-width:\s*1280px\)[\s\S]*?--app-shell-radius:\s*14px[\s\S]*?--app-rail-radius:\s*14px/);
  });

  it('does not apply transform on chassis or shell (would trap position:fixed)', () => {
    for (const name of ['app-chassis', 'app-shell']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} must not use transform`).not.toMatch(/transform:/);
    }
  });
});

/**
 * The same argument, one level in: the shell stopped drawing frames on
 * 2026-08-31, and the content panes inside it followed the same afternoon when
 * the owner asked for the remaining hairlines to be very slim or gone.
 *
 * These are source guards for the panes whose ring was the LAST statement of a
 * boundary something else already made — the Library results list (a Chrome
 * header band on top, a divider under every row, the last divider closing the
 * bottom) and the AI page's options row and message pane (Pane on the sticky
 * strip's Workspace ground, plus a radius). A ring returning here is a box
 * drawn around content that was already legible without one.
 */
describe('Content panes carry no ring', () => {
  const pagesPage = read('features/pages/PagesPage.tsx');
  const aiPage = read('features/ai/AiAssistantPage.tsx');

  it('the Library results panels are unlined and their header band carries no rule', () => {
    const panels = [...pagesPage.matchAll(/data-testid="library-(?:search-)?results-panel" className="([^"]*)"/g)];
    expect(panels.length, 'both Library results panels must be found — this guard is stale').toBe(2);
    for (const [, classes] of panels) {
      expect(classes, `results panel must stay unlined: ${classes}`).not.toMatch(/\bborder\b/);
      expect(classes, 'the panel keeps its clip and radius, which is what draws it').toMatch(
        /overflow-hidden[\s\S]*rounded-lg/,
      );
    }
    // The header row is `panel-toolbar`: Chrome at 1.09:1 (Paper) / 1.11:1
    // (Graphite) on the pane. The fill is the boundary, so a `border-b` on the
    // same edge is a second statement of it.
    for (const testId of ['search-results-context', 'browse-results-context']) {
      const row = new RegExp(`className="([^"]*)" data-testid="${testId}"`).exec(pagesPage);
      expect(row, `${testId} row not found — this guard is stale`).not.toBeNull();
      expect(row![1]!, `${testId} must keep the Chrome band`).toMatch(/\bpanel-toolbar\b/);
      expect(row![1]!, `${testId} must not re-add a rule under the band`).not.toMatch(/\bborder-b\b/);
    }
  });

  it('the AI options row and message pane are unlined', () => {
    const messagePane = /className="([^"]*)" data-testid="ai-message-pane"/.exec(aiPage);
    expect(messagePane, 'the AI message pane was not found — this guard is stale').not.toBeNull();
    expect(messagePane![1]!, 'the message pane must stay unlined').not.toMatch(/\bborder\b/);
    expect(messagePane![1]!, 'its radius and the Pane/Workspace step draw it').toMatch(/rounded-xl/);

    const optionsRow = /className="flex flex-wrap items-center gap-x-2 gap-y-2 ([^"]*)"/.exec(aiPage);
    expect(optionsRow, 'the AI options row was not found — this guard is stale').not.toBeNull();
    expect(optionsRow![1]!, 'the options row must stay unlined').not.toMatch(/\bborder\b/);
  });
});

describe('AppLayout structure', () => {
  it('wraps the authenticated app in chassis then shell', () => {
    expect(appLayout).toMatch(/data-testid="app-chassis"/);
    expect(appLayout).toMatch(/data-testid="app-shell"/);
    expect(appLayout).toMatch(/data-testid="app-workspace"/);
    const chassisAt = appLayout.indexOf('data-testid="app-chassis"');
    const shellAt = appLayout.indexOf('data-testid="app-shell"');
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    const headerAt = appLayout.indexOf('<header');
    expect(chassisAt).toBeGreaterThan(-1);
    expect(shellAt).toBeGreaterThan(chassisAt);
    expect(workspaceAt).toBeGreaterThan(shellAt);
    expect(headerAt).toBeGreaterThan(chassisAt);
    expect(headerAt).toBeLessThan(workspaceAt);
  });

  it('puts logo, alerts and the user menu on the chassis, outside the brighter workspace', () => {
    const chassisAt = appLayout.indexOf('data-testid="app-chassis"');
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    const headerAt = appLayout.indexOf('<header');
    expect(headerAt).toBeGreaterThan(chassisAt);
    expect(headerAt).toBeLessThan(workspaceAt);
    expect(appLayout.slice(headerAt, workspaceAt)).toMatch(/HeaderSessionCluster/);
  });

  it('keeps the skip link before the shell so it is not clipped', () => {
    const skipAt = appLayout.indexOf('Skip to content');
    const shellAt = appLayout.indexOf('data-testid="app-shell"');
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(shellAt);
  });

  it('keeps left navigation inside the workspace, not as a detached card', () => {
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    expect(workspaceAt).toBeGreaterThan(-1);
    const sidebarAt = appLayout.indexOf('<SidebarTreeView', workspaceAt);
    const mainAt = appLayout.indexOf('id="main-content"');
    expect(sidebarAt).toBeGreaterThan(workspaceAt);
    expect(mainAt).toBeGreaterThan(sidebarAt);
    const paneAt = appLayout.indexOf('<ArticleRightPane', workspaceAt);
    expect(paneAt).toBeGreaterThan(mainAt);
  });

  it('mounts the article inspector outside the workspace as the context rail', () => {
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    const paneAt = appLayout.indexOf('<ArticleRightPane', workspaceAt);
    expect(paneAt).toBeGreaterThan(workspaceAt);
    const afterWorkspace = appLayout.slice(workspaceAt, paneAt);
    // The pane must not sit inside the workspace wrapper: a closing of
    // app-workspace has to appear before ArticleRightPane.
    expect(afterWorkspace).toMatch(/<\/div>/);
  });

  it('hosts a chassis-level mobile inspector sheet before the workspace', () => {
    const sheetAt = appLayout.indexOf('aria-label="Page inspector"');
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    expect(sheetAt).toBeGreaterThan(-1);
    expect(sheetAt).toBeLessThan(workspaceAt);
    expect(appLayout).toMatch(/presentation="sheet"/);
    expect(appLayout).not.toMatch(/forceCollapsed/);
    expect(appLayout).not.toMatch(/forceTreeCollapsed/);
  });

  it('does not reintroduce the retired floating-chrome padding on the panel wrapper', () => {
    const match = /data-testid="panel-wrapper"[^>]*className="([^"]+)"/.exec(appLayout)
      ?? /data-testid="panel-wrapper"[^>]*className=\{cn\(([\s\S]*?)\)\}/.exec(appLayout);
    expect(match, 'panel-wrapper className').not.toBeNull();
    const value = match![1]!;
    expect(value).not.toMatch(/\bp-3\b/);
    expect(value).not.toMatch(/\bgap-2\.5\b/);
  });

  it('the destination rail sits flush against the workspace, 4px past the header band', () => {
    expect(appLayout).toMatch(/data-testid="app-shell"[^>]*className="[^"]*"/);
    const shellClass = /data-testid="app-shell"[^>]*className="([^"]+)"/.exec(appLayout)?.[1] ?? '';
    expect(shellClass).not.toMatch(/\bgap-/);
    const nav = read('shared/components/layout/MainNavStrip.tsx');
    expect(nav).toContain('w-[var(--app-nav-rail-width)]');
    expect(nav).toContain('items-center');
    expect(nav).toContain('px-1');
    expect(nav).toMatch(/h-10 w-10/);
  });

  it('mounts the chassis destination rail outside the workspace card', () => {
    expect(appLayout).toMatch(/MainNavChassisRail/);
    const chassisNavAt = appLayout.indexOf('<MainNavChassisRail');
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    expect(chassisNavAt).toBeGreaterThan(-1);
    expect(chassisNavAt).toBeLessThan(workspaceAt);
  });

  it('keeps desktop trees off the in-tree Pages/AI/Graph strip', () => {
    expect(appLayout).toMatch(/SettingsSidebar embedMainNav=\{false\}/);
    expect(appLayout).toMatch(/SidebarTreeView embedMainNav=\{false\}/);
    expect(appLayout).toMatch(/SidebarTreeView onNavigate=\{closeMobileSidebar\} embedMainNav/);
    expect(appLayout).not.toMatch(/AppHeaderMain/);
  });

  it('does not paint a second fill on the article main inside the workspace card', () => {
    const mainAt = appLayout.indexOf('id="main-content"');
    expect(mainAt).toBeGreaterThan(-1);
    const mainBlock = appLayout.slice(mainAt, appLayout.indexOf('</main>', mainAt));
    expect(mainBlock).not.toMatch(/bg-card/);
  });

  it('still owns a single main scroll container', () => {
    const matches = appLayout.match(/data-scroll-container/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe('Context rail vs left navigation', () => {
  it('the inspector uses the context-rail surface, not the sidebar chassis utility', () => {
    const openingAsideFor = (testId: string) => {
      const marker = rightPane.lastIndexOf(`data-testid="${testId}"`);
      const start = rightPane.lastIndexOf('<m.aside', marker);
      return rightPane.slice(start, marker + testId.length + 32);
    };
    const collapsed = openingAsideFor('article-right-pane-rail');
    const expanded = openingAsideFor('article-right-pane');
    expect(collapsed).toMatch(/app-context-rail/);
    expect(expanded).toMatch(/app-context-rail/);
    expect(collapsed).not.toMatch(/app-sidebar/);
    expect(expanded).not.toMatch(/app-sidebar/);
  });

  it('left navigation and settings still use the sidebar chassis utility', () => {
    expect(sidebar).toMatch(/app-sidebar/);
    expect(settingsSidebar).toMatch(/app-sidebar/);
    expect(sidebar).not.toMatch(/app-context-rail/);
    expect(settingsSidebar).not.toMatch(/app-context-rail/);
  });
});
