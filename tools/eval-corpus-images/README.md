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
is a corpus of one page whose every other revision pin is gone — after which the
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

   And a **third check covers what neither pin can**: whether a figure is still
   *usable*. Commons metadata is live, so a licence retagged, an author field
   blanked or a thumbnail that stopped rendering turns a 3-image page into a
   2-image one — or drops it below the two-image floor and out of the corpus —
   on a run advertising itself as a reproduction. So the build diffs its own
   inventory against the committed manifest and exits non-zero on anything it
   lost. The Vitest guard cannot see this: four category counts of 17 pass
   exactly as four counts of 18 do.

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

   Three halves of that rule are easy to get wrong, and earlier cuts got all
   three. **`Credit` is not an author** — it is Commons' *Source* field, and
   reading it as one credited a PD photograph to "Eigenes Werk" ("own work").
   The **unknown-author templates are localised**: de.wikipedia renders them as
   "Autor/-in unbekannt Unknown author" and "Anonym Unknown author", which an
   equality test against `"unknown"` reads as a name. The match is anchored, so
   Commons' "No machine-readable author provided. *X* assumed…" — which does
   name someone — still passes. And the templates are only the *tidy* spellings:
   `author=` is free text somebody typed, so `File:Magischesdreieck.gif` says
   `unbekant` and `File:Turbolader LKW.jpg` a bare `selbst`, both of which
   shipped into the notices file as names while the corpus README published a
   "no named author" count as if the filter had caught them.

   A credit longer than 400 characters is abbreviated on a **word boundary**
   and marked ` […]`. A flat character cap shipped `AxelScheithauer` as
   `AxelSch` and dropped a third contributor entirely, on a CC BY-SA image
   whose whole obligation is that credit.

   **`Artist` is not the whole obligation either.** Where Commons records an
   `Attribution` with `AttributionRequired`, that string is the credit line the
   licensor *specified* — CC BY-SA 4.0 §3(a)(1)(A)(i) obliges attribution "in
   any reasonable manner requested by the Licensor", §3(a)(1)(B) the retention
   of a supplied copyright notice — and it is regularly not the bare name in
   `Artist`: `Bundesarchiv, Bild 183-85770-0002 / Junge, Peter Heinz /
   CC-BY-SA 3.0`, `© Raimond Spekking / CC BY-SA 4.0 (via Wikimedia Commons)`,
   `Copyright (c) 2004 Richard Ling`. It is recorded as `requiredCredit` and
   printed verbatim in its own notices column. It does **not** replace `author`,
   because `Artist` is regularly the fuller of the two — `Madprime (original)
   Woudloper (rotated image)` against a credit line of `I, Madprime` — so
   preferring either one alone loses something.

   All of it goes through one text extractor, and that is not cosmetic:
   `get_text(" ")` inserts a separator at every inline boundary, which turned
   the photographer credit `Thomas Wolf, www.foto-tw.de` into `Thomas Wolf ,
   www.foto-tw.de` — one character off the string this file exists to reproduce
   exactly.

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
  pinned revisions" into a diff. Two *transitive* packages are pinned for the
  same reason — `soupsieve`, the selector engine behind every `select()` here
  (the drop sweep, the figure hoist, the figure collection), and `six`, which
  markdownify carries. The rest are requests' network plumbing and are left
  floating on purpose: pinning `certifi` freezes a CA bundle, and a build tool
  that stops trusting Wikimedia's certificate is a worse failure than a
  floating transitive.
- **Two rejection denominators are reported, not one.** A page stops evaluating
  once it has its three images, so most captioned figures never reach the
  licence filter. Quoting refusals against every figure seen would describe a
  filter that ran on far more than it did.

## Manners

`build.py` sends a descriptive `User-Agent` with a contact URL, sleeps between
requests, honours `Retry-After` and backs off on 429/5xx. It runs once per
corpus refresh; there is nothing to gain from pushing the API.

`Retry-After` is parsed in **both** its forms. RFC 9110 permits an HTTP-date,
and `float("Wed, 21 Oct 2015 07:28:00 GMT")` raises — which escaped the retry
loop, was caught as an article failure and refused the swap, so the one path
written for "we are being rate-limited" was the path that killed the build. A
transport error (`ConnectionError`, `ReadTimeout`) takes the same back-off as a
5xx for the same reason: a full build is ~600 requests over ten minutes of
network, and a single reset otherwise costs the whole run.

## Licensing

The corpus this produces is **third-party content**, licensed separately from
this repository's **AGPL-3.0** (root `LICENSE`) — page text CC BY-SA 4.0
(adapted), images under their own licences. The obligations are written into
`backend/src/domains/llm/eval/corpus-de-images/LICENSE-ATTRIBUTION.md`, per page
and per image.
