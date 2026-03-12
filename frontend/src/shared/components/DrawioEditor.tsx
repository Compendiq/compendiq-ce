import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

const DRAWIO_ORIGIN = 'https://embed.diagrams.net';
const DRAWIO_URL = `${DRAWIO_ORIGIN}/?embed=1&proto=json&spin=1&ui=atlas&saveAndExit=1`;

export interface DrawioEditorProps {
  /** Raw draw.io XML of the diagram to edit */
  xml: string;
  /** Called when the user saves the diagram. Receives the exported PNG data URI and updated XML. */
  onSave: (dataUri: string, xml: string) => Promise<void>;
  /** Called when the user closes the editor without saving */
  onClose: () => void;
}

type EditorPhase = 'loading' | 'ready' | 'saving';

/**
 * Full-screen iframe overlay that loads the draw.io embed editor.
 *
 * Protocol:
 * 1. iframe sends { event: 'init' } when ready
 * 2. We respond with { action: 'load', xml } to load the diagram
 * 3. User clicks Save -> iframe sends { event: 'save', xml }
 * 4. We request a PNG export: { action: 'export', format: 'xmlpng' }
 * 5. iframe sends { event: 'export', data: <data-uri> }
 * 6. We call onSave(dataUri, xml) then send { action: 'exit' }
 */
export function DrawioEditor({ xml, onSave, onClose }: DrawioEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<EditorPhase>('loading');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Store the latest XML from save events so we can pair it with the export
  const pendingXmlRef = useRef<string>('');

  const postToDrawio = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), DRAWIO_ORIGIN);
  }, []);

  // Handle messages from the draw.io iframe
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Security: only accept messages from the draw.io origin
      if (event.origin !== DRAWIO_ORIGIN) return;

      let data: { event?: string; xml?: string; data?: string };
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      switch (data.event) {
        case 'init':
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
  }, [xml, onSave, onClose, postToDrawio]);

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

      <iframe
        ref={iframeRef}
        src={DRAWIO_URL}
        className="h-full w-full border-0"
        title="Draw.io Diagram Editor"
        data-testid="drawio-iframe"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </div>
  );
}

export { DRAWIO_ORIGIN, DRAWIO_URL };
