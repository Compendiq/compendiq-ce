import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat, type ChatMessage } from '../../domains/llm/services/openai-compatible-client.js';

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
// From the leaf module, NOT via rag-service: the route suite stubs
// rag-service with a closed export list, and the formula must stay REAL
// there (stubbing it would let route and formula drift — #1268 review).
import { computeRetrievalConfidence } from '../../domains/llm/services/retrieval-confidence.js';
import { getRagConfidenceThreshold, getRagConfidenceThresholdRerank } from '../../core/services/admin-settings-service.js';
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
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import { userCanAccessPage } from '../../core/services/rbac-service.js';
import { acquireStreamSlot } from '../../core/services/sse-stream-limiter.js';

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
    const { question, model, conversationId, includeSubPages, externalUrls } = body;
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
      // The chat path REQUESTS the #1104 rerank stage; it actually runs only
      // when an admin has assigned a provider+model to the `rerank` use case
      // (unassigned → no-op). `/api/search` deliberately does not request it
      // — its results paginate, and reranking one page independently of the
      // next breaks the ordering the pages share.
      searchResults = await hybridSearch(userId, question, 5, undefined, {
        rerank: true,
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
        sectionTitle: r.sectionTitle,
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

    // ── Retrieval-confidence refuse gate (#1105) ─────────────────────────
    // Retrieval signals ONLY, never LLM self-report. Diagnostic always (an
    // info log — default LOG_LEVEL shows it, which is what "ship diagnostic
    // first" requires; the same verdict rides the trace as rag.confidence /
    // rag.confidence_basis); refusal only when the operator raised the
    // threshold FOR THIS REQUEST'S BASIS above its 0 default. Cosine and
    // rerank relevance are incommensurable scales and the basis flips per
    // request (a rerank bypass measures on cosine), so each measured basis
    // gates on its own knob — see readConfidenceThreshold in
    // admin-settings-service. A healthy EMPTY set (basis 'none', score 0)
    // belongs to no scale and refuses when EITHER knob is raised: "no
    // grounding at all" is below any positive bar, and mapping it to one
    // knob left a rerank-only or similarity-only deployment with the
    // feature's headline case silently open (#1268 review).
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
    // Keyword-only and keyword-led sets and health-caveat
    // empties (vector leg down, corpus unembedded, coverage probe failed)
    // carry a null score and are never refused: the gate does not refuse
    // what it cannot measure. Placed BEFORE the response-cache read so a
    // low-confidence question cannot serve a stale cached answer either.
    const confidence = computeRetrievalConfidence(searchResults, retrieval.meta?.healthCaveat ?? null);
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
      },
      'RAG retrieval confidence',
    );
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
      || hasSubstantiveHistory,
    );
    if (
      confidenceThreshold > 0
      && !otherGrounding
      && confidence.score !== null
      && confidence.score < confidenceThreshold
    ) {
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
      const refusalText =
        (searchResults.length === 0
          ? 'I could not find any knowledge-base content related to this question, so I am not answering rather than guessing. Try rephrasing, or ask about something the knowledge base covers.'
          : 'The knowledge-base passages I found are not a strong enough match to this question to ground an answer, so I am not answering rather than guessing.')
        + groundingNote;
      const liveRefusalText =
        sources.length > 0
          ? `${refusalText} The closest partial matches are attached as sources for reference — none matched well enough to use.`
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
      const messages: ChatMessage[] = [
        { role: 'system', content: askPrompt + multiPageSuffix },
        // Refusal turns are persistence/UI records, not model context —
        // and the `refused` field must not reach the provider wire.
        ...conversationHistory.filter((m) => !m.refused).map(
          ({ role, content }): ChatMessage => ({ role, content }),
        ),
        {
          role: 'user',
          content: `Context from knowledge base:\n\n${ragContext}\n\n---\n\nQuestion: ${sanitizedQuestion}`,
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
