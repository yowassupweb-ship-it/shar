"""Conservative fallback for text copied from a visually formatted document."""

from __future__ import annotations


_SAME_LOOK = str.maketrans({
    "\u00a0": " ", "\u202f": " ", "\u2007": " ",
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u00ab": '"', "\u00bb": '"',
})


def spans(text: str, needle: str) -> tuple[list[tuple[int, int]], str]:
    """Prefer literal matches; only then try one-to-one visual equivalents.

    Positions always refer to the original string, so edits preserve all unrelated bytes.
    Callers must reject multiple matches unless replace_all was requested.
    """
    positions: list[tuple[int, int]] = []
    start = text.find(needle)
    while start >= 0:
        positions.append((start, start + len(needle)))
        start = text.find(needle, start + len(needle))
    if positions:
        return positions, "exact"
    visual_text, visual_needle = text.translate(_SAME_LOOK), needle.translate(_SAME_LOOK)
    if visual_needle == needle and visual_text == text:
        return [], "exact"
    start = visual_text.find(visual_needle)
    while start >= 0:
        positions.append((start, start + len(needle)))
        start = visual_text.find(visual_needle, start + len(needle))
    return positions, "typographic" if positions else "exact"
