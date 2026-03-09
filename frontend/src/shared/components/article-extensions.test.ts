import { describe, it, expect } from 'vitest';
import { Details, DetailsSummary, Panel, DrawioDiagram, ConfluenceToc, UnknownMacro } from './article-extensions';

// Helper to extract parseHTML rules from a TipTap extension config
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getParseRules(ext: any) {
  return ext.config.parseHTML?.call({ name: ext.name, options: {}, storage: {}, parent: undefined });
}

describe('article-extensions', () => {
  describe('Details', () => {
    it('has correct name and group', () => {
      expect(Details.name).toBe('details');
      expect(Details.config.group).toBe('block');
    });

    it('parses <details> tag', () => {
      const parseRules = getParseRules(Details);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'details' }));
    });
  });

  describe('DetailsSummary', () => {
    it('has correct name', () => {
      expect(DetailsSummary.name).toBe('detailsSummary');
    });

    it('parses <summary> tag', () => {
      const parseRules = getParseRules(DetailsSummary);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'summary' }));
    });
  });

  describe('Panel', () => {
    it('has correct name and group', () => {
      expect(Panel.name).toBe('panel');
      expect(Panel.config.group).toBe('block');
    });

    it('parses all panel types', () => {
      const parseRules = getParseRules(Panel);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.panel-info' }));
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.panel-warning' }));
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.panel-note' }));
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.panel-tip' }));
    });
  });

  describe('DrawioDiagram', () => {
    it('has correct name and is atomic', () => {
      expect(DrawioDiagram.name).toBe('drawioDiagram');
      expect(DrawioDiagram.config.atom).toBe(true);
    });

    it('parses div.confluence-drawio', () => {
      const parseRules = getParseRules(DrawioDiagram);
      expect(parseRules).toBeDefined();
      expect(parseRules?.[0]).toEqual(expect.objectContaining({ tag: 'div.confluence-drawio' }));
    });
  });

  describe('ConfluenceToc', () => {
    it('has correct name and is atomic', () => {
      expect(ConfluenceToc.name).toBe('confluenceToc');
      expect(ConfluenceToc.config.atom).toBe(true);
    });

    it('parses div.confluence-toc', () => {
      const parseRules = getParseRules(ConfluenceToc);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-toc' }));
    });
  });

  describe('UnknownMacro', () => {
    it('has correct name', () => {
      expect(UnknownMacro.name).toBe('unknownMacro');
    });

    it('parses div.confluence-macro-unknown', () => {
      const parseRules = getParseRules(UnknownMacro);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-macro-unknown' }));
    });
  });
});
