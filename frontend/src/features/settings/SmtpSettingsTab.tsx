import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  enabled: boolean;
}

export function SmtpSettingsTab() {
  const queryClient = useQueryClient();
  const [testEmail, setTestEmail] = useState('');

  const { data: config, isLoading } = useQuery<SmtpConfig>({
    queryKey: ['smtp-config'],
    queryFn: () => apiFetch('/admin/smtp'),
  });

  const [form, setForm] = useState<Partial<SmtpConfig>>({});

  const current = { ...config, ...form };

  const saveMutation = useMutation({
    mutationFn: (body: Partial<SmtpConfig>) =>
      apiFetch('/admin/smtp', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smtp-config'] });
      setForm({});
      toast.success('SMTP settings saved');
    },
    onError: (err) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: (to: string) =>
      apiFetch('/admin/smtp/test', { method: 'POST', body: JSON.stringify({ to }) }) as Promise<{ success: boolean; error?: string }>,
    onSuccess: (data: { success: boolean; error?: string }) => {
      if (data.success) {
        toast.success('Test email sent');
      } else {
        toast.error(`Test failed: ${data.error}`);
      }
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 rounded bg-card/60" /><div className="h-8 rounded bg-card/60" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-4 text-lg font-semibold">Email / SMTP Configuration</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Configure SMTP to enable email notifications for sync events, knowledge requests, and comments.
        </p>
      </div>

      <div className="space-y-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={current.enabled ?? false}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            className="accent-primary"
          />
          <span className="text-sm font-medium">Enable email notifications</span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">SMTP Host</label>
            <input
              type="text"
              value={current.host ?? ''}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="smtp.example.com"
              className="input-field w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Port</label>
            <input
              type="number"
              value={current.port ?? 587}
              onChange={(e) => setForm({ ...form, port: parseInt(e.target.value, 10) })}
              className="input-field w-full"
            />
          </div>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={current.secure ?? false}
            onChange={(e) => setForm({ ...form, secure: e.target.checked })}
            className="accent-primary"
          />
          <span className="text-sm">Use TLS/SSL</span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Username</label>
            <input
              type="text"
              value={current.user ?? ''}
              onChange={(e) => setForm({ ...form, user: e.target.value })}
              placeholder="user@example.com"
              className="input-field w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Password</label>
            <input
              type="password"
              value={form.pass ?? ''}
              onChange={(e) => setForm({ ...form, pass: e.target.value })}
              placeholder={config?.pass || 'Enter password'}
              className="input-field w-full"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">From Address</label>
          <input
            type="email"
            value={current.from ?? ''}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
            placeholder="noreply@compendiq.local"
            className="input-field w-full"
          />
        </div>

        <button
          onClick={() => saveMutation.mutate(current)}
          disabled={saveMutation.isPending}
          className="btn-primary"
        >
          {saveMutation.isPending ? 'Saving...' : 'Save SMTP Settings'}
        </button>
      </div>

      <hr className="border-border/30" />

      <div>
        <h4 className="mb-2 text-sm font-semibold">Send Test Email</h4>
        <div className="flex gap-2">
          <input
            type="email"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            placeholder="admin@example.com"
            className="input-field flex-1"
          />
          <button
            onClick={() => testMutation.mutate(testEmail)}
            disabled={!testEmail || testMutation.isPending}
            className="btn-secondary"
          >
            {testMutation.isPending ? 'Sending...' : 'Send Test'}
          </button>
        </div>
      </div>
    </div>
  );
}
