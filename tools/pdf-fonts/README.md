# pdf-fonts — the fonts article PDFs embed (#1729)

`prepare.py` rebuilds `backend/src/core/services/fonts/`: four Noto faces for
text and code, Noto Sans SC and Noto Sans KR for CJK and Hangul, and their SIL
OFL 1.1 licences. `core/services/pdf-fonts.ts` reads them; `npm run build -w
backend` copies them into `dist/`, so every image that ships the built backend
has them.

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

`OFL-NotoSans.txt` is `OFL.txt` of
[notofonts/latin-greek-cyrillic@4bc63d7e](https://github.com/notofonts/latin-greek-cyrillic/blob/4bc63d7ebca1faed49c6c685f380ba0abc2c1941/OFL.txt);
`OFL-NotoSansCJK.txt` is the SC package's `LICENSE_FONT` (the KR package's is
identical). Its Reserved Font Name "Source" is not used by these fonts' names.

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

Hinting is not added (the Noto Sans files are the unhinted builds): subsets stay
about half the size.

## Updating

Change a pin (URL and source SHA-256), run `prepare.py`, which then reports the
new output SHA-256: pin that too, and run the backend PDF tests
(`src/core/services/pdf-fonts.test.ts`, `pdf-service.test.ts`). Each update adds
about 10 MB to the repository.
