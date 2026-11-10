import type { LlmProvider } from '@compendiq/contracts';
import { formatDateStamp } from '../../../shared/lib/format-relative-time';

type Declaration = Pick<LlmProvider, 'localityDeclaredAt' | 'localityDeclaredBy' | 'localityDeclaredByName'>;

/**
 * Who declared a provider's locality, and when (#1882). The declarer is named
 * by the server-resolved display name; the UUID is the accountability record
 * and is never shown. A declarer the server cannot name — the account was
 * deleted, or a server that predates the field — reads "an administrator".
 * The date follows the inspector's rule: `formatDateStamp` visible, the exact
 * time of day in the `title`.
 */
export function ProviderLocalityDeclaration({ provider, className }: { provider: Declaration; className?: string }) {
  const { localityDeclaredAt: at, localityDeclaredBy: by, localityDeclaredByName: name } = provider;
  if (!at && !by) return null;
  return (
    <p className={className} data-testid="provider-locality-declaration">
      Declared by {name ? <bdi>{name}</bdi> : 'an administrator'}
      {at && (
        <>
          {' · '}
          <time dateTime={at} title={new Date(at).toLocaleString()} className="whitespace-nowrap">{formatDateStamp(at)}</time>
        </>
      )}
    </p>
  );
}
