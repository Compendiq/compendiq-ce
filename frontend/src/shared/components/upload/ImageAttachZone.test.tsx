import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageAttachZone, imageDisabledReason } from './ImageAttachZone';

const base = {
  model: 'llama3.1',
  image: null,
  onPick: vi.fn(),
  onRemove: vi.fn(),
  isPreparing: false,
};

describe('imageDisabledReason', () => {
  it('is undefined when the model is known vision-capable', () => {
    expect(imageDisabledReason(true, 'qwen2.5vl')).toBeUndefined();
  });

  it('says the model cannot read images when the verdict is false', () => {
    const reason = imageDisabledReason(false, 'llama3.1')!;
    expect(reason).toMatch(/llama3\.1/);
    expect(reason).toMatch(/can't read images/i);
    expect(reason).toMatch(/Settings/);
  });

  /**
   * null is "not established", not "established as no". Reusing the false copy
   * would assert something the server never checked.
   */
  it('says support is unconfirmed when the verdict is null', () => {
    const reason = imageDisabledReason(null, 'llama3.1')!;
    expect(reason).toMatch(/llama3\.1/);
    expect(reason).toMatch(/not confirmed|isn't confirmed/i);
    expect(reason).not.toMatch(/can't read images/i);
  });

  it('gives false and null different text', () => {
    expect(imageDisabledReason(false, 'm')).not.toBe(imageDisabledReason(null, 'm'));
  });
});

describe('ImageAttachZone', () => {
  it('enables the trigger when vision is true', () => {
    render(<ImageAttachZone {...base} vision={true} />);
    expect(screen.getByTestId('image-attach-trigger')).not.toBeDisabled();
  });

  it.each([[false], [null]] as const)('disables the trigger when vision is %s', (vision) => {
    render(<ImageAttachZone {...base} vision={vision} />);
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });

  it('exposes the reason as a title, since the app has no Tooltip primitive', () => {
    render(<ImageAttachZone {...base} vision={false} />);
    expect(screen.getByTestId('image-attach-trigger'))
      .toHaveAttribute('title', expect.stringMatching(/can't read images/i));
  });

  it('renders a thumbnail and dimensions once an image is attached', () => {
    render(<ImageAttachZone {...base} vision={true} image={{
      handle: 'a'.repeat(64), format: 'webp', width: 1568, height: 882,
      fileSize: 240_000, previewUrl: 'blob:preview',
    }} />);
    expect(screen.getByTestId('image-attach-thumb')).toHaveAttribute('src', 'blob:preview');
    expect(screen.getByTestId('image-attach-card')).toHaveTextContent('1568×882');
  });

  it('disables the trigger while preparing', () => {
    render(<ImageAttachZone {...base} vision={true} isPreparing />);
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });

  it('disables the trigger when explicitly disabled', () => {
    render(<ImageAttachZone {...base} vision={true} disabled />);
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });

  it('calls onPick with the selected file', async () => {
    const onPick = vi.fn();
    render(<ImageAttachZone {...base} vision={true} onPick={onPick} />);
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('image-attach-file-input'), { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledWith(file);
  });

  it('resets the input so the same file can be picked twice', async () => {
    // jsdom enforces the real DOM restriction that a file input's `.value` can
    // only ever be programmatically read back as '' (assigning anything else
    // throws), so asserting `input.value === ''` after the change can never
    // fail here — it holds whether or not the component resets anything.
    // Spying on the native setter observes the actual assignment instead.
    const setter = vi.spyOn(window.HTMLInputElement.prototype, 'value', 'set');
    const onPick = vi.fn();
    render(<ImageAttachZone {...base} vision={true} onPick={onPick} />);
    const input = screen.getByTestId('image-attach-file-input') as HTMLInputElement;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(setter).toHaveBeenCalledWith('');
  });

  it('calls onRemove when the remove control is clicked', async () => {
    const onRemove = vi.fn();
    render(<ImageAttachZone {...base} vision={true} onRemove={onRemove} image={{
      handle: 'a'.repeat(64), format: 'webp', width: 1568, height: 882,
      fileSize: 240_000, previewUrl: 'blob:preview',
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
