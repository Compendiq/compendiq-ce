import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupKmsConfig, BackupStatusResponse } from '@compendiq/contracts';
import { EnterpriseProvider } from '../../../shared/enterprise/context';
import { BackupTab } from './BackupTab';

const STATUS: BackupStatusResponse = {
  hasMasterKey: false, kmsEnabled: true, lockHeld: false,
  s3: { enabled: true, endpoint: 'https://s3.example.com', bucket: 'backups', region: 'us-east-1', accessKey: '••••••••', secretKey: '••••••••', prefix: 'backups/', forcePathStyle: false, hasAccessKey: true, hasSecretKey: true },
  schedule: { enabled: false, intervalHours: 24, retentionCount: 7, retentionDays: 30, lastRunAt: null },
  objectLock: { enabled: false, mode: 'COMPLIANCE', retentionDays: 30, legalHold: false },
  history: [],
};
const KMS: BackupKmsConfig = { provider: 'aws', keyId: 'arn:aws:kms:us-east-1:123456789012:key/backup', awsRegion: 'us-east-1', vaultAddr: '', vaultNamespace: '', credentialsPresent: true };
const EE = { edition: 'enterprise', valid: true, features: ['enterprise_backup_dr'] };
const clients: QueryClient[] = [];
const DOWNLOAD = `/api/backup/download/${'a'.repeat(64)}`;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup({ license = EE, status = structuredClone(STATUS), kms = { ...KMS }, intercept }: {
  license?: typeof EE;
  status?: BackupStatusResponse;
  kms?: BackupKmsConfig;
  intercept?: (url: string, method: string, body: Record<string, unknown> | undefined) => Promise<Response> | Response | undefined;
} = {}) {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, method, body });
    const intercepted = intercept?.(url, method, body);
    if (intercepted) return intercepted;
    if (url === '/api/admin/license') return json(license);
    if (url === '/api/admin/backup/kms') {
      if (method === 'PUT') kms = { ...kms, ...body } as BackupKmsConfig;
      return json(kms);
    }
    if (url === '/api/admin/backup/kms/test') return json({ ok: true, keyArn: kms.keyId });
    if (url === '/api/admin/backup/kms/rotate') return json({ ok: true });
    if (url === '/api/admin/backup/export-ticket') return json({ downloadUrl: DOWNLOAD });
    if (url === '/api/admin/backup/run') return json({ jobId: 'queued-1' });
    if (url === '/api/admin/backup') {
      if (method === 'PUT' && status.objectLock) {
        const lock = status.objectLock;
        status.objectLock = {
          enabled: body?.objectLockEnabled as boolean ?? lock.enabled,
          mode: body?.objectLockMode as typeof lock.mode ?? lock.mode,
          retentionDays: body?.objectLockRetentionDays as number ?? lock.retentionDays,
          legalHold: body?.objectLockLegalHold as boolean ?? lock.legalHold,
        };
      }
      return json(status);
    }
    return json({ message: 'Unexpected request' }, 404);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><EnterpriseProvider><BackupTab /></EnterpriseProvider></QueryClientProvider>);
  return { requests, client };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Shared runtime-gated enterprise backup controls', () => {
  it.each([
    { edition: 'community', valid: true, features: ['enterprise_backup_dr'] },
    { edition: 'enterprise', valid: true, features: [] },
    { edition: 'enterprise', valid: false, features: ['enterprise_backup_dr'] },
  ])('keeps $edition / valid=$valid / features=$features inert', async (license) => {
    const { requests } = setup({ license, status: { ...STATUS, kmsEnabled: false } });
    await screen.findByRole('heading', { name: 'Download backup' });
    expect(screen.queryByRole('heading', { name: 'Envelope encryption' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Enable Object Lock')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run backup to S3 now' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'ce-backups' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save S3 settings' }));
    await waitFor(() => expect(requests.filter((request) => request.method === 'PUT')).toEqual([
      { url: '/api/admin/backup', method: 'PUT', body: { s3Bucket: 'ce-backups' } },
    ]));
    expect(requests.some((request) => request.url.includes('/kms'))).toBe(false);
  });

  it('waits for the license before requesting enterprise settings', async () => {
    const license = deferred<Response>();
    const { requests } = setup({ intercept: (url) => url === '/api/admin/license' ? license.promise : undefined });
    await screen.findByRole('heading', { name: 'Download backup' });
    expect(requests.some((request) => request.url.includes('/kms'))).toBe(false);
    await act(async () => license.resolve(json(EE)));
    expect(await screen.findByLabelText('Key ARN')).toHaveValue(KMS.keyId);
    expect(screen.getByLabelText('Enable Object Lock')).toBeInTheDocument();
  });

  it('allows KMS-only download, manual run and schedule without a local secret', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const { requests } = setup();
    await screen.findByLabelText('Key ARN');
    expect(screen.getByLabelText('Download passphrase (optional)')).toBeDisabled();
    const run = screen.getByRole('button', { name: 'Run backup to S3 now' });
    expect(run).toBeEnabled();
    fireEvent.click(run);
    fireEvent.click(screen.getByRole('button', { name: 'Download backup' }));
    fireEvent.click(screen.getByLabelText('Run automatically'));
    fireEvent.click(screen.getByRole('button', { name: 'Save S3 settings' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(DOWNLOAD));
    expect(requests).toContainEqual({ url: '/api/admin/backup/export-ticket', method: 'POST', body: {} });
    expect(requests).toContainEqual({ url: '/api/admin/backup/run', method: 'POST', body: undefined });
    expect(requests).toContainEqual({ url: '/api/admin/backup', method: 'PUT', body: { scheduleEnabled: true } });
  });

  it('does not infer KMS readiness from the provider form when status omits kmsEnabled', async () => {
    const status = structuredClone(STATUS);
    delete status.kmsEnabled;
    setup({ status });
    await screen.findByLabelText('Key ARN');
    expect(screen.getByRole('button', { name: 'Run backup to S3 now' })).toBeDisabled();
    expect(screen.getByLabelText('Download passphrase (optional)')).toBeEnabled();
  });

  it('saves AWS and Vault settings without credentials and only tests the saved key', async () => {
    const { requests } = setup({ kms: { ...KMS, provider: 'none', keyId: '', awsRegion: '' } });
    const provider = await screen.findByLabelText('Provider');
    fireEvent.change(provider, { target: { value: 'aws' } });
    fireEvent.change(screen.getByLabelText('Key ARN'), { target: { value: KMS.keyId } });
    fireEvent.change(screen.getByLabelText('AWS region'), { target: { value: 'us-east-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test round-trip' }));
    expect(requests.some((request) => request.url.endsWith('/kms/test'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save KMS settings' }));
    await screen.findByText('KMS envelope settings saved.');
    expect(requests).toContainEqual({ url: '/api/admin/backup/kms', method: 'PUT', body: { provider: 'aws', keyId: KMS.keyId, awsRegion: 'us-east-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test round-trip' }));
    await screen.findByText(`KMS round-trip succeeded (${KMS.keyId}).`);
    fireEvent.change(provider, { target: { value: 'vault' } });
    fireEvent.change(screen.getByLabelText('Transit key name'), { target: { value: 'backup-key' } });
    fireEvent.change(screen.getByLabelText('Vault address'), { target: { value: 'https://vault.example.com:8200' } });
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'platform' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save KMS settings' }));
    await screen.findByText('KMS envelope settings saved.');
    expect(requests).toContainEqual({ url: '/api/admin/backup/kms', method: 'PUT', body: { provider: 'vault', keyId: 'backup-key', vaultAddr: 'https://vault.example.com:8200', vaultNamespace: 'platform' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));
    await screen.findByText('KMS key rotation requested.');
    expect(requests.filter((request) => request.url.endsWith('/kms/rotate'))).toEqual([{ url: '/api/admin/backup/kms/rotate', method: 'POST', body: undefined }]);
  });

  it('keeps KMS retry focused and renders no fabricated config after a failed read', async () => {
    const retry = deferred<Response>();
    let reads = 0;
    setup({ intercept: (url, method) => {
      if (url !== '/api/admin/backup/kms' || method !== 'GET') return;
      reads += 1;
      return reads === 1 ? json({ message: 'KMS unavailable' }, 503) : retry.promise;
    } });
    const button = await screen.findByRole('button', { name: 'Retry KMS settings' });
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
    button.focus();
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBe(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => retry.resolve(json(KMS)));
    await screen.findByLabelText('Key ARN');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Envelope encryption' })).toHaveFocus());
  });

  it('preserves a failed KMS save and prevents duplicate writes while pending', async () => {
    const write = deferred<Response>();
    const { requests } = setup({ intercept: (url, method) => url.endsWith('/kms') && method === 'PUT' ? write.promise : undefined });
    fireEvent.change(await screen.findByLabelText('Key ARN'), { target: { value: 'new-key' } });
    const save = screen.getByRole('button', { name: 'Save KMS settings' });
    save.focus();
    fireEvent.click(save);
    await screen.findByRole('button', { name: 'Saving…' });
    expect(save).not.toBeDisabled();
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Key ARN')).toBeDisabled();
    fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));
    await act(async () => write.resolve(json({ message: 'KMS access denied' }, 403)));
    expect(await screen.findByRole('alert')).toHaveTextContent('KMS access denied');
    expect(screen.getByLabelText('Key ARN')).toHaveValue('new-key');
    expect(save).toHaveFocus();
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(requests.some((request) => request.url.endsWith('/kms/rotate'))).toBe(false);
  });

  it('reports round-trip and rotation failures without claiming success', async () => {
    const test = deferred<Response>();
    const { requests } = setup({ intercept: (url) => {
      if (url.endsWith('/kms/test')) return test.promise;
      if (url.endsWith('/kms/rotate')) return json({ message: 'Rotation denied' }, 400);
    } });
    await screen.findByLabelText('Key ARN');
    fireEvent.click(screen.getByRole('button', { name: 'Test round-trip' }));
    const pending = await screen.findByRole('button', { name: 'Testing…' });
    fireEvent.click(pending);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));
    await act(async () => test.resolve(json({ message: 'Decrypt denied' }, 400)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Decrypt denied');
    expect(requests.filter((request) => request.url.endsWith('/kms/test'))).toHaveLength(1);
    expect(requests.some((request) => request.url.endsWith('/kms/rotate'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Rotation denied'));
    expect(screen.queryByText('KMS key rotation requested.')).not.toBeInTheDocument();
  });

  it('saves Object Lock mode, years as days and legal hold separately from other drafts', async () => {
    const { requests } = setup();
    await screen.findByLabelText('Enable Object Lock');
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'unsaved-bucket' } });
    fireEvent.click(screen.getByLabelText('Enable Object Lock'));
    expect(screen.getByText(/Compliance lock cannot be shortened/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Lock mode'), { target: { value: 'GOVERNANCE' } });
    fireEvent.change(screen.getByLabelText('Object Lock retention unit'), { target: { value: 'years' } });
    fireEvent.change(screen.getByLabelText('Object Lock retention'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('Legal hold (ON until explicitly cleared)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Object Lock settings' }));
    await screen.findByText('Object Lock settings saved.');
    expect(requests.filter((request) => request.method === 'PUT')).toEqual([{ url: '/api/admin/backup', method: 'PUT', body: { objectLockEnabled: true, objectLockMode: 'GOVERNANCE', objectLockRetentionDays: 730, objectLockLegalHold: true } }]);
    expect(screen.getByLabelText('Object Lock retention')).toHaveValue(730);
    expect(screen.getByLabelText('Bucket')).toHaveValue('unsaved-bucket');
  });

  it('rejects invalid retention, holds pending controls, and preserves a failed Object Lock draft', async () => {
    const write = deferred<Response>();
    const { requests } = setup({ intercept: (url, method) => url === '/api/admin/backup' && method === 'PUT' ? write.promise : undefined });
    fireEvent.click(await screen.findByLabelText('Enable Object Lock'));
    const retention = screen.getByLabelText('Object Lock retention');
    const save = screen.getByRole('button', { name: 'Save Object Lock settings' });
    fireEvent.change(retention, { target: { value: '' } });
    fireEvent.click(save);
    expect(retention).toHaveAttribute('aria-invalid', 'true');
    expect(requests.some((request) => request.method === 'PUT')).toBe(false);
    fireEvent.change(retention, { target: { value: '3650' } });
    fireEvent.click(save);
    await screen.findByRole('button', { name: 'Saving Object Lock…' });
    fireEvent.click(save);
    expect(retention).toBeDisabled();
    await act(async () => write.resolve(json({ message: 'Object Lock entitlement expired' }, 403)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Object Lock entitlement expired');
    expect(retention).toHaveValue(3650);
    expect(screen.getByLabelText('Enable Object Lock')).toBeChecked();
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });
});
