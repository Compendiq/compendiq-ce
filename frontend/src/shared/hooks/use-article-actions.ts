import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../lib/api';
import { downloadArticlePdf } from '../lib/article-pdf-download';
import { usePermission } from './use-permission';
import { useResyncPage } from './use-pages';
import { useExportPdf } from './use-standalone';

/** Shared read-mode and rail article action state (export, resync, relocate, auto-tag). */
export function useArticleActions(id: string | undefined, pageTitle?: string | null) {
  const resyncMutation = useResyncPage();
  const exportPdf = useExportPdf();
  const { allowed: canRelocate } = usePermission('pages:relocate');
  const [relocateOpen, setRelocateOpen] = useState(false);
  const [confirmResyncOpen, setConfirmResyncOpen] = useState(false);

  // Optimistic visibility while the query loads so Auto-tag never flickers out.
  const autoTagDefaultQuery = useQuery<{ model?: string | null }>({
    queryKey: ['llm', 'usecase-default', 'auto_tag'],
    queryFn: () => apiFetch('/llm/usecase-default?usecase=auto_tag'),
    retry: false,
    staleTime: 30_000,
  });
  const aiAutoTagAvailable =
    autoTagDefaultQuery.isLoading || Boolean(autoTagDefaultQuery.data?.model);

  const handleExportPdf = useCallback(async () => {
    if (!id) return;
    try {
      downloadArticlePdf(await exportPdf.mutateAsync(parseInt(id, 10)), pageTitle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PDF export failed';
      toast.error(msg.includes('Chromium') ? 'PDF generation unavailable — Chromium not installed on the server' : msg);
    }
  }, [id, pageTitle, exportPdf]);

  const openResyncConfirm = useCallback(() => {
    if (!id) return;
    setConfirmResyncOpen(true);
  }, [id]);

  const handleConfirmResync = useCallback(() => {
    setConfirmResyncOpen(false);
    if (!id) return;
    resyncMutation.mutate(id, {
      onSuccess: (data) => {
        if (data.succeeded > 0) {
          toast.success('Re-synced from Confluence.');
        } else if (data.failed > 0 || data.errors.length > 0) {
          toast.error(data.errors[0] ?? 'Re-sync failed.');
        } else {
          toast.info('Nothing to re-sync.');
        }
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : 'Re-sync failed.'),
    });
  }, [id, resyncMutation]);

  return {
    exportPdf,
    handleExportPdf,
    resyncMutation,
    confirmResyncOpen,
    setConfirmResyncOpen,
    openResyncConfirm,
    handleConfirmResync,
    aiAutoTagAvailable,
    canRelocate,
    relocateOpen,
    setRelocateOpen,
  };
}
