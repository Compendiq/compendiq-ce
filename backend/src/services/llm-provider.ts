/**
 * LLM Provider abstraction layer.
 *
 * Defines a common interface for LLM backends (Ollama, OpenAI-compatible APIs)
 * so the rest of the application can work with any provider transparently.
 */

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

export interface HealthResult {
  connected: boolean;
  error?: string;
}

/**
 * Common interface that all LLM providers must implement.
 */
export interface LlmProvider {
  readonly name: string;

  /** Check connectivity to the LLM backend. */
  checkHealth(): Promise<HealthResult>;

  /** List available models. */
  listModels(): Promise<LlmModel[]>;

  /** Stream a chat completion, yielding chunks as they arrive. */
  streamChat(
    model: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk>;

  /** Non-streaming chat completion. */
  chat(model: string, messages: ChatMessage[]): Promise<string>;

  /** Generate embeddings for one or more texts. */
  generateEmbedding(text: string | string[]): Promise<number[][]>;
}

export type LlmProviderType = 'ollama' | 'openai';
