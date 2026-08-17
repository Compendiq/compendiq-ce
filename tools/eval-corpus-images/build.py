#!/usr/bin/env python3
"""#1115 P5a — build the German, image-bearing retrieval eval corpus.

Writes `backend/src/domains/llm/eval/corpus-de-images/`: one Markdown page per
article, the images it references, a manifest, an attribution file and a README.

Why the corpus is COMMITTED rather than fetched at eval time is the same reason
`scripts/vendor-eval-corpus.ts` gives for the English one: the harness has to
run without network access, and a corpus that could shift underneath the
fixture would silently invalidate every labelled `query -> page` pair. The
addition here is that the pages carry *images*, so this script also has to
carry the licence obligations that come with them.

Three rules do the real work.

1. **Captions and alt text are stripped from the page body.** The corpus mimics
   a Confluence page where the visual content is not restated in prose — that is
   the only shape on which an image retrieval leg can add anything over the text
   leg. A page that captions its own figures is answerable from text alone, so a
   measurement taken on it flatters the feature. The caption is not discarded:
   it goes into MANIFEST.json for the independent labeller (P5c) to write
   `expectedImages[]` against.

2. **Licences are filtered, not assumed.** Only CC0, public domain, CC BY x and
   CC BY-SA x pass. GFDL-only, any NC or ND variant, fair use and unknown are
   rejected and counted. Every accepted image needs a named author, because the
   attribution obligation is not satisfiable without one.

3. **Every image is re-encoded locally.** Wikimedia's own thumbnail is only the
   fetch; the bytes that land in the repository are downscaled to <= 512 px on
   the longest edge, re-encoded (JPEG for photographic content, PNG for
   diagrams) to aim at 80 KB, and dropped outright if they cannot be brought
   under 120 KB. The result is verified to sniff as png/jpeg/webp under the same
   magic-byte rules as `core/services/image-validator.ts` — SVG never reaches
   the repository, both because a VL encoder needs raster and because SVG
   carries script/XXE risk.

Determinism is not one pin but four checks, and the revision id is the pin they
sit ON rather than one of them: `oldid` selects a wikitext revision and nothing
else, and no branch below exits non-zero for it. The four are the page text
against a recorded `textSha256`, each image against the upstream Commons `sha1`,
the inventory against the committed manifest, and the total image budget — the
same four, in the same words, as `docs/runbooks/retrieval-eval.md`. Revisions are
pinned in the corpus's own MANIFEST.json and read back on a plain re-run (read
BEFORE the output directory is wiped — that is a scar from the English vendoring
script, whose first cut read the manifest afterwards and found nothing).

A revid does NOT pin the text. `action=parse&oldid=` renders that revision's
wikitext through the CURRENT template set and the current parser, so a template
edit or a MediaWiki upgrade moves the prose under a fixed revision — this script
already carries a workaround for one such change (`cut_tail_sections`, on
1.43's `<div class="mw-heading">` wrapper). So each page also records
`textSha256` over the Markdown it wrote, and a pinned run that produces
different bytes names the page and exits non-zero.

Nor does it pin the FILES: Commons serves the current version of a file, and an
SVG re-drawn or a photograph re-cropped upstream changes a rebuild with nothing
in the manifest to notice it. So each image records the upstream `sha1`, and a
pinned run reports every file whose sha1 has moved and exits non-zero.

And nothing above covers whether a figure is still *usable*. Commons metadata is
live, so a licence retagged, an author blanked or a thumbnail that stopped
rendering quietly turns a 3-image page into a 2-image one, or drops it out of
the corpus. So a pinned run also diffs its own inventory against the committed
manifest and exits non-zero on anything it lost (`lost_since`).

The fourth is not about reproduction at all: the corpus has a total image
budget, and a build over it exits non-zero whether or not it was pinned.

In all three DRIFT branches the bytes ARE written, because a diff you can look
at is more use than a refusal — the run simply stops claiming to have reproduced
the corpus. `--update` deliberately moves to current revisions and skips all
three, which obliges a re-label; the budget check is not one of the three and
runs on every build.

Nothing is written into the corpus directory until the whole run succeeds: the
build stages into a sibling directory and swaps it in at the end. A run that
loses three articles to a flaky network would otherwise leave a thinner corpus
behind AND destroy the revision pins of every article it did not rebuild, which
is the reproducibility property above, deleted by a transient 502.

Usage:
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python build.py --probe          # per-article usable-figure UPPER BOUND
    .venv/bin/python build.py                  # rebuild at the pinned revisions
    .venv/bin/python build.py --update         # move to current revisions
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import os
import re
import shutil
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import requests
import yaml
from bs4 import BeautifulSoup, Tag
from markdownify import MarkdownConverter
from PIL import Image

TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent.parent
CORPUS_DIR = REPO_ROOT / "backend" / "src" / "domains" / "llm" / "eval" / "corpus-de-images"
# Built into, then swapped over `CORPUS_DIR`. A sibling rather than a temp dir
# elsewhere so the swap is a rename on one filesystem and cannot half-happen.
STAGING_DIR = CORPUS_DIR.with_name(CORPUS_DIR.name + ".staging")

DE_API = "https://de.wikipedia.org/w/api.php"
COMMONS_FILE_URL = "https://commons.wikimedia.org/wiki/"

# A descriptive agent with a contact URL is what the Wikimedia API policy asks
# for; an anonymous default user agent is rate-limited hard and rightly so.
USER_AGENT = (
    "CompendiqEvalCorpusBuilder/1.0 "
    "(https://github.com/Compendiq/compendiq-ce; retrieval eval fixture; #1115) "
    "python-requests"
)

# Deliberately unhurried. This runs once per corpus refresh, so there is nothing
# to gain from pushing the API and a reputation to lose.
REQUEST_DELAY_S = 0.25

MAX_IMAGE_EDGE_PX = 512
TARGET_IMAGE_BYTES = 80 * 1024
HARD_IMAGE_BYTES = 120 * 1024
MAX_IMAGES_PER_PAGE = 3
MIN_IMAGES_PER_PAGE = 2
# Below this a "page" is a stub and only adds noise, exactly as MIN_CHARS does
# in the English vendoring script.
MIN_PAGE_CHARS = 800
TOTAL_BYTE_BUDGET = 10 * 1024 * 1024

PAGE_LICENSE = "CC BY-SA 4.0"

# Well past the longest credit Commons actually serves (the longest in this
# corpus is 280 characters and names three contributors). A credit longer than
# this is abbreviated ON A WORD BOUNDARY and marked, never cut mid-token: the
# first cut capped at a flat 180 and shipped `AxelScheithauer` as `AxelSch`
# with the third contributor missing entirely, on a CC BY-SA image whose whole
# obligation is that credit.
AUTHOR_MAX_CHARS = 400
AUTHOR_ABBREVIATED_MARK = " […]"

# ---------------------------------------------------------------------------
# licence filter
# ---------------------------------------------------------------------------

# Commons' `extmetadata.License` is a machine id (`cc-by-sa-3.0`, `cc0`, `pd`).
# Mapping it onto a closed set of canonical labels is what lets the Vitest guard
# hold a fixed allow-list instead of fuzzy-matching free text.
_CC_ID = re.compile(r"^cc-by(?P<sa>-sa)?-(?P<ver>\d\.\d)(?:-(?P<port>[a-z]{2}))?$")
_PD_IDS = {"pd", "publicdomain", "public domain", "pd-old", "pd-us", "pd-self"}
# Anything here is a refusal regardless of what else the id says.
_FORBIDDEN_TOKENS = ("-nc", "nc-", "-nd", "nd-", "noncommercial", "noderivs", "fair", "gfdl")


def canonical_license(raw_id: str, short_name: str) -> str | None:
    """Canonical label for a permitted licence, or None to reject.

    Rejects by construction rather than by list: an id that does not match one
    of the three permitted shapes is refused, so a licence nobody anticipated
    fails closed.
    """
    ident = (raw_id or "").strip().lower()
    short = (short_name or "").strip().lower()
    if not ident:
        # Some very old uploads carry only a LicenseShortName. Accept the three
        # unambiguous spellings and refuse the rest.
        if short in {"cc0", "cc0 1.0"}:
            return "CC0 1.0"
        if short in {"public domain", "gemeinfrei"}:
            return "Public domain"
        return None

    if any(token in ident for token in _FORBIDDEN_TOKENS):
        return None
    if ident.startswith("cc0"):
        return "CC0 1.0"
    if ident in _PD_IDS or ident.startswith("pd-"):
        return "Public domain"
    match = _CC_ID.match(ident)
    if match:
        base = "CC BY-SA" if match.group("sa") else "CC BY"
        label = f"{base} {match.group('ver')}"
        if match.group("port"):
            label += f" {match.group('port').upper()}"
        return label
    return None


LICENSE_URLS = {
    "CC0 1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
    "Public domain": "https://en.wikipedia.org/wiki/Public_domain",
}


def license_url(label: str) -> str:
    if label in LICENSE_URLS:
        return LICENSE_URLS[label]
    match = re.match(r"^CC BY(-SA)? (\d\.\d)(?: ([A-Z]{2}))?$", label)
    if not match:
        return ""
    slug = "by-sa" if match.group(1) else "by"
    url = f"https://creativecommons.org/licenses/{slug}/{match.group(2)}/"
    if match.group(3):
        url += f"{match.group(3).lower()}/"
    return url


# ---------------------------------------------------------------------------
# magic-byte sniffing — mirrors core/services/image-validator.ts
# ---------------------------------------------------------------------------

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def sniff_image_format(buf: bytes) -> str | None:
    """The app's `sniffImageFormat`, byte for byte. Never consults a filename."""
    if len(buf) >= 8 and buf[:8] == PNG_SIG:
        return "png"
    if len(buf) >= 3 and buf[0] == 0xFF and buf[1] == 0xD8 and buf[2] == 0xFF:
        return "jpeg"
    if len(buf) >= 6 and buf[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if len(buf) >= 12 and buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
        return "webp"
    return None


ACCEPTED_FORMATS = {"png", "jpeg", "webp"}


# ---------------------------------------------------------------------------
# API access
# ---------------------------------------------------------------------------

session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})


