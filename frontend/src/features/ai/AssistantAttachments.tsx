/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useAttachments } from '../../shared/hooks/use-attachments';
import { imageDisabledReason } from '../../shared/components/upload/ImageAttachZone';
import { useAiContext } from './AiContext';

type AssistantAttachmentsValue = ReturnType<typeof useAttachments>;

const AssistantAttachmentsContext = createContext<AssistantAttachmentsValue | null>(null);

/**
 * Keeps one attachment controller alive while `/ai` switches between actions.
 *
 * Mode inputs also mount this boundary for their focused unit tests. When the
 * page already owns the boundary, the nested instance reuses it instead of
 * creating a second upload controller or a second set of drop listeners.
 */
export function AssistantAttachmentsScope({ children }: { children: ReactNode }) {
  const existing = useContext(AssistantAttachmentsContext);
  if (existing) return children;
  return <AssistantAttachmentsOwner>{children}</AssistantAttachmentsOwner>;
}

function AssistantAttachmentsOwner({ children }: { children: ReactNode }) {
  const {
    mode, pageId, isStreaming, chatVision, chatVisionModel,
  } = useAiContext();
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments({
    dropTargetRef,
    imageEnabled: chatVision === true,
    imageDisabledReason: imageDisabledReason(chatVision, chatVisionModel),
    // Diagram has no attachment fields in its request contract. Keep already
    // staged files for switching back, but never accept an invisible new one.
    disabled: isStreaming || mode === 'diagram',
  });

  const { clearAll } = attachments;
  useEffect(() => {
    // Uploaded sources describe the page/request they were prepared beside.
    // Do not let them silently cross into another page context.
    clearAll();
  }, [pageId, clearAll]);

  return (
    <AssistantAttachmentsContext.Provider value={attachments}>
      {/* `contents` keeps the existing composer geometry and DOM focus order;
          this stable ancestor only owns native drop and paste listeners. */}
      <div ref={dropTargetRef} className="contents">
        {children}
      </div>
    </AssistantAttachmentsContext.Provider>
  );
}

export function useAssistantAttachments(): AssistantAttachmentsValue {
  const attachments = useContext(AssistantAttachmentsContext);
  if (!attachments) {
    throw new Error('useAssistantAttachments must be used within AssistantAttachmentsScope');
  }
  return attachments;
}
