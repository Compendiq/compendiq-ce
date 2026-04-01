import { describe, it, expect, vi } from 'vitest';
import { VimExtension, VIM_PLUGIN_KEY, type VimMode, type VimState } from './vim-extension';

describe('VimExtension', () => {
  it('exports the extension with name "vim"', () => {
    const ext = VimExtension.configure({});
    expect(ext.name).toBe('vim');
  });

  it('has the correct default options', () => {
    const ext = VimExtension.configure({});
    expect(ext.options.onModeChange).toBeUndefined();
    expect(ext.options.onSave).toBeUndefined();
    expect(ext.options.onStateChange).toBeUndefined();
  });

  it('accepts callbacks via configure', () => {
    const onModeChange = vi.fn();
    const onSave = vi.fn();
    const onStateChange = vi.fn();
    const ext = VimExtension.configure({ onModeChange, onSave, onStateChange });
    expect(ext.options.onModeChange).toBe(onModeChange);
    expect(ext.options.onSave).toBe(onSave);
    expect(ext.options.onStateChange).toBe(onStateChange);
  });

  it('exports VIM_PLUGIN_KEY', () => {
    expect(VIM_PLUGIN_KEY).toBeDefined();
    expect(VIM_PLUGIN_KEY.key).toContain('vim');
  });

  it('creates ProseMirror plugins', () => {
    const ext = VimExtension.configure({});
    // The extension should have addProseMirrorPlugins
    expect(ext.config.addProseMirrorPlugins).toBeDefined();
  });
});

describe('VimMode type', () => {
  it('allows valid mode values', () => {
    const normal: VimMode = 'normal';
    const insert: VimMode = 'insert';
    const visual: VimMode = 'visual';
    expect(normal).toBe('normal');
    expect(insert).toBe('insert');
    expect(visual).toBe('visual');
  });
});

describe('VimState type', () => {
  it('can construct a valid VimState', () => {
    const state: VimState = {
      mode: 'normal',
      pendingKeys: '',
      countPrefix: '',
      register: '',
      commandBuffer: null,
    };
    expect(state.mode).toBe('normal');
    expect(state.pendingKeys).toBe('');
    expect(state.countPrefix).toBe('');
    expect(state.register).toBe('');
    expect(state.commandBuffer).toBeNull();
  });

  it('can represent a command buffer state', () => {
    const state: VimState = {
      mode: 'normal',
      pendingKeys: '',
      countPrefix: '',
      register: '',
      commandBuffer: 'w',
    };
    expect(state.commandBuffer).toBe('w');
  });

  it('can represent pending operator state', () => {
    const state: VimState = {
      mode: 'normal',
      pendingKeys: 'd',
      countPrefix: '3',
      register: 'some text',
      commandBuffer: null,
    };
    expect(state.pendingKeys).toBe('d');
    expect(state.countPrefix).toBe('3');
    expect(state.register).toBe('some text');
  });
});
