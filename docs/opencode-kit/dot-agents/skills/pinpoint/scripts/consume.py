#!/usr/bin/env python3
"""
pinpoint - consume: reconcile the baseline snapshot against the master doc.

The C route (issue 0004) keeps the truth source in a markdown master doc
(``.pinpoint/docs/<name>.md``) where annotations are marker lines. The main
session edits the master directly; ``consume`` is the write-back step that
turns those edits into acks:

    python scripts/consume.py <doc-name> [--workspace DIR]
                                       [--explain b<N>=<text> ...]

Flow (issue 0012; semantics ported from the prototype on branch
prototype/0004-consume-interface):

1.  Read the master and its baseline snapshot
    (``.pinpoint/state/<name>.base.md``). No baseline (first run) creates
    one from the current master and reports "nothing to reconcile".
2.  Reconcile baseline -> master: blocks are re-anchored by LCS over
    content keys; unpaired leftovers pair in order (changed content = the
    same block updated, inheriting identity and markers); marker
    reconciliation drives acks - marker removed = ack, content changed +
    marker removed = fix-and-ack, marker still present = still pending.
    Line notes align old->new fence lines by content (line-level LCS +
    in-order gap pairing), so a note is judged on ITS line: an unrelated
    insertion above it never acks it, and a marker that moved with its
    line stays pending.
3.  Red-line (issue 0009): a block carrying an unresolved marker that
    disappears without a pair refuses the WHOLE submission; nothing is
    written and the error teaches the correct pattern.
4.  Every ack appends an ``annotation_applied`` record to
    ``.pinpoint/annotations.jsonl`` (shape {ts, file, element_id, action,
    old, new}, like the server's records). The optional repeatable
    ``--explain b<N>=<text>`` flag is the explanation channel for notes
    resolved without a content change (0004: 解释文本进审计): on a pure
    ack the text is attached to that record as an ``explain`` field
    (chosen over overloading ``new``, which means "new content"); refs
    that match no plain ack are reported on stderr and never fail the
    round. Line refs (``@N``) are not keyable - line numbers are
    ambiguous across blocks - so only element ids are accepted.
5.  On success the master is rewritten only if canonical serialization
    differs from the file (normalization), and the baseline snapshot is
    always updated to the reconciled master.

Element ids: the master format has no persistent block ids, so consume
labels blocks ``b<N>`` (N = 1-based position in the baseline snapshot);
new blocks continue the numbering. Ids are per-round labels, not anchors
(0004: anchors are content keys).

Exit codes: 0 success (including "nothing to reconcile"), 1 on errors
(missing doc, unparseable master, red-line refusal).

Dependencies: master.py (which pulls render.py -> markdown/bs4 via
server_common.import_or_install).
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Optional

from master import MasterBlock, MasterError, parse_master, serialize_master
from render import Block
from server_common import write_text_lf

DOCS_DIR_NAME = 'docs'
STATE_DIR_NAME = 'state'
BASE_SUFFIX = '.base.md'
ANNOTATION_LOG_NAME = 'annotations.jsonl'


# ---------------------------------------------------------------------------
# Prototype ports: content keys, LCS anchoring, marker reconciliation
# ---------------------------------------------------------------------------

def content_key(block: Block) -> str:
    """The LCS anchor key of a block (prototype blockContentKey)."""
    return f'{block.kind}|{block.lang}|' + '\n'.join(block.lines)


def lcs_pairs(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    """Pair equal keys with a longest-common-subsequence walk
    (prototype lcsPairs; identical tie-breaking: prefer advancing in a)."""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if a[i] == b[j]:
                dp[i][j] = dp[i + 1][j + 1] + 1
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])
    pairs = []
    i = j = 0
    while i < n and j < m:
        if a[i] == b[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def _block_text(block: Block) -> str:
    return '\n'.join(block.lines)


class ReconcileResult:
    """Events (one stdout line each), ack records, red-line violations."""

    def __init__(self):
        self.events: list[str] = []
        self.acks: list[dict] = []
        self.redline: list[str] = []  # human-readable violations


def _ack(element_id: str, note: str, new: Optional[str]) -> dict:
    return {
        'element_id': element_id,
        'action': 'annotation_applied',
        'old': note,
        'new': new,
    }


def _fence_line_matches(
    old_lines: list[str], new_lines: list[str],
) -> dict:
    """Map old fence-line index -> new fence-line index for one paired
    block: LCS over line content anchors unchanged lines, and between
    anchors the leftovers pair in order (same line, edited); surplus
    lines count as deleted (old) or inserted (new). The line-level
    mirror of reconcile_master's block anchoring, so a line note follows
    ITS line through unrelated insertions above it.
    """
    match: dict = {}
    oi = ni = 0

    def pair_leftover(
        old_lo: int, old_hi: int, new_lo: int, new_hi: int,
    ) -> None:
        for x in range(min(old_hi - old_lo, new_hi - new_lo)):
            match[old_lo + x] = new_lo + x

    for pi, pj in lcs_pairs(old_lines, new_lines):
        pair_leftover(oi, pi, ni, pj)
        match[pi] = pj  # the anchors themselves: unchanged lines
        oi, ni = pi + 1, pj + 1
    pair_leftover(oi, len(old_lines), ni, len(new_lines))
    return match


def _reconcile_markers(
    old_mb: MasterBlock, new_mb: MasterBlock, element_id: str,
    changed: bool, result: ReconcileResult,
) -> None:
    """Reconcile one paired block's markers (prototype reconcileMarkers)."""
    old_block_notes = [m for m in old_mb.markers if m.kind == 'block']
    new_block_notes = [m for m in new_mb.markers if m.kind == 'block']
    old_line_notes = {m.line: m for m in old_mb.markers if m.kind == 'line'}
    new_line_notes = {m.line: m for m in new_mb.markers if m.kind == 'line'}

    if old_block_notes:
        if new_block_notes:
            result.events.append(
                f'{element_id} marker still present - annotation pending')
        elif changed:
            result.events.append(
                f'{element_id} annotation acked '
                '(content changed: fix disposes the note)')
            result.acks.append(_ack(element_id, old_block_notes[0].note,
                                    _block_text(new_mb.block)))
        else:
            result.events.append(
                f'{element_id} annotation acked (marker removed)')
            result.acks.append(_ack(element_id, old_block_notes[0].note, None))
    elif new_block_notes:
        result.events.append(f'{element_id} new block annotation attached')

    # Line notes: align old fence lines to new fence lines by content,
    # so a note is judged on ITS line, never on whatever now sits at its
    # old position. A marker that moved with its line is still pending;
    # a removed marker acks (plain when the line is unchanged, fix-and-
    # ack when the line's own content changed).
    old_lines = old_mb.block.lines
    new_lines = new_mb.block.lines
    match = _fence_line_matches(old_lines, new_lines)
    for line_no, old_marker in old_line_notes.items():
        new_idx = match.get(line_no - 1)
        if new_idx is not None and (new_idx + 1) in new_line_notes:
            result.events.append(
                f'{element_id} line {line_no} marker still present - '
                'annotation pending')
            continue
        if new_idx is not None and old_lines[line_no - 1] != new_lines[new_idx]:
            result.events.append(
                f'{element_id} line {line_no} annotation acked '
                '(content changed: fix disposes the note)')
            result.acks.append(
                _ack(element_id, old_marker.note, new_lines[new_idx]))
        else:
            result.events.append(
                f'{element_id} line {line_no} annotation acked '
                '(marker removed)')
            result.acks.append(_ack(element_id, old_marker.note, None))
    # A marker at a matched note's new position is that same note moved,
    # not a fresh attachment.
    moved_to = {match[line_no - 1] + 1
                for line_no in old_line_notes if (line_no - 1) in match}
    for line_no in new_line_notes:
        if line_no not in old_line_notes and line_no not in moved_to:
            result.events.append(
                f'{element_id} new line marker pp@{line_no} attached')


