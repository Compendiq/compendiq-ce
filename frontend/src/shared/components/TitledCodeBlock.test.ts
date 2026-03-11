import { describe, it, expect } from 'vitest';
import { TitledCodeBlock } from './TitledCodeBlock';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Helper to extract parseHTML rules from a TipTap extension config
function getParseRules(ext: any) {
  return ext.config.parseHTML?.call({ name: ext.name, options: ext.options, storage: {}, parent: undefined });
}

// Helper to extract addAttributes result, calling parent() to get inherited attrs
function getAttrs(ext: any): Record<string, any> {
  return ext.config.addAttributes?.call({
    name: ext.name,
    options: ext.options ?? {},
    storage: {},
    parent: () => ({ language: { default: null } }),
  }) as Record<string, any>;
}

describe('TitledCodeBlock', () => {
  it('has correct name', () => {
    expect(TitledCodeBlock.name).toBe('codeBlock');
  });

  it('parses <pre> tag', () => {
    const parseRules = getParseRules(TitledCodeBlock);
    expect(parseRules).toBeDefined();
    expect(parseRules?.[0]).toEqual(expect.objectContaining({ tag: 'pre' }));
  });

  it('top-level parseHTML getAttrs extracts data-title', () => {
    const parseRules = getParseRules(TitledCodeBlock);
    expect(parseRules).toBeDefined();
    const rule = parseRules?.[0];
    expect(typeof rule?.getAttrs).toBe('function');

    const mockEl = {
      getAttribute: (name: string) => (name === 'data-title' ? 'docker-compose.yml' : null),
      querySelector: () => null,
    } as unknown as HTMLElement;

    const attrs = rule!.getAttrs(mockEl);
    expect(attrs).toEqual(expect.objectContaining({ title: 'docker-compose.yml' }));
  });

  it('top-level parseHTML getAttrs returns null title when data-title absent', () => {
    const parseRules = getParseRules(TitledCodeBlock);
    const rule = parseRules?.[0];

    const mockEl = {
      getAttribute: () => null,
      querySelector: () => null,
    } as unknown as HTMLElement;

    const attrs = rule!.getAttrs(mockEl);
    expect(attrs).toEqual(expect.objectContaining({ title: null }));
  });

  it('top-level parseHTML getAttrs extracts language from code child class', () => {
    const parseRules = getParseRules(TitledCodeBlock);
    const rule = parseRules?.[0];

    const mockCodeEl = { className: 'language-typescript' };
    const mockEl = {
      getAttribute: () => null,
      querySelector: (sel: string) => (sel === 'code' ? mockCodeEl : null),
    } as unknown as HTMLElement;

    const attrs = rule!.getAttrs(mockEl);
    expect(attrs).toEqual(expect.objectContaining({ language: 'typescript' }));
  });

  it('defines a title attribute with data-title parseHTML', () => {
    const attrs = getAttrs(TitledCodeBlock);
    expect(attrs).toBeDefined();
    expect(attrs).toHaveProperty('title');
    expect(attrs.title).toHaveProperty('default', null);
    expect(typeof attrs.title.parseHTML).toBe('function');
    expect(typeof attrs.title.renderHTML).toBe('function');
  });

  it('inherits language attribute from parent', () => {
    const attrs = getAttrs(TitledCodeBlock);
    expect(attrs).toHaveProperty('language');
  });

  it('parseHTML extracts data-title from element', () => {
    const attrs = getAttrs(TitledCodeBlock);

    // Mock an element with getAttribute
    const mockElement = {
      getAttribute: (name: string) => {
        if (name === 'data-title') return 'docker-compose.yml';
        return null;
      },
    };

    expect(attrs.title.parseHTML(mockElement)).toBe('docker-compose.yml');
  });

  it('parseHTML returns null when data-title is absent', () => {
    const attrs = getAttrs(TitledCodeBlock);

    const mockElement = {
      getAttribute: () => null,
    };

    expect(attrs.title.parseHTML(mockElement)).toBeNull();
  });

  it('renderHTML includes data-title when title is set', () => {
    const attrs = getAttrs(TitledCodeBlock);

    const result = attrs.title.renderHTML({ title: 'config.yaml' });
    expect(result).toEqual({ 'data-title': 'config.yaml' });
  });

  it('renderHTML returns empty object when title is null', () => {
    const attrs = getAttrs(TitledCodeBlock);

    const result = attrs.title.renderHTML({ title: null });
    expect(result).toEqual({});
  });
});
