import { describe, it, expect } from 'vitest';
import { sanitizeLlmOutput } from './sanitize-llm-output.js';
import type { OutputRules } from './sanitize-llm-output.js';

const RULES_STRIP: OutputRules = { stripReferences: true, referenceAction: 'strip' };
const RULES_FLAG: OutputRules = { stripReferences: true, referenceAction: 'flag' };
const RULES_OFF: OutputRules = { stripReferences: true, referenceAction: 'off' };
const RULES_DISABLED: OutputRules = { stripReferences: false, referenceAction: 'flag' };

describe('sanitizeLlmOutput', () => {
  // ── Pass-through cases ─────────────────────────────────────────────────────

  it('passes through when stripReferences is false', () => {
    const content = '# Article\nSome content\n\n## References\n- [Fake](https://fake.com)';
    const result = sanitizeLlmOutput(content, RULES_DISABLED);
    expect(result.wasModified).toBe(false);
    expect(result.content).toBe(content);
  });

  it('passes through when referenceAction is off', () => {
    const content = '# Article\n\n## References\n- [Fake](https://fake.com)';
    const result = sanitizeLlmOutput(content, RULES_OFF);
    expect(result.wasModified).toBe(false);
    expect(result.content).toBe(content);
  });

  it('passes through when no reference section is found', () => {
    const content = '# Good Article\nSome technical content\n\n## Conclusion\nThis is the end.';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(false);
    expect(result.content).toBe(content);
  });

  it('passes through empty content', () => {
    const result = sanitizeLlmOutput('', RULES_STRIP);
    expect(result.wasModified).toBe(false);
    expect(result.content).toBe('');
  });

  // ── ATX heading detection ──────────────────────────────────────────────────

  it('detects ## References (ATX h2)', () => {
    const content = '# Article\nContent\n\n## References\n- [Fake](https://fake.com)';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['References']);
    expect(result.content).not.toContain('References');
    expect(result.content).toContain('Content');
  });

  it('detects ### Sources (ATX h3)', () => {
    const content = '# Article\nContent\n\n### Sources\n1. https://example.com';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['Sources']);
  });

  it('detects # Bibliography (ATX h1)', () => {
    const content = 'Content\n\n# Bibliography\n- Book 1\n- Book 2';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['Bibliography']);
  });

  it('detects #### Works Cited (ATX h4)', () => {
    const content = 'Content\n\n#### Works Cited\n- Author (2024)';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['Works Cited']);
  });

  it('detects ## Further Reading', () => {
    const content = 'Content here\n\n## Further Reading\n- Read more at https://example.com';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['Further Reading']);
  });

  // ── Setext heading detection ───────────────────────────────────────────────

  it('detects setext-style References heading with ===', () => {
    const content = 'Content\n\nReferences\n=========\n- [Fake](https://fake.com)';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
  });

  it('detects setext-style Sources heading with ---', () => {
    const content = 'Content\n\nSources\n-------\n- https://fake.com';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
  });

  // ── Bold-colon detection ───────────────────────────────────────────────────

  it('detects **References:** format', () => {
    const content = 'Content\n\n**References:**\n- [Fake](https://fake.com)';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
  });

  it('detects **Sources** format (no colon)', () => {
    const content = 'Content\n\n**Sources**\n- https://fake.com';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
  });

  // ── Case insensitive ──────────────────────────────────────────────────────

  it('matches case-insensitively (## REFERENCES)', () => {
    const content = 'Content\n\n## REFERENCES\n- https://fake.com';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
  });

  it('matches case-insensitively (## references)', () => {
    const content = 'Content\n\n## references\n- https://fake.com';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
  });

  // ── Strip action ──────────────────────────────────────────────────────────

  it('strip action removes the section entirely', () => {
    const content = '# Article\nGood content here.\n\n## References\n1. https://fake1.com\n2. https://fake2.com';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
    expect(result.content).toBe('# Article\nGood content here.');
    expect(result.disclaimer).toBeNull();
    expect(result.strippedSections).toEqual(['References']);
  });

  // ── Flag action ───────────────────────────────────────────────────────────

  it('flag action prepends disclaimer to the section', () => {
    const content = '# Article\nContent\n\n## References\n- https://fake.com';
    const result = sanitizeLlmOutput(content, RULES_FLAG);
    expect(result.wasModified).toBe(true);
    expect(result.content).toContain('**Note**');
    expect(result.content).toContain('have not been verified');
    expect(result.content).toContain('## References');
    expect(result.disclaimer).not.toBeNull();
  });

  // ── Verified sources ──────────────────────────────────────────────────────

  it('preserves references section when all URLs are verified', () => {
    const content = '# Article\nContent\n\n## References\n- https://docs.python.org/3/library\n- https://fastify.dev/docs';
    const rules: OutputRules = {
      ...RULES_STRIP,
      verifiedSources: ['https://docs.python.org/3/library', 'https://fastify.dev/docs'],
    };
    const result = sanitizeLlmOutput(content, rules);
    expect(result.wasModified).toBe(false);
    expect(result.content).toBe(content);
  });

  it('strips references when some URLs are not verified', () => {
    const content = '# Article\n\n## References\n- https://verified.com/docs\n- https://fake-hallucinated.com/paper';
    const rules: OutputRules = {
      ...RULES_STRIP,
      verifiedSources: ['https://verified.com/docs'],
    };
    const result = sanitizeLlmOutput(content, rules);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['References']);
  });

  it('verified source matching is case-insensitive', () => {
    const content = '# Article\n\n## References\n- https://DOCS.Python.ORG/guide';
    const rules: OutputRules = {
      ...RULES_STRIP,
      verifiedSources: ['https://docs.python.org/guide'],
    };
    const result = sanitizeLlmOutput(content, rules);
    expect(result.wasModified).toBe(false);
  });

  it('strips references with no URLs (no way to verify)', () => {
    const content = '# Article\n\n## References\n- Smith, J. (2024). AI Safety. Publisher.';
    const result = sanitizeLlmOutput(content, RULES_STRIP);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['References']);
  });
});

