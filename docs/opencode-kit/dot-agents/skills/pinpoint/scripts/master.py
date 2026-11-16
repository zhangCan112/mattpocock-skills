#!/usr/bin/env python3
"""
pinpoint - The markdown master format: parsing, serialization, projection.

Under the C route (issue 0004) the truth source is a markdown master
document (`.pinpoint/docs/<name>.md`). Annotations are marker LINES in it:

    <!-- pp: note -->      block-level: annotates the block below
    <!-- pp@N: note -->    line-level: annotates the Nth content line of
                           the fenced block below (1-based, blanks count)

Markers sit on their own lines directly above the block they annotate
(several markers may precede one block: one block note + line notes).
Marker lines are structurally transparent: they never split or merge
blocks, so the master minus all marker lines is plain markdown in the
subset render.py supports - which is also the clean export (0008).

The module surface (format layer for the server, issue 0013):

    parse_master(text)      -> [MasterBlock]  markers + render.Blocks
    serialize_master(block) -> master markdown (inverse of parse)
    projection(text)        -> editor HTML body: render.py's rendering
                               with markers translated into
                               data-edit-target / data-edit-annotation
                               attributes (block note -> the block
                               element, pp@N -> the Nth span.line or
                               div.line inside it)

Dependencies: markdown, beautifulsoup4 - auto-installed via
server_common.import_or_install (same mechanism as render.py).
"""

import re
import xml.etree.ElementTree as ET
from collections import namedtuple
from typing import Any, Optional

from server_common import import_or_install

import_or_install('markdown')
import_or_install('bs4', 'beautifulsoup4')

from bs4 import BeautifulSoup

import render
from render import Block
from annotations import ATTR_ANNOTATION, ATTR_TARGET, parse_doc_text

MasterBlock = namedtuple('MasterBlock', 'markers block')
Marker = namedtuple('Marker', 'kind line note')


class MasterError(Exception):
    """Refused master input or unrepresentable block/markers."""


# Mirrors render._FENCE_RE; kept local so render's private names stay private.
_FENCE_LINE_RE = re.compile(r'^(```|~~~)\s*(\S*)\s*$')

# A marker is a whole line: optional indent, an HTML comment holding
# `pp:` (block) or `pp@N:` (line) plus the note. The note may not
# contain `-->` (tempered dot), so a comment ending early is just text.
_MARKER_RE = re.compile(r'^\s*<!--\s*pp(?:@(\d+))?:\s*((?:(?!-->).)*?)-->\s*$')


def _match_marker(line: str) -> Optional[Marker]:
    match = _MARKER_RE.match(line)
    if match is None:
        return None
    note = match.group(2).strip()
    if match.group(1) is not None:
        return Marker('line', int(match.group(1)), note)
    return Marker('block', None, note)


def _validate(markers: list[Marker], block: Block) -> None:
    """Reject marker sets that cannot be represented in the projection.

    A block carries at most one block note (one data-edit-annotation
    attribute) and any number of line notes with distinct line numbers.
    Line notes only make sense on fenced blocks, within the fence.
    """
    seen_lines = set()
    block_notes = 0
    for marker in markers:
        if marker.kind == 'block':
            block_notes += 1
            if block_notes > 1:
                raise MasterError(
                    'block carries more than one block note: '
                    f'{marker.note!r}'
                )
            continue
        if marker.line < 1:
            raise MasterError(f'line note numbers start at 1: pp@{marker.line}')
        if block.kind != 'code':
            raise MasterError(
                f'line note pp@{marker.line} needs a fenced block below, '
                f'not a {block.kind} block'
            )
        if marker.line > len(block.lines):
            raise MasterError(
                f'line note pp@{marker.line} past the end of the fence '
                f'({len(block.lines)} lines)'
            )
        if marker.line in seen_lines:
            raise MasterError(
                f'two notes target fence line {marker.line}'
            )
        seen_lines.add(marker.line)


