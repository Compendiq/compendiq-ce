/**
 * Pointer Event bridge.
 *
 * Some input environments — software KVMs (Synergy / Barrier / Deskflow),
 * remote/streamed desktop sessions (VNC / RDP), and certain mouse or trackpad
 * drivers — deliver legacy mouse events (mousedown / mousemove / mouseup /
 * click) but never the corresponding W3C Pointer Events (pointerdown /
 * pointermove / pointerup). That silently breaks every pointerdown-based
 * interaction: Radix menus (open and outside-dismiss), @dnd-kit and TipTap
 * drag, and anything else built on Pointer Events, while plain onClick controls
 * keep working.
 *
 * This bridge synthesizes the missing pointer events from the mouse events it
 * does receive — but ONLY in such environments. A normal mouse dispatches a real
 * pointer event *before* its compatibility mouse event, so the first real
 * (non-synthesized) pointer event of ANY type latches the bridge off and removes
 * its listeners before it could ever double a subsequent event. Touch and pen
 * input, which fire real pointer events, disable it the same way. On
 * environments that never emit pointer events, the bridge stays active for the
 * whole session.
 *
 * Because a synthesized pointer id is not a pointer the user agent is actually
 * tracking, `Element.setPointerCapture(id)` would throw `NotFoundError` for it —
 * which @dnd-kit calls unconditionally at drag start. While active, the bridge
 * therefore makes setPointerCapture / releasePointerCapture tolerate that
 * missing-pointer error (drag still works because @dnd-kit listens on
 * document.body and the synthesized events bubble). Both patches are reverted
 * the instant a real pointer latches the bridge off, so normal input is
 * untouched.
 *
 * Idempotent per target; call once at startup.
 */

const MOUSE_TO_POINTER: Readonly<Record<string, string>> = {
  mousedown: 'pointerdown',
  mousemove: 'pointermove',
  mouseup: 'pointerup',
};

// Marks events this bridge dispatched so its own pointer listeners do not
// mistake a synthesized event for a native one and latch themselves off.
const BRIDGED = '__compendiqBridgedPointerEvent';

// A synthesized pointer is not a real tracked pointer, so capture calls for it
// raise these DOM errors; swallow only those, never a genuine failure.
const MISSING_POINTER_ERRORS = new Set(['NotFoundError', 'InvalidStateError']);

const installedTargets = new WeakSet<EventTarget>();

export function installPointerEventBridge(
  target: Document | Element = typeof document !== 'undefined'
    ? document
    : (undefined as unknown as Document),
): () => void {
  const noop = () => {};
  if (
    typeof window === 'undefined' ||
    typeof PointerEvent === 'undefined' ||
    !target ||
    installedTargets.has(target)
  ) {
    return noop;
  }
  installedTargets.add(target);

  let active = true;

  // Make pointer-capture calls tolerant of our synthesized (untracked) pointers.
  const proto = typeof Element !== 'undefined' ? Element.prototype : undefined;
  const originalSetCapture = proto?.setPointerCapture;
  const originalReleaseCapture = proto?.releasePointerCapture;
  const tolerate = (fn?: (id: number) => void) =>
    fn
      ? function (this: Element, pointerId: number) {
          try {
            return fn.call(this, pointerId);
          } catch (error) {
            if (error instanceof DOMException && MISSING_POINTER_ERRORS.has(error.name)) return;
            throw error;
          }
        }
      : undefined;
  if (proto && originalSetCapture) proto.setPointerCapture = tolerate(originalSetCapture)!;
  if (proto && originalReleaseCapture) proto.releasePointerCapture = tolerate(originalReleaseCapture)!;

  const teardown = () => {
    if (!active) return;
    active = false;
    installedTargets.delete(target);
    if (proto && originalSetCapture) proto.setPointerCapture = originalSetCapture;
    if (proto && originalReleaseCapture) proto.releasePointerCapture = originalReleaseCapture;
    target.removeEventListener('pointerdown', onNativePointer, true);
    target.removeEventListener('pointermove', onNativePointer, true);
    target.removeEventListener('pointerup', onNativePointer, true);
    target.removeEventListener('mousedown', onMouse, true);
    target.removeEventListener('mousemove', onMouse, true);
    target.removeEventListener('mouseup', onMouse, true);
  };

  function onNativePointer(event: Event) {
    // Our own synthesized events carry a marker; ignore them.
    if ((event as unknown as Record<string, unknown>)[BRIDGED]) return;
    // A real pointer event means this environment supports Pointer Events, so the
    // bridge is unnecessary — remove it (and restore the capture patches) to
    // guarantee zero interference with normal input.
    teardown();
  }

  function onMouse(event: Event) {
    const mouse = event as MouseEvent;
    const pointerType = MOUSE_TO_POINTER[mouse.type];
    if (!pointerType) return;
    const node = mouse.target;
    if (!(node instanceof Element)) return;

    const pointer = new PointerEvent(pointerType, {
      bubbles: true,
      cancelable: true,
      composed: true,
      // A single logical mouse pointer.
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: mouse.buttons ? 0.5 : 0,
      button: mouse.button,
      buttons: mouse.buttons,
      clientX: mouse.clientX,
      clientY: mouse.clientY,
      screenX: mouse.screenX,
      screenY: mouse.screenY,
      ctrlKey: mouse.ctrlKey,
      shiftKey: mouse.shiftKey,
      altKey: mouse.altKey,
      metaKey: mouse.metaKey,
    });
    (pointer as unknown as Record<string, unknown>)[BRIDGED] = true;
    node.dispatchEvent(pointer);
  }

  target.addEventListener('pointerdown', onNativePointer, true);
  target.addEventListener('pointermove', onNativePointer, true);
  target.addEventListener('pointerup', onNativePointer, true);
  target.addEventListener('mousedown', onMouse, true);
  target.addEventListener('mousemove', onMouse, true);
  target.addEventListener('mouseup', onMouse, true);

  return teardown;
}
