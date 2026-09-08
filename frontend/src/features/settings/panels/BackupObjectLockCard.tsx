import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UpdateBackupSettingsSchema, type BackupObjectLockConfig, type UpdateBackupSettingsInput } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

type ObjectLockPatch = Pick<UpdateBackupSettingsInput, 'objectLockEnabled' | 'objectLockMode' | 'objectLockRetentionDays' | 'objectLockLegalHold'>;

/** The parent mounts this only for enterprise_backup_dr. */
export function BackupObjectLockCard({ config, stale }: { config?: BackupObjectLockConfig; stale: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ObjectLockPatch>({});
  const [unit, setUnit] = useState<'days' | 'years'>('days');
  const [retention, setRetention] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const days = retention === null ? config?.retentionDays ?? 1 : Number(retention) * (unit === 'years' ? 365 : 1);
  const invalidRetention = retention !== null && (retention.trim() === '' || !Number.isInteger(Number(retention)) || days < 1 || days > 3650);
  const enabled = draft.objectLockEnabled ?? config?.enabled ?? false;
  const mode = draft.objectLockMode ?? config?.mode ?? 'COMPLIANCE';
  const legalHold = draft.objectLockLegalHold ?? config?.legalHold ?? false;
  const dirty = Object.keys(draft).length > 0 || retention !== null;
  const save = useMutation({
    mutationFn: (body: ObjectLockPatch) => apiFetch('/admin/backup', {
      method: 'PUT', body: JSON.stringify(UpdateBackupSettingsSchema.parse(body)),
    }),
    onSuccess: async () => {
      // Keep the submitted draft visible until the shared status has refreshed.
      await queryClient.invalidateQueries({ queryKey: ['admin', 'backup'] });
      setDraft({});
      setRetention(null);
      setUnit('days');
      setSaved(true);
    },
  });
  const blocked = save.isPending || stale || !dirty || invalidRetention;
  return (
    <section className="space-y-4" aria-labelledby="backup-object-lock-heading">
      <h3 id="backup-object-lock-heading" className="text-lg font-semibold">Object Lock (WORM)</h3>
      <p id="backup-object-lock-help" className="text-sm text-muted-foreground">
        Writes backups as immutable S3 objects. The bucket must support Object Lock. The schedule cannot remove locked archives.
      </p>
      <p role="status" className="text-sm">{saved ? 'Object Lock settings saved.' : ''}</p>
      {!config ? <p className="text-sm text-muted-foreground">Object Lock settings are not available from this server.</p> : <>
        <fieldset disabled={save.isPending || stale} className="space-y-4">
          <label htmlFor="backup-object-lock-enabled" className="flex items-center gap-2">
            <input id="backup-object-lock-enabled" type="checkbox" className="accent-primary h-4 w-4" checked={enabled} aria-describedby="backup-object-lock-help" onChange={(event) => { setSaved(false); setDraft({ ...draft, objectLockEnabled: event.target.checked }); }} />
            <span className="text-sm font-medium">Enable Object Lock</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="backup-object-lock-mode" className="mb-1 block text-sm font-medium">Lock mode</label>
              <select id="backup-object-lock-mode" className="nm-select-md w-full" value={mode} disabled={!enabled} onChange={(event) => { setSaved(false); setDraft({ ...draft, objectLockMode: event.target.value as BackupObjectLockConfig['mode'] }); }}>
                <option value="COMPLIANCE">Compliance</option>
                <option value="GOVERNANCE">Governance</option>
              </select>
            </div>
            <div>
              <label htmlFor="backup-object-lock-retention" className="mb-1 block text-sm font-medium">Object Lock retention</label>
              <div className="flex gap-2">
                <input id="backup-object-lock-retention" type="number" min={1} max={unit === 'years' ? 10 : 3650} step={1} className="nm-input min-w-0 flex-1" value={retention ?? config.retentionDays} disabled={!enabled} aria-invalid={invalidRetention || undefined} aria-describedby="backup-object-lock-retention-help" onChange={(event) => { setSaved(false); setRetention(event.target.value); }} />
                <select aria-label="Object Lock retention unit" className="nm-select-md" value={unit} disabled={!enabled} onChange={(event) => {
                  const next = event.target.value as typeof unit;
                  setSaved(false);
                  setRetention(String(next === 'years' ? Math.max(1, Math.ceil(days / 365)) : days));
                  setUnit(next);
                }}>
                  <option value="days">Days</option>
                  <option value="years">Years</option>
                </select>
              </div>
              <p id="backup-object-lock-retention-help" className="mt-1 text-sm text-muted-foreground">1–3650 days or 1–10 whole years. One year is 365 days; switching to years rounds up.</p>
              {invalidRetention && <p role="alert" className="text-sm text-destructive">Enter a whole number from 1 to {unit === 'years' ? 10 : 3650}.</p>}
            </div>
          </div>
          <label htmlFor="backup-object-lock-legal-hold" className="flex items-center gap-2">
            <input id="backup-object-lock-legal-hold" type="checkbox" className="accent-primary h-4 w-4" checked={legalHold} disabled={!enabled} onChange={(event) => { setSaved(false); setDraft({ ...draft, objectLockLegalHold: event.target.checked }); }} />
            <span className="text-sm">Legal hold (ON until explicitly cleared)</span>
          </label>
        </fieldset>
        {enabled && mode === 'COMPLIANCE' && <p role="status" className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">Compliance lock cannot be shortened or removed during the retention period. S3 refuses deletion, including scheduled pruning.</p>}
        {save.error && <p role="alert" className="break-words text-sm text-destructive">{save.error.message} Your changes have been kept. Retry saving.</p>}
        <button type="button" className="nm-button-ghost" aria-disabled={blocked || undefined} onClick={() => {
          if (blocked) return;
          setSaved(false);
          save.mutate({ ...draft, ...(retention !== null ? { objectLockRetentionDays: days } : {}) });
        }}>{save.isPending ? 'Saving Object Lock…' : 'Save Object Lock settings'}</button>
      </>}
    </section>
  );
}
