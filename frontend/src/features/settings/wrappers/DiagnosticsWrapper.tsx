import { lazy, Suspense } from 'react';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';

const SystemTab = lazy(() => import('../panels/SystemTab').then((m) => ({ default: m.SystemTab })));
const ErrorDashboard = lazy(() => import('../ErrorDashboard').then((m) => ({ default: m.ErrorDashboard })));

/**
 * "Diagnostics" wrapper — system status + error dashboard. Both are
 * "operator looks at the live state of the deployment" tools, so they
 * pair naturally and the old separate rail entries felt like clutter.
 */
export function DiagnosticsWrapper() {
  const tabs: SubTabDef[] = [
    {
      id: 'system',
      label: 'System status',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <SystemTab />
        </Suspense>
      ),
    },
    {
      id: 'errors',
      label: 'Errors',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <ErrorDashboard />
        </Suspense>
      ),
    },
  ];

  return (
    <>
      <PanelHeader
        title="Diagnostics"
        subtitle="Live system status, application info, and the recent-errors log."
      />
      <SubTabs ariaLabel="Diagnostics sub-sections" tabs={tabs} testIdRoot="diagnostics" />
    </>
  );
}