def retry_after_seconds(header: str | None, fallback: float) -> float:
    """`Retry-After` as a number of seconds, whichever of its two forms arrived.

    RFC 9110 permits an HTTP-date as well as a delta, and `float()` on one
    raises `ValueError` — which escapes the retry loop, is caught as an article
    failure, and refuses the swap. The one path written for "we are being
    rate-limited" was the path that killed the build.
    """
    if not header:
        return fallback
    try:
        return max(0.0, float(header))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return fallback
    if when is None:
        return fallback
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def api_get(url: str, params: dict[str, Any] | None = None, *, binary: bool = False) -> Any:
    """One GET with the project's back-off manners: honour Retry-After, then
    exponential, then give up loudly rather than half-building a corpus.

    A transport failure takes the SAME back-off as a 5xx rather than escaping.
    A full build is ~600 requests over ten minutes of network, so one connection
    reset otherwise costs the entire run — and the run refuses to swap on a
    single failed article, by design.
    """
    delay = 1.0
    for attempt in range(6):
        time.sleep(REQUEST_DELAY_S)
        try:
            response = session.get(url, params=params, timeout=60)
        except requests.RequestException as error:
            print(f"  ! {type(error).__name__} from {url}; backing off {delay:.0f}s", file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 60)
            continue
        if response.status_code == 429 or response.status_code >= 500:
            wait = retry_after_seconds(response.headers.get("Retry-After"), delay)
            print(f"  ! {response.status_code} from {url}; backing off {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
            delay = min(delay * 2, 60)
            continue
        response.raise_for_status()
        return response.content if binary else response.json()
    raise RuntimeError(f"gave up on {url} after 6 attempts")


def resolve_revision(title: str) -> tuple[str, int]:
    """Resolved title (redirects followed) and current revision id."""
    data = api_get(
        DE_API,
        {
            "action": "query",
            "titles": title,
            "prop": "revisions",
            "rvprop": "ids",
            "redirects": 1,
            "format": "json",
            "formatversion": 2,
        },
    )
    pages = data.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        raise RuntimeError(f"no such article: {title}")
    page = pages[0]
    return page["title"], int(page["revisions"][0]["revid"])


def fetch_parsed_html(revid: int) -> str:
    """Rendered HTML of one specific revision — the pin is the whole point."""
    data = api_get(
        DE_API,
        {
            "action": "parse",
            "oldid": revid,
            "prop": "text",
            "format": "json",
            "formatversion": 2,
        },
    )
    return data["parse"]["text"]


def fetch_image_metadata(file_titles: list[str]) -> dict[str, dict[str, Any]]:
    """imageinfo + extmetadata for a batch of `File:` titles.

    Queried through de.wikipedia rather than Commons directly: MediaWiki
    resolves foreign-repo files transparently, so one endpoint covers both
    locally-hosted and Commons-hosted files without branching.

    `sha1` is in the property list because the article revision is only half of
    the pin. Commons serves the CURRENT version of a file; an SVG re-drawn or a
    photograph re-cropped upstream changes what a "pinned" rebuild produces,
    and without a recorded content address there is nothing to notice it with.
    """
    out: dict[str, dict[str, Any]] = {}
    for batch_start in range(0, len(file_titles), 20):
        batch = file_titles[batch_start : batch_start + 20]
        data = api_get(
            DE_API,
            {
                "action": "query",
                "titles": "|".join(batch),
                "prop": "imageinfo",
                "iiprop": "url|size|mime|sha1|extmetadata",
                "format": "json",
                "formatversion": 2,
            },
        )
        query = data.get("query", {})
        # `normalized` maps what we asked for onto what the API answered.
        alias: dict[str, str] = {n["to"]: n["from"] for n in query.get("normalized", [])}
        for page in query.get("pages", []):
            info = (page.get("imageinfo") or [None])[0]
            if info is None:
                continue
            asked = alias.get(page["title"], page["title"])
            out[asked] = {"title": page["title"], **info}
    return out


def commons_file_title(local_title: str) -> str:
    """`Datei:X` -> `File:X`.

    de.wikipedia answers in its own namespace alias, but the file lives on
    Commons under the canonical English one — and that is the name the
    attribution has to carry, because it is the name that resolves.
    """
    for prefix in FILE_NS:
        if local_title.startswith(prefix):
            return "File:" + local_title[len(prefix) :]
    return local_title


def fetch_thumbnail(file_title: str, width: int) -> bytes | None:
    data = api_get(
        DE_API,
        {
            "action": "query",
            "titles": file_title,
            "prop": "imageinfo",
            "iiprop": "url",
            "iiurlwidth": width,
            "format": "json",
            "formatversion": 2,
        },
    )
    pages = data.get("query", {}).get("pages", [])
    info = (pages[0].get("imageinfo") or [None])[0] if pages else None
    if not info:
        return None
    url = info.get("thumburl") or info.get("url")
    if not url:
        return None
    return api_get(url, binary=True)


# ---------------------------------------------------------------------------
# HTML -> figures + prose
# ---------------------------------------------------------------------------

# Chrome, navigation and apparatus. None of it is prose, and all of it would be
# embedded as if it were.
DROP_SELECTORS = [
    "style", "script", "sup.reference", "sup.noprint", ".mw-editsection", ".mw-empty-elt",
    ".hatnote", ".navbox", ".vertical-navbox", ".infobox", ".sistersitebox", ".metadata",
    ".noprint", ".reflist", ".mw-references-wrap", "ol.references", ".shortdescription",
    ".toc", "#toc", ".mw-kartographer-map", ".side-box", ".ambox", ".mw-collapsible",
    ".gallery", ".mwe-math-element", ".thumbinner .magnify", "table", ".mw-indicators",
    ".mw-authority-control", ".navigation-not-searchable", ".mw-jump-link",
    # de.wikipedia's `{{FN}}` family: `.fussnoten-etui` is the marker inside a
    # table cell and `.fussnoten-box` the definition list under it. `table` is
    # already dropped above, so the definitions annotate columns that no longer
    # exist — the marker arrives as a bare `1` on its own line and the text
    # below it refers to rows nobody can see. Six pages shipped 20 such lines.
    ".fussnoten-box", ".fussnoten-block", ".fussnoten-etui",
]

#: Elements a reader never sees. de.wikipedia's infobox templates emit their
#: maintenance-category links as `<div style="display:none">`, so `{{Infobox
#: Berg}}` put `pd5` and `Vorlage:Infobox Berg/Wartung/BILD1` into `zugspitze.md`
#: as its first two body lines — i.e. into the first chunk that gets embedded,
#: on the page opening a retrieval eval weights most. The rule is general rather
#: than a selector per template: text the article does not display is not the
#: article's prose. `.infobox` never matched this one, because the page's
#: infobox is a `wikitable float-right`.
_HIDDEN_STYLE = re.compile(r"display\s*:\s*none", re.I)

# Everything from one of these headings onward is apparatus: link farms,
# bibliographies and footnotes, none of which reads as knowledge-base prose.
TAIL_HEADINGS = {
    "siehe auch", "literatur", "weblinks", "einzelnachweise", "anmerkungen", "quellen",
    "fußnoten", "belege", "nachweise", "filme", "dokumentationen", "normen und standards",
    "verwandte themen", "medien", "bildergalerie", "galerie",
}

FILE_NS = ("Datei:", "File:", "Bild:", "Image:")


def strip_noise(soup: BeautifulSoup) -> None:
    for selector in DROP_SELECTORS:
        for node in soup.select(selector):
            node.decompose()
    for node in soup.select(".editoronly"):
        node.decompose()
    for node in soup.find_all(style=_HIDDEN_STYLE):
        node.decompose()


def cut_tail_sections(root: Tag) -> None:
    """Drop every sibling from the first apparatus heading onward."""
    for heading in root.find_all(["h2", "h3"]):
        text = heading.get_text(" ", strip=True).lower().strip()
        text = re.sub(r"\[.*?\]", "", text).strip()
        if text in TAIL_HEADINGS:
            # In MediaWiki 1.43+ an h2 is wrapped in a <div class="mw-heading">;
            # cutting from the heading alone would leave that wrapper standing.
            start = heading
            while start.parent is not root and start.parent is not None:
                start = start.parent
            for sibling in list(start.next_siblings):
                if isinstance(sibling, Tag):
                    sibling.decompose()
                else:
                    sibling.extract()
            start.decompose()
            return


def file_title_from_figure(figure: Tag) -> str | None:
    """The `File:…` title behind a figure, from the link or the thumbnail URL.

    Percent-decoded, which is not cosmetic: MediaWiki writes the href
    percent-encoded, so `Kölner Dom nachts 2013.jpg` arrives as
    `K%C3%B6lner...`. Left encoded, the imageinfo lookup finds nothing and the
    figure is discarded as "no imageinfo" — which is how every umlaut-titled
    photograph silently left the corpus on the first build.
    """
    for anchor in figure.find_all("a", href=True):
        href = html.unescape(anchor["href"])
        for prefix in FILE_NS:
            marker = f"/wiki/{prefix}"
            if marker in href:
                return "File:" + unquote(href.split(marker, 1)[1].split("#")[0]).replace("_", " ")
            if href.startswith(f"./{prefix}"):
                return "File:" + unquote(href[len(prefix) + 2 :]).replace("_", " ")
    img = figure.find("img")
    if img and img.get("src"):
        # …/commons/thumb/a/ab/Name.svg/512px-Name.svg.png -> Name.svg
        parts = html.unescape(img["src"]).split("/")
        if "thumb" in parts:
            idx = parts.index("thumb")
            if len(parts) > idx + 3:
                return "File:" + unquote(parts[idx + 3]).replace("_", " ")
        elif parts:
            return "File:" + unquote(parts[-1]).replace("_", " ")
    return None


#: Zero-width characters Commons' templates sprinkle into rendered HTML. They
#: survive `get_text`, so a credit compared against the licensor's own string
#: differs by a character nobody can see.
_INVISIBLES = str.maketrans(dict.fromkeys("\u200b\u200c\u200d\ufeff", ""))


def tidy_inline_text(text: str) -> str:
    """Undo what `get_text(" ")` does to punctuation, then collapse whitespace.

    BeautifulSoup inserts a separator at every inline boundary, so `<b>oben</b>:`
    comes back as "oben :" and `<a>Thomas Wolf</a>, www.foto-tw.de` as
    "Thomas Wolf , www.foto-tw.de". Cosmetic in a caption; not cosmetic in a
    credit, which is a string the licensor specified and this file claims to
    reproduce.
    """
    text = text.translate(_INVISIBLES)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([:;,.)»])", r"\1", text)
    text = re.sub(r"([(«])\s+", r"\1", text)
    return text.strip()


