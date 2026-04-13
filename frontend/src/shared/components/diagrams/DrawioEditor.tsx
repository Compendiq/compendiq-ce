import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';

/** Self-hosted draw.io served from /drawio/ by the same nginx.
 *  offline=1&stealth=1 disables all cloud integrations (Drive, OneDrive, etc.). */
const DRAWIO_ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const DRAWIO_URL = `${DRAWIO_ORIGIN}/drawio/?embed=1&proto=json&spin=1&ui=atlas&saveAndExit=1&offline=1&stealth=1`;

/** Timeout in ms to wait for the draw.io iframe 'init' event before showing the error state */
const DRAWIO_INIT_TIMEOUT_MS = 15_000;

export interface DrawioEditorProps {
  /** Raw draw.io XML of the diagram to edit */
  xml: string;
  /** Called when the user saves the diagram. Receives the exported PNG data URI and updated XML. */
  onSave: (dataUri: string, xml: string) => Promise<void>;
  /** Called when the user closes the editor without saving */
  onClose: () => void;
  /**
   * Optional URL of the draw.io embed server.
   * Used in deployments where embed.diagrams.net is blocked by a firewall.
   * Falls back to DRAWIO_ORIGIN if omitted or if the provided value is not a valid URL.
   */
  drawioUrl?: string;
}

type EditorPhase = 'loading' | 'ready' | 'saving' | 'error';

/**
 * Full-screen iframe overlay that loads the self-hosted draw.io embed editor.
 *
 * Protocol:
 * 1. iframe sends { event: 'init' } when ready
 * 2. We respond with { action: 'load', xml } to load the diagram
 * 3. User clicks Save -> iframe sends { event: 'save', xml }
 * 4. We request a PNG export: { action: 'export', format: 'xmlpng' }
 * 5. iframe sends { event: 'export', data: <data-uri> }
 * 6. We call onSave(dataUri, xml) then send { action: 'exit' }
 */
export function DrawioEditor({ xml, onSave, onClose, drawioUrl }: DrawioEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<EditorPhase>('loading');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // Key used to force-remount the iframe on retry
  const [iframeKey, setIframeKey] = useState(0);

  // Store the latest XML from save events so we can pair it with the export
  const pendingXmlRef = useRef<string>('');
  // Timeout ref for the init timeout
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute effective origin and URL from the optional drawioUrl prop.
  // A defensive try/catch prevents a crash if the stored value is somehow
  // an invalid URL despite Zod .url() validation on the write path.
  const effectiveOrigin = useMemo(() => {
    if (drawioUrl) {
      try {
        return new URL(drawioUrl).origin;
      } catch {
        return DRAWIO_ORIGIN;
      }
    }
    return DRAWIO_ORIGIN;
  }, [drawioUrl]);

  const effectiveUrl = useMemo(() => {
    if (drawioUrl) {
      return `${drawioUrl.replace(/\/$/, '')}/?embed=1&proto=json&spin=1&ui=atlas&saveAndExit=1`;
    }
    return DRAWIO_URL;
  }, [drawioUrl]);

  const postToDrawio = useCallback(
    (msg: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), effectiveOrigin);
    },
    [effectiveOrigin],
  );

  // 15-second timeout: if init never arrives, transition to error state
  useEffect(() => {
    timeoutRef.current = setTimeout(() => {
      // Functional setState: only transition loading→error, not ready→error
      setPhase((prev) => (prev === 'loading' ? 'error' : prev));
    }, DRAWIO_INIT_TIMEOUT_MS);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  // Re-run when iframeKey changes (i.e. on retry) to reset the timeout
  }, [iframeKey]);

  // Handle messages from the draw.io iframe
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Security: only accept messages from the configured draw.io origin
      if (event.origin !== effectiveOrigin) return;

      let data: { event?: string; xml?: string; data?: string };
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      switch (data.event) {
        case 'init':
          // Clear the init timeout — we got a response
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          // Editor is ready; load the diagram XML
          postToDrawio({ action: 'load', xml });
          setPhase('ready');
          break;

        case 'save':
          // User clicked save; store XML and request PNG export
          setPhase('saving');
          pendingXmlRef.current = data.xml ?? '';
          setHasUnsavedChanges(false);
          postToDrawio({
            action: 'export',
            format: 'xmlpng',
            xml: data.xml,
            spinKey: 'saving',
          });
          break;

        case 'export':
          // PNG export arrived; persist and exit
          if (data.data) {
            onSave(data.data, pendingXmlRef.current)
              .then(() => {
                postToDrawio({ action: 'exit' });
              })
              .catch(() => {
                // Save failed — return to ready state so user can retry
                setPhase('ready');
              });
          }
          break;

        case 'exit':
          onClose();
          break;

        default:
          // Track unsaved changes on any other events (e.g. 'configure', 'autosave')
          if (data.event === 'autosave') {
            setHasUnsavedChanges(true);
          }
          break;
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [xml, onSave, onClose, postToDrawio, effectiveOrigin]);

  // Warn on Escape or browser close with unsaved changes
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (hasUnsavedChanges) {
        e.preventDefault();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (hasUnsavedChanges) {
          const leave = window.confirm(
            'You have unsaved changes in the diagram editor. Discard changes and close?',
          );
          if (!leave) return;
        }
        onClose();
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [hasUnsavedChanges, onClose]);

  const handleRetry = useCallback(() => {
    setPhase('loading');
    setIframeKey((k) => k + 1);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      data-testid="drawio-editor-overlay"
    >
      {phase === 'loading' && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          data-testid="drawio-loading"
        >
          <Loader2 className="h-8 w-8 animate-spin text-white" />
          <span className="ml-3 text-sm text-white/70">Loading diagram editor...</span>
        </div>
      )}

      {phase === 'error' && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          data-testid="drawio-error"
        >
          <div className="mx-4 flex max-w-md flex-col items-center gap-4 rounded-xl border border-white/10 bg-black/80 p-8 text-center backdrop-blur-md">
            <AlertTriangle className="h-10 w-10 text-amber-400" />
            <h3 className="text-lg font-medium text-white">Could not load diagram editor</h3>
            <p className="text-sm text-white/60">
              The self-hosted draw.io editor did not respond. Check that the /drawio/ static files
              are deployed correctly in the nginx container.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleRetry}
                className="flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm text-white transition-colors hover:bg-white/20"
                data-testid="drawio-retry-btn"
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </button>
              <button
                onClick={onClose}
                className="flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm text-white transition-colors hover:bg-white/20"
                data-testid="drawio-close-btn"
              >
                <X className="h-4 w-4" />
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <iframe
        key={iframeKey}
        ref={iframeRef}
        src={effectiveUrl}
        className="h-full w-full border-0"
        title="Draw.io Diagram Editor"
        data-testid="drawio-iframe"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads"
      />
    </div>
  );
}

export { DRAWIO_ORIGIN, DRAWIO_URL };
