import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { EnterpriseProvider } from '../../../shared/enterprise/context';
import { useAuthStore } from '../../../stores/auth-store';
import { AccessControlWrapper } from './AccessControlWrapper';

const users = [
  { id: 'u1', username: 'alice', displayName: 'Alice', email: null, role: 'admin', authProvider: 'local', deactivatedAt: null, deactivatedBy: null, deactivatedReason: null, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'u2', username: 'bob', displayName: null, email: null, role: 'user', authProvider: 'local', deactivatedAt: null, deactivatedBy: null, deactivatedReason: null, createdAt: '2026-01-01T00:00:00Z' },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function setup(initialEntry = '/settings/governance/access') {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/admin/license') return json({ edition: 'enterprise', tier: 'enterprise', features: ['advanced_rbac'], valid: true });
    if (url === '/api/admin/users') return json({ users });
    if (url === '/api/users') return json(users);
    if (url === '/api/groups') return json([{ id: 1, name: 'Engineering', description: null, source: 'local', memberCount: 1, createdAt: '2026-01-01' }]);
    if (url === '/api/groups/1/members') return json([{ userId: 'u1', username: 'alice', source: 'manual', joinedAt: '2026-01-01' }]);
    if (url === '/api/admin/users/u2/deactivate') return json({});
    if (url === '/api/roles') return json([{ id: 2, name: 'editor', displayName: 'Editor', isSystem: true, permissions: [], createdAt: '2026-01-01' }]);
    if (url === '/api/spaces') return json([{ key: 'DEV', name: 'Development' }]);
    if (url === '/api/spaces/DEV/roles') return json([]);
    return new Response('Unexpected request', { status: 404 });
  });
  useAuthStore.getState().setAuth('test-token', { id: 'u1', username: 'alice', role: 'admin' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><EnterpriseProvider><MemoryRouter initialEntries={[initialEntry]}><LazyMotion features={domAnimation}><AccessControlWrapper /></LazyMotion></MemoryRouter></EnterpriseProvider></QueryClientProvider>);
  return { client, calls };
}

afterEach(() => { cleanup(); useAuthStore.getState().clearAuth(); vi.restoreAllMocks(); });

async function groups() {
  fireEvent.click(await screen.findByTestId('rbac-tab-groups'));
  fireEvent.click(await screen.findByTestId('toggle-members-1'));
  const select = await screen.findByTestId('member-select-1');
  expect(await within(select).findByRole('option', { name: 'bob' })).toBeInTheDocument();
}

async function permissions() {
  fireEvent.click(await screen.findByTestId('rbac-tab-permissions'));
  const select = await screen.findByTestId('space-selector');
  await within(select).findByRole('option', { name: 'Development (DEV)' });
  fireEvent.change(select, { target: { value: 'DEV' } });
  fireEvent.click(await screen.findByTestId('add-assignment-btn'));
  expect(await within(screen.getByTestId('principal-select')).findByRole('option', { name: 'bob' })).toBeInTheDocument();
}

describe('Access Control users cache', () => {
  it('keeps Users data usable through expanded Groups and Assign Role, then back', async () => {
    const { client, calls } = setup();
    expect(await screen.findByText('bob')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('subtab-access-rbac'));
    await groups();
    await permissions();
    fireEvent.click(screen.getByTestId('subtab-access-users'));
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(calls.filter((call) => call === 'GET /api/admin/users')).toHaveLength(1);
    expect(calls.filter((call) => call === 'GET /api/users')).toHaveLength(1);
    client.clear();
  });

  it('keeps the Users table visible after Roles populated its fresh user cache', async () => {
    const { client, calls } = setup('/settings/governance/access?sub=rbac');
    await groups();
    await permissions();
    fireEvent.click(screen.getByTestId('subtab-access-users'));
    expect(await screen.findByText('bob')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('subtab-access-rbac'));
    await groups();
    expect(calls.filter((call) => call === 'GET /api/users')).toHaveLength(1);
    client.clear();
  });

  it('invalidates both representations after a user lifecycle change', async () => {
    const { client, calls } = setup();
    await screen.findByText('bob');
    fireEvent.click(await screen.findByTestId('subtab-access-rbac'));
    await groups();
    fireEvent.click(screen.getByTestId('subtab-access-users'));
    fireEvent.click(await screen.findByText('Deactivate'));
    await waitFor(() => expect(calls.filter((call) => call === 'GET /api/admin/users').length).toBeGreaterThan(1));
    fireEvent.click(screen.getByTestId('subtab-access-rbac'));
    await groups();
    expect(calls.filter((call) => call === 'GET /api/admin/users').length).toBeGreaterThan(1);
    expect(calls.filter((call) => call === 'GET /api/users').length).toBeGreaterThan(1);
    client.clear();
  });
});
