/**
 * Dedicated remote-caret palette (#1447). Not Steel, not status hues, not AI
 * violet — those already mean interaction, pipeline state, warning, and AI.
 * Each swatch is measured ≥3:1 against Graphite and Paper `--surface-card`
 * in collab-caret-contrast.test.ts.
 */
export const COLLAB_CARET_PALETTE = [
  '#5C6B8A', // slate
  '#3F6F64', // teal
  '#8A5A3C', // terracotta
  '#7A6238', // bronze
  '#C45C26', // burnt orange
  '#9A4A6B', // dusty rose
  '#7B5A8B', // muted purple
  '#3D7A80', // ocean
  '#6B6B2B', // olive
  '#A0522D', // sienna
] as const;

export type CollabCaretColor = (typeof COLLAB_CARET_PALETTE)[number];

/** Same 31-imul the gateway uses so a user keeps one colour across awareness and chips. */
export function caretColorForUserId(userId: string): CollabCaretColor {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = Math.imul(h, 31) + userId.charCodeAt(i);
  }
  const index = Math.abs(h) % COLLAB_CARET_PALETTE.length;
  return COLLAB_CARET_PALETTE[index] ?? COLLAB_CARET_PALETTE[0];
}

function colorForAwarenessUser(user: Record<string, unknown>): string {
  if (typeof user.id === 'string' && user.id.length > 0) {
    return caretColorForUserId(user.id);
  }
  if (typeof user.color === 'string' && user.color.length > 0) {
    return user.color;
  }
  return COLLAB_CARET_PALETTE[0];
}

function nameForAwarenessUser(user: Record<string, unknown>): string {
  return typeof user.name === 'string' && user.name.trim().length > 0
    ? user.name
    : 'Collaborator';
}

/** TipTap CollaborationCaret `render` — chip uses pane ink, 1px hairline, no lift. */
export function renderCollabCaret(user: Record<string, unknown>): HTMLElement {
  const color = colorForAwarenessUser(user);
  const caret = document.createElement('span');
  caret.className = 'collaboration-carets__caret';
  caret.style.setProperty('--collab-caret-color', color);
  caret.style.borderColor = color;
  if (typeof user.id === 'string') caret.dataset.userId = user.id;

  const label = document.createElement('span');
  label.className = 'collaboration-carets__label';
  label.style.backgroundColor = color;
  label.textContent = nameForAwarenessUser(user);
  caret.append(label);
  return caret;
}

/** Selection overlay: tint of the same caret colour, never a status hue. */
export function selectionRenderCollab(user: Record<string, unknown>): {
  nodeName: string;
  class: string;
  style: string;
  'data-user': string;
} {
  const color = colorForAwarenessUser(user);
  return {
    nodeName: 'span',
    class: 'collaboration-carets__selection',
    style: `background-color: color-mix(in srgb, ${color} 28%, transparent)`,
    'data-user': nameForAwarenessUser(user),
  };
}