def parse_master(text: str) -> list[MasterBlock]:
    """Parse a master markdown document into blocks carrying their markers.

    Marker lines are recognized outside fences only, and are transparent
    to the block structure: the block sequence equals render.split_blocks
    over the master with all marker lines removed. Each run of markers
    attaches to the first block that follows it (blank lines in between
    are tolerated; serialization writes them flush above the block).
    """
    if text.startswith('\ufeff'):
        text = text[1:]
    lines = text.replace('\r\n', '\n').split('\n')

    pending: list[Marker] = []
    flushes: list[tuple] = []  # (clean-line index of block start, markers)
    clean: list[str] = []
    in_fence = False
    for line in lines:
        if in_fence:
            clean.append(line)
            if _FENCE_LINE_RE.match(line):
                in_fence = False
            continue
        marker = _match_marker(line)
        if marker is not None:
            pending.append(marker)
            continue
        if not line.strip():
            clean.append(line)
            continue
        if pending:
            flushes.append((len(clean), pending))
            pending = []
        clean.append(line)
        if _FENCE_LINE_RE.match(line):
            in_fence = True
    if pending:
        raise MasterError('marker at end of document annotates nothing')

    # Piece j (j >= 1) starts at the j-th marked block's first line, so
    # its first split block is that marked block. Piece 0 is the unmarked
    # prefix. Cut points are block starts by construction, so no block
    # straddles a piece boundary.
    edges = [0] + [idx for idx, _ in flushes] + [len(clean)]
    doc: list[MasterBlock] = []
    for j in range(len(edges) - 1):
        piece = '\n'.join(clean[edges[j]:edges[j + 1]])
        piece_blocks = render.split_blocks(piece)
        if j > 0:
            if not piece_blocks:  # unreachable: flushes happen at content
                raise MasterError('marker annotates no block')
            _validate(flushes[j - 1][1], piece_blocks[0])
            doc.append(MasterBlock(list(flushes[j - 1][1]), piece_blocks[0]))
            piece_blocks = piece_blocks[1:]
        doc.extend(MasterBlock([], b) for b in piece_blocks)
    return doc


def _check_note(note: str) -> None:
    """Marker lines are single-line HTML comments: notes must fit inside."""
    if '\n' in note or '\r' in note:
        raise MasterError('marker notes are single-line')
    if '-->' in note:
        raise MasterError("marker notes cannot contain '-->'")


def _marker_line(marker: Marker) -> str:
    _check_note(marker.note)
    if marker.kind == 'block':
        return f'<!-- pp: {marker.note} -->'
    return f'<!-- pp@{marker.line}: {marker.note} -->'


def _block_source(block: Block) -> list[str]:
    """The markdown lines a block was parsed from (split_blocks' inverse)."""
    if block.kind == 'code':
        if '\n' in block.lang or '\r' in block.lang:
            raise MasterError('fence language is a single word')
        for line in block.lines:
            if _FENCE_LINE_RE.match(line):
                raise MasterError(
                    'code line is fence-shaped and cannot live in a fence'
                )
        return [f'```{block.lang}'] + list(block.lines) + ['```']
    return list(block.lines)


def serialize_master(blocks: list[MasterBlock]) -> str:
    """Serialize blocks + markers back to master markdown (parse's inverse).

    Canonical form: markers sit flush above their block, blocks are
    separated by one blank line, the file ends with a newline. The same
    representation rules as parse apply, so serialize(parse(x)) output
    can always be parsed again.
    """
    pieces = []
    for master_block in blocks:
        _validate(master_block.markers, master_block.block)
        lines = [_marker_line(m) for m in master_block.markers]
        lines.extend(_block_source(master_block.block))
        pieces.append('\n'.join(lines))
    if not pieces:
        return ''
    return '\n\n'.join(pieces) + '\n'


def _elements(container: Any) -> list:
    """Descendant elements of a rendered block in document order (works
    for the bs4 Tags of the projection and the ElementTree Elements of
    the server)."""
    if hasattr(container, 'find_all'):  # bs4 Tag
        return container.find_all(True)
    return list(container.iter())  # ElementTree Element


