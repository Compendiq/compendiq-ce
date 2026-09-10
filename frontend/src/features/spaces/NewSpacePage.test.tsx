import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewSpacePage } from './NewSpacePage';
import { SPACE_ICONS } from '../../shared/components/spaces/space-icons';

const mockNavigate = vi.fn();
const mockMutateAsync = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../shared/hooks/use-standalone', () => ({
  useCreateLocalSpace: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NewSpacePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NewSpacePage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockMutateAsync.mockClear();
  });

  it('renders the create space form', () => {
    renderPage();
    expect(screen.getByText('Create Local Space')).toBeInTheDocument();
    expect(screen.getByLabelText('Space Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Space Key')).toBeInTheDocument();
  });

  it('auto-generates key from name', () => {
    renderPage();
    const nameInput = screen.getByLabelText('Space Name');
    fireEvent.change(nameInput, { target: { value: 'My Engineering Docs' } });

    const keyInput = screen.getByLabelText('Space Key') as HTMLInputElement;
    expect(keyInput.value).toBe('MY_ENGINEERING_DOCS');
  });

  it('allows manual key override', () => {
    renderPage();
    const nameInput = screen.getByLabelText('Space Name');
    fireEvent.change(nameInput, { target: { value: 'My Docs' } });

    const keyInput = screen.getByLabelText('Space Key');
    fireEvent.change(keyInput, { target: { value: 'CUSTOM_KEY' } });

    // Now changing name should not override the manually set key
    fireEvent.change(nameInput, { target: { value: 'Updated Name' } });
    expect((keyInput as HTMLInputElement).value).toBe('CUSTOM_KEY');
  });

  it('submits the form and navigates on success', async () => {
    mockMutateAsync.mockResolvedValueOnce({ key: 'TEST', name: 'Test' });
    renderPage();

    const nameInput = screen.getByLabelText('Space Name');
    fireEvent.change(nameInput, { target: { value: 'Test Space' } });

    const submitButton = screen.getByText('Create Space');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        key: 'TEST_SPACE',
        name: 'Test Space',
        description: undefined,
      });
    });
  });

  it('has a cancel button that navigates back', () => {
    renderPage();
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('has a back button', () => {
    renderPage();
    fireEvent.click(screen.getByText('Back'));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('disables submit when name or key is empty', () => {
    renderPage();
    const submitButton = screen.getByText('Create Space');
    expect(submitButton).toBeDisabled();
  });

  it('allows selecting an icon and passes it to the mutation', async () => {
    mockMutateAsync.mockResolvedValueOnce({ key: 'TEST_SPACE', name: 'Test Space' });
    renderPage();

    const nameInput = screen.getByLabelText('Space Name');
    fireEvent.change(nameInput, { target: { value: 'Test Space' } });

    // Select the "Code" icon
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));

    const submitButton = screen.getByText('Create Space');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        key: 'TEST_SPACE',
        name: 'Test Space',
        description: undefined,
        icon: 'code',
      });
    });
  });

  it('renders a real glyph and an accessible name for every icon option', () => {
    // The picker used to render label text only — svg count was 0 across all
    // ten options, so users picked an icon by reading its name.
    renderPage();
    for (const { value, label } of SPACE_ICONS) {
      const option = screen.getByRole('button', { name: label });
      expect(
        option.querySelector(`svg.lucide-${value}`),
        `option "${label}" should render the ${value} glyph`,
      ).not.toBeNull();
      expect(option).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('names the picker group and gives options the interactive treatment', () => {
    renderPage();
    // Same recipe as LoginVariantPicker: a named group, and operable surfaces
    // carrying the interactive border (never the quiet hairline) plus an
    // explicit focus-visible outline.
    const group = screen.getByRole('group', { name: 'Space icon' });
    const options = within(group).getAllByRole('button');
    expect(options).toHaveLength(SPACE_ICONS.length);
    for (const option of options) {
      expect(option.className).toContain('focus-visible:outline');
      expect(option.className).toMatch(/border-(border-interactive|action)\b/);
    }
  });

  it('exposes selection via aria-pressed and deselects on second click', () => {
    renderPage();
    const codeButton = screen.getByRole('button', { name: 'Code' });

    // Select — icon selection is non-AI chrome (Task 5 — amber reserved for AI affordances).
    fireEvent.click(codeButton);
    expect(codeButton).toHaveAttribute('aria-pressed', 'true');
    expect(codeButton.className).toContain('border-action');

    // Deselect
    fireEvent.click(codeButton);
    expect(codeButton).toHaveAttribute('aria-pressed', 'false');
    expect(codeButton.className).not.toContain('border-action');
  });
});
