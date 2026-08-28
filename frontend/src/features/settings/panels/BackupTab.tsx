import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BackupStatusResponse, UpdateBackupSettingsInput } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { useAuthStore } from '../../../stores/auth-store';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { PanelHeader } from '../PanelHeader';

export function BackupTab() {
  const queryClient = useQueryClient();
  const [passphrase, setPassphrase] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [form, setForm] = useState<Partial<UpdateBackupSettingsInput>>({});

  const { data, isLoading } = useQuery<BackupStatusResponse>({
    queryKey: ['admin', 'backup'],
    queryFn: () => apiFetch('/admin/backup'),
  });

  const saveMutation = useMutation({
    mutationFn: (body: UpdateBackupSettingsInput) =>
      apiFetch('/admin/backup', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'backup'] });
      setForm({});
      toast.success('Backup settings saved');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; error?: string }>('/admin/backup/test-s3', { method: 'POST' }),
    onSuccess: (res) => {
      if (res.ok) toast.success('S3 connection succeeded');
      else toast.error(res.error ?? 'S3 test failed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const runMutation = useMutation({
    mutationFn: () => apiFetch<{ jobId: string }>('/admin/backup/run', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'backup'] });
      toast.success('S3 backup queued');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading || !data) return <SkeletonFormFields />;


  async function downloadBackup() {
    setDownloading(true);
    try {
      const { accessToken } = useAuthStore.getState();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const res = await fetch('/api/admin/backup/export', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(passphrase ? { passphrase } : {}),
      });
      if (!res.ok) {
        let message = `Backup failed (${res.status})`;
        try {
          const body = (await res.json()) as { message?: string; error?: string };
          if (body.message) message = body.message;
          else if (body.error) message = body.error;
        } catch {
          /* keep default */
        }
        toast.error(message);
        return;
      }
      const blob = await res.blob();
      const filename =
        res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        'compendiq-backup.enc';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 100);
      toast.success('Backup downloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-8">
      <PanelHeader subtitle="Encrypted PostgreSQL + attachment backups. Archives use AES-256-GCM and never land unencrypted on disk." />

      <section className="space-y-4" aria-labelledby="backup-download-heading">
        <h3 id="backup-download-heading" className="text-lg font-semibold">Download backup</h3>
        <p className="text-sm text-muted-foreground">
          {data.hasMasterKey
            ? 'Encrypted with BACKUP_ENCRYPTION_KEY. Optionally set a passphrase to encrypt this download with PBKDF2 instead.'
            : 'Set a passphrase of at least 12 characters, or configure BACKUP_ENCRYPTION_KEY on the server.'}
        </p>
        {data.lockHeld && (
          <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
            A backup is already running.
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="backup-passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Optional passphrase"
            className="nm-input flex-1"
            autoComplete="new-password"
            data-testid="backup-passphrase"
          />
          <button
            type="button"
            onClick={() => void downloadBackup()}
            disabled={downloading || data.lockHeld}
            className="nm-button-primary"
            data-testid="backup-download-btn"
          >
            {downloading ? 'Preparing…' : 'Download backup'}
          </button>
        </div>
      </section>

      <hr className="border-border" />

      <section className="space-y-4" aria-labelledby="backup-s3-heading">
        <h3 id="backup-s3-heading" className="text-lg font-semibold">S3 destination</h3>
        <label htmlFor="backup-s3-enabled" className="flex items-center gap-2">
          <input
            id="backup-s3-enabled"
            type="checkbox"
            checked={Boolean(form.s3Enabled ?? data.s3.enabled)}
            onChange={(e) => setForm({ ...form, s3Enabled: e.target.checked })}
            className="accent-primary h-4 w-4"
          />
          <span className="text-sm font-medium">Enable S3 uploads</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="backup-s3-endpoint" className="mb-1 block text-sm font-medium">Endpoint</label>
            <input
              id="backup-s3-endpoint"
              className="nm-input"
              value={String(form.s3Endpoint ?? data.s3.endpoint)}
              onChange={(e) => setForm({ ...form, s3Endpoint: e.target.value })}
              placeholder="https://s3.amazonaws.com"
              data-testid="backup-s3-endpoint"
            />
          </div>
          <div>
            <label htmlFor="backup-s3-bucket" className="mb-1 block text-sm font-medium">Bucket</label>
            <input
              id="backup-s3-bucket"
              className="nm-input"
              value={String(form.s3Bucket ?? data.s3.bucket)}
              onChange={(e) => setForm({ ...form, s3Bucket: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="backup-s3-region" className="mb-1 block text-sm font-medium">Region</label>
            <input
              id="backup-s3-region"
              className="nm-input"
              value={String(form.s3Region ?? data.s3.region)}
              onChange={(e) => setForm({ ...form, s3Region: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="backup-s3-prefix" className="mb-1 block text-sm font-medium">Prefix</label>
            <input
              id="backup-s3-prefix"
              className="nm-input"
              value={String(form.s3Prefix ?? data.s3.prefix)}
              onChange={(e) => setForm({ ...form, s3Prefix: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="backup-s3-access" className="mb-1 block text-sm font-medium">Access key</label>
            <input
              id="backup-s3-access"
              type="password"
              className="nm-input"
              value={form.s3AccessKey ?? ''}
              onChange={(e) => setForm({ ...form, s3AccessKey: e.target.value })}
              placeholder={data.s3.hasAccessKey ? 'Stored — enter to rotate' : ''}
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="backup-s3-secret" className="mb-1 block text-sm font-medium">Secret key</label>
            <input
              id="backup-s3-secret"
              type="password"
              className="nm-input"
              value={form.s3SecretKey ?? ''}
              onChange={(e) => setForm({ ...form, s3SecretKey: e.target.value })}
              placeholder={data.s3.hasSecretKey ? 'Stored — enter to rotate' : ''}
              autoComplete="off"
            />
          </div>
        </div>
        <label htmlFor="backup-s3-path-style" className="flex items-center gap-2">
          <input
            id="backup-s3-path-style"
            type="checkbox"
            checked={Boolean(form.s3ForcePathStyle ?? data.s3.forcePathStyle)}
            onChange={(e) => setForm({ ...form, s3ForcePathStyle: e.target.checked })}
            className="accent-primary h-4 w-4"
          />
          <span className="text-sm">Path-style addressing (MinIO, R2, Wasabi)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="nm-button-primary"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(form)}
            data-testid="backup-save-btn"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save S3 settings'}
          </button>
          <button
            type="button"
            className="nm-button-ghost"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate()}
            data-testid="backup-test-s3-btn"
          >
            {testMutation.isPending ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </section>

      <hr className="border-border" />

      <section className="space-y-4" aria-labelledby="backup-schedule-heading">
        <h3 id="backup-schedule-heading" className="text-lg font-semibold">Schedule</h3>
        <label htmlFor="backup-schedule-enabled" className="flex items-center gap-2">
          <input
            id="backup-schedule-enabled"
            type="checkbox"
            checked={Boolean(form.scheduleEnabled ?? data.schedule.enabled)}
            onChange={(e) => setForm({ ...form, scheduleEnabled: e.target.checked })}
            className="accent-primary h-4 w-4"
          />
          <span className="text-sm font-medium">Run automatically</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="backup-interval" className="mb-1 block text-sm font-medium">Interval (hours)</label>
            <input
              id="backup-interval"
              type="number"
              min={1}
              max={168}
              className="nm-input"
              value={form.intervalHours ?? data.schedule.intervalHours}
              onChange={(e) => setForm({ ...form, intervalHours: Number.parseInt(e.target.value, 10) })}
            />
          </div>
          <div>
            <label htmlFor="backup-retain-count" className="mb-1 block text-sm font-medium">Keep last N</label>
            <input
              id="backup-retain-count"
              type="number"
              min={1}
              max={100}
              className="nm-input"
              value={form.retentionCount ?? data.schedule.retentionCount}
              onChange={(e) => setForm({ ...form, retentionCount: Number.parseInt(e.target.value, 10) })}
            />
          </div>
          <div>
            <label htmlFor="backup-retain-days" className="mb-1 block text-sm font-medium">Delete after days</label>
            <input
              id="backup-retain-days"
              type="number"
              min={1}
              max={365}
              className="nm-input"
              value={form.retentionDays ?? data.schedule.retentionDays}
              onChange={(e) => setForm({ ...form, retentionDays: Number.parseInt(e.target.value, 10) })}
            />
          </div>
        </div>
        <button
          type="button"
          className="nm-button-ghost"
          disabled={runMutation.isPending || data.lockHeld}
          onClick={() => runMutation.mutate()}
          data-testid="backup-run-now-btn"
        >
          {runMutation.isPending ? 'Queuing…' : 'Run backup to S3 now'}
        </button>
      </section>

      <section className="space-y-2" aria-labelledby="backup-history-heading">
        <h3 id="backup-history-heading" className="text-lg font-semibold">History</h3>
        {data.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="backup-history">
            {data.history.map((run) => (
              <li key={run.id}>
                {run.createdAt} — {run.destination} — {run.status}
                {run.objectKey ? ` — ${run.objectKey}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
