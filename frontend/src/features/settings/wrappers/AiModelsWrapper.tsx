import { lazy, Suspense } from 'react';
import { SubTabs, type SubTabDef } from '../SubTabs';
import { PanelHeader } from '../PanelHeader';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';

const LlmTab = lazy(() => import('../panels/LlmTab').then((m) => ({ default: m.LlmTab })));
const EmbeddingTab = lazy(() => import('../panels/EmbeddingTab').then((m) => ({ default: m.EmbeddingTab })));
const WorkersTab = lazy(() => import('../WorkersTab').then((m) => ({ default: m.WorkersTab })));
const RetrievalTab = lazy(() => import('../panels/RetrievalTab').then((m) => ({ default: m.RetrievalTab })));
const ClientInferenceTab = lazy(() => import('../panels/ClientInferenceTab').then((m) => ({ default: m.ClientInferenceTab })));

/**
 * "AI Models" wrapper — folds LLM provider config, embedding-model config,
 * the retrieval knobs and the workers/queue dashboard into one nav entry. All
 * four sub-panels are CE-visible to admins.
 *
 * Retrieval sits after Embeddings and before Workers: it configures the stage
 * between "what the embedding model indexed" and "what the chat model is
 * handed", and its rerank pool points back at the LLM providers tab for the
 * assignment that switches that stage on (#1118).
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
      id: 'retrieval',
      label: 'Retrieval',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <RetrievalTab />
        </Suspense>
      ),
    },
    {
      id: 'client-inference',
      label: 'Client inference',
      render: () => (
        <Suspense fallback={<SkeletonFormFields />}>
          <ClientInferenceTab />
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
        subtitle="Configure LLM providers, embedding model, retrieval tuning, and worker concurrency."
      />
      <SubTabs ariaLabel="AI Models sub-sections" tabs={tabs} testIdRoot="ai-models" />
    </>
  );
}
