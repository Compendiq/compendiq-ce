import { z } from 'zod';

export const ImprovementTypeSchema = z.enum([
  'grammar',
  'structure',
  'clarity',
  'technical',
  'completeness',
]);

/**
 * #1154: the image-staging endpoint accepts four raster formats. Like
 * SUPPORTED_DOCUMENT_FORMATS below, this list is the single source of truth —
 * the backend sniffing table and the upload UI's `accept` list both derive
 * from it, so SVG's exclusion cannot drift between them. SVG is out for two
 * independent reasons: vision encoders need raster, and it carries script and
 * external-entity risk.
 */
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'gif'] as const;

export const ImageFormatSchema = z.enum(SUPPORTED_IMAGE_FORMATS);

/**
 * Content-addressed staging id: the sha256 of the validated bytes, lowercase
 * hex. The regex is a security control, not tidiness — the handle is
 * interpolated into the Redis key `llm:img:<userId>:<sha256>`, so a bare
 * z.string() would permit key injection.
 */
export const ImageHandleSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const PrepareImageResponseSchema = z.object({
  /** Format the server *sniffed* from the bytes — never the client's Content-Type. */
  format: ImageFormatSchema,
  handle: ImageHandleSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileSize: z.number().int().nonnegative(),
});

export const ImproveRequestSchema = z.object({
  content: z.string().min(1),
  type: ImprovementTypeSchema,
  model: z.string().min(1).optional(), // #929: optional — resolved server-side per ADR-021, body value ignored
  pageId: z.string().optional(),
  includeSubPages: z.boolean().optional(),
  instruction: z.string().max(10000).optional(),
  /**
   * #1131: text of a document the user attached as background for the rewrite.
   *
   * Deliberately *not* folded into `instruction`. That field is capped at 10K
   * and is appended to the **system prompt**, so a real uploaded document would
   * blow the cap on the first attachment and, worse, arrive with the authority
   * of an instruction. Reference material is user *content*: it takes the same
   * 200K ceiling as `GenerateRequestSchema.documentText` and is merged into the
   * user turn, sanitized separately.
   */
  referenceText: z.string().max(200_000).optional(),
  thinking: z.boolean().optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
  imageHandle: ImageHandleSchema.optional(), // #1154: staged image handle from POST /llm/prepare-image
});

export const GenerateRequestSchema = z.object({
  prompt: z.string().min(1),
  template: z.enum(['runbook', 'howto', 'architecture', 'troubleshooting']).optional(),
  model: z.string().min(1).optional(), // #929: optional — resolved server-side per ADR-021, body value ignored
  spaceKey: z.string().optional(),
  parentId: z.string().optional(),
  /**
   * #1132: text of the document the user attached as source material.
   *
   * Was `pdfText` back when Generate accepted only PDFs. It is format-blind
   * by design — the extractor has already sniffed and decoded the bytes, so
   * what arrives here is a DOCX's or an ODT's prose exactly as much as a PDF's,
   * and a PDF-shaped name would have been a lie for five of the six formats.
   */
  documentText: z.string().max(200_000).optional(),
  thinking: z.boolean().optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
  imageHandle: ImageHandleSchema.optional(), // #1154: staged image handle from POST /llm/prepare-image
});

/**
 * #1131: the document-extraction endpoint accepts six formats. This list is the
 * single source of truth — the backend extractor derives its sniffing table
 * from it and the upload UI derives its `accept` list from it.
 */
export const SUPPORTED_DOCUMENT_FORMATS = ['pdf', 'docx', 'md', 'txt', 'rtf', 'odt'] as const;

export const DocumentFormatSchema = z.enum(SUPPORTED_DOCUMENT_FORMATS);

export const ExtractDocumentResponseSchema = z.object({
  /** Format the server *sniffed* from the bytes — never the client's Content-Type. */
  format: DocumentFormatSchema,
  text: z.string(),
  fileSize: z.number(),
  preview: z.string(),
  /**
   * PDF-only. Absent for every other format rather than faked as `0`, so a
   * consumer can tell "not a paged format" from "a zero-page PDF".
   */
  totalPages: z.number().optional(),
});

export const SummarizeRequestSchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1).optional(), // #929: optional — resolved server-side per ADR-021, body value ignored
  length: z.enum(['short', 'medium', 'detailed']).default('medium'),
  pageId: z.string().optional(),
  includeSubPages: z.boolean().optional(),
  thinking: z.boolean().optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
});

export const AskRequestSchema = z.object({
  question: z.string().min(1),
  model: z.string().min(1).optional(), // #929: optional — resolved server-side per ADR-021, body value ignored
  conversationId: z.string().uuid().optional(),
  pageId: z.string().optional(),
  includeSubPages: z.boolean().optional(),
  thinking: z.boolean().optional(),
  externalUrls: z.array(z.string().url()).max(5).optional(),
  searchWeb: z.boolean().optional(),
  searchQuery: z.string().max(500).optional(),
  /**
   * #1112 — multi-query expansion ("deep search"). Per-request and DEFAULT
   * OFF, exactly like `searchWeb` and `thinking` above: it costs one extra
   * chat call and two extra retrievals, so it stays the caller's decision per
   * ask rather than a mode the server infers. Absent and `false` are the same
   * thing, and `false` must reach retrieval as today's single-query path.
   */
  deepSearch: z.boolean().optional(),
});

export const GenerateDiagramRequestSchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1).optional(), // #929: optional — resolved server-side per ADR-021, body value ignored
  diagramType: z.enum(['flowchart', 'sequence', 'state', 'mindmap']).default('flowchart'),
  pageId: z.string().optional(),
  thinking: z.boolean().optional(),
});

export const AnalyzeQualityRequestSchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1).optional(), // #929: optional — resolved server-side per ADR-021, body value ignored
  pageId: z.string().optional(),
  includeSubPages: z.boolean().optional(),
  thinking: z.boolean().optional(),
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
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;
export type ExtractDocumentResponse = z.infer<typeof ExtractDocumentResponseSchema>;
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;
export type ImageFormat = z.infer<typeof ImageFormatSchema>;
export type PrepareImageResponse = z.infer<typeof PrepareImageResponseSchema>;