def reconcile_master(
    old: list[MasterBlock], new: list[MasterBlock],
) -> ReconcileResult:
    """Reconcile the baseline against the current master.

    Port of the prototype's applyMaster: LCS anchors blocks whose
    content keys match; gaps drain in order (leftover old/new blocks
    pair up, surplus old blocks are deletions, surplus new blocks are
    fresh). A leftover old block that still carries markers is a
    red-line violation (issue 0009).
    """
    result = ReconcileResult()
    pairs = lcs_pairs([content_key(mb.block) for mb in old],
                      [content_key(mb.block) for mb in new])
    fresh_no = len(old) + 1

    def pair_up(oi: int, ni: int, changed: bool) -> None:
        element_id = f'b{oi + 1}'
        _reconcile_markers(old[oi], new[ni], element_id, changed, result)
        if changed and not any(m.kind == 'block' for m in old[oi].markers):
            result.events.append(f'{element_id} content updated')

    def handle_gone(oi: int) -> None:
        element_id = f'b{oi + 1}'
        old_mb = old[oi]
        if old_mb.markers:
            notes = '; '.join(m.note for m in old_mb.markers)
            result.redline.append(f'{element_id} (annotation: "{notes}")')
        else:
            result.events.append(f'{element_id} deleted')

    def pair_gap(old_range: tuple[int, int],
                 new_range: tuple[int, int]) -> None:
        """Pair the leftover blocks of one LCS anchor gap, in order:
        changed content = same block updated, surplus old blocks are
        deletions, surplus new blocks are fresh."""
        lo, hi = old_range
        lo2, hi2 = new_range
        nonlocal fresh_no
        olds = list(range(lo, hi))
        news = list(range(lo2, hi2))
        k = min(len(olds), len(news))
        for x in range(k):
            old_key = content_key(old[olds[x]].block)
            new_key = content_key(new[news[x]].block)
            pair_up(olds[x], news[x], old_key != new_key)
        for x in range(k, len(olds)):
            handle_gone(olds[x])
        for x in range(k, len(news)):
            block = new[news[x]].block
            result.events.append(f'new block b{fresh_no} ({block.kind})')
            fresh_no += 1

    oi = ni = 0
    for pi, pj in pairs:
        pair_gap((oi, pi), (ni, pj))
        pair_up(pi, pj, False)
        oi, ni = pi + 1, pj + 1
    pair_gap((oi, len(old)), (ni, len(new)))
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def resolve_doc(workspace: Path, doc_name: str) -> tuple[Path, Path]:
    """Master and baseline paths for a doc name (with or without .md)."""
    name = Path(doc_name).name
    if name.endswith('.md'):
        name = name[:-3]
    if not name:
        raise MasterError(f'invalid doc name: {doc_name!r}')
    master_path = workspace / DOCS_DIR_NAME / f'{name}.md'
    baseline_path = workspace / STATE_DIR_NAME / f'{name}{BASE_SUFFIX}'
    return master_path, baseline_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Reconcile the baseline snapshot against the master doc '
                    '(acks annotations, enforces the delete red-line)',
    )
    parser.add_argument(
        'doc', help='Doc name (docs/<name>.md, with or without .md)')
    parser.add_argument('--workspace', default='.pinpoint',
                        help='pinpoint workspace root (default: ./.pinpoint)')
    parser.add_argument('--explain', action='append', default=[],
                        metavar='REF=TEXT',
                        help='Explanation for a note resolved WITHOUT a '
                             'content change (repeatable). REF is the element '
                             'id b<N> from the digest/consume report, e.g. '
                             '--explain b2=intentional, kept as-is. The text '
                             'lands in that ack\'s audit record (explain '
                             'field); refs that match no plain ack are '
                             'reported on stderr and ignored.')
    return parser


