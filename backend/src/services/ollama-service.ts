import { Ollama } from 'ollama';
import type { Config } from 'ollama';
import pLimit from 'p-limit';
import { sanitizeLlmInput } from '../utils/sanitize-llm-input.js';
import { logger } from '../utils/logger.js';
import { ollamaBreakers } from './circuit-breaker.js';

/** Default timeout for Ollama HTTP requests (30 s). */
const OLLAMA_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Wrap the global `fetch` so every Ollama request gets an abort-signal
 * timeout.  If the caller already supplies a signal the caller's signal
 * wins (the ollama SDK sets signals for streaming requests).
 */
const ollamaFetch: typeof fetch = (input, init?) => {
  const hasSignal = init?.signal != null;
  return fetch(input, {
    ...init,
    signal: hasSignal ? init!.signal : AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
  });
};

const ollamaConfig: Partial<Config> = {
  host: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  fetch: ollamaFetch,
};

if (process.env.LLM_BEARER_TOKEN) {
  ollamaConfig.headers = {
    Authorization: `Bearer ${process.env.LLM_BEARER_TOKEN}`,
  };
}

const ollama = new Ollama(ollamaConfig);

// Max 2 concurrent LLM calls
const llmLimit = pLimit(2);

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

const SYSTEM_PROMPTS = {
  improve_grammar: `You are a technical writing assistant. Improve the grammar, spelling, and punctuation of the following article while preserving its meaning and structure. Return the improved text in Markdown format. Only output the improved text, no explanations.`,

  improve_structure: `You are a technical writing assistant. Improve the structure and organization of the following article. Add clear headings, improve paragraph flow, and ensure logical order. Return the improved text in Markdown format. Only output the improved text, no explanations.`,

  improve_clarity: `You are a technical writing assistant. Improve the clarity and readability of the following article. Simplify complex sentences, remove jargon where possible, and ensure each point is clear. Return the improved text in Markdown format. Only output the improved text, no explanations.`,

  improve_technical: `You are a technical expert reviewer. Review the following article for technical accuracy. Fix any technical errors, update outdated information, and add missing technical details. Return the improved text in Markdown format. Only output the improved text, no explanations.`,

  improve_completeness: `You are a technical writing assistant. Review the following article for completeness. Identify and fill in any missing sections, add examples where helpful, and ensure all topics are adequately covered. Return the improved text in Markdown format. Only output the improved text, no explanations.`,

  generate: `You are a technical documentation writer. Generate a well-structured knowledge base article based on the user's request. Use clear headings, code examples where appropriate, and follow best practices for technical documentation. Return the article in Markdown format.`,

  generate_runbook: `You are a technical documentation writer specializing in operational runbooks. Generate a runbook with: Overview, Prerequisites, Step-by-step procedures, Troubleshooting, and Rollback sections. Return in Markdown format.`,

  generate_howto: `You are a technical documentation writer. Generate a how-to guide with: Introduction, Prerequisites, Step-by-step instructions with examples, Tips and best practices, and Common issues sections. Return in Markdown format.`,

  generate_architecture: `You are a software architect creating documentation. Generate an architecture document with: Overview, System diagram description, Components, Data flow, Technology choices, and Trade-offs sections. Return in Markdown format.`,

  generate_troubleshooting: `You are a support engineer creating documentation. Generate a troubleshooting guide with: Symptom description, Possible causes, Diagnostic steps, Resolution steps, and Prevention measures for each issue. Return in Markdown format.`,

  summarize: `You are a technical writing assistant. Provide a concise summary of the following article. Focus on the key points, decisions, and actionable items. Return the summary in Markdown format.`,

  ask: `You are a knowledgeable assistant that answers questions based on the provided knowledge base context. Answer accurately based on the context. If the context doesn't contain enough information, say so. Always cite which articles your answer is based on.`,

  generate_diagram_flowchart: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid flowchart diagram that captures the main processes, decisions, and flows described in the content. Use the Mermaid flowchart syntax (graph TD or graph LR). Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "graph" or "flowchart".`,

  generate_diagram_sequence: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid sequence diagram that captures the interactions between participants/systems described in the content. Use the Mermaid sequenceDiagram syntax. Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "sequenceDiagram".`,

  generate_diagram_state: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid state diagram that captures the states and transitions described in the content. Use the Mermaid stateDiagram-v2 syntax. Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "stateDiagram-v2".`,

  generate_diagram_mindmap: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid mindmap diagram that captures the key concepts and their relationships described in the content. Use the Mermaid mindmap syntax. Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "mindmap".`,
} as const;

