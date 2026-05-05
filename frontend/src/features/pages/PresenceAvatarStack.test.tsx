import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { PresenceAvatarStack } from './PresenceAvatarStack';
import type { PresenceViewer } from './use-presence';

function wrap(ui: React.ReactElement) {
  return render(<LazyMotion features={domAnimation}>{ui}</LazyMotion>);
}

const alice: PresenceViewer = { userId: 'u1', name: 'Alice', role: 'editor', isEditing: true };
const bob: PresenceViewer = { userId: 'u2', name: 'Bob', role: 'viewer', isEditing: false };
const carol: PresenceViewer = { userId: 'u3', name: 'Carol', role: 'viewer', isEditing: false };
const dave: PresenceViewer = { userId: 'u4', name: 'Dave', role: 'viewer', isEditing: false };
const eve: PresenceViewer = { userId: 'u5', name: 'Eve', role: 'admin', isEditing: true };

describe('PresenceAvatarStack', () => {
  it('renders nothing when there are no viewers', () => {
    wrap(<PresenceAvatarStack viewers={[]} />);
    expect(screen.queryByTestId('presence-avatar-stack')).toBeNull();
  });

  it('renders all viewers when count <= maxVisible', () => {
    wrap(<PresenceAvatarStack viewers={[alice, bob]} />);
    expect(screen.getAllByTestId('presence-avatar')).toHaveLength(2);
    expect(screen.queryByTestId('presence-overflow')).toBeNull();
  });

  it('collapses to +N chip above maxVisible', () => {
    wrap(<PresenceAvatarStack viewers={[alice, bob, carol, dave, eve]} />);
    expect(screen.getAllByTestId('presence-avatar')).toHaveLength(3);
    expect(screen.getByTestId('presence-overflow').textContent).toBe('+2');
  });

  it('shows pencil badge only on editors', () => {
    wrap(<PresenceAvatarStack viewers={[alice, bob]} />);
    const badges = screen.getAllByTestId('presence-editing-badge');
    expect(badges).toHaveLength(1);
    const editingAvatar = screen.getByText('Alice').closest('[data-testid="presence-avatar"]');
    expect(editingAvatar?.getAttribute('data-is-editing')).toBe('true');
  });

  it('renders viewers in the order passed (caller sorts)', () => {
    wrap(<PresenceAvatarStack viewers={[alice, bob, carol]} />);
    const avatars = screen.getAllByTestId('presence-avatar');
    expect(avatars[0]?.getAttribute('data-user-id')).toBe('u1');
    expect(avatars[1]?.getAttribute('data-user-id')).toBe('u2');
    expect(avatars[2]?.getAttribute('data-user-id')).toBe('u3');
  });

  it('shows tooltip with name and role via title attribute', () => {
    wrap(<PresenceAvatarStack viewers={[alice, bob]} />);
    const aliceAvatar = screen.getAllByTestId('presence-avatar')[0];
    expect(aliceAvatar?.getAttribute('title')).toContain('Alice');
    expect(aliceAvatar?.getAttribute('title')).toContain('editor');
    expect(aliceAvatar?.getAttribute('title')).toContain('editing');
    const bobAvatar = screen.getAllByTestId('presence-avatar')[1];
    expect(bobAvatar?.getAttribute('title')).toContain('Bob');
    expect(bobAvatar?.getAttribute('title')).not.toContain('editing');
  });

  it('respects custom maxVisible', () => {
    wrap(<PresenceAvatarStack viewers={[alice, bob, carol, dave]} maxVisible={2} />);
    expect(screen.getAllByTestId('presence-avatar')).toHaveLength(2);
    expect(screen.getByTestId('presence-overflow').textContent).toBe('+2');
  });
});
