# German image-bearing eval corpus (#1115 P5a)

65 German Wikipedia articles carrying 187 vendored images
(6.19 MB), built by `tools/eval-corpus-images/build.py`.

| Shape | Pages | What it is |
|---|---|---|
| `technical` | 16 | engineering diagrams and schematics |
| `science` | 16 | labelled scientific figures |
| `process` | 17 | process, lifecycle and network notation |
| `photo` | 16 | photographs of things and places |

## What it is for

#1115 adds an image retrieval leg beside the text one. Measuring it needs pages
where the picture carries information the prose does not — which is the ordinary
shape of a Confluence page, where somebody pastes a diagram and writes around it
rather than describing it.

So **the page bodies carry no captions and no alt text.** Every image is
`![](images/…)`, empty alt, and the caption the article had is in
`MANIFEST.json` instead. That is not tidiness: a page that captions its own
figures is answerable from text alone, and an image leg measured on it would
score a win it did not earn. The captions still have to exist somewhere for the
independent labeller (P5c) to write `expectedImages[]` against, and the manifest
is where they live.

## It is NOT wired into the eval runner

This directory is deliberately absent from `CORPUS_DIRS` and from
`corpusDirsForLanguage`. `computeCorpusManifestSha` hashes every directory in
that list, so joining it would invalidate every recorded baseline the moment
these bytes landed. **P5b** adds the `--images` axis and wires it in on purpose.
`corpus-de-images.test.ts` fails if it happens by accident first.

There is also no fixture here. Labels are **P5c**, written by an independent
vision-capable agent on a different model from the implementer and blind to the
retrieval code — the #1102 amendment. A corpus labelled by whoever is tuning the
thing it scores measures the tuning.

## Licensing

Third-party content, licensed separately from this repository's **AGPL-3.0**
(root `LICENSE`), and a test fixture rather than product content. Page text is
CC BY-SA 4.0 (adapted); images carry their own licences. Obligations, per page
and per image, are in `LICENSE-ATTRIBUTION.md`.

## Rebuilding

```bash
cd tools/eval-corpus-images
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python build.py            # reproduces THIS corpus, at the pinned revisions
.venv/bin/python build.py --update   # moves to current revisions — obliges a re-label
```

A plain run reads the `revid` of every page back out of `MANIFEST.json`, so it
rebuilds the committed text rather than tracking whatever the articles say
today. The images are pinned by a second mechanism, because Commons serves the
current version of a file and an upstream re-draw would otherwise change a
"pinned" rebuild silently: each image records the upstream `sha1`, and a run
that finds one moved names the file and exits non-zero. Nothing here may be
hand-edited — the builder regenerates the whole directory into a staging
sibling and swaps it in only on success, and `corpus-de-images.test.ts` fails
on a manifest that has drifted from the files beside it.

## What the licence filter rejected on this build

The articles carry **1073** captioned figures between them. A page
contributes at most 3, so the filter ran on **206**
of them and refused **19**. The larger number is not the
filter's denominator and is not quoted as one.

| Reason | Figures |
|---|---|
| no named author | 12 |
| licence not permitted | 4 |
| not hosted on Commons | 3 |
