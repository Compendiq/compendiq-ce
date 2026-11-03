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

Requires **Python 3.11 or newer** (Pillow 13's minimum).

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/python build.py --probe    # UPPER BOUND on usable figures; writes nothing
.venv/bin/python build.py            # rebuild at the PINNED revisions
.venv/bin/python build.py --update   # move to current revisions (obliges a re-label)

.venv/bin/python -m unittest test_build   # text transforms and image drift, offline
```

`test_build.py` is stdlib `unittest` rather than pytest on purpose:
`requirements.txt` is the record of what the committed bytes were built with,
and a test runner nobody builds with does not belong in it. It runs from the
same venv because `build.py` imports Pillow and friends at module scope.

`--probe --articles some.yaml` runs the same selection over a candidate list
without touching `articles.yaml`; that is how the shipped list was pruned. Its
count is an **upper bound**, and the flag it prints says so: a probe returns
before the thumbnail fetch and the re-encode, so the two rejections that can
only be known by trying — `no thumbnail` and `cannot meet the byte cap` — have
not run. `ok?` marks an article sitting exactly on the two-figure floor, which
a full build can still drop.
`--only` and `--articles` **require** `--probe` and the tool refuses them
without it: both subset the article list, and a subset written over the corpus
is a corpus of one page whose every other revision pin is gone — after which the
next plain run re-pins them at current revisions and every label written
against them is stale. The build also stages into
`corpus-de-images.staging/` and swaps it in only once every article has
succeeded, so a flaky network cannot leave a thinner corpus behind.

## What it does, and why each step is there

1. **Resolves each article to a revision id** and fetches *that revision's*
   rendered HTML (`action=parse&oldid=…`). Pins are read back out of the
   corpus's own `MANIFEST.json` — **before** anything is written, which is a
   scar from `scripts/vendor-eval-corpus.ts`, whose first cut read it afterwards
   and left the checkout as dead code while three documents claimed
   reproducibility. An article that is not in the pins is built at the *current*
   revision and says so by name: absent and renamed-upstream look identical
   here, and absorbing the difference into a `.get` default is how a
   reproducible run quietly stops being one.

   **A revid does not pin the text**, and it is the easiest pin to over-claim —
   it is the thing the five checks sit on, not one of them: `textSha256`,
   the Commons `sha1`, encoded image SHA-256, the inventory diff and the
   image budget.
   `oldid` selects a *wikitext* revision, which MediaWiki then renders through
   the **current** template set and the current parser — so an upstream template
   edit or a MediaWiki release changes the prose of a page nobody edited. It has already happened to this builder once: 1.43 started
   wrapping `h2` in `<div class="mw-heading">`, which `cut_tail_sections`
   carries a branch for. So each page records a `textSha256` over the Markdown
   it produced, and a rebuild that renders different bytes names the page and
   exits non-zero. Without it a template edit lands silently on a run that
   prints its totals and exits 0, and P5c's labels are then written against text
   that has moved.

   The **images are pinned separately** for the same reason one rung along:
   Commons serves the current version of a file, so an SVG re-drawn or a
   photograph re-cropped upstream changes a "pinned" rebuild with nothing to
   notice it. Each image records the upstream `sha1`; a run that finds one moved
   names the file and exits non-zero, having written the bytes anyway so the
   diff is inspectable.

   The **encoded bytes need their own check**: Commons can render an unchanged
   SVG differently, and a Pillow upgrade can alter resampling or encoding.
   Before building, snapshot the committed image files' SHA-256 digests; compare
   the regenerated files against them after the swap. Changed bytes fail the
   run even when source sha1, dimensions, format and file size stay unchanged.

   And an **inventory check covers what digests cannot**: whether a figure is
   still *usable*. Commons metadata is live, so a licence retagged, an author
   field blanked or a thumbnail that stopped rendering turns a 3-image page into
   a 2-image one — or drops it below the two-image floor and out of the corpus —
   on a run advertising itself as a reproduction. So the build diffs its own
   inventory against the committed manifest and exits non-zero on anything it
   lost. The Vitest guard cannot see this: four category counts of 17 pass
   exactly as four counts of 18 do.

   The **fifth** is not about reproduction: the corpus has a total image
   budget, and a build over it exits non-zero. It is the only check
   `--update` does not skip — the four above are gated on a pinned run.

2. **Strips captions and alt text from the page body.** The corpus mimics a
   Confluence page where the visual content is *not* restated in prose — that is
   the only shape on which an image retrieval leg can add anything over the text
   leg. A page that captions its own figures is answerable from text alone, so
   the measurement would flatter the feature. Captions are not discarded: they
   go into `MANIFEST.json` for the independent labeller (P5c).

   **The captions of DROPPED figures are the half that got away.** Only 187 of
   1073 captioned figures are vendored, and a caption whose figure was never
   selected has no manifest entry — so the Vitest guard, which compares the body
   against the manifest, is structurally unable to see it. Three markup shapes
   put one into the prose: a panorama, which is a bare `<div>` around a
   `.thumbinner` with no `.thumb` class anywhere (`nuerburgring.md` ran a whole
   section consisting of "Start-und-Ziel-Gerade und Boxengasse des
   Nürburgrings. (Der schnurgerade Streckenabschnitt erscheint auf dem Bild…)",
   about a picture not on the page); `.dewiki-gallery`, whose `-title` is a
   caption over its figures; and `.gallerytext` / `.gallerycaption` one rung
   down. The final sweep therefore decomposes every caption *container*, not
   only `figure, .thumb`. `u-bahn-muenchen.md` is the case that shows why it
   matters — it carried "U-Bahn-Linienschema München, Stand: Dezember 2018" as
   prose, which is the network diagram described in words.

   **A `--update` re-vendoring must re-read the page bodies for caption prose**,
   because neither automated check covers that run. The Vitest guard compares
   bodies against the 187 *manifest* captions, so a caption belonging to a figure
   the builder DROPPED has no entry to compare against — which is the whole class
   above, and it lands as ordinary prose carrying no marker. `text_drift` does
   close the loop on a plain rebuild by naming the page whose `textSha256` moved,
   but it is gated on `not args.update`, and `--update` is precisely the run that
   re-vendors. So on a `--update` the container sweep is the only thing standing
   between a caption template this builder has never met and the corpus: read the
   page diff, not only the counts, before committing.

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

## Controlled encoder refresh

Do not use a full `--update` to repair an encoder-only dependency bump: it
also accepts live Wikipedia text, Commons metadata and thumbnail-renderer
changes. Work in an isolated checkout and keep the old corpus as evidence.

1. Compare old and new encoders on identical fetched thumbnail inputs, using
   `fetch_thumbnail` with `build_page`'s aspect-ratio-aware request width and
   `downscale_and_encode(raw, mime)`.
   Verify each upstream `sha1` still matches the manifest. Before replacing an
   affected image, require the old encoder to reproduce its committed bytes;
   otherwise the input has drifted too and needs a separate corpus review.
2. Regenerate only dependency-affected images with the new pinned encoder.
   Serialize their generated size/format/dimension metadata into the manifest,
   preserving every unrelated field, page, caption, credit and image.
   Regenerate the corpus README with `write_readme`, retaining the original
   selection/rejection statistics: an encoder refresh did not rerun selection.
3. Inspect old and new images and revalidate all labels that reference them.
   Update `fixture-de-images.json`'s `corpusManifestSha` using
   `computeCorpusManifestSha([IMAGE_CORPUS_DIR])` only after that review.
   Preserve valid query IDs, wording and labeller attribution.
4. Run `test_build`, `corpus-de-images.test.ts` and `fixture-de-images.test.ts`,
   and reproduce the refreshed images again with the new encoder. Record the
   scope and provenance in this README. Do not rewrite historical eval reports;
   new image-axis runs require fresh, same-corpus baselines.

### Pillow 13 refresh — PR #1707 (2026-10-26)

Generated with Python 3.14.8 and Pillow 13.0.0 using the existing encoder.
For each affected source, Commons' sha1 matched the manifest and Pillow 12.3.0
reproduced the committed file from the same fetched thumbnail before replacement.
Only these outputs and their manifest byte counts changed:

| Image | Dimensions / requested width | Previous bytes | Pillow 13 bytes |
|---|---|---:|---:|
| `berliner-fernsehturm__1.jpg` | 185×512 / 185 | 18209 | 18204 |
| `ereignisgesteuerte-prozesskette__1.png` | 171×512 / 171 | 16073 | 15895 |
| `ereignisgesteuerte-prozesskette__2.png` | 232×512 / 232 | 20903 | 20817 |

Old/new visual inspection confirmed the tower/World Clock photograph and both
process diagrams retain the content referenced by `img-01-001`–`img-01-003`
and `img-02-019`–`img-02-022`. Those seven labels remain valid; all 309 label
texts, IDs and original labeller attribution are unchanged. The fixture's
manifest digest moved from `1d305046bdd0…` to `877e6dc92e0b…`.

The other 184 images, all 65 page bodies, source hashes, captions and credits
were preserved. Existing live-upstream drift was not accepted: a full network
rebuild may still fail its drift checks and must be reviewed separately.
Repeat encoding matched all three refreshed files byte for byte. The offline
builder smoke verified pinned drift exits 1, the refreshed subset exits 0,
`--update` accepts changes, and `--probe` leaves files untouched.

## Choices worth knowing before you change one

- **Selection order and page order are different things.** The ranking decides
  *which* figures a page contributes (a `photo` article prefers JPEG sources, a
  diagram article prefers SVG); the numbering follows document order. Without
  the ranking, `Kölner Dom` contributed a medieval illumination, a reliquary and
  a floor plan — three diagrams and no cathedral, on a page vendored to be a
  photograph.
- **Hidden nodes are not prose, as a rule rather than a selector list.**
  de.wikipedia's infobox templates emit their maintenance categories as
  `<div style="display:none">`, so `{{Infobox Berg}}` opened `zugspitze.md` on
  `pd5` and `Vorlage:Infobox Berg/Wartung/BILD1` — the first body text under the
  H1, inside the first chunk that gets embedded. `.infobox` never matched it:
  that page's infobox is a `wikitable float-right`. Anything the reader does not
  see is dropped, which also took two `Wikipedia:WikiProjekt …` links off other
  pages.
- **A footnote whose table is gone goes with it.** `table` is stripped, so
  de.wikipedia's `{{FN}}` family (`.fussnoten-etui` in the cell,
  `.fussnoten-box` below it) annotates columns that no longer exist — six pages
  carried 20 lines that were nothing but a `1`, a `(1)` or a `\*`. The
  containers are dropped, and `drop_orphan_markers` sweeps a marker-only line
  regardless of which template produced it, because that class of defect has
  more than one template.
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
  can change output bytes for identical input. An upgrade therefore requires
  the controlled refresh above, not just a version edit. Two transitive packages
  are pinned for the
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
