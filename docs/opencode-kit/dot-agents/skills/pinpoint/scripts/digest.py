#!/usr/bin/env python3
"""
pinpoint - Per-round digest CLI (0011; format fixed by 0002).

The digest is what the AI reads instead of the doc: every pending
annotation (master marker lines under docs/*.md, quoted together with
the master region they annotate) plus every unconsumed direct edit
(new records in edits.jsonl since the last digest, tracked by read
position in state/digest.json). Printed to stdout.

Shape (0002 Resolution): a per-doc header (doc name - annotation count -
direct-edit count), a one-line marker syntax reminder, the next-step
hint; then one section per annotation quoting the master region (block
note = marker line + block source; line note = the fence +/-2 content
lines with the annotated line carrying a "<- pp@N" pointer); then a
direct-edits section showing new-value(original:old-value).

Usage:
    python scripts/digest.py [path]

    path   pinpoint workspace root (default: ./.pinpoint)

Exit codes:
    0  digest completed (annotations may or may not be present)
    1  path not found, no docs/ directory, or a master failed to parse
       (an unreadable master never passes as a doc without annotations;
       the edits read position is not advanced, so nothing is lost)
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Union

from master import (
    MasterError, MasterBlock, Marker, parse_master, serialize_master,
)
from render import Block

DOCS_DIR_NAME = 'docs'
EDITS_LOG_NAME = 'edits.jsonl'
STATE_DIR_NAME = 'state'
STATE_FILE_NAME = 'digest.json'
STATE_KEY = 'edits_pos'  # lines of edits.jsonl consumed so far
STATE_EPOCH_KEY = 'apply_epoch'  # last apply epoch digested (wait.py)

SYNTAX_REMINDER = (
    '标记语法:<!-- pp: 块注解(置于所注解块的上方) --> · '
    '<!-- pp@N: 行注解(N = 围栏内第 N 行,空行计入) -->'
)
NEXT_STEP_HINT = '下一步:编辑 master 处置注解 → 处置后删除标记行 → 提交 consume'

# Context window around a line-noted fence line, in content lines.
LINE_CONTEXT = 2


def scan_master_file(path: Path) -> list:
    """Parse one master and return its MasterBlocks.

    Propagates MasterError: whether one unreadable master is fatal is the
    caller's call; an empty list must never stand in for a file that could
    not be read.
    """
    return parse_master(path.read_text(encoding='utf-8-sig'))


def scan_workspace(workspace: Path) -> tuple:
    """Scan all docs/*.md masters. Returns (blocks_by_doc, unreadable).

    blocks_by_doc maps doc file name -> [MasterBlock] in document order
    for every doc that carries at least one marker; unreadable collects
    "name: reason" strings for masters that failed to parse.
    """
    docs_dir = workspace / DOCS_DIR_NAME
    blocks_by_doc: dict = {}
    unreadable: list = []
    for doc_file in sorted(docs_dir.glob('*.md')):
        try:
            blocks = scan_master_file(doc_file)
        except MasterError as exc:
            unreadable.append(f'{doc_file.name}: {exc}')
            continue
        if any(mb.markers for mb in blocks):
            blocks_by_doc[doc_file.name] = blocks
    return blocks_by_doc, unreadable


def read_new_edits(workspace: Path) -> tuple:
    """Return (records, position) for edits.jsonl, read incrementally.

    Only records past the position stored in state/digest.json are
    returned; position counts lines, so non-edit records are consumed
    without being shown. A truncated or recreated log resets to the
    start (position beyond the current line count); unparsable lines
    are warned about and skipped. A missing log yields ([], 0).
    """
    log = workspace / EDITS_LOG_NAME
    state_path = workspace / STATE_DIR_NAME / STATE_FILE_NAME
    if not log.exists():
        return [], 0
    pos = 0
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding='utf-8'))
            pos = max(0, int(state.get(STATE_KEY, 0)))
        except (ValueError, OSError):
            pos = 0
    lines = log.read_text(encoding='utf-8-sig', errors='replace').splitlines()
    if pos > len(lines):  # truncated or recreated log: start over
        pos = 0
    records = []
    for line in lines[pos:]:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            print(f'[WARN] skipping unparsable {EDITS_LOG_NAME} line: '
                  f'{line[:80]}', file=sys.stderr)
            continue
        if record.get('action') == 'edit':
            records.append(record)
    return records, len(lines)


def read_state_file(workspace: Path) -> dict:
    """Load state/digest.json as a dict ({} when absent or corrupt)."""
    state_path = workspace / STATE_DIR_NAME / STATE_FILE_NAME
    try:
        state = json.loads(state_path.read_text(encoding='utf-8'))
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def read_apply_epoch(workspace: Path) -> Optional[int]:
    """The apply epoch wait.py last digested (None when never recorded).

    Written only by wait.py; a plain digest.py run preserves the key.
    """
    raw = read_state_file(workspace).get(STATE_EPOCH_KEY)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        return None
    return raw


def peek_pending(workspace: Path) -> bool:
    """True when a digest printed now would show anything.

    Scan only — no output, no state written. Used by wait.py to notice
    work that was applied before its wait started. An unreadable master
    counts as pending so the error surfaces through the digest path.
    """
    try:
        blocks_by_doc, unreadable = scan_workspace(workspace)
    except OSError:
        return True
    edits, _position = read_new_edits(workspace)
    return bool(blocks_by_doc) or bool(unreadable) or bool(edits)


def write_state(workspace: Path, position: int,
                apply_epoch: Optional[int] = None) -> None:
    """Write the digest read position, preserving sibling state keys.

    ``apply_epoch`` (wait.py's apply epoch snapshot) is updated only
    when given; plain digest.py runs never touch it.
    """
    state_path = workspace / STATE_DIR_NAME / STATE_FILE_NAME
    state = read_state_file(workspace)
    state[STATE_KEY] = position
    if apply_epoch is not None:
        state[STATE_EPOCH_KEY] = apply_epoch
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state), encoding='utf-8')


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Print the per-round pinpoint digest (pending '
                    'annotations + unconsumed direct edits)',
    )
    parser.add_argument('path', nargs='?', default='.pinpoint',
                        help='Pinpoint workspace root (default: ./.pinpoint)')
    return parser


def run(path: Union[str, Path], apply_epoch: Optional[int] = None) -> int:
    """Print the digest for the workspace at ``path`` and advance the
    state. Shared by the digest.py CLI and wait.py (which passes the
    apply epoch its wait released on, so the next wait starts from it).
    """
    target = Path(path).resolve()
    if not target.exists():
        print(f'Error: Path not found: {target}', file=sys.stderr)
        return 1
    if not target.is_dir():
        print(
            f'Error: Expected a workspace directory, got: {target}',
            file=sys.stderr)
        return 1
    docs_dir = target / DOCS_DIR_NAME
    if not docs_dir.exists():
        print(
            f'Error: No {DOCS_DIR_NAME}/ directory under: {target}',
            file=sys.stderr)
        return 1

    blocks_by_doc, unreadable = scan_workspace(target)
    edits, position = read_new_edits(target)

    for message in unreadable:
        print(f'[ERROR] Failed to parse master {message}', file=sys.stderr)
    if unreadable:
        return 1

    print_digest(blocks_by_doc, edits)
    write_state(target, position, apply_epoch=apply_epoch)
    return 0


def main(argv: Optional[list] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, OSError, ValueError):
            pass

    parser = build_parser()
    args = parser.parse_args(argv)
    return run(args.path)


def _fence_window(block: Block, marker: Marker) -> str:
    """A line-noted fence, quoted: fence lines + the annotated line with
    +/- LINE_CONTEXT content lines around it, '…' where runs were elided."""
    lines = block.lines
    n = marker.line  # 1-based into the fence's content lines, blanks count
    lo = max(0, n - 1 - LINE_CONTEXT)
    hi = min(len(lines), n - 1 + LINE_CONTEXT + 1)
    out = [f'```{block.lang}']
    if lo > 0:
        out.append('…')
    for i in range(lo, hi):
        if i == n - 1:
            out.append(f'{lines[i]}   ← pp@{n}: {marker.note}')
        else:
            out.append(lines[i])
    if hi < len(lines):
        out.append('…')
    out.append('```')
    return '\n'.join(out)


def _section_body(marker: Marker, block: Block) -> str:
    """The quoted master region for one marker (0002: block notes quote
    marker line + block source; line notes quote the fence window)."""
    if marker.kind == 'line':
        return _fence_window(block, marker)
    return serialize_master([MasterBlock([marker], block)]).rstrip('\n')


def _sections(doc: str, blocks: list, counter: list) -> list:
    """The quoted master region for every marker in one doc, in doc order."""
    out = []
    for mb in blocks:
        for marker in mb.markers:
            counter[0] += 1
            body = _section_body(marker, mb.block)
            out.append(f'── {counter[0]} · {doc} ──\n{body}')
    return out


def print_digest(blocks_by_doc: dict, edits: list) -> None:
    if not blocks_by_doc and not edits:
        print('[OK] No annotations found.')
        return
    counter = [0]
    for doc, blocks in blocks_by_doc.items():
        notes = sum(len(mb.markers) for mb in blocks)
        doc_stem = Path(doc).stem
        doc_edits = sum(
            1 for rec in edits
            if Path(str(rec.get('file', ''))).stem == doc_stem)
        print(f'{doc} · {notes} annotation{"s" if notes != 1 else ""} · '
              f'{doc_edits} direct edit{"s" if doc_edits != 1 else ""}')
        print(SYNTAX_REMINDER)
        print(NEXT_STEP_HINT)
        print()
        for section in _sections(doc, blocks, counter):
            print(section)
            print()
    _print_edit_only_docs(blocks_by_doc, edits)
    if edits:
        print(f'── direct edits · {len(edits)} ──')
        for rec in edits:
            new = rec.get('new') or ''
            old = rec.get('old') or ''
            where = f'{rec.get("file", "?")} {rec.get("element_id", "?")}: '
            print(f'{where}{new}(原:{old})')


def _print_edit_only_docs(blocks_by_doc: dict, edits: list) -> None:
    """Headers for zero-marker docs that only have pending edits (0002:
    the per-doc header is doc name · annotation count · direct-edit
    count, so such a doc must not be invisible). A record whose stem
    matches an announced doc counts there (legacy .html vs master .md);
    the records themselves still show in the direct-edits section."""
    claimed = {Path(doc).stem for doc in blocks_by_doc}
    extras = {}  # file name -> edit count, first-appearance order
    for rec in edits:
        name = str(rec.get('file', '?'))
        stem = Path(name).stem
        if stem in claimed:
            continue
        claimed.add(stem)
        extras[name] = sum(1 for r in edits
                           if Path(str(r.get('file', '?'))).stem == stem)
    for doc, count in extras.items():
        print(f'{doc} · 0 annotations · '
              f'{count} direct edit{"s" if count != 1 else ""}')
        print()


if __name__ == '__main__':
    raise SystemExit(main())
