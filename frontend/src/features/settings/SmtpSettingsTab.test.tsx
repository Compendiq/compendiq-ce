import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SmtpSettingsTab } from './SmtpSettingsTab';

afterEach(() => vi.restoreAllMocks());

describe('SMTP save reconciliation', () => {
  it('keeps edits made during a save, including a password absent from the request', async () => {
    const held = Promise.withResolvers<Response>();
    let sent: Record<string, unknown> | undefined;
    let savedHost = 'initial.example';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return held.promise;
      }
      return Response.json({ host: savedHost, port: 587, secure: false, user: '', from: '', enabled: false });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SmtpSettingsTab /></QueryClientProvider>);
    const host = await screen.findByLabelText('SMTP Host');
    fireEvent.change(host, { target: { value: 'submitted.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SMTP Settings' }));
    await waitFor(() => expect(sent?.host).toBe('submitted.example'));
    expect(sent).not.toHaveProperty('pass');
    fireEvent.change(host, { target: { value: 'later.example' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'later-password' } });
    savedHost = 'submitted.example';
    held.resolve(Response.json({ success: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save SMTP Settings' })).toBeEnabled());
    expect(host).toHaveValue('later.example');
    expect(screen.getByLabelText('Password')).toHaveValue('later-password');
    fireEvent.click(screen.getByRole('button', { name: 'Save SMTP Settings' }));
    await waitFor(() => expect(sent).toMatchObject({ host: 'later.example', pass: 'later-password' }));
  });
});
