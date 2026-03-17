import { describe, it, expect } from 'vitest';
import { Details, DetailsSummary, Panel, DrawioDiagram, ConfluenceToc, ConfluenceStatus, ConfluenceChildren, ConfluenceLayout, ConfluenceLayoutSection, ConfluenceLayoutCell, UnknownMacro } from './article-extensions';

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

  describe('ConfluenceStatus', () => {
    it('has correct name and is inline atom', () => {
      expect(ConfluenceStatus.name).toBe('confluenceStatus');
      expect(ConfluenceStatus.config.group).toBe('inline');
      expect(ConfluenceStatus.config.inline).toBe(true);
      expect(ConfluenceStatus.config.atom).toBe(true);
    });

    it('parses span.confluence-status', () => {
      const parseRules = getParseRules(ConfluenceStatus);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'span.confluence-status' }));
    });
  });

  describe('ConfluenceChildren', () => {
    it('has correct name and is block atom', () => {
      expect(ConfluenceChildren.name).toBe('confluenceChildren');
      expect(ConfluenceChildren.config.group).toBe('block');
      expect(ConfluenceChildren.config.atom).toBe(true);
    });

    it('parses div.confluence-children-macro', () => {
      const parseRules = getParseRules(ConfluenceChildren);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-children-macro' }));
    });

    it('defines attributes for all supported parameters', () => {
      const addAttributes = ConfluenceChildren.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceChildren', options: {}, storage: {}, parent: undefined });
      expect(attrs).toBeDefined();
      const expectedParams = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType', 'macro-name'];
      for (const param of expectedParams) {
        expect(attrs).toHaveProperty(param);
        expect(attrs[param].default).toBeNull();
      }
    });

    it('parseHTML reads data-* attributes for each parameter', () => {
      const addAttributes = ConfluenceChildren.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceChildren', options: {}, storage: {}, parent: undefined });
      // Create a mock element with data attributes (case-insensitive like real DOM)
      const mockElement = {
        getAttribute: (name: string) => {
          const map: Record<string, string> = {
            'data-sort': 'creation',
            'data-reverse': 'true',
            'data-depth': '2',
            'data-first': '10',
            'data-page': 'My Page',
            'data-style': 'h3',
            'data-excerpttype': 'rich',
            'data-macro-name': 'ui-children',
          };
          return map[name.toLowerCase()] ?? null;
        },
      } as unknown as HTMLElement;

      expect(attrs.sort.parseHTML(mockElement)).toBe('creation');
      expect(attrs.reverse.parseHTML(mockElement)).toBe('true');
      expect(attrs.depth.parseHTML(mockElement)).toBe('2');
      expect(attrs.first.parseHTML(mockElement)).toBe('10');
      expect(attrs.page.parseHTML(mockElement)).toBe('My Page');
      expect(attrs.style.parseHTML(mockElement)).toBe('h3');
      expect(attrs.excerptType.parseHTML(mockElement)).toBe('rich');
      expect(attrs['macro-name'].parseHTML(mockElement)).toBe('ui-children');
    });
  });

    it('renderHTML preserves null attributes and does not drop falsy values', () => {
      const renderHTML = ConfluenceChildren.config.renderHTML;
      if (!renderHTML) throw new Error('renderHTML not defined');

      // Simulate a node with some attrs set and some null
      const node = {
        attrs: {
          sort: 'title',
          reverse: null,
          depth: '0', // falsy as number but truthy as string
          first: null,
          page: null,
          style: null,
          excerptType: null,
          'macro-name': 'ui-children',
        },
      };

      const result = renderHTML.call(
        { name: 'confluenceChildren', options: {}, storage: {}, parent: undefined },
        { node, HTMLAttributes: {} },
      ) as [string, Record<string, string>, string];

      const [tag, attrs, content] = result;
      expect(tag).toBe('div');
      expect(content).toBe('[Children pages listed here]');
      expect(attrs['data-sort']).toBe('title');
      expect(attrs['data-depth']).toBe('0');
      expect(attrs['data-macro-name']).toBe('ui-children');
      // Null attrs should not appear
      expect(attrs).not.toHaveProperty('data-reverse');
      expect(attrs).not.toHaveProperty('data-first');
    });

  describe('ConfluenceLayout', () => {
    it('has correct name and group', () => {
      expect(ConfluenceLayout.name).toBe('confluenceLayout');
      expect(ConfluenceLayout.config.group).toBe('block');
    });

    it('parses div.confluence-layout', () => {
      const parseRules = getParseRules(ConfluenceLayout);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-layout' }));
    });

    it('preserves data-layout-type attribute', () => {
      const addAttributes = ConfluenceLayout.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceLayout', options: {}, storage: {}, parent: undefined });
      expect(attrs).toHaveProperty('layoutType');
      const mockEl = { getAttribute: (name: string) => name === 'data-layout-type' ? 'two-column' : null } as unknown as HTMLElement;
      expect(attrs.layoutType.parseHTML(mockEl)).toBe('two-column');
    });
  });

  describe('ConfluenceLayoutSection', () => {
    it('has correct name and group', () => {
      expect(ConfluenceLayoutSection.name).toBe('confluenceLayoutSection');
      expect(ConfluenceLayoutSection.config.group).toBe('block');
    });

    it('parses div.confluence-layout-section', () => {
      const parseRules = getParseRules(ConfluenceLayoutSection);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-layout-section' }));
    });
  });

  describe('ConfluenceLayoutCell', () => {
    it('has correct name and group', () => {
      expect(ConfluenceLayoutCell.name).toBe('confluenceLayoutCell');
      expect(ConfluenceLayoutCell.config.group).toBe('block');
    });

    it('parses div.confluence-layout-cell', () => {
      const parseRules = getParseRules(ConfluenceLayoutCell);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-layout-cell' }));
    });

    it('preserves data-cell-width attribute', () => {
      const addAttributes = ConfluenceLayoutCell.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceLayoutCell', options: {}, storage: {}, parent: undefined });
      expect(attrs).toHaveProperty('cellWidth');
      const mockEl = { getAttribute: (name: string) => name === 'data-cell-width' ? '50%' : null } as unknown as HTMLElement;
      expect(attrs.cellWidth.parseHTML(mockEl)).toBe('50%');
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
