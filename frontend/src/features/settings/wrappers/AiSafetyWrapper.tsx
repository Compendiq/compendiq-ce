import { lazy, Suspense } from 'react';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { useEnterprise } from '../../../shared/enterprise/use-enterprise';

const AiSafetyTab = lazy(() => import('../AiSafetyTab').then((m) => ({ default: m.AiSafetyTab })));
const LlmPolicyTab = lazy(() => import('../../admin/LlmPolicyTab').then((m) => ({ default: m.LlmPolicyTab })));
const PiiPolicyTab = lazy(() => import('../../admin/PiiPolicyTab').then((m) => ({ default: m.PiiPolicyTab })));
const ReviewerQueuePage = lazy(() => import('../../ai/ReviewerQueuePage').then((m) => ({ default: m.ReviewerQueuePage })));
const AiReviewPolicyTab = lazy(() => import('../../admin/AiReviewPolicyTab').then((m) => ({ default: m.AiReviewPolicyTab })));
const LlmAuditPage = lazy(() => import('../../admin/LlmAuditPage').then((m) => ({ default: m.LlmAuditPage })));

/**
 * "AI Safety" wrapper — single entry-point for everything that constrains
 * or audits LLM behaviour. CE shows just the AI Safety tab; EE reveals
 * policy, PII, reviewer queue, review policy, and audit tabs based on the
 * licensed feature set.
 */
export function AiSafetyWrapper() {
  const { isEnterprise, hasFeature } = useEnterprise();

  const tabs: SubTabDef[] = [
    {
      id: 'safety',
      label: 'Input/Output Safety',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <AiSafetyTab />
        </Suspense>
      ),
    },
    {
      id: 'llm-policy',
      label: 'LLM Policy',
      badge: 'EE',
      visible: isEnterprise && hasFeature('org_llm_policy'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <LlmPolicyTab />
        </Suspense>
      ),
    },
    {
      id: 'pii',
      label: 'PII detection',
      badge: 'EE',
      visible: isEnterprise && hasFeature('pii_detection'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <PiiPolicyTab />
        </Suspense>
      ),
    },
    {
      id: 'reviews',
      label: 'Review queue',
      badge: 'EE',
      visible: isEnterprise && hasFeature('ai_output_review'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <ReviewerQueuePage />
        </Suspense>
      ),
    },
    {
      id: 'review-policy',
      label: 'Review policy',
      badge: 'EE',
      visible: isEnterprise && hasFeature('ai_output_review'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <AiReviewPolicyTab />
        </Suspense>
      ),
    },
    {
      id: 'llm-audit',
      label: 'Audit log',
      badge: 'EE',
      visible: isEnterprise && hasFeature('llm_audit_trail'),
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <LlmAuditPage />
        </Suspense>
      ),
    },
  ];

  return (
    <>
      <PanelHeader
        title="AI Safety"
        subtitle="Guardrails, output rules, and (with EE) review policy, audit log, and PII detection."
      />
      <SubTabs ariaLabel="AI Safety sub-sections" tabs={tabs} testIdRoot="ai-safety" />
    </>
  );
}
