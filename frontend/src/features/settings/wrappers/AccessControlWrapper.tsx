import { lazy, Suspense } from 'react';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { useEnterprise } from '../../../shared/enterprise/use-enterprise';

const UsersAdminPage = lazy(() => import('../../admin/UsersAdminPage').then((m) => ({ default: m.UsersAdminPage })));
const RbacPage = lazy(() => import('../../admin/RbacPage').then((m) => ({ default: m.RbacPage })));
const OidcSettingsPage = lazy(() => import('../../admin/OidcSettingsPage').then((m) => ({ default: m.OidcSettingsPage })));
const IpAllowlistTab = lazy(() => import('../../admin/IpAllowlistTab').then((m) => ({ default: m.IpAllowlistTab })));
const RateLimitsTab = lazy(() => import('../RateLimitsTab').then((m) => ({ default: m.RateLimitsTab })));
const RegistrationPolicyTab = lazy(() => import('../RegistrationPolicyTab').then((m) => ({ default: m.RegistrationPolicyTab })));

/**
 * "Access Control" wrapper — collapses Users, Roles, SSO, IP allowlist, and
 * Rate Limits into one nav entry. Users + Rate Limits are CE; the rest are
 * EE-gated. SSO is EE but not behind a feature flag (it ships with every EE
 * tier), so the visibility check is `isEnterprise` alone.
 */
export function AccessControlWrapper() {
  const { isEnterprise, hasFeature } = useEnterprise();

  const tabs: SubTabDef[] = [
    {
      id: 'users',
      label: 'Users',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <UsersAdminPage />
        </Suspense>
      ),
    },
    {
      id: 'rbac',
      label: 'Roles',
      badge: 'EE',
      visible: isEnterprise && hasFeature('advanced_rbac'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <RbacPage />
        </Suspense>
      ),
    },
    {
      id: 'sso',
      label: 'SSO / OIDC',
      badge: 'EE',
      visible: isEnterprise,
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <OidcSettingsPage />
        </Suspense>
      ),
    },
    {
      id: 'ip-allowlist',
      label: 'IP allowlist',
      badge: 'EE',
      visible: isEnterprise && hasFeature('ip_allowlisting'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <IpAllowlistTab />
        </Suspense>
      ),
    },
    {
      id: 'rate-limits',
      label: 'Rate limits',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <RateLimitsTab />
        </Suspense>
      ),
    },
    {
      id: 'registration',
      label: 'Registration',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <RegistrationPolicyTab />
        </Suspense>
      ),
    },
  ];

  return (
    <>
      <PanelHeader
        title="Access Control"
        subtitle="Users, rate limits, and — with EE — roles, SSO, and IP allowlisting."
      />
      <SubTabs ariaLabel="Access Control sub-sections" tabs={tabs} testIdRoot="access" />
    </>
  );
}
