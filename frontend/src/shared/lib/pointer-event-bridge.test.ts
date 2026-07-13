import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { installPointerEventBridge } from './pointer-event-bridge';

describe('installPointerEventBridge', () => {
  let container: HTMLDivElement;
  let child: HTMLButtonElement;
  let stop: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    child = document.createElement('button');
    container.appendChild(child);
    document.body.appendChild(container);
    stop = () => {};
  });

  afterEach(() => {
    stop();
    container.remove();
  });

  function fireMouse(type: string, init: MouseEventInit = {}) {
    child.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  }
  function collect(type: string): PointerEvent[] {
    const events: PointerEvent[] = [];
    child.addEventListener(type, (e) => events.push(e as PointerEvent));
    return events;
  }

  it('synthesizes a pointerdown from a mousedown when no native pointerdown fired', () => {
    stop = installPointerEventBridge(container);
    const pointerdowns = collect('pointerdown');
    fireMouse('mousedown', { button: 0, clientX: 5, clientY: 7 });
    expect(pointerdowns).toHaveLength(1);
    expect(pointerdowns[0].type).toBe('pointerdown');
    expect(pointerdowns[0].pointerType).toBe('mouse');
    expect(pointerdowns[0].button).toBe(0);
    expect(pointerdowns[0].clientX).toBe(5);
    expect(pointerdowns[0].clientY).toBe(7);
  });

  it('bridges mousemove and mouseup to pointermove and pointerup', () => {
    stop = installPointerEventBridge(container);
    const moves = collect('pointermove');
    const ups = collect('pointerup');
    fireMouse('mousemove', { clientX: 1, clientY: 2 });
    fireMouse('mouseup', { button: 0 });
    expect(moves).toHaveLength(1);
    expect(ups).toHaveLength(1);
  });

  it('latches off once a native pointerdown is observed (no double events for real input)', () => {
    stop = installPointerEventBridge(container);
    const pointerdowns = collect('pointerdown');
    // A real, non-synthesized pointerdown means the environment supports pointer
    // events; the bridge must disable itself and never synthesize again.
    child.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(pointerdowns).toHaveLength(1); // the native one only
    fireMouse('mousedown', { button: 0 });
    expect(pointerdowns).toHaveLength(1); // no synthesized addition
  });

  it('does not mistake its own synthesized pointerdown for a native one', () => {
    stop = installPointerEventBridge(container);
    const pointerdowns = collect('pointerdown');
    fireMouse('mousedown', { button: 0 });
    fireMouse('mousedown', { button: 0 });
    // Both bridged: the first synthesized pointerdown must not latch the bridge off.
    expect(pointerdowns).toHaveLength(2);
  });

  it('stops synthesizing after teardown', () => {
    const teardown = installPointerEventBridge(container);
    const pointerdowns = collect('pointerdown');
    teardown();
    fireMouse('mousedown', { button: 0 });
    expect(pointerdowns).toHaveLength(0);
  });

  it('latches off on ANY native pointer event, not just pointerdown', () => {
    // A native pointermove means the environment supports pointer events, so the
    // bridge must stop before it can double any subsequent pointermove/up.
    stop = installPointerEventBridge(container);
    const moves = collect('pointermove');
    child.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    expect(moves).toHaveLength(1); // the native one
    fireMouse('mousemove', { clientX: 3, clientY: 3 });
    expect(moves).toHaveLength(1); // no synthesized duplicate
  });

  it('swallows the missing-pointer error from setPointerCapture while active and restores it on teardown', () => {
    const original = Element.prototype.setPointerCapture;
    // A real browser throws NotFoundError when capturing a pointer id it is not
    // tracking (as it would for our synthesized pointer). jsdom does not, so
    // install a throwing stub to exercise the tolerance path deterministically.
    const throwing = function (this: Element) {
      throw new DOMException('No active pointer with the given id', 'NotFoundError');
    };
    Element.prototype.setPointerCapture = throwing as typeof original;
    try {
      const teardown = installPointerEventBridge(container);
      expect(() => child.setPointerCapture(1)).not.toThrow();
      teardown();
      // The bridge restored exactly what it replaced.
      expect(Element.prototype.setPointerCapture).toBe(throwing);
    } finally {
      Element.prototype.setPointerCapture = original;
    }
  });
});
