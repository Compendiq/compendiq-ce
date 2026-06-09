import { lazy, Suspense } from 'react';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';

const LlmTab = lazy(() => import('../panels/LlmTab').then((m) => ({ default: m.LlmTab })));
const EmbeddingTab = lazy(() => import('../panels/EmbeddingTab').then((m) => ({ default: m.EmbeddingTab })));
const WorkersTab = lazy(() => import('../WorkersTab').then((m) => ({ default: m.WorkersTab })));

/**
 * "AI Models" wrapper — folds LLM provider config, embedding-model config,
 * and the workers/queue dashboard into one nav entry. All three sub-panels
 * are CE-visible to admins.
 */
export function AiModelsWrapper() {
  const tabs: SubTabDef[] = [
    {
      id: 'llm',
      label: 'LLM providers',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <LlmTab />
        </Suspense>
      ),
    },
    {
      id: 'embedding',
      label: 'Embeddings',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <EmbeddingTab />
        </Suspense>
      ),
    },
    {
      id: 'workers',
      label: 'Workers',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <WorkersTab />
        </Suspense>
      ),
    },
  ];

  return (
    <>
      <PanelHeader
        title="AI Models"
        subtitle="Configure LLM providers, embedding model, and worker concurrency."
      />
      <SubTabs ariaLabel="AI Models sub-sections" tabs={tabs} testIdRoot="ai-models" />
    </>
  );
}
