# RAG & Search — Gap Analysis vs. the Hybrid‑Rerank Reference Guide

**Purpose.** Compare Compendiq's current RAG/search pipeline against the
external *"Hybrid RAG Search with Reranking — Portable Implementation Guide"*
(a production ITSM knowledge assistant: Qdrant + vLLM gateway, hybrid
dense+sparse+title+body retrieval, cross‑encoder rerank, MMR, structure‑aware
chunking with page‑merge, 6‑signal confidence gate). Goal: identify what the
guide does that Compendiq does not, and where adopting it would help.

**How to read the tables:** ✅ already have it · 🟡 partial / different ·
❌ missing.

---

## 0. The pipeline, side by side

| Stage | Reference guide | Compendiq today |
|---|---|---|
| Query embed | dense + sparse | dense only (query embedded once; lexical leg is Postgres FTS, not a query sparse vector) |
| Retrieval legs | 4 legs (dense, sparse/BM25, title‑match, body‑match) fused by RRF | 2 legs (pgvector cosine + Postgres FTS `ts_rank`) fused by RRF |
| Over‑fetch | ~20 candidates, then rerank | ~10 per leg → return top‑K (K=5 for chat); no rerank to justify over‑fetch |
| Rerank | **cross‑encoder** (hosted `/v1/rerank` or local) — the precision stage | **none** |
| Reshape | dedup‑by‑parent, page‑merge, tier/recency, exact‑ID short‑circuit | dedup‑by‑parent ✅; the rest ❌ |
| Diversity | MMR (λ=0.7) after rerank | none |
| Trust gate | 6‑signal retrieval‑confidence score → answer vs. refuse | none (always answers) |
| Chunking | structure‑aware, ~2000 chars / ~200 overlap, **title prefixed into chunk text** | structure‑aware (heading→paragraph→word), ~1500 chars / ~150 overlap, title stored only in metadata |
| Multi‑query | optional 2–3 paraphrases merged | none |
| Eval | Recall@K + MRR on a fixed labelled fixture | none |

**Core file map (Compendiq):**
- `backend/src/domains/llm/services/rag-service.ts` — `vectorSearch`, `keywordSearch`, `reciprocalRankFusion`, `hybridSearch`, `buildRagContext`.
- `backend/src/domains/llm/services/embedding-service.ts` — `chunkText`, `embedPage`, `processDirtyPages`.
- `backend/src/routes/knowledge/search.ts` — `/api/search` (keyword/semantic/hybrid modes + pg_trgm fuzzy‑title path + facets).
- `backend/src/routes/llm/llm-ask.ts` — RAG chat: `hybridSearch(userId, question)` → `buildRagContext` → stream.

---

## 1. What Compendiq already does well (parity with the guide)

- **Hybrid retrieval + RRF.** `reciprocalRankFusion` (k=60) already fuses vector
  and keyword results by rank — the guide's central idea is present.
  (`rag-service.ts:137`)
- **Dense vector search done right.** pgvector cosine (`<=>`), HNSW
  (`m=16, ef_construction=200`), tunable `hnsw.ef_search` (`RAG_EF_SEARCH=100`).
  Distance→similarity conversion is correct. (`rag-service.ts:42`)
- **A lexical/keyword leg exists.** Postgres FTS over a GIN‑indexed `tsvector`
  (title + body_text), trigger‑maintained with a runtime‑configurable language
  (`FTS_LANGUAGE`, migration `049` supersedes the earlier hardcoded‑`english`
  `047`), queried with `plainto_tsquery` (injection‑safe) + `ts_rank`. This
  covers most of the guide's "sparse leg" motivation. (`rag-service.ts:93`)
- **Dedup by parent document.** RRF keys on `pageId`, so the merged output is
  already one entry per page (best chunk wins). Semantic route dedups too.
  (`rag-service.ts:145`, `search.ts:120`)
- **Structure‑aware chunking.** Splits on Markdown headings first, then
  paragraphs, then a word‑level fallback, with overlap and a hard char ceiling.
  (`embedding-service.ts:208`)
- **Graceful degradation on the retrieval path.** If embedding fails, hybrid
  search falls back to keyword‑only and labels the analytics event
  `keyword_fallback`; circuit‑breaker errors propagate as 503.
  (`rag-service.ts:280`)
