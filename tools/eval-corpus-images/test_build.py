#!/usr/bin/env python3
"""Unit tests for the pure text transforms in `build.py`.

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
"""

from __future__ import annotations

import unittest

from build import drop_orphan_markers


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


if __name__ == "__main__":
    unittest.main()
