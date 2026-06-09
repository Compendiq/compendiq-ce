import { lazy, Suspense } from 'react';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { useEnterprise } from '../../../shared/enterprise/use-enterprise';

const DataRetentionTab = lazy(() => import('../../admin/DataRetentionTab').then((m) => ({ default: m.DataRetentionTab })));
const ComplianceReportsTab = lazy(() => import('../../admin/ComplianceReportsTab').then((m) => ({ default: m.ComplianceReportsTab })));
const WebhooksTab = lazy(() => import('../../admin/WebhooksTab').then((m) => ({ default: m.WebhooksTab })));
const ScimSettingsPage = lazy(() => import('../../admin/ScimSettingsPage').then((m) => ({ default: m.ScimSettingsPage })));

/**
 * "Data & Compliance" wrapper — all-EE container for the four
 * compliance-grade surfaces: retention, audit reports, outbound webhooks,
 * SCIM provisioning. Each sub-tab is hidden unless its feature flag is on,
 * so a tier that only ships retention won't show empty SCIM/webhook tabs.
 */
export function ComplianceWrapper() {
  const { isEnterprise, hasFeature } = useEnterprise();

  const tabs: SubTabDef[] = [
    {
      id: 'retention',
      label: 'Retention',
      badge: 'EE',
      visible: isEnterprise && hasFeature('data_retention_policies'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <DataRetentionTab />
        </Suspense>
      ),
    },
    {
      id: 'reports',
      label: 'Reports',
      badge: 'EE',
      visible: isEnterprise && hasFeature('compliance_reports'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <ComplianceReportsTab />
        </Suspense>
      ),
    },
    {
      id: 'webhooks',
      label: 'Webhooks',
      badge: 'EE',
      visible: isEnterprise && hasFeature('webhook_push'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <WebhooksTab />
        </Suspense>
      ),
    },
    {
      id: 'scim',
      label: 'SCIM',
      badge: 'EE',
      visible: isEnterprise && hasFeature('scim_provisioning'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <ScimSettingsPage />
        </Suspense>
      ),
    },
  ];

  return (
    <>
      <PanelHeader
        title="Data & Compliance"
        subtitle="Enterprise: retention policy, audit reports, webhook delivery, and SCIM provisioning."
      />
      <SubTabs ariaLabel="Data & Compliance sub-sections" tabs={tabs} testIdRoot="compliance" />
    </>
  );
}
