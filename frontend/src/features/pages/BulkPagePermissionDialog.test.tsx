import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EnterpriseContext } from '../../shared/enterprise/enterprise-context';
import type { EnterpriseContextValue } from '../../shared/enterprise/types';
import { BulkPagePermissionDialog } from './BulkPagePermissionDialog';

function makeWrapper(opts: { hasBatchOps: boolean }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const value: EnterpriseContextValue = {
    ui: null,
    license: null,
    isEnterprise: opts.hasBatchOps,
    hasFeature: (f: string) => opts.hasBatchOps && f === 'batch_page_operations',
    isLoading: false,
  };
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <EnterpriseContext.Provider value={value}>{children}</EnterpriseContext.Provider>
      </QueryClientProvider>
    );
  };
}

describe('BulkPagePermissionDialog', () => {
  const baseProps = {
    open: true,
    onClose: vi.fn(),
    selectedIds: ['1', '2', '3'],
  };

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ succeeded: 3, failed: 0, errors: [], inheritFlippedPageIds: [1, 2] }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when batch_page_operations feature is disabled (CE / unlicensed EE)', () => {
    const { container } = render(
      <BulkPagePermissionDialog {...baseProps} />,
      { wrapper: makeWrapper({ hasBatchOps: false }) },
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the dialog when feature is enabled', () => {
    render(
      <BulkPagePermissionDialog {...baseProps} />,
      { wrapper: makeWrapper({ hasBatchOps: true }) },
    );
    expect(screen.getByTestId('bulk-permission-dialog')).toBeInTheDocument();
  });

  it('shows the inherit_perms warning for add and replace, hides for remove', () => {
    render(
      <BulkPagePermissionDialog {...baseProps} />,
      { wrapper: makeWrapper({ hasBatchOps: true }) },
    );
    expect(screen.queryByTestId('inherit-warning')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('action-remove'));
    expect(screen.queryByTestId('inherit-warning')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('action-replace'));
    expect(screen.queryByTestId('inherit-warning')).toBeInTheDocument();
  });

  it('Apply is disabled while principal_id is empty, enabled once filled', () => {
    render(
      <BulkPagePermissionDialog {...baseProps} />,
      { wrapper: makeWrapper({ hasBatchOps: true }) },
    );
    const apply = screen.getByTestId('apply-btn') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('principal-id'), { target: { value: 'executives' } });
    expect(apply.disabled).toBe(false);
  });

  it('POSTs the chosen action+principal+permission and closes on success', async () => {
    const onClose = vi.fn();
    const onApplied = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(
      <BulkPagePermissionDialog {...baseProps} onClose={onClose} onApplied={onApplied} />,
      { wrapper: makeWrapper({ hasBatchOps: true }) },
    );

    fireEvent.change(screen.getByTestId('principal-type'), { target: { value: 'group' } });
    fireEvent.change(screen.getByTestId('principal-id'), { target: { value: 'executives' } });
    fireEvent.change(screen.getByTestId('permission'), { target: { value: 'edit' } });
    fireEvent.click(screen.getByTestId('apply-btn'));

    await waitFor(() => {
      expect(onApplied).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    const call = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/admin/pages/bulk/permission'),
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      ids: ['1', '2', '3'],
      action: 'add',
      principal_type: 'group',
      principal_id: 'executives',
      permission: 'edit',
    });
  });

  it('does not render when open=false', () => {
    const { container } = render(
      <BulkPagePermissionDialog {...baseProps} open={false} />,
      { wrapper: makeWrapper({ hasBatchOps: true }) },
    );
    expect(container.innerHTML).toBe('');
  });
});
