export type SpellLang = 'en_US' | 'de_DE';

/** A token is a misspelling only if every enabled installed dictionary rejects it. */
export function isMisspelling(word: string, acceptors: Array<(token: string) => boolean>): boolean {
  if (acceptors.length === 0) return false;
  const token = word.replace(/^['"]+|['"]+$/g, '');
  if (!token || !/[\p{L}]/u.test(token)) return false;
  return acceptors.every((accepts) => !accepts(token));
}

export function tokenize(text: string): Array<{ word: string; from: number; to: number }> {
  const tokens: Array<{ word: string; from: number; to: number }> = [];
  const re = /[\p{L}][\p{L}'-]*/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ word: match[0], from: match.index, to: match.index + match[0].length });
  }
  return tokens;
}