def _line_elements(container: Any) -> list:
    """The container's class="line" elements in document order (span.line
    in code fences, div.line in diagram figures)."""
    lines = []
    for el in _elements(container):
        classes = el.get('class') or []
        if isinstance(classes, str):
            classes = classes.split()
        if 'line' in classes:
            lines.append(el)
    return lines


def line_rank(container: Any, el: Any) -> Optional[int]:
    """1-based rank of el among container's class="line" elements - the N
    that a pp@N marker addresses; None when el is not a line element
    inside container. The single definition of the "line" concept, shared
    by the marker translation (projection), the server's temp-id mapping,
    and legacy migration.
    """
    return line_rank_in([container], el)


def line_rank_in(containers: list, el: Any) -> Optional[int]:
    """1-based rank of el among the class="line" elements of several
    containers - the pieces one master block rendered to. line_rank is
    the single-container case; the server's temp-id mapping counts
    through this definition so a pp@N marker and the temp id of the
    line it annotates agree on N even for a multi-element block.
    """
    rank = 0
    for container in containers:
        for candidate in _line_elements(container):
            rank += 1
            if candidate is el:
                return rank
    return None


def _annotate_block(html: str, markers: list[Marker]) -> str:
    """Translate markers into annotation attributes on one rendered block.

    Block notes go on the block element itself; pp@N goes on the Nth
    element with class="line" (span.line in code blocks, div.line in
    diagram figures), in document order. The result is re-serialized
    through render's normalizer so projection output keeps the same
    XML-safety guarantees as render_blocks.
    """
    soup = BeautifulSoup(html, 'html.parser')
    block_el = soup.find(True)
    if block_el is None:
        raise MasterError('block rendered to no element')
    for marker in markers:
        if marker.kind == 'block':
            block_el[ATTR_TARGET] = 'true'
            block_el[ATTR_ANNOTATION] = marker.note
            continue
        lines = _line_elements(block_el)
        if marker.line > len(lines):  # unreachable: parse validates
            raise MasterError(f'line note pp@{marker.line} has no line')
        target = lines[marker.line - 1]
        target[ATTR_TARGET] = 'true'
        target[ATTR_ANNOTATION] = marker.note
    return render.normalize_html_fragment(str(soup))


def _element_count(block_html: str) -> int:
    """How many element children a block's HTML contributes to the body."""
    if not block_html.strip():
        return 0
    try:
        root = parse_doc_text(f'<body>{block_html}</body>')
    except ET.ParseError as exc:
        raise MasterError(f'block rendered to unparseable HTML: {exc}') from exc
    return len(list(root))


def projection_blocks(master_text: str) -> tuple:
    """Render a master document, tracking which body children each block
    rendered to.

    Returns ``(html, spans)``: ``html`` is projection()'s body, and
    ``spans`` holds, per master block, the ``(start, end)`` range of the
    body's element children it produced. The ranges are contiguous,
    ordered, and together cover every child - but a block may own zero
    children (a lone link-reference definition renders to nothing) or
    several (a paragraph run containing a quote or raw HTML splits into
    p/blockquote, p/div/p, ...). Callers that translate element ids back
    to master block indexes must go through these spans; the body's
    children do NOT correspond 1:1 to parse_master blocks.
    """
    parts = []
    spans = []
    count = 0
    for master_block in parse_master(master_text):
        html = render.render_block(master_block.block)
        if master_block.markers:
            html = _annotate_block(html, master_block.markers)
        parts.append(html)
        block_count = _element_count(html)
        spans.append((count, count + block_count))
        count += block_count
    return '\n'.join(parts), spans


def projection(master_text: str) -> str:
    """Render a master document to the editor's projection HTML body.

    Marker lines never appear in the output; each becomes annotation
    attributes on the block element (block note) or on the addressed
    content line (pp@N). A master without markers renders exactly like
    render.render_blocks over the same text.
    """
    return projection_blocks(master_text)[0]


if __name__ == '__main__':
    raise SystemExit('master.py is a library module (used by server.py)')
