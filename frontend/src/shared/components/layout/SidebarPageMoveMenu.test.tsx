import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { SidebarPageMoveMenu } from './SidebarPageMoveMenu';
import type { MoveTarget } from './sidebar-tree-move';

const targets: MoveTarget[] = [
  { id: 'a', title: 'Alpha', depth: 0 },
  { id: 'b', title: 'Bravo', depth: 0 },
  { id: 'b1', title: 'Bravo child', depth: 1 },
];

function renderMenu(overrides: Partial<ComponentProps<typeof SidebarPageMoveMenu>> = {}) {
  const onOpenChange = vi.fn();
  const onMove = vi.fn();
  render(
    <SidebarPageMoveMenu
      open
      onOpenChange={onOpenChange}
      pageTitle="Charlie"
      parentId={null}
      targets={targets}
      onMove={onMove}
      {...overrides}
    >
      <button type="button">grip</button>
    </SidebarPageMoveMenu>,
  );
  return { onOpenChange, onMove };
}

describe('SidebarPageMoveMenu', () => {
  it('lists nest targets and commits a move into one', () => {
    const { onMove, onOpenChange } = renderMenu();
    fireEvent.click(screen.getByTestId('sidebar-move-target-b'));
    expect(onMove).toHaveBeenCalledWith('b');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('hides move to top level for a root page', () => {
    renderMenu({ parentId: null });
    expect(screen.queryByTestId('sidebar-move-to-root')).not.toBeInTheDocument();
  });

  it('moves to top level when that action is chosen', () => {
    const { onMove } = renderMenu({ parentId: 'a' });
    fireEvent.click(screen.getByTestId('sidebar-move-to-root'));
    expect(onMove).toHaveBeenCalledWith(null);
  });

  it('hides search until the list is long, then filters by title', () => {
    renderMenu();
    expect(screen.queryByTestId('sidebar-move-search')).not.toBeInTheDocument();

    cleanup();
    const many: MoveTarget[] = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      title: i === 3 ? 'Needle page' : `Page ${i}`,
      depth: 0,
    }));
    renderMenu({ targets: many });
    fireEvent.change(screen.getByTestId('sidebar-move-search'), { target: { value: 'needle' } });
    expect(screen.getByTestId('sidebar-move-target-p3')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-move-target-p0')).not.toBeInTheDocument();
  });

  it('names an empty space and an empty search differently', () => {
    renderMenu({ targets: [] });
    expect(screen.getByTestId('sidebar-move-empty')).toHaveTextContent(/no other pages/i);

    cleanup();
    const many: MoveTarget[] = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      title: `Page ${i}`,
      depth: 0,
    }));
    renderMenu({ targets: many });
    fireEvent.change(screen.getByTestId('sidebar-move-search'), { target: { value: 'zzzz' } });
    expect(screen.getByTestId('sidebar-move-empty')).toHaveTextContent(/no pages matching/i);
  });
});
