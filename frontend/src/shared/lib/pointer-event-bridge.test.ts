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

  it('reports button -1 on a synthesized move but the real button on a down transition', () => {
    stop = installPointerEventBridge(container);
    const moves = collect('pointermove');
    const downs = collect('pointerdown');
    // A move is not a button transition: a real UA reports button === -1 there.
    fireMouse('mousemove', { button: 0, clientX: 4, clientY: 4 });
    // A press IS a transition: the pressed button must be preserved.
    fireMouse('mousedown', { button: 0, clientX: 4, clientY: 4 });
    expect(moves).toHaveLength(1);
    expect(moves[0].button).toBe(-1);
    expect(downs).toHaveLength(1);
    expect(downs[0].button).toBe(0);
  });

  it('copies movementX/movementY onto the synthesized pointermove', () => {
    stop = installPointerEventBridge(container);
    const moves = collect('pointermove');
    fireMouse('mousemove', { movementX: 7, movementY: -3 });
    expect(moves).toHaveLength(1);
    expect(moves[0].movementX).toBe(7);
    expect(moves[0].movementY).toBe(-3);
  });

  it('bridges mouseover/mouseout to pointerover/pointerout', () => {
    stop = installPointerEventBridge(container);
    const overs = collect('pointerover');
    const outs = collect('pointerout');
    fireMouse('mouseover', { clientX: 2, clientY: 2 });
    fireMouse('mouseout', { clientX: 2, clientY: 2 });
    expect(overs).toHaveLength(1);
    expect(overs[0].type).toBe('pointerover');
    expect(outs).toHaveLength(1);
    expect(outs[0].type).toBe('pointerout');
  });

  it('synthesizes exactly one pointercancel from a contextmenu on the target', () => {
    stop = installPointerEventBridge(container);
    const cancels = collect('pointercancel');
    child.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 9, clientY: 3 }),
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0].type).toBe('pointercancel');
    expect(cancels[0].button).toBe(-1);
    expect(cancels[0].clientX).toBe(9);
  });

  it('synthesizes one pointercancel on document.body when the window loses focus', () => {
    stop = installPointerEventBridge(container);
    const cancels: PointerEvent[] = [];
    const onCancel = (e: Event) => cancels.push(e as PointerEvent);
    document.body.addEventListener('pointercancel', onCancel);
    try {
      // A window blur is not a MouseEvent and its target is not an Element, so the
      // cancel is dispatched on document.body with no client coordinates.
      window.dispatchEvent(new Event('blur'));
      expect(cancels).toHaveLength(1);
      expect(cancels[0].type).toBe('pointercancel');
      expect(cancels[0].button).toBe(-1);
    } finally {
      document.body.removeEventListener('pointercancel', onCancel);
    }
  });

  it('shares one ref-counted capture patch across targets: no double-wrap, native restored only after the last teardown', () => {
    const original = Element.prototype.setPointerCapture;
    const throwing = function (this: Element) {
      throw new DOMException('No active pointer with the given id', 'NotFoundError');
    } as typeof original;
    Element.prototype.setPointerCapture = throwing;

    // Two distinct install targets, each with its own child.
    const targetA = document.createElement('div');
    const childA = document.createElement('button');
    targetA.appendChild(childA);
    const targetB = document.createElement('div');
    const childB = document.createElement('button');
    targetB.appendChild(childB);
    document.body.append(targetA, targetB);

    const teardownA = installPointerEventBridge(targetA);
    const teardownB = installPointerEventBridge(targetB);
    try {
      // With both bridges active the prototype is a tolerant wrapper.
      expect(() => childA.setPointerCapture(1)).not.toThrow();

      // Tearing down the FIRST bridge must NOT restore the throwing native — the
      // second bridge still relies on the shared patch.
      teardownA();
      expect(() => childB.setPointerCapture(1)).not.toThrow();

      // Only the LAST teardown restores the native, and it is the EXACT function
      // the bridge replaced — proving it was wrapped once, not once per target.
      teardownB();
      expect(Element.prototype.setPointerCapture).toBe(throwing);
      expect(() => childB.setPointerCapture(1)).toThrow();
    } finally {
      teardownA();
      teardownB();
      Element.prototype.setPointerCapture = original;
      targetA.remove();
      targetB.remove();
    }
  });
});
