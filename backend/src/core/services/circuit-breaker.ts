import { logger } from '../utils/logger.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number; // ms
}

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  nextRetryTime: number | null;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 30_000, // 30 seconds
};

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private readonly config: CircuitBreakerConfig;
  readonly name: string;

  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getStatus(): CircuitBreakerStatus {
    // Check if timeout has expired for OPEN state
    if (this.state === 'OPEN' && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.timeout) {
        this.transitionTo('HALF_OPEN');
      }
    }

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextRetryTime:
        this.state === 'OPEN' && this.lastFailureTime !== null
          ? this.lastFailureTime + this.config.timeout
          : null,
    };
  }

  /**
   * Execute a function through the circuit breaker.
   * When OPEN, throws immediately without calling fn.
   * When HALF_OPEN, allows one request through as a probe.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const status = this.getStatus(); // triggers timeout check

    if (status.state === 'OPEN') {
      throw new CircuitBreakerOpenError(
        `${this.name}: LLM server temporarily unavailable`,
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  recordSuccess(): void {
    this.onSuccess();
  }

  recordFailure(): void {
    this.onFailure();
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    logger.info({ breaker: this.name }, 'Circuit breaker reset');
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo('CLOSED');
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (this.state === 'CLOSED') {
      // Reset failure count on success
      this.failureCount = 0;
      this.successCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN');
      this.successCount = 0;
    } else if (this.state === 'CLOSED') {
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo('OPEN');
        this.successCount = 0;
      }
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'HALF_OPEN') {
      this.successCount = 0;
    }

    logger.info(
      { breaker: this.name, from: oldState, to: newState, failureCount: this.failureCount },
      'Circuit breaker state transition',
    );
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

// Embedding operations use a higher failure threshold (5 instead of 3)
// because transient network issues during bulk embedding should not
// trip the breaker as aggressively as interactive chat requests.
const EMBED_BREAKER_CONFIG: Partial<CircuitBreakerConfig> = {
  failureThreshold: 5,
};

// Per-method circuit breakers for Ollama
export const ollamaBreakers = {
  chat: new CircuitBreaker('ollama-chat'),
  embed: new CircuitBreaker('ollama-embed', EMBED_BREAKER_CONFIG),
  list: new CircuitBreaker('ollama-list'),
} as const;

// Separate per-method circuit breakers for OpenAI-compatible providers.
// These are independent from Ollama breakers so that an OpenAI outage
// does not block Ollama requests and vice versa.
export const openaiBreakers = {
  chat: new CircuitBreaker('openai-chat'),
  embed: new CircuitBreaker('openai-embed', EMBED_BREAKER_CONFIG),
  list: new CircuitBreaker('openai-list'),
} as const;

/**
 * Get aggregated status of all Ollama circuit breakers.
 */
export function getOllamaCircuitBreakerStatus(): Record<string, CircuitBreakerStatus> {
  return {
    chat: ollamaBreakers.chat.getStatus(),
    embed: ollamaBreakers.embed.getStatus(),
    list: ollamaBreakers.list.getStatus(),
  };
}

/**
 * Get aggregated status of all OpenAI circuit breakers.
 */
export function getOpenaiCircuitBreakerStatus(): Record<string, CircuitBreakerStatus> {
  return {
    chat: openaiBreakers.chat.getStatus(),
    embed: openaiBreakers.embed.getStatus(),
    list: openaiBreakers.list.getStatus(),
  };
}
