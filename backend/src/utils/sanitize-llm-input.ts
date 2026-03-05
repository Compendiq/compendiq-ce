import { logger } from './logger.js';

/**
 * Configurable blocklist patterns for prompt injection detection.
 * Each entry has a regex pattern and a human-readable description.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // System prompt manipulation
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, description: 'ignore previous instructions' },
  { pattern: /ignore\s+(all\s+)?above\s+instructions/i, description: 'ignore above instructions' },
  { pattern: /disregard\s+(all\s+)?previous/i, description: 'disregard previous' },
  { pattern: /forget\s+(all\s+)?(your\s+)?instructions/i, description: 'forget instructions' },
  { pattern: /forget\s+everything\s+(above|before)/i, description: 'forget everything above' },
  { pattern: /override\s+(your\s+)?(system\s+)?instructions/i, description: 'override instructions' },

  // Role hijacking
  { pattern: /you\s+are\s+now\s+(a|an|my)\b/i, description: 'role reassignment (you are now)' },
  { pattern: /act\s+as\s+(a|an|if\s+you\s+are)\b/i, description: 'role reassignment (act as)' },
  { pattern: /pretend\s+(you\s+are|to\s+be)\b/i, description: 'role reassignment (pretend)' },
  { pattern: /from\s+now\s+on,?\s+you\s+(are|will)\b/i, description: 'role reassignment (from now on)' },

  // System/assistant prompt markers
  { pattern: /^system\s*:/im, description: 'system prompt marker' },
  { pattern: /^assistant\s*:/im, description: 'assistant prompt marker' },
  { pattern: /\[SYSTEM\]/i, description: '[SYSTEM] tag' },
  { pattern: /\[INST\]/i, description: '[INST] tag' },
  { pattern: /<<\s*SYS\s*>>/i, description: '<<SYS>> tag' },
  { pattern: /<\|im_start\|>/i, description: 'ChatML start tag' },
  { pattern: /<\|im_end\|>/i, description: 'ChatML end tag' },

  // Prompt leaking
  { pattern: /repeat\s+(your\s+)?(system\s+)?(prompt|instructions)/i, description: 'prompt leaking attempt' },
  { pattern: /show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions)/i, description: 'prompt leaking attempt' },
  { pattern: /what\s+(are|were)\s+(your\s+)?(system\s+)?(prompt|instructions)/i, description: 'prompt leaking attempt' },
  { pattern: /output\s+(your\s+)?(initial|system)\s+prompt/i, description: 'prompt leaking attempt' },

  // Markdown/format injection for output manipulation
  { pattern: /```\s*(system|assistant)\b/i, description: 'markdown code block injection' },

  // Delimiter injection
  { pattern: /---+\s*\n\s*(system|new\s+instructions)/i, description: 'delimiter injection' },
];

export interface SanitizeResult {
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

  // Check each pattern
  for (const { pattern, description } of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      warnings.push(`Detected prompt injection pattern: ${description}`);
      // Remove the matched pattern
      sanitized = sanitized.replace(pattern, '[FILTERED]');
    }
  }

  // Strip ChatML-like tags that could confuse model parsing
  const chatMlTagPattern = /<\|[a-z_]+\|>/gi;
  if (chatMlTagPattern.test(sanitized)) {
    warnings.push('Detected ChatML-like tags');
    sanitized = sanitized.replace(chatMlTagPattern, '[FILTERED]');
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
 */
export function detectInjectionAttempt(input: string): boolean {
  return INJECTION_PATTERNS.some(({ pattern }) => pattern.test(input));
}
