import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { THEMES } from './stores/theme-store';

/**
 * Regression tests for the graphite dark theme rework (#394).
 *
 * Ensures both dark themes use near-neutral (low chroma) surfaces
 * and that display labels / descriptions match the new naming.
 */

const cssPath = resolve(__dirname, 'index.css');
const css = readFileSync(cssPath, 'utf-8');

/**
 * Parse an oklch() value and return { L, C, H }.
 * Handles both `oklch(L C H)` and `oklch(L C H / alpha)`.
 */
function parseOklch(value: string): { L: number; C: number; H: number } | null {
  const match = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!match) return null;
  return { L: parseFloat(match[1]), C: parseFloat(match[2]), H: parseFloat(match[3]) };
}

describe('Graphite dark themes (#394)', () => {
  describe('Void Indigo (default @theme block)', () => {
    it('has background chroma <= 0.015 (graphite, not saturated)', () => {
      // The @theme block defines --color-background for void-indigo
      const bgMatch = css.match(/@theme\s*\{[^}]*--color-background:\s*(oklch\([^)]+\))/s);
      expect(bgMatch).not.toBeNull();
      const parsed = parseOklch(bgMatch![1]);
      expect(parsed).not.toBeNull();
      expect(parsed!.C).toBeLessThanOrEqual(0.015);
    });

    it('has card chroma <= 0.015 (graphite surfaces)', () => {
      const cardMatch = css.match(/@theme\s*\{[^}]*--color-card:\s*(oklch\([^)]+\))/s);
      expect(cardMatch).not.toBeNull();
      const parsed = parseOklch(cardMatch![1]);
      expect(parsed).not.toBeNull();
      expect(parsed!.C).toBeLessThanOrEqual(0.015);
    });

    it('preserves strong indigo accent on primary (chroma >= 0.15)', () => {
      const primaryMatch = css.match(/@theme\s*\{[^}]*--color-primary:\s*(oklch\([^)]+\))/s);
      expect(primaryMatch).not.toBeNull();
      const parsed = parseOklch(primaryMatch![1]);
      expect(parsed).not.toBeNull();
      expect(parsed!.C).toBeGreaterThanOrEqual(0.15);
    });
  });

  describe('Obsidian Violet ([data-theme="obsidian-violet"])', () => {
    it('has background hue around 60 (warm), not 285 (violet)', () => {
      // Extract the obsidian-violet block
      const blockMatch = css.match(
        /\[data-theme="obsidian-violet"\]\s*\{([^}]+)\}/s,
      );
      expect(blockMatch).not.toBeNull();
      const block = blockMatch![1];

      const bgMatch = block.match(/--color-background:\s*(oklch\([^)]+\))/);
      expect(bgMatch).not.toBeNull();
      const parsed = parseOklch(bgMatch![1]);
      expect(parsed).not.toBeNull();
      // Warm hue: should be between 30 and 90 (around 60)
      expect(parsed!.H).toBeGreaterThanOrEqual(30);
      expect(parsed!.H).toBeLessThanOrEqual(90);
    });

    it('has background chroma <= 0.010 (near-neutral warm graphite)', () => {
      const blockMatch = css.match(
        /\[data-theme="obsidian-violet"\]\s*\{([^}]+)\}/s,
      );
      expect(blockMatch).not.toBeNull();
      const block = blockMatch![1];

      const bgMatch = block.match(/--color-background:\s*(oklch\([^)]+\))/);
      expect(bgMatch).not.toBeNull();
      const parsed = parseOklch(bgMatch![1]);
      expect(parsed).not.toBeNull();
      expect(parsed!.C).toBeLessThanOrEqual(0.010);
    });

    it('preserves strong violet accent on primary (chroma >= 0.20)', () => {
      const blockMatch = css.match(
        /\[data-theme="obsidian-violet"\]\s*\{([^}]+)\}/s,
      );
      expect(blockMatch).not.toBeNull();
      const block = blockMatch![1];

      const primaryMatch = block.match(/--color-primary:\s*(oklch\([^)]+\))/);
      expect(primaryMatch).not.toBeNull();
      const parsed = parseOklch(primaryMatch![1]);
      expect(parsed).not.toBeNull();
      expect(parsed!.C).toBeGreaterThanOrEqual(0.20);
    });
  });

  describe('Theme store labels', () => {
    it('Void Indigo is labeled "Void"', () => {
      const voidTheme = THEMES.find((t) => t.id === 'void-indigo');
      expect(voidTheme).toBeDefined();
      expect(voidTheme!.label).toBe('Void');
    });

    it('Obsidian Violet is labeled "Obsidian"', () => {
      const obsidianTheme = THEMES.find((t) => t.id === 'obsidian-violet');
      expect(obsidianTheme).toBeDefined();
      expect(obsidianTheme!.label).toBe('Obsidian');
    });

    it('Void Indigo description mentions graphite', () => {
      const voidTheme = THEMES.find((t) => t.id === 'void-indigo');
      expect(voidTheme).toBeDefined();
      expect(voidTheme!.description.toLowerCase()).toContain('graphite');
    });

    it('Obsidian Violet description mentions graphite', () => {
      const obsidianTheme = THEMES.find((t) => t.id === 'obsidian-violet');
      expect(obsidianTheme).toBeDefined();
      expect(obsidianTheme!.description.toLowerCase()).toContain('graphite');
    });
  });
});
