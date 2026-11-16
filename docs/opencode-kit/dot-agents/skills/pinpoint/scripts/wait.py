#!/usr/bin/env python3
"""
pinpoint - Blocking wait CLI: sleep until the user applies in the browser.

Replaces the manual go signal (0015): the agent launches this right
after serving the page. It blocks on the editor server's /api/wait
endpoint and returns the moment a confirmed "Apply changes"
(POST /api/save-all) fully succeeds, then prints the per-round digest
(digest.py's output, shared code). Nobody has to repeat the apply in
chat.

The wait is bounded by the server's lifetime only — the waiter never
feeds the idle watchdog, so it does not keep the server alive. An open
tab (60 s heartbeat) or unapplied staged work keeps both waiting; a
closed tab with nothing staged ends the wait when the server
idle-stops.

Usage:
    python scripts/wait.py [path] [--chunk SECONDS]

    path     pinpoint workspace root (default: ./.pinpoint)
    --chunk  per-request blocking slice in seconds (default: 60).
             Internal knob: chunking bounds leftover server threads and
             keeps dead-server detection immediate without busy polling.

Exit codes:
    0    the user applied; the digest is on stdout. A release that
         touched no files prints '[APPLIED] full agreement' — the user
         submitted with nothing staged (an empty digest without that
         note means deletions only, or nothing new). A release that
         touched files prints '[APPLIED] empties=undecided' or
         'empties=agreed' (0026) — what the Apply's untouched blocks
         mean: undecided is a held position, not approval
    1    bad workspace, or no running pinpoint server at start
    2    the server exited mid-wait (idle timeout, Exit button,
         --shutdown, external kill) — nothing new was applied. If
         annotations were applied after the waiter stopped, run
         digest.py (the manual fallback) after asking the user.
    130  interrupted (Ctrl+C / agent cancel). Unapplied staging stays
         in server memory; applied notes are already on disk — rerun
         wait.py or digest.py later to pick them up.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

import digest
from server_common import lock_pid, process_alive, read_lock

LOCK_FILE_NAME = 'lock.json'
HOST = '127.0.0.1'
HTTP_MARGIN = 30  # socket timeout slack over the server-side chunk

APPROVAL_NOTE = (
    '[APPLIED] full agreement — the user submitted with nothing staged '
    '(no annotations, no edits). Nothing to consume: converge the round '
    '(export / finish) as the conversation asks.'
)

UNDECIDED_NOTE = (
    '[APPLIED] empties=undecided — the user holds the un-annotated '
    'blocks undecided: a stated position, not approval. Consume the '
    'notes below, then wait for the next round; do not converge or '
    'export yet (export.py refuses; --draft exports a working '
    'snapshot).'
)

AGREED_NOTE = (
    '[APPLIED] empties=agreed — the user approves the un-annotated '
    'blocks: once the notes below are consumed, the document is '
    'converged and may be exported.'
)


def release_note(
    files: Optional[list], empties: Optional[str],
) -> Optional[str]:
    """The semantics line for a witnessed release (None = say nothing).

    A no-file release is full agreement (0015) and already approved;
    a file-carrying release says what its untouched blocks mean
    (0026). ``files is None`` (immediate release / old server) has no
    line — the digest speaks alone.
    """
    if full_agreement(files):
        return APPROVAL_NOTE
    if isinstance(files, list) and files:
        if empties == 'undecided':
            return UNDECIDED_NOTE
        if empties == 'agreed':
            return AGREED_NOTE
    return None


def full_agreement(files: Optional[list]) -> bool:
    """True when the releasing Apply touched no files.

    The user confirmed Apply changes with nothing staged — approval of
    the whole document (0015), not an empty digest to interpret.
    """
    return isinstance(files, list) and not files


def decide_immediate(saved: Optional[int], current: int, pending: bool) -> bool:
    """Release without blocking?

    True when there is already unconsumed work to digest: annotations
    or edits applied before this wait started (``pending``), or an
    Apply epoch the last digest never saw (``current > saved`` — covers
    a delete-only Apply, which leaves no digest trace of its own).
    """
    return pending or (saved is not None and current > saved)


def _get_json(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def _base_url(port: int) -> str:
    return f'http://{HOST}:{port}'


def _server_alive(base: str) -> bool:
    try:
        data = _get_json(f'{base}/api/health', timeout=3)
    except (urllib.error.URLError, OSError, ValueError):
        return False
    return data.get('service') == 'pinpoint'


def _resolve_port(workspace: Path) -> int:
    """The running server's port from lock.json, or 0 when unusable."""
    lock = read_lock(workspace / LOCK_FILE_NAME)
    if not lock or not process_alive(lock_pid(lock)):
        return 0
    try:
        return int(lock.get('port', 0) or 0)
    except (TypeError, ValueError):
        return 0


