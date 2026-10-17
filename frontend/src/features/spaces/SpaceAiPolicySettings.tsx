import { useState } from 'react';
import { AiPolicyCascadeSettings } from './AiPolicyCascadeSettings';
import { useQuery } from '@tanstack/react-query';
import { SpaceAiPolicySettingsSchema, type AiPolicy } from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

const labels = { all: 'All AI allowed', local_only: 'Local AI only', none: 'No AI allowed' };

export function SpaceAiPolicySettings({ spaceKey }: { spaceKey: string }) {
  const { isEnterprise, hasFeature, license } = useEnterprise();
  const enterpriseBackend = isEnterprise || license?.canUpdate === true;
  const enabled = hasFeature('org_llm_policy');
  const [choice, setChoice] = useState<AiPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = useQuery({
    queryKey: ['space-ai-policy', spaceKey, enabled],
    enabled: enterpriseBackend,
    retry: false,
    queryFn: async () => SpaceAiPolicySettingsSchema.parse(await apiFetch(`/admin/spaces/${encodeURIComponent(spaceKey)}/default-ai-policy`)),
  });
  if (!enterpriseBackend) return null;
  const data = settings.data;
  const writable = enabled && data?.canManage && data.entitled && !settings.isError;
  const save = async () => {
    if (!data || !writable || busy || choice === null) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/admin/spaces/${encodeURIComponent(spaceKey)}/default-ai-policy`, {
        method: 'PUT', body: JSON.stringify({ policy: choice, expectedRevision: data.revision }),
      });
      setChoice(null);
      await settings.refetch();
    } catch {
      setError('Settings were not saved. Your choice is retained. Reload current settings before retrying; authority, license or revision may have changed.');
    } finally { setBusy(false); }
  };
  return <section aria-label="AI creation default" className="mt-6 space-y-3 rounded-lg border border-border p-4">
    <h2 className="font-medium">AI creation default</h2>
    <p className="text-sm">Applies only to new articles and imports. Incoming restrictive labels can tighten it; an authorized creator may choose another policy. Changing this default or moving an article never rewrites existing policies.</p>
    {!enabled && <p role="status">The saved default is inactive without the org_llm_policy entitlement. New creations use All AI allowed; existing article restrictions remain enforced.</p>}
    {settings.isPending && <p role="status">Loading current capability…</p>}
    {settings.isError && <p role="alert">Current settings are unavailable. No changes can be made.</p>}
    {data && <>
      <p>Saved default: {labels[data.defaultAiPolicy]}. Effective creation default: {labels[enabled && data.entitled ? data.effectiveCreationDefault : 'all']}.</p>
      {!data.enforcementAvailable && <p>Restrictive changes are unavailable until policy enforcement rollout is ready.</p>}
      {!data.canManage && <p>Managing defaults requires space management authority and a live entitlement.</p>}
      <label>Creation policy<select aria-label="Creation policy" value={choice ?? data.defaultAiPolicy}
        disabled={!writable || busy} onChange={(event) => setChoice(event.target.value as AiPolicy)}>
        {Object.entries(labels).map(([policy, label]) => <option key={policy} value={policy} disabled={policy !== 'all' && !data.enforcementAvailable}>{label}</option>)}
      </select></label>
      <button type="button" disabled={!writable || busy || choice === null} onClick={() => void save()}>Save creation default</button>
    </>}
    {data && <AiPolicyCascadeSettings key={`${spaceKey}:${enabled}:${data.entitled}`} entitled={enabled && data.entitled && !settings.isError} enforcementAvailable={data.enforcementAvailable} />}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => { setError(''); void settings.refetch(); }}>Reload current settings</button>
  </section>;
}
