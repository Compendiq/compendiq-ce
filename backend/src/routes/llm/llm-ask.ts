import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat, type ChatMessage, type ChatContentPart } from '../../domains/llm/services/openai-compatible-client.js';

/**
 * A persisted conversation turn. `refused` marks a #1105 confidence refusal:
 * it is persistence/UI metadata, STRIPPED before messages are sent to the
 * model (a refusal is not model context — replaying "I am not answering"
 * invites imitation) and excluded from the gate's history exemption (a
 * refusal turn grounds nothing).
 */
type StoredChatMessage = ChatMessage & { refused?: boolean };

import { contentToText } from '../../domains/llm/services/prompts.js';
import { hybridSearch, buildRagContext, type RetrievalMeta } from '../../domains/llm/services/rag-service.js';
// #1112: deep search's wrapper around hybridSearch. Its own module, not a
// rag-service export, because expansion is a REQUEST-level stage: /api/search
// paginates and must never reach it.
import { multiQuerySearch } from '../../domains/llm/services/multi-query-search.js';
// From the leaf module, NOT via rag-service: the route suite stubs
// rag-service with a closed export list, and the formula must stay REAL
// there (stubbing it would let route and formula drift — #1268 review).
import { computeRetrievalConfidence } from '../../domains/llm/services/retrieval-confidence.js';
import { getRagConfidenceThreshold, getRagConfidenceThresholdRerank, getRagContextCharsPerPage } from '../../core/services/admin-settings-service.js';
import { LlmCache, buildRagCacheKey } from '../../domains/llm/services/llm-cache.js';
import { CircuitBreakerOpenError } from '../../core/services/circuit-breaker.js';
import { isEnabled as isMcpDocsEnabled, fetchDocumentation } from '../../core/services/mcp-docs-client.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { AskRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { emitLlmAudit, estimateTokens } from '../../domains/llm/services/llm-audit-hook.js';
import { assembleSubPageContext, getMultiPagePromptSuffix } from '../../domains/confluence/services/subpage-context.js';
import {
  resolveSystemPrompt,
  checkCacheWithLock,
  sendCachedSSE,
  sanitizeLlmInput,
  resolvePageRef,
  resolveImagePart,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import { userCanAccessPage } from '../../core/services/rbac-service.js';
import { acquireStreamSlot } from '../../core/services/sse-stream-limiter.js';

/**
 * Why the ask path declined to answer. Emitted as `refusalReason` on the
 * refusal's final SSE frame beside `refused: true` — the route's verdict is
 * strictly more informative to a client than the raw retrieval health it was
 * derived from, since it says what the route DID. The health facts
 * (`degradedReason`, `healthCaveat`, coverage) stay in the info log and the
 * trace, where the operator reads them.
 */
type RefusalReason = 'semantic_index_unavailable' | 'no_context' | 'weak_match';

/**
 * The refusal sentence per reason. `semantic_index_unavailable` must NOT read
 * like `no_context`: one says the knowledge base has nothing on the question,
 * the other says we could not look properly. Telling a user the first when
 * the second is true is the failure this gate exists to prevent — and it is
 * most likely during the #1116 re-embed window, when a corpus-is-empty claim
 * is both false and self-confirming.
 */
const REFUSAL_TEXT: Record<RefusalReason, string> = {
  semantic_index_unavailable:
    'I could not search the knowledge base properly: the semantic index is unavailable right now, so only a plain keyword match ran. That is not enough to ground an answer, so I am not answering rather than guessing. This is a service problem, not a gap in the knowledge base — try again shortly, or check with an administrator if it persists.',
  no_context:
    'I could not find any knowledge-base content related to this question, so I am not answering rather than guessing. Try rephrasing, or ask about something the knowledge base covers.',
  weak_match:
    'The knowledge-base passages I found are not a strong enough match to this question to ground an answer, so I am not answering rather than guessing.',
};

/**
 * Live-only sentence naming the attached sources (see the persisted/live
 * divergence below). The outage wording must not claim the sources were
 * measured and found wanting — nothing ranked them against the question.
 *
 * The `no_context` entry is unreachable in practice and present for total
 * typing: that reason requires zero retrieved rows AND no other grounding,
 * which is exactly the state in which `sources` is empty and this sentence
 * is never appended.
 */
const REFUSAL_SOURCES_NOTE: Record<RefusalReason, string> = {
  semantic_index_unavailable:
    ' The keyword-only matches are attached as sources for reference — they were never ranked against your question.',
  no_context:
    ' The closest partial matches are attached as sources for reference — none matched well enough to use.',
  weak_match:
    ' The closest partial matches are attached as sources for reference — none matched well enough to use.',
};

export async function llmAskRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // GET /api/mcp-docs/status - public (authenticated) check for MCP docs availability
  // Non-admin users need this to show/hide the external URL attachment button in AskMode.
  fastify.get('/mcp-docs/status', async () => {
    const enabled = await isMcpDocsEnabled();
    return { enabled };
  });

  // POST /api/llm/ask - RAG-powered Q&A with streaming
  fastify.post('/llm/ask', { ...LLM_STREAM_RATE_LIMIT, preHandler: requireGlobalPermission('llm:query') }, async (request, reply) => {
    // Per-user concurrent SSE-stream cap (#268). MUST run before reply.hijack()
    // so rejections can be returned as a normal JSON 429.
    const slot = await acquireStreamSlot(request.userId);
    if (!slot.acquired) {
      return reply.code(429).send({
        error: 'too_many_concurrent_streams',
        message: 'You have reached the per-user concurrent AI-stream limit. Close an existing stream and try again.',
      });
    }

    try {
    const auditStart = Date.now();
    const body = AskRequestSchema.parse(request.body);
    const { question, model, conversationId, includeSubPages, externalUrls, imageHandle } = body;
    const userId = request.userId;

    if (question.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Question too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    // Sanitize question before sending to LLM. The two flags below are
    // mutated by the MCP-fetched-docs sanitize loop further down so the
    // Report 5 attestation captures injection signals from EITHER input
    // source, not just the question. (Mirrors `llm-generate.ts`'s
    // accumulator pattern for `documentText`.)
    const { sanitized: sanitizedQuestion, warnings } = sanitizeLlmInput(question);
    let promptInjectionDetected = warnings.length > 0;
    let wasSanitized = sanitizedQuestion !== question;
    if (promptInjectionDetected) {
      await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/ask' }, request);
    }

    // Load conversation history if continuing
    let conversationHistory: StoredChatMessage[] = [];
    let convId = conversationId;

    if (convId) {
      const conv = await query<{ messages: StoredChatMessage[] }>(
        'SELECT messages FROM llm_conversations WHERE id = $1 AND user_id = $2',
        [convId, userId],
      );
      if (conv.rows.length > 0) {
        conversationHistory = conv.rows[0]!.messages;
      }
    }

    // Perform hybrid RAG search — falls back to keyword-only if embedding fails
    let searchResults;
    // Object holder, not a bare `let`: TS control-flow analysis cannot see
    // the synchronous callback assignment and would narrow a bare variable
    // to its `null` initializer at every read site (#1268 review) — property
    // reads are un-narrowed after the intervening await.
    const retrieval: { meta: RetrievalMeta | null } = { meta: null };
    try {
      // #1112: deep search is the SAME retrieval, run for the user's question
      // plus two model-written paraphrases and fused. It is a per-request
      // opt-in (`deepSearch`, default off) and `multiQuerySearch` is a
      // drop-in for `hybridSearch` — same arguments, same options, and when
      // expansion is skipped or soft-fails it calls exactly the line below.
      // Expansion lives in that wrapper rather than inside `hybridSearch`
      // because `/api/search` paginates and must never expand.
      //
      // THE FLAG MUST STAY PER-QUESTION, AND THE UI TOGGLE THAT SETS IT MUST
      // RESET AFTER EVERY ASK (#1119) — never a persisted preference, never a
      // remembered mode. Measured on the #1102 fixture with the rerank stage
      // live: on the vocabulary-gap slice expansion is a large win
      // (R@1 .182 -> .424, n=33), and on the other 164 queries it is a
      // REGRESSION (R@5 .921 -> .866, 2 wins / 11 losses, McNemar exact
      // p = 0.0225). It also costs 1.40 -> 3.76 s/query. So the feature is
      // net-positive only while the person asking chooses it for the question
      // that needs it; a sticky toggle silently applies the regression to
      // every subsequent ordinary question, which is precisely the arm that
      // measured worse. Default off, one question at a time.
      const search = body.deepSearch ? multiQuerySearch : hybridSearch;
      // The chat path REQUESTS the #1104 rerank stage; it actually runs only
      // when an admin has assigned a provider+model to the `rerank` use case
      // (unassigned → no-op). `/api/search` deliberately does not request it
      // — its results paginate, and reranking one page independently of the
      // next breaks the ordering the pages share.
      searchResults = await search(userId, question, 5, undefined, {
        rerank: true,
        // #1106 PR 2: assemble each source page's sibling chunks into the
        // context window buildRagContext reads. Chat-path only — see
        // HybridSearchOptions.assembleContext.
        assembleContext: true,
        // #1107: verified exact-identifier pins ("what is INC-2203",
        // "find the page called X") ahead of the fused ranking.
        pinIdentifiers: true,
        // #1105: the confidence gate needs the retrieval-health verdict —
        // an empty set during a vector-leg outage must not read as "the KB
        // has nothing on this".
        onRetrievalMeta: (meta) => {
          retrieval.meta = meta;
        },
      });
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        reply.code(503);
        return { error: 'LLM service temporarily unavailable', message: 'The AI service circuit breaker is open. Please try again later.' };
      }
      throw err;
    }
    let ragContext = buildRagContext(searchResults);
    // ── KB-context sanitization, part 1 of 2 (#1270 review m12 + F1,
    // CLAUDE.md security rule 3) ─────────────────────────────────────────
    // The RAG half is sanitized HERE, BEFORE the sub-page prepend: its own
    // framing ('[Source N: …]' headers, '---' separators followed by a
    // bracket) cannot trigger the delimiter-injection pattern, while the
    // sub-page tree's '--- Page: … ---' attribution markers CAN when a page
    // body starts with "System …" — sanitizing the concatenated string ate
    // the very markers the prompt suffix tells the model to cite. The tree
    // is therefore sanitized per-page-BODY inside assembleSubPageContext,
    // before markers wrap the text, and its detections arrive as
    // `injectionWarnings` (the fetchWebSources precedent), folded into the
    // attestation below. Detections here carry contentOrigin so the audit
    // trail distinguishes first-party KB content — which the ASKING user
    // did not author — from the requester's own input (#1270 review F7).
    {
      const { sanitized: cleanRag, warnings: ragWarnings } = sanitizeLlmInput(ragContext);
      if (ragWarnings.length > 0) {
        promptInjectionDetected = true;
        await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings: ragWarnings, route: '/llm/ask', source: 'kb_context', contentOrigin: 'first_party_kb' }, request);
      }
      if (cleanRag !== ragContext) wasSanitized = true;
      ragContext = cleanRag;
    }

    // If includeSubPages is enabled and a pageId is provided, augment the RAG context
    // with the sub-page tree content
    let multiPageSuffix = '';
    // The realised-grounding signal for the #1105 gate. NOT multiPageSuffix:
    // that is a prompt-FORMATTING string which getMultiPagePromptSuffix
    // returns as '' for pageCount <= 1 — a leaf page assembles successfully
    // (its full content enters ragContext above) with an empty suffix, and
    // using the suffix as the proxy made the gate refuse over grounding that
    // was in the prompt while claiming the tree "could not be included".
    let subPageContextAssembled = false;
    if (includeSubPages && body.pageId) {
      // #814: enforce the same access control as GET /pages/:id before pulling
      // the parent page (and its whole sub-tree) into the LLM prompt. Without
      // this a caller with only the global `llm:query` permission could
      // extract the content of any page in a space they cannot access.
      const resolved = await resolvePageRef(body.pageId);
      if (resolved && (await userCanAccessPage(userId, resolved.id))) {
        const bodyResult = await query<{ body_html: string }>(
          'SELECT body_html FROM pages WHERE id = $1 AND deleted_at IS NULL',
          [resolved.id],
        );
        const parentHtml = bodyResult.rows[0]?.body_html || '';
        const assembled = await assembleSubPageContext(
          userId,
          resolved.confluenceId ?? body.pageId,
          parentHtml,
          resolved.title,
        );
        // Prepend the page tree context before the RAG context
        ragContext = `Page tree context:\n\n${assembled.markdown}\n\n---\n\nAdditional knowledge base context:\n\n${ragContext}`;
        multiPageSuffix = getMultiPagePromptSuffix(assembled.pageCount);
        subPageContextAssembled = true;
        // Part 2 of 2: the tree was sanitized per-page-body inside
        // assembleSubPageContext (markers intact); its detections join the
        // same attestation trail.
        if (assembled.injectionWarnings.length > 0) {
          promptInjectionDetected = true;
          wasSanitized = true;
          await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings: assembled.injectionWarnings, route: '/llm/ask', source: 'subpage_tree', contentOrigin: 'first_party_kb' }, request);
        }
      }
    }


    // Fetch external documentation URLs via MCP sidecar (if provided and enabled)
    const externalDocs: Array<{ url: string; title: string; markdown: string }> = [];
    if (externalUrls && externalUrls.length > 0 && await isMcpDocsEnabled()) {
      for (const extUrl of externalUrls) {
        try {
          const doc = await fetchDocumentation(extUrl, userId);
          // Sanitize fetched content before injecting into LLM prompt.
          // Roll any warnings/modifications into the per-call flags so
          // Report 5 (LLM Usage attestation) per-route counts don't
          // undercount injection signals smuggled in via fetched docs.
          const { sanitized: sanitizedDoc, warnings: docWarnings } = sanitizeLlmInput(doc.markdown);
          if (docWarnings.length > 0) {
            await logAuditEvent(
              request.userId,
              'PROMPT_INJECTION_DETECTED',
              'llm',
              undefined,
              { warnings: docWarnings, route: '/llm/ask', field: 'externalDoc', url: doc.url },
              request,
            );
            promptInjectionDetected = true;
          }
          if (sanitizedDoc !== doc.markdown) wasSanitized = true;
          // The title is attacker-controlled page metadata too — sanitize it
          // before it is embedded into the external-docs context (#820).
          externalDocs.push({ url: doc.url, title: sanitizeLlmInput(doc.title).sanitized, markdown: sanitizedDoc });
        } catch (err) {
          logger.warn({ err, url: extUrl }, 'Failed to fetch external doc via MCP');
        }
      }

      if (externalDocs.length > 0) {
        const externalContext = externalDocs.map((d, i) =>
          `[External Source ${i + 1}: "${d.title}" (${d.url})]\n${d.markdown}`
        ).join('\n\n---\n\n');
        ragContext += `\n\n---\n\nExternal documentation:\n\n${externalContext}`;
      }
    }

    // Web search for reference material (consistent with generate/improve)
    const askWebSources: WebSource[] = [];
    if (body.searchWeb) {
      const wq = body.searchQuery || sanitizedQuestion.slice(0, 200);
      const { sources: fetchedSources, injectionWarnings } = await fetchWebSources(wq, userId);
      askWebSources.push(...fetchedSources);
      // One aggregated event per request (#835) — covers every offending web
      // source so audit volume stays bounded. logAuditEvent never throws.
      if (injectionWarnings.length > 0) {
        await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, {
          warnings: injectionWarnings.flatMap((w) => w.warnings),
          route: '/llm/ask',
          field: 'webSearch',
          urls: injectionWarnings.map((w) => w.url),
        }, request);
        // Roll web-search detections into the per-call attestation flags so
        // llm_audit_log (Report 5) stays consistent with audit_log — same
        // idiom as the external-doc loop above. Detections always imply
        // [FILTERED] rewrites, so `sanitized` flips too.
        promptInjectionDetected = true;
        wasSanitized = true;
      }
    }

    if (askWebSources.length > 0) {
      ragContext += formatWebContext(askWebSources, {
        sourceLabel: 'Web Source',
        sectionHeader: 'Web search results',
      });
    }

    // Resolve the `chat` use-case to a concrete provider+model up-front so the
    // cache key includes the resolved identity. Guarantees that admin flips of
    // the chat assignment do not serve a stale cached response generated by a
    // different provider. Queue + per-provider circuit breakers are wrapped
    // inside `streamChat()` itself, so no per-call-site wrapping needed.
    const { config: chatConfig, model: resolvedModel } = await resolveUsecase('chat');
    logger.debug(
      { userId, bodyModel: model, providerId: chatConfig.providerId, resolvedModel },
      'Resolved chat usecase assignment',
    );

    // #1154: gate and load before the cache lookup, so the key can include
    // the image and a refusal never costs a provider round-trip.
    let imagePart: ChatContentPart | undefined;
    let imageHash: string | undefined;
    if (imageHandle) {
      const resolved = await resolveImagePart(
        fastify, userId, imageHandle, chatConfig.providerId, resolvedModel,
      );
      imagePart = resolved.part;
      imageHash = resolved.hash;
    }

    // Check RAG cache with stampede protection (only for new conversations without history)
    // Locally-created pages have confluence_id NULL, and a set of nulls collapses
    // to a run of empty strings in the joined cache key — two different sets of
    // standalone pages would then share a key and serve each other's answer.
    // Fall back to the integer PK, which every page has (#1125).
    const docIds = searchResults.map((r) => r.confluenceId ?? `page:${r.pageId}`);
    const ragCacheKey = buildRagCacheKey(resolvedModel, question, docIds, {
      includeSubPages,
      pageId: body.pageId,
      externalUrls,
      searchWeb: body.searchWeb,
      provider: chatConfig.providerId,
      thinking: body.thinking,
      // #1270 reviews m6 + F9: cached answers are specific to the assembly
      // CONFIG (the budget — killing assembly must not replay large-context
      // answers for the TTL) AND to the realized OUTCOME (how many sources
      // actually assembled — a soft-failed request's chunk-level answer
      // must not be served under the healthy key for an hour after the
      // transient recovers).
      contextChars: await getRagContextCharsPerPage(),
      assembledPages: searchResults.filter((r) => r.contextText !== undefined).length,
      pinnedCount: searchResults.filter((r) => r.pinned === true).length,
      // #1112: the two modes must not serve each other's answers — the doc-id
      // component cannot see a re-ORDERED set, and sees nothing at all when
      // expansion soft-fails to the single-query path and later recovers.
      deepSearch: body.deepSearch,
      imageHash,
    });

    // `score` is the retrieval ORDERING value — an RRF fusion score from
    // hybridSearch, typically ~0.033, and since #1106's best-chunk-only
    // fusion rule that is also the CEILING (rrfWorstCase), invariant to the
    // fetch width, the rerank pool and the raw chunk window alike — never
    // near what a similarity threshold expects. It is kept because it orders
    // the array and is what
    // any existing consumer of this frame reads; it must never be rendered or
    // thresholded. `similarity` is the cosine, or null when the page was found
    // only by keyword search and none was ever measured (#1117).
    //
    // Note the two are separate FIELDS rather than one redefined field purely
    // for legibility — `sources` is never persisted (saveConversation below
    // writes `ChatMessage[]`, i.e. `{role, content}`), so a replayed
    // conversation carries no sources at all and renders no badge regardless.
    const sources = [
      ...searchResults.map((r) => ({
        pageId: r.pageId,
        pageTitle: r.pageTitle,
        spaceKey: r.spaceKey,
        confluenceId: r.confluenceId,
        // #1270 reviews m7 + F4: the prompt header refuses to label
        // multi-SECTION context with one section, and the UI chip agrees —
        // keyed on the real spans-sections datum, not window size (every
        // chunk of one oversized section shares its title).
        sectionTitle: r.contextSpansSections === true ? undefined : r.sectionTitle,
        score: r.score,
        similarity: r.vectorScore,
        // #1104: present only on reranked results; #1105's confidence formula
        // is the intended reader (see SearchResult.rerankScore's
        // comparability caveat — never threshold it with a universal
        // constant). NOTE the rerank stage changes WHICH topK land here, so
        // ConfidenceBadge's mean-cosine sample shifts when rerank promotes
        // keyword-only or low-cosine pages — recorded in ADR-021's #1104
        // amendment.
        rerankScore: r.rerankScore ?? null,
      })),
      // `url` is the discriminator the frontend keys on: these are links, not
      // pages, and routing them through `/pages/:id` lands on the not-found
      // page (#1125). `confluenceId` keeps carrying the URL for conversations
      // persisted before this field existed.
      // `score: 1` is a sort key, not a measurement — these never went through
      // retrieval. `similarity: null` keeps them out of any confidence average:
      // previously they were the only sources scoring 1.0, so a web-grounded
      // answer outranked one grounded in the knowledge base (#1117).
      ...externalDocs.map((d) => ({
        pageId: 0,
        pageTitle: d.title,
        spaceKey: 'External',
        confluenceId: d.url,
        url: d.url,
        sectionTitle: d.title,
        score: 1,
        similarity: null,
      })),
      ...askWebSources.map((s) => ({
        pageId: 0,
        pageTitle: s.title,
        spaceKey: 'Web',
        confluenceId: s.url,
        url: s.url,
        sectionTitle: s.title,
        score: 1,
        similarity: null,
      })),
    ];

    // Helper to save/create conversation from a cached answer or a refusal.
    // The row's `model` column is the THREAD's configured model, not an
    // attestation that it was invoked — a refusal writes it without a call.
    const saveConversation = async (answer: string, opts?: { refused?: boolean }) => {
      const newMessages: StoredChatMessage[] = [
        ...conversationHistory,
        { role: 'user', content: question },
        opts?.refused
          ? { role: 'assistant', content: answer, refused: true }
          : { role: 'assistant', content: answer },
      ];

      if (convId) {
        await query(
          'UPDATE llm_conversations SET messages = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2',
          [convId, userId, JSON.stringify(newMessages)],
        );
      } else {
        const insertResult = await query<{ id: string }>(
          `INSERT INTO llm_conversations (user_id, model, title, messages)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, resolvedModel, question.slice(0, 100), JSON.stringify(newMessages)],
        );
        convId = insertResult.rows[0]!.id;
      }
    };

    // ── Honest-refusal gate (#1105, widened by #1114's prerequisite) ─────
    // THREE refusal reasons, and only ONE of them is a threshold verdict.
    // The other two are unconditional, because they are not measurements at
    // all — they are statements that retrieval did not happen:
    //
    // 1. `semantic_index_unavailable` — the embedding leg THREW
    //    (`degradedReason === 'embedding_failed'`: provider outage, model
    //    still loading, 5xx, timeout, missing `embedding` assignment, or a
    //    pgvector dimension mismatch). The search silently continued
    //    keyword-only and the answer was rendered as an ordinary one, so a
    //    user could not tell a degraded answer from a whole-corpus one —
    //    and during the #1116 re-embed window, which is exactly when this
    //    fires, that is precisely what they need to know.
    // 2. `no_context` — retrieval returned NOTHING and nothing else grounds
    //    the turn. `buildRagContext` hands the model the literal string "No
    //    relevant context found in the knowledge base." and the model
    //    answered from parametric memory anyway, with `refused` unset and
    //    no signal on the wire: an ungrounded answer wearing a grounded
    //    answer's clothes.
    // 3. `weak_match` — the #1105 verdict proper: a MEASURED score below
    //    the operator's threshold for this request's basis.
    //
    // Reasons 1 and 2 deliberately do NOT consult a threshold. Both knobs
    // default to 0, so a threshold-gated version of either would ship dark
    // in most deployments — including, for reason 1, during the very outage
    // it exists to disclose. Reason 3 keeps its knob: it is a tuning value
    // for "how good is good enough", a question reasons 1 and 2 never ask.
    //
    // Retrieval signals ONLY, never LLM self-report. Diagnostic always (an
    // info log — default LOG_LEVEL shows it, which is what "ship diagnostic
    // first" requires; the same verdict rides the trace as rag.confidence /
    // rag.confidence_basis). Cosine and
    // rerank relevance are incommensurable scales and the basis flips per
    // request (a rerank bypass measures on cosine), so each measured basis
    // gates on its own knob — see readConfidenceThreshold in
    // admin-settings-service. The basis-'none' arm (max of both knobs) is
    // now belt-and-braces rather than the empty set's route to refusal:
    // `computeRetrievalConfidence` only ever returns a non-null 'none'
    // score for a healthy EMPTY set, and reason 2 refuses that ahead of any
    // threshold. It stays because the #1268 review's argument still holds
    // for any future formula that measures on no basis — "no grounding at
    // all" belongs to no scale and must not be orphaned by the knob split.
    //
    // The gate stands down for grounding that actually MATERIALISED — an
    // assembled sub-page tree, fetched external docs, fetched web results,
    // or a prior SUBSTANTIVE assistant turn (follow-ups resolve against
    // history; a persisted refusal grounds nothing, or re-asking the same
    // weak question would bypass the gate with the refusal itself as
    // context). Request flags alone do not count (#1268 review — replaces
    // the flag-based fail-open): the sharp edge is `includeSubPages`, which
    // is session-sticky AiContext state sent on every ask, so as a flag it
    // was a one-click session-wide gate bypass even when RBAC denied the
    // tree. (`externalUrls` clears per send and `searchWeb` is API-only on
    // this route — for those the flags were merely inaccurate, not
    // amplified.) When requested grounding did NOT materialise, the refusal
    // text names it below — a refusal whose only named remedy is
    // "rephrase" is wrong when the actual failure is a dead sidecar.
    // That stand-down covers all three reasons, the outage one included: a
    // sub-page tree, attached documents, web results and a substantive
    // prior turn are real grounding that the vector index being down does
    // not touch. Keyword-only and keyword-led sets that DID return rows
    // still carry a null score and are never refused for reason 3 — the
    // gate does not threshold what it cannot measure — but a keyword-only
    // set produced by a THROWN embedding call is now reason 1, which is a
    // health fact rather than a score. Placed BEFORE the response-cache
    // read so a low-confidence question cannot serve a stale cached answer
    // either.
    const confidence = computeRetrievalConfidence(searchResults, retrieval.meta?.healthCaveat ?? null);
    const similarityThreshold = await getRagConfidenceThreshold();
    const rerankThreshold = await getRagConfidenceThresholdRerank();
    const confidenceThreshold =
      confidence.basis === 'rerank'
        ? rerankThreshold
        : confidence.basis === 'similarity'
          ? similarityThreshold
          : Math.max(similarityThreshold, rerankThreshold);
    const hasSubstantiveHistory = conversationHistory.some(
      (m) => m.role === 'assistant' && !m.refused,
    );
    const otherGrounding = Boolean(
      subPageContextAssembled
      || externalDocs.length > 0
      || askWebSources.length > 0
      || hasSubstantiveHistory
      || imagePart,
    );
    // Precedence is deliberate: the outage reason outranks the empty-set one
    // because during an embedding outage "I found nothing" is a CONSEQUENCE,
    // not a finding, and telling the user the corpus has nothing on their
    // question is the false claim this whole gate exists to avoid.
    const refusalReason: RefusalReason | null =
      otherGrounding
        ? null
        : retrieval.meta?.degradedReason === 'embedding_failed'
          ? 'semantic_index_unavailable'
          : searchResults.length === 0
            ? 'no_context'
            : confidenceThreshold > 0
                && confidence.score !== null
                && confidence.score < confidenceThreshold
              ? 'weak_match'
              : null;
    logger.info(
      {
        userId,
        confidence: confidence.score,
        basis: confidence.basis,
        degradedReason: retrieval.meta?.degradedReason ?? null,
        healthCaveat: retrieval.meta?.healthCaveat ?? null,
        searchType: retrieval.meta?.searchType ?? null,
        embeddingCoverage: retrieval.meta?.embeddingCoverage ?? null,
        aclEmptied: retrieval.meta?.aclEmptied ?? false,
        refusalReason,
      },
      'RAG retrieval confidence',
    );
    if (refusalReason !== null) {
      // Persisted text and live text diverge DELIBERATELY: saveConversation
      // stores {role, content, refused} only, so the reload has no source
      // list to point at — but the live final frame does attach the weak
      // sources (#1119's hook), and an unexplained chip row under "I am not
      // answering" reads as sources that were used (#1268 review). Each
      // surface's text matches what that surface shows.
      // Requested-but-failed grounding is named explicitly: in the reachable
      // "three URLs attached, sidecar down, KB empty" path the URLs are the
      // only thing that failed, and a refusal that answers it with "try
      // rephrasing" misdirects the user away from the real remedy.
      const groundingFailures: string[] = [];
      if (externalUrls && externalUrls.length > 0 && externalDocs.length === 0) {
        groundingFailures.push('none of the attached URLs could be retrieved');
      }
      if (includeSubPages && body.pageId && !subPageContextAssembled) {
        groundingFailures.push('the requested page tree could not be included');
      }
      if (body.searchWeb && askWebSources.length === 0) {
        groundingFailures.push('the web search returned no results');
      }
      const groundingNote =
        groundingFailures.length > 0
          ? ` Note: ${groundingFailures.join(', and ')} — that grounding was unavailable for this answer; retry, or check with an administrator if it persists.`
          : '';
      const refusalText = REFUSAL_TEXT[refusalReason] + groundingNote;
      const liveRefusalText =
        sources.length > 0
          ? refusalText + REFUSAL_SOURCES_NOTE[refusalReason]
          : refusalText;
      // The refusal is a real assistant turn: persist it (marked `refused`,
      // see StoredChatMessage) so the thread reads coherently on reload, but
      // never cache it (the threshold is runtime config) and no chat
      // completion runs (the query embedding — and a rerank call, when that
      // stage is live — already did; those are the cost of measuring). No
      // llm_audit_log row is written, matching the cache-hit path: that log
      // attests model calls, and none happened.
      await saveConversation(refusalText, { refused: true });
      sendCachedSSE(
        reply,
        liveRefusalText,
        {
          // #1119 keys its refusal treatment on this flag; until it ships
          // the text above renders as an ordinary assistant message.
          refused: true,
          // The one retrieval-health fact that reaches the client. Without
          // it an outage refusal is indistinguishable on the wire from "the
          // corpus does not cover this", which is the same conflation the
          // text above exists to undo.
          refusalReason,
          confidence: confidence.score,
          confidenceBasis: confidence.basis,
          conversationId: convId,
          sources,
        },
        // Nothing was cached — the default `cached: true` would be a lie.
        { cached: false },
      );
      return;
    }

    let ragLockAcquired = false;
    if (conversationHistory.length === 0) {
      const { cached, lockAcquired } = await checkCacheWithLock(llmCache, ragCacheKey);
      ragLockAcquired = lockAcquired;

      if (cached) {
        await saveConversation(cached.content);

        sendCachedSSE(reply, cached.content, {
          conversationId: convId,
          sources,
        });
        return;
      }
    }

    try {
      // Build messages (use resolveSystemPrompt so guardrails are appended)
      const askPrompt = await resolveSystemPrompt(userId, 'ask');
      const userTextContent = `Context from knowledge base:\n\n${ragContext}\n\n---\n\nQuestion: ${sanitizedQuestion}`;
      const userContent: string | ChatContentPart[] = imagePart
        ? [{ type: 'text', text: userTextContent }, imagePart]
        : userTextContent;

      const messages: ChatMessage[] = [
        { role: 'system', content: askPrompt + multiPageSuffix },
        // Refusal turns are persistence/UI records, not model context —
        // and the `refused` field must not reach the provider wire.
        ...conversationHistory.filter((m) => !m.refused).map(
          ({ role, content }): ChatMessage => ({ role, content }),
        ),
        {
          role: 'user',
          content: userContent,
        },
      ];

      // Stream the response and collect full answer
      const controller = new AbortController();
      const onClose = () => controller.abort();
      request.raw.on('close', onClose);

      const generator = streamChat(chatConfig, resolvedModel, messages, controller.signal, { thinking: body.thinking });
      let fullAnswer = '';

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        for await (const chunk of generator) {
          if (controller.signal.aborted) {
            logger.debug('RAG SSE stream aborted by client disconnect');
            break;
          }
          fullAnswer += chunk.content;
          reply.raw.write(`data: ${JSON.stringify({ content: chunk.content, done: chunk.done })}\n\n`);
        }

        if (!controller.signal.aborted) {
          // Cache the response
          if (fullAnswer) {
            await llmCache.setCachedResponse(ragCacheKey, fullAnswer);
          }

          await saveConversation(fullAnswer);

          emitLlmAudit({
            userId,
            action: 'ask',
            model: resolvedModel,
            provider: chatConfig.providerId,
            inputTokens: estimateTokens(messages.map(m => contentToText(m.content)).join('')),
            outputTokens: estimateTokens(fullAnswer),
            inputMessages: messages.map(m => ({
              role: m.role,
              contentLength: contentToText(m.content).length,
            })),
            retrievedChunkIds: searchResults.map(r => String(r.pageId)),
            durationMs: Date.now() - auditStart,
            status: 'success',
            promptInjectionDetected,
            sanitized: wasSanitized,
          });

          reply.raw.write(`data: ${JSON.stringify({
            done: true,
            final: true,
            conversationId: convId,
            sources,
          })}\n\n`);
        }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
          logger.debug('RAG stream aborted by client disconnect');
        } else {
          logger.error({ err }, 'RAG stream error');
          emitLlmAudit({
            userId,
            action: 'ask',
            model: resolvedModel,
            provider: chatConfig.providerId,
            inputTokens: estimateTokens(messages.map(m => contentToText(m.content)).join('')),
            outputTokens: 0,
            inputMessages: messages.map(m => ({
              role: m.role,
              contentLength: contentToText(m.content).length,
            })),
            retrievedChunkIds: searchResults.map(r => String(r.pageId)),
            durationMs: Date.now() - auditStart,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
            promptInjectionDetected,
            sanitized: wasSanitized,
          });
          reply.raw.write(`data: ${JSON.stringify({ error: 'Stream error', done: true })}\n\n`);
        }
      } finally {
        request.raw.removeListener('close', onClose);
        reply.raw.end();
      }
    } finally {
      if (ragLockAcquired) await llmCache.releaseLock(ragCacheKey);
    }
    } finally {
      await slot.release();
    }
  });
}
