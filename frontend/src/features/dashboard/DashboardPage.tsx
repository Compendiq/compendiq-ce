import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import {
  BookOpen, Layers, Bot, RefreshCw,
  Plus, Settings, FileText, Sparkles, Cpu, Loader2,
} from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { useSpaces, useSync } from '../../shared/hooks/use-spaces';
import { usePages, useEmbeddingStatus, useTriggerEmbedding } from '../../shared/hooks/use-pages';
import { FreshnessBadge } from '../../shared/components/FreshnessBadge';
import { KnowledgeGaps } from './KnowledgeGaps';

const stagger = {
  animate: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
};

const quickActions = [
  { icon: RefreshCw, label: 'Sync Now', path: '/pages', color: 'text-info' },
  { icon: Plus, label: 'New Page', path: '/pages/new', color: 'text-success' },
  { icon: Sparkles, label: 'AI Assistant', path: '/ai', color: 'text-primary' },
  { icon: Settings, label: 'Manage Spaces', path: '/settings', color: 'text-warning' },
];

export function DashboardPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { data: spaces } = useSpaces();
  const { data: pages } = usePages({ limit: 1 });
  const { data: recentPages } = usePages({ sort: 'modified', limit: 5 });
  const { data: embeddingStatus } = useEmbeddingStatus();
  const syncMutation = useSync();
  const triggerEmbedding = useTriggerEmbedding();

  const embeddedPagesLabel = embeddingStatus
    ? `${embeddingStatus.embeddedPages} / ${embeddingStatus.totalPages}`
    : '--';

  const stats = [
    { icon: Layers, label: 'Spaces', value: spaces ? String(spaces.length) : '--', color: 'text-info' },
    { icon: BookOpen, label: 'Pages', value: pages ? String(pages.total) : '--', color: 'text-success' },
    { icon: Bot, label: 'Embedded Pages', value: embeddedPagesLabel, color: 'text-primary' },
    { icon: Cpu, label: 'Chunks', value: embeddingStatus ? String(embeddingStatus.totalEmbeddings) : '--', color: 'text-warning' },
  ];

  const handleQuickAction = (path: string, label: string) => {
    if (label === 'Sync Now') {
      syncMutation.mutate();
    }
    navigate(path);
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">
        Welcome back, {user?.username}
      </h1>

      {/* Stats cards */}
      <m.div
        variants={stagger}
        initial="initial"
        animate="animate"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {stats.map(({ icon: Icon, label, value, color }) => (
          <m.div
            key={label}
            variants={fadeUp}
            className="glass-card-hover p-5"
          >
            <div className="flex items-center gap-3">
              <div className={`rounded-lg bg-foreground/5 p-2.5 ${color}`}>
                <Icon size={20} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold">{value}</p>
              </div>
            </div>
          </m.div>
        ))}
      </m.div>

      {/* Embedding trigger */}
      {embeddingStatus && embeddingStatus.dirtyPages > 0 && (
        <m.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mt-4 glass-card p-4 flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-foreground/5 p-2.5 text-blue-400">
              <Cpu size={20} />
            </div>
            <div>
              <p className="text-sm font-medium">
                {embeddingStatus.dirtyPages} {embeddingStatus.dirtyPages === 1 ? 'page needs' : 'pages need'} embedding
              </p>
              <p className="text-xs text-muted-foreground">
                {embeddingStatus.embeddedPages} / {embeddingStatus.totalPages} pages embedded
              </p>
            </div>
          </div>
          <button
            onClick={() => triggerEmbedding.mutate()}
            disabled={embeddingStatus.isProcessing || triggerEmbedding.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {embeddingStatus.isProcessing ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Sparkles size={16} />
                Embed Now
              </>
            )}
          </button>
        </m.div>
      )}

      {/* Quick Actions */}
      <m.div
        variants={stagger}
        initial="initial"
        animate="animate"
        className="mt-8"
      >
        <h2 className="mb-4 text-lg font-semibold">Quick Actions</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {quickActions.map(({ icon: Icon, label, path, color }) => (
            <m.button
              key={label}
              variants={fadeUp}
              onClick={() => handleQuickAction(path, label)}
              className="glass-card-hover flex flex-col items-center gap-2 p-4"
            >
              <div className={`rounded-lg bg-foreground/5 p-2.5 ${color}`}>
                <Icon size={20} />
              </div>
              <span className="text-sm font-medium">{label}</span>
            </m.button>
          ))}
        </div>
      </m.div>

      {/* Recent Articles */}
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-8"
      >
        <h2 className="mb-4 text-lg font-semibold">Recent Articles</h2>
        {recentPages?.items.length ? (
          <div className="space-y-2">
            {recentPages.items.map((page, i) => (
              <m.button
                key={page.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 + i * 0.05 }}
                onClick={() => navigate(`/pages/${page.id}`)}
                className="glass-card-hover flex w-full items-center gap-4 p-4 text-left"
              >
                <FileText size={18} className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{page.title}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{page.spaceKey}</span>
                    {page.lastModifiedAt && (
                      <span>{new Date(page.lastModifiedAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                {page.lastModifiedAt && (
                  <FreshnessBadge lastModified={page.lastModifiedAt} />
                )}
              </m.button>
            ))}
          </div>
        ) : (
          <div className="glass-card p-6 text-center text-sm text-muted-foreground">
            No articles yet. Sync your Confluence spaces to see recent pages.
          </div>
        )}
      </m.div>

      {/* Knowledge Gaps (admin only) */}
      {user?.role === 'admin' && (
        <div className="mt-8">
          <KnowledgeGaps />
        </div>
      )}

      {/* Getting Started */}
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="mt-8 glass-card p-6"
      >
        <h2 className="mb-4 text-lg font-semibold">Getting Started</h2>
        <p className="text-muted-foreground">
          Configure your Confluence connection and Ollama model in{' '}
          <a href="/settings" className="text-primary underline">Settings</a>{' '}
          to start managing your knowledge base.
        </p>
      </m.div>
    </div>
  );
}
