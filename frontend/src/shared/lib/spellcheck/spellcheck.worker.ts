import { isMisspelling, tokenize, type SpellLang } from './spellcheck-engine';

type SpellRequest =
  | {
    id: string;
    type: 'load';
    langs: SpellLang[];
    dictionaries: Array<{ lang: SpellLang; aff: string; dic: string }>;
  }
  | { id: string; type: 'check'; chunks: Array<{ text: string; base: number }> }
  | { id: string; type: 'suggest'; word: string };

type SpellEvent =
  | { id: string; type: 'ready'; langs: SpellLang[] }
  | { id: string; type: 'misses'; ranges: Array<{ from: number; to: number; word: string }> }
  | { id: string; type: 'suggestions'; word: string; suggestions: string[] }
  | { id: string; type: 'error'; message: string };

const acceptors = new Map<SpellLang, (word: string) => boolean>();
const suggesters = new Map<SpellLang, (word: string) => string[]>();

function post(event: SpellEvent): void {
  self.postMessage(event);
}

let chain: Promise<void> = Promise.resolve();

async function handle(msg: SpellRequest): Promise<void> {
  if (msg.type === 'load') {
    acceptors.clear();
    suggesters.clear();
    const nspell = (await import('nspell')).default;
    for (const dict of msg.dictionaries) {
      const spell = nspell(dict.aff, dict.dic);
      acceptors.set(dict.lang, (word) => spell.correct(word));
      suggesters.set(dict.lang, (word) => spell.suggest(word).slice(0, 5));
    }
    post({ id: msg.id, type: 'ready', langs: [...acceptors.keys()] as SpellLang[] });
    return;
  }
  if (msg.type === 'check') {
    const checks = [...acceptors.values()];
    const ranges = msg.chunks.flatMap((chunk) => tokenize(chunk.text)
      .filter((token) => isMisspelling(token.word, checks))
      .map((token) => ({
        from: chunk.base + token.from,
        to: chunk.base + token.to,
        word: token.word,
      })));
    post({ id: msg.id, type: 'misses', ranges });
    return;
  }
  if (msg.type === 'suggest') {
    const lists = [...suggesters.values()].map((fn) => fn(msg.word));
    const merged = [...new Set(lists.flat())].slice(0, 5);
    post({ id: msg.id, type: 'suggestions', word: msg.word, suggestions: merged });
  }
}

self.onmessage = (event: MessageEvent<SpellRequest>) => {
  chain = chain.then(() => handle(event.data)).catch((err: unknown) => {
    const id = event.data?.id ?? 'error';
    post({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : 'spellcheck failed',
    });
  });
};