- **Things the guide never mentions but Compendiq has:** RBAC space‑scoping on
  every retrieval query, an EE per‑page ACL post‑filter with over‑fetch
  compensation, per‑provider circuit breakers + queue, search analytics,
  pg_trgm fuzzy‑title matching in the search route, multilingual FTS.

---

## 2. The differences — ranked by leverage

### 2.1 ❌ No cross‑encoder reranker (the biggest gap)

- **Guide:** retrieval and ranking are two jobs. Over‑fetch ~20 with cheap
  hybrid recall, then a cross‑encoder re‑scores each `(query, doc)` pair and
  keeps ~5. Described as "the highest‑leverage addition to a naive RAG search."
- **Compendiq:** the RRF‑fused order *is* the final order. `hybridSearch` returns
  `merged.slice(0, topK)` with no re‑scoring. A genuinely relevant chunk that
  lands at RRF rank 8–12 is never rescued.
- **Integration:** add a `rerank(query, candidates, topK)` step in `hybridSearch`
  between RRF and the final slice. Over‑fetch to ~20 first (see 2.2). Options,
  in order of fit for this repo:
  1. **Reuse the existing provider abstraction.** ADR‑021 already models N
     `openai-compatible` providers with per‑use‑case assignments. Add a
     `rerank` use case and call a Cohere‑style `/v1/rerank` (or an Ollama/
     TEI reranker) through `openai-compatible-client.ts`, inheriting the queue
     + circuit breaker for free. This matches how `embedding`/`chat`/`summary`
     are wired.
  2. Local cross‑encoder (BGE‑reranker) as an alternative provider.
- **Must‑haves from the guide:** truncate docs to ~2000 chars before scoring;
  normalise local‑model logits to `[0,1]`; **on rerank failure, mark
  `rerank_bypassed` and do NOT fake a 0/1 score** (renormalise downstream).
- **Effort:** medium. **Impact:** high. This is the single change most likely
  to improve answer quality.

### 2.2 ❌ No over‑fetch before ranking

- **Guide:** fetch `rerank_top_k ≈ 20`, keep `final_k ≈ 5`. Under‑fetching
  "defeats the reranker — it can only reorder what you gave it."
- **Compendiq:** per‑leg default limit is 10; chat asks for `topK=5`. The only
  over‑fetch today is EE ACL compensation (`ceil(topK*1.5)`), and it's about
  ACL headroom, not ranking. (`rag-service.ts:239`)
- **Integration:** decouple *fetch width* from *return width*. Add a
  `RAG_RERANK_CANDIDATES` (~20) fetch budget for both legs, rerank, then slice
  to `topK`. Cheap on its own; it's the prerequisite that makes 2.1 pay off.
- **Effort:** low. **Impact:** high (as an enabler).

### 2.3 ❌ No retrieval‑confidence score / refuse gate

- **Guide:** a fixed, auditable 6‑signal formula (best similarity, match count,
  source‑type diversity, solution ratio, max rerank score, source quality, minus
  a weak‑source penalty) → below a threshold, **refuse / ask for info instead of
  guessing**. "The difference between a helpful assistant and a confident liar."
  Never gate on the LLM's self‑reported confidence.
- **Compendiq:** `llm-ask.ts` always answers. `buildRagContext` even returns
  `"No relevant context found in the knowledge base."` and still streams an LLM
  answer over it. No distance floor, no `match_count` gate. (`rag-service.ts:342`)
- **Integration:** compute a confidence score from the signals Compendiq already
  has (top cosine similarity, number of results, and—once 2.1 lands—max rerank
  score). Below a configurable threshold, short‑circuit the stream with an
  honest "not enough grounded context" message + the weak sources, rather than a
  low‑grounded answer. Start diagnostic‑only (log it, show it), then gate.
  **Reuse what exists:** the graph route already has a corpus‑size‑aware
  similarity floor — `tieredMinScoreForCorpus` → 0.4 / 0.6 / 0.7 by corpus size
  (`pages-embeddings.ts`). The RAG path has *no* score floor at all; lifting
  that same tiered floor into `hybridSearch`/`vectorSearch` is a cheap first
  step toward a real gate.
