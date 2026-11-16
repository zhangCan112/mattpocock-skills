#!/usr/bin/env python3
"""
pinpoint - Browser annotation editor server.

Flask backend for the pinpoint web editor: serves the UI, lists docs,
stages annotations and direct text edits in memory, and writes them only
on Apply (save-all), appending audit history to annotations.jsonl /
edits.jsonl.

Under the C route (issue 0008) the truth source is the markdown master
docs/<name>.md: GET serves a projection rendered fresh from the master
(cached in memory by content hash, never written to disk), Apply
translates staged work into marker lines and block text in the master
and snapshots the consume baseline state/<stem>.base.md, and legacy
docs/<name>.html migrate to masters on first open (old file archived).

Adapted from ppt-master's battle-tested svg_editor/server.py lifecycle:
per-workspace lock.json single instance, idle timeout, /api/shutdown,
Host/Origin header checks, path-traversal guards.

Usage:
    python scripts/server.py [workspace] [options]

    workspace            pinpoint workspace root (default: ./.pinpoint)
    --port N             bind exactly this port (default: first free from 6160)
    --timeout SECONDS    idle auto-stop (default 900; 0 disables; deferred
                         while unapplied staged work exists)
    --no-browser         do not auto-open the browser
    --daemon             start in background, return when reachable
    --shutdown           stop the running server for this workspace

Dependencies:
    flask>=3.0.0, markdown, beautifulsoup4 (auto-installed via pip on
    first ModuleNotFoundError)
"""

import argparse
import atexit
import hashlib
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional, Union

import master
import migrate
import review_state
from annotations import (
    ATTR_ANNOTATION,
    ATTR_TARGET,
    TEMP_PREFIX,
    assign_temp_ids,
    find_by_id,
    parse_annotations,
    parse_doc_text,
    set_annotation,
    set_text,
    strip_unused_temp_ids,
)
from server_common import (
    claim_lock as _claim_lock,
    clear_lock as _clear_lock,
    ensure_workspace,
    find_free_port as _find_free_port,
    import_or_install,
    lock_pid as _lock_pid,
    open_preview_browser,
    popen_detached as _popen_detached,
    process_alive as _process_alive,
    read_lock as _read_lock,
    release_lock as _release_lock,
    validate_port as _validate_port,
    write_text_lf as _write_text_lf,
)

import_or_install('flask')

from flask import Flask, Response, jsonify, request, send_from_directory

import render

logger = logging.getLogger('pinpoint')

DOCS_DIR_NAME = 'docs'
ASSETS_DIR_NAME = 'assets'
STATE_DIR_NAME = 'state'
ARCHIVE_DIR_NAME = 'archive'
LOCK_FILE_NAME = 'lock.json'
EDIT_LOG_NAME = 'edits.jsonl'
ANNOTATION_LOG_NAME = 'annotations.jsonl'
SERVER_LOG_NAME = 'server.log'

MASTER_SUFFIX = '.md'
LEGACY_SUFFIX = '.html'
BASELINE_SUFFIX = '.base.md'

# Keep pinpoint away from ppt-master's live preview / confirm UI port range
# so a stale pinpoint tab cannot shut down another tool.
DEFAULT_PORT = 6160
PUBLIC_HOST = '127.0.0.1'
STARTUP_TIMEOUT = 15

MAX_ELEMENT_ID_LEN = 200
MAX_ANNOTATION_LEN = 10000
MAX_EDIT_TEXT_LEN = 5000


def _server_url(port: int, path: str = '') -> str:
    suffix = path if path.startswith('/') or not path else f'/{path}'
    return f'http://{PUBLIC_HOST}:{port}{suffix}'


def _append_log(workspace: Path, filename: str, record: dict) -> None:
    """Append one history record to the workspace JSONL log."""
    try:
        with open(workspace / filename, 'a', encoding='utf-8') as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + '\n')
    except OSError as exc:
        logger.warning('log append failed (%s): %s', filename, exc)


def _serialize_inner(root: ET.Element) -> str:
    """Serialize the body's children as an HTML fragment string."""
    body = root if root.tag == 'body' else root.find('body')
    if body is None:
        body = root
    return ''.join(ET.tostring(child, encoding='unicode') for child in body)


def _serialize_document(root: ET.Element) -> str:
    return '<!DOCTYPE html>\n' + ET.tostring(root, encoding='unicode') + '\n'


def idle_stop_decision(elapsed: float, timeout: int, has_staged: bool,
                       over_time_seen: bool) -> tuple:
    """Decide whether the idle watchdog should stop the server.

    Returns ``(stop, over_time_seen_next)``. Staged work vetoes the stop —
    unapplied user input outranks process hygiene. A fresh over-time
    reading needs a second consecutive tick before stopping, so a tab
    that just woke up (and is about to heartbeat) wins the race.
    """
    if has_staged:
        return False, False
    if elapsed > timeout:
        return (True, True) if over_time_seen else (False, True)
    return False, False


def _has_staged_work(app) -> bool:
    """True when any doc has unapplied annotations or direct edits staged.

    A staged-but-empty annotation snapshot counts too: it encodes the
    user's "deleted every note" intent, still pending Apply.
    """
    return bool(app.config['ANNOTATIONS'] or app.config['PENDING_EDITS'])


def _assign_ids_to_annotated(root: ET.Element) -> None:
    """Give temp ids to annotated elements the annotatable-tag pass skipped.

    Marker translation can land a note on a non-annotatable element (a
    code fence's span.line): it still needs a temp id so the editor can
    address it and Apply can translate it back to a pp@N marker.
    """
    used = []
    for elem in root.iter():
        eid = elem.get('id', '')
        if eid.startswith(TEMP_PREFIX):
            try:
                used.append(int(eid[len(TEMP_PREFIX):]))
            except ValueError:
                continue
    counter = max(used, default=-1) + 1
    for elem in root.iter():
        if elem.get(ATTR_TARGET) == 'true' and elem.get('id') is None:
            elem.set('id', f'{TEMP_PREFIX}{counter}')
            counter += 1


def _build_mapping(root: ET.Element, spans: list) -> dict:
    """temp id -> (master block index, fence content line or None).

    A master block may render to zero, one, or several top-level
    elements (a lone link-reference definition renders to none; a
    paragraph run with a quote or raw HTML to several), so the body's
    children do NOT correspond 1:1 to parse_master blocks: ``spans``,
    from master.projection_blocks, gives each block's (start, end) child
    range. class="line" elements are ranked per block in document order
    by master.line_rank_in - the same counting that master's marker
    translation uses, so a pp@N marker and the temp id of the line it
    annotates agree on N.
    """
    children = list(root)
    covered = 0
    for _start, end in spans:
        covered = max(covered, end)
    if covered != len(children):
        raise master.MasterError(
            f'projection spans cover {covered} of {len(children)} '
            f'top-level elements')
    mapping = {}
    for index, (start, end) in enumerate(spans):
        group = children[start:end]
        for block_el in group:
            for el in block_el.iter():
                eid = el.get('id')
                if eid:
                    mapping[eid] = (index, master.line_rank_in(group, el))
    return mapping


