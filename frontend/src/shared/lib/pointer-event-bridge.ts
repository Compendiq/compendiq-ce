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
 * document.body and the synthesized events bubble). The prototype patch is
 * shared and ref-counted across every install target, so it is wrapped exactly
 * once no matter how many bridges are installed and the true native is restored
 * only when the last bridge tears down (in production there is one target —
 * `document` — so latch-off restores it immediately). Normal input is untouched.
 *
 * Idempotent per target; call once at startup.
 */

const MOUSE_TO_POINTER: Readonly<Record<string, string>> = {
  mousedown: 'pointerdown',
  mousemove: 'pointermove',
  mouseup: 'pointerup',
  mouseover: 'pointerover',
  mouseout: 'pointerout',
};

// Marks events this bridge dispatched so its own pointer listeners do not
// mistake a synthesized event for a native one and latch themselves off.
const BRIDGED = '__compendiqBridgedPointerEvent';

// A synthesized pointer is not a real tracked pointer, so capture calls for it
// raise these DOM errors; swallow only those, never a genuine failure.
const MISSING_POINTER_ERRORS = new Set(['NotFoundError', 'InvalidStateError']);

const installedTargets = new WeakSet<EventTarget>();

type CaptureFn = (this: Element, pointerId: number) => void;

// Wrap a pointer-capture method so it tolerates the missing-pointer errors our
// synthesized (untracked) pointer id raises, while re-throwing any genuine
// failure. Hoisted to module scope so a single shared wrapper is applied to the
// prototype regardless of how many bridge targets are installed.
function tolerate(fn: CaptureFn): CaptureFn {
  return function (this: Element, pointerId: number) {
    try {
      return fn.call(this, pointerId);
    } catch (error) {
      if (error instanceof DOMException && MISSING_POINTER_ERRORS.has(error.name)) return;
      throw error;
    }
  };
}

// The prototype capture patch is shared across every install target and applied
// exactly once, ref-counted so the true native is restored only when the LAST
// bridge tears down. Installing on N targets must not wrap the native N times:
// each extra wrap would nest another try/catch, and — worse — a mid-life restore
// by one target would strip the patch the other still-active targets rely on.
let capturePatchRefCount = 0;
let sharedOriginalSetCapture: CaptureFn | undefined;
let sharedOriginalReleaseCapture: CaptureFn | undefined;

function patchPointerCapture(): void {
  // Only the first bridge (0 -> 1) reads the real natives and installs wrappers;
  // every later install just bumps the count.
  if (capturePatchRefCount++ > 0) return;
  const proto = typeof Element !== 'undefined' ? Element.prototype : undefined;
  if (!proto) return;
  sharedOriginalSetCapture = proto.setPointerCapture;
  sharedOriginalReleaseCapture = proto.releasePointerCapture;
  if (sharedOriginalSetCapture) proto.setPointerCapture = tolerate(sharedOriginalSetCapture);
  if (sharedOriginalReleaseCapture) proto.releasePointerCapture = tolerate(sharedOriginalReleaseCapture);
}

function unpatchPointerCapture(): void {
  if (capturePatchRefCount === 0) return;
  // Only the last bridge (1 -> 0) restores the natives; earlier teardowns just
  // decrement so the wrapper stays in place for the targets still active.
  if (--capturePatchRefCount > 0) return;
  const proto = typeof Element !== 'undefined' ? Element.prototype : undefined;
  if (proto) {
    if (sharedOriginalSetCapture) proto.setPointerCapture = sharedOriginalSetCapture;
    if (sharedOriginalReleaseCapture) proto.releasePointerCapture = sharedOriginalReleaseCapture;
  }
  sharedOriginalSetCapture = undefined;
  sharedOriginalReleaseCapture = undefined;
}

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

  const teardown = () => {
    if (!active) return;
    active = false;
    installedTargets.delete(target);
    unpatchPointerCapture();
    target.removeEventListener('pointerdown', onNativePointer, true);
    target.removeEventListener('pointermove', onNativePointer, true);
    target.removeEventListener('pointerup', onNativePointer, true);
    target.removeEventListener('pointerover', onNativePointer, true);
    target.removeEventListener('pointerout', onNativePointer, true);
    target.removeEventListener('pointercancel', onNativePointer, true);
    target.removeEventListener('mousedown', onMouse, true);
    target.removeEventListener('mousemove', onMouse, true);
    target.removeEventListener('mouseup', onMouse, true);
    target.removeEventListener('mouseover', onMouse, true);
    target.removeEventListener('mouseout', onMouse, true);
    target.removeEventListener('contextmenu', onCancel, true);
    window.removeEventListener('blur', onCancel, true);
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

    // `button` is only meaningful on a button transition (down/up); a move or
    // over/out reports -1 ("no change"), matching a real user agent. Passing the
    // last-pressed button on a plain move would misreport a phantom press.
    const isTransition = pointerType === 'pointerdown' || pointerType === 'pointerup';

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
      button: isTransition ? mouse.button : -1,
      buttons: mouse.buttons,
      clientX: mouse.clientX,
      clientY: mouse.clientY,
      screenX: mouse.screenX,
      screenY: mouse.screenY,
      movementX: mouse.movementX,
      movementY: mouse.movementY,
      ctrlKey: mouse.ctrlKey,
      shiftKey: mouse.shiftKey,
      altKey: mouse.altKey,
      metaKey: mouse.metaKey,
    });
    // offsetX/offsetY, pageX/pageY and `view` are NOT settable through the
    // PointerEvent/MouseEvent constructor (jsdom rejects `view: window`), so they
    // stay at their 0/null defaults on the synthesized event by design.
    (pointer as unknown as Record<string, unknown>)[BRIDGED] = true;
    node.dispatchEvent(pointer);
  }

  // Synthesize a pointercancel when the interaction is interrupted the way a real
  // user agent would fire one: an OS context menu (right-click) or the window
  // losing focus. Without it, a drag/press started via synthesized events could
  // be left dangling because its natural cancel signal never arrives.
  function onCancel(event: Event) {
    const source = event instanceof MouseEvent ? event : undefined;
    const cancel = new PointerEvent('pointercancel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: 0,
      button: -1,
      buttons: 0,
      clientX: source ? source.clientX : 0,
      clientY: source ? source.clientY : 0,
    });
    (cancel as unknown as Record<string, unknown>)[BRIDGED] = true;
    const node = event.target instanceof Element ? event.target : document.body;
    node.dispatchEvent(cancel);
  }

  patchPointerCapture();

  target.addEventListener('pointerdown', onNativePointer, true);
  target.addEventListener('pointermove', onNativePointer, true);
  target.addEventListener('pointerup', onNativePointer, true);
  target.addEventListener('pointerover', onNativePointer, true);
  target.addEventListener('pointerout', onNativePointer, true);
  target.addEventListener('pointercancel', onNativePointer, true);
  target.addEventListener('mousedown', onMouse, true);
  target.addEventListener('mousemove', onMouse, true);
  target.addEventListener('mouseup', onMouse, true);
  target.addEventListener('mouseover', onMouse, true);
  target.addEventListener('mouseout', onMouse, true);
  // contextmenu bubbles to the target; window blur only fires on window, so it
  // must be registered there (and removed there) rather than on `target`.
  target.addEventListener('contextmenu', onCancel, true);
  window.addEventListener('blur', onCancel, true);

  return teardown;
}
