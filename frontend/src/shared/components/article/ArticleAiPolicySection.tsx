import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PageAiPolicyDetailFieldsSchema, PageAiPolicyResponseSchema, type AiPolicy } from '@compendiq/contracts';
import { usePage } from '../../hooks/use-pages';
import { apiFetch, ApiError } from '../../lib/api';
import { AI_POLICY_CHIP_LABEL, AI_POLICY_EXPLANATION, canShowPolicySelector, NO_AI_CONFIRMATION } from '../../lib/article-ai-policy';
import { AiPolicyChip } from '../badges/AiPolicyChips';
import { ConfirmDialog } from '../ConfirmDialog';

/** Mounted in Details, independently of whether the article read has succeeded. */
export function ArticleAiPolicySection({ pageId }: { pageId: string }) {
  const query = usePage(pageId);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AiPolicy | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false);
  const parsed = PageAiPolicyDetailFieldsSchema.safeParse(query.data);
  const detail = parsed.success ? parsed.data : undefined;
  const permissionLost = denied || (!!query.error && query.error instanceof ApiError && [401, 403, 404].includes(query.error.statusCode));
  const policy = permissionLost ? undefined : detail?.aiPolicy;
  // Mounted on capability, NOT on `isFetching`: a background refetch must not
  // unmount the <select> the user is focused on (the control would vanish
  // and focus would drop to <body>). The refetch instead disables Save until
  // the fresh revision is in, so a save can never race a stale one.
  const editable = !permissionLost && !query.isError && canShowPolicySelector(query.data);
  const refreshing = query.isFetching;
  const selected = draft ?? policy;

  async function save() {
    setConfirm(false);
    if (!editable || refreshing || pending || conflict || !selected || detail?.aiPolicyRevision === undefined) return;
    setPending(true);
    setNotice('');
    try {
      const result = PageAiPolicyResponseSchema.parse(await apiFetch(`/pages/${pageId}/ai-policy`, {
        method: 'PUT', body: JSON.stringify({ aiPolicy: selected, expectedRevision: detail.aiPolicyRevision }),
      }));
      // Only committed server values enter the page cache. Never paint a draft as active.
      qc.setQueryData(['pages', pageId], (old: Record<string, unknown> | undefined) => old ? {
        ...old, aiPolicy: result.aiPolicy, aiPolicyRevision: result.aiPolicyRevision,
      } : old);
      setDraft(result.aiPolicy);
      setNotice(result.synchronization?.status === 'pending'
        ? 'Policy saved locally. Upstream label synchronization is pending.' : 'Policy saved.');
      await qc.invalidateQueries({ queryKey: ['pages'] });
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 409) {
        setConflict(true);
        setNotice('Policy was not saved. Refresh and review the current revision; your selection is kept.');
      } else if (error instanceof ApiError && [401, 403, 404].includes(error.statusCode)) {
        setDenied(true);
        setDraft(null);
        qc.removeQueries({ queryKey: ['pages', pageId], exact: true });
        setNotice('Policy controls are unavailable because access or mutation permission changed.');
      } else setNotice('Policy was not saved. Your selection is kept; retry when the policy is available.');
    } finally { setPending(false); }
  }

  async function refresh() {
    const result = await query.refetch();
    if (!result.isError) { setConflict(false); setDenied(false); setNotice('Current policy refreshed. Review your selection before saving.'); }
  }

  return <section className="space-y-2 px-3 py-4 text-xs" aria-label="Article AI policy" aria-busy={pending || query.isFetching}>
    <h3 className="font-semibold">AI policy</h3>
    {permissionLost ? <p role="status">AI policy details are no longer available.</p>
      : query.isLoading ? <p role="status">Loading AI policy…</p>
        : policy ? <><AiPolicyChip policy={policy} /><p>{AI_POLICY_EXPLANATION[policy]}</p></>
          : <p>AI policy is unknown or unsupported. No editable default is assumed.</p>}
    {query.isError && !permissionLost && <p role="alert">{query.data ? 'Cached policy is stale. Refresh before making changes.' : 'AI policy could not be loaded.'}</p>}
    {detail?.aiPolicyActivation === 'foundation_only' && <p>Policy controls are unavailable until enforcement is activated.</p>}
    {editable && selected && <div className="space-y-2">
      <label className="block">Change AI policy
        <select className="nm-select-md mt-1 w-full" value={selected} disabled={pending} onChange={(e) => setDraft(e.target.value as AiPolicy)}>
          {Object.entries(AI_POLICY_CHIP_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <p>Removing a reserved label alone does not change policy. Change the policy explicitly here.</p>
      <button className="nm-button-ghost px-3 py-2" type="button" aria-disabled={pending || refreshing || conflict || selected === policy} onClick={() => {
        if (pending || refreshing || conflict || selected === policy) return;
        if (selected === 'none') setConfirm(true); else void save();
      }}>{pending ? 'Saving policy…' : refreshing ? 'Refreshing policy…' : 'Save policy'}</button>
    </div>}
    <p role="status">{notice}</p>
    <button type="button" className="nm-button-ghost px-3 py-2" aria-disabled={query.isFetching || pending} onClick={() => { if (!query.isFetching && !pending) void refresh(); }}>Refresh / review policy</button>
    <ConfirmDialog open={confirm && editable} title={NO_AI_CONFIRMATION.title}
      description={`The committed change removes ${NO_AI_CONFIRMATION.removes.join(', ')}. It keeps ${NO_AI_CONFIRMATION.remains.join(', ')}. ${NO_AI_CONFIRMATION.limits.join(' ')}`}
      confirmLabel={NO_AI_CONFIRMATION.confirmLabel} onConfirm={() => void save()} onCancel={() => setConfirm(false)} />
  </section>;
}