// ── Swiss spelling (#705) ────────────────────────────────────────────────────

describe('sanitizeLlmOutput — Swiss spelling (#705)', () => {
  // Swiss spelling combined with reference detection disabled, so only the
  // ß→ss transform is exercised in isolation.
  const RULES_SWISS_ONLY: OutputRules = {
    stripReferences: false,
    referenceAction: 'flag',
    swissSpelling: true,
  };
  const RULES_NO_SWISS: OutputRules = {
    stripReferences: false,
    referenceAction: 'flag',
    swissSpelling: false,
  };

  it('replaces lowercase ß with ss', () => {
    const result = sanitizeLlmOutput('Die Straße ist groß.', RULES_SWISS_ONLY);
    expect(result.content).toBe('Die Strasse ist gross.');
    expect(result.wasModified).toBe(true);
  });

  it('replaces capital ẞ (U+1E9E) with SS', () => {
    const result = sanitizeLlmOutput('STRAẞE', RULES_SWISS_ONLY);
    expect(result.content).toBe('STRASSE');
    expect(result.wasModified).toBe(true);
  });

  it('replaces every occurrence, not just the first', () => {
    const result = sanitizeLlmOutput('Maß, Fuß, Spaß', RULES_SWISS_ONLY);
    expect(result.content).toBe('Mass, Fuss, Spass');
    expect(result.content).not.toContain('ß');
  });

  it('leaves output with no eszett unchanged and unmodified', () => {
    const content = 'Plain ASCII content with no special characters.';
    const result = sanitizeLlmOutput(content, RULES_SWISS_ONLY);
    expect(result.content).toBe(content);
    expect(result.wasModified).toBe(false);
  });

  it('does not touch ß when swissSpelling is off (default behaviour)', () => {
    const content = 'Die Straße ist groß.';
    const result = sanitizeLlmOutput(content, RULES_NO_SWISS);
    expect(result.content).toBe(content);
    expect(result.wasModified).toBe(false);
  });

  it('also normalizes ß inside fenced code blocks (blanket replace)', () => {
    const content = 'Run:\n```\nconst gruß = "groß";\n```';
    const result = sanitizeLlmOutput(content, RULES_SWISS_ONLY);
    expect(result.content).toBe('Run:\n```\nconst gruss = "gross";\n```');
    expect(result.content).not.toContain('ß');
  });

  it('applies Swiss spelling AND strips references in the same pass', () => {
    const content = '# Artikel\nGroße Straße.\n\n## References\n- https://fake.com';
    const rules: OutputRules = { stripReferences: true, referenceAction: 'strip', swissSpelling: true };
    const result = sanitizeLlmOutput(content, rules);
    expect(result.wasModified).toBe(true);
    expect(result.strippedSections).toEqual(['References']);
    expect(result.content).toBe('# Artikel\nGrosse Strasse.');
    expect(result.content).not.toContain('ß');
  });

  it('applies Swiss spelling to flagged content including the kept reference section', () => {
    const content = '# Artikel\nGroße Straße.\n\n## References\n- https://fake.com';
    const rules: OutputRules = { stripReferences: true, referenceAction: 'flag', swissSpelling: true };
    const result = sanitizeLlmOutput(content, rules);
    expect(result.wasModified).toBe(true);
    expect(result.content).toContain('Grosse Strasse.');
    expect(result.content).toContain('## References');
    expect(result.content).not.toContain('ß');
  });

  it('reports wasModified=true even when only Swiss spelling changes content', () => {
    // No reference section present, so the reference pass is a no-op; the
    // modification flag must still reflect the ß→ss substitution.
    const result = sanitizeLlmOutput('groß', RULES_SWISS_ONLY);
    expect(result.wasModified).toBe(true);
    expect(result.content).toBe('gross');
  });
});
