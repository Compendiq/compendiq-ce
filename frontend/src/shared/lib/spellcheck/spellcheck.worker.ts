import { isMisspelling, tokenize, type SpellLang } from './spellcheck-engine';

type SpellRequest =
  | { id: string; type: 'load'; langs: SpellLang[]; origin: string }
  | { id: string; type: 'check'; text: string; base: number }
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

async function loadDict(lang: SpellLang, origin: string): Promise<void> {
  const id = lang === 'en_US' ? 'hunspell-en_US' : 'hunspell-de_DE';
  const prefix = lang === 'en_US' ? 'en_US' : 'de_DE';
  const [affRes, dicRes] = await Promise.all([
    fetch(`${origin}/api/models/client-assets/${id}/${prefix}.aff`, { credentials: 'include' }),
    fetch(`${origin}/api/models/client-assets/${id}/${prefix}.dic`, { credentials: 'include' }),
  ]);
  if (!affRes.ok || !dicRes.ok) return;
  const nspell = (await import('nspell')).default;
  const spell = nspell(await affRes.text(), await dicRes.text());
  acceptors.set(lang, (word) => spell.correct(word));
  suggesters.set(lang, (word) => spell.suggest(word).slice(0, 5));
}

self.onmessage = (event: MessageEvent<SpellRequest>) => {
  void (async () => {
    const msg = event.data;
    try {
      if (msg.type === 'load') {
        acceptors.clear();
        suggesters.clear();
        for (const lang of msg.langs) {
          await loadDict(lang, msg.origin);
        }
        post({ id: msg.id, type: 'ready', langs: [...acceptors.keys()] as SpellLang[] });
        return;
      }
      if (msg.type === 'check') {
        const checks = [...acceptors.values()];
        const ranges = tokenize(msg.text)
          .filter((token) => isMisspelling(token.word, checks))
          .map((token) => ({
            from: msg.base + token.from,
            to: msg.base + token.to,
            word: token.word,
          }));
        post({ id: msg.id, type: 'misses', ranges });
        return;
      }
      if (msg.type === 'suggest') {
        const lists = [...suggesters.values()].map((fn) => fn(msg.word));
        const merged = [...new Set(lists.flat())].slice(0, 5);
        post({ id: msg.id, type: 'suggestions', word: msg.word, suggestions: merged });
      }
    } catch (err) {
      post({
        id: msg.id,
        type: 'error',
        message: err instanceof Error ? err.message : 'spellcheck failed',
      });
    }
  })();
};
