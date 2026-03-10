import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for the Vite build configuration to ensure manual chunks
 * and production optimizations are correctly configured.
 */

// Read package.json to get actual dependencies
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const deps = Object.keys(pkg.dependencies || {});

// Read and parse vite.config.ts to extract manualChunks configuration
const viteConfigPath = resolve(__dirname, '..', 'vite.config.ts');
const viteConfigSource = readFileSync(viteConfigPath, 'utf-8');

describe('Vite build configuration', () => {
  describe('sourcemap', () => {
    it('disables sourcemaps in production via environment check', () => {
      expect(viteConfigSource).toContain(
        "sourcemap: process.env.NODE_ENV !== 'production'",
      );
    });

    it('does not use unconditional sourcemap: true', () => {
      // Ensure there is no standalone `sourcemap: true` (the old config)
      // The new config has `sourcemap: process.env.NODE_ENV !== 'production'`
      const lines = viteConfigSource.split('\n');
      const sourcemapLines = lines.filter((l) =>
        l.trim().startsWith('sourcemap:'),
      );
      for (const line of sourcemapLines) {
        expect(line.trim()).not.toBe('sourcemap: true,');
      }
    });
  });

  describe('manualChunks', () => {
    it('defines manualChunks in rollupOptions output', () => {
      expect(viteConfigSource).toContain('manualChunks');
      expect(viteConfigSource).toContain('rollupOptions');
    });

    it('splits react vendor bundle', () => {
      expect(viteConfigSource).toContain("'react-vendor'");
      expect(viteConfigSource).toContain("'react'");
      expect(viteConfigSource).toContain("'react-dom'");
      expect(viteConfigSource).toContain("'react-router-dom'");
    });

    it('splits TanStack Query into its own chunk', () => {
      expect(viteConfigSource).toContain("'query'");
      expect(viteConfigSource).toContain("'@tanstack/react-query'");
    });

    it('splits framer-motion into its own chunk', () => {
      expect(viteConfigSource).toContain("'motion'");
      expect(viteConfigSource).toContain("'framer-motion'");
    });

    it('splits Radix UI into its own chunk', () => {
      expect(viteConfigSource).toContain("'radix-ui'");
    });

    it('splits UI utilities into their own chunk', () => {
      expect(viteConfigSource).toContain("'ui-utils'");
      expect(viteConfigSource).toContain("'lucide-react'");
      expect(viteConfigSource).toContain("'clsx'");
      expect(viteConfigSource).toContain("'tailwind-merge'");
    });

    it('splits zustand into its own chunk', () => {
      expect(viteConfigSource).toContain("'zustand'");
    });

    it('only references packages that exist in package.json dependencies', () => {
      // Extract all quoted package names from the manualChunks section
      const manualChunksMatch = viteConfigSource.match(
        /manualChunks:\s*\{([\s\S]*?)\n\s{8}\}/,
      );
      expect(manualChunksMatch).not.toBeNull();

      const chunksBlock = manualChunksMatch![1];
      // Match package names in array values (strings inside square brackets)
      const packageRefs = [
        ...chunksBlock.matchAll(/'(@?[a-z][a-z0-9./-]*)'/g),
      ]
        .map((m) => m[1])
        // Filter out chunk names (keys) by only keeping values inside arrays
        .filter((name) => {
          // Chunk keys appear as 'key': [...], package refs appear inside [...]
          // A simple heuristic: chunk keys are followed by a colon
          const keyPattern = new RegExp(`'${escapeRegex(name)}'\\s*:`);
          return !keyPattern.test(chunksBlock);
        });

      for (const pkg of packageRefs) {
        expect(deps).toContain(pkg);
      }
    });
  });
});

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
