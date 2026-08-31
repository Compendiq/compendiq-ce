# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences of roughly equal weight, often the same person in one session:

- **Readers/searchers** — knowledge workers inside an organisation that runs Confluence
  Data Center. They arrive with a question, need the answer out of a large corpus, and
  leave. Search, page reading, and asking the AI are their whole surface.
- **Authors/editors** — the people who write and maintain those pages. They work in the
  editor, use AI to improve/summarise/diagram, watch quality scores, and publish back to
  Confluence.

A third, much smaller audience operates the system: admins configuring Confluence sync,
LLM providers and per-use-case model assignments, users/RBAC, licensing and SMTP. They
visit rarely but their surfaces are numerous.

## Product Purpose

Compendiq is an AI knowledge-base application layered over an existing Confluence Data
Center instance. It syncs Confluence spaces and pages into its own store, embeds them for
semantic retrieval, and puts an LLM over that corpus so people can ask questions, get cited
answers, and improve the source pages in place. Success is a person getting a trustworthy,
sourced answer out of their own organisation's documentation faster than reading it — and
the page they came from being measurably better afterwards.

## Positioning

It works against **Confluence Data Center**, self-hosted, with the customer's own LLM
endpoints (Ollama or any OpenAI-compatible provider) — nothing leaves their network. The
mechanism a neighbouring product cannot truthfully copy: it round-trips Confluence XHTML
Storage Format losslessly, so AI-authored improvements are written *back* to Confluence with
macros, media, mentions and layouts intact. It is a two-way editor over someone else's
system of record, not a read-only chat wrapper.

## Operating Context

- **The corpus is not ours.** Confluence is the system of record; Compendiq syncs from it
  on an interval and writes back. Pages carry spaces, parents, labels, versions, macros.
- **Everything runs on the customer's infrastructure.** Postgres + pgvector, Redis, and
  LLM endpoints the customer operates. Air-gapped and self-hosted deployments are normal.
- **Retrieval is hybrid** — vector similarity over `bge-m3` embeddings plus full-text —
  and answers cite the pages they came from.
- **Long-running background work is constant**: sync, embedding, summarisation, quality
  scoring, auto-tagging. Users see these as states, not as tasks they started.
- **The AI is docked beside the work, not a destination.** On a page, the assistant is a
  third column next to the article inspector; every request starts from a chip or the
  composer, never from opening the panel.
- **Keyboard-first usage is expected**: a command palette, single-key shortcuts, and a
  shortcuts modal already exist and are load-bearing.

## Capabilities and Constraints

Confirmed capabilities: Confluence space/page sync; hybrid semantic + full-text search;
cited RAG chat; page creation and editing in a TipTap editor with Confluence macro support;
AI improve / summarise / diagram / quality-score / auto-tag; Markdown import; document and
image upload as AI source material (vision-gated); page graph; version history; trash;
spaces and permissions; analytics; notifications; light/dark themes.

Constraints that outlive any redesign:

- Confluence DC 9.2 speaks **XHTML Storage Format only** — no ADF. The content pipeline
  (`confluenceToHtml` / `htmlToConfluence` / `htmlToMarkdown` / `markdownToHtml`) is
  backend-only; there is no frontend Markdown→HTML path and applying AI output must go
  through `POST /llm/improvements/apply`.
- **Open-core.** This repo is Community Edition; Enterprise ships the *same unmodified CE
  frontend image* and gates its UI at runtime via `useEnterprise().isEnterprise`. Enterprise
  surfaces must render as inert state in CE, never be conditionally compiled out.
- Zod contracts from `@compendiq/contracts` bind every API boundary.
- Backend domain import boundaries are ESLint-enforced; the frontend is
  `features/` + `shared/` + `stores/` + `providers/`.
- Roughly 20 routes across pages, AI, graph, spaces, settings, admin, setup and auth.
- Version 0.7.2, pre-1.0, SemVer.

Undecided / not established: no confirmed customer count, no published pricing, no
benchmark numbers, no named reference customers. Future work must not invent them.

## Brand Commitments

- Product name **Compendiq**. An existing logo/mark component ships in
  `frontend/src/shared/components/{Logo,CompendiqLogo}.tsx`.
