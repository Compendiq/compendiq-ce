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
  includeSubPages: z.boolean().optional(),
  instruction: z.string().max(10000).optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
});

export const GenerateRequestSchema = z.object({
  prompt: z.string().min(1),
  template: z.enum(['runbook', 'howto', 'architecture', 'troubleshooting']).optional(),
  model: z.string().min(1),
  spaceKey: z.string().optional(),
  parentId: z.string().optional(),
  pdfText: z.string().max(200_000).optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
});

export const ExtractPdfResponseSchema = z.object({
  text: z.string(),
  totalPages: z.number(),
  fileSize: z.number(),
  preview: z.string(),
});

export const SummarizeRequestSchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1),
  length: z.enum(['short', 'medium', 'detailed']).default('medium'),
  pageId: z.string().optional(),
  includeSubPages: z.boolean().optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
});

export const AskRequestSchema = z.object({
  question: z.string().min(1),
  model: z.string().min(1),
  conversationId: z.string().uuid().optional(),
  pageId: z.string().optional(),
  includeSubPages: z.boolean().optional(),
  externalUrls: z.array(z.string().url()).max(5).optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
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
  includeSubPages: z.boolean().optional(),
});

export const ForceEmbedTreeRequestSchema = z.object({
  pageId: z.string().min(1),
});

export const ApplyImprovementRequestSchema = z.object({
  pageId: z.string().min(1),
  improvedMarkdown: z.string().min(1),
  version: z.number().int().positive().optional(),
  title: z.string().optional(),
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
export type ForceEmbedTreeRequest = z.infer<typeof ForceEmbedTreeRequestSchema>;
export type ApplyImprovementRequest = z.infer<typeof ApplyImprovementRequestSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Improvement = z.infer<typeof ImprovementSchema>;
export type OllamaModel = z.infer<typeof OllamaModelSchema>;
export type ExtractPdfResponse = z.infer<typeof ExtractPdfResponseSchema>;
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;
