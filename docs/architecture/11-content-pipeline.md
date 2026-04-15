# 11. Content Format Pipeline

Confluence Data Center 9.2 exposes its pages in **XHTML Storage Format**
only — no ADF, no REST API v2. Compendiq normalizes this into three
representations that flow through the rest of the system.

## Representations

| Form | Stored in | Consumed by |
|------|-----------|-------------|
| **XHTML Storage** | `pages.body_storage` | Round-trip to Confluence (push-back not yet enabled in CE, but retained for fidelity) |
| **HTML (clean)** | `pages.body_html` | TipTap editor, viewer UI, diff UI |
| **Plain text** | `pages.body_text` | Embedding input, FTS (`tsvector`) |
| **Markdown** | not stored — derived per call | LLM prompts (Ollama / OpenAI) |

## Flow

```mermaid
flowchart LR
    CF[("Confluence<br/>XHTML Storage")]
    DB[("Postgres pages<br/>body_storage · body_html · body_text")]
    LLM[("LLM<br/>Markdown prompts")]
    ED["Editor (TipTap v3)<br/>HTML"]

    CF -- "confluenceToHtml()" --> DB
    DB -- "htmlToConfluence()" --> CF
    DB -- "htmlToMarkdown()" --> LLM
    LLM -- "markdownToHtml()" --> DB
    DB <--> ED

    classDef ext fill:#fff,stroke:#333
    classDef data fill:#eef6ff,stroke:#4a90e2
    classDef ai fill:#fff4e5,stroke:#e5a23c
    classDef ui fill:#eefbe8,stroke:#4caf50
    class CF ext
    class DB data
    class LLM ai
    class ED ui
```

## Conversion rules

Implemented in `backend/src/core/services/content-converter.ts` using
`turndown` + `jsdom` + `turndown-plugin-gfm`.

Custom turndown rules handle Confluence-specific macros:

| Confluence macro            | HTML form                        | Markdown form                 |
|-----------------------------|----------------------------------|-------------------------------|
| `ac:structured-macro[code]` | `<pre><code class="language-x">` | ` ```x … ``` ` fenced block   |
| `ac:task-list`              | `<ul data-task-list>`            | `- [ ]` / `- [x]`             |
| `ac:panel` (info/note/warn) | `<div class="panel panel-…">`    | `> **INFO:** …` block-quote   |
| `ri:user`                   | `<span class="mention">@user</span>` | `@user` (inline)          |
| `ri:page`                   | `<a data-page-link>`             | `[title](compendiq://page/ID)` |
| `ac:structured-macro[drawio]` | `<img data-drawio>`            | `![diagram](attachment-url)`  |

## Why store three forms?

- **`body_storage` (XHTML)** — lossless round-trip with Confluence; any
  future write-back needs the exact original serialisation.
- **`body_html`** — what the viewer and TipTap editor consume; already
  sanitized so we don't run the converter on every render.
- **`body_text`** — stripped of all tags; the input both to the embedding
  pipeline and to the PostgreSQL `tsvector` column for hybrid search.

Markdown is regenerated on demand because (a) LLM prompt sizes vary by
model so partial/windowed serialisation is common, and (b) the conversion
is cheap compared to the LLM call itself.

## Attachments

Images, drawio diagrams, and PDFs are downloaded during sync to
`ATTACHMENTS_DIR` (default `data/attachments`) and rewritten to
Compendiq-local URLs in `body_html`. The original Confluence URLs are
kept in a sidecar table (`image_references`) for reconciliation.

See [`08-flow-sync.md`](./08-flow-sync.md) for where this hooks into the
sync pipeline.
