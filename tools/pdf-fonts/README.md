# pdf-fonts — the fonts article PDFs embed (#1729)

`prepare.py` rebuilds the article PDF fonts and SIL OFL 1.1 licences under
`backend/src/core/services/fonts/`. The backend build copies the whole directory
into `dist/`. No runtime downloads or system fonts are needed.

Python because fontTools is the reference TrueType compiler and no Node library
writes TrueType. Requires **Python 3.10 or newer**.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python prepare.py   # downloads, checks, rewrites the fonts, checks again
```

## Sources (pinned; `prepare.py` checks every SHA-256)

| File | Upstream | Version | Licence |
|---|---|---|---|
| `NotoSans-{Regular,Bold,Italic}.ttf` | [notofonts.github.io@4cf78353](https://github.com/notofonts/notofonts.github.io/tree/4cf78353cd1668040ba8efa13029cd910fcdf9e2/fonts/NotoSans/unhinted/ttf) `fonts/NotoSans/unhinted/ttf/` | 2.015 | `OFL-NotoSans.txt` (The Noto Project Authors) |
| `NotoSansMono-Regular.ttf` | same commit, `fonts/NotoSansMono/unhinted/ttf/` | 2.014 | `OFL-NotoSans.txt` |
| `NotoSansSC-Regular.ttf` | npm `@expo-google-fonts/noto-sans-sc@0.4.4`, `400Regular/NotoSansSC_400Regular.ttf` (Google Fonts static instance) | 2.004-H2 | `OFL-NotoSansCJK.txt` (Adobe) |
| `NotoSansKR-Regular.ttf` | npm `@expo-google-fonts/noto-sans-kr@0.4.4`, `400Regular/NotoSansKR_400Regular.ttf` | 2.004-H2 | `OFL-NotoSansCJK.txt` |
| `NotoSansArmenian-Regular.ttf` | notofonts.github.io@4cf78353, `fonts/NotoSansArmenian/unhinted/ttf/` | 2.008 | `OFL-NotoSansArmenian.txt` |
| `NotoSansGeorgian-Regular.ttf` | same commit, `fonts/NotoSansGeorgian/unhinted/ttf/` | 2.005 | `OFL-NotoSansGeorgian.txt` |
| `NotoSansSymbols-Regular.ttf` | same commit, `fonts/NotoSansSymbols/unhinted/ttf/` | 2.003 | `OFL-NotoSansSymbols.txt` |
| `NotoSansSymbols2-Regular.ttf` | same commit, `fonts/NotoSansSymbols2/unhinted/ttf/` | 2.008 | `OFL-NotoSansSymbols.txt` |

`OFL-NotoSans.txt` is `OFL.txt` of
[notofonts/latin-greek-cyrillic@4bc63d7e](https://github.com/notofonts/latin-greek-cyrillic/blob/4bc63d7ebca1faed49c6c685f380ba0abc2c1941/OFL.txt);
`OFL-NotoSansCJK.txt` is the SC package's `LICENSE_FONT` (the KR package's is
identical). Its Reserved Font Name "Source" is not used by these fonts' names.
The Armenian, Georgian and Symbols projects name The Noto Project Authors and
declare no Reserved Font Name. Both symbol families come from the same project
and carry the same notice. The generator pins each project's OFL file.

## What it changes, and why

The rewritten files are Modified Versions under the OFL; their outlines and
advance widths are unchanged (checked for every mapped code point).

1. **Every glyph record padded to an even length** (`glyf.padding = 2`).
   `@pdf-lib/fontkit` 1.1.1 — the fontkit pdf-lib uses — writes a short `loca`
   table for subsets under 64 KiB and halves the offsets without padding, so
   after the first odd-length record every glyph is read from the wrong byte
   (pdf-lib#1232). The upstream files have thousands of odd records; their
   subsets render broken or blank in Ghostscript, PDFium, MuPDF and Preview.
2. **The OpenType layout tables dropped** (`GSUB`, `GPOS`, `GDEF`). pdf-lib
   draws no positioning anyway, and substitutions would make a drawn line differ
   from its measured width (`1⁄2` draws 830 units with the fraction forms but
   measures 1,274 one code point at a time), which is what wrapping relies on.
   Parsing them also tripled the time per export.
3. **Every code point given a glyph of its own.** Noto Sans SC and KR draw some
   code points with one shared glyph: `〜` and `～`, a Kangxi radical and its
   ideograph (`⽇` and `日`), `①` and `➀`. pdf-lib's ToUnicode maps a glyph to
   the first character drawn with it, so the second of such a pair extracted,
   searched and copied as the first. Each code point but the lowest of a group
   now gets a composite of the shared glyph — same outline, same metrics —
   appended after the existing glyphs: 497 in SC, 723 in KR, 40 KB together.

For optional faces, `prepare.py` also emits `pdf-fallback-ranges.ts` from
the verified cmaps. Each range contains only code points not guaranteed by the
four text faces or claimed by an earlier optional face. Article export can thus
select a face without opening its file. The symbol faces supply Common,
Latin, Greek and Braille patterns, not Arabic-script Rumi numerals or inherited
combining marks that need shaping. The script data comes with pinned fontTools.
Invisible characters do not select a face; default emoji presentation is
excluded from the four additions (#2033), not from existing CJK coverage.
Selected fonts are subset per document.

Hinting is not added (the Noto Sans files are the unhinted builds): subsets stay
about half the size.

## Updating

Change a pin (URL and source SHA-256), run `prepare.py`, which then reports the
new output SHA-256: pin that too, and run the backend PDF tests
(`src/core/services/pdf-fonts.test.ts`, `pdf-service.test.ts`). Each update adds
about 10 MB to the repository.

## Browser analytics exports (#2032)

After checking the article outputs, `prepare.py` calls `analytics.publish`.
It copies Regular, Bold, SC, KR and both OFL notices byte-for-byte into
`frontend/public/fonts/pdf/`. It generates the lazy `analytics-font-coverage.json`
from their cmaps: inclusive range pairs plus each file's SHA-256, used to
version its immutable URL and reject unexpected content. No font is bundled in JS.

SC covers some non-CJK symbols neither sans style has (e.g. `✓ → ① Ⅷ`).
The pipeline subsets this residual so a symbol does not require a full CJK
download; if SC is needed in the same report, its original face serves both.
`fonttools==4.68.0` supplies the Unicode 18.0 Script_Extensions tables:
Han, Hiragana, Katakana and Hangul (including shared punctuation) stay in
the full faces. SC precedes KR; these pins leave no KR-only non-CJK residual.
The shard retains source outlines, advances, distinct cmap glyphs, even
offsets and the CJK OFL. `analytics.py` checks its output digest; review a
changed residual and its rendering before updating that pin.