def extmeta_text(extmeta: dict[str, Any], key: str) -> str:
    """One `extmetadata` field as readable text. Commons serves them as HTML."""
    raw = (extmeta.get(key) or {}).get("value") or ""
    if not isinstance(raw, str):
        return ""
    return tidy_inline_text(BeautifulSoup(raw, "html.parser").get_text(" ", strip=True))


def caption_text(figure: Tag) -> str:
    caption = figure.find("figcaption") or figure.select_one(".thumbcaption")
    if caption is None:
        return ""
    text = caption.get_text(" ", strip=True)
    text = re.sub(r"\[\d+\]", "", text)          # leftover reference markers
    return tidy_inline_text(text)


def hoist_boxed_figures(root: Tag) -> None:
    """Lift captioned figures out of the boxes that are about to be dropped.

    The lead photograph of a building, a train or an aircraft lives in the
    infobox on de.wikipedia, and the infobox is dropped as chrome — so a corpus
    built without this had a `photo` slice of interior shots, engravings and
    floor plans, and no cathedral.

    WHERE it lifts them to is two cases, not one. An **infobox** figure has no
    position in the prose to preserve, so it goes to the top, which is where a
    hero image belongs on a Confluence page anyway. A figure in an **ordinary
    content table** does have one, and moving it to the top destroys it: the
    Nassi-Shneiderman article keeps each notation symbol in a table under its
    own heading, and hoisting all three to the front left the page opening on
    three stacked diagrams above two headings with nothing under them. Those go
    immediately before their table instead, so the figure stays under the
    heading that introduces it.
    """
    for container in root.select("table, .infobox, .vertical-navbox"):
        classes = container.get("class") or []
        to_top = container.name != "table" or "infobox" in classes or "vertical-navbox" in classes
        for figure in reversed(container.select("figure, .thumb")):
            if len(caption_text(figure)) < 12:
                continue
            if to_top:
                root.insert(0, figure.extract())
            else:
                container.insert_before(figure.extract())


@dataclass
class FigureCandidate:
    node: Tag
    file_title: str
    caption: str


def collect_figures(root: Tag) -> list[FigureCandidate]:
    """Captioned figures, in document order.

    Only captioned ones: the caption is what the labeller needs to write
    `expectedImages[]`, and an uncaptioned decorative image gives it nothing to
    label against.
    """
    out: list[FigureCandidate] = []
    seen: set[str] = set()
    for node in root.select("figure, .thumb"):
        caption = caption_text(node)
        if len(caption) < 12:
            continue
        title = file_title_from_figure(node)
        if not title or title in seen:
            continue
        if not re.search(r"\.(svg|png|jpe?g|gif|tiff?|webp)$", title, re.I):
            continue
        seen.add(title)
        out.append(FigureCandidate(node=node, file_title=title, caption=caption))
    return out


# ---------------------------------------------------------------------------
# image processing
# ---------------------------------------------------------------------------


def looks_photographic(img: Image.Image, source_mime: str) -> bool:
    """Photo -> JPEG, diagram -> PNG.

    The source MIME decides where it can: an `image/svg+xml` is a vector
    drawing by definition, and JPEG's ringing lands exactly on the thin dark
    strokes and small labels that make a schematic readable at 512 px — the
    first build turned a thylakoid-membrane SVG into a JPEG on a colour count
    alone, because a gradient-heavy diagram has plenty of colours. `image/jpeg`
    is a photograph often enough to take at its word.

    PNG and GIF sources are genuinely either, so those are decided from the
    pixels: `getcolors` returning None means the palette blew past the limit,
    which is what a photograph does and a diagram does not.
    """
    if source_mime == "image/svg+xml":
        return False
    if source_mime == "image/jpeg":
        return True
    return img.convert("RGB").getcolors(maxcolors=8192) is None


def flatten(img: Image.Image) -> Image.Image:
    """Alpha onto white. A diagram uploaded into Confluence sits on a white
    page, and a transparent PNG costs bytes for a background the model will
    read as white regardless."""
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        canvas = Image.new("RGB", img.size, (255, 255, 255))
        canvas.paste(img, mask=img.split()[-1])
        return canvas
    return img.convert("RGB")


def fit(img: Image.Image, edge: int) -> Image.Image:
    out = img.copy()
    out.thumbnail((edge, edge), Image.LANCZOS)
    return out


def encode(img: Image.Image, photographic: bool, quality_or_colors: int) -> bytes:
    buf = io.BytesIO()
    if photographic:
        img.save(buf, format="JPEG", quality=quality_or_colors, optimize=True, progressive=False)
    else:
        palette = img.quantize(colors=quality_or_colors, method=Image.MEDIANCUT, dither=Image.NONE)
        palette.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


