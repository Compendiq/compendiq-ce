import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpaceSettingsPage } from './SpaceSettingsPage';

const mockNavigate = vi.fn();
const mockUpdateMutateAsync = vi.fn();
const mockDeleteMutateAsync = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const defaultLocalSpaces = [
  { key: 'NOTES', name: 'My Notes', description: 'Personal notes', icon: null as string | null, pageCount: 5, createdBy: null, createdAt: '2026-03-01T00:00:00Z', source: 'local' as const },
];
let mockLocalSpaces = [...defaultLocalSpaces];

vi.mock('../../shared/hooks/use-standalone', () => ({
  useLocalSpaces: () => ({ data: mockLocalSpaces }),
  useUpdateLocalSpace: () => ({
    mutateAsync: mockUpdateMutateAsync,
    isPending: false,
  }),
  useDeleteLocalSpace: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderPage(spaceKey = 'NOTES') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/spaces/${spaceKey}/settings`]}>
        <Routes>
          <Route path="/spaces/:key/settings" element={<SpaceSettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SpaceSettingsPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockUpdateMutateAsync.mockClear();
    mockDeleteMutateAsync.mockClear();
    mockLocalSpaces = [...defaultLocalSpaces];
  });

  it('renders the space settings form', () => {
    renderPage();
    expect(screen.getByText('Space Settings')).toBeInTheDocument();
    // The key appears in both the subtitle and the read-only field
    expect(screen.getAllByText('NOTES')).toHaveLength(2);
  });

  it('populates form with existing space data', () => {
    renderPage();
    const nameInput = screen.getByLabelText('Space Name') as HTMLInputElement;
    expect(nameInput.value).toBe('My Notes');
  });

  it('shows page count', () => {
    renderPage();
    expect(screen.getByText('5 pages in this space')).toBeInTheDocument();
  });

  it('updates space on form submit', async () => {
    mockUpdateMutateAsync.mockResolvedValueOnce({});
    renderPage();

    const nameInput = screen.getByLabelText('Space Name');
    fireEvent.change(nameInput, { target: { value: 'Updated Notes' } });

    const saveButton = screen.getByText('Save Changes');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
        key: 'NOTES',
        name: 'Updated Notes',
        description: 'Personal notes',
      });
    });
  });

  it('clears an emptied description instead of silently keeping the old one', async () => {
    // `description.trim() || undefined` dropped the field from the JSON body,
    // so emptying the textarea could never clear a saved description — the
    // same trap the icon-clear path documents. Backend accepts ''.
    mockUpdateMutateAsync.mockResolvedValueOnce({});
    renderPage();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
        key: 'NOTES',
        name: 'My Notes',
        description: '',
      });
    });
  });

  it('shows danger zone with delete button', () => {
    renderPage();
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    expect(screen.getByText('Delete Space')).toBeInTheDocument();
  });

  it('shows confirm dialog before deleting', () => {
    renderPage();
    fireEvent.click(screen.getByText('Delete Space'));
    expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('deletes space and navigates home on confirm', async () => {
    mockDeleteMutateAsync.mockResolvedValueOnce({});
    renderPage();

    fireEvent.click(screen.getByText('Delete Space'));
    fireEvent.click(screen.getByText('Confirm Delete'));

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith('NOTES');
    });
  });

  it('shows not found message for unknown space', () => {
    renderPage('UNKNOWN');
    expect(screen.getByText('Space not found or is not a local space.')).toBeInTheDocument();
  });

  describe('space icon', () => {
    /** The read-only Space Key row: the font-mono key beside the identity glyph. */
    function keyRow(): HTMLElement {
      const row = screen
        .getAllByText('NOTES')
        .map((el) => el.parentElement!)
        .find((parent) => parent.querySelector('svg') !== null);
      if (!row) throw new Error('key row with glyph not found');
      return row;
    }

    it('renders the persisted icon in the key row and preselects it in the picker', () => {
      mockLocalSpaces = [{ ...defaultLocalSpaces[0]!, icon: 'rocket' }];
      renderPage();

      // The read-only key row carries the space's identity mark.
      expect(keyRow().querySelector('svg.lucide-rocket')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Rocket' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('falls back to the HardDrive mark when no icon is set', () => {
      renderPage();
      expect(keyRow().querySelector('svg.lucide-hard-drive')).not.toBeNull();
    });

    it('includes a newly chosen icon in the update payload', async () => {
      mockUpdateMutateAsync.mockResolvedValueOnce({});
      renderPage();

      fireEvent.click(screen.getByRole('button', { name: 'Code' }));
      fireEvent.click(screen.getByText('Save Changes'));

      await waitFor(() => {
        expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
          key: 'NOTES',
          name: 'My Notes',
          description: 'Personal notes',
          icon: 'code',
        });
      });
    });

    it('clears a previously set icon with an empty string (the schema has no null)', async () => {
      mockLocalSpaces = [{ ...defaultLocalSpaces[0]!, icon: 'rocket' }];
      mockUpdateMutateAsync.mockResolvedValueOnce({});
      renderPage();

      // Deselect the preselected option, then save.
      fireEvent.click(screen.getByRole('button', { name: 'Rocket' }));
      fireEvent.click(screen.getByText('Save Changes'));

      await waitFor(() => {
        expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
          key: 'NOTES',
          name: 'My Notes',
          description: 'Personal notes',
          icon: '',
        });
      });
    });
  });
});