def _replace_element_text(
    block_html: str, element_id: str, text: str,
) -> Optional[str]:
    """A rendered block's HTML with one element's text swapped in.

    Same refusals as annotations.set_text (unknown id, element children);
    returns None when refused. Direct edits on sub-blocks (a li or td)
    therefore re-serialize the whole enclosing block through the
    migration serializer instead of flattening the list/table.
    """
    root = parse_doc_text(f'<body>{block_html}</body>')
    elem = find_by_id(root, element_id)
    if elem is None or len(elem) > 0:
        return None
    elem.text = text
    return ''.join(ET.tostring(child, encoding='unicode') for child in root)


def _element_fingerprint(elem: ET.Element) -> tuple:
    """Content anchor of an element: (tag, whitespace-normalized text).

    Positional _pp_N ids renumber whenever the master changes between
    staging and serving; the fingerprint is what a staged annotation or
    direct edit actually points at (annotations.py: the id is only a
    session-local address label, never a persistent anchor).
    """
    tag = elem.tag.split('}', 1)[-1]
    text = ' '.join(''.join(elem.itertext()).split())
    return (tag, text)


def _fingerprints(root: ET.Element) -> dict:
    """id -> fingerprint for every id-carrying element of a projection."""
    out = {}
    for el in root.iter():
        eid = el.get('id')
        if eid:
            out[eid] = _element_fingerprint(el)
    return out


def reanchor_annotations(
    snapshot: dict, anchors: dict, root: ET.Element,
) -> list:
    """Re-key staged annotations onto the current projection ids.

    A master edited while work is staged (the consume step of the live
    loop edits docs between user rounds) renumbers every _pp_N after the
    edit: without re-anchoring, notes silently land on the wrong block or
    dangle as ghosts. Each note follows its recorded fingerprint; ids
    that still match keep their id (zero churn in the common case).

    A note whose content matches nothing anymore (its block was deleted
    or rewritten) is parked on a "!stale!<id>" key first: it must not
    block the live id it coincidentally holds — that id belongs to a
    different block now and another note may need it. Runs to a fixpoint
    so a shifted id vacated by one note is claimable by the next in the
    same call. Returns the keys still unresolved.
    """
    current = _fingerprints(root)
    stale = {
        eid for eid in snapshot
        if anchors.get(eid) is not None
        and current.get(eid) != anchors.get(eid)}
    parked: dict = {}
    for eid in stale:
        anchor = anchors[eid]
        if not any(fp == anchor for fp in current.values()):
            key = f'!stale!{eid}'
            parked[key] = snapshot.pop(eid)
            anchors[key] = anchors.pop(eid)

    for _ in range(len(snapshot) + 1):
        taken = {
            eid for eid in snapshot
            if current.get(eid) == anchors.get(eid)}
        rekey = []
        for eid in list(snapshot):
            anchor = anchors.get(eid)
            if anchor is None or eid in taken:
                continue
            for nid, fp in current.items():
                if fp == anchor and nid not in taken and nid not in snapshot:
                    rekey.append((eid, nid))
                    taken.add(nid)
                    break
        if not rekey:
            break
        for old, new in rekey:
            snapshot[new] = snapshot.pop(old)
            anchors[new] = anchors.pop(old)

    snapshot.update(parked)
    unresolved = []
    for eid in snapshot:
        anchor = anchors.get(eid)
        if anchor is None:
            if eid not in current:
                unresolved.append(eid)
        elif current.get(eid) != anchor:
            unresolved.append(eid)
    return unresolved


def reanchor_edits(records: list, root: ET.Element) -> None:
    """Re-key staged direct edits by their recorded original text.

    Same renumbering hazard as annotations: a staged edit whose target
    id shifted would overwrite whatever element now sits at that id.
    """
    current_fp = _fingerprints(root)
    by_id = {el.get('id'): el for el in root.iter() if el.get('id')}
    used = {r['element_id'] for r in records}
    for record in records:
        eid = record['element_id']
        elem = by_id.get(eid)
        old_norm = ' '.join((record['old'] or '').split())
        if elem is not None and len(elem) == 0 and \
                ' '.join((elem.text or '').split()) == old_norm:
            continue
        for nid, fp in current_fp.items():
            if nid in used or nid == eid:
                continue
            el = by_id.get(nid)
            if el is None or len(el) > 0:
                continue
            if fp[1] == old_norm:
                used.discard(eid)
                used.add(nid)
                record['element_id'] = nid
                break


