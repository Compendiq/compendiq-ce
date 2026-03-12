import { describe, it, expect } from 'vitest';
import { parseQualityScores } from './quality-worker.js';

describe('parseQualityScores', () => {
  it('parses a complete well-formed quality report', () => {
    const text = `
## Overall Quality Score: 75/100

## Completeness: 80/100
- Missing a troubleshooting section
- Could add more examples

## Clarity: 70/100
- Some jargon is undefined
- Complex sentences in section 3

## Structure: 78/100
- Good heading hierarchy
- Missing table of contents

## Accuracy: 72/100
- Some outdated API references

## Readability: 68/100
- Long paragraphs in introduction
- Code blocks lack syntax highlighting

## Summary
This article covers the basics well but needs work on clarity and readability. The main areas for improvement are defining technical jargon and breaking up long paragraphs.
`;

    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(75);
    expect(result!.completeness).toBe(80);
    expect(result!.clarity).toBe(70);
    expect(result!.structure).toBe(78);
    expect(result!.accuracy).toBe(72);
    expect(result!.readability).toBe(68);
    expect(result!.summary).toContain('covers the basics well');
  });

  it('returns null when overall score is missing', () => {
    const text = `
## Completeness: 80/100
## Clarity: 70/100
## Structure: 78/100
## Accuracy: 72/100
## Readability: 68/100
## Summary
Some text.
`;
    expect(parseQualityScores(text)).toBeNull();
  });

  it('returns null when a dimension score is missing', () => {
    const text = `
## Overall Quality Score: 75/100
## Completeness: 80/100
## Clarity: 70/100
## Structure: 78/100
## Readability: 68/100
## Summary
Missing accuracy dimension.
`;
    expect(parseQualityScores(text)).toBeNull();
  });

  it('clamps scores above 100 to 100', () => {
    const text = `
## Overall Quality Score: 150/100
## Completeness: 120/100
## Clarity: 200/100
## Structure: 0/100
## Accuracy: 100/100
## Readability: 50/100
## Summary
Edge case scores.
`;
    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(100);
    expect(result!.completeness).toBe(100);
    expect(result!.clarity).toBe(100);
    expect(result!.structure).toBe(0);
    expect(result!.accuracy).toBe(100);
    expect(result!.readability).toBe(50);
  });

  it('returns null when score contains negative number (invalid format)', () => {
    const text = `
## Overall Quality Score: 75/100
## Completeness: -10/100
## Clarity: 70/100
## Structure: 60/100
## Accuracy: 65/100
## Readability: 55/100
## Summary
Negative score.
`;
    // -10 won't match the \\d+ regex, so parsing fails
    expect(parseQualityScores(text)).toBeNull();
  });

  it('handles scores with varied whitespace', () => {
    const text = `
##  Overall Quality Score:  82 / 100

## Completeness:  85 / 100
- Good coverage

## Clarity:  79 / 100
- Clear writing

## Structure:  90 / 100
- Well organized

## Accuracy:  75 / 100
- Mostly accurate

## Readability:  80 / 100
- Easy to read

## Summary
Well-written article with solid structure.
`;
    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(82);
    expect(result!.completeness).toBe(85);
  });

  it('handles empty summary gracefully', () => {
    const text = `
## Overall Quality Score: 60/100
## Completeness: 55/100
## Clarity: 65/100
## Structure: 60/100
## Accuracy: 58/100
## Readability: 62/100
## Summary
`;
    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('');
  });

  it('returns null for completely empty input', () => {
    expect(parseQualityScores('')).toBeNull();
  });

  it('returns null for malformed output', () => {
    expect(parseQualityScores('This is just plain text with no structure.')).toBeNull();
  });
});