def _wait_release(
    base: str, since: int, chunk: float,
) -> tuple[int, Optional[list], Optional[str]]:
    """Block (in chunks) until the apply epoch passes ``since``.

    Returns (new epoch, files touched by the releasing Apply, the
    Apply's empty-block interpretation); exits (raises) on transport
    errors — the caller maps those to exit code 2 (server gone).
    ``files == []`` means the Apply submitted with nothing staged:
    full agreement. ``empties`` is 'undecided' | 'agreed' | None
    (0026; None before any Apply or on an old server).
    """
    while True:
        url = f'{base}/api/wait?since={since}&timeout={chunk}'
        data = _get_json(url, timeout=chunk + HTTP_MARGIN)
        if data.get('status') == 'applied':
            files = data.get('files')
            return (int(data.get('epoch', since + 1)), files,
                    data.get('empties'))
        since = int(data.get('epoch', since))  # nothing applied; keep waiting


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Block until the user presses Apply changes in the '
                    'pinpoint editor, then print the per-round digest',
    )
    parser.add_argument('path', nargs='?', default='.pinpoint',
                        help='Pinpoint workspace root (default: ./.pinpoint)')
    parser.add_argument('--chunk', type=float, default=60.0,
                        help='Per-request blocking slice in seconds '
                             '(default: 60)')
    return parser


def main(argv: Optional[list] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, OSError, ValueError):
            pass

    parser = build_parser()
    args = parser.parse_args(argv)
    if args.chunk <= 0:
        parser.error('--chunk must be positive')

    workspace = Path(args.path).resolve()
    if not workspace.is_dir():
        print(f'Error: Workspace not found: {workspace}', file=sys.stderr)
        return 1

    port = _resolve_port(workspace)
    base = _base_url(port) if port else ''
    if not port or not _server_alive(base):
        print(
            'Error: no pinpoint server running for '
            f'{workspace} (lock.json stale or missing). Start it first:\n'
            '    python scripts/server.py --daemon',
            file=sys.stderr,
        )
        return 1

    try:
        current = _get_json(f'{base}/api/wait?since=0&timeout=0', timeout=5)
        epoch = int(current.get('epoch', 0))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f'Error: server unreachable at {base}: {exc}', file=sys.stderr)
        return 1

    release: int
    files: Optional[list] = None
    empties: Optional[str] = None
    if decide_immediate(
            digest.read_apply_epoch(workspace), epoch,
            digest.peek_pending(workspace)):
        release = epoch  # unconsumed work predates this wait — digest now
    else:
        try:
            release, files, empties = _wait_release(base, epoch, args.chunk)
        except (urllib.error.URLError, OSError) as exc:
            print(
                '[WAIT] pinpoint server exited mid-wait — nothing new was '
                'applied. If you applied annotations after the waiter '
                f'stopped, run digest.py ({exc}).',
                file=sys.stderr,
            )
            return 2

    # The apply happened: say what its untouched blocks mean (0026)
    # — full agreement, or the user's explicit undecided/agreed claim —
    # instead of leaving the empties' meaning to guess. Then print the
    # digest and record the epoch so the next wait blocks until a
    # genuinely new Apply.
    note = release_note(files, empties)
    if note is not None:
        print(note)
    return digest.run(workspace, apply_epoch=release)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(
            '[WAIT] interrupted — unapplied staging survives in the server; '
            'rerun wait.py (or digest.py) to pick up applied notes.',
            file=sys.stderr,
        )
        raise SystemExit(130)
