import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth-store';
import { SetupWizard } from './SetupWizard';

function renderWizard(initialEntries = ['/setup']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <SetupWizard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Helper: type into an input by clearing and setting a value, then firing change. */
function typeInto(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}

const fetchSpy = vi.spyOn(globalThis, 'fetch');

function mockFetchForSetup({ adminExists }: { adminExists: boolean }) {
  fetchSpy.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (url.includes('/health/setup-status')) {
      return new Response(JSON.stringify({
        setupComplete: false,
        steps: { admin: adminExists, llm: false, confluence: false },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/setup/llm-test')) {
      return new Response(JSON.stringify({
        success: true,
        models: [{ name: 'llama3.2:latest', size: 2000000000 }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/setup/admin')) {
      return new Response(JSON.stringify({
        accessToken: 'setup-token',
        user: { id: '1', username: 'admin', role: 'admin' },
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('SetupWizard', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().clearAuth();

    // Default: mock all API calls to return success (no admin exists)
    mockFetchForSetup({ adminExists: false });
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('renders the welcome step initially', () => {
    renderWizard();

    expect(screen.getByText(/Welcome to/i)).toBeInTheDocument();
    expect(screen.getByTestId('start-setup-btn')).toBeInTheDocument();
  });

  it('displays the Compendiq logo on welcome step', () => {
    renderWizard();

    // The logo is rendered as an SVG with aria-label "Compendiq"
    expect(screen.getByLabelText('Compendiq')).toBeInTheDocument();
  });

  it('displays version on welcome step', () => {
    renderWizard();

    expect(screen.getByText(`v${__APP_VERSION__}`)).toBeInTheDocument();
  });

  it('advances to admin step when "Start Setup" is clicked', async () => {
    renderWizard();

    fireEvent.click(screen.getByTestId('start-setup-btn'));

    await waitFor(() => {
      expect(screen.getByText('Create Admin Account')).toBeInTheDocument();
    });
    expect(screen.getByTestId('setup-username')).toBeInTheDocument();
    expect(screen.getByTestId('setup-password')).toBeInTheDocument();
    expect(screen.getByTestId('setup-confirm-password')).toBeInTheDocument();
  });

  it('can navigate back from admin step to welcome', async () => {
    renderWizard();

    fireEvent.click(screen.getByTestId('start-setup-btn'));
    await waitFor(() => {
      expect(screen.getByText('Create Admin Account')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('admin-back-btn'));
    await waitFor(() => {
      expect(screen.getByText(/Welcome to/i)).toBeInTheDocument();
    });
  });

  it('creates admin account and advances to LLM step', async () => {
    renderWizard();

    // Go to admin step
    fireEvent.click(screen.getByTestId('start-setup-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('setup-username')).toBeInTheDocument();
    });

    // Fill in the form
    typeInto(screen.getByTestId('setup-username'), 'admin');
    typeInto(screen.getByTestId('setup-password'), 'securepass123');
    typeInto(screen.getByTestId('setup-confirm-password'), 'securepass123');

    // Submit
    fireEvent.click(screen.getByTestId('create-admin-btn'));

    // Should call the setup/admin endpoint
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/setup/admin',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    // Should advance to LLM step
    await waitFor(() => {
      expect(screen.getByText('Configure LLM Provider')).toBeInTheDocument();
    });

    // Auth store should have the token
    expect(useAuthStore.getState().accessToken).toBe('setup-token');
  });

  it('shows the progress stepper on non-welcome/complete steps', async () => {
    renderWizard();

    // No stepper on welcome
    expect(screen.queryByTestId('setup-stepper')).not.toBeInTheDocument();

    // Go to admin step
    fireEvent.click(screen.getByTestId('start-setup-btn'));

    // Stepper should be visible
    await waitFor(() => {
      expect(screen.getByTestId('setup-stepper')).toBeInTheDocument();
    });
  });

  it('navigates through all steps to completion', async () => {
    renderWizard();

    // Step 1: Welcome
    expect(screen.getByText(/Welcome to/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('start-setup-btn'));

    // Step 2: Admin
    await waitFor(() => {
      expect(screen.getByText('Create Admin Account')).toBeInTheDocument();
    });
    typeInto(screen.getByTestId('setup-username'), 'admin');
    typeInto(screen.getByTestId('setup-password'), 'securepass123');
    typeInto(screen.getByTestId('setup-confirm-password'), 'securepass123');
    fireEvent.click(screen.getByTestId('create-admin-btn'));

    // Step 3: LLM
    await waitFor(() => {
      expect(screen.getByText('Configure LLM Provider')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('llm-next-btn'));

    // Step 4: Confluence
    await waitFor(() => {
      expect(screen.getByText('Connect Confluence')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('skip-confluence-btn'));

    // Step 5: Complete
    await waitFor(() => {
      expect(screen.getByText(/You're All Set/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('goto-pages')).toBeInTheDocument();
    expect(screen.getByTestId('goto-settings')).toBeInTheDocument();
  });

  it('auto-detects Ollama on LLM step mount', async () => {
    renderWizard();

    // Navigate to LLM step
    fireEvent.click(screen.getByTestId('start-setup-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('setup-username')).toBeInTheDocument();
    });
    typeInto(screen.getByTestId('setup-username'), 'admin');
    typeInto(screen.getByTestId('setup-password'), 'securepass123');
    typeInto(screen.getByTestId('setup-confirm-password'), 'securepass123');
    fireEvent.click(screen.getByTestId('create-admin-btn'));

    await waitFor(() => {
      expect(screen.getByText('Configure LLM Provider')).toBeInTheDocument();
    });

    // The auto-detect should fire a call to /setup/llm-test
    await waitFor(() => {
      const llmCalls = fetchSpy.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/setup/llm-test'),
      );
      expect(llmCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('LLM step allows manual test connection', async () => {
    renderWizard();

    // Navigate to LLM step
    fireEvent.click(screen.getByTestId('start-setup-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('setup-username')).toBeInTheDocument();
    });
    typeInto(screen.getByTestId('setup-username'), 'admin');
    typeInto(screen.getByTestId('setup-password'), 'securepass123');
    typeInto(screen.getByTestId('setup-confirm-password'), 'securepass123');
    fireEvent.click(screen.getByTestId('create-admin-btn'));

    await waitFor(() => {
      expect(screen.getByText('Configure LLM Provider')).toBeInTheDocument();
    });

    // Click test connection
    fireEvent.click(screen.getByTestId('test-llm-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('llm-test-result')).toBeInTheDocument();
    });
  });

  it('skips admin step when admin already exists', async () => {
    mockFetchForSetup({ adminExists: true });
    renderWizard();

    // Step 1: Welcome
    expect(screen.getByText(/Welcome to/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('start-setup-btn'));

    // Should skip Admin and go directly to LLM
    await waitFor(() => {
      expect(screen.getByText('Configure LLM Provider')).toBeInTheDocument();
    });
    expect(screen.queryByText('Create Admin Account')).not.toBeInTheDocument();
  });

  it('skips admin step going back from LLM when admin exists', async () => {
    mockFetchForSetup({ adminExists: true });
    renderWizard();

    // Go to LLM step
    fireEvent.click(screen.getByTestId('start-setup-btn'));
    await waitFor(() => {
      expect(screen.getByText('Configure LLM Provider')).toBeInTheDocument();
    });

    // Go back should skip admin and return to welcome
    fireEvent.click(screen.getByTestId('llm-back-btn'));
    await waitFor(() => {
      expect(screen.getByText(/Welcome to/i)).toBeInTheDocument();
    });
  });

  it('renders the complete step with navigation links', async () => {
    renderWizard();

    // Navigate through all steps
    fireEvent.click(screen.getByTestId('start-setup-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('setup-username')).toBeInTheDocument();
    });
    typeInto(screen.getByTestId('setup-username'), 'admin');
    typeInto(screen.getByTestId('setup-password'), 'securepass123');
    typeInto(screen.getByTestId('setup-confirm-password'), 'securepass123');
    fireEvent.click(screen.getByTestId('create-admin-btn'));

    await waitFor(() => {
      expect(screen.getByText('Configure LLM Provider')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('llm-next-btn'));

    await waitFor(() => {
      expect(screen.getByText('Connect Confluence')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('skip-confluence-btn'));

    await waitFor(() => {
      expect(screen.getByText(/You're All Set/i)).toBeInTheDocument();
    });

    // Check navigation links
    expect(screen.getByText('Go to Pages')).toBeInTheDocument();
    expect(screen.getByText('Admin Settings')).toBeInTheDocument();
  });
});
