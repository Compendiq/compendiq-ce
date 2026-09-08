import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BackupKmsConfigSchema,
  BackupKmsRotateResponseSchema,
  BackupKmsTestResponseSchema,
  UpdateBackupKmsSchema,
  type UpdateBackupKmsInput,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

/** Mounted only by the licensed backup surface; CE never requests these routes. */
export function BackupKmsCard() {
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState<UpdateBackupKmsInput>({});
  const [retrying, setRetrying] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const [message, setMessage] = useState('');
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['admin', 'backup-kms'],
    queryFn: async () => BackupKmsConfigSchema.parse(await apiFetch('/admin/backup/kms')),
    staleTime: 30_000,
    retry: false,
  });
  useEffect(() => {
    if (!restoreFocus || retrying || isError) return;
    setRestoreFocus(false);
    if (document.activeElement === document.body) headingRef.current?.focus();
  }, [restoreFocus, retrying, isError]);

  const save = useMutation({
    mutationFn: async (body: UpdateBackupKmsInput) => BackupKmsConfigSchema.parse(
      await apiFetch('/admin/backup/kms', {
        method: 'PUT', body: JSON.stringify(UpdateBackupKmsSchema.parse(body)),
      }),
    ),
    onSuccess: (next) => {
      queryClient.setQueryData(['admin', 'backup-kms'], next);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'backup'] });
      setDraft({});
      setMessage('KMS envelope settings saved.');
    },
  });
  const test = useMutation({
    mutationFn: async () => BackupKmsTestResponseSchema.parse(
      await apiFetch('/admin/backup/kms/test', { method: 'POST' }),
    ),
    onSuccess: (result) => setMessage(`KMS round-trip succeeded (${result.keyArn}).`),
  });
  const rotate = useMutation({
    mutationFn: async () => BackupKmsRotateResponseSchema.parse(
      await apiFetch('/admin/backup/kms/rotate', { method: 'POST' }),
    ),
    onSuccess: () => setMessage('KMS key rotation requested.'),
  });
  const busy = save.isPending || test.isPending || rotate.isPending;
  const form = data ? { ...data, ...draft } : undefined;
  const dirty = !!data && Object.entries(draft).some(([key, value]) => data[key as keyof UpdateBackupKmsInput] !== value);
  const actionsBlocked = busy || isError || retrying || !data || data.provider === 'none' || dirty;
  const failure = save.error ?? test.error ?? rotate.error;
  function startAction() {
    save.reset();
    test.reset();
    rotate.reset();
    setMessage('');
  }

  return (
    <section className="space-y-4" aria-labelledby="backup-kms-heading">
      <h3 id="backup-kms-heading" ref={headingRef} tabIndex={-1} className="nm-focus-ring text-lg font-semibold">Envelope encryption</h3>
      <p className="text-sm text-muted-foreground">
        Each backup gets a single-use AES-256-GCM data key wrapped by AWS KMS or Vault Transit.
        Cloud credentials stay on the server; only key identifiers and provider settings are saved here.
      </p>
      <p role="status" className="break-words text-sm">{message}</p>
      {failure && <p role="alert" className="break-words text-sm text-destructive">{failure.message} Your settings have been kept. Retry the action.</p>}
      {(isError || retrying) && (
        <div role="status" className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
          <p>{data ? 'KMS settings could not be refreshed. Last-loaded settings are shown; retry before making changes.' : 'KMS settings could not be loaded. Retry to restore the controls.'}</p>
          <button type="button" className="nm-button-ghost aria-disabled:opacity-70" aria-disabled={retrying || undefined} onClick={() => {
            if (retrying) return;
            setRetrying(true);
            setRestoreFocus(true);
            void refetch().finally(() => setRetrying(false));
          }}>{retrying ? 'Retrying…' : 'Retry KMS settings'}</button>
        </div>
      )}
      {isPending && !retrying && <p role="status" className="text-sm text-muted-foreground">Loading KMS settings…</p>}
      {form && (
        <>
          <fieldset disabled={busy || isError || retrying} className="space-y-4">
            <div>
              <label htmlFor="backup-kms-provider" className="mb-1 block text-sm font-medium">Provider</label>
              <select id="backup-kms-provider" className="nm-select-md w-full" value={form.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value as typeof form.provider })}>
                <option value="none">Disabled (master key / passphrase)</option>
                <option value="aws">AWS KMS</option>
                <option value="vault">HashiCorp Vault Transit</option>
              </select>
            </div>
            {form.provider !== 'none' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="backup-kms-key" className="mb-1 block text-sm font-medium">{form.provider === 'vault' ? 'Transit key name' : 'Key ARN'}</label>
                  <input id="backup-kms-key" className="nm-input w-full" value={form.keyId} maxLength={2048} autoComplete="off" onChange={(event) => setDraft({ ...draft, keyId: event.target.value })} />
                </div>
                {form.provider === 'aws' && <div>
                  <label htmlFor="backup-kms-region" className="mb-1 block text-sm font-medium">AWS region</label>
                  <input id="backup-kms-region" className="nm-input w-full" value={form.awsRegion} maxLength={64} onChange={(event) => setDraft({ ...draft, awsRegion: event.target.value })} />
                </div>}
                {form.provider === 'vault' && <>
                  <div>
                    <label htmlFor="backup-kms-vault-addr" className="mb-1 block text-sm font-medium">Vault address</label>
                    <input id="backup-kms-vault-addr" className="nm-input w-full" value={form.vaultAddr} maxLength={2048} placeholder="https://vault.internal:8200" onChange={(event) => setDraft({ ...draft, vaultAddr: event.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="backup-kms-vault-ns" className="mb-1 block text-sm font-medium">Namespace</label>
                    <input id="backup-kms-vault-ns" className="nm-input w-full" value={form.vaultNamespace} maxLength={256} onChange={(event) => setDraft({ ...draft, vaultNamespace: event.target.value })} />
                  </div>
                </>}
              </div>
            )}
          </fieldset>
          {form.provider !== 'none' && (
            <p className="text-sm text-muted-foreground">
              {form.provider === 'aws'
                ? 'Use AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY on the server, or an IAM role. Test the saved configuration to verify access.'
                : 'Set VAULT_TOKEN on the server. The token is never stored in Compendiq.'}
              {form.provider === data?.provider && !data?.credentialsPresent ? ' Server credentials have not been confirmed.' : ''}
            </p>
          )}
          {dirty && <p id="backup-kms-unsaved" className="text-sm text-muted-foreground">Save changes before testing or rotating the configured key.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="nm-button-primary" aria-disabled={busy || isError || retrying || !dirty || undefined} onClick={() => {
              if (busy || isError || retrying || !dirty) return;
              startAction();
              save.mutate(draft);
            }}>{save.isPending ? 'Saving…' : 'Save KMS settings'}</button>
            <button type="button" className="nm-button-ghost" aria-disabled={actionsBlocked || undefined} aria-describedby={dirty ? 'backup-kms-unsaved' : undefined} onClick={() => {
              if (actionsBlocked) return;
              startAction();
              test.mutate();
            }}>{test.isPending ? 'Testing…' : 'Test round-trip'}</button>
            <button type="button" className="nm-button-ghost" aria-disabled={actionsBlocked || undefined} aria-describedby={dirty ? 'backup-kms-unsaved' : undefined} onClick={() => {
              if (actionsBlocked) return;
              startAction();
              rotate.mutate();
            }}>{rotate.isPending ? 'Rotating…' : 'Rotate key'}</button>
          </div>
        </>
      )}
    </section>
  );
}
