import { lazy, Suspense } from 'react';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';

const SmtpSettingsTab = lazy(() => import('../SmtpSettingsTab').then((m) => ({ default: m.SmtpSettingsTab })));
const SearxngTab = lazy(() => import('../SearxngTab').then((m) => ({ default: m.SearxngTab })));
const McpDocsTab = lazy(() => import('../McpDocsTab').then((m) => ({ default: m.McpDocsTab })));

/**
 * "Integrations" wrapper — Email/SMTP, SearXNG, and MCP docs share the same
 * "external service the platform talks to" character, so they fold cleanly
 * into one nav entry with three sub-tabs.
 */
export function IntegrationsWrapper() {
  const tabs: SubTabDef[] = [
    {
      id: 'email',
      label: 'Email / SMTP',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <SmtpSettingsTab />
        </Suspense>
      ),
    },
    {
      id: 'searxng',
      label: 'SearXNG',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <SearxngTab />
        </Suspense>
      ),
    },
    {
      id: 'mcp-docs',
      label: 'MCP Docs',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <McpDocsTab />
        </Suspense>
      ),
    },
  ];

  return (
    <>
      <PanelHeader
        title="Integrations"
        subtitle="External services Compendiq talks to: SMTP, SearXNG, MCP documentation."
      />
      <SubTabs ariaLabel="Integrations sub-sections" tabs={tabs} testIdRoot="integrations" />
    </>
  );
}
