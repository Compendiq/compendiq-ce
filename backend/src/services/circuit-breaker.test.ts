import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  getOllamaCircuitBreakerStatus,
  getOpenaiCircuitBreakerStatus,
  ollamaBreakers,
  openaiBreakers,
} from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 1000,
    });
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      const status = breaker.getStatus();
      expect(status.state).toBe('CLOSED');
      expect(status.failureCount).toBe(0);
      expect(status.successCount).toBe(0);
      expect(status.lastFailureTime).toBeNull();
      expect(status.nextRetryTime).toBeNull();
    });
  });

  describe('CLOSED state', () => {
    it('should allow calls through when CLOSED', async () => {
      const result = await breaker.execute(async () => 'success');
      expect(result).toBe('success');
    });

    it('should stay CLOSED on isolated failures below threshold', async () => {
      // Fail once
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      expect(breaker.getStatus().state).toBe('CLOSED');
      expect(breaker.getStatus().failureCount).toBe(1);

      // Fail twice
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      expect(breaker.getStatus().state).toBe('CLOSED');
      expect(breaker.getStatus().failureCount).toBe(2);
    });

    it('should transition to OPEN after reaching failure threshold', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }
      expect(breaker.getStatus().state).toBe('OPEN');
      expect(breaker.getStatus().failureCount).toBe(3);
    });

    it('should reset failure count on success', async () => {
      // Two failures
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      expect(breaker.getStatus().failureCount).toBe(2);

      // One success resets
      await breaker.execute(async () => 'ok');
      expect(breaker.getStatus().failureCount).toBe(0);
    });
  });

  describe('OPEN state', () => {
    beforeEach(async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }
    });

    it('should reject calls immediately when OPEN', async () => {
      await expect(breaker.execute(async () => 'should not run')).rejects.toThrow(CircuitBreakerOpenError);
      await expect(breaker.execute(async () => 'should not run')).rejects.toThrow(
        'test: LLM server temporarily unavailable',
      );
    });

    it('should have a nextRetryTime when OPEN', () => {
      const status = breaker.getStatus();
      expect(status.state).toBe('OPEN');
      expect(status.nextRetryTime).not.toBeNull();
      expect(status.nextRetryTime! - Date.now()).toBeLessThanOrEqual(1000);
    });

    it('should transition to HALF_OPEN after timeout expires', async () => {
      // Fast-forward time
      vi.useFakeTimers();
      vi.advanceTimersByTime(1100);

      const status = breaker.getStatus();
      expect(status.state).toBe('HALF_OPEN');

      vi.useRealTimers();
    });
  });

  describe('HALF_OPEN state', () => {
    beforeEach(async () => {
      // Trip the breaker and wait for timeout
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }
      vi.useFakeTimers();
      vi.advanceTimersByTime(1100);
      breaker.getStatus(); // triggers transition
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should allow one request through in HALF_OPEN', async () => {
      vi.useRealTimers();
      const result = await breaker.execute(async () => 'probe-success');
      expect(result).toBe('probe-success');
    });

    it('should go back to OPEN on failure in HALF_OPEN', async () => {
      vi.useRealTimers();
      await expect(breaker.execute(async () => { throw new Error('probe-fail'); })).rejects.toThrow('probe-fail');
      expect(breaker.getStatus().state).toBe('OPEN');
    });

    it('should transition to CLOSED after successThreshold successes in HALF_OPEN', async () => {
      vi.useRealTimers();
      // Need 2 successes (successThreshold = 2)
      await breaker.execute(async () => 'success-1');
      expect(breaker.getStatus().state).toBe('HALF_OPEN');

      await breaker.execute(async () => 'success-2');
      expect(breaker.getStatus().state).toBe('CLOSED');
      expect(breaker.getStatus().failureCount).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset to initial CLOSED state', async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      }
      expect(breaker.getStatus().state).toBe('OPEN');

      breaker.reset();
      const status = breaker.getStatus();
      expect(status.state).toBe('CLOSED');
      expect(status.failureCount).toBe(0);
      expect(status.successCount).toBe(0);
      expect(status.lastFailureTime).toBeNull();
    });
  });

  describe('recordSuccess / recordFailure', () => {
    it('should allow manual success/failure recording', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStatus().failureCount).toBe(2);

      breaker.recordSuccess();
      expect(breaker.getStatus().failureCount).toBe(0);
    });
  });
});

describe('getOllamaCircuitBreakerStatus', () => {
  beforeEach(() => {
    ollamaBreakers.chat.reset();
    ollamaBreakers.embed.reset();
    ollamaBreakers.list.reset();
  });

  it('should return status for all three breakers', () => {
    const status = getOllamaCircuitBreakerStatus();
    expect(status).toHaveProperty('chat');
    expect(status).toHaveProperty('embed');
    expect(status).toHaveProperty('list');

    expect(status.chat.state).toBe('CLOSED');
    expect(status.embed.state).toBe('CLOSED');
    expect(status.list.state).toBe('CLOSED');
  });

  it('should reflect individual breaker states', async () => {
    // Trip the chat breaker
    for (let i = 0; i < 3; i++) {
      ollamaBreakers.chat.recordFailure();
    }

    const status = getOllamaCircuitBreakerStatus();
    expect(status.chat.state).toBe('OPEN');
    expect(status.embed.state).toBe('CLOSED');
    expect(status.list.state).toBe('CLOSED');
  });
});

describe('openaiBreakers (separate from ollamaBreakers)', () => {
  beforeEach(() => {
    ollamaBreakers.chat.reset();
    ollamaBreakers.embed.reset();
    ollamaBreakers.list.reset();
    openaiBreakers.chat.reset();
    openaiBreakers.embed.reset();
  });

  it('should have separate chat and embed breakers', () => {
    const status = getOpenaiCircuitBreakerStatus();
    expect(status).toHaveProperty('chat');
    expect(status).toHaveProperty('embed');
    expect(status.chat.state).toBe('CLOSED');
    expect(status.embed.state).toBe('CLOSED');
  });

  it('should be independent from ollama breakers -- tripping openai does not trip ollama', async () => {
    // Trip the openai chat breaker
    for (let i = 0; i < 3; i++) {
      openaiBreakers.chat.recordFailure();
    }

    // OpenAI chat should be OPEN
    expect(getOpenaiCircuitBreakerStatus().chat.state).toBe('OPEN');
    // Ollama chat should still be CLOSED
    expect(getOllamaCircuitBreakerStatus().chat.state).toBe('CLOSED');
  });

  it('should be independent from ollama breakers -- tripping ollama does not trip openai', async () => {
    // Trip the ollama embed breaker
    for (let i = 0; i < 3; i++) {
      ollamaBreakers.embed.recordFailure();
    }

    // Ollama embed should be OPEN
    expect(getOllamaCircuitBreakerStatus().embed.state).toBe('OPEN');
    // OpenAI embed should still be CLOSED
    expect(getOpenaiCircuitBreakerStatus().embed.state).toBe('CLOSED');
  });

  it('should have different names for openai breakers', () => {
    expect(openaiBreakers.chat.name).toBe('openai-chat');
    expect(openaiBreakers.embed.name).toBe('openai-embed');
    expect(ollamaBreakers.chat.name).toBe('ollama-chat');
    expect(ollamaBreakers.embed.name).toBe('ollama-embed');
  });
});
