import { lazy, Suspense } from 'react';
import type { SettingsResponse } from '@compendiq/contracts';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { useEnterprise } from '../../../shared/enterprise/use-enterprise';

const SpacesTab = lazy(() => import('../SpacesTab').then((m) => ({ default: m.SpacesTab })));
const SyncTab = lazy(() => import('../panels/SyncTab').then((m) => ({ default: m.SyncTab })));
const SyncConflictPolicyTab = lazy(() => import('../../admin/SyncConflictPolicyTab').then((m) => ({ default: m.SyncConflictPolicyTab })));
const SyncConflictsPage = lazy(() => import('../../admin/SyncConflictsPage').then((m) => ({ default: m.SyncConflictsPage })));

interface Props {
  settings: SettingsResponse | undefined;
  isLoading: boolean;
  onSaveSettingsAsync: (body: Record<string, unknown>) => Promise<unknown>;
}

/**
 * "Spaces & Sync" wrapper — consolidates the four content-sync surfaces into
 * one nav entry with sub-tabs. EE-gated tabs (conflict policy/queue) reveal
 * automatically when the `sync_conflict_resolution` feature is licensed.
 */
export function SpacesSyncWrapper({ settings, isLoading, onSaveSettingsAsync }: Props) {
  const { isEnterprise, hasFeature } = useEnterprise();
  const showConflicts = isEnterprise && hasFeature('sync_conflict_resolution');

  const tabs: SubTabDef[] = [
    {
      id: 'spaces',
      label: 'Spaces',
      render: () => {
        if (isLoading || !settings) return <SkeletonFormFields />;
        return (
          <Suspense fallback={<SkeletonFormFields />}>
            <SpacesTab
              selectedSpaces={settings.selectedSpaces ?? []}
              showSpaceHomeContent={settings.showSpaceHomeContent ?? true}
              onSave={onSaveSettingsAsync}
            />
          </Suspense>
        );
      },
    },
    {
      id: 'sync',
      label: 'Sync schedule',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <SyncTab />
        </Suspense>
      ),
    },
    {
      id: 'conflict-policy',
      label: 'Conflict policy',
      badge: 'EE',
      visible: showConflicts,
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <SyncConflictPolicyTab />
        </Suspense>
      ),
    },
    {
      id: 'conflicts',
      label: 'Conflicts queue',
      badge: 'EE',
      visible: showConflicts,
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <SyncConflictsPage />
        </Suspense>
      ),
    },
  ];

  return (
    <>
      <PanelHeader
        title="Spaces & Sync"
        subtitle="Pick which Confluence spaces to mirror and how often Compendiq pulls updates."
      />
      <SubTabs ariaLabel="Spaces & Sync sub-sections" tabs={tabs} testIdRoot="spaces-sync" />
    </>
  );
}
