# eval-corpus-images — build the German image-bearing eval corpus (#1115 P5a)

Builds `backend/src/domains/llm/eval/corpus-de-images/` from German Wikipedia:
one Markdown page per article, the images it references, a manifest, an
attribution file and a README.

Python rather than TypeScript, and the one place in this repo that is: the job
is image re-encoding, and Pillow does in four lines what the backend
deliberately has no dependency for. `core/services/image-validator.ts` is
dependency-free on purpose (`sharp` and `image-size` were both refused as
supply-chain additions for four header layouts), and the answer to that is not
to add a decoder to the product so a fixture can be built once a year.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/python build.py --probe    # usable figures per article; writes nothing
.venv/bin/python build.py            # rebuild at the PINNED revisions
.venv/bin/python build.py --update   # move to current revisions (obliges a re-label)
```

`--probe --articles some.yaml` runs the same selection over a candidate list
without touching `articles.yaml`; that is how the shipped list was pruned.
`--only` and `--articles` **require** `--probe` and the tool refuses them
without it: both subset the article list, and a subset written over the corpus
is a corpus of one page whose other 65 revision pins are gone — after which the
next plain run re-pins them at current revisions and every label written
against them is stale. The build also stages into
`corpus-de-images.staging/` and swaps it in only once every article has
succeeded, so a flaky network cannot leave a thinner corpus behind.

## What it does, and why each step is there

1. **Resolves each article to a revision id** and fetches *that revision's*
   rendered HTML (`action=parse&oldid=…`). The pin is the whole point: a
   re-run reproduces the committed bytes rather than tracking whatever the
   article says today. Pins are read back out of the corpus's own
   `MANIFEST.json` — **before** anything is written, which is a scar from
   `scripts/vendor-eval-corpus.ts`, whose first cut read it afterwards and left
   the checkout as dead code while three documents claimed reproducibility. An
   article that is not in the pins is built at the *current* revision and says
   so by name: absent and renamed-upstream look identical here, and absorbing
   the difference into a `.get` default is how a reproducible run quietly stops
   being one.

   The **images are pinned separately**, because a revision id says nothing
   about them: Commons serves the current version of a file, so an SVG re-drawn
   or a photograph re-cropped upstream changes a "pinned" rebuild with nothing
   to notice it. Each image records the upstream `sha1`; a run that finds one
   moved names the file and exits non-zero, having written the bytes anyway so
   the diff is inspectable.

2. **Strips captions and alt text from the page body.** The corpus mimics a
   Confluence page where the visual content is *not* restated in prose — that is
   the only shape on which an image retrieval leg can add anything over the text
   leg. A page that captions its own figures is answerable from text alone, so
   the measurement would flatter the feature. Captions are not discarded: they
   go into `MANIFEST.json` for the independent labeller (P5c).

3. **Filters licences.** CC0, public domain, CC BY x and CC BY-SA x only, each
   with a named author, each hosted on Commons. The filter rejects *by
   construction* — a licence id that does not match one of the three permitted
   shapes fails closed — so GFDL-only, NC, ND, fair use and unknown need no
   entry in a deny-list to be refused. An image with no `Artist` /
   `Attribution` is dropped, because the obligation is not satisfiable without
   a name and writing "unknown" into the notices file would be a claim rather
   than a record.

   Two halves of that rule are easy to get wrong, and the first cut got both.
   **`Credit` is not an author** — it is Commons' *Source* field, and reading
   it as one credited a PD photograph to "Eigenes Werk" ("own work"). And the
   **unknown-author templates are localised**: de.wikipedia renders them as
   "Autor/-in unbekannt Unknown author" and "Anonym Unknown author", which an
   equality test against `"unknown"` reads as a name. The match is anchored, so
   Commons' "No machine-readable author provided. *X* assumed…" — which does
   name someone — still passes.

   A credit longer than 400 characters is abbreviated on a **word boundary**
   and marked ` […]`. A flat character cap shipped `AxelScheithauer` as
   `AxelSch` and dropped a third contributor entirely, on a CC BY-SA image
   whose whole obligation is that credit.

4. **Re-encodes every image locally.** ≤ 512 px longest edge, aiming at 80 KB,
   refused above 120 KB. SVG figures arrive as Wikimedia's PNG thumbnail
   rendering, so no vector ever reaches the repository — a VL encoder needs
   raster, and SVG carries script/XXE risk that `sniffImageFormat` refuses
   anyway. The output is verified against the same magic-byte rules the product
   applies (`sniff_image_format` mirrors `core/services/image-validator.ts`).

5. **Writes the manifest, the attribution file and the corpus README**, all
   generated. Nothing in the output directory may be hand-edited: the builder
   rewrites it whole, and `corpus-de-images.test.ts` fails on a manifest that
   has drifted from the files beside it.

## Choices worth knowing before you change one

- **Selection order and page order are different things.** The ranking decides
  *which* figures a page contributes (a `photo` article prefers JPEG sources, a
  diagram article prefers SVG); the numbering follows document order. Without
  the ranking, `Kölner Dom` contributed a medieval illumination, a reliquary and
  a floor plan — three diagrams and no cathedral, on a page vendored to be a
  photograph.
- **Infobox figures are hoisted, not dropped.** The lead photograph of a
  building or an aircraft lives in the infobox, and the infobox is chrome. The
  figure is lifted to the top of the article before the box is removed.
- **`image/svg+xml` forces PNG output.** A colour-count heuristic alone sent a
  gradient-heavy membrane diagram to JPEG, whose ringing lands exactly on the
  thin strokes and small labels that make a schematic readable at 512 px.
- **File titles are percent-decoded.** MediaWiki writes hrefs encoded, so
  `Kölner Dom nachts 2013.jpg` arrives as `K%C3%B6lner…`; left encoded, the
  imageinfo lookup finds nothing and every umlaut-titled photograph silently
  leaves the corpus as "no imageinfo".
- **`requirements.txt` is pinned**, Pillow included: a different encoder major
  can change output bytes for identical input, which would turn "reproduce the
  pinned revisions" into a diff.
- **Two rejection denominators are reported, not one.** A page stops evaluating
  once it has its three images, so most captioned figures never reach the
  licence filter. Quoting refusals against every figure seen would describe a
  filter that ran on far more than it did.

## Manners

`build.py` sends a descriptive `User-Agent` with a contact URL, sleeps between
requests, honours `Retry-After` and backs off on 429/5xx. It runs once per
corpus refresh; there is nothing to gain from pushing the API.

## Licensing

The corpus this produces is **third-party content**, licensed separately from
this repository's **AGPL-3.0** (root `LICENSE`) — page text CC BY-SA 4.0
(adapted), images under their own licences. The obligations are written into
`backend/src/domains/llm/eval/corpus-de-images/LICENSE-ATTRIBUTION.md`, per page
and per image.