- **Effort:** medium. **Impact:** high for trust, especially since Compendiq can
  write LLM output back into pages (improve/generate flows).

### 2.4 🟡 Chunking: title not prefixed, smaller sizes

- **Guide:** ~2000 chars / ~200 overlap and **prefix every chunk with the
  document title** so each chunk is standalone and feeds a title‑match leg.
- **Compendiq:** ~1500 chars (500 tok × 3) / ~150 overlap; title lives in
  `metadata.page_title` but is **not** part of the embedded/searched chunk text.
  (`embedding-service.ts:18`, `chunkText` at `:208`)
- **Integration:** (a) prepend `"{title} — {section}\n\n"` to each chunk's text
  before embedding so the title's terms are in‑vector and in‑FTS; (b) consider
  raising the target chunk size toward ~2000 chars. **Caveat:** both change what's
  stored → require a full re‑embed (`enqueueReembedAll`) to take effect; ship as
  an opt‑in setting and re‑index deliberately.
- **Effort:** low‑medium (+ re‑embed). **Impact:** medium.

### 2.5 ❌ No page‑merge (fragmented pages reach the LLM as truncated middles)

- **Guide:** when one chunk of a page ranks in, fetch its sibling chunks by
  `page_id`, concatenate in `chunk_index` order within a char budget, and hand
  the reranker/LLM **one full‑page record** (distance=min, rerank=max).
- **Compendiq:** only the single best chunk per page is returned. A page split
  into 6 chunks where only chunk #4 ranks gives the LLM an arbitrary middle
  section. `page_embeddings` already stores `page_id` + `chunk_index`, so the
  data is there. (`embedding-service.ts:412`)
- **Integration:** after dedup, for each surviving page fetch sibling chunks
  (`SELECT ... WHERE page_id = $1 ORDER BY chunk_index`) and rebuild the section
  under a budget; feed that to rerank/context. Soft‑fail to chunk‑level on error.
- **Effort:** medium. **Impact:** medium‑high for multi‑chunk pages.

### 2.6 ❌ No exact‑identifier short‑circuit

- **Guide:** semantic + title match never reliably hit a literal ID
  (ticket/doc/host/error codes). If the query names one, do a direct exact‑match
  lookup and **pin** those records at the top.
- **Compendiq:** relies on FTS + pg_trgm fuzzy title (route only, not in RAG
  `hybridSearch`). Numeric/code identifiers get "averaged away" in the vector
  and diluted in FTS. Confluence page keys, space keys, and labels are exactly
  this kind of identifier.
- **Integration:** regex the query for Compendiq's ID shapes (Confluence page
  id / key, space key, label) and, on a hit, pin exact matches ahead of RRF
  output. Low‑risk, high‑precision for "find the page called X" queries.
- **Effort:** low. **Impact:** medium (query‑dependent).

### 2.7 ❌ No MMR / diversity pass

- **Guide:** rerankers optimise pure relevance and can return near‑duplicates.
  Run MMR (λ=0.7, cheap trigram‑Jaccard similarity) **after** rerank to trade a
  little relevance for coverage.
- **Compendiq:** none. Partly masked today because dedup‑by‑page already removes
  the worst near‑duplicates, but two very similar *pages* can still both rank.
- **Integration:** add an optional MMR narrow (oversample rerank to 2×K → K).
  Lower priority — do it after 2.1 exists (MMR belongs *after* rerank).
- **Effort:** low‑medium. **Impact:** low‑medium.

### 2.8 🟡 Dedicated title / identifier retrieval leg

- **Guide:** separate title‑match and (optional) body‑match legs so identifiers
  in titles aren't diluted by body text.
- **Compendiq:** `tsv` concatenates title + body into one FTS field, so title
  terms are present but not weighted as their own leg. The route has pg_trgm
  title similarity, but `hybridSearch` (used by chat) does not.
- **Integration:** either add a third RRF leg that runs `plainto_tsquery` against
  a title‑only tsvector, or weight the title portion of `tsv` (setweight A/B).
  Overlaps with 2.6; do the exact‑ID short‑circuit first (cheaper, sharper).
- **Cheap adjacent win:** the lexical leg uses `plainto_tsquery`, which drops
  quotes/operators. Switching to `websearch_to_tsquery` gives users quoted
  phrases and `-exclude` for free — a small, isolated FTS‑quality bump.
