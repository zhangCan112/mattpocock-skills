#!/usr/bin/env python3
"""
pinpoint - Export the converged master as clean markdown.

Under the C route (issue 0004) the truth source is a markdown master doc
(``.pinpoint/docs/<name>.md``) whose annotation markers are comment lines.
Export is the converged master with all marker lines stripped: parse the
master, drop the markers, serialize - the content only, in master.py's
canonical form.

Usage:
    python scripts/export.py <doc-or-master> [-o OUT.md] [--draft]
                                [--workspace DIR]

    <doc-or-master>  a doc name (resolved against <workspace>/docs/), a
                     master path (.md), or a legacy HTML doc path (.html)
    -o OUT.md        write to a file (default: stdout)
    --draft          export even when the review is not converged
                     (0026): the output is a working snapshot, marked by
                     a leading HTML comment — the answered part may
                     already steer the work while the rest is undecided
    --workspace DIR  workspace root for doc names (default: ./.pinpoint)

Convergence gate (0026): export refuses a doc whose master still
carries unconsumed markers, or whose last Apply left the untouched
blocks undecided (silence is not consent). Consume the notes / Apply
again (empties=agreed, or nothing staged for full agreement) — or ask
for --draft explicitly.

A legacy HTML doc whose master does not exist yet is serialized through
migrate.py (issue 0008: the old read-side serializer); when the master
exists it always wins - the master is the truth source. Export never
writes to the workspace.

Dependencies: master.py / migrate.py (markdown + beautifulsoup4 via
server_common.import_or_install).
"""

import argparse
import sys
from pathlib import Path
from typing import Optional

import migrate
import review_state
from master import MasterBlock, MasterError, parse_master, serialize_master
from server_common import write_text_lf

HTML_SUFFIXES = ('.html', '.htm')
MASTER_SUFFIX = '.md'


class ExportError(Exception):
    """Refused export input (unknown doc, unsupported file type)."""


def export_master(master_text: str) -> str:
    """The clean markdown of a master: markers stripped, content kept."""
    blocks = parse_master(master_text)
    return serialize_master([MasterBlock([], mb.block) for mb in blocks])


def export_legacy(html_text: str) -> str:
    """Clean markdown of a legacy HTML doc, via migrate's serializer.

    migrate's master conversion (annotations become markers) then the
    marker strip: notes are dropped exactly like attributes were.
    """
    return export_master(migrate._master_from_html(html_text))


def count_markers(master_text: str) -> int:
    """Unconsumed annotation markers in a master text (0026 gate)."""
    return sum(len(mb.markers) for mb in parse_master(master_text))


def convergence_reasons(master_text: str, empties: Optional[str]) -> list:
    """Why the doc is not converged for export ([] = go ahead).

    0026: markers waiting to be consumed block export, and so does a
    last Apply that left the untouched blocks undecided — silence is
    not consent. ``empties`` is the doc's recorded review state
    ('undecided' | 'agreed' | None = never applied).
    """
    reasons: list = []
    markers = count_markers(master_text)
    if markers:
        reasons.append(f'{markers} annotation marker(s) unconsumed')
    if empties == review_state.UNDECIDED:
        reasons.append('the last Apply left the rest undecided')
    return reasons


def resolve_doc_file(arg: str, workspace: Path) -> tuple[Path, Optional[Path]]:
    """Locate what to export: -> (file, legacy_path_or_None).

    An existing path is used directly (.md = master, .html = legacy with
    master preference: a sibling <stem>.md wins). A bare name (no path
    separators) is resolved against <workspace>/docs/ - master first,
    then legacy HTML. Raises ExportError when nothing can be found.
    """
    given = Path(arg)
    if given.is_file():
        suffix = given.suffix.lower()
        if suffix == MASTER_SUFFIX:
            return given, None
        if suffix in HTML_SUFFIXES:
            sibling = given.with_suffix(MASTER_SUFFIX)
            if sibling.is_file():
                return sibling, None
            return given, given
        raise ExportError(
            f'unsupported doc type: {given.name} (expected .md or .html)')
    if given.parent != Path('.'):
        raise ExportError(f'doc not found: {arg}')

    name = given.name
    if name.endswith(MASTER_SUFFIX):
        name = name[:-len(MASTER_SUFFIX)]
    elif name.endswith('.html'):
        name = name[:-len('.html')]
    if not name or name in ('.', '..'):
        raise ExportError(f'invalid doc name: {arg!r}')
    docs_dir = workspace / 'docs'
    master = docs_dir / f'{name}{MASTER_SUFFIX}'
    if master.is_file():
        return master, None
    legacy = docs_dir / f'{name}.html'
    if legacy.is_file():
        return legacy, legacy
    raise ExportError(f'doc not found: {master}')


def export_document(doc_path: Path) -> str:
    """Clean markdown of any doc file (.md master or legacy .html)."""
    text = doc_path.read_text(encoding='utf-8-sig')
    if doc_path.suffix.lower() == MASTER_SUFFIX:
        return export_master(text)
    return export_legacy(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Export a pinpoint master doc to clean markdown '
                    '(marker lines stripped)',
    )
    parser.add_argument(
        'doc', help='Doc name, master path (.md), or legacy doc path (.html)')
    parser.add_argument(
        '-o', '--output', help='Write to this file (default: stdout)')
    parser.add_argument(
        '--draft', action='store_true',
        help='Export even when the review is not converged: a marked '
             'working snapshot, not final approval (0026)')
    parser.add_argument('--workspace', default='.pinpoint',
                        help='pinpoint workspace root for doc names '
                             '(default: ./.pinpoint)')
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
    try:
        doc_file, legacy = resolve_doc_file(args.doc, workspace)
    except ExportError as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1

    try:
        text = doc_file.read_text(encoding='utf-8-sig')
        if legacy is not None:
            text = migrate._master_from_html(text)
    except (OSError, MasterError) as exc:
        print(
            f'Error: failed to export {doc_file.name}: {exc}',
            file=sys.stderr)
        return 1

    # 0026 convergence gate: unconsumed markers or an undecided last
    # Apply refuse the export; --draft turns the refusal into a marked
    # working snapshot (the answered part may already steer the work).
    reasons = convergence_reasons(
        text, review_state.read(workspace).get(doc_file.name))
    if reasons and not args.draft:
        print(
            'Error: review not converged — ' + '; '.join(reasons)
            + '. Consume the notes, or Apply again (empties=agreed, or '
              'nothing staged for full agreement); --draft exports a '
              'working snapshot.',
            file=sys.stderr)
        return 1

    md = export_master(text)
    if reasons:
        summary = '; '.join(reasons)
        print(f'[DRAFT] working snapshot, review not converged: {summary}',
              file=sys.stderr)
        md = ('<!-- pinpoint draft: mid-review export — not converged '
              f'({summary}) -->\n\n') + md

    if args.output:
        write_text_lf(Path(args.output), md)
    else:
        print(md, end='')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
