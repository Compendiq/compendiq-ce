# Knowledge Core - Compendiq

This file contains detailed technical implementation notes, historical design decisions, and low-level implementation details extracted from `CLAUDE.md` to optimize active context.

## LLM Provider Model (ADR-021)

### Rerank & Image Embedding
- `rerank` (#1104) and `image_embedding` (#1115) never inherit from the default provider. Unassigned means the stage is disabled.
- `image_embedding` targets a `/v1/rerank` endpoint.
- `image_embedding` is a text embedder answers the plain shape with a plausible but wrong vector; unassigned means the image leg is off.

### Deep Search (#1112)
- Multi-query expansion asks `chat` for two paraphrases.
- It is one extra completion for a one-sentence rewrite.
- It is per-request and default off (`deepSearch`, `searchWeb` precedent).
- It never expands an exact-identifier or pasted-error query.

### Multimodal Image Retrieval (#1115, ADR-025)
- Text uses Phase-1 text embedder; vision-language model embeds images into a separate `page_image_embeddings` index.
- Uses `vl-embedding-client.ts` with a specific message array (trailing empty `assistant` turn + `continue_final_message: true`).
- Image corpus is a third corpus (`eval/corpus-de-images/`).

### Confidence Threshold & Calibration
- A swap must never rewrite refusal policy.
- `rag_confidence_threshold_calibration` / `..._rerank_calibration` are recorded when a threshold is PUT.
- A basis with no assigned model is a `null pair` inside a present record.

## UI/UX Implementation (ADR-010)

### Themes (Graphite & Paper)
- **Graphite**: Dark (`#0F0F10` workspace, `#161617` pane, `#09090A` canvas).
- **Paper**: Light (`#F7F7F8` workspace, `#FAFAFB` pane, `#EEEFF0` canvas).
- **Steel** accent: `#86AEC8` (dark) / `#3F627C` (light).
- Surfaces use FLAT COLOURS (`--surface-backdrop`, `--surface-card`).
- Depth is a 1px hairline, not extrusion.

### Component Specifics
- **Assistant**: A tab in the inspector (`Assistant`, `Outline`, `Details`). Not a separate column.
- **Editor Toolbar**: `EditorToolbar` lives in the article column.
- **Status Colors**: `success` (green), `warning` (amber), `destructive` (red), `embedding` (Steel), `AI` (violet), `inactive` (slate), `info` (indigo).
- **Navigation**: `SidebarTreeView` and `DndLocalSpaceTree` must move together.

## Content Pipeline (ADR-003)

### Data Flow
`Confluence (XHTML) ⇄ confluenceToHtml/htmlToConfluence ⇄ DB (body_storage XHTML, body_html clean, body_text plain) ⇄ htmlToMarkdown/markdownToHtml ⇄ {LLM: Markdown, Editor/TipTap: HTML}`

### Extraction & Processing
- **Document Extraction**: `core/services/document-extractor.ts`.
- **Formats**: `pdf` (`unpdf`), `docx` (`mammoth`), `odt` (`content.xml`), `rtf`, `md/txt`.
- **Images**: Sniffed via magic-byte (png/jpeg/webp/gif). SVG is refused.
- **Redis Staging**: Capacity-gated via `IMAGE_STAGING_MAX_REDIS_PERCENT` (default 80%).

### Size Limits
- Nginx: `44m`
- Route `bodyLimit`: `8 MiB`
- `ImportMarkdownSchema`: `1,000,000` characters
- `MAX_IMAGE_BYTES`: `5 MB`
- `MAX_IMAGE_DIMENSION`: `4096`