def create_app(
    workspace_dir: str,
    idle_timeout: int = 900,
    lock_file: Optional[Path] = None,
) -> Flask:
    """Create and configure the Flask app for a pinpoint workspace."""
    workspace = Path(workspace_dir).resolve()
    docs_dir = workspace / DOCS_DIR_NAME
    assets_dir = workspace / ASSETS_DIR_NAME

    app = Flask(__name__, static_folder='static', static_url_path='/static')
    app.config['WORKSPACE'] = workspace
    app.config['DOCS_DIR'] = docs_dir
    app.config['ASSETS_DIR'] = assets_dir
    app.config['STATE_DIR'] = workspace / STATE_DIR_NAME
    app.config['ARCHIVE_DIR'] = workspace / ARCHIVE_DIR_NAME
    app.config['LOCK_FILE'] = lock_file
    # In-memory staging: {doc_name: {element_id: annotation_text}}
    app.config['ANNOTATIONS'] = {}
    # Content anchors for staged work: {doc_name: {element_id: fingerprint}},
    # so notes survive a master edit that renumbers the _pp_N ids.
    app.config['ANNOTATION_ANCHORS'] = {}
    # Per-doc staged direct edits; written to docs/ only by /api/save-all.
    app.config['PENDING_EDITS'] = {}
    # Projection cache: {doc_name: {hash, content, annotations, mapping}},
    # keyed by master content hash. Never written to disk.
    app.config['PROJECTION_CACHE'] = {}
    app.config['LAST_REQUEST_TIME'] = time.time()
    # Test seam: os._exit in production, callable hook under test.
    app.config['EXIT_HOOK'] = os._exit
    app.config['SHUTDOWN_DELAY'] = 0.5
    # Apply epoch: bumped once per fully successful /api/save-all. The
    # blocking /api/wait endpoint releases when the epoch moves past the
    # caller's snapshot, so an agent-side waiter (wait.py) wakes the
    # moment the user confirms Apply changes in the browser — no chat
    # go-signal needed. A failed Apply bumps nothing.
    app.config['APPLY_EPOCH'] = 0
    app.config['APPLY_EVENT'] = threading.Condition()
    # Files touched by the latest successful Apply. An empty list means
    # the user submitted with nothing staged — full agreement (0015):
    # the epoch still bumps and the waiter still releases, so the agent
    # learns the user approved the whole document.
    app.config['LAST_APPLY_FILES'] = []
    # 0026: the empty-block interpretation of the latest successful
    # Apply — 'undecided' (silence is not consent) or 'agreed'. Carried
    # to wait.py via /api/wait so the agent learns what an Apply's
    # untouched blocks mean; None until a first Apply happens.
    app.config['LAST_APPLY_EMPTIES'] = None

    @app.before_request
    def _update_activity():
        allowed_hosts = {PUBLIC_HOST, 'localhost', '::1', '[::1]'}
        host = request.headers.get('Host', '').lower()
        if host.startswith('[') or host.count(':') == 1:
            host = host.rsplit(':', 1)[0]
        if host not in allowed_hosts:
            return jsonify({'error': 'Forbidden Host header'}), 403
        origin = request.headers.get('Origin')
        if origin is not None:
            try:
                origin_host = urllib.parse.urlsplit(origin).hostname
            except ValueError:
                origin_host = None
            if origin_host not in allowed_hosts:
                return jsonify({'error': 'Forbidden Origin header'}), 403
        if request.path != '/api/wait':
            # /api/wait must not feed the idle watchdog: the waiter is a
            # passive observer. Keeping the server alive through it would
            # defeat the idle lifecycle — the tab heartbeat and the
            # staged-work veto own whether the wait outlives idleness.
            app.config['LAST_REQUEST_TIME'] = time.time()

    @app.after_request
    def _no_cache_static(resp):
        # Editor JS/CSS must update immediately after skill upgrades;
        # a stale app.js from the browser cache is a support trap.
        if request.path.startswith('/static/'):
            resp.headers['Cache-Control'] = 'no-cache'
        return resp

    def _exit_with_lock_release(code: int = 0) -> None:
        lf = app.config.get('LOCK_FILE')
        if lf is not None:
            _release_lock(lf)
        # os._exit skips atexit handlers; we released the lock manually.
        app.config['EXIT_HOOK'](code)

    def _idle_watchdog():
        if idle_timeout <= 0:
            return
        over_time_seen = False
        deferred_logged = False
        while True:
            time.sleep(10)
            elapsed = time.time() - app.config['LAST_REQUEST_TIME']
            staged = _has_staged_work(app)
            stop, over_time_seen = idle_stop_decision(
                elapsed, idle_timeout, staged, over_time_seen,
            )
            if stop:
                logger.info('idle for %ds, shutting down', idle_timeout)
                _exit_with_lock_release(0)
                return
            if staged and elapsed > idle_timeout and not deferred_logged:
                deferred_logged = True
                logger.info(
                    'idle %ds but unapplied staged work present; '
                    'deferring auto-stop',
                    int(elapsed),
                )
            if elapsed <= idle_timeout:
                deferred_logged = False

    threading.Thread(target=_idle_watchdog, daemon=True).start()

    @app.route('/')
    def index():
        return send_from_directory(app.static_folder, 'index.html')

    @app.route('/api/health')
    def health():
        """Cheap readiness probe; also identifies this workspace."""
        try:
            doc_count = 0
            for pattern in (f'*{MASTER_SUFFIX}', f'*{LEGACY_SUFFIX}'):
                doc_count += len(list(docs_dir.glob(pattern)))
        except OSError:
            doc_count = 0
        resp = jsonify({
            'status': 'ok',
            'service': 'pinpoint',
            'pid': os.getpid(),
            'workspace': str(workspace),
            'docs': doc_count,
        })
        resp.headers['Cache-Control'] = 'no-store'
        return resp

    def _doc_files() -> list:
        """Doc files to list: masters first-class, legacy HTML without one.

        An HTML file whose master exists is a migration leftover (crash
        between master write and archive move); the master is the truth.
        """
        if not docs_dir.exists():
            return []
        files = sorted(docs_dir.glob(f'*{MASTER_SUFFIX}'))
        masters = {f.name for f in files}
        files.extend(
            f for f in sorted(docs_dir.glob(f'*{LEGACY_SUFFIX}'))
            if f.stem + MASTER_SUFFIX not in masters
        )
        return files

    @app.route('/api/docs')
    def get_docs():
        docs = []
        empties_map = review_state.read(workspace)
        for doc_file in _doc_files():
            ok = True
            error_msg: Optional[str] = None
            disk_count = 0
            try:
                if doc_file.name.endswith(MASTER_SUFFIX):
                    text = doc_file.read_text(encoding='utf-8-sig')
                    disk_count = sum(
                        len(mb.markers) for mb in master.parse_master(text))
                else:
                    root = parse_doc_text(
                        doc_file.read_text(encoding='utf-8-sig'))
                    disk_count = len(parse_annotations(root))
            except (master.MasterError, ET.ParseError, OSError) as exc:
                ok = False
                error_msg = f'parse error: {exc}'
            staged = app.config['ANNOTATIONS'].get(doc_file.name)
            count = len(staged) if staged is not None else disk_count
            staged_edits = len(
                app.config['PENDING_EDITS'].get(doc_file.name) or [])
            try:
                mtime = doc_file.stat().st_mtime
            except OSError:
                mtime = 0
            docs.append({
                'name': doc_file.name,
                'annotated': count > 0,
                'annotation_count': count,
                'ok': ok,
                'error': error_msg,
                'mtime': mtime,
                # Staged (unapplied) work, for the Apply confirm modal:
                # staged_snapshot with staged_notes == 0 encodes the
                # user's delete-every-note intent — still pending Apply.
                'staged_notes': len(staged) if staged is not None else 0,
                'staged_snapshot': staged is not None,
                'staged_edits': staged_edits,
                # 0026: the doc's last-Apply empty-block state, so the
                # editor can show convergence back to its holder.
                'empties': empties_map.get(doc_file.name),
            })
        return jsonify({'docs': docs})

    def _safe_doc_path(name: str) -> Optional[Path]:
        """Reject traversal; resolve and verify the doc stays under docs/."""
        if '/' in name or '\\' in name or '..' in name or not name:
            return None
        doc_file = (docs_dir / name).resolve()
        try:
            doc_file.relative_to(docs_dir.resolve())
        except ValueError:
            return None
        return doc_file

    def _is_master_name(name: str) -> bool:
        return name.endswith(MASTER_SUFFIX)

    def _baseline_path(name: str) -> Path:
        """Consume baseline path (0012 contract): state/<stem>.base.md."""
        return app.config['STATE_DIR'] / (Path(name).stem + BASELINE_SUFFIX)

    def _resolve_doc_name(name: str) -> Optional[str]:
        """Map a requested doc name to the name it is served under.

        Masters are served as-is. A legacy name resolves to its master
        when one exists, and on the first open migrates the HTML doc
        (master written, old file archived, baseline snapshotted). If
        migration fails the legacy name stands and today's HTML path
        serves it. Unknown names return None (caller 404s).
        """
        if _safe_doc_path(name) is None:
            return None
        if _is_master_name(name):
            return name if (docs_dir / name).exists() else None
        master_name = Path(name).stem + MASTER_SUFFIX
        if (docs_dir / master_name).exists():
            return master_name
        legacy = docs_dir / name
        if not legacy.is_file() or not name.lower().endswith(LEGACY_SUFFIX):
            return None
        try:
            migrate.migrate_legacy_doc(
                html_path=legacy,
                master_path=docs_dir / master_name,
                archive_path=app.config['ARCHIVE_DIR'] / name,
                baseline_path=_baseline_path(master_name),
            )
            logger.info('migrated legacy doc %s -> %s', name, master_name)
        except migrate.MigrationError as exc:
            logger.warning(
                'migration of %s failed (%s); serving legacy HTML', name, exc)
            return name
        return master_name

    def _master_snapshot(name: str) -> tuple:
        """Projection cache entry for the doc's current master text.

        Keyed by SHA-256 of the master text: a master edit invalidates
        the entry and the next serve re-renders. The projection is never
        written to disk. Returns (entry, None) or (None, (response, code)).
        """
        try:
            text = (docs_dir / name).read_text(encoding='utf-8-sig')
        except OSError as exc:
            return None, (jsonify({'error': f'Failed to read doc: {exc}'}), 500)
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        cache = app.config['PROJECTION_CACHE']
        entry = cache.get(name)
        if entry is None or entry['hash'] != digest:
            try:
                content, spans = master.projection_blocks(text)
            except master.MasterError as exc:
                logger.warning('master projection failed: %s: %s', name, exc)
                return None, (jsonify(
                    {'error': f'Failed to render master: {exc}'}), 500)
            try:
                root = parse_doc_text(f'<body>{content}</body>')
            except ET.ParseError as exc:
                logger.warning('projection parse failed: %s: %s', name, exc)
                return None, (jsonify(
                    {'error': f'Failed to parse projection: {exc}'}), 500)
            assign_temp_ids(root)
            _assign_ids_to_annotated(root)
            try:
                mapping = _build_mapping(root, spans)
            except master.MasterError as exc:
                logger.warning('projection mapping failed: %s: %s', name, exc)
                return None, (jsonify(
                    {'error': f'Failed to map projection: {exc}'}), 500)
            entry = {
                'hash': digest,
                'content': _serialize_inner(root),
                'annotations': {
                    item['element_id']: item['annotation']
                    for item in parse_annotations(root)
                },
                'mapping': mapping,
                'spans': spans,
            }
            cache[name] = entry
        return entry, None

    def _load_served_root(name: str) -> tuple:
        """The doc's served projection as a fresh ET root.

        Masters render through the hash-keyed projection cache; legacy
        docs parse from disk as before. Returns (root, None) or
        (None, (response, code)). ``name`` must already be resolved.
        """
        if _is_master_name(name):
            entry, error = _master_snapshot(name)
            if error is not None:
                return None, error
            try:
                return parse_doc_text(f"<body>{entry['content']}</body>"), None
            except ET.ParseError as exc:
                return None, (jsonify(
                    {'error': f'Failed to parse projection: {exc}'}), 500)
        return _load_doc_root(name)

    def _load_doc_root(name: str) -> tuple:
        """Parse a legacy doc file.

        Returns ``(root, None)`` or ``(None, (resp, code))``.
        """
        doc_file = _safe_doc_path(name)
        if doc_file is None:
            return None, (jsonify({'error': 'Invalid doc name'}), 400)
        if not doc_file.exists():
            return None, (jsonify({'error': 'Doc not found'}), 404)
        try:
            root = parse_doc_text(doc_file.read_text(encoding='utf-8-sig'))
        except ET.ParseError as exc:
            logger.warning('doc parse failed: %s: %s', name, exc)
            return None, (jsonify(
                {'error': f'Failed to parse doc: {exc}'}), 500)
        except OSError as exc:
            return None, (jsonify({'error': f'Failed to read doc: {exc}'}), 500)
        return root, None

    def _apply_pending_edits(root: ET.Element, records: list) -> Optional[str]:
        for record in records:
            ok, reason = set_text(root, record['element_id'], record['text'])
            if not ok:
                return reason
        return None

    @app.route('/api/doc/<name>')
    def get_doc(name: str) -> Union[Response, tuple[Response, int]]:
        resolved = _resolve_doc_name(name)
        if resolved is None:
            return jsonify({'error': 'Doc not found'}), 404

        root, error = _load_served_root(resolved)
        if error is not None:
            return error
        assert root is not None

        if not _is_master_name(resolved):
            assign_temp_ids(root)
            unresolved_ids: list = []
        else:
            # Staged work may predate a master edit (the consume step of
            # the live loop): re-key it onto the current ids first, so
            # neither the preview nor Apply writes into shifted targets.
            unresolved_ids = _reanchor_staged_work(resolved, root)

        pending = app.config['PENDING_EDITS'].get(resolved) or []
        failure = _apply_pending_edits(root, pending)
        if failure is not None:
            return jsonify(
                {'error': f'Failed to apply pending edits: {failure}'}), 500

        if _is_master_name(resolved):
            entry, error = _master_snapshot(resolved)
            if error is not None:
                return error
            disk_annotations = dict(entry['annotations'])
        else:
            disk_annotations = {
                item['element_id']: item['annotation']
                for item in parse_annotations(root)
            }
        id_to_tag: dict = {}
        for elem in root.iter():
            eid = elem.get('id')
            if eid:
                id_to_tag[eid] = elem.tag

        merged = dict(app.config['ANNOTATIONS'].get(resolved, disk_annotations))
        annotations_list = [
            {'element_id': eid, 'tag': id_to_tag.get(eid, ''),
             'annotation': text}
            for eid, text in merged.items()
        ]
        try:
            mtime = (docs_dir / resolved).stat().st_mtime
        except OSError:
            mtime = 0

        return jsonify({
            'name': resolved,
            'content': _serialize_inner(root),
            'annotations': annotations_list,
            # staged notes whose block vanished or shifted beyond
            # recognition: the UI flags them; Apply refuses them
            'unresolved': unresolved_ids,
            'mtime': mtime,
            'undo_depth': len(pending),
            # 0026: last-Apply empty-block state (undecided | agreed |
            # None = never applied) — the status strip shows it.
            'empties': review_state.read(workspace).get(resolved),
        })

    def _reanchor_staged_work(name: str, root: ET.Element) -> list:
        """Follow the current projection: re-key staged annotations and
        direct edits whose positional ids went stale after a master edit
        (see reanchor_annotations / reanchor_edits). Master docs only -
        legacy docs carry annotations inside the file itself.
        Returns the annotation ids that still match no block."""
        if not _is_master_name(name):
            return []
        anchors = app.config['ANNOTATION_ANCHORS'].get(name)
        if anchors is None:
            anchors = app.config['ANNOTATION_ANCHORS'][name] = {}
        unresolved: list = []
        snapshot = app.config['ANNOTATIONS'].get(name)
        if snapshot:
            unresolved = reanchor_annotations(snapshot, anchors, root)
        edits = app.config['PENDING_EDITS'].get(name)
        if edits:
            reanchor_edits(edits, root)
        return unresolved

    def _seed_annotation_anchors(name: str, root: ET.Element) -> None:
        """Record fingerprints for every currently annotated element, so
        later re-anchoring can follow them through a master edit."""
        anchors = app.config['ANNOTATION_ANCHORS'].get(name)
        if anchors is None:
            anchors = app.config['ANNOTATION_ANCHORS'][name] = {}
        snapshot = app.config['ANNOTATIONS'].get(name)
        if not snapshot:
            return
        current = _fingerprints(root)
        for eid in snapshot:
            if eid in current and eid not in anchors:
                anchors[eid] = current[eid]

    def _get_annotation_snapshot(name: str) -> tuple:
        """Return the doc's staged annotation state, loading it once.

        ``name`` must already be resolved; the snapshot is keyed by the
        resolved (master) name.
        """
        annotations = app.config['ANNOTATIONS']
        if name in annotations:
            return annotations[name], None
        root, error = _load_served_root(name)
        if error is not None:
            return None, error
        assert root is not None
        assign_temp_ids(root)
        _assign_ids_to_annotated(root)
        annotations[name] = {
            item['element_id']: item['annotation']
            for item in parse_annotations(root)
        }
        _seed_annotation_anchors(name, root)
        return annotations[name], None

    @app.route('/api/doc/<name>/annotate', methods=['POST'])
    def post_annotate(name: str) -> Union[Response, tuple[Response, int]]:
        data = request.get_json(silent=True)
        if not data or 'element_id' not in data or 'annotation' not in data:
            return jsonify({'error': 'Missing element_id or annotation'}), 400
        element_id = data['element_id']
        annotation = data['annotation']
        if not isinstance(element_id, str) or not isinstance(annotation, str):
            return jsonify(
            {'error': 'element_id and annotation must be strings'}), 400
        if len(element_id) > MAX_ELEMENT_ID_LEN:
            return jsonify(
            {'error': f'element_id too long (max {MAX_ELEMENT_ID_LEN})'}), 400
        if len(annotation) > MAX_ANNOTATION_LEN:
            return jsonify(
            {'error': f'Annotation too long (max {MAX_ANNOTATION_LEN})'}), 400

        resolved = _resolve_doc_name(name)
        if resolved is None:
            return jsonify({'error': 'Doc not found'}), 404
        snapshot, error = _get_annotation_snapshot(resolved)
        if error is not None:
            return error
        assert snapshot is not None
        snapshot[element_id] = annotation
        # Record what the note actually points at, so a master edit that
        # renumbers the ids cannot silently detach it.
        if _is_master_name(resolved):
            root, load_error = _load_served_root(resolved)
            if load_error is None:
                elem = None
                for el in root.iter():
                    if el.get('id') == element_id:
                        elem = el
                        break
                if elem is not None:
                    anchors = app.config['ANNOTATION_ANCHORS'].setdefault(
                        resolved, {})
                    anchors[element_id] = _element_fingerprint(elem)
        return jsonify({'status': 'ok', 'count': len(snapshot)})

    @app.route('/api/doc/<name>/annotate/<element_id>', methods=['DELETE'])
    def delete_annotate(
        name: str, element_id: str,
    ) -> Union[Response, tuple[Response, int]]:
        resolved = _resolve_doc_name(name)
        if resolved is None:
            return jsonify({'error': 'Doc not found'}), 404
        snapshot, error = _get_annotation_snapshot(resolved)
        if error is not None:
            return error
        assert snapshot is not None
        if element_id not in snapshot:
            return jsonify({'error': 'Annotation not found'}), 404
        del snapshot[element_id]
        app.config['ANNOTATION_ANCHORS'].get(name, {}).pop(element_id, None)
        return jsonify({'status': 'ok', 'count': len(snapshot)})

    @app.route('/api/doc/<name>/edit', methods=['POST'])
    def post_edit(name: str) -> Union[Response, tuple[Response, int]]:
        data = request.get_json(silent=True)
        if not data or 'element_id' not in data or 'text' not in data:
            return jsonify({'error': 'Missing element_id or text'}), 400
        element_id = data['element_id']
        text = data['text']
        if not isinstance(element_id, str) or not isinstance(text, str):
            return jsonify(
            {'error': 'element_id and text must be strings'}), 400
        if len(element_id) > MAX_ELEMENT_ID_LEN:
            return jsonify(
            {'error': f'element_id too long (max {MAX_ELEMENT_ID_LEN})'}), 400
        if len(text) > MAX_EDIT_TEXT_LEN:
            return jsonify(
            {'error': f'text too long (max {MAX_EDIT_TEXT_LEN})'}), 400

        resolved = _resolve_doc_name(name)
        if resolved is None:
            return jsonify({'error': 'Doc not found'}), 404
        root, error = _load_served_root(resolved)
        if error is not None:
            return error
        assert root is not None
        if not _is_master_name(resolved):
            assign_temp_ids(root)
        pending = app.config['PENDING_EDITS'].get(resolved) or []
        failure = _apply_pending_edits(root, pending)
        if failure is not None:
            return jsonify(
                {'error': f'Failed to apply pending edits: {failure}'}), 500

        elem = find_by_id(root, element_id)
        if elem is None:
            return jsonify({'error': 'not-found'}), 400
        if len(elem) > 0:
            return jsonify({'error': 'has-element-children'}), 400

        record = {
            'element_id': element_id, 'text': text,
            'old': elem.text or ''}
        app.config['PENDING_EDITS'].setdefault(resolved, []).append(record)
        edits_now = app.config['PENDING_EDITS'][resolved]
        return jsonify({'status': 'ok', 'undo_depth': len(edits_now)})

    @app.route('/api/doc/<name>/undo', methods=['POST'])
    def post_undo(name: str) -> Union[Response, tuple[Response, int]]:
        """Drop the most recent staged direct edit on this doc (LIFO)."""
        resolved = _resolve_doc_name(name)
        if resolved is None:
            return jsonify({'error': 'Invalid doc name'}), 400
        stack = app.config['PENDING_EDITS'].get(resolved) or []
        if not stack:
            return jsonify({'status': 'empty', 'undo_depth': 0})
        stack.pop()
        return jsonify({'status': 'ok', 'undo_depth': len(stack)})

    def _apply_master_doc(name: str, anns: dict, has_staged_annotations: bool,
                          edits: list) -> tuple:
        """Translate staged work into the master document.

        Annotations become marker lines (block note above the block,
        ``pp@N`` above the fence); direct edits replace the block's
        markdown — or one fence content line for class="line" targets.
        The consume baseline snapshot (state/<stem>.base.md) updates to
        the new master; never the pending markers of a third party.

        Returns (old_annotations, effective_anns, failure) — failure
        None on success. ``effective_anns`` is the annotation set the
        master now carries (for audit records).
        """
        try:
            text = (docs_dir / name).read_text(encoding='utf-8-sig')
        except OSError as exc:
            return None, None, f'Failed to read doc: {exc}'
        try:
            blocks = master.parse_master(text)
        except master.MasterError as exc:
            return None, None, f'Failed to parse master: {exc}'

        entry, error = _master_snapshot(name)
        if error is not None:
            return None, None, error[0].get_json()['error']
        old_annotations = dict(entry['annotations'])
        mapping = entry['mapping']

        # Staged work may predate a master edit (the consume step of the
        # live loop): re-key it onto the current ids first — exactly like
        # get_doc — then refuse notes that still match no block rather
        # than dropping them silently (the drop used to be log-only).
        unresolved: list = []
        try:
            reanchor_root = parse_doc_text(f"<body>{entry['content']}</body>")
        except ET.ParseError:
            reanchor_root = None
        if reanchor_root is not None:
            unresolved = _reanchor_staged_work(name, reanchor_root)

        if not has_staged_annotations:
            anns = dict(old_annotations)
        else:
            anns = dict(app.config['ANNOTATIONS'].get(name, {}))
            # fingerprint-mismatched ids first, then any id the mapping
            # genuinely lacks (anchor-less seeds)
            missing = [eid for eid in anns
                       if eid not in mapping and eid not in unresolved]
            unresolved = unresolved + missing
            if unresolved:
                listed = '; '.join(
                    f'"{anns.get(eid, eid)}"' for eid in unresolved[:3])
                return old_annotations, anns, (
                    f'{len(unresolved)} annotation(s) no longer match any '
                    f'block ({listed}) - the block was deleted or rewritten '
                    f'outside the editor. Reload the document and re-place '
                    f'or delete those notes, then Apply again.')

        # 1. Annotations: the staged snapshot is the complete desired
        #    set, so first strip every existing marker, then attach the
        #    staged ones. Targets missing from the mapping are dropped
        #    with a warning, same as the HTML path.
        blocks = [mb._replace(markers=[]) for mb in blocks]
        markers: dict = {}
        for element_id, note in anns.items():
            target = mapping.get(element_id)
            if target is None:
                logger.warning(
                    'annotation target missing on save (%s: %s) — dropped',
                    name, element_id,
                )
                continue
            slot = markers.setdefault(
                target[0], {'block': None, 'lines': {}})
            if target[1] is None:
                slot['block'] = migrate.sanitize_note(note)
            else:
                slot['lines'][target[1]] = migrate.sanitize_note(note)
        for idx, slot in markers.items():
            new_markers = []
            if slot['block'] is not None:
                new_markers.append(master.Marker('block', None, slot['block']))
            for line_no in sorted(slot['lines']):
                new_markers.append(
                    master.Marker('line', line_no, slot['lines'][line_no]))
            blocks[idx] = blocks[idx]._replace(markers=new_markers)

        # 2. Direct edits, ascending by target block with an offset, so
        #    an edit that splits its block into several markdown blocks
        #    keeps later targets pointing at the right MasterBlock.
        ordered = []
        for order, record in enumerate(edits):
            target = mapping.get(record['element_id'])
            if target is None:
                return old_annotations, anns, (
                    f'Failed to apply edits: not-found '
                    f'({record["element_id"]})')
            ordered.append((target[0], target[1], order, record))
        ordered.sort(key=lambda item: (item[0], item[2]))

        projection_children = None
        offset = 0
        for idx, line_no, _order, record in ordered:
            mb = blocks[idx + offset]
            if line_no is not None:
                # Fence content line: replace the exact source line.
                if mb.block.kind != 'code' or line_no > len(mb.block.lines):
                    return old_annotations, anns, (
                        'Failed to apply edits: line target vanished')
                lines = list(mb.block.lines)
                lines[line_no - 1] = record['text']
                blocks[idx + offset] = mb._replace(
                    block=mb.block._replace(lines=lines))
                continue
            # Block text: swap the text in the block's projection HTML,
            # then re-serialize the whole block (list/table structure
            # around a li/td edit survives). A block may render to
            # several top-level elements - take them all.
            if projection_children is None:
                projection_children = list(parse_doc_text(
                    f"<body>{entry['content']}</body>"))
            start, end = entry['spans'][idx]
            block_html = ''.join(
                ET.tostring(projection_children[i], encoding='unicode')
                for i in range(start, end))
            edited = _replace_element_text(
                block_html, record['element_id'], record['text'])
            if edited is None:
                return old_annotations, anns, (
                    'Failed to apply edits: element refused the text swap')
            md = migrate.html_body_to_markdown(edited)
            pieces = render.split_blocks(md)
            if not pieces:
                pieces = [render.Block('para', '', ['&nbsp;'])]
            new_blocks = [
                master.MasterBlock(mb.markers if i == 0 else [], piece)
                for i, piece in enumerate(pieces)
            ]
            blocks[idx + offset:idx + offset + 1] = new_blocks
            offset += len(new_blocks) - 1

        # 3. Write master + baseline; drop the stale projection.
        try:
            new_text = master.serialize_master(blocks)
        except master.MasterError as exc:
            return old_annotations, anns, f'Failed to serialize master: {exc}'
        try:
            _write_text_lf(docs_dir / name, new_text)
            baseline = _baseline_path(name)
            baseline.parent.mkdir(parents=True, exist_ok=True)
            _write_text_lf(baseline, new_text)
        except OSError as exc:
            return old_annotations, anns, f'Failed to write doc: {exc}'
        app.config['PROJECTION_CACHE'].pop(name, None)
        return old_annotations, anns, None

    def _apply_legacy_doc(name: str, anns: dict, has_staged_annotations: bool,
                          edits: list) -> tuple:
        """Today's HTML write path (migration fallback only).

        Returns (old_annotations, effective_anns, failure).
        """
        root, error = _load_doc_root(name)
        if error is not None:
            return None, None, error[0].get_json()['error']
        assert root is not None

        assign_temp_ids(root)
        failure = _apply_pending_edits(root, edits)
        if failure is not None:
            return None, None, f'Failed to apply edits: {failure}'

        old_annotations = {
            item['element_id']: item['annotation']
            for item in parse_annotations(root)
        }
        if not has_staged_annotations:
            anns = old_annotations

        for elem in root.iter():
            elem.attrib.pop(ATTR_TARGET, None)
            elem.attrib.pop(ATTR_ANNOTATION, None)
        for element_id, annotation_text in anns.items():
            if not set_annotation(root, element_id, annotation_text):
                logger.warning(
                    'annotation target missing on save (%s: %s) — dropped',
                    name, element_id,
                )

        # Only annotated elements keep their id: it is the AI's locator
        # until the note is consumed (protocol.md). The rest are session
        # pollution.
        strip_unused_temp_ids(root, set(anns.keys()))

        doc_file = _safe_doc_path(name)
        if doc_file is None:
            return old_annotations, anns, 'Invalid doc path'
        try:
            _write_text_lf(doc_file, _serialize_document(root))
        except OSError as exc:
            return old_annotations, anns, f'Failed to write doc: {exc}'
        return old_annotations, anns, None

    @app.route('/api/save-all', methods=['POST'])
    def save_all():
        annotations = app.config['ANNOTATIONS']
        pending_edits = app.config['PENDING_EDITS']
        modified = []
        failures = []
        # 0026: the Apply's claim about the blocks it did not touch.
        # Missing or unknown values (old clients) read as undecided —
        # silence is not consent; only an explicit 'agreed' (or the
        # nothing-staged full agreement below) approves the rest.
        choice = review_state.normalize(
            (request.get_json(silent=True) or {}).get('empties'))
        interpretation = choice or review_state.UNDECIDED

        filenames = sorted(set(annotations.keys()) | set(pending_edits.keys()))
        for filename in filenames:
            # A staged-but-empty snapshot means the user deleted every
            # annotation — still write, so the on-disk markers are cleared.
            has_staged_annotations = filename in annotations
            anns = dict(annotations.get(filename, {}))
            edits = pending_edits.get(filename, [])

            if _is_master_name(filename):
                old_annotations, effective_anns, failure = _apply_master_doc(
                    filename, anns, has_staged_annotations, edits)
            else:
                old_annotations, effective_anns, failure = _apply_legacy_doc(
                    filename, anns, has_staged_annotations, edits)
            if failure is not None:
                failures.append(f'{filename}: {failure}')
                continue

            ts = time.time()
            for element_id, annotation_text in effective_anns.items():
                old_text = old_annotations.get(element_id)
                action = (
                    'annotation_updated' if old_text is not None
                    else 'annotation_saved')
                _append_log(workspace, ANNOTATION_LOG_NAME, {
                    'ts': ts, 'file': filename, 'element_id': element_id,
                    'action': action, 'old': old_text, 'new': annotation_text,
                })
            for element_id, old_text in old_annotations.items():
                if element_id not in effective_anns:
                    _append_log(workspace, ANNOTATION_LOG_NAME, {
                        'ts': ts, 'file': filename, 'element_id': element_id,
                        'action': 'annotation_removed',
                        'old': old_text, 'new': None,
                    })
            for edit in edits:
                _append_log(workspace, EDIT_LOG_NAME, {
                    'ts': ts, 'file': filename,
                    'element_id': edit['element_id'],
                    'action': 'edit', 'kind': 'text',
                    'old': edit.get('old'), 'new': edit.get('text'),
                })
            modified.append(filename)
            annotations.pop(filename, None)
            app.config['ANNOTATION_ANCHORS'].pop(filename, None)
            pending_edits.pop(filename, None)

        if failures:
            return jsonify({
                'error': 'Failed to save: ' + '; '.join(failures),
                'files_modified': modified,
            }), 500
        # Fully successful Apply: wake every /api/wait waiter. Partial
        # failures above release nothing — the user fixes and Applies
        # again, and only then does the round count as submitted.
        # 0026: the empty-block interpretation is first-class state —
        # recorded per doc (untouched docs keep theirs; a nothing-staged
        # Apply approves everything) and mirrored into the waiter's
        # release payload.
        if not modified:
            interpretation = review_state.AGREED  # full agreement (0015)
        review_state.record(
            workspace, modified, interpretation,
            [f.name for f in _doc_files()])
        _append_log(workspace, ANNOTATION_LOG_NAME, {
            'ts': time.time(), 'action': 'apply',
            'empties': interpretation, 'files': list(modified),
        })
        with app.config['APPLY_EVENT']:
            app.config['APPLY_EPOCH'] += 1
            app.config['LAST_APPLY_FILES'] = list(modified)
            app.config['LAST_APPLY_EMPTIES'] = interpretation
            app.config['APPLY_EVENT'].notify_all()
        return jsonify({'status': 'ok', 'files_modified': modified})

    @app.route('/api/wait')
    def wait_for_apply():
        """Block until a save-all succeeds past the caller's epoch.

        The agent-side wait primitive (wait.py): launched right after
        the page is served, it sleeps here until the user confirms
        Apply changes in the browser. ``since`` is the caller's
        last-seen apply epoch (0 = wait for the first Apply ever);
        ``timeout`` bounds the block in seconds (default: forever).
        The response always carries the current epoch, so a
        ``timeout=0`` call doubles as an epoch probe. Never feeds the
        idle watchdog (see _update_activity).
        """
        try:
            since = int(request.args.get('since', 0))
        except ValueError:
            return jsonify({'error': 'since must be an integer'}), 400
        if since < 0:
            return jsonify({'error': 'since must be >= 0'}), 400
        raw_timeout = request.args.get('timeout')
        deadline: Optional[float] = None
        if raw_timeout is not None:
            try:
                seconds = float(raw_timeout)
            except ValueError:
                return jsonify({'error': 'timeout must be a number'}), 400
            if seconds < 0:
                return jsonify({'error': 'timeout must be >= 0'}), 400
            deadline = time.time() + seconds

        event = app.config['APPLY_EVENT']
        with event:
            while app.config['APPLY_EPOCH'] <= since:
                remaining = None if deadline is None else deadline - time.time()
                if remaining is not None and remaining <= 0:
                    break
                event.wait(timeout=remaining)
            epoch = app.config['APPLY_EPOCH']
            files = (app.config['LAST_APPLY_FILES']
                     if epoch > since else None)
        status = 'applied' if epoch > since else 'timeout'
        payload = {'status': status, 'epoch': epoch}
        if files is not None:
            # What the releasing Apply touched: [] = submitted with
            # nothing staged (full agreement), so wait.py can say so
            # instead of printing a bare empty digest.
            payload['files'] = files
            # 0026: what that Apply's untouched blocks mean —
            # 'undecided' or 'agreed' (None before any Apply).
            payload['empties'] = app.config['LAST_APPLY_EMPTIES']
        return jsonify(payload)

    @app.route('/assets/<path:filename>')
    def serve_asset(
        filename: str,
    ) -> Union[Response, tuple[Response, int]]:
        """Serve ../assets/* images referenced by docs (guarded)."""
        if not assets_dir.exists():
            return jsonify({'error': 'assets directory not found'}), 404
        target = (assets_dir / filename).resolve()
        try:
            target.relative_to(assets_dir.resolve())
        except ValueError:
            return jsonify({'error': 'invalid path'}), 400
        if not target.exists() or not target.is_file():
            return jsonify({'error': 'not found'}), 404
        return send_from_directory(str(assets_dir), filename)

    @app.route('/api/shutdown', methods=['POST'])
    def shutdown():
        data = request.get_json(silent=True) or {}
        reason = data.get('reason') or 'shutdown'

        def _stop():
            time.sleep(app.config['SHUTDOWN_DELAY'])
            logger.info('shutting down (%s)', reason)
            _exit_with_lock_release(0)
        threading.Thread(target=_stop, daemon=True).start()
        return jsonify({'status': 'ok'})

    return app


