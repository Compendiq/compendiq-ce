#!/usr/bin/env python3
"""Unit tests for the pure text transforms and the image-drift check in `build.py`.

Stdlib `unittest`, deliberately: `requirements.txt` is pinned to what the
committed corpus was built with because Pillow's encoders decide output bytes,
and adding a test runner to that file would put a dependency nobody builds with
into the list that documents what the bytes came from. Run it from the same
venv as the builder — `build.py` imports requests/Pillow/bs4/markdownify/yaml
at module scope:

    .venv/bin/python -m unittest discover -s tools/eval-corpus-images

`drop_orphan_markers` is the one worth pinning here. It is a regex sweep over
the WHOLE rendered page, its subject is "a marker whose subject was stripped",
and its failure mode is silent: a deleted line inside a code sample moves the
page under a `textSha256` that only ever reports *that* the text moved.

`committed_image_digests` / `image_drift` are the other: the only check that
sees an image re-encoded to different bytes while every recorded field stays
put. They run against real files in a temp directory, swap included.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from build import committed_image_digests, drop_orphan_markers, image_drift, lost_since


class DropOrphanMarkers(unittest.TestCase):
    def test_drops_marker_only_lines_in_prose(self):
        for marker in ["1", "12", "2)", "(3)", "*", "\\*", "**", "†", "‡"]:
            with self.subTest(marker=marker):
                # The line goes entirely — it is not blanked — because
                # `drop_empty_headings` counts content lines after this runs.
                self.assertEqual(
                    drop_orphan_markers(f"Vorher\n{marker}\nNachher"),
                    "Vorher\nNachher",
                )

    def test_leaves_prose_alone(self):
        # `a)` is plausible prose and is deliberately not in the pattern; a line
        # that merely STARTS with a marker is a sentence, not an orphan.
        md = "Der TCP-Header\na)\n1. Schritt\n1 Byte\nAbschnitt"
        self.assertEqual(drop_orphan_markers(md), md)

    def test_keeps_marker_shaped_lines_inside_a_fence(self):
        md = "\n".join(["Beispiel", "```", "1", "*", "2)", "```", "Danach"])
        self.assertEqual(drop_orphan_markers(md), md)

    def test_keeps_them_inside_a_fence_with_an_info_string(self):
        md = "\n".join(["Beispiel", "```python", "1", "```", "Danach"])
        self.assertEqual(drop_orphan_markers(md), md)

    def test_resumes_dropping_after_the_fence_closes(self):
        md = "\n".join(["```", "1", "```", "Zwischentext", "2", "Ende"])
        self.assertEqual(
            drop_orphan_markers(md),
            "\n".join(["```", "1", "```", "Zwischentext", "Ende"]),
        )

    def test_handles_more_than_one_fence(self):
        md = "\n".join(["```", "1", "```", "*", "```", "2", "```"])
        self.assertEqual(
            drop_orphan_markers(md),
            "\n".join(["```", "1", "```", "```", "2", "```"]),
        )

    def test_an_unclosed_fence_exempts_the_rest(self):
        # The safe direction: a page whose fence never closes is malformed, and
        # keeping a line that might be code beats deleting one that is.
        md = "\n".join(["Text", "```", "1", "*"])
        self.assertEqual(drop_orphan_markers(md), md)

    def test_indented_fences_still_toggle(self):
        md = "\n".join(["- Liste", "  ```", "  1", "  ```", "2"])
        self.assertEqual(
            drop_orphan_markers(md),
            "\n".join(["- Liste", "  ```", "  1", "  ```"]),
        )


def image_entry(file: str, data: bytes) -> dict:
    # Every field the manifest records about an image, held identical between
    # the committed and rebuilt sides so only the bytes on disk can differ.
    return {
        "file": file,
        "width": 512,
        "height": 384,
        "bytes": len(data),
        "format": "png",
        "sourceTitle": "File:Beispiel.png",
        "sha1": "0123456789abcdef0123456789abcdef01234567",
    }


def page(file: str, images: list[dict]) -> dict:
    return {"file": file, "images": images}


class ImageDrift(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.corpus = self.root / "corpus"
        self.staging = self.root / "corpus.staging"

    def write(self, base: Path, files: dict[str, bytes]) -> None:
        for name, data in files.items():
            path = base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def swap(self) -> None:
        # What `main` does: the committed directory goes, staging takes its name.
        shutil.rmtree(self.corpus)
        os.replace(self.staging, self.corpus)

    def test_same_sized_bytes_with_unchanged_metadata_are_drift(self):
        old, new = b"\x89PNG\r\n\x1a\nAAAA", b"\x89PNG\r\n\x1a\nAAAB"
        self.assertEqual(len(old), len(new))
        name = "images/seite__1.png"
        self.write(self.corpus, {name: old})
        self.write(self.staging, {name: new})
        manifest = {"pages": [page("seite.md", [image_entry(name, old)])]}
        built = [page("seite.md", [image_entry(name, new)])]
        self.assertEqual(manifest["pages"], built)  # nothing recorded differs

        drift = image_drift(committed_image_digests(manifest, self.corpus), built, self.staging)

        self.assertEqual(len(drift), 1)
        self.assertIn(name, drift[0])
        self.assertIn(hashlib.sha256(old).hexdigest()[:12], drift[0])
        self.assertIn(hashlib.sha256(new).hexdigest()[:12], drift[0])
        self.assertEqual(lost_since(manifest, built), [])

    def test_identical_bytes_are_not_drift(self):
        data = b"\xff\xd8\xff\xe0jpeg"
        name = "images/seite__1.jpg"
        self.write(self.corpus, {name: data})
        self.write(self.staging, {name: data})
        manifest = {"pages": [page("seite.md", [image_entry(name, data)])]}

        snapshot = committed_image_digests(manifest, self.corpus)

        self.assertEqual(snapshot, {name: hashlib.sha256(data).hexdigest()})
        self.assertEqual(image_drift(snapshot, manifest["pages"], self.staging), [])

    def test_snapshot_survives_the_swap(self):
        name_a, name_b = "images/seite__1.png", "images/seite__2.png"
        self.write(self.corpus, {name_a: b"committed-a", name_b: b"committed-b"})
        self.write(self.staging, {name_a: b"committed-a", name_b: b"rebuilt-bb"})
        manifest = {"pages": [page("seite.md", [image_entry(name_a, b""), image_entry(name_b, b"")])]}

        snapshot = committed_image_digests(manifest, self.corpus)
        self.swap()

        self.assertFalse(self.staging.exists())
        self.assertEqual((self.corpus / name_b).read_bytes(), b"rebuilt-bb")
        drift = image_drift(snapshot, manifest["pages"], self.corpus)
        self.assertEqual(len(drift), 1)
        self.assertTrue(drift[0].startswith(f"{name_b} "))

    def test_first_build_has_nothing_to_compare(self):
        # No committed corpus at all: `read_manifest` answers an empty manifest.
        self.assertFalse(self.corpus.exists())
        snapshot = committed_image_digests({"pages": []}, self.corpus)
        self.assertEqual(snapshot, {})

        name = "images/neu__1.png"
        self.write(self.staging, {name: b"brand new"})
        self.assertEqual(image_drift(snapshot, [page("neu.md", [image_entry(name, b"")])], self.staging), [])

    def test_new_images_beside_committed_ones_are_not_drift(self):
        kept, added, other = "images/seite__1.png", "images/seite__2.png", "images/andere__1.png"
        self.write(self.corpus, {kept: b"kept"})
        self.write(self.staging, {kept: b"kept", added: b"added", other: b"other"})
        manifest = {"pages": [page("seite.md", [image_entry(kept, b"")])]}
        built = [
            page("seite.md", [image_entry(kept, b""), image_entry(added, b"")]),
            page("andere.md", [image_entry(other, b"")]),
        ]

        self.assertEqual(image_drift(committed_image_digests(manifest, self.corpus), built, self.staging), [])

    def test_images_no_longer_built_are_lost_not_drift(self):
        kept, gone = "images/seite__1.png", "images/seite__2.png"
        self.write(self.corpus, {kept: b"kept", gone: b"gone"})
        self.write(self.staging, {kept: b"kept"})
        manifest = {"pages": [page("seite.md", [image_entry(kept, b""), image_entry(gone, b"")])]}
        built = [page("seite.md", [image_entry(kept, b"")])]

        snapshot = committed_image_digests(manifest, self.corpus)

        self.assertIn(gone, snapshot)
        self.assertEqual(image_drift(snapshot, built, self.staging), [])
        lost = lost_since(manifest, built)
        self.assertEqual(len(lost), 1)
        self.assertIn(gone, lost[0])

    def test_listed_image_missing_from_disk_is_skipped(self):
        present, missing = "images/seite__1.png", "images/seite__2.png"
        self.write(self.corpus, {present: b"present"})
        manifest = {"pages": [page("seite.md", [image_entry(present, b""), image_entry(missing, b"")])]}

        self.assertEqual(set(committed_image_digests(manifest, self.corpus)), {present})


if __name__ == "__main__":
    unittest.main()
