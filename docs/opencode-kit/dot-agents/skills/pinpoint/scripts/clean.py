#!/usr/bin/env python3
"""pinpoint - Workspace cleanup: archive provably finished reviews.

The workspace (``.pinpoint/``) is append-only by design: every review
leaves its doc, baseline and assets behind, and the editor lists them
all on every open. This command is the exit. It classifies every doc
against the SAME convergence truth export.py enforces (0026), archives
what is provably finished, and refuses to touch anything that still
carries the user's words or a held position.

Safety contract (issue 0027):

- Dry-run by default: the verdict table prints, nothing is written.
  ``--apply`` executes; ``--hard`` deletes outright instead of
  archiving (implies ``--apply``).
- Archive, not delete: files move to ``archive/<YYYYmmdd-HHMMSS>/``
  keeping their workspace-relative paths — one reversible batch.
- Docs with unconsumed markers or an ``undecided`` last Apply always
  KEEP: the user's words and stated positions are never garbage.
- Docs with no stance on record (never applied — e.g. legacy HTML
  from before the Apply era) fall to the time rule only: no markers
  and untouched for ``--stale-days`` days (default 30; 0 disables).
- ``annotations.jsonl`` is never touched: audit memory outlives docs.
- ``--apply`` refuses while a pinpoint server holds the workspace (a
  live save-all would resurrect archived docs); ``--force`` overrides.
- Restore at any time: move the files back out of the archive batch.

Usage:
    python scripts/clean.py [path] [--apply] [--hard] [--name DOC]
                                        [--stale-days N] [--force]

    path          pinpoint workspace root (default: ./.pinpoint)
    --apply       execute the printed plan (default: dry-run)
    --hard        delete outright instead of archiving (implies --apply)
    --name DOC    one doc only (master or legacy name); it must pass
                  the export convergence gate — the time rule does
                  not apply to a named target
    --stale-days  archive stance-less, marker-free docs older than N
                  days (default 30; 0 disables the time rule)
    --force       apply even with a live server holding the workspace

Exit codes:
    0    plan printed (dry-run) or executed (--apply)
    1    bad workspace, unknown --name, an unconverged --name target,
         or --apply refused because a server holds the workspace
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import NamedTuple, Optional

import export
import migrate
import review_state
from master import MasterError
from server_common import lock_pid, process_alive, read_lock, write_text_lf

DOCS_DIR_NAME = 'docs'
STATE_DIR_NAME = 'state'
ASSETS_DIR_NAME = 'assets'
ARCHIVE_DIR_NAME = 'archive'
BASE_SUFFIX = '.base.md'
MASTER_SUFFIX = '.md'
LEGACY_SUFFIX = '.html'
LOCK_FILE_NAME = 'lock.json'
ANNOTATION_LOG_NAME = 'annotations.jsonl'
DEFAULT_STALE_DAYS = 30
SECONDS_PER_DAY = 86400

KEEP = 'keep'
ARCHIVE = 'archive'

# classify/_gate_reasons share one except clause: every way a doc can
# fail to become judgeable master text.
UNREADABLE = (MasterError, migrate.MigrationError, OSError, UnicodeError,
              ValueError)


class CleanError(Exception):
    """A refusable input: bad workspace, unknown name, live server."""


class Verdict(NamedTuple):
    action: str              # KEEP | ARCHIVE
    rel: str                 # workspace-relative display path
    reason: str
    file: Optional[Path]     # source file (None for synthetic rows)


def _rel(file: Path, workspace: Path) -> str:
    """Display path: workspace-relative when the file sits under it."""
    try:
        return file.resolve().relative_to(workspace.resolve()).as_posix()
    except ValueError:
        return file.name


def _gate_reasons(doc_file: Path, empties: Optional[str]) -> list:
    """The export convergence gate's reasons for this doc ([] = go).

    Reused verbatim (0026): cleaning must not invent a second, looser
    notion of "done" than the one that governs export. Legacy HTML
    goes through migrate's conversion first, so both doc eras are
    judged by the same master-format truth.
    """
    text = doc_file.read_text(encoding='utf-8-sig')
    if doc_file.suffix.lower() != MASTER_SUFFIX:
        text = migrate._master_from_html(text)
    return export.convergence_reasons(text, empties)


def classify_doc(
    workspace: Path, doc_file: Path, empties: Optional[str],
    stale_days: int, now: float, named: bool,
) -> Verdict:
    """One doc's verdict: converged -> archive, live -> keep.

    ``named`` targets come from ``--name`` (point cleanup at loop
    end) and skip the time rule: a doc the agent names must pass the
    gate outright or the command refuses — no age-based bypass.
    """
    rel = _rel(doc_file, workspace)
    try:
        reasons = _gate_reasons(doc_file, empties)
    except UNREADABLE as exc:
        return Verdict(KEEP, rel, f'unreadable ({exc}); never guessed',
                       doc_file)
    if reasons:
        return Verdict(KEEP, rel, '; '.join(reasons), doc_file)
    if empties == review_state.AGREED:
        return Verdict(ARCHIVE, rel,
                       'converged (no markers, empties=agreed)', doc_file)
    if named:
        # exportable per the gate (no markers, no undecided hold) and
        # explicitly named: converged enough to archive
        return Verdict(ARCHIVE, rel,
                       'converged (gate passed; no stance recorded)',
                       doc_file)
    if stale_days <= 0:
        return Verdict(KEEP, rel, 'no markers, no Apply stance recorded',
                       doc_file)
    try:
        age_days = (now - doc_file.stat().st_mtime) / SECONDS_PER_DAY
    except OSError:
        return Verdict(KEEP, rel, 'no stance recorded; mtime unavailable',
                       doc_file)
    if age_days >= stale_days:
        return Verdict(
            ARCHIVE, rel,
            f'stale: no markers, no stance, untouched {age_days:.0f}d '
            f'(>= {stale_days}d)',
            doc_file)
    return Verdict(
        KEEP, rel,
        f'no stance recorded; only {age_days:.0f}d old '
        f'(stale at {stale_days}d)',
        doc_file)


def _list_docs(docs_dir: Path) -> tuple:
    """(listed docs, migration leftovers) — the server's listing rule.

    Masters are first-class; a legacy HTML without its master is a
    doc, one WITH its master is a crash leftover of an interrupted
    migration (the master is the truth).
    """
    if not docs_dir.is_dir():
        return [], []
    masters = sorted(docs_dir.glob(f'*{MASTER_SUFFIX}'))
    master_stems = {f.stem for f in masters}
    leftovers: list = []
    docs: list = []
    for f in sorted(docs_dir.glob(f'*{LEGACY_SUFFIX}')):
        (leftovers if f.stem in master_stems else docs).append(f)
    docs.extend(masters)
    docs.sort(key=lambda f: f.name)
    return docs, leftovers


def _resolve_name(docs_dir: Path, name: str) -> tuple:
    """Resolve --name to (doc file, migration leftover or None).

    Raises CleanError on traversal, unknown or non-doc names.
    """
    if not name or '/' in name or '\\' in name or '..' in name:
        raise CleanError(f'invalid doc name: {name!r}')
    stem = name
    for suffix in (MASTER_SUFFIX, LEGACY_SUFFIX):
        if stem.endswith(suffix):
            stem = stem[:-len(suffix)]
            break
    if not stem:
        raise CleanError(f'invalid doc name: {name!r}')
    master = docs_dir / f'{stem}{MASTER_SUFFIX}'
    legacy = docs_dir / f'{stem}{LEGACY_SUFFIX}'
    if master.is_file():
        return master, (legacy if legacy.is_file() else None)
    if legacy.is_file():
        return legacy, None
    raise CleanError(
        f'doc not found: {name} (looked for docs/{stem}{MASTER_SUFFIX} '
        f'and docs/{stem}{LEGACY_SUFFIX})')


def _asset_verdicts(workspace: Path, remaining_docs: list) -> list:
    """Verdicts for assets/: unreferenced after the plan -> archive.

    The scan set is every doc that remains in docs/ plus the text
    files at the workspace root (agent-written sources may reference
    an asset by name). Already-archived batches are not scanned —
    their assets moved with them. An unavailable scan keeps
    everything: better uncleaned than wrongly cleaned.
    """
    assets_dir = workspace / ASSETS_DIR_NAME
    verdicts: list = []
    if not assets_dir.is_dir():
        return verdicts
    root_sources = (sorted(workspace.glob(f'*{MASTER_SUFFIX}'))
                    + sorted(workspace.glob(f'*{LEGACY_SUFFIX}')))
    texts: Optional[list] = []
    for f in remaining_docs + root_sources:
        try:
            texts.append(f.read_text(encoding='utf-8', errors='replace'))
        except OSError:
            texts = None
            break
    for asset in sorted(assets_dir.rglob('*')):
        if not asset.is_file():
            continue
        rel = _rel(asset, workspace)
        if texts is None:
            verdicts.append(
                Verdict(KEEP, rel, 'reference scan unavailable', asset))
        elif any(asset.name in text for text in texts):
            verdicts.append(Verdict(KEEP, rel, 'referenced', asset))
        else:
            verdicts.append(
                Verdict(ARCHIVE, rel, 'unreferenced after this plan',
                        asset))
    return verdicts


def build_plan(
    workspace: Path, stale_days: int, now: float, name: Optional[str],
) -> tuple:
    """(verdicts, archived doc names) for the whole workspace.

    Verdicts cover docs, migration leftovers, baselines and assets;
    the archived doc names drive the empties.json pruning.
    """
    docs_dir = workspace / DOCS_DIR_NAME
    state_dir = workspace / STATE_DIR_NAME
    empties_map = review_state.read(workspace)
    verdicts: list = []
    archived_docs: list = []

    all_docs, all_leftovers = _list_docs(docs_dir)
    if name is not None:
        target, target_leftover = _resolve_name(docs_dir, name)
        docs, leftovers = [target], (
            [target_leftover] if target_leftover else [])
    else:
        docs, leftovers = all_docs, all_leftovers

    # A leftover never blocks anything and always leaves: its content
    # is fully owned by the surviving master.
    for f in leftovers:
        verdicts.append(Verdict(
            ARCHIVE, _rel(f, workspace),
            f'migration leftover (master {f.stem}{MASTER_SUFFIX} is '
            'the truth)', f))

    for doc_file in docs:
        verdict = classify_doc(
            workspace, doc_file, empties_map.get(doc_file.name),
            stale_days, now, named=name is not None)
        verdicts.append(verdict)
        if verdict.action == ARCHIVE:
            archived_docs.append(doc_file)

    # Baselines: a leaving doc's baseline follows it; a baseline with
    # no doc at all is an orphan (swept in bulk mode only — a named
    # point-clean touches nothing beyond its target).
    leaving_stems = {f.stem for f in archived_docs}
    living_stems = {f.stem for f in all_docs}
    if state_dir.is_dir():
        for base in sorted(state_dir.glob(f'*{BASE_SUFFIX}')):
            stem = base.name[:-len(BASE_SUFFIX)]
            rel = _rel(base, workspace)
            if stem in leaving_stems:
                verdicts.append(Verdict(
                    ARCHIVE, rel,
                    f'baseline of archived docs/{stem} doc', base))
            elif name is None and stem not in living_stems:
                verdicts.append(Verdict(
                    ARCHIVE, rel,
                    f'orphan baseline (no docs/{stem}'
                    f'{MASTER_SUFFIX} or .html)', base))

    remaining_docs = [f for f in all_docs if f not in archived_docs]
    verdicts.extend(_asset_verdicts(workspace, remaining_docs))
    return verdicts, [f.name for f in archived_docs]


def _server_holding(workspace: Path) -> bool:
    """True when a live pinpoint server holds this workspace."""
    lock = read_lock(workspace / LOCK_FILE_NAME)
    return process_alive(lock_pid(lock))


def _batch_dir(workspace: Path) -> Path:
    """A fresh archive batch directory (second-collision safe)."""
    stamp = time.strftime('%Y%m%d-%H%M%S')
    base = workspace / ARCHIVE_DIR_NAME / stamp
    n = 0
    while base.exists():
        n += 1
        base = workspace / ARCHIVE_DIR_NAME / f'{stamp}-{n}'
    return base


def _prune_empties(workspace: Path, archived_docs: list) -> Optional[int]:
    """Drop archived docs' entries from state/empties.json.

    Returns the number of pruned entries (None = nothing to do). The
    map is rewritten only when it actually changes.
    """
    state = review_state.read(workspace)
    pruned = [name for name in archived_docs if name in state]
    if not pruned:
        return None
    for name in pruned:
        del state[name]
    path = review_state.state_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_text_lf(path, json.dumps(state, sort_keys=True))
    return len(pruned)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Archive provably finished pinpoint reviews out of '
                    'the workspace (dry-run by default; nothing the '
                    'review still needs is ever touched)',
    )
    parser.add_argument('path', nargs='?', default='.pinpoint',
                        help='Pinpoint workspace root (default: ./.pinpoint)')
    parser.add_argument('--apply', action='store_true',
                        help='Execute the plan (default: dry-run)')
    parser.add_argument('--hard', action='store_true',
                        help='Delete outright instead of archiving '
                             '(implies --apply)')
    parser.add_argument('--name',
                        help='One doc only (master or legacy name); must '
                             'pass the export convergence gate')
    parser.add_argument('--stale-days', type=int,
                        default=DEFAULT_STALE_DAYS,
                        help=f'Archive stance-less marker-free docs older '
                             f'than N days (default {DEFAULT_STALE_DAYS}; '
                             f'0 disables the time rule)')
    parser.add_argument('--force', action='store_true',
                        help='Apply even with a live server holding the '
                             'workspace')
    return parser


def main(argv: Optional[list] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, OSError, ValueError):
            pass

    parser = build_parser()
    args = parser.parse_args(argv)
    apply_mode = args.apply or args.hard
    if args.stale_days < 0:
        parser.error('--stale-days must be >= 0')

    workspace = Path(args.path).resolve()
    if not workspace.is_dir():
        print(f'Error: Workspace not found: {workspace}', file=sys.stderr)
        return 1

    try:
        verdicts, archived_docs = build_plan(
            workspace, args.stale_days, time.time(), args.name)
    except CleanError as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1

    if args.name is not None:
        kept_docs = [v for v in verdicts
                     if v.action == KEEP and v.file is not None
                     and v.file.parent.name == DOCS_DIR_NAME]
        if kept_docs:
            print('Error: not archiving --name target:', file=sys.stderr)
            for v in kept_docs:
                print(f'  {v.rel}: {v.reason}', file=sys.stderr)
            return 1

    if apply_mode and not args.force and _server_holding(workspace):
        print(
            'Error: a pinpoint server is holding this workspace — a live '
            'Apply would resurrect archived docs.\n'
            'Stop it first (python scripts/server.py --shutdown, or let '
            'it idle out), or pass --force.',
            file=sys.stderr,
        )
        return 1

    width = max((len(v.rel) for v in verdicts), default=0)
    for v in verdicts:
        print(f'{v.action.upper():<8}{v.rel:<{width}}  {v.reason}')
    kept = sum(1 for v in verdicts if v.action == KEEP)
    to_archive = [v for v in verdicts if v.action == ARCHIVE]
    print(f'\n{len(to_archive)} to archive, {kept} to keep '
          f'(annotations.jsonl: never touched)')

    if not apply_mode:
        print('dry-run: nothing written (pass --apply to execute)')
        return 0

    batch = _batch_dir(workspace) if not args.hard else None
    for v in to_archive:
        if v.file is None:
            continue
        if args.hard:
            v.file.unlink(missing_ok=True)
            print(f'deleted  {v.rel}')
        else:
            dest = batch / v.rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(v.file), str(dest))
            print(f'archived {v.rel} -> {_rel(dest, workspace)}')
    pruned = _prune_empties(workspace, archived_docs)
    if pruned:
        print(f'pruned {pruned} empties.json entrie(s) of archived docs')
    if batch is not None:
        print(f'restore anytime: move files back from '
              f'{_rel(batch, workspace)}/')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
