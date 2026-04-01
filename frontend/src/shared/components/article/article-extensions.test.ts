import { describe, it, expect } from 'vitest';
import { Details, DetailsSummary, Panel, DrawioDiagram, ConfluenceToc, ConfluenceStatus, ConfluenceChildren, ConfluenceAttachments, ConfluenceLayout, ConfluenceLayoutSection, ConfluenceLayoutCell, ConfluenceSection, ConfluenceColumn, UnknownMacro, LAYOUT_PRESETS } from './article-extensions';

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
    it('has correct name and is atomic and draggable', () => {
      expect(DrawioDiagram.name).toBe('drawioDiagram');
      expect(DrawioDiagram.config.atom).toBe(true);
      expect(DrawioDiagram.config.draggable).toBe(true);
    });

    it('parses div.confluence-drawio', () => {
      const parseRules = getParseRules(DrawioDiagram);
      expect(parseRules).toBeDefined();
      expect(parseRules?.[0]).toEqual(expect.objectContaining({ tag: 'div.confluence-drawio' }));
    });

    it('defines xml attribute that reads from data-drawio-xml', () => {
      const addAttributes = DrawioDiagram.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'drawioDiagram', options: {}, storage: {}, parent: undefined });
      expect(attrs).toHaveProperty('xml');
      expect(attrs.xml.default).toBeNull();
      const mockEl = { getAttribute: (name: string) => name === 'data-drawio-xml' ? '<mxGraphModel/>' : null } as unknown as HTMLElement;
      expect(attrs.xml.parseHTML(mockEl)).toBe('<mxGraphModel/>');
    });

    it('renderHTML emits data-drawio-xml when xml is set', () => {
      const addAttributes = DrawioDiagram.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'drawioDiagram', options: {}, storage: {}, parent: undefined });
      const result = attrs.xml.renderHTML({ xml: '<mxGraphModel/>' });
      expect(result).toEqual({ 'data-drawio-xml': '<mxGraphModel/>' });
    });

    it('renderHTML omits data-drawio-xml when xml is null', () => {
      const addAttributes = DrawioDiagram.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'drawioDiagram', options: {}, storage: {}, parent: undefined });
      const result = attrs.xml.renderHTML({ xml: null });
      expect(result).toEqual({});
    });

    it('defines pngDataUri attribute that is not persisted in HTML', () => {
      const addAttributes = DrawioDiagram.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'drawioDiagram', options: {}, storage: {}, parent: undefined });
      expect(attrs).toHaveProperty('pngDataUri');
      expect(attrs.pngDataUri.default).toBeNull();
      // parseHTML always returns null (not persisted)
      const mockEl = {} as HTMLElement;
      expect(attrs.pngDataUri.parseHTML(mockEl)).toBeNull();
      // renderHTML returns empty (not persisted)
      expect(attrs.pngDataUri.renderHTML({ pngDataUri: 'data:image/png;base64,abc' })).toEqual({});
    });

    it('defines insertDrawioDiagram command', () => {
      const addCommands = DrawioDiagram.config.addCommands;
      expect(addCommands).toBeDefined();
      const commands = addCommands?.call({ name: 'drawioDiagram', options: {}, storage: {}, parent: undefined, type: {} });
      expect(commands).toHaveProperty('insertDrawioDiagram');
    });

    it('defines addNodeView for ReactNodeViewRenderer', () => {
      expect(DrawioDiagram.config.addNodeView).toBeDefined();
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

  describe('ConfluenceAttachments', () => {
    it('has correct name and is block atom', () => {
      expect(ConfluenceAttachments.name).toBe('confluenceAttachments');
      expect(ConfluenceAttachments.config.group).toBe('block');
      expect(ConfluenceAttachments.config.atom).toBe(true);
    });

    it('parses div.confluence-attachments-macro', () => {
      const parseRules = getParseRules(ConfluenceAttachments);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-attachments-macro' }));
    });

    it('defines upload and old attributes with defaults', () => {
      const addAttributes = ConfluenceAttachments.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceAttachments', options: {}, storage: {}, parent: undefined });
      expect(attrs).toHaveProperty('upload');
      expect(attrs).toHaveProperty('old');
      expect(attrs.upload.default).toBe('false');
      expect(attrs.old.default).toBe('false');
    });

    it('parseHTML reads data-upload and data-old attributes', () => {
      const addAttributes = ConfluenceAttachments.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceAttachments', options: {}, storage: {}, parent: undefined });
      const mockEl = {
        getAttribute: (name: string) => {
          const map: Record<string, string> = { 'data-upload': 'true', 'data-old': 'false' };
          return map[name] ?? null;
        },
      } as unknown as HTMLElement;
      expect(attrs.upload.parseHTML(mockEl)).toBe('true');
      expect(attrs.old.parseHTML(mockEl)).toBe('false');
    });

    it('parseHTML defaults to false when attributes are missing', () => {
      const addAttributes = ConfluenceAttachments.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceAttachments', options: {}, storage: {}, parent: undefined });
      const mockEl = {
        getAttribute: () => null,
      } as unknown as HTMLElement;
      expect(attrs.upload.parseHTML(mockEl)).toBe('false');
      expect(attrs.old.parseHTML(mockEl)).toBe('false');
    });

    it('defines addNodeView for ReactNodeViewRenderer', () => {
      expect(ConfluenceAttachments.config.addNodeView).toBeDefined();
    });
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

    it('has content spec requiring layout sections', () => {
      expect(ConfluenceLayout.config.content).toBe('confluenceLayoutSection+');
    });

    it('defines layout editing commands', () => {
      const addCommands = ConfluenceLayout.config.addCommands;
      expect(addCommands).toBeDefined();
      const commands = addCommands?.call({ name: 'confluenceLayout', options: {}, storage: {}, parent: undefined, type: {} });
      expect(commands).toHaveProperty('insertLayout');
      expect(commands).toHaveProperty('changeLayoutType');
      expect(commands).toHaveProperty('deleteLayout');
    });
  });

  describe('LAYOUT_PRESETS', () => {
    it('contains 5 presets with expected types', () => {
      expect(LAYOUT_PRESETS).toHaveLength(5);
      const types = LAYOUT_PRESETS.map((p) => p.type);
      expect(types).toContain('two_equal');
      expect(types).toContain('two_left_sidebar');
      expect(types).toContain('two_right_sidebar');
      expect(types).toContain('three_equal');
      expect(types).toContain('three_with_sidebars');
    });

    it('each preset has bars matching its column count', () => {
      for (const preset of LAYOUT_PRESETS) {
        expect(preset.bars.length).toBe(preset.cols);
      }
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

    it('defines data-layout-type attribute', () => {
      const addAttributes = ConfluenceLayoutSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceLayoutSection', options: {}, storage: {}, parent: undefined });
      expect(attrs).toBeDefined();
      expect(attrs).toHaveProperty('data-layout-type');
      expect(attrs['data-layout-type'].default).toBeNull();
    });

    it('parseHTML reads data-layout-type from element', () => {
      const addAttributes = ConfluenceLayoutSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceLayoutSection', options: {}, storage: {}, parent: undefined });
      const layoutTypes = ['two_equal', 'three_equal', 'two_left_sidebar', 'two_right_sidebar', 'single'];
      for (const layoutType of layoutTypes) {
        const mockEl = { getAttribute: (name: string) => name === 'data-layout-type' ? layoutType : null } as unknown as HTMLElement;
        expect(attrs['data-layout-type'].parseHTML(mockEl)).toBe(layoutType);
      }
    });

    it('renderHTML emits data-layout-type when present', () => {
      const addAttributes = ConfluenceLayoutSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceLayoutSection', options: {}, storage: {}, parent: undefined });
      const result = attrs['data-layout-type'].renderHTML({ 'data-layout-type': 'two_equal' });
      expect(result).toEqual({ 'data-layout-type': 'two_equal' });
    });

    it('renderHTML omits data-layout-type when null', () => {
      const addAttributes = ConfluenceLayoutSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceLayoutSection', options: {}, storage: {}, parent: undefined });
      const result = attrs['data-layout-type'].renderHTML({ 'data-layout-type': null });
      expect(result).toEqual({});
    });

    it('has content spec requiring layout cells', () => {
      expect(ConfluenceLayoutSection.config.content).toBe('confluenceLayoutCell+');
    });
  });

  describe('ConfluenceLayoutCell', () => {
    it('has correct name and group', () => {
      expect(ConfluenceLayoutCell.name).toBe('confluenceLayoutCell');
      expect(ConfluenceLayoutCell.config.group).toBe('block');
    });

    it('is isolating', () => {
      expect(ConfluenceLayoutCell.config.isolating).toBe(true);
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

  describe('ConfluenceSection', () => {
    it('has correct name and group', () => {
      expect(ConfluenceSection.name).toBe('confluenceSection');
      expect(ConfluenceSection.config.group).toBe('block');
    });

    it('parses div.confluence-section', () => {
      const parseRules = getParseRules(ConfluenceSection);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-section' }));
    });

    it('defines border attribute', () => {
      const addAttributes = ConfluenceSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceSection', options: {}, storage: {}, parent: undefined });
      expect(attrs).toHaveProperty('border');
      expect(attrs.border.default).toBeNull();
    });

    it('parseHTML reads data-border from element', () => {
      const addAttributes = ConfluenceSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceSection', options: {}, storage: {}, parent: undefined });
      const mockEl = { getAttribute: (name: string) => name === 'data-border' ? 'true' : null } as unknown as HTMLElement;
      expect(attrs.border.parseHTML(mockEl)).toBe('true');
    });

    it('renderHTML emits data-border when present', () => {
      const addAttributes = ConfluenceSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceSection', options: {}, storage: {}, parent: undefined });
      expect(attrs.border.renderHTML({ border: 'true' })).toEqual({ 'data-border': 'true' });
    });

    it('renderHTML omits data-border when null', () => {
      const addAttributes = ConfluenceSection.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceSection', options: {}, storage: {}, parent: undefined });
      expect(attrs.border.renderHTML({ border: null })).toEqual({});
    });

    it('has content spec requiring columns', () => {
      expect(ConfluenceSection.config.content).toBe('confluenceColumn+');
    });

    it('defines editing commands', () => {
      const addCommands = ConfluenceSection.config.addCommands;
      expect(addCommands).toBeDefined();
      const commands = addCommands?.call({ name: 'confluenceSection', options: {}, storage: {}, parent: undefined, type: {} });
      expect(commands).toHaveProperty('insertColumns');
      expect(commands).toHaveProperty('addSectionColumnBefore');
      expect(commands).toHaveProperty('addSectionColumnAfter');
      expect(commands).toHaveProperty('removeSectionColumn');
      expect(commands).toHaveProperty('toggleSectionBorder');
      expect(commands).toHaveProperty('deleteSection');
    });
  });

  describe('ConfluenceColumn', () => {
    it('has correct name and no group', () => {
      expect(ConfluenceColumn.name).toBe('confluenceColumn');
      expect(ConfluenceColumn.config.group).toBeUndefined();
    });

    it('is isolating', () => {
      expect(ConfluenceColumn.config.isolating).toBe(true);
    });

    it('parses div.confluence-column', () => {
      const parseRules = getParseRules(ConfluenceColumn);
      expect(parseRules).toBeDefined();
      expect(parseRules).toContainEqual(expect.objectContaining({ tag: 'div.confluence-column' }));
    });

    it('defines cellWidth attribute', () => {
      const addAttributes = ConfluenceColumn.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceColumn', options: {}, storage: {}, parent: undefined });
      expect(attrs).toHaveProperty('cellWidth');
      expect(attrs.cellWidth.default).toBeNull();
    });

    it('parseHTML reads data-cell-width from element', () => {
      const addAttributes = ConfluenceColumn.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceColumn', options: {}, storage: {}, parent: undefined });
      const mockEl = {
        getAttribute: (name: string) => name === 'data-cell-width' ? '30%' : null,
      } as unknown as HTMLElement;
      expect(attrs.cellWidth.parseHTML(mockEl)).toBe('30%');
    });

    it('parseHTML falls back to extracting width from inline style', () => {
      const addAttributes = ConfluenceColumn.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceColumn', options: {}, storage: {}, parent: undefined });
      const mockEl = {
        getAttribute: (name: string) => {
          if (name === 'data-cell-width') return null;
          if (name === 'style') return 'flex: 0 0 50%';
          return null;
        },
      } as unknown as HTMLElement;
      expect(attrs.cellWidth.parseHTML(mockEl)).toBe('50%');
    });

    it('renderHTML emits data-cell-width and inline style for safe widths', () => {
      const addAttributes = ConfluenceColumn.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceColumn', options: {}, storage: {}, parent: undefined });
      const result = attrs.cellWidth.renderHTML({ cellWidth: '30%' });
      expect(result).toEqual({ 'data-cell-width': '30%', style: 'flex: 0 0 30%' });
    });

    it('renderHTML emits data-cell-width without style for unsafe widths', () => {
      const addAttributes = ConfluenceColumn.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceColumn', options: {}, storage: {}, parent: undefined });
      const result = attrs.cellWidth.renderHTML({ cellWidth: '30%; color: red' });
      expect(result).toEqual({ 'data-cell-width': '30%; color: red' });
    });

    it('renderHTML returns empty object when cellWidth is null', () => {
      const addAttributes = ConfluenceColumn.config.addAttributes;
      const attrs = addAttributes?.call({ name: 'confluenceColumn', options: {}, storage: {}, parent: undefined });
      expect(attrs.cellWidth.renderHTML({ cellWidth: null })).toEqual({});
    });

    it('has content spec requiring blocks', () => {
      expect(ConfluenceColumn.config.content).toBe('block+');
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
