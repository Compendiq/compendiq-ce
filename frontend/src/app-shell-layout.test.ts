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

describe('Inset shell tokens', () => {
  it('declares chassis as hex in both themes', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      expect(tokenHex(block, '--app-chassis'), theme).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('shell and rail backgrounds alias the left-pane chrome in both themes', () => {
    for (const block of [darkBlock, lightBlock]) {
      const shell = /--app-shell-bg:\s*([^;]+);/.exec(block);
      const rail = /--app-rail-bg:\s*([^;]+);/.exec(block);
      expect(shell, '--app-shell-bg must be declared').not.toBeNull();
      expect(rail, '--app-rail-bg must be declared').not.toBeNull();
      expect(shell![1]!.trim()).toBe('var(--color-background)');
      expect(rail![1]!.trim()).toBe('var(--color-background)');
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

  it('dark chassis is darker than the shell; light chassis is darker than paper', () => {
    expect(luminance(tokenHex(darkBlock, '--app-chassis'))).toBeLessThan(
      luminance(tokenHex(darkBlock, '--color-background')),
    );
    expect(luminance(tokenHex(lightBlock, '--app-chassis'))).toBeLessThan(
      luminance(tokenHex(lightBlock, '--color-background')),
    );
  });

  it('the context rail matches the left pane and stays off the chassis and document card', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const pane = tokenHex(block, '--color-background');
      expect(pane, `${theme} rail vs chassis`).not.toBe(tokenHex(block, '--app-chassis'));
      expect(pane, `${theme} rail vs card`).not.toBe(tokenHex(block, '--color-card'));
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
    expect(block).toMatch(/padding-inline:\s*var\(--app-inset\)/);
    expect(block).toMatch(/padding-bottom:\s*var\(--app-inset\)/);
    expect(block).toMatch(/padding-top:\s*0/);
  });

  it('the header stays a compact band independent of the chassis inset', () => {
    const block = extractBlock(css, '@utility app-header {');
    expect(block).toMatch(/height:\s*var\(--app-header-height\)/);
    expect(css).toMatch(/--app-header-height:\s*2\.5rem/);
    expect(appLayout).toMatch(/className="app-header[^"]*items-center/);
    expect(appLayout).not.toMatch(/<header[^>]*\bh-12\b/);
    expect(appLayout).not.toMatch(/<header[^>]*\bborder-b\b/);
  });

  it('the workspace utility is the detached card: bordered, radiused, unshadowed', () => {
    const block = extractBlock(css, '@utility app-workspace {');
    expect(block).toMatch(/background:\s*var\(--app-shell-bg\)/);
    expect(block).toMatch(/border:/);
    expect(block).toMatch(/border-radius:\s*var\(--app-shell-radius\)/);
    expect(block).not.toMatch(/box-shadow:/);
  });

  it('the layout shell wrapper does not add a second card around the rail', () => {
    const block = extractBlock(css, '@utility app-shell {');
    expect(block).not.toMatch(/border-radius:/);
    expect(block).not.toMatch(/box-shadow:/);
  });

  it('the context rail utility is a bordered, radiused, unshadowed pane', () => {
    const block = extractBlock(css, '@utility app-context-rail {');
    expect(block).toMatch(/background:\s*var\(--app-rail-bg\)/);
    expect(block).toMatch(/border:/);
    expect(block).toMatch(/border-radius:\s*var\(--app-rail-radius\)/);
    expect(block).not.toMatch(/box-shadow:/);
    expect(block).not.toMatch(/gradient\(/);
  });

  it('body-with-rail uses the shared gap token rather than a magic padding class', () => {
    const block = extractBlock(css, '@utility app-body-with-rail {');
    expect(block).toMatch(/gap:\s*var\(--app-rail-gap\)/);
    expect(block).not.toMatch(/padding-right:/);
    expect(block).not.toMatch(/padding-bottom:/);
  });

  it('mobile is edge-to-edge; md and xl step the inset, radius and rail gap', () => {
    expect(css).toMatch(/--app-inset:\s*0px/);
    expect(css).toMatch(/--app-shell-radius:\s*0px/);
    expect(css).toMatch(/--app-rail-gap:\s*0px/);
    expect(css).toMatch(/@media \(min-width:\s*768px\)[\s\S]*?--app-inset:\s*12px/);
    expect(css).toMatch(/@media \(min-width:\s*1280px\)[\s\S]*?--app-inset:\s*16px/);
  });

  it('does not apply transform on chassis or shell (would trap position:fixed)', () => {
    for (const name of ['app-chassis', 'app-shell']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} must not use transform`).not.toMatch(/transform:/);
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

  it('puts logo, find, alerts and the user menu on the chassis, outside the brighter workspace', () => {
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
    const collapsed = rightPane.slice(
      rightPane.indexOf('data-testid="article-right-pane-rail"') - 400,
      rightPane.indexOf('data-testid="article-right-pane-rail"') + 80,
    );
    const expanded = rightPane.slice(
      rightPane.indexOf('data-testid="article-right-pane"') - 400,
      rightPane.indexOf('data-testid="article-right-pane"') + 80,
    );
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