@dataclass
class EncodedImage:
    data: bytes
    fmt: str
    ext: str
    width: int
    height: int


def downscale_and_encode(raw: bytes, source_mime: str) -> EncodedImage | None:
    """<= 512 px longest edge, aiming at 80 KB, refused above 120 KB.

    Two numbers on purpose: the target keeps the mean low across ~150 images,
    the cap stops one pathological figure from spending the whole budget. An
    image that cannot make the cap is dropped rather than shrunk into
    illegibility — it is one figure out of many, and the corpus is worth more
    than the completeness of any single article.
    """
    try:
        source = Image.open(io.BytesIO(raw))
        source.load()
    except Exception:
        return None

    photographic = looks_photographic(source, source_mime)
    flat = flatten(source)
    ladder = [85, 80, 75, 70, 65, 60] if photographic else [256, 128, 64, 32]
    best: EncodedImage | None = None

    for edge in (MAX_IMAGE_EDGE_PX, 448, 384, 320):
        resized = fit(flat, edge)
        for step in ladder:
            data = encode(resized, photographic, step)
            fmt = sniff_image_format(data)
            if fmt not in ACCEPTED_FORMATS:
                return None
            candidate = EncodedImage(
                data=data,
                fmt=fmt,
                ext="jpg" if fmt == "jpeg" else fmt,
                width=resized.width,
                height=resized.height,
            )
            if best is None or len(data) < len(best.data):
                best = candidate
            if len(data) <= TARGET_IMAGE_BYTES:
                return candidate
    if best is not None and len(best.data) <= HARD_IMAGE_BYTES:
        return best
    return None


# ---------------------------------------------------------------------------
# markdown
# ---------------------------------------------------------------------------

PLACEHOLDER = "@@COMPENDIQ_IMAGE_{index}@@"


class CorpusConverter(MarkdownConverter):
    """Anchors become their text: a `/wiki/Foo` link is site navigation, and a
    knowledge-base page carrying dozens of them puts markup into the embedding
    where prose should be."""

    def convert_a(self, el, text, parent_tags=None):  # type: ignore[override]
        return text


def to_markdown(root: Tag) -> str:
    md = CorpusConverter(heading_style="ATX", bullets="-", escape_underscores=False).convert_soup(root)
    md = html.unescape(md)
    md = re.sub(r"\[Bearbeiten[^\]]*\]", "", md)
    md = re.sub(r"[ \t]+\n", "\n", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    # markdownify emits empty emphasis for the stripped inline markup.
    md = re.sub(r"^\s*\*\*\s*$", "", md, flags=re.M)
    return drop_empty_headings(drop_orphan_markers(md)).strip()


#: A line that is only a footnote marker. `.fussnoten-box` above is the template
#: that produced every one of the 20 committed cases, so this is belt and
#: braces — but the *class* of defect is "an annotation whose subject was
#: stripped", and de.wikipedia has more than one template for it. A marker with
#: nothing to point at is noise in the index either way, and a rule over the
#: rendered Markdown catches a template this script has never met. Digits and
#: asterisks only (markdownify escapes the latter to `\*`); a bare `a)` is
#: plausible prose and is left alone.
_ORPHAN_MARKER = re.compile(r"^(?:\(\d{1,2}\)|\d{1,2}\)?|(?:\\?\*){1,4}|[†‡])$")


def drop_orphan_markers(md: str) -> str:
    """Remove marker-only lines, before `drop_empty_headings` counts content.

    Fenced code is EXEMPT. Inside a ``` block a line that is exactly `1` or `*`
    is a line of the sample, not an annotation whose subject was stripped, and
    deleting it is the one edit `textSha256` cannot describe: the drift report
    says the page rendered different text, never that a line of a code listing
    vanished. No committed page hits this today (3 fenced blocks, none with such
    a line), so this is a guard for `--update` and for the next article added.
    markdownify emits ``` for every `<pre>` it converts, so that one fence
    marker is the whole of what this builder can produce; an unclosed fence
    leaves the rest of the page exempt, which is the safe direction.
    """
    kept: list[str] = []
    in_fence = False
    for line in md.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
        elif not in_fence and _ORPHAN_MARKER.fullmatch(stripped):
            continue
        kept.append(line)
    return "\n".join(kept)


def drop_empty_headings(md: str) -> str:
    """Remove headings that have nothing under them.

    Tables are stripped, so a section whose entire content was a table becomes
    a heading followed by the next heading. That is not prose, it chunks badly,
    and it puts a subject line into the index with no text to support it. An
    image placeholder counts as content — the replacement happens after this,
    so a section carrying only a figure keeps its heading.

    "Nothing under them" means nothing before the next heading AT THE SAME OR A
    SHALLOWER LEVEL. The first cut stopped at the next heading of any depth,
    which is a different rule: a `##` whose subsections are all populated has
    nothing between itself and its first `###`, so it was deleted along with
    the genuinely bare ones. That cost a section title on 22 of 66 pages —
    `Kölner Dom` ran `# Kölner Dom` straight into `### Römische und
    merowingische Bischofskirche`, with the parent's subject line gone from the
    page entirely. It is a heading over populated subsections, which is exactly
    a section that has content.

    Iterated to a fixpoint, because dropping a bare `###` can leave its `##`
    parent bare in turn.
    """
    heading = re.compile(r"^(#{1,6}) ")
    for _ in range(8):
        lines = md.split("\n")
        out: list[str] = []
        for index, line in enumerate(lines):
            match = heading.match(line)
            if match:
                level = len(match.group(1))
                stop = len(lines)
                for offset, other in enumerate(lines[index + 1 :]):
                    other_match = heading.match(other)
                    if other_match and len(other_match.group(1)) <= level:
                        stop = index + 1 + offset
                        break
                body = lines[index + 1 : stop]
                # A deeper heading inside the span IS content: it is the
                # subsection this heading introduces.
                if not any(other.strip() for other in body):
                    continue
            out.append(line)
        collapsed = "\n".join(out)
        if collapsed == md:
            return md
        md = collapsed
    return md


def slugify(title: str) -> str:
    decomposed = (
        title.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
        .replace("Ä", "Ae").replace("Ö", "Oe").replace("Ü", "Ue").replace("ß", "ss")
    )
    ascii_only = unicodedata.normalize("NFKD", decomposed).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_only).strip("-").lower()
    return re.sub(r"-{2,}", "-", slug)


# The unknown-author templates, as de.wikipedia RENDERS them — which is the
# only form this script ever sees. `extmetadata` is localised, so the German
# projects answer "Autor/-in unbekannt Unknown author" and "Anonym Unknown
# author" where an equality test against `"unknown"` sees a name. Four images
# reached the notices file through that gap on the first build, one of them
# credited to Commons' *Source* field, "Eigenes Werk".
#
# Anchored, never a substring search: "No machine-readable author provided.
# Marcelo Reis assumed…" is Commons' wording for a file that DOES name someone,
# and "Eigenes Werk von Max Mustermann" is a name too.
#
# The spellings are what Commons ACTUALLY answers, not what the templates are
# supposed to render: `File:Magischesdreieck.gif` gives `unbekant` (one `n`
# short) and `File:Turbolader LKW.jpg` a bare `selbst`. Both are hand-typed into
# the `author=` parameter, so a filter matching only the template's own wording
# is a filter that misses the field it was written for — the first cut shipped
# two credits naming nobody while the README published "no named author: 11" as
# if the filter had caught them all.
_UNKNOWN_AUTHOR = re.compile(
    r"^(?:"
    r"(?:autor(?:/-?in)?\s+)?unbekan{1,2}t(?:er\s+autor)?"
    r"|urheber\s+unbekan{1,2}t"
    r"|nicht\s+bekannt"
    r"|unknown(?:\s+author)?"
    r"|anonym(?:ous)?"
    r"|eigenes\s+werk"
    r"|own\s+work"
    r"|self[-\s]?made"
    r"|selbst(?:\s+(?:erstellt|gemacht|fotografiert|aufgenommen))?"
    r"|n/?a"
    r"|[-–—?.]"
    r")"
    # de.wikipedia renders the localised template with the English original
    # glued on behind it, so every spelling above may carry that tail.
    r"(?:\s+unknown\s+author)?$",
    re.IGNORECASE,
)