- Two themes are a product requirement, not a preference: a dark and a light workspace,
  user-switchable, both fully designed.
- **User-pinned reference (2026-08-06): [app.plane.so](https://app.plane.so)** — specifically
  its *calm, dense, flat surfaces* and its *speed and keyboard-first feel*. Explicitly **not**
  its navigation/workspace model and **not** its views/filters system; Compendiq keeps its
  own topology (spaces tree, article inspector, docked AI).
- **Standing visual preference (2026-08-06): the category convention, executed at full
  fidelity.** Offered four distinct visual worlds (Apparatus / Concourse / Datamatics /
  Billing) against the category standard, the user chose the standard. This is a durable
  brand commitment, not a one-off: Compendiq is to look and behave like a first-rate modern
  workspace application, without irony, pastiche or smuggled quirk. Future work does not
  re-open this with a concept round.
- **Craft bar: Linear, Plane, and Notion.** Compendiq must hold up beside all three. Linear
  sets the bar for motion timing, keyboard coverage and type scale; Plane for calm neutral
  surfaces and row density; Notion for the document/editor surface, block handling and
  reading typography.
- **Default theme follows the OS**, with a manual override persisted per user. Neither light
  nor dark is a fallback; both are designed and tuned.
- **Palette commitment (2026-08-20, amended 2026-08-30):** Graphite and Paper use the
  eight-role ladder recorded in ADR-010 — v0.7 for the roles and Graphite, v0.8 for
  Paper — with the desaturated Steel pair (`#86AEC8` dark / `#3F627C` light) as the
  single brand and interaction accent. Violet remains AI, amber warning, green success,
  and red failure; these semantic colors are not alternate accents. Graphite's document
  pane stays off near-black to reduce long-session glare. **Paper is a quietly warm neutral with white
  panes and a near-white frame** (owner decision, 2026-08-30): document, left navigation
  and context rail are `#FFFFFF`; the frame — gutter, left destination rail, top app
  header — is `#FAFAF9`, with the hover/selected fill a measured step below white, and the remaining warmth lives in Chrome, Workspace, the fills,
  the borders and the ink at chroma 0.002–0.007, where the hue is felt and not seen. The
  earlier "avoid pure white" rule no longer applies to light mode, and Canvas is no longer
  light mode's darkest step.
- A separate marketing site (`compendiq-landing`) exists and is currently on a retired
  palette; cross-surface parity is a known open item, not a constraint on this work.

## Evidence on Hand

- A running Community Edition at `localhost:8081` (published image, may lag `dev`) and a
  local Confluence Data Center container with no marketplace apps.
- The full incumbent interface in `frontend/src/` — treated here as evidence of what the
  product is, and as anti-reference for what it becomes.
- Architecture decisions in `docs/ARCHITECTURE-DECISIONS.md`, diagrams in
  `docs/architecture/`, enterprise design in `docs/ENTERPRISE-ARCHITECTURE.md`.
- No customer logos, testimonials, case studies, press, or usage statistics exist.

## Product Principles

1. **The source of record wins.** Nothing the interface does may risk silent loss of
   Confluence content — macros, media, mentions, layout. Where a lossy path exists, the UI
   hides or warns rather than proceeding quietly.
2. **Cited or it didn't happen.** AI output is only useful here if the user can get to the
   page it came from; provenance is a first-class part of every answer.
3. **Reading and writing are one session.** A person who found an answer should be able to
   fix the page that gave it to them without changing context.
4. **State is ambient, not modal.** Sync, embedding, quality and summarisation run
   continuously; the interface reports them without interrupting the task.
5. **The keyboard is the primary input for power users**, and every capability reachable by
   pointer must also be reachable without one.

## Accessibility & Inclusion

WCAG 2.1 AA is the working floor and is already enforced by tests: contrast ratios are
computed from the token file rather than pinned, non-text contrast (1.4.11, 3:1) is met by a
real border on every interactive surface rather than by shadow, `forced-colors: active` must
survive, `prefers-reduced-motion: reduce` strips transforms, and focus order must follow DOM
order (no `order-*` reordering in composers). Any replacement system inherits these floors.
