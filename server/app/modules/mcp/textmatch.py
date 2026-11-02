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


def explain_miss(text: str, needle: str) -> str:
    """Почему фрагмент не нашёлся — одной фразой для агента: что именно не совпало и где ближайшее место."""
    import difflib
    import re

    flat_text, flat_needle = re.sub(r"\s+", " ", text), re.sub(r"\s+", " ", needle).strip()
    if flat_needle and flat_needle in flat_text:
        return "Текст есть, но отличаются переносы строк или число пробелов: берите кусок внутри одной строки"
    if flat_needle and flat_needle.casefold() in flat_text.casefold():
        return "Текст есть, но отличается регистр букв"
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    first = next((line.strip() for line in needle.splitlines() if line.strip()), "")
    near = difflib.get_close_matches(first, lines, n=1, cutoff=0.6) if first else []
    return f"Ближайшее похожее место: «{near[0][:160]}»" if near else "Похожих мест не нашлось: перечитайте материал (read_item)"