export type SystemPromptKey = keyof typeof SYSTEM_PROMPTS;

export function getSystemPrompt(key: SystemPromptKey): string {
  return SYSTEM_PROMPTS[key];
}

export async function listModels(): Promise<Array<{ name: string; size: number; modifiedAt: Date; digest: string }>> {
  return ollamaBreakers.list.execute(async () => {
    const response = await ollama.list();
    return response.models.map((m) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
      digest: m.digest,
    }));
  });
}

export interface OllamaHealthResult {
  connected: boolean;
  error?: string;
}

export async function checkHealth(): Promise<OllamaHealthResult> {
  try {
    await ollama.list();
    return { connected: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.debug({ err }, 'Ollama health check failed');
    return { connected: false, error: message };
  }
}

export async function* streamChat(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const generator = await ollamaBreakers.chat.execute(() =>
    llmLimit(() =>
      ollama.chat({
        model,
        messages,
        stream: true,
      }),
    ),
  );

  try {
    for await (const part of generator) {
      // Check if client disconnected
      if (signal?.aborted) {
        // Try to abort the underlying stream
        if (typeof (generator as unknown as AsyncGenerator).return === 'function') {
          await (generator as unknown as AsyncGenerator).return(undefined);
        }
        return;
      }
      yield {
        content: part.message.content,
        done: part.done,
      };
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      logger.debug('Stream aborted by client disconnect');
      return;
    }
    throw err;
  }
}

export async function chat(model: string, messages: ChatMessage[]): Promise<string> {
  return ollamaBreakers.chat.execute(async () => {
    const response = await llmLimit(() =>
      ollama.chat({ model, messages, stream: false }),
    );
    return response.message.content;
  });
}

export async function generateEmbedding(text: string | string[]): Promise<number[][]> {
  return ollamaBreakers.embed.execute(async () => {
    const model = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';
    const input = Array.isArray(text) ? text : [text];

    const response = await llmLimit(() =>
      ollama.embed({ model, input }),
    );

    return response.embeddings;
  });
}

export function improveContent(
  model: string,
  content: string,
  type: 'grammar' | 'structure' | 'clarity' | 'technical' | 'completeness',
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const { sanitized } = sanitizeLlmInput(content);
  const systemPrompt = getSystemPrompt(`improve_${type}` as SystemPromptKey);
  return streamChat(model, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: sanitized },
  ], signal);
}

export function generateArticle(
  model: string,
  prompt: string,
  template?: 'runbook' | 'howto' | 'architecture' | 'troubleshooting',
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const { sanitized } = sanitizeLlmInput(prompt);
  const systemPrompt = template
    ? getSystemPrompt(`generate_${template}` as SystemPromptKey)
    : getSystemPrompt('generate');
  return streamChat(model, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: sanitized },
  ], signal);
}

export function summarizeContent(
  model: string,
  content: string,
  length: 'short' | 'medium' | 'detailed' = 'medium',
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const { sanitized } = sanitizeLlmInput(content);
  const lengthInstructions = {
    short: 'Provide a brief 2-3 sentence summary.',
    medium: 'Provide a summary of 1-2 paragraphs covering the main points.',
    detailed: 'Provide a detailed summary covering all important points, decisions, and action items.',
  };

  return streamChat(model, [
    { role: 'system', content: `${getSystemPrompt('summarize')} ${lengthInstructions[length]}` },
    { role: 'user', content: sanitized },
  ], signal);
}

export function generateDiagram(
  model: string,
  content: string,
  diagramType: 'flowchart' | 'sequence' | 'state' | 'mindmap' = 'flowchart',
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const { sanitized } = sanitizeLlmInput(content);
  const systemPrompt = getSystemPrompt(`generate_diagram_${diagramType}` as SystemPromptKey);
  return streamChat(model, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: sanitized },
  ], signal);
}

export function askWithContext(
  model: string,
  question: string,
  context: string,
  conversationHistory: ChatMessage[] = [],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const { sanitized: sanitizedQuestion } = sanitizeLlmInput(question);
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt('ask') },
    ...conversationHistory,
    {
      role: 'user',
      content: `Context from knowledge base:\n\n${context}\n\n---\n\nQuestion: ${sanitizedQuestion}`,
    },
  ];

  return streamChat(model, messages, signal);
}

export { ollama };
