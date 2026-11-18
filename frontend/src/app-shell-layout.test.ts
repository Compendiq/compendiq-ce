import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractBlock } from './test-utils';

/**
 * Inset application shell: viewport chassis (top header + compact left icon
 * rail) → rounded workspace card (route sidebar + main + detached context rail).
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

  it('shell keeps the workspace ground while the sidebar sits slightly darker than the central pane in both themes', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const shell = /--app-shell-bg:\s*([^;]+);/.exec(block);
      const rail = /--app-rail-bg:\s*([^;]+);/.exec(block);
      expect(shell, '--app-shell-bg must be declared').not.toBeNull();
      expect(rail, '--app-rail-bg must be declared').not.toBeNull();
      expect(shell![1]!.trim()).toBe('var(--color-background)');
      expect(rail![1]!.trim()).toBe('transparent');

      const sidebarBg = tokenHex(block, '--app-sidebar-bg');
      const cardBg = tokenHex(block, '--color-card');
      const leftEdgeStop = tokenHex(block, '--shell-grad-1');
      expect(
        luminance(sidebarBg),
        `${theme}: sidebar (${sidebarBg}) must be darker than main pane (${cardBg})`,
      ).toBeLessThan(luminance(cardBg));
      expect(
        luminance(sidebarBg),
        `${theme}: sidebar (${sidebarBg}) must stay above left-edge chassis stop (${leftEdgeStop})`,
      ).toBeGreaterThan(luminance(leftEdgeStop));
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

  // Canvas step is the ONLY thing drawing the card. Graphite sits at 1.101:1 and
  // Paper at 1.171:1 — Paper has been as grey as 1.23:1 (2026-09-07) and as flat
  // as 1.044:1, and the failure
  // mode this guards is silent: a chassis retune that keeps "below the pane"
  // true while flattening the edge to invisibility (#fafaf9 gave 1.044:1 and
  // was the reason the frame had to be deepened when the line went away).
  it('orders the 5-stop shell gradient ramp in both themes (darkest toward left/bottom-left, brightest toward top-right)', () => {
    const lightStops = [1, 2, 3, 4, 5].map((n) => luminance(tokenHex(lightBlock, `--shell-grad-${n}`)));
    for (let i = 1; i < lightStops.length; i++) {
      expect(lightStops[i]!, `light stop ${i + 1} must be lighter than stop ${i}`).toBeGreaterThan(lightStops[i - 1]!);
    }
    expect(tokenHex(lightBlock, '--shell-grad-5')).toBe(tokenHex(lightBlock, '--app-chassis'));
    expect(lightBlock).toMatch(/--shell-grad-dir:\s*to top right;/);

    const darkStops = [1, 2, 3, 4, 5].map((n) => luminance(tokenHex(darkBlock, `--shell-grad-${n}`)));
    for (let i = 1; i < darkStops.length; i++) {
      expect(darkStops[i]!, `dark stop ${i + 1} must lift toward top-right brightest stop ${i}`).toBeGreaterThan(darkStops[i - 1]!);
    }
    expect(tokenHex(darkBlock, '--shell-grad-1')).toBe(tokenHex(darkBlock, '--app-chassis'));
    expect(darkBlock).toMatch(/--shell-grad-dir:\s*to top right;/);
  });

  it('keeps navigation labels and focus indicators readable across every gradient stop', () => {
    for (const block of [darkBlock, lightBlock]) {
      const shellMuted = tokenHex(block, '--shell-muted');
      const primary = tokenHex(block, '--color-primary');
      for (const n of [1, 2, 3, 4, 5]) {
        const stop = tokenHex(block, `--shell-grad-${n}`);
        expect(contrast(shellMuted, stop)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(primary, stop)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('paints the chassis with the radial shade pool and 5-stop diagonal colour-gradient', () => {
    const block = extractBlock(css, '@utility app-chassis {');
    expect(block).toMatch(/background-color:\s*var\(--app-chassis\)/);
    expect(block).toMatch(/radial-gradient\(64% 58% at var\(--shell-pool-pos\)/);
    expect(block).toMatch(/var\(--shell-pool\)\s*0%/);
    expect(block).toMatch(/var\(--shell-pool-soft\)\s*46%/);
    expect(block).toMatch(/linear-gradient\(var\(--shell-grad-dir\)/);
    expect(block).toMatch(/var\(--shell-grad-1\)\s*0%/);
    expect(block).toMatch(/var\(--shell-grad-5\)\s*100%/);
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
  const utilities = ['app-chassis', 'app-shell', 'app-workspace', 'app-context-rail'];

  it('declares the shell utilities', () => {
    for (const name of utilities) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `@utility ${name} must exist`).not.toBe('');
    }
  });

  it('the chassis utility paints the gradient chassis tokens and applies inset padding', () => {
    const block = extractBlock(css, '@utility app-chassis {');
    expect(block).toMatch(/background-color:\s*var\(--app-chassis\)/);
    expect(block).toMatch(/background-image:/);
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

  it('matches the left icon rail width to the header height and mirrors it in the boot skeleton', () => {
    const skeleton = read('shared/components/feedback/AppLoadingFallback.tsx');
    expect(css).toMatch(/--app-nav-rail-width:\s*var\(--app-header-height\)/);
    expect(skeleton).toContain('w-[var(--app-nav-rail-width)]');
    expect(skeleton).toContain('app-sidebar');
    expect(skeleton).not.toContain('ml-4');
  });

  it('the workspace sidebar uses translucent --app-sidebar-translucent with a 1px right divider and transparent toolbars', () => {
    const sidebar = extractBlock(css, '@utility app-sidebar {');
    const pane = extractBlock(css, '@utility app-content-pane {');
    expect(sidebar).toMatch(/background:\s*var\(--app-sidebar-translucent\)/);
    expect(sidebar).toMatch(/background-clip:\s*padding-box/);
    expect(sidebar).toMatch(/border-right-width:\s*1px/);
    expect(sidebar).toMatch(/border-color:\s*var\(--panel-divider\)/);
    expect(pane).toMatch(/background:\s*transparent/);
    expect(css).toMatch(
      /\.app-sidebar\s+\.panel-toolbar\s*\{[^}]*background:\s*transparent/,
    );
  });

  it('the workspace utility is the frosted radiused card with its translucent panel ground, border token, and resting shadow', () => {
    const block = extractBlock(css, '@utility app-workspace {');
    expect(block).toMatch(/background:\s*var\(--panel-bg\)/);
    expect(block).toMatch(/backdrop-filter:\s*blur\(16px\)/);
    expect(block).toMatch(/border-radius:\s*var\(--app-shell-radius\)/);
    expect(block).toMatch(/border:\s*1px solid var\(--panel-border\)/);
    expect(css).not.toMatch(/--app-shell-border-width/);
    expect(block).toMatch(/box-shadow:\s*var\(--panel-shadow\)/);
  });

  it('the layout shell wrapper does not add a second card around the rail', () => {
    const block = extractBlock(css, '@utility app-shell {');
    expect(block).not.toMatch(/border-radius:/);
    expect(block).not.toMatch(/box-shadow:/);
  });

  it('the context rail utility uses --app-rail-bg with a left border dividing it from the main pane', () => {
    const block = extractBlock(css, '@utility app-context-rail {');
    expect(block).toMatch(/background:\s*var\(--app-rail-bg\)/);
    expect(block).toMatch(/border-left-width:\s*1px/);
    expect(block).toMatch(/border-color:\s*var\(--rail-divider\)/);
    expect(block).not.toMatch(/box-shadow:/);
    expect(block).not.toMatch(/gradient\(/);
  });

  it('keeps dark mode workspace outer/left borders seamless, right rail softly hairlined, headers aligned on --workspace-card-bg, and sidebar darker than main', () => {
    expect(darkBlock).toMatch(/--panel-border:\s*transparent;/);
    expect(darkBlock).toMatch(/--panel-divider:\s*transparent;/);
    expect(darkBlock).toMatch(/--rail-divider:\s*rgb\(255 255 255 \/ 0\.06\);/);
    const darkShadow = /--panel-shadow:\s*([^;]+);/.exec(darkBlock);
    expect(darkShadow).not.toBeNull();
    expect(darkShadow![1]).not.toMatch(/inset\s+0\s+1px/);

    const railHeader = extractBlock(css, '.app-context-rail .panel-toolbar.nm-popover-glass {');
    expect(railHeader).toMatch(/background-color:\s*var\(--workspace-card-bg\)/);
    expect(railHeader).toMatch(/backdrop-filter:\s*none/);

    const panelBgMatch = /--panel-bg:\s*rgb\(0 0 0 \/ ([0-9.]+)\);/.exec(darkBlock);
    const sidebarAlphaMatch = /--app-sidebar-translucent:\s*rgb\(0 0 0 \/ ([0-9.]+)\);/.exec(darkBlock);
    expect(panelBgMatch).not.toBeNull();
    expect(sidebarAlphaMatch).not.toBeNull();
    expect(Number(panelBgMatch![1])).toBeCloseTo(0.30, 5);
    expect(Number(sidebarAlphaMatch![1])).toBeCloseTo(0.52, 5);
    expect(Number(sidebarAlphaMatch![1])).toBeGreaterThan(Number(panelBgMatch![1]));

    const lightPanelBgMatch = /--panel-bg:\s*rgb\(255 255 255 \/ ([0-9.]+)\);/.exec(lightBlock);
    const lightSidebarAlphaMatch = /--app-sidebar-translucent:\s*rgb\(208 212 218 \/ ([0-9.]+)\);/.exec(lightBlock);
    expect(lightPanelBgMatch).not.toBeNull();
    expect(lightSidebarAlphaMatch).not.toBeNull();
    expect(Number(lightPanelBgMatch![1])).toBeCloseTo(0.78, 5);
    expect(Number(lightSidebarAlphaMatch![1])).toBeCloseTo(0.38, 5);
  });

  it('mobile is edge-to-edge; md and xl step the inset and card radius', () => {
    expect(css).toMatch(/--app-inset:\s*0px/);
    expect(css).toMatch(/--app-shell-radius:\s*0px/);
    expect(css).toMatch(/@media \(min-width:\s*768px\)[\s\S]*?--app-inset:\s*12px[\s\S]*?--app-shell-radius:\s*12px/);
    expect(css).toMatch(/@media \(min-width:\s*1280px\)[\s\S]*?--app-inset:\s*16px[\s\S]*?--app-shell-radius:\s*14px/);
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
 * bottom) and the AI page's message pane (Pane on the sticky strip's Workspace
 * ground, plus a radius). A ring returning here is a box drawn around content
 * that was already legible without one.
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

  it('the AI message pane is unlined and no options row came back above it', () => {
    const messagePane = /className="([^"]*)" data-testid="ai-message-pane"/.exec(aiPage);
    expect(messagePane, 'the AI message pane was not found — this guard is stale').not.toBeNull();
    expect(messagePane![1]!, 'the message pane must stay unlined').not.toMatch(/\bborder\b/);
    expect(messagePane![1]!, 'its radius and the Pane/Workspace step draw it').toMatch(/rounded-xl/);

    // The `bg-card` options row above the pane held one chip (`Think`) and
    // went into the composers on 2026-09-01 (owner request). A card row
    // returning here is a full-width strip describing a request composed 600px
    // below it — and it would spend its padding and both column gaps out of
    // the pane's height at every mode.
    expect(aiPage, 'the AI options row must not come back').not.toMatch(
      /flex flex-wrap items-center gap-x-2[^"]*bg-card/,
    );
    expect(aiPage, 'Think belongs to the composers now, not this page').not.toContain(
      'Thinking mode',
    );

    // What is left of the sticky strip is the mode-specific setting, and its
    // under-mask must still cover exactly the bar's box: an absolutely
    // positioned mask past the block-end edge grows scrollable overflow in a
    // container that has none (#769). It paints `bg-card` — the route pane's own
    // fill (`app-content-pane`) — since 2026-09-11: on `bg-background` the bar
    // and its mask painted a Workspace-coloured box around the composer inside a
    // Pane-coloured page. The DOM half of this is pinned in
    // `AiAssistantPage.test.tsx`, which cannot reach diagram mode on /ai.
    const masks = [...aiPage.matchAll(/aria-hidden\s*\n\s*className="([^"]*)"/g)];
    expect(masks.length, 'the /ai under-masks were not found — this guard is stale')
      .toBeGreaterThan(0);
    for (const [, classes] of masks) {
      expect(classes).toBe('pointer-events-none absolute inset-0 z-[-1] bg-card');
    }
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

  it('mounts the compact icon rail on the chassis and the route sidebar inside the workspace card left of main', () => {
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    expect(workspaceAt).toBeGreaterThan(-1);
    const chassisNavAt = appLayout.indexOf('<MainNavChassisRail');
    const sidebarAt = appLayout.indexOf('<SidebarTreeView', workspaceAt);
    const aiSidebarAt = appLayout.indexOf('<AiConversationsSidebar', workspaceAt);
    const settingsSidebarAt = appLayout.indexOf('<SettingsSidebar', workspaceAt);
    const mainAt = appLayout.indexOf('id="main-content"');
    expect(chassisNavAt).toBeGreaterThan(-1);
    expect(chassisNavAt).toBeLessThan(workspaceAt);
    expect(sidebarAt).toBeGreaterThan(workspaceAt);
    expect(sidebarAt).toBeLessThan(mainAt);
    expect(aiSidebarAt).toBeGreaterThan(workspaceAt);
    expect(aiSidebarAt).toBeLessThan(mainAt);
    expect(settingsSidebarAt).toBeGreaterThan(workspaceAt);
    expect(settingsSidebarAt).toBeLessThan(mainAt);
    expect(mainAt).toBeGreaterThan(workspaceAt);
    const paneAt = appLayout.indexOf('<ArticleRightPane', workspaceAt);
    expect(paneAt).toBeGreaterThan(mainAt);
  });

  it('mounts the article inspector attached inside the workspace card', () => {
    const workspaceAt = appLayout.indexOf('data-testid="app-workspace"');
    const paneAt = appLayout.indexOf('<ArticleRightPane', workspaceAt);
    const mainAt = appLayout.indexOf('id="main-content"');
    expect(workspaceAt).toBeGreaterThan(-1);
    expect(mainAt).toBeGreaterThan(workspaceAt);
    expect(paneAt).toBeGreaterThan(mainAt);
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

  it('does not reintroduce the retired floating-chrome padding or extra rail margin on the panel wrapper', () => {
    const match = /data-testid="panel-wrapper"[^>]*className="([^"]+)"/.exec(appLayout)
      ?? /data-testid="panel-wrapper"[^>]*className=\{cn\(([\s\S]*?)\)\}/.exec(appLayout);
    expect(match, 'panel-wrapper className').not.toBeNull();
    const value = match![1]!;
    expect(value).not.toMatch(/\bp-3\b/);
    expect(value).not.toMatch(/\bgap-2\.5\b/);
    expect(value).not.toMatch(/\bml-2\b/);
  });

  it('keeps desktop sidebars off the in-tree Pages/AI/Graph strip and header free of MainNavHeaderTabs', () => {
    expect(appLayout).toMatch(/SettingsSidebar embedMainNav=\{false\}/);
    expect(appLayout).toMatch(/SidebarTreeView embedMainNav=\{false\}/);
    expect(appLayout).toMatch(/AiConversationsSidebar embedMainNav=\{false\}/);
    expect(appLayout).toMatch(/SidebarTreeView onNavigate=\{closeMobileSidebar\} embedMainNav/);
    expect(appLayout).not.toMatch(/MainNavHeaderTabs/);
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

  it('left navigation and settings still use the sidebar utility', () => {
    expect(sidebar).toMatch(/app-sidebar/);
    expect(settingsSidebar).toMatch(/app-sidebar/);
    expect(sidebar).not.toMatch(/app-context-rail/);
    expect(settingsSidebar).not.toMatch(/app-context-rail/);
  });
});
