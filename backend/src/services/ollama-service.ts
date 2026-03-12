/**
 * LLM service facade.
 *
 * Maintains the original module-level API surface so existing route handlers
 * and services continue to work.  Under the hood, all calls are delegated to
 * the currently active LlmProvider instance (Ollama or OpenAI-compatible).
 *
 * The active provider can be switched at runtime via `setActiveProvider()`.
 */

import { sanitizeLlmInput } from '../core/utils/sanitize-llm-input.js';
import { logger } from '../core/utils/logger.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAIProvider } from './openai-service.js';
import type { LlmProvider, LlmProviderType } from './llm-provider.js';

// Local type definitions (also defined in llm-provider.ts — kept here to avoid circular imports)
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface LlmModel {
  name: string;
  size: number;
  modifiedAt: Date;
  digest: string;
}

export interface OllamaHealthResult {
  connected: boolean;
  error?: string;
}

// ─── SSL / Auth config (shared across providers) ────────────────────────────

/** Whether to verify TLS certificates for LLM connections (default: true). */
const llmVerifySsl = process.env.LLM_VERIFY_SSL !== 'false';

/** Auth type for LLM connections: 'bearer' (default) or 'none'. */
const llmAuthType = (process.env.LLM_AUTH_TYPE ?? 'bearer').toLowerCase();

if (!llmVerifySsl) {
  logger.warn('LLM_VERIFY_SSL=false — TLS certificate verification is disabled for LLM/Ollama connections');
}

if (llmAuthType !== 'bearer' && llmAuthType !== 'none') {
  logger.warn({ llmAuthType }, 'Unknown LLM_AUTH_TYPE value — falling back to no auth');
}

/** Whether TLS verification is enabled for LLM connections. */
export function isLlmVerifySslEnabled(): boolean {
  return llmVerifySsl;
}

/** The configured LLM auth type ('bearer' | 'none'). */
export function getLlmAuthType(): string {
  return llmAuthType;
}

// ─── Provider registry ─────────────────────────────────────────────────────

const providers: Record<LlmProviderType, LlmProvider> = {
  ollama: new OllamaProvider(),
  openai: new OpenAIProvider(),
};

let activeProviderType: LlmProviderType =
  (process.env.LLM_PROVIDER as LlmProviderType) === 'openai' ? 'openai' : 'ollama';

export function getActiveProvider(): LlmProvider {
  return providers[activeProviderType];
}

export function getActiveProviderType(): LlmProviderType {
  return activeProviderType;
}

export function setActiveProvider(type: LlmProviderType): void {
  if (!providers[type]) {
    throw new Error(`Unknown LLM provider: ${type}`);
  }
  logger.info({ from: activeProviderType, to: type }, 'Switching LLM provider');
  activeProviderType = type;
}

export function getProvider(type: LlmProviderType): LlmProvider {
  return providers[type];
}

// ─── System prompts (provider-agnostic) ─────────────────────────────────────

export const LANGUAGE_PRESERVATION_INSTRUCTION = `IMPORTANT: Keep the text in its ORIGINAL language. If the text is in German, respond in German. If in English, respond in English. Never translate — only improve the text while preserving its language.`;

