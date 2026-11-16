#!/usr/bin/env python3
"""pinpoint - Per-doc empty-block review state (0026).

An Apply that carries staged work must say what the un-annotated
blocks mean: ``undecided`` (the default — silence is not consent) or
``agreed``. The choice is a first-class state, not a transient UI
toggle: it is recorded on disk, survives rounds, and is superseded
only by a later Apply.

Storage: ``state/empties.json``, a flat map of doc file name ->
``undecided`` | ``agreed``. Written only by a fully successful Apply
(server.py); read by the editor API and export.py's convergence gate.
A full-agreement Apply (nothing staged anywhere — 0015) approves
every document.
"""

import json
from pathlib import Path
from typing import Optional

from server_common import write_text_lf

STATE_DIR_NAME = 'state'
STATE_FILE_NAME = 'empties.json'

UNDECIDED = 'undecided'
AGREED = 'agreed'


def state_path(workspace: Path) -> Path:
    """The state file location under ``workspace``."""
    return workspace / STATE_DIR_NAME / STATE_FILE_NAME


def read(workspace: Path) -> dict:
    """The recorded map doc file name -> 'undecided' | 'agreed'.

    Absent or corrupt state reads as {} — a broken state file must
    never brick exports or the editor.
    """
    try:
        raw = json.loads(state_path(workspace).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(name): value for name, value in raw.items()
        if value in (UNDECIDED, AGREED)
    }


def normalize(raw: object) -> Optional[str]:
    """Coerce a client-supplied empties value; None = not stated."""
    return raw if raw in (UNDECIDED, AGREED) else None


def record(
    workspace: Path, modified: list, empties: str, doc_names: list,
) -> dict:
    """Record one successful Apply's empty-block interpretation.

    ``modified`` — the files the Apply touched; each gets ``empties``.
    Docs untouched by a partial Apply keep their previous state (an
    undecided round on doc A must not un-converge doc B).
    ``doc_names`` — every doc in docs/; used only when ``modified``
    is empty (a full-agreement Apply approves them all, per 0015's
    document-wide approval). Returns the new map.
    """
    state = read(workspace)
    targets = modified if modified else doc_names
    value = empties if modified else AGREED
    for name in targets:
        state[name] = value
    path = state_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_text_lf(path, json.dumps(state, sort_keys=True))
    return state
