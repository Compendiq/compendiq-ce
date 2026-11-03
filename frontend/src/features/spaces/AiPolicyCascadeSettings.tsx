import { useState } from 'react';
import { AiPolicyCascadePreviewSchema, type AiPolicyCascadePreview, type AiPolicy } from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';

export function AiPolicyCascadeSettings({ entitled, enforcementAvailable }: { entitled: boolean; enforcementAvailable: boolean }) {
  const [root, setRoot] = useState('');
  const [policy, setPolicy] = useState<AiPolicy>('all');
  const [preview, setPreview] = useState<AiPolicyCascadePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const allowed = entitled && (policy === 'all' || enforcementAvailable);
  const request = async (commit: boolean) => {
    if (!allowed || busy || (commit && !preview)) return;
    setBusy(true); setMessage('');
    try {
      const result = AiPolicyCascadePreviewSchema.parse(await apiFetch(`/pages/${Number(root)}/ai-policy/cascade${commit ? '' : '/preview'}`, {
        method: 'POST', body: JSON.stringify(commit ? {
          policy: preview!.policy, items: preview!.items.map((item) => ({ pageId: item.pageId, expectedRevision: item.revision })),
        } : { policy }),
      }));
      if (commit) { setPreview(null); setMessage(`Policy applied to ${result.items.length} owned articles. ${result.limitation}`); }
      else setPreview(result);
    } catch {
      setPreview(null);
      setMessage(commit
        ? 'The cascade could not be confirmed; it may already have committed. Check current article policies and obtain a new preview before retrying. Authority, license, readiness or revisions may have changed.'
        : 'The preview could not be loaded. The root may be inaccessible, non-standalone or not yours, or license/readiness may have changed. No mutation was requested. For non-standalone roots use the ordinary per-page policy control.');
    } finally { setBusy(false); }
  };
  return <section aria-label="Apply policy to owned subtree" className="mt-6 space-y-3 rounded-lg border border-border p-4">
    <h2 className="font-medium">Apply policy to owned subtree</h2>
    <p>Explicitly changes existing articles, not future inheritance. Only your standalone root and your standalone descendants are included, even for administrators. Other owners and Confluence descendants remain unchanged. No inaccessible titles are shown.</p>
    {!entitled && <p role="status">Cascade requires the live org_llm_policy entitlement.</p>}
    <label>Standalone root article ID<input aria-label="Standalone root article ID" type="number" min="1" value={root} disabled={busy || !entitled} onChange={(e) => { setRoot(e.target.value); setPreview(null); }} /></label>
    <label>Subtree policy<select aria-label="Subtree policy" value={policy} disabled={busy || !entitled} onChange={(e) => { setPolicy(e.target.value as AiPolicy); setPreview(null); }}>
      <option value="all">All AI allowed</option><option value="local_only" disabled={!enforcementAvailable}>Local AI only</option><option value="none" disabled={!enforcementAvailable}>No AI allowed</option>
    </select></label>
    <button type="button" disabled={!allowed || busy || !Number.isSafeInteger(Number(root)) || Number(root) <= 0} onClick={() => void request(false)}>Preview subtree</button>
    {preview && entitled && <div role="status">
      <p>{preview.items.length} owned articles will change. {preview.limitation}</p>
      <button type="button" disabled={!allowed || busy || preview.items.length === 0 || preview.items.length > 1000} onClick={() => void request(true)}>Confirm subtree policy</button>
      <button type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel preview</button>
      {preview.items.length > 1000 && <p>Subtree exceeds the 1000-article mutation limit. Choose a smaller root.</p>}
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