const SYSTEM_PROMPTS = {
  improve_grammar: `You are a technical writing assistant. Improve the grammar, spelling, and punctuation of the following article while preserving its meaning and structure. Return the improved text in Markdown format. Only output the improved text, no explanations. ${LANGUAGE_PRESERVATION_INSTRUCTION}`,

  improve_structure: `You are a technical writing assistant. Improve the structure and organization of the following article. Add clear headings, improve paragraph flow, and ensure logical order. Return the improved text in Markdown format. Only output the improved text, no explanations. ${LANGUAGE_PRESERVATION_INSTRUCTION}`,

  improve_clarity: `You are a technical writing assistant. Improve the clarity and readability of the following article. Simplify complex sentences, remove jargon where possible, and ensure each point is clear. Return the improved text in Markdown format. Only output the improved text, no explanations. ${LANGUAGE_PRESERVATION_INSTRUCTION}`,

  improve_technical: `You are a technical expert reviewer. Review the following article for technical accuracy. Fix any technical errors, update outdated information, and add missing technical details. Return the improved text in Markdown format. Only output the improved text, no explanations. ${LANGUAGE_PRESERVATION_INSTRUCTION}`,

  improve_completeness: `You are a technical writing assistant. Review the following article for completeness. Identify and fill in any missing sections, add examples where helpful, and ensure all topics are adequately covered. Return the improved text in Markdown format. Only output the improved text, no explanations. ${LANGUAGE_PRESERVATION_INSTRUCTION}`,

  generate: `You are a technical documentation writer. Generate a well-structured knowledge base article based on the user's request. Use clear headings, code examples where appropriate, and follow best practices for technical documentation. Return the article in Markdown format.`,

  generate_runbook: `You are a technical documentation writer specializing in operational runbooks. Generate a runbook with: Overview, Prerequisites, Step-by-step procedures, Troubleshooting, and Rollback sections. Return in Markdown format.`,

  generate_howto: `You are a technical documentation writer. Generate a how-to guide with: Introduction, Prerequisites, Step-by-step instructions with examples, Tips and best practices, and Common issues sections. Return in Markdown format.`,

  generate_architecture: `You are a software architect creating documentation. Generate an architecture document with: Overview, System diagram description, Components, Data flow, Technology choices, and Trade-offs sections. Return in Markdown format.`,

  generate_troubleshooting: `You are a support engineer creating documentation. Generate a troubleshooting guide with: Symptom description, Possible causes, Diagnostic steps, Resolution steps, and Prevention measures for each issue. Return in Markdown format.`,

  summarize: `You are a technical writing assistant. Provide a concise summary of the following article. Focus on the key points, decisions, and actionable items. Return the summary in Markdown format. ${LANGUAGE_PRESERVATION_INSTRUCTION}`,

  ask: `You are a knowledgeable assistant that answers questions based on the provided knowledge base context. Answer accurately based on the context. If the context doesn't contain enough information, say so. Always cite which articles your answer is based on. Respond in the same language as the user's question.`,

  generate_diagram_flowchart: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid flowchart diagram that captures the main processes, decisions, and flows described in the content. Use the Mermaid flowchart syntax (graph TD or graph LR). Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "graph" or "flowchart". IMPORTANT: If any node label contains special characters like parentheses (), brackets [], or braces {}, you MUST wrap the entire label text in double quotes. Example: A["Deploy (30min downtime)"] instead of A[Deploy (30min downtime)].`,

  generate_diagram_sequence: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid sequence diagram that captures the interactions between participants/systems described in the content. Use the Mermaid sequenceDiagram syntax. Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "sequenceDiagram". IMPORTANT: If any node label contains special characters like parentheses (), brackets [], or braces {}, you MUST wrap the entire label text in double quotes. Example: A["Deploy (30min downtime)"] instead of A[Deploy (30min downtime)].`,

  generate_diagram_state: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid state diagram that captures the states and transitions described in the content. Use the Mermaid stateDiagram-v2 syntax. Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "stateDiagram-v2". IMPORTANT: If any node label contains special characters like parentheses (), brackets [], or braces {}, you MUST wrap the entire label text in double quotes. Example: A["Deploy (30min downtime)"] instead of A[Deploy (30min downtime)].`,

  generate_diagram_mindmap: `You are a diagram generation assistant. Analyze the provided article text and generate a Mermaid mindmap diagram that captures the key concepts and their relationships described in the content. Use the Mermaid mindmap syntax. Output ONLY the raw Mermaid diagram code with no markdown fences, no explanations, and no surrounding text. Start directly with "mindmap". IMPORTANT: If any node label contains special characters like parentheses (), brackets [], or braces {}, you MUST wrap the entire label text in double quotes. Example: A["Deploy (30min downtime)"] instead of A[Deploy (30min downtime)].`,

  analyze_quality: `You are an expert technical documentation quality analyst. Evaluate the provided article across five dimensions and produce a structured quality report.

For each dimension, provide a score from 0 to 100 and 1-3 specific, actionable suggestions for improvement:

1. **Completeness** — Does the article cover all necessary topics? Are there gaps, missing sections, or unexplained concepts?
2. **Clarity** — Is the writing clear and unambiguous? Are complex concepts explained well? Is jargon defined?
3. **Structure** — Is the article well-organized with logical headings, sections, and flow? Is information easy to find?
4. **Accuracy** — Does the content appear technically correct? Are there outdated references, contradictions, or unsupported claims?
5. **Readability** — Is the text easy to read? Are sentences concise? Is formatting (lists, code blocks, tables) used effectively?

Format your response as follows:

## Overall Quality Score: [SCORE]/100

## Completeness: [SCORE]/100
[1-3 bullet points with specific suggestions]

## Clarity: [SCORE]/100
[1-3 bullet points with specific suggestions]

## Structure: [SCORE]/100
[1-3 bullet points with specific suggestions]

## Accuracy: [SCORE]/100
[1-3 bullet points with specific suggestions]

## Readability: [SCORE]/100
[1-3 bullet points with specific suggestions]

## Summary
[2-3 sentences summarizing the overall quality and the highest-priority improvements]

Be constructive and specific. Reference actual content from the article in your suggestions. ${LANGUAGE_PRESERVATION_INSTRUCTION}`,
} as const;

export type SystemPromptKey = keyof typeof SYSTEM_PROMPTS;

export function getSystemPrompt(key: SystemPromptKey): string {
  return SYSTEM_PROMPTS[key];
}

// ─── Delegated functions (backward-compatible API) ──────────────────────────

export async function listModels(): Promise<LlmModel[]> {
  return getActiveProvider().listModels();
}

export async function checkHealth(): Promise<OllamaHealthResult> {
  return getActiveProvider().checkHealth();
}

export function streamChat(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  return getActiveProvider().streamChat(model, messages, signal);
}

export async function chat(model: string, messages: ChatMessage[]): Promise<string> {
  return getActiveProvider().chat(model, messages);
}

export async function generateEmbedding(text: string | string[]): Promise<number[][]> {
  return getActiveProvider().generateEmbedding(text);
}

// ─── High-level helpers (use the active provider under the hood) ────────────

export function improveContent(
  model: string,
  content: string,
  type: 'grammar' | 'structure' | 'clarity' | 'technical' | 'completeness',
  signal?: AbortSignal,
  instruction?: string,
): AsyncGenerator<StreamChunk> {
  const { sanitized } = sanitizeLlmInput(content);
  let systemPrompt = getSystemPrompt(`improve_${type}` as SystemPromptKey);
  if (instruction) {
    systemPrompt += `\n\nADDITIONAL USER INSTRUCTIONS:\n${instruction}`;
  }
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

export function analyzeQualityContent(
  model: string,
  content: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const { sanitized } = sanitizeLlmInput(content);
  const systemPrompt = getSystemPrompt('analyze_quality');
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

/** @deprecated Access the Ollama client directly via OllamaProvider. */
export const ollama = (providers.ollama as OllamaProvider).client;
