import { z } from 'zod';

export const ImprovementTypeSchema = z.enum([
  'grammar',
  'structure',
  'clarity',
  'technical',
  'completeness',
]);

export const ImproveRequestSchema = z.object({
  content: z.string().min(1),
  type: ImprovementTypeSchema,
  model: z.string().min(1),
  pageId: z.string().optional(),
});

export const GenerateRequestSchema = z.object({
  prompt: z.string().min(1),
  template: z.enum(['runbook', 'howto', 'architecture', 'troubleshooting']).optional(),
  model: z.string().min(1),
  spaceKey: z.string().optional(),
  parentId: z.string().optional(),
});

export const SummarizeRequestSchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1),
  length: z.enum(['short', 'medium', 'detailed']).default('medium'),
  pageId: z.string().optional(),
});

export const AskRequestSchema = z.object({
  question: z.string().min(1),
  model: z.string().min(1),
  conversationId: z.string().uuid().optional(),
});

export const GenerateDiagramRequestSchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1),
  diagramType: z.enum(['flowchart', 'sequence', 'state', 'mindmap']).default('flowchart'),
  pageId: z.string().optional(),
});

export const AnalyzeQualityRequestSchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1),
  pageId: z.string().optional(),
});

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  model: z.string(),
  title: z.string().nullable(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ImprovementSchema = z.object({
  id: z.string().uuid(),
  confluenceId: z.string(),
  type: z.string(),
  model: z.string(),
  status: z.enum(['draft', 'streaming', 'applied', 'rejected']),
  createdAt: z.string(),
});

export const OllamaModelSchema = z.object({
  name: z.string(),
  size: z.number(),
  modifiedAt: z.coerce.date(),
  digest: z.string(),
});

export const EmbeddingStatusSchema = z.object({
  totalPages: z.number(),
  dirtyPages: z.number(),
  totalEmbeddings: z.number(),
  isProcessing: z.boolean(),
});

export type ImprovementType = z.infer<typeof ImprovementTypeSchema>;
export type ImproveRequest = z.infer<typeof ImproveRequestSchema>;
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type SummarizeRequest = z.infer<typeof SummarizeRequestSchema>;
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type GenerateDiagramRequest = z.infer<typeof GenerateDiagramRequestSchema>;
export type DiagramType = z.infer<typeof GenerateDiagramRequestSchema>['diagramType'];
export type AnalyzeQualityRequest = z.infer<typeof AnalyzeQualityRequestSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Improvement = z.infer<typeof ImprovementSchema>;
export type OllamaModel = z.infer<typeof OllamaModelSchema>;
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;