def abbreviate_author(text: str) -> str:
    """Cap a credit at a WORD boundary, and say so when it was cut.

    A silent mid-token cut is worse than a long line: `AxelSch` is not a person
    anyone can look up, and nothing in the notices file said the name was
    partial. The mark is what sends a reader to `sourceUrl` for the rest.
    """
    if len(text) <= AUTHOR_MAX_CHARS:
        return text
    budget = AUTHOR_MAX_CHARS - len(AUTHOR_ABBREVIATED_MARK)
    head = text[:budget]
    cut = max(head.rfind(" "), head.rfind(";"), head.rfind(":"), head.rfind(","))
    if cut > budget // 2:
        head = head[:cut]
    return head.rstrip(" ;:,") + AUTHOR_ABBREVIATED_MARK


def plain_author(extmeta: dict[str, Any]) -> str:
    """A readable author from `Artist`, then `Attribution`.

    Both are HTML on Commons — usually a link to the uploader's user page.

    `Credit` is NOT consulted, and that is the point of the two-key chain:
    Commons' `Credit` is the *Source* field, not an author. Reading it as one
    put "Eigenes Werk" ("own work") into the notices file as the name of a
    photographer, and "Translation of Image:… .svg" would have been next.

    An image with neither key, or with one of the unknown-author templates, is
    dropped: the attribution obligation is not satisfiable without a name, and
    writing "unknown" into the notices file would be a claim rather than a
    record.

    `Artist` stays FIRST even though `Attribution` is what a CC BY-SA licensor
    specified (see `required_credit`), because the two answer different
    questions and `Attribution` is regularly the shorter answer: Commons
    records `Madprime (original) Woudloper (rotated image)` as the artist of a
    derivative and `I, Madprime` as the credit line, `Original: Andreas Wieland
    Vektor: EssensStrassen` against a bare `Andreas Wieland`. Swapping the
    order would drop a contributor from the notices file to satisfy a
    requirement the extra column satisfies without losing anything.
    """
    for key in ("Artist", "Attribution"):
        text = extmeta_text(extmeta, key)
        if text and not _UNKNOWN_AUTHOR.match(text):
            return abbreviate_author(text)
    return ""


def required_credit(extmeta: dict[str, Any]) -> str:
    """The credit line the LICENSOR specified, verbatim, or "" if there is none.

    CC BY-SA 4.0 §3(a)(1)(A)(i) obliges attribution "in any reasonable manner
    requested by the Licensor" and §3(a)(1)(B) the retention of a supplied
    copyright notice; 3.0 §4(c) says the same through "Attribution Parties".
    Commons' `extmetadata.Attribution` IS that request, and `AttributionRequired`
    is Commons saying the licence makes it one — so `© Raimond Spekking / CC
    BY-SA 4.0 (via Wikimedia Commons)` and `Bundesarchiv, Bild 183-85770-0002 /
    Junge, Peter Heinz / CC-BY-SA 3.0` are the strings that must travel with
    those files, not the bare names in `Artist`.

    Gated on `AttributionRequired` rather than on the field being present: a
    public-domain file with an `Attribution` (`© Sémhur / Wikimedia Commons`,
    on a USGS-derived map) carries no obligation, and printing one under a
    "required" heading would be a claim rather than a record — the same mistake
    as writing "unknown" into an author column.
    """
    required = str((extmeta.get("AttributionRequired") or {}).get("value", "")).strip().lower()
    if required != "true":
        return ""
    return abbreviate_author(extmeta_text(extmeta, "Attribution"))


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def rank_candidates(
    figures: list[FigureCandidate],
    metadata: dict[str, dict[str, Any]],
    category: str,
) -> list[FigureCandidate]:
    """Order the figures so a page contributes the KIND of image its shape names.

    Document order alone is the wrong rule and quietly wrecks the `photo`
    slice: `Kölner Dom` opens on its history, so the first three captioned
    figures were a medieval illumination, a reliquary and a floor plan — three
    diagrams and no cathedral, on a page vendored to be a photograph. The
    upstream MIME is enough to sort on and costs no extra request: SVG is a
    diagram, JPEG is (nearly always) a photograph, PNG is either.

    Only the ORDER changes. Nothing is excluded here, so a technical article
    whose only usable figures are photographs still contributes them.
    """
    diagram_first = category != "photo"

    def rank(figure: FigureCandidate) -> tuple[int, int]:
        mime = (metadata.get(figure.file_title) or {}).get("mime", "")
        if mime == "image/svg+xml":
            kind = 0
        elif mime == "image/png":
            kind = 1
        else:
            kind = 2
        preference = kind if diagram_first else -kind
        return (preference, figures.index(figure))

    return sorted(figures, key=rank)


@dataclass
class Rejection:
    file_title: str
    reason: str