# ---------------------------------------------------------------------------
# Launch / daemon / reuse machinery (ported from ppt-master svg_editor)
# ---------------------------------------------------------------------------

def _lock_file(workspace: Path) -> Path:
    return workspace / LOCK_FILE_NAME


def _shutdown_existing(workspace: Path) -> int:
    """Stop the editor server for this workspace (idempotent)."""
    lock_file = _lock_file(workspace)
    existing = _read_lock(lock_file)
    if not existing:
        logger.info('no pinpoint server running — nothing to stop')
        return 0

    pid = _lock_pid(existing)
    try:
        port = int(existing.get('port', 0) or 0)
    except (TypeError, ValueError):
        port = 0
    if not _process_alive(pid):
        _clear_lock(lock_file)
        logger.info('server already stopped; cleared stale lock')
        return 0

    if port:
        try:
            req = urllib.request.Request(
                _server_url(port, '/api/shutdown'),
                data=b'{"reason": "cli-shutdown"}',
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            urllib.request.urlopen(req, timeout=3)
        except OSError:
            pass

    for _ in range(20):
        if not _process_alive(pid):
            break
        time.sleep(0.1)
    if _process_alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    _clear_lock(lock_file)
    logger.info('pinpoint server stopped (pid=%s)', pid)
    return 0


def _wait_for_ready(port: int, proc: subprocess.Popen, workspace: Path,
                    timeout: int = STARTUP_TIMEOUT) -> int:
    """Wait until this workspace's detached server responds.

    Returns the server pid recorded in the lock, or 0 on timeout. ``proc.pid``
    is not trusted for identity: on Windows a venv python.exe may be a
    launcher whose child is the real interpreter.
    """
    deadline = time.time() + timeout
    health_url = _server_url(port, '/api/health')
    last_error = ''
    while time.time() < deadline:
        if proc.poll() is not None:
            logger.error(
                'server exited during startup (code=%s)', proc.returncode)
            return 0
        try:
            with urllib.request.urlopen(health_url, timeout=1) as response:
                data = json.load(response)
                lock = _read_lock(_lock_file(workspace))
                server_pid = _lock_pid(lock)
                if (
                    response.status == 200
                    and isinstance(data, dict)
                    and data.get('service') == 'pinpoint'
                    and data.get('workspace') == str(workspace)
                    and lock is not None
                    and lock.get('port') == port
                    and data.get('pid') == server_pid
                ):
                    return server_pid
                last_error = (
                    'health response belongs to another service '
                    'or workspace')
        except (urllib.error.URLError, TimeoutError, OSError,
                ValueError) as exc:
            last_error = str(exc)
        time.sleep(0.25)
    note = f' (last error: {last_error})' if last_error else ''
    logger.error(
        'server did not become ready at %s within %ss%s',
        health_url, timeout, note,
    )
    return 0


def _open_browser(url: str) -> bool:
    return open_preview_browser(url, logger=logger)


def _reuse_running_server(existing: dict, *, open_browser: bool,
                          requested_port: Optional[int] = None) -> int:
    """Idempotent relaunch: point at the running server instead of failing."""
    pid = existing.get('pid', '?')
    try:
        port = int(existing.get('port', 0) or 0)
    except (TypeError, ValueError):
        port = 0
    if not port:
        logger.error(
            'pinpoint server already running (pid=%s) but its lock records no '
            'usable port; run --shutdown, then start again', pid,
        )
        return 1
    if requested_port is not None and port != requested_port:
        logger.error(
            'pinpoint server already running on port %s; explicit --port %s '
            'cannot reuse it. Run --shutdown, then start again',
            port, requested_port,
        )
        return 1
    url = _server_url(port)
    logger.info(
        'pinpoint server already running (pid=%s), reusing: %s', pid, url)
    if open_browser and not _open_browser(url):
        logger.info('browser did not auto-open; open %s manually', url)
    return 0


def _open_browser_async(url: str, delay: float = 0.4) -> None:
    def _open() -> None:
        time.sleep(delay)
        _open_browser(url)
    threading.Thread(target=_open, daemon=True).start()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='pinpoint annotation editor server',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('workspace', nargs='?', default='.pinpoint',
                        help='pinpoint workspace root (default: ./.pinpoint)')
    parser.add_argument(
        '--port', type=int, default=None,
        help='Exact port to listen on (default: first free '
             f'port from {DEFAULT_PORT})')
    parser.add_argument(
        '--no-browser', action='store_true',
        help='Do not auto-open browser')
    parser.add_argument(
        '--daemon', action='store_true',
        help='Start in the background and return once reachable')
    parser.add_argument(
        '--timeout', type=int, default=None,
        help='Idle timeout in seconds (default: 900; 0 = disabled)')
    parser.add_argument(
        '--shutdown', action='store_true',
        help='Stop the server running for this workspace, then exit')
    return parser


def main(argv: Optional[list] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format='[%(asctime)s] [%(levelname)s] pinpoint: %(message)s',
        datefmt='%H:%M:%S',
    )

    if args.port is not None:
        try:
            args.port = _validate_port(args.port)
        except ValueError as exc:
            logger.error('%s', exc)
            return 2

    workspace = Path(args.workspace).resolve()
    if args.shutdown:
        return _shutdown_existing(workspace)

    docs_dir = workspace / DOCS_DIR_NAME
    if not docs_dir.exists():
        ensure_workspace(workspace)
        docs_dir.mkdir(parents=True, exist_ok=True)

    lock_file = _lock_file(workspace)

    if args.daemon:
        existing = _read_lock(lock_file)
        if existing and _process_alive(_lock_pid(existing)):
            return _reuse_running_server(
                existing, open_browser=not args.no_browser,
                requested_port=args.port,
            )
        try:
            ensure_workspace(workspace)
        except OSError as exc:
            logger.error(
                'cannot create workspace directory: %s (%s)', workspace, exc)
            return 1
        log_path = workspace / SERVER_LOG_NAME
        try:
            port = (args.port if args.port is not None
                    else _find_free_port(DEFAULT_PORT))
        except RuntimeError as exc:
            logger.error('%s', exc)
            return 1
        idle_timeout = args.timeout if args.timeout is not None else 900
        cmd = [
            sys.executable, str(Path(__file__).resolve()), str(workspace),
            '--port', str(port), '--timeout', str(idle_timeout), '--no-browser',
        ]
        try:
            with log_path.open('a', encoding='utf-8') as log:
                proc = _popen_detached(
                    cmd, stdout=log, stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL, logger=logger,
                )
        except OSError as exc:
            logger.error('cannot write server log: %s (%s)', log_path, exc)
            return 1
        url = _server_url(port)
        server_pid = _wait_for_ready(port, proc, workspace)
        if not server_pid:
            if proc.poll() is None:
                proc.terminate()
            logger.error(
                'server failed to become reachable: %s (log: %s)',
                url, log_path)
            return 1
        logger.info(
            'started pinpoint in background: %s (pid=%s)', url, server_pid)
        logger.info('log: %s', log_path)
        if not args.no_browser and not _open_browser(url):
            logger.info('browser did not auto-open; open %s manually', url)
        return 0

    try:
        port = (args.port if args.port is not None
                else _find_free_port(DEFAULT_PORT))
    except RuntimeError as exc:
        logger.error('%s', exc)
        return 1

    try:
        ensure_workspace(workspace)
    except OSError as exc:
        logger.error(
            'cannot create workspace directory: %s (%s)', workspace, exc)
        return 1
    existing = _claim_lock(lock_file, port)
    if existing:
        return _reuse_running_server(
            existing, open_browser=not args.no_browser,
            requested_port=args.port,
        )
    atexit.register(_release_lock, lock_file)

    def _on_sigterm(signum: int, _frame) -> None:
        logger.info('received signal %s, exiting', signum)
        sys.exit(0)
    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, OSError):
        pass

    idle_timeout = args.timeout if args.timeout is not None else 900

    app = create_app(
        str(workspace), idle_timeout=idle_timeout, lock_file=lock_file)

    url = _server_url(port)
    if not args.no_browser:
        _open_browser_async(url)

    logger.info('running at %s', url)
    logger.info('workspace: %s', workspace)
    logger.info('docs: %s', docs_dir)
    logger.info('idle timeout: %ds (0 = disabled)', idle_timeout)
    # threaded must be explicit: /api/wait holds a connection open, and
    # a single-threaded server would freeze heartbeats and Apply behind
    # a blocked waiter.
    app.run(host=PUBLIC_HOST, port=port, debug=False, threaded=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
