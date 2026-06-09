import { logger } from './logger.js';

/**
 * Configurable blocklist patterns for prompt injection detection.
 * Each entry has a regex pattern and a human-readable description.
 *
 * All patterns carry the `g` flag so every occurrence is neutralized, not
 * just the first. Because `g`-flagged regexes are stateful via `lastIndex`,
 * these shared instances must only be used with lastIndex-safe operations:
 * `String.prototype.replace` (resets lastIndex when global) and
 * `String.prototype.search` (saves and restores lastIndex). Never call
 * `.test()` or `.exec()` on them.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // System prompt manipulation
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/gi, description: 'ignore previous instructions' },
  { pattern: /ignore\s+(all\s+)?above\s+instructions/gi, description: 'ignore above instructions' },
  { pattern: /disregard\s+(all\s+)?previous/gi, description: 'disregard previous' },
  { pattern: /forget\s+(all\s+)?(your\s+)?instructions/gi, description: 'forget instructions' },
  { pattern: /forget\s+everything\s+(above|before)/gi, description: 'forget everything above' },
  { pattern: /override\s+(your\s+)?(system\s+)?instructions/gi, description: 'override instructions' },

  // Role hijacking
  { pattern: /you\s+are\s+now\s+(a|an|my)\b/gi, description: 'role reassignment (you are now)' },
  { pattern: /act\s+as\s+(a|an|if\s+you\s+are)\b/gi, description: 'role reassignment (act as)' },
  { pattern: /pretend\s+(you\s+are|to\s+be)\b/gi, description: 'role reassignment (pretend)' },
  { pattern: /from\s+now\s+on,?\s+you\s+(are|will)\b/gi, description: 'role reassignment (from now on)' },

  // System/assistant prompt markers
  { pattern: /^system\s*:/gim, description: 'system prompt marker' },
  { pattern: /^assistant\s*:/gim, description: 'assistant prompt marker' },
  { pattern: /\[SYSTEM\]/gi, description: '[SYSTEM] tag' },
  { pattern: /\[INST\]/gi, description: '[INST] tag' },
  { pattern: /<<\s*SYS\s*>>/gi, description: '<<SYS>> tag' },
  { pattern: /<\|im_start\|>/gi, description: 'ChatML start tag' },
  { pattern: /<\|im_end\|>/gi, description: 'ChatML end tag' },

  // Prompt leaking
  { pattern: /repeat\s+(your\s+)?(system\s+)?(prompt|instructions)/gi, description: 'prompt leaking attempt' },
  { pattern: /show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions)/gi, description: 'prompt leaking attempt' },
  { pattern: /what\s+(are|were)\s+(your\s+)?(system\s+)?(prompt|instructions)/gi, description: 'prompt leaking attempt' },
  { pattern: /output\s+(your\s+)?(initial|system)\s+prompt/gi, description: 'prompt leaking attempt' },

  // Markdown/format injection for output manipulation
  { pattern: /```\s*(system|assistant)\b/gi, description: 'markdown code block injection' },

  // Delimiter injection
  { pattern: /---+\s*\n\s*(system|new\s+instructions)/gi, description: 'delimiter injection' },
];

interface SanitizeResult {
  sanitized: string;
  wasModified: boolean;
  warnings: string[];
}

/**
 * Sanitizes user input before sending to LLM.
 * Strips/flags suspicious prompt injection patterns.
 *
 * Returns the sanitized text and any warnings detected.
 */
export function sanitizeLlmInput(input: string): SanitizeResult {
  const warnings: string[] = [];
  let sanitized = input;

  // Check each pattern. A single global replace with a callback both detects
  // and removes every occurrence in one pass (replace resets lastIndex on
  // global regexes, so the shared pattern instances stay stateless).
  for (const { pattern, description } of INJECTION_PATTERNS) {
    let matched = false;
    sanitized = sanitized.replace(pattern, () => {
      matched = true;
      return '[FILTERED]';
    });
    if (matched) {
      warnings.push(`Detected prompt injection pattern: ${description}`);
    }
  }

  // Strip ChatML-like tags that could confuse model parsing
  let chatMlMatched = false;
  sanitized = sanitized.replace(/<\|[a-z_]+\|>/gi, () => {
    chatMlMatched = true;
    return '[FILTERED]';
  });
  if (chatMlMatched) {
    warnings.push('Detected ChatML-like tags');
  }

  // Log warnings if any injection attempts detected
  if (warnings.length > 0) {
    logger.warn(
      { warnings, inputLength: input.length },
      'Prompt injection attempt detected and sanitized',
    );
  }

  return {
    sanitized,
    wasModified: sanitized !== input,
    warnings,
  };
}

/**
 * Quick check if input contains suspicious patterns without modifying it.
 * Useful for logging/monitoring.
 *
 * Uses String.prototype.search instead of RegExp.prototype.test because the
 * shared patterns carry the `g` flag: `.test()` would advance `lastIndex`
 * and make subsequent calls start mid-string, whereas `search` always
 * matches from the start and restores `lastIndex` on exit.
 */
export function detectInjectionAttempt(input: string): boolean {
  return INJECTION_PATTERNS.some(({ pattern }) => input.search(pattern) !== -1);
}