def main(argv: Optional[list] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, OSError, ValueError):
            pass

    parser = build_parser()
    args = parser.parse_args(argv)
    workspace = Path(args.workspace).resolve()

    # Explanation channel (0004: 解释文本进审计): keyed by element id -
    # line refs (@N) are ambiguous across blocks, so only b<N> is
    # keyable and everything else is reported, never fatal.
    explains: dict = {}
    for raw in args.explain:
        ref, sep, text = raw.partition('=')
        if not sep or not ref.strip():
            print(f'Warning: --explain {raw!r} is not REF=TEXT '
                  '(REF = element id b<N>); ignored.', file=sys.stderr)
            continue
        explains[ref.strip()] = text

    try:
        master_path, baseline_path = resolve_doc(workspace, args.doc)
    except MasterError as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1
    if not master_path.exists():
        print(f'Error: no master doc: {master_path}', file=sys.stderr)
        return 1
    master_text = master_path.read_text(encoding='utf-8-sig')

    # Parse-validate the master before any write: a corrupt master must
    # not poison a first-run baseline (which would hide the corruption
    # from every later round).
    try:
        new = parse_master(master_text)
    except MasterError as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1

    if not baseline_path.exists():
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        write_text_lf(baseline_path, master_text)
        print(f'No baseline snapshot for {master_path.name} - created from '
              'the current master; nothing to reconcile.')
        return 0

    try:
        old = parse_master(baseline_path.read_text(encoding='utf-8-sig'))
    except MasterError as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1

    result = reconcile_master(old, new)
    if result.redline:
        print('Error: consume refused: block(s) deleted together with an '
              'unresolved annotation:', file=sys.stderr)
        for violation in result.redline:
            print(f'  {master_path.name} {violation}', file=sys.stderr)
        print('Resolve the annotation first, then delete the block: edit the '
              'content (fix + remove the marker = fix-and-ack), or remove the '
              'marker and explain the decision in your reply. Nothing was '
              'written (master and baseline snapshot untouched).',
              file=sys.stderr)
        return 1

    # Attach explanations to pure acks (marker removed, content
    # unchanged): a fix-and-ack's `new` already speaks for itself.
    for ack in result.acks:
        if ack['new'] is None and ack['element_id'] in explains:
            ack['explain'] = explains.pop(ack['element_id'])
    for ref, text in explains.items():
        print(f'Warning: --explain {ref}: no plain ack (marker removed, '
              'content unchanged) for this element id; explanation '
              'ignored.', file=sys.stderr)

    master_serialized = serialize_master(new)
    if master_serialized != master_text:
        write_text_lf(master_path, master_serialized)
    write_text_lf(baseline_path, master_serialized)

    if result.acks:
        ts = time.time()
        with open(workspace / ANNOTATION_LOG_NAME, 'a', encoding='utf-8') as fh:
            for ack in result.acks:
                record = {'ts': ts, 'file': master_path.name, **ack}
                fh.write(json.dumps(record, ensure_ascii=False) + '\n')

    for event in result.events:
        print(event)
    pending = sum(len(mb.markers) for mb in new)
    print(f'[{master_path.name}] {len(result.acks)} acked, {pending} pending.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
