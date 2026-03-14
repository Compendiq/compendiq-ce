import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationPreferences } from './NotificationPreferences';

let mockApiFetch: ReturnType<typeof vi.fn>;

vi.mock('../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const defaultPrefs = {
  comment: true,
  mention: true,
  verification_due: true,
  sync_complete: true,
  general: true,
};

function renderPrefs() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationPreferences />
    </QueryClientProvider>,
  );
}

describe('NotificationPreferences', () => {
  beforeEach(() => {
    mockApiFetch = vi.fn().mockResolvedValue(defaultPrefs);
  });

  it('renders the section heading', () => {
    renderPrefs();
    expect(screen.getByText('Notification Preferences')).toBeInTheDocument();
  });

  it('renders all notification type rows after loading', async () => {
    renderPrefs();
    await vi.waitFor(() => {
      expect(screen.getByTestId('pref-comment')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pref-mention')).toBeInTheDocument();
    expect(screen.getByTestId('pref-verification_due')).toBeInTheDocument();
    expect(screen.getByTestId('pref-sync_complete')).toBeInTheDocument();
    expect(screen.getByTestId('pref-general')).toBeInTheDocument();
  });

  it('renders labels and descriptions for each type', async () => {
    renderPrefs();
    await vi.waitFor(() => {
      expect(screen.getByText('Comments')).toBeInTheDocument();
    });
    expect(screen.getByText('When someone comments on your pages')).toBeInTheDocument();
    expect(screen.getByText('Mentions')).toBeInTheDocument();
    expect(screen.getByText('Verification Due')).toBeInTheDocument();
    expect(screen.getByText('Sync Complete')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('renders toggle switches', async () => {
    renderPrefs();
    await vi.waitFor(() => {
      expect(screen.getByTestId('pref-toggle-comment')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pref-toggle-mention')).toBeInTheDocument();
    expect(screen.getByTestId('pref-toggle-verification_due')).toBeInTheDocument();
    expect(screen.getByTestId('pref-toggle-sync_complete')).toBeInTheDocument();
    expect(screen.getByTestId('pref-toggle-general')).toBeInTheDocument();
  });

  it('toggles call API when switch is clicked', async () => {
    renderPrefs();
    await vi.waitFor(() => {
      expect(screen.getByTestId('pref-toggle-comment')).toBeInTheDocument();
    });

    // The toggle should be in checked state (comment: true)
    const toggle = screen.getByTestId('pref-toggle-comment');
    expect(toggle).toHaveAttribute('data-state', 'checked');

    // Click to toggle off
    fireEvent.click(toggle);

    // Should have called the API with comment: false
    await vi.waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/notifications/preferences',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ comment: false }),
        }),
      );
    });
  });

  it('has correct test id on the container', () => {
    renderPrefs();
    expect(screen.getByTestId('notification-preferences')).toBeInTheDocument();
  });

  it('shows loading skeletons initially', () => {
    // Make the fetch never resolve
    mockApiFetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderPrefs();
    const skeletons = document.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