- **Effort:** medium. **Impact:** low‑medium.

### 2.9 ❌ No multi‑query expansion

- **Guide:** optional — reformulate into 2–3 paraphrases, retrieve each, merge
  by ID before rerank. Lifts recall on terse/jargon queries.
- **Compendiq:** single query only.
- **Integration:** optional "deep search" toggle; costs extra vector searches +
  one LLM reformulation. Do last.
- **Effort:** medium. **Impact:** low‑medium (situational).

### 2.10 ❌ No quality/tier/recency ranking signal

- **Guide:** fold a per‑source `golden/standard/archived` tier + freshness decay
  into ranking as a distance multiplier; hard‑exclude archived from context.
- **Compendiq:** a quality worker computes page quality scores, but they are
  **not** consumed by retrieval ranking; there's no recency decay in RAG. Only
  `last_modified_at DESC` ordering exists — and that's for the embedding *batch
  fetch order*, not search ranking. (`embedding-service.ts:639`)
- **Integration:** optionally blend existing quality score / recency into the
  final ordering (or the confidence formula's `source_quality` term). Keep the
  tier source‑of‑truth in Postgres, not the vector payload (payload goes stale).
- **Effort:** medium. **Impact:** medium (leverages data Compendiq already has).

### 2.11 ❌ No retrieval eval harness (Recall@K / MRR)

- **Guide:** build a small labelled fixture, track Recall@K + MRR, gate changes
  on it (regressions >0.01 fail), always measure on a fully‑embedded corpus.
- **Compendiq:** rich unit/integration tests for the *plumbing* (RRF math, ACL,
  fallback) but no *quality* metric. Every change above should be measured, not
  eyeballed.
- **Integration:** add a labelled query→expected‑page fixture and a Vitest that
  computes Recall@K/MRR against a seeded, fully‑embedded test DB. Build this
  **before** 2.1 so the reranker's win is provable.
- **Effort:** medium. **Impact:** high (de‑risks everything else).

---

## 3. Where Compendiq is intentionally different (not gaps)

- **Query/passage prefixes (E5/GTE/BGE‑family).** The guide warns about
  asymmetric prefixes. Compendiq's default `bge-m3` is **not** an asymmetric
  prefix model — it does not use `query:` / `passage:`. Adding prefixes would
  *hurt*. Only revisit if an admin switches to an E5/GTE model. (No action.)
- **RRF‑score‑as‑distance foot‑gun (guide §1).** Compendiq does not feed
  `1 − rrf_score` into a cosine gate, so the specific foot‑gun isn't triggered.
  Minor note: RRF scores (~0.03) surface to the UI as `score`/`rank`; if a
  distance/quality gate is ever added, normalise per result set or gate on
  rerank score (which is exactly what 2.1 + 2.3 set up).
- **Vector DB.** Guide is Qdrant; Compendiq is pgvector. Everything above ports
  cleanly — RRF, over‑fetch, rerank, page‑merge, MMR, confidence are all
  DB‑agnostic and mostly application‑layer.

---

## 4. Suggested integration order (highest leverage first)

1. **Eval harness** (2.11) — Recall@K/MRR fixture. Prove the wins.
2. **Over‑fetch** (2.2) — decouple fetch width from return width.
3. **Cross‑encoder reranker** (2.1) — new `rerank` use case via the existing
   provider abstraction; honest bypass on failure.
4. **Confidence score + refuse gate** (2.3) — diagnostic‑only first, then gate.
5. **Page‑merge** (2.5) and **exact‑ID short‑circuit** (2.6).
6. **Chunk title‑prefix + size** (2.4) — bundle with a deliberate re‑embed.
7. **MMR** (2.7), **title leg** (2.8), **quality/recency** (2.10),
   **multi‑query** (2.9) — polish, situational.

Each step is independently shippable and testable. Steps 3, 4, 6 touch the
RAG/LLM flow, so per `CLAUDE.md` rule 6 update the matching
`docs/architecture/*.md` (RAG flow) in the same PR, and note new tuning knobs in
`.env.example` (e.g. `RAG_RERANK_CANDIDATES`, `RAG_RERANK_ENABLED`,
`RAG_CONFIDENCE_THRESHOLD`).
