import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TemplatesTab } from './TemplatesTab';
import { useAuthStore } from '../../../stores/auth-store';

const USER = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'ada', role: 'user' as const };
const ADMIN = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'admin', role: 'admin' as const };

const { editorHtml } = vi.hoisted(() => ({
  editorHtml: { current: '<p>Hello</p>' },
}));

vi.mock('../../../shared/components/article/Editor', async () => {
  const { useEffect } = await import('react');
  return {
    Editor: ({
      onEditorReady,
      content,
    }: {
      content?: string;
      onEditorReady?: (editor: unknown) => void;
    }) => {
      useEffect(() => {
        onEditorReady?.({
          getHTML: () => editorHtml.current || content || '<p></p>',
          getJSON: () => ({ type: 'doc', content: [{ type: 'paragraph' }] }),
        });
        return () => onEditorReady?.(null);
      }, [onEditorReady, content]);
      return (
        <textarea
          data-testid="template-body-editor"
          defaultValue={content}
          onChange={(e) => {
            editorHtml.current = e.target.value;
          }}
        />
      );
    },
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const personalTemplate = {
  id: 1,
  title: 'Sprint notes',
  description: 'Weekly recap',
  category: 'notes',
  icon: '📝',
  isGlobal: false,
  useCount: 0,
  createdBy: USER.id,
  createdAt: '2026-01-01T00:00:00Z',
};

const sharedTemplate = {
  id: 2,
  title: 'Meeting Notes',
  description: 'Agenda and decisions',
  category: 'meetings',
  icon: '📅',
  isGlobal: true,
  useCount: 4,
  createdBy: ADMIN.id,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('TemplatesTab', () => {
  beforeEach(() => {
    editorHtml.current = '<p>Hello</p>';
    useAuthStore.getState().setAuth('test-token', USER);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('loads personal and shared lists with empty states that name the emptiness', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    render(<TemplatesTab />, { wrapper: createWrapper() });

    expect(screen.getByTestId('templates-tab')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('You have no personal templates yet')).toBeInTheDocument();
    });
    expect(screen.getByText('No shared templates yet')).toBeInTheDocument();
    expect(screen.getByTestId('my-templates-list')).toBeInTheDocument();
    expect(screen.getByTestId('shared-templates-list')).toBeInTheDocument();
  });

  it('splits loaded templates into My templates and Shared templates', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([personalTemplate, sharedTemplate]));
    render(<TemplatesTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Sprint notes')).toBeInTheDocument();
    });
    expect(screen.getByTestId('my-templates-list')).toHaveTextContent('Sprint notes');
    expect(screen.getByTestId('shared-templates-list')).toHaveTextContent('Meeting Notes');
  });

  it('creates a personal template', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/api/templates')) {
        return jsonResponse({ id: 9, title: 'Retro notes', isGlobal: false }, 201);
      }
      return jsonResponse([]);
    });

    render(<TemplatesTab />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('create-template-btn')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('create-template-btn'));
    fireEvent.change(screen.getByTestId('template-title-input'), { target: { value: 'Retro notes' } });
    fireEvent.click(screen.getByTestId('template-save-btn'));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(([url, opts]) =>
        String(url).endsWith('/api/templates') && (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body.title).toBe('Retro notes');
      expect(body.bodyHtml).toBe('<p>Hello</p>');
      expect(body.bodyJson).toBeTruthy();
      expect(body.isGlobal).toBeUndefined();
    });
  });

  it('shows the share checkbox for admins', async () => {
    useAuthStore.getState().setAuth('test-token', ADMIN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/api/templates')) {
        return jsonResponse({ id: 9, title: 'Shared retro', isGlobal: true }, 201);
      }
      return jsonResponse([]);
    });

    render(<TemplatesTab />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('create-template-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('create-template-btn'));

    const checkbox = screen.getByTestId('template-share-checkbox');
    expect(checkbox).toBeInTheDocument();
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByTestId('template-title-input'), { target: { value: 'Shared retro' } });
    fireEvent.click(screen.getByTestId('template-save-btn'));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(([url, opts]) =>
        String(url).endsWith('/api/templates') && (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body.isGlobal).toBe(true);
    });
  });

  it('does not show the share checkbox for a regular user', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    render(<TemplatesTab />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('create-template-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('create-template-btn'));

    expect(screen.queryByTestId('template-share-checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Share with everyone')).not.toBeInTheDocument();
  });

  it('asks for confirmation before deleting a template', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'DELETE' && url.endsWith('/api/templates/1')) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse([personalTemplate, sharedTemplate]);
    });

    render(<TemplatesTab />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('delete-template-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('delete-template-1'));
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete "Sprint notes"?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => {
      const del = fetchSpy.mock.calls.find(([url, opts]) =>
        String(url).endsWith('/api/templates/1') && (opts as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
  });

  it('does not show edit or delete buttons on shared templates for a regular user, even if created by them', async () => {
    const sharedCreatedByUser = {
      ...sharedTemplate,
      id: 3,
      title: 'Shared by me',
      createdBy: USER.id,
      isGlobal: true,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([personalTemplate, sharedCreatedByUser]));
    render(<TemplatesTab />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('edit-template-1')).toBeInTheDocument());
    expect(screen.getByTestId('delete-template-1')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-template-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-template-3')).not.toBeInTheDocument();
  });

  it('shows edit and delete buttons on shared templates for an admin', async () => {
    useAuthStore.getState().setAuth('test-token', ADMIN);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([personalTemplate, sharedTemplate]));
    render(<TemplatesTab />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('edit-template-2')).toBeInTheDocument());
    expect(screen.getByTestId('delete-template-2')).toBeInTheDocument();
  });
});
