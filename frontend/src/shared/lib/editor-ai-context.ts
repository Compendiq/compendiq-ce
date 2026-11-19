import { createContext } from 'react';
import type { AiPolicy } from '@compendiq/contracts';

/** Unknown identity or permission is never a free-form inference exemption. */
export const EditorAiContext = createContext<{
  pageId?: string;
  policy?: AiPolicy;
  revision?: number;
  permitted?: boolean;
}>({});