@dataclass
class BuildStats:
    """Three counters, not one, because collapsing them overstates the filter.

    `candidates` is every captioned figure seen; `examined` is the subset the
    licence filter actually ran on. They differ a lot — a page stops evaluating
    once it has its three images — so reporting "14 of 1075 rejected" would
    describe a filter that ran on 1075 figures and let 1061 through, when in
    truth it ran on 203 and refused 14 of those. The second number is the one
    that says anything about the filter.
    """

    candidates: int = 0
    examined: int = 0
    accepted: int = 0
    rejections: list[Rejection] = field(default_factory=list)
    #: Commons files whose upstream sha1 has moved since the recorded one. Not
    #: a rejection — the image is still vendored — but a pinned run that hits
    #: one has not reproduced the corpus, and says so.
    drifted: list[str] = field(default_factory=list)

    def reject(self, file_title: str, reason: str) -> None:
        self.rejections.append(Rejection(file_title, reason))

    def by_reason(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for rejection in self.rejections:
            counts[rejection.reason] = counts.get(rejection.reason, 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


def load_articles(path: Path) -> list[tuple[str, str]]:
    data = yaml.safe_load(path.read_text(encoding="utf8"))
    out: list[tuple[str, str]] = []
    for category, titles in data.items():
        for title in titles:
            out.append((str(title), str(category)))
    return out


def read_manifest() -> dict[str, Any]:
    """The committed manifest, read BEFORE anything is written.

    The English vendoring script shipped this the other way round once and the
    checkout was dead code while three documents claimed reproducibility. The
    build now stages into a sibling directory, so the committed manifest is
    still standing either way — but reading it first keeps the ordering
    obvious rather than incidental.
    """
    manifest_path = CORPUS_DIR / "MANIFEST.json"
    if not manifest_path.exists():
        return {"pages": []}
    return json.loads(manifest_path.read_text(encoding="utf8"))


def read_pins(manifest: dict[str, Any]) -> dict[str, int]:
    """Recorded revision per RESOLVED article title."""
    return {page["title"]: int(page["revid"]) for page in manifest.get("pages", [])}


def read_image_sha1s(manifest: dict[str, Any]) -> dict[str, str]:
    """Recorded upstream sha1 per Commons file title."""
    return {
        image["sourceTitle"]: image["sha1"]
        for page in manifest.get("pages", [])
        for image in page.get("images", [])
        if image.get("sha1")
    }


def text_drift(manifest: dict[str, Any], pages: list[dict[str, Any]]) -> list[str]:
    """Pages whose rendered Markdown differs from the committed bytes.

    The half of reproducibility a revision id does not buy. `action=parse` with
    an `oldid` renders that revision's wikitext through the CURRENT templates and
    parser, so an upstream template edit or a MediaWiki release changes the prose
    of a page nobody edited. It has already happened to this builder once —
    1.43 started wrapping `h2` in `<div class="mw-heading">`, which
    `cut_tail_sections` carries a branch for.

    Absent from the committed manifest means "not recorded yet", not "matches":
    the field arrived after the first corpus was vendored, so a page without one
    is skipped rather than reported as drifted.
    """
    recorded = {
        page["file"]: page["textSha256"]
        for page in manifest.get("pages", [])
        if page.get("textSha256")
    }
    return [
        f"{page['file']}: {recorded[page['file']][:12]} -> {page['textSha256'][:12]}"
        for page in pages
        if page["file"] in recorded and recorded[page["file"]] != page["textSha256"]
    ]


def lost_since(manifest: dict[str, Any], pages: list[dict[str, Any]]) -> list[str]:
    """Pages and images the committed manifest has and this build does not.

    The `revid` pin covers the article TEXT and the `sha1` the image BYTES;
    neither covers whether a figure is still *usable*. Commons metadata is
    live, so a licence retagged upstream, an author field blanked or a
    thumbnail that stopped rendering silently turns a 3-image page into a
    2-image one — or drops it below `MIN_IMAGES_PER_PAGE` and out of the corpus
    entirely — on a run whose whole claim is that it reproduces the committed
    bytes. The Vitest guard cannot see it either: four category counts of 17
    pass exactly as four counts of 18 do.

    The previous inventory is already in hand (`read_manifest` runs before
    anything is written), so the comparison is free. Skipped under `--update`,
    which is the flag that means "move".
    """
    previous_pages = {page["file"]: page for page in manifest.get("pages", [])}
    current_pages = {page["file"]: page for page in pages}
    lost: list[str] = []
    for file, page in previous_pages.items():
        current = current_pages.get(file)
        if current is None:
            lost.append(f"{file} ({len(page.get('images', []))} image(s)) is no longer built")
            continue
        now = {image["file"] for image in current.get("images", [])}
        for image in page.get("images", []):
            if image["file"] not in now:
                lost.append(f"{image['file']} ({image.get('sourceTitle', '?')}) is no longer vendored")
    return lost


def build_page(
    title: str,
    category: str,
    revid: int,
    stats: BuildStats,
    probe: bool,
    out_dir: Path,
    pinned_sha1: dict[str, str],
) -> dict[str, Any] | None:
    soup = BeautifulSoup(fetch_parsed_html(revid), "html.parser")
    root = soup.select_one(".mw-parser-output") or soup
    # Trim BEFORE collecting figures, not after. A figure living in a gallery,
    # an infobox or a `Weblinks` tail would otherwise be downloaded, attributed
    # and numbered, and then have its placeholder deleted by the trim — leaving
    # a manifest entry no page references, which is a guard failure describing
    # a build-order bug rather than the corpus.
    cut_tail_sections(root)
    hoist_boxed_figures(root)
    strip_noise(soup)

    figures = collect_figures(root)
    stats.candidates += len(figures)

    metadata = fetch_image_metadata([figure.file_title for figure in figures])

    # Selection order and PAGE order are deliberately different things. The
    # ranking decides *which* figures a page contributes; the numbering below
    # follows document order, so `__1` is the first image a reader meets and
    # the manifest reads down the page rather than down a preference list.
    document_order = {id(figure.node): position for position, figure in enumerate(figures)}
    selected: list[tuple[int, dict[str, Any], FigureCandidate, EncodedImage | None]] = []
    slug = slugify(title)

    for figure in rank_candidates(figures, metadata, category):
        if len(selected) >= MAX_IMAGES_PER_PAGE:
            figure.node.decompose()
            continue
        stats.examined += 1
        info = metadata.get(figure.file_title)
        if info is None:
            stats.reject(figure.file_title, "no imageinfo")
            figure.node.decompose()
            continue
        # Locally-hosted files are refused rather than special-cased. On
        # de.wikipedia the local repository is where the licences this filter
        # exists to reject live (fair use, PD-Germany claims that Commons will
        # not host), and a "source" link that does not resolve on Commons is a
        # worse attribution than none.
        description_url = info.get("descriptionurl") or ""
        if "commons.wikimedia.org" not in description_url:
            stats.reject(figure.file_title, "not hosted on Commons")
            figure.node.decompose()
            continue
        extmeta = info.get("extmetadata") or {}
        label = canonical_license(
            (extmeta.get("License") or {}).get("value", ""),
            (extmeta.get("LicenseShortName") or {}).get("value", ""),
        )
        if label is None:
            stats.reject(figure.file_title, "licence not permitted")
            figure.node.decompose()
            continue
        author = plain_author(extmeta)
        if not author:
            stats.reject(figure.file_title, "no named author")
            figure.node.decompose()
            continue

        source_title = commons_file_title(info["title"])
        sha1 = str(info.get("sha1") or "")
        recorded = pinned_sha1.get(source_title)
        if recorded and sha1 and recorded != sha1:
            stats.drifted.append(f"{source_title}: {recorded} -> {sha1}")
        attribution = {
            "sourceTitle": source_title,
            "sourceUrl": COMMONS_FILE_URL + source_title.replace(" ", "_"),
            "sha1": sha1,
            "author": author,
            "requiredCredit": required_credit(extmeta),
            "license": label,
            "licenseUrl": license_url(label),
            "caption": figure.caption,
        }

        if probe:
            selected.append((document_order[id(figure.node)], attribution, figure, None))
            figure.node.decompose()
            continue

        # Ask for a thumbnail whose LONGEST edge lands on the cap. MediaWiki
        # scales by width, so a tall figure asked for at 512 wide comes back
        # 512 x anything — a needless download and a needless downscale.
        width, height = int(info.get("width") or 0), int(info.get("height") or 0)
        request_width = MAX_IMAGE_EDGE_PX
        if height > width > 0:
            request_width = max(64, round(MAX_IMAGE_EDGE_PX * width / height))
        raw = fetch_thumbnail(info["title"], request_width)
        if raw is None:
            stats.reject(figure.file_title, "no thumbnail")
            figure.node.decompose()
            continue
        encoded = downscale_and_encode(raw, str(info.get("mime") or ""))
        if encoded is None:
            stats.reject(figure.file_title, "cannot meet the byte cap")
            figure.node.decompose()
            continue

        selected.append((document_order[id(figure.node)], attribution, figure, encoded))

    stats.accepted += len(selected)

    if probe:
        return {"title": title, "usable": len(selected)}

    if len(selected) < MIN_IMAGES_PER_PAGE:
        for _, _, figure, _ in selected:
            figure.node.decompose()
        return None

    accepted: list[dict[str, Any]] = []
    for index, (_, attribution, figure, encoded) in enumerate(sorted(selected, key=lambda s: s[0]), start=1):
        assert encoded is not None
        name = f"{slug}__{index}.{encoded.ext}"
        (out_dir / "images" / name).write_bytes(encoded.data)
        accepted.append(
            {
                "file": f"images/{name}",
                "width": encoded.width,
                "height": encoded.height,
                "bytes": len(encoded.data),
                "format": encoded.fmt,
                **attribution,
            }
        )
        # The figure becomes a bare image reference with an EMPTY alt: the
        # caption is the labeller's, not the page's.
        placeholder = soup.new_tag("p")
        placeholder.string = PLACEHOLDER.format(index=index)
        figure.node.replace_with(placeholder)

    # Anything still carrying an <img> is a figure that was rejected, an inline
    # icon or a rendered formula. None of them may reach the page: markdownify
    # would emit an absolute upload.wikimedia.org URL with alt text, which is
    # both an unattributed image and the caption leak this corpus exists to
    # avoid.
    #
    # The CAPTION containers go with them, and that half is not covered by
    # `figure, .thumb` — which is the mechanism by which captions belonging to
    # figures this build DROPPED shipped as body prose. Three shapes did it:
    #   * a panorama is `<div style=…><div class="thumbinner centered panorama">`
    #     with no `.thumb` anywhere, so decomposing the `<img>` left its
    #     `.thumbcaption` standing as a paragraph. `nuerburgring.md` ran a whole
    #     `### Streckenführungen` section consisting of "Start-und-Ziel-Gerade
    #     und Boxengasse des Nürburgrings. (Der schnurgerade Streckenabschnitt
    #     erscheint auf dem Bild…)" — prose referring to "dem Bild", about a
    #     picture that is not on the page;
    #   * `.dewiki-gallery` is a de.wikipedia template whose `-title` is a
    #     heading over its figures (`Baufortschritt des Eiffelturms`), and it is
    #     a caption whether or not one of those figures was vendored;
    #   * `.gallerycaption` / `.gallerytext`, for the same reason one rung down.
    # The guard cannot catch these on its own: it compares the body against the
    # 187 captions in the manifest, and a dropped figure has no manifest entry.
    for node in root.select(
        "figure, .thumb, .thumbinner, .thumbcaption, figcaption, "
        ".gallerycaption, .gallerytext, .dewiki-gallery-title, .dewiki-gallery-nav"
    ):
        node.decompose()
    for node in root.find_all("img"):
        node.decompose()

    body = to_markdown(root)
    for entry_index, entry in enumerate(accepted, start=1):
        body = body.replace(PLACEHOLDER.format(index=entry_index), f"![]({entry['file']})")
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    if "@@COMPENDIQ_IMAGE_" in body:
        # Loud, because the silent version is a manifest entry no page
        # references and an attribution nobody can trace back to a picture.
        raise RuntimeError(f"{title}: an image placeholder survived the conversion")
    markdown = f"# {title}\n\n{body}\n"

    if len(body) < MIN_PAGE_CHARS:
        for entry in accepted:
            (out_dir / entry["file"]).unlink(missing_ok=True)
        return None

    # `newline="\n"` on every committed-text write below: the default translates
    # `\n` to `os.linesep`, while `textSha256` (and the Vitest guard, which
    # hashes the file's raw bytes) is taken over the untranslated string. On
    # Windows the two would disagree for every page, and a first build would
    # report all 65 as drifted rather than reproduced.
    (out_dir / f"{slug}.md").write_text(markdown, encoding="utf8", newline="\n")
    return {
        "file": f"{slug}.md",
        "title": title,
        "titleSource": "wikipedia",
        "source": "wikipedia-de",
        "url": f"https://de.wikipedia.org/wiki/{title.replace(' ', '_')}",
        "revid": revid,
        # The revid pins the wikitext; this pins the PROSE. See the module
        # docstring: `oldid` renders through the live template set, so the
        # rendered text of a fixed revision moves on a template edit or a
        # MediaWiki upgrade, and without this a rebuild reports totals and
        # exits 0 while P5c's labels sit against text that has changed.
        "textSha256": hashlib.sha256(markdown.encode("utf8")).hexdigest(),
        "license": PAGE_LICENSE,
        "category": category,
        "images": accepted,
    }


MANIFEST_PURPOSE = (
    "German Wikipedia articles that carry figures, vendored downscaled and attributed for "
    "#1115's image retrieval eval. Page bodies deliberately carry no caption and no alt text: "
    "the captions live here, for the independent labeller. NOT part of CORPUS_DIRS - P5b wires "
    "the --images axis; adding it earlier would invalidate every recorded baseline."
)


def write_attribution(pages: list[dict[str, Any]], out_dir: Path) -> None:
    lines = [
        "# Image eval corpus — licences and attribution",
        "",
        "Everything in this directory is **third-party content**, vendored as a test fixture for",
        "#1115's image retrieval eval. It is **not** covered by this repository's AGPL-3.0 licence",
        "(see the root `LICENSE`), and nothing here ships in the product.",
        "",
        "## What you must do if you redistribute this directory",
        "",
        "- **Page text is CC BY-SA 4.0.** Each page below names its article, its URL and the exact",
        "  revision the text was taken from. The text was *adapted*: figure captions, alt text,",
        "  infoboxes, tables, footnotes and the apparatus sections were removed. Redistribution must",
        "  keep the attribution and must stay under CC BY-SA 4.0 — ShareAlike is not optional.",
        "- **Images keep their own licences**, which are not all the same and are not all the page's.",
        "  Each is listed with its Commons file, its author and its licence. CC BY and CC BY-SA",
        "  images require the credit below to travel with the image; CC BY-SA images",
        "  additionally require ShareAlike. CC0 and public-domain images carry no obligation, and are",
        "  credited anyway because the record is worth more than the minimum.",
        "- **Where a licensor specified the wording, the `Required credit` column is that wording,",
        "  verbatim, and it is the string to reproduce.** CC BY-SA 4.0 §3(a)(1)(A)(i) obliges",
        "  attribution \"in any reasonable manner requested by the Licensor\" and §3(a)(1)(B) the",
        "  retention of a supplied copyright notice; 3.0 says the same through \"Attribution Parties\".",
        "  Commons records that request as `Attribution`, and it is regularly not the bare name in",
        "  the `Author` column (`Bundesarchiv, Bild 183-85770-0002 / Junge, Peter Heinz /",
        "  CC-BY-SA 3.0`, `© Raimond Spekking / CC BY-SA 4.0 (via Wikimedia Commons)`). The `Author`",
        "  column is kept beside it rather than replaced, because it is regularly the FULLER of the",
        "  two — a derivative work's original author and its vectoriser, where the credit line names",
        "  only one. A `—` means Commons records no such requirement for that file.",
        "  The wording is recorded **as de.wikipedia renders it** — that is where the builder reads the",
        "  file's metadata — and a credit assembled by a Commons *template* arrives localised",
        "  (`Cezary p in der Wikipedia auf Polnisch`, which Commons itself renders as `Cezary p at",
        "  Polish Wikipedia`). Where the two differ, the canonical form is on the linked Commons file",
        "  page.",
        "- Images were **downscaled and re-encoded** (≤ 512 px longest edge, JPEG or PNG). That is a",
        "  modification, and is stated here rather than left to be inferred.",
        "",
        "Only CC0, public domain, CC BY x and CC BY-SA x were vendored. GFDL-only, NonCommercial,",
        "NoDerivatives, fair-use and unattributed files were rejected by the builder. Every credit",
        "below is a name Commons records: a file whose author is one of the unknown-author templates",
        "(`Autor/-in unbekannt`, `Anonym`, `Eigenes Werk`) was dropped rather than credited to a",
        "phrase, and Commons' `Credit` field is never read as an author because it is the *Source*.",
        "",
    ]
    if any(image["author"].endswith(AUTHOR_ABBREVIATED_MARK) for page in pages for image in page["images"]):
        lines += [
            f"A credit ending in `{AUTHOR_ABBREVIATED_MARK.strip()}` is abbreviated — the full list of",
            "contributors is on the linked Commons file page.",
            "",
        ]
    for page in pages:
        lines.append(f"## {page['title']}")
        lines.append("")
        lines.append(f"- Article: <{page['url']}>")
        lines.append(f"- Revision: `{page['revid']}`")
        lines.append(f"- Text: {PAGE_LICENSE}, text adapted")
        lines.append("")
        lines.append("| Image | Commons file | Author | Licence | Required credit |")
        lines.append("|---|---|---|---|---|")
        for image in page["images"]:
            author = image["author"].replace("|", "\\|")
            source = image["sourceTitle"].replace("|", "\\|")
            link = image["licenseUrl"]
            licence = f"[{image['license']}]({link})" if link else image["license"]
            credit = (image.get("requiredCredit") or "").replace("|", "\\|")
            credit_cell = f"`{credit}`" if credit else "—"
            lines.append(
                f"| `{image['file']}` | [{source}]({image['sourceUrl']}) | {author} | {licence} "
                f"| {credit_cell} |"
            )
        lines.append("")
    (out_dir / "LICENSE-ATTRIBUTION.md").write_text("\n".join(lines), encoding="utf8", newline="\n")


def write_readme(
    pages: list[dict[str, Any]], stats: BuildStats, total_bytes: int, out_dir: Path
) -> None:
    per_category: dict[str, int] = {}
    for page in pages:
        per_category[page["category"]] = per_category.get(page["category"], 0) + 1
    image_count = sum(len(page["images"]) for page in pages)
    rejections = stats.by_reason()
    reject_rows = "\n".join(f"| {reason} | {count} |" for reason, count in rejections.items())

    (out_dir / "README.md").write_text(
        f"""# German image-bearing eval corpus (#1115 P5a)

{len(pages)} German Wikipedia articles carrying {image_count} vendored images
({total_bytes / 1024 / 1024:.2f} MB), built by `tools/eval-corpus-images/build.py`.

| Shape | Pages | What it is |
|---|---|---|
| `technical` | {per_category.get('technical', 0)} | engineering diagrams and schematics |
| `science` | {per_category.get('science', 0)} | labelled scientific figures |
| `process` | {per_category.get('process', 0)} | process, lifecycle and network notation |
| `photo` | {per_category.get('photo', 0)} | photographs of things and places |

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
asks for the committed revision rather than whatever the article says today.
That is where the pinning starts and not where it ends, because a revid does
**not** pin the prose: `action=parse&oldid=` renders that revision's wikitext
through the *current* template set and parser, so a template edit or a MediaWiki
release moves the text of a page nobody edited. So each page also records a
`textSha256` over the Markdown it produced, and a rebuild that renders different
bytes names the page and exits non-zero.

The images need a third pin, because Commons serves the current version of a
file and an upstream re-draw would otherwise change a "pinned" rebuild silently:
each image records the upstream `sha1`, and a run that finds one moved names the
file and exits non-zero. A fourth check covers what none of them can — whether a
figure is still *usable* — by diffing this build's inventory against the
committed manifest.

Nothing here may be hand-edited. The builder regenerates the whole directory
into a staging sibling and swaps it in only on success, and
`corpus-de-images.test.ts` fails on a manifest that has drifted from the files
beside it — including a page body whose sha256 no longer matches.

## What the licence filter rejected on this build

The articles carry **{stats.candidates}** captioned figures between them. A page
contributes at most {MAX_IMAGES_PER_PAGE}, so the filter ran on **{stats.examined}**
of them and refused **{len(stats.rejections)}**. The larger number is not the
filter's denominator and is not quoted as one.

| Reason | Figures |
|---|---|
{reject_rows}
""",
        encoding="utf8",
        newline="\n",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="move to current revisions")
    parser.add_argument(
        "--probe",
        action="store_true",
        help="report an UPPER BOUND on usable figures per article (it stops before the download "
        "and the re-encode, so two rejection reasons have not run); write nothing",
    )
    parser.add_argument("--only", default=None, help="comma-separated article titles, for probing")
    parser.add_argument(
        "--articles",
        default=None,
        help="an alternative article list, for probing candidates before they join articles.yaml",
    )
    args = parser.parse_args()

    # Both flags subset the article list, and a subset written over the whole
    # corpus is a corpus of one page — with every other article's revision
    # pins deleted, so the next plain run silently re-pins them at CURRENT
    # revisions and every label written against them goes stale. They are
    # documented as probing tools; this is what makes them so.
    if (args.only or args.articles) and not args.probe:
        parser.error(
            "--only and --articles subset the article list, so they only make sense with --probe. "
            "Without it the run would replace the whole vendored corpus with the subset."
        )

    articles = load_articles(Path(args.articles) if args.articles else TOOL_DIR / "articles.yaml")
    if args.only:
        wanted = {name.strip() for name in args.only.split(",")}
        articles = [entry for entry in articles if entry[0] in wanted]

    manifest = read_manifest()
    pins = {} if args.update else read_pins(manifest)
    pinned_sha1 = {} if args.update else read_image_sha1s(manifest)
    stats = BuildStats()

    out_dir = STAGING_DIR
    if not args.probe:
        if STAGING_DIR.exists():
            shutil.rmtree(STAGING_DIR)
        (STAGING_DIR / "images").mkdir(parents=True)

    pages: list[dict[str, Any]] = []
    thin: list[str] = []
    failed: list[str] = []
    # Two articles slugging to the same name would silently overwrite each
    # other's images, and only the page collision would surface downstream.
    seen_slugs: dict[str, str] = {}

    for title, category in articles:
        try:
            resolved, current = resolve_revision(title)
            slug = slugify(resolved)
            if slug in seen_slugs and seen_slugs[slug] != resolved:
                raise RuntimeError(f"slug collision: {resolved!r} and {seen_slugs[slug]!r} both give {slug!r}")
            seen_slugs[slug] = resolved
            revid = pins.get(resolved, current)
            if not args.update and resolved not in pins and pins:
                # Absent from the pins and the manifest was not empty: either a
                # genuinely new article, or one whose title moved upstream (a
                # rename, a re-pointed redirect) — indistinguishable here, and
                # both mean this page is being built at the CURRENT revision
                # while the run advertises itself as reproducing the pinned
                # ones. Silence was the bug.
                print(
                    f"  ! {title}: no pinned revision for {resolved!r}; building at the current "
                    f"revision {current}. New article, or renamed upstream — check before "
                    f"committing, because its labels were written against the old text.",
                    file=sys.stderr,
                )
            result = build_page(resolved, category, revid, stats, args.probe, out_dir, pinned_sha1)
        except Exception as error:  # noqa: BLE001 - report every bad article, then refuse to swap
            print(f"  ! {title}: {error}", file=sys.stderr)
            failed.append(f"{category}/{title}: {error}")
            continue
        if args.probe:
            usable = result["usable"] if result else 0
            # An UPPER BOUND, and the flag says so when it matters. `build_page`
            # returns before the download and the re-encode under `--probe`, so
            # the two rejections that can only be known by trying — `no
            # thumbnail` and `cannot meet the byte cap` — have not run. An
            # article probed at exactly the floor can therefore still ship at
            # one figure and be dropped by the full build.
            flag = "THIN" if usable < MIN_IMAGES_PER_PAGE else ("ok? " if usable == MIN_IMAGES_PER_PAGE else "ok  ")
            print(f"{flag} {category:10s} {resolved:45s} {usable}")
            continue
        if result is None:
            thin.append(f"{category}/{title}")
            print(f"  - {title}: fewer than {MIN_IMAGES_PER_PAGE} usable figures — dropped")
            continue
        pages.append(result)
        print(f"  + {result['file']:40s} {len(result['images'])} images  rev {revid}")

    if args.probe:
        print(
            "\nCounts are an UPPER BOUND: a probe stops before the thumbnail fetch and the "
            f"re-encode, so `no thumbnail` and `cannot meet the byte cap` have not run. `ok?` "
            f"marks an article sitting exactly on the {MIN_IMAGES_PER_PAGE}-figure floor, which a "
            "full build can still drop.",
            file=sys.stderr,
        )
        return 0

    # Refuse BEFORE anything is swapped in. A run that lost articles to a flaky
    # network would otherwise write a thinner corpus, restate it as fact in the
    # generated README, delete the pins of the pages it never rebuilt, and exit
    # 0 — the failure `api_get`'s "give up loudly rather than half-building a
    # corpus" exists to prevent, one layer up.
    if failed or not pages:
        for entry in failed:
            print(f"! {entry}", file=sys.stderr)
        print(
            f"! {len(failed)} article(s) failed and {len(pages)} page(s) built — the vendored "
            f"corpus is untouched. Staging left at {STAGING_DIR} for inspection.",
            file=sys.stderr,
        )
        return 1

    pages.sort(key=lambda page: page["file"])
    total_bytes = sum(image["bytes"] for page in pages for image in page["images"])

    (out_dir / "MANIFEST.json").write_text(
        json.dumps(
            {
                "generatedBy": "tools/eval-corpus-images/build.py",
                "purpose": MANIFEST_PURPOSE,
                "pages": pages,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf8",
        newline="\n",
    )
    write_attribution(pages, out_dir)
    write_readme(pages, stats, total_bytes, out_dir)

    if CORPUS_DIR.exists():
        shutil.rmtree(CORPUS_DIR)
    os.replace(out_dir, CORPUS_DIR)

    print()
    print(f"pages            {len(pages)}")
    print(f"images           {sum(len(page['images']) for page in pages)}")
    print(f"image bytes      {total_bytes} ({total_bytes / 1024 / 1024:.2f} MB)")
    print(f"budget           {TOTAL_BYTE_BUDGET / 1024 / 1024:.0f} MB")
    print(f"figures seen     {stats.candidates}")
    print(f"figures examined {stats.examined}")
    print(f"figures rejected {len(stats.rejections)} {stats.by_reason()}")
    if thin:
        print(f"articles dropped {len(thin)}: {', '.join(thin)}")

    exit_code = 0
    if total_bytes > TOTAL_BYTE_BUDGET:
        print("! over the image budget", file=sys.stderr)
        exit_code = 1
    if stats.drifted and not args.update:
        # The bytes ARE written — a diff you can look at is more use than a
        # refusal — but this run did not reproduce the corpus, and saying so is
        # the whole point of recording the sha1.
        print(file=sys.stderr)
        print(f"! {len(stats.drifted)} upstream file(s) changed since the recorded sha1:", file=sys.stderr)
        for entry in stats.drifted:
            print(f"!   {entry}", file=sys.stderr)
        print("! this rebuild is NOT a reproduction of the committed bytes.", file=sys.stderr)
        exit_code = 1
    if not args.update:
        moved = text_drift(manifest, pages)
        if moved:
            # Same rule as the sha1 branch, for the half a revid cannot pin.
            print(file=sys.stderr)
            print(f"! {len(moved)} page(s) rendered different text at the pinned revision:", file=sys.stderr)
            for entry in moved:
                print(f"!   {entry}", file=sys.stderr)
            print(
                "! this rebuild is NOT a reproduction of the committed text. `oldid` renders through "
                "the CURRENT template set: a template edit or a MediaWiki upgrade moved the prose. "
                "Read the diff and re-label before committing.",
                file=sys.stderr,
            )
            exit_code = 1
        lost = lost_since(manifest, pages)
        if lost:
            # Same rule as the sha1 branch, for the half a sha1 cannot see: the
            # bytes are written so the diff is inspectable, and the run stops
            # claiming to have reproduced the corpus.
            print(file=sys.stderr)
            print(f"! {len(lost)} item(s) in the committed manifest are absent from this build:", file=sys.stderr)
            for entry in lost:
                print(f"!   {entry}", file=sys.stderr)
            print(
                "! this rebuild is NOT a reproduction of the committed corpus. Commons metadata is "
                "live: a licence, an author field or a thumbnail moved. Re-label before committing.",
                file=sys.stderr,
            )
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
