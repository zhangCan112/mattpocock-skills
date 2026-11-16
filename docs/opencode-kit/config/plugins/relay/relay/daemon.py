#!/usr/bin/env python3
"""relay - a singleton MCP daemon giving every agent in the project a
channel to the human user.

L1 scope (see .pinpoint/docs/mcp-ambition.md):
  * Streamable HTTP MCP endpoint at POST /mcp exposing one tool,
    ``ask_user``: a batched list of questions; the call blocks until the
    user answers in the web panel.
  * Panel at GET /: one card per session - every open ticket of that
    session merged, whole-card fold, per-ticket "you decide" decline,
    and one card-level Apply that settles the batch. Cards grouped by
    root session, titled via the local OpenCode service HTTP API - no
    agent turns spent (issue 0020). Contexts render as numbered lines;
    clicking a line drops an @L<n>: annotation into that question's
    answer.
  * Workspace (0030): one global daemon serves every checkout. State
    lives in a single workspace dir - lock.json (pid/port/token),
    asks.jsonl (audit), pending.json (open tickets - re-opened as
    "restored" after a restart, issue 0019), server.log. The plugin
    spawns it with ``--workspace ~/.relay``; a bare CLI run still
    defaults to ``<cwd>/.relay`` (tests, dev).
  * Project provenance (0030): each project's plugin instance stamps
    its checkout into the MCP registration headers
    (``X-Relay-Project``); tickets, audit rows and the panel carry it
    (project chip on session cards), and file-viewer links anchor
    relative paths at the requesting ticket's checkout so one daemon
    can serve them all.
  * Restart recovery (issue 0019): the instructions tell agents to
    retry ask_user on transport errors; open tickets survive a
    restart (panel-badged 重启前, manually settleable, audit event
    "restored", never auto-timed-out); shutdown drains live tickets
    first - bounded by DRAIN_MAX_SEC, --force skips the drain.
  * Token auth: MCP calls and panel APIs must carry the lock-file token.

Design rules (doc 3.4/3.5): batching is the caller's discipline; the
tool definition, the server instructions, and the return value stay
small - every agent pays for them on every call.

Stdlib only. Platform helpers live in relay's own vendored
server_common (0029): relay has no import relationship with the
pinpoint skill and ships on its own.
Usage:
    python relay/daemon.py [--port 8791] [--daemon] [--shutdown [--force]]
"""
import argparse
import base64
import html
import http.client
import json
import logging
import os
import re
import secrets
import select
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional, Union
from urllib.parse import unquote

try:  # package import (relay.daemon, used by the tests)
    from .server_common import (
        LISTEN_REUSE_ADDRESS, claim_lock, find_free_port,
        open_preview_browser, popen_detached, process_alive, read_lock,
        release_lock,
    )
except ImportError:  # script execution (python relay/daemon.py)
    from server_common import (
        LISTEN_REUSE_ADDRESS, claim_lock, find_free_port,
        open_preview_browser, popen_detached, process_alive, read_lock,
        release_lock,
    )

PREFERRED_PORT = 8791
WORKSPACE_NAME = '.relay'
TICKET_TIMEOUT_SWEEP = 30  # seconds between sweeps marking timed-out tickets
# Shutdown drain bound (0019): bounded so zombie tickets (no timeout,
# dead caller) can never block a redeploy; --force skips the drain.
DRAIN_MAX_SEC = 10.0
# User-response floor (0034 A, user verdict 2026-11-13): an
# agent-supplied timeout_sec is raised to this - a caller in a hurry
# must not cut the user off mid-read (a 300-900s ask timed out while
# the user was still reading; the agent then ran on unchecked). None
# (no timeout) stays None: even more patient than the floor.
MIN_TIMEOUT_SEC = 7200
PANEL_VERSION = '29'      # bump when PANEL_HTML changes; open tabs self-reload
# Post-claim port retries (0022): the scan is exact and the bind refuses
# double-binds, so more than one yield is already exotic — but never loop
# forever hunting a port.
PORT_BIND_ATTEMPTS = 3

# Session metadata lookup (issue 0020): the panel shows OpenCode session
# titles / parent groups / first messages. Source of truth is the local
# OpenCode service HTTP API, never a guess.
META_TTL = 30             # seconds a fetched session entry stays fresh
META_WALK_CAP = 4         # parent-chain hops when resolving the root session
META_TIMEOUT = 2          # per-request HTTP timeout; the panel must not hang
META_COOLDOWN = 30        # skip lookups for this long after the service 401s/dies

# Read-only file viewer (issue 0020, user request 2026-11-03): contexts
# carry file paths; the panel linkifies them to /file?path=...
FILE_CAP = 512 * 1024    # refuse files larger than this

# Duplicate-tab guard: --open skips the browser launch when a panel tab
# polled recently (timestamp persists across daemon restarts, so a
# redeploy's parent process still sees the tab that polled the OLD
# daemon). Background tabs can be timer-throttled to ~1/min; foreground
# testing polls every 2s, well inside the window.
PANEL_ALIVE_SEC = 15
PANEL_POLL_WRITE_INTERVAL = 5   # throttle for the timestamp file
RESOLVED_HISTORY_MAX = 20   # panel Q&A history cap (0023 slice 5; 0034 C)

# Lines (0036 effort; DESIGN.md §24): inter-primary messaging.
LINE_NAME_RE = re.compile(r'^[a-z0-9_-]{1,32}$')  # line & group slugs
LINE_LOG_CAP = 50          # messages kept per line (panel shows tail)
LINE_HISTORY_MAX = 20      # closed-line traces kept for the panel
LINE_DROPS_MAX = 20        # undeliverable bounces kept (panel 留痕)
PUSH_TIMEOUT = 5           # synthetic POST timeout (spike: 2.3s wake)
PUSH_RETRY_DELAY = 0.3     # port-drift retry pause; re-reads the file
LINE_DENY_RETRY = (
    'cannot verify this session as a primary (opencode service '
    'unreachable or session unknown); probe it, then retry')

LOG = logging.getLogger('relay')

INSTRUCTIONS = (
    'Channel to the human user. A decision only the user can make: '
    'batch ALL questions of this round into ONE ask_user call; it '
    'blocks until answered. Never use it for anything you can '
    'resolve yourself. A transport error (e.g. ECONNRESET) is not '
    'a business failure - the relay daemon was likely restarted: '
    'probe it, then resend the same ask_user. '
    'Channel to peer agents: open_line makes you reachable by name; '
    'send(to, text) addresses a peer. Replies are pushed to you and '
    'wake you - end your turn to wait, never poll. Close your lines '
    '(close_line, close_group) when the topic is done.'
)

ASK_USER_TOOL = {
    'name': 'ask_user',
    'description': (
        'Ask the human user a batch of questions; blocks until they are '
        'answered in the relay panel. Batch every question of this round '
        'into one call.'
    ),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'questions': {
                'type': 'array',
                'minItems': 1,
                'items': {
                    'type': 'object',
                    'properties': {
                        'text': {
                            'type': 'string',
                            'description': 'one short question',
                        },
                        'context': {
                            'type': 'string',
                            'description': 'optional long context '
                            '(code/log), shown collapsed',
                        },
                        'options': {
                            'type': 'array',
                            'items': {'type': 'string'},
                            'description': 'optional candidate answers',
                        },
                    },
                    'required': ['text'],
                },
            },
            'timeout_sec': {
                'type': 'integer',
                'minimum': 1,
                'description': 'give up waiting after this many '
                    'seconds; anything below 7200 is raised to 7200 '
                    '- the user keeps at least 2h to answer',
            },
        },
        'required': ['questions'],
    },
}

OPEN_LINE_TOOL = {
    'name': 'open_line',
    'description': (
        'Register this session under a unique name so peers can '
        'reach you; returns the directory.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'name': {
                'type': 'string',
                'description': 'unique slug [a-z0-9-_]{1,32}',
            },
            'description': {
                'type': 'string',
                'description': 'one line: what this session does',
            },
            'group': {
                'type': 'string',
                'description': 'optional topic slug; first opener '
                               'founds the group',
            },
        },
        'required': ['name'],
    },
}

SEND_TOOL = {
    'name': 'send',
    'description': (
        'Send a message to a line by name; pushed into its '
        'transcript, waking it.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'to': {
                'type': 'string',
                'description': 'line name from the directory',
            },
            'text': {
                'type': 'string',
                'description': 'message body',
            },
        },
        'required': ['to', 'text'],
    },
}

CLOSE_LINE_TOOL = {
    'name': 'close_line',
    'description': (
        'Close your own line; in-flight messages bounce back to '
        'their senders.'),
    'inputSchema': {'type': 'object', 'properties': {}},
}

CLOSE_GROUP_TOOL = {
    'name': 'close_group',
    'description': (
        'Close every line in a group (founder only); in-flight '
        'messages bounce.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'group': {
                'type': 'string',
                'description': 'group slug you founded',
            },
        },
        'required': ['group'],
    },
}

LIST_LINES_TOOL = {
    'name': 'list_lines',
    'description': 'List open lines: name, description, project, '
                   'freshness.',
    'inputSchema': {'type': 'object', 'properties': {}},
}

TOOLS = [ASK_USER_TOOL, OPEN_LINE_TOOL, SEND_TOOL, CLOSE_LINE_TOOL,
         CLOSE_GROUP_TOOL, LIST_LINES_TOOL]


# ---------------------------------------------------------------- state

class RelayState:
    """Tickets + audit. Guarded by one lock; each ticket owns an Event."""

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.lock = threading.Lock()
        self.tickets = {}  # id -> dict(ticket)
        self.audit_path = workspace / 'asks.jsonl'
        self.pending_path = workspace / 'pending.json'

    def ask(self, session, questions, timeout_sec, project=None):
        ticket = {
            'id': uuid.uuid4().hex[:8],
            'session': session,
            'questions': questions,
            'timeout_sec': timeout_sec,
            'created': time.time(),
            'status': 'open',  # open | answered | declined | timeout
            'answers': None,
            'note': '',
        }
        if project:
            # 0030: which checkout this ticket came from (the MCP
            # registration's X-Relay-Project header). Absent stays
            # absent - old records keep their shape.
            ticket['project'] = project
        ticket['event'] = threading.Event()
        with self.lock:
            self.tickets[ticket['id']] = ticket
        self._audit('ask', ticket)
        self._persist_open()
        return ticket

    def resolved_history(self):
        """Settled tickets for the panel's Q&A history (0023 user
        follow-up: the user stays in the loop on traffic they did not
        take part in). 0034 C: ask tickets that vanished without a
        user answer - timeout (the agent fell back on its own) or
        abandoned (the caller's tool call was killed) - are included,
        so a card that disappears mid-read always leaves a trace.
        Answered/declined asks are not: the user settled those and
        knows. In-memory, newest first, capped; the audit log keeps
        everything. 0035: escalation rows died with the tool - asks
        are the only tickets left."""
        with self.lock:
            pairs = []
            for t in self.tickets.values():
                if t['status'] not in ('timeout', 'abandoned'):
                    continue
                row = {
                    'id': t['id'],
                    'session': t['session'],
                    'status': t['status'],
                    'project': t.get('project'),  # 0030 anchor source
                    'text': '\n'.join(
                        '%d. %s' % (i + 1, q.get('text', ''))
                        for i, q in enumerate(t['questions'] or [])),
                }
                pairs.append((t.get('settled_at', t['created']), row))
        pairs.sort(key=lambda pair: pair[0], reverse=True)
        return [row for _, row in pairs[:RESOLVED_HISTORY_MAX]]

    def settle(self, ticket_id, status, answers=None, note='',
               declined=None):
        with self.lock:
            ticket = self.tickets.get(ticket_id)
            if not ticket or ticket['status'] != 'open':
                return False
            ticket['status'] = status
            ticket['answers'] = answers
            ticket['note'] = note
            if declined:
                # 0024: per-question cede markers for answer_text;
                # stored only when non-empty so settled shapes stay
                # compatible.
                ticket['declined'] = declined
            ticket['settled_at'] = time.time()  # history ordering (0034 C)
            event = ticket['event']
        self._audit(status, ticket)
        event.set()
        self._persist_open()
        return True

    def apply_settlements(self, settlements):
        """One card-level Apply: settle a batch of tickets in order.
        Each entry is {'ticket', 'action': 'answer'|'decline',
        'answers', 'note'} plus (0024) 'declined': question indices
        the user cedes to the agent on a mixed answer. Returns
        {ticket_id: settled?} so races (a ticket timed out between
        panel render and click) surface instead of silently
        half-applying."""
        results = {}
        for entry in settlements or []:
            tid = entry.get('ticket', '')
            with self.lock:
                ticket = self.tickets.get(tid)
                nq = len(ticket['questions']) if ticket else 0
            if entry.get('action') == 'decline':
                results[tid] = self.settle(
                    tid, 'declined', note=entry.get('note', ''))
                continue
            # 0024: keep answers positionally aligned; remember the
            # ceded indices (junk and out-of-range dropped) so
            # answer_text can mark them instead of trusting the
            # (possibly stale) empty answer texts.
            declined = [
                i for i in (entry.get('declined') or [])
                if isinstance(i, int) and not isinstance(i, bool)
                and 0 <= i < nq]
            results[tid] = self.settle(
                tid, 'answered',
                answers=entry.get('answers') or [],
                note=entry.get('note', ''), declined=declined)
        return results

    def sweep_timeouts(self):
        now = time.time()
        with self.lock:
            due = [
                t for t in self.tickets.values()
                if t['status'] == 'open' and t['timeout_sec']
                and not t.get('restored')
                and now - t['created'] >= t['timeout_sec']
            ]
        for ticket in due:
            self.settle(ticket['id'], 'timeout')

    def open_tickets(self):
        now = time.time()
        with self.lock:
            return [
                {
                    'id': t['id'],
                    'session': t['session'],
                    'age': int(now - t['created']),
                    'questions': t['questions'],
                    'restored': bool(t.get('restored')),
                    'project': t.get('project'),  # 0030 chip source
                }
                for t in self.tickets.values() if t['status'] == 'open'
            ]

    def _persist_open(self):
        """Snapshot open tickets to pending.json (0019 cut B): a
        restart must not erase in-flight work. Best effort - serving
        continues if the write fails; restore_pending is the startup
        path's job."""
        with self.lock:
            records = []
            for t in self.tickets.values():
                if t['status'] != 'open':
                    continue
                rec = {
                    'id': t['id'],
                    'session': t['session'],
                    'questions': t['questions'],
                    'timeout_sec': t['timeout_sec'],
                    'created': t['created'],
                    'restored': bool(t.get('restored')),
                }
                if t.get('project'):
                    rec['project'] = t['project']  # 0030 provenance
                records.append(rec)
        try:
            tmp = self.pending_path.with_suffix('.json.tmp')
            tmp.write_text(
                json.dumps(records, ensure_ascii=False) + '\n',
                encoding='utf-8')
            os.replace(tmp, self.pending_path)
        except OSError:
            LOG.warning('pending write failed', exc_info=True)

    def restore_pending(self):
        """Re-open tickets persisted by a previous run (0019 cut B).
        Restored tickets carry ``restored`` so the panel can badge
        them and the sweeper leaves them alone: no waiter exists
        anymore, so visibility beats timeout semantics. Returns the
        restored tickets."""
        try:
            raw = self.pending_path.read_text(encoding='utf-8')
        except OSError:
            return []
        try:
            records = json.loads(raw or '[]')
            if not isinstance(records, list):
                raise ValueError('pending.json: expected a list')
        except ValueError:
            LOG.warning('pending.json unreadable; skipping restore',
                        exc_info=True)
            return []
        restored = []
        with self.lock:
            for rec in records:
                if not isinstance(rec, dict) or not rec.get('id'):
                    continue
                if rec.get('kind', 'ask') != 'ask':
                    # 0035: escalation tickets died with the tool; a
                    # pre-0035 pending.json may still carry them.
                    # Nothing can settle them anymore, so they stay
                    # dropped (asks.jsonl keeps the history).
                    continue
                if rec['id'] in self.tickets:
                    continue
                ticket = {
                    'id': rec['id'],
                    'session': rec.get('session', 'unknown'),
                    'questions': rec.get('questions') or [],
                    'timeout_sec': rec.get('timeout_sec'),
                    'created': rec.get('created', time.time()),
                    'status': 'open',
                    'answers': None,
                    'note': '',
                    'restored': True,
                }
                if rec.get('project'):
                    ticket['project'] = rec['project']
                ticket['event'] = threading.Event()
                self.tickets[ticket['id']] = ticket
                restored.append(ticket)
        for ticket in restored:
            self._audit('restored', ticket)
        return restored

    def _audit(self, event, ticket):
        record = {
            'ts': time.time(),
            'event': event,
            'ticket': ticket['id'],
            'session': ticket['session'],
        }
        if ticket.get('project'):
            record['project'] = ticket['project']  # 0030 provenance
        if event in ('ask', 'restored'):
            record['questions'] = ticket['questions']
        else:
            record['answers'] = ticket['answers']
            record['note'] = ticket['note']
            if ticket.get('declined'):
                # 0024: ceded indices ride the audit too - the log
                # keeps everything; only non-empty (old records stay
                # shape-stable).
                record['declined'] = ticket['declined']
        self.append_audit(record)

    def append_audit(self, record):
        """Raw single-stream append: line events share asks.jsonl
        (0030 never split; 0040 event family). Best effort - serving
        continues if the write fails."""
        try:
            with self.audit_path.open('a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        except OSError:
            LOG.warning('audit write failed', exc_info=True)


def _wait_for_ticket(ticket, client_gone):
    """Block until the ticket settles, its timeout fires, or the MCP
    client vanishes (the agent's tool call was killed). Killed calls
    must settle as 'abandoned' immediately - a ghost card would haunt
    the panel for the full timeout otherwise (seen live when the user
    force-stopped an ask_user during 0020 v6 acceptance)."""
    timeout = ticket['timeout_sec'] or None
    deadline = None if timeout is None else time.time() + timeout
    while not ticket['event'].wait(timeout=0.25):
        if deadline is not None and time.time() >= deadline:
            return 'timeout'
        if client_gone():
            return 'abandoned'
    return 'settled'


def _drain_open_tickets(state, limit):
    """Wait (bounded) for live open tickets to settle at shutdown
    (0019 cut C). Restored tickets never count: nobody waits for
    them and pending.json carries them across. Returns True when no
    live ticket is left, False when the limit ran out."""
    deadline = time.time() + limit
    while True:
        with state.lock:
            live = any(t['status'] == 'open' and not t.get('restored')
                       for t in state.tickets.values())
        if not live or time.time() >= deadline:
            return not live
        time.sleep(0.25)


def answer_text(ticket):
    """Compact per context-tax: answers only, no echo of questions."""
    if ticket['status'] == 'answered':
        ceded = set(ticket.get('declined') or [])
        lines = [
            '%d. %s' % (i + 1,
                        '(yours to decide)' if i in ceded else a)
            for i, a in enumerate(ticket['answers'] or [])
        ]
        text = '\n'.join(lines) or '(no answers)'
        if ticket['note']:
            text += '\nnote: ' + ticket['note']
        if ceded:
            text += ('\nQuestions marked yours to decide: proceed '
                     'with your best judgment and say so in your '
                     'report.')
        return text
    if ticket['status'] == 'declined':
        text = ('The user replied: these questions are yours to decide; '
                'proceed with your best judgment and say so in your report.')
        if ticket['note']:
            text += '\nnote: ' + ticket['note']
        return text
    return ('The user did not answer within timeout_sec (user '
            'unavailable). Fall back to your safe default and record it; '
            'do not retry the same question verbatim.')


def normalize_timeout(value, tool):
    """Validate + clamp an agent-supplied timeout_sec (0034 A, pure,
    unit tested). None stays None (no timeout - even more patient
    than the floor); an integer >= 1 is raised to MIN_TIMEOUT_SEC: a
    caller in a hurry must not cut the user off mid-read. Returns
    (clamped, None) or (None, error_message)."""
    if value is None:
        return None, None
    if (not isinstance(value, int) or isinstance(value, bool)
            or value < 1):
        return None, '%s: timeout_sec must be an integer >= 1' % tool
    return max(value, MIN_TIMEOUT_SEC), None


# ------------------------------------------------------ session metadata

def _service_state_file() -> Path:
    """Registration file of the local OpenCode service (client docs:
    Service.discover reads exactly this file)."""
    xdg = os.environ.get('XDG_STATE_HOME')
    base = Path(xdg) if xdg else Path.home() / '.local' / 'state'
    return base / 'opencode' / 'service.json'


class ServiceUnavailable(Exception):
    """The local OpenCode service could not be reached or refused auth."""


def _service_get(path: str):
    """GET <service>/path with the registration's Basic auth
    (username ``opencode``, see packages/client service-probe.ts).
    Returns the response's ``data`` envelope. Raises ServiceUnavailable."""
    try:
        reg = json.loads(_service_state_file().read_text(encoding='utf-8'))
        auth = base64.b64encode(
            ('opencode:' + reg['password']).encode()).decode()
        req = urllib.request.Request(
            reg['url'] + path, headers={'Authorization': 'Basic ' + auth})
        with urllib.request.urlopen(req, timeout=META_TIMEOUT) as resp:
            return json.load(resp).get('data')
    except Exception as exc:  # any failure means "no metadata"
        raise ServiceUnavailable(str(exc)) from exc


class SessionGone(Exception):
    """The service answered 404/409: the target session is dead."""


def _service_post(path: str, payload) -> None:
    """POST <service>/path (Basic auth, JSON body) - the synthetic
    push transport (0038). Raises ServiceUnavailable on transport
    failure or SessionGone on 404/409 (dead target session)."""
    try:
        reg = json.loads(_service_state_file().read_text(encoding='utf-8'))
        auth = base64.b64encode(
            ('opencode:' + reg['password']).encode()).decode()
        req = urllib.request.Request(
            reg['url'] + path, method='POST',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Authorization': 'Basic ' + auth,
                     'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=PUSH_TIMEOUT):
                return
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 409):
                raise SessionGone(str(exc))
            raise
    except SessionGone:
        raise
    except Exception as exc:
        raise ServiceUnavailable(str(exc)) from exc


def push_synthetic(session_id: str, text: str) -> str:
    """Queue one synthetic turn. delivery=queue always - the endpoint
    defaults to steer, which never reaches the model (§21). One
    retry with a fresh service.json read covers the drifting service
    port (0038). Returns 'pushed' | 'dead' | 'failed'."""
    body = {'text': text, 'delivery': 'queue'}
    for attempt in (1, 2):
        try:
            _service_post('/api/session/%s/synthetic' % session_id, body)
            return 'pushed'
        except SessionGone:
            return 'dead'
        except ServiceUnavailable:
            if attempt == 2:
                return 'failed'
            time.sleep(PUSH_RETRY_DELAY)
    return 'failed'


def push_text(messages) -> str:
    """The synthetic envelope (0038): one line per message,
    ``[relay] from <line> (<kind>): <text>``; a batch rides one
    synthetic turn as many lines. A lineless sender falls back to
    its session tail."""
    out = []
    for m in messages:
        who = m['from'] or ('session ' + m['from_session'][-8:])
        out.append('[relay] from %s (%s): %s'
                   % (who, m['kind'], m['text']))
    return '\n'.join(out)


class SessionMeta:
    """sessionID -> OpenCode session metadata, for the panel cards.

    Read path (``snapshot``) is instant and never blocks; fetches run on
    a throwaway thread (``refresh_async``) so /api/state stays snappy.
    Every failure degrades to "no metadata": the panel falls back to the
    sessionID tail. First messages are fetched once (immutable); titles
    refresh every META_TTL seconds (sessions get renamed/titled lazily).
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._cache = {}       # sid -> entry dict
        self._roots = {}       # sid -> root sid (parent chain resolved)
        self._refreshing = False
        self._cooldown_until = 0.0

    # ---------------------------------------------------------- reads

    def snapshot(self, session_ids) -> dict:
        """sid -> plain entry copy (plus resolved root) for panel use."""
        with self._lock:
            roots = {sid: self._roots.get(sid) for sid in session_ids}
            return {
                sid: dict(self._cache[sid], root=roots.get(sid))
                for sid in session_ids if sid in self._cache
            }

    # -------------------------------------------------------- refresh

    def refresh_async(self, session_ids) -> None:
        """Kick one background fetch for stale/missing sessions."""
        now = time.time()
        with self._lock:
            if self._refreshing or now < self._cooldown_until:
                return
            stale = [
                sid for sid in session_ids
                if sid not in self._cache
                or now - self._cache[sid]['ts'] >= META_TTL
            ]
            # Parents seen only as parentID (never ticket sessions) fill
            # in on later cycles; see _refresh's expansion loop.
            for sid in list(self._cache):
                entry = self._cache[sid]
                if (entry['parentID'] and entry['parentID'] not in
                        self._cache and entry['parentID'] not in stale):
                    stale.append(entry['parentID'])
            if not stale:
                return
            self._refreshing = True
        threading.Thread(
            target=self._refresh, args=(set(stale),), daemon=True).start()

    def _refresh(self, session_ids) -> None:
        try:
            ids = set(session_ids)
            for _ in range(META_WALK_CAP):  # walk parent chains upward
                for sid in sorted(ids):
                    self._fetch_entry(sid)
                with self._lock:  # any cached session with an uncached parent?
                    ids = {
                        e['parentID'] for e in self._cache.values()
                        if e['parentID'] and e['parentID'] not in self._cache
                    }
                    if not ids:
                        break
            self._resolve_roots()
        except ServiceUnavailable:
            with self._lock:
                self._cooldown_until = time.time() + META_COOLDOWN
        finally:
            with self._lock:
                self._refreshing = False

    def _fetch_entry(self, sid: str) -> None:
        """Fetch one session (plus its parent title / first user message)
        and cache it. Non-'ses_' ids never hit the API."""
        with self._lock:
            old = self._cache.get(sid, {})
        if not sid.startswith('ses_'):
            with self._lock:
                self._cache[sid] = {
                    'title': '', 'agent': '', 'parentID': None,
                    'parent_title': '', 'first_msg': None,
                    'directory': '', 'time': {}, 'ts': time.time(),
                }
            return
        info = _service_get('/api/session/' + sid) or {}
        entry = {
            'title': info.get('title') or '',
            'agent': info.get('agent') or '',
            'parentID': info.get('parentID'),
            'parent_title': '',
            'first_msg': old.get('first_msg'),  # immutable once fetched
            # 0030: the session's checkout (location.directory) - the
            # machine-singleton service answers every project, so this
            # is the panel's fallback project label for tickets that
            # arrived without an X-Relay-Project header.
            'directory': ((info.get('location') or {}).get(
                'directory')) or '',
            # 0040 death stance (a): freshness = last attended, from
            # Session.Info.time (viewed/busy, epoch ms). Honesty over
            # TTL - the panel shows the age, never auto-closes.
            'time': info.get('time') or {},
            'ts': time.time(),
        }
        if entry['parentID']:
            parent = _service_get('/api/session/' + entry['parentID']) or {}
            entry['parent_title'] = parent.get('title') or ''
        if entry['first_msg'] is None:
            msgs = _service_get(
                '/api/session/%s/message?order=asc&limit=1&type=user' % sid)
            entry['first_msg'] = (
                (msgs or [{}])[0].get('text') or '') if msgs else ''
        with self._lock:
            self._cache[sid] = entry

    def _resolve_roots(self) -> None:
        """Map every cached session to its root (top-most ancestor)."""
        with self._lock:
            for sid in self._cache:
                root, hops = sid, 0
                while hops < META_WALK_CAP:
                    entry = self._cache.get(root)
                    if not entry or not entry['parentID']:
                        break
                    root = entry['parentID']
                    hops += 1
                self._roots[sid] = root


def enrich_tickets(tickets, snap):
    """Order tickets by session group and attach panel metadata.

    Pure function (unit-tested): groups appear in first-ticket order,
    tickets keep creation order inside their group. Each row gains
    ``group`` (root session id), ``group_title`` and ``meta`` (may be
    None - the panel then falls back to the sessionID tail).
    """
    groups = {}  # root sid -> [rows], insertion ordered
    for t in tickets:
        meta = snap.get(t['session'])
        root = (meta or {}).get('root') or t['session']
        row = dict(t)
        row['group'] = root
        row['group_title'] = (
            (snap.get(root) or {}).get('title')
            or (meta or {}).get('parent_title') or '')
        row['meta'] = meta
        groups.setdefault(root, []).append(row)
    return [row for rows in groups.values() for row in rows]


def merge_session_cards(rows):
    """One panel card per session: that session's open tickets merged
    (issue 0020 原有范围, 多问合一卡).

    Pure function (unit-tested). Tickets keep creation order inside
    the card; the card's ``age`` is its oldest ticket's (triage shows
    who has waited longest); ``count`` is the merged question total.
    ``group`` / ``group_title`` / ``meta`` come from the first row.
    ``project`` (0030): first truthy among the session's rows (a
    session never spans checkouts), else the service metadata's
    ``directory`` - the panel chips it so a global daemon's inbox
    stays legible across projects.
    """
    cards = {}
    for row in rows:
        card = cards.setdefault(row['session'], {
            'session': row['session'],
            'group': row['group'],
            'group_title': row['group_title'],
            'meta': row['meta'],
            'project': row.get('project'),
            'tickets': [],
            'ages': [],
        })
        if not card['project'] and row.get('project'):
            card['project'] = row['project']
        card['tickets'].append(
            {'id': row['id'], 'questions': row['questions'],
             'restored': row.get('restored', False)})
        card['ages'].append(row['age'])
    out = []
    for card in cards.values():
        card['age'] = max(card.pop('ages'))
        card['count'] = sum(len(t['questions']) for t in card['tickets'])
        if not card['project'] and card['meta'] and card['meta'].get(
                'directory'):
            card['project'] = card['meta']['directory']
        out.append(card)
    return out


def enrich_resolved(rows, snap):
    """Attach each Q&A-history row its session title (0025).

    Pure function (unit-tested): row order and shape are preserved,
    every row gains ``title`` - '' when metadata is unavailable, the
    panel then shows the sessionID tail alone. Unlike
    ``enrich_tickets`` this adds no grouping; resolved rows render
    flat in the history fold."""
    out = []
    for r in rows:
        row = dict(r)
        row['title'] = (snap.get(r['session']) or {}).get('title') or ''
        out.append(row)
    return out


# ------------------------------------------------------------- lines

class LineState:
    """Open lines, their traffic, and group lifecycle (DESIGN.md §24).

    One lock; pushes run OUTSIDE it (HTTP), the lock re-taken to
    record outcomes. lines.json mirrors pending.json conventions
    (0019): registration + undelivered box survive a restart; pushed
    messages ride their state and never re-send (0040 three no-loss).
    """

    def __init__(self, workspace: Path, relay_state: 'RelayState'):
        self.lock = threading.Lock()
        self.lines = {}     # name -> entry
        self.groups = {}    # group -> {'founder': sid, 'founded_at'}
        self.history = []   # closed-line traces (panel 留痕, capped)
        self.drops = []     # bounces with no sender line (§24.3 face)
        self.lines_path = workspace / 'lines.json'
        self._audit = relay_state.append_audit

    # ----------------------------------------------------- helpers

    def _event(self, event, **fields):
        record = {'ts': time.time(), 'event': event}
        record.update(fields)
        self._audit(record)

    def _event_lines(self, event, lines, **fields):
        for name in lines:
            self._event(event, line=name, **fields)

    def _owned_name(self, session):
        for name, entry in self.lines.items():
            if entry['owner'] == session:
                return name
        return None

    @staticmethod
    def _trim(entry):
        if len(entry['log']) > LINE_LOG_CAP:
            del entry['log'][:len(entry['log']) - LINE_LOG_CAP]

    # ------------------------------------------------------- open

    def open_line(self, session, project, name, description, group):
        """(line_name, None) or (None, error_text). A taken name is
        refused naming its occupier (0039); same-session re-open
        idempotently updates the description. A line may join a
        group at open time or later (re-open), but never switch:
        founder bookkeeping would silently re-parent (0040)."""
        with self.lock:
            held = self.lines.get(name)
            if held and held['owner'] != session:
                return None, ("open_line: name '%s' is taken by "
                              'session %s (%s)'
                              % (name, held['owner'][-8:],
                                 held['description'] or 'no description'))
            if held and group and held['group'] \
                    and held['group'] != group:
                return None, ("open_line: line is in group '%s'; "
                              'close_line and reopen to switch'
                              % held['group'])
            update = held is not None
            if group and group not in self.groups:
                self.groups[group] = {'founder': session,
                                      'founded_at': time.time()}
            if update:
                if description:
                    held['description'] = description
                if group and not held['group']:
                    held['group'] = group  # late join, still no switch
            else:
                self.lines[name] = {
                    'name': name, 'description': description or '',
                    'group': group or None, 'owner': session,
                    'project': project or '',
                    'opened_at': time.time(), 'log': [], 'box': [],
                }
            owner_group = group or (held['group'] if held else None)
            self._persist_locked()
        self._event('line.open', line=name, group=owner_group or '',
                    session=session, project=project or '',
                    update=update)
        return name, None

    # ------------------------------------------------------- send

    def send(self, sender_session, sender_project, to, text):
        """Deliver to an open line (inline push); a missing/closed
        target bounces back to the sender's line (0040). Returns
        caller-facing text - never a silent drop."""
        with self.lock:
            target = self.lines.get(to)
            msg = {
                'id': uuid.uuid4().hex[:8], 'kind': 'msg',
                'from': self._owned_name(sender_session),
                'from_session': sender_session, 'to': to,
                'text': text, 'sent_at': time.time(),
                'state': 'pending',
                'project': sender_project or '',
            }
            if target is not None:
                target['log'].append(msg)
                target['box'].append(msg)
                self._trim(target)
                self._persist_locked()
        self._event('message.sent', line=to, from_line=msg['from'] or '',
                    to=to, session=sender_session,
                    project=sender_project or '')
        if target is not None:
            outcome = self._push_line(to)
            if outcome == 'pushed':
                return 'sent: delivered to %s' % to
            if outcome == 'dead':
                return ('bounced: %s is gone (session deleted); your '
                        'message was returned' % to)
            return ('queued: %s is unreachable right now; the message '
                    'stays in flight (auto-retried, never dropped)' % to)
        return self._bounce(msg, sender_session, sender_project,
                            'line %s closed or unknown' % to)

    def _push_line(self, name):
        """Push one line's pending box as a single synthetic turn
        (multi-line batch, 0038). 'dead' closes the line (404 is the
        death signal, 0038 failure face) which bounces the batch."""
        with self.lock:
            entry = self.lines.get(name)
            if entry is None or not entry['box']:
                return 'idle'
            batch = list(entry['box'])
            owner = entry['owner']
        outcome = push_synthetic(owner, push_text(batch))
        with self.lock:
            entry = self.lines.get(name)  # may have closed meanwhile
            if entry is None:
                return outcome
            if outcome == 'pushed':
                ids = {m['id'] for m in batch}
                entry['box'] = [m for m in entry['box']
                                if m['id'] not in ids]
                stamp = time.time()
                for m in entry['log']:
                    if m['id'] in ids:
                        m['state'] = 'pushed'
                        m['pushed_at'] = stamp
                self._persist_locked()
        if outcome == 'pushed':
            for m in batch:
                self._event('message.pushed', line=name,
                            from_line=m['from'] or '', to=name,
                            session=m['from_session'],
                            project=m.get('project', ''))
            return 'pushed'
        if outcome == 'dead':
            self.close_line(name, actor='system',
                            reason='push 404: session gone')
            return 'dead'
        for m in batch:
            self._event('message.push-failed', line=name,
                        session=m['from_session'],
                        project=m.get('project', ''),
                        reason='service unreachable; stays in box')
        return 'failed'

    def _bounce(self, msg, sender_session, sender_project, reason):
        """Return one message to its sender's line as kind=bounce
        (0040): pushed like any message, one-line body, directory
        summary attached (0039). No sender line -> dropped (audit +
        panel; no other legal channel)."""
        stamp = time.strftime('%H:%M', time.localtime(msg['sent_at']))
        with self.lock:
            sender_line = (self.lines.get(msg['from'])
                           if msg['from'] else None)
            directory = self._directory_names_locked()
        body = ('your message to %s at %s was returned (%s)'
                % (msg['to'], stamp, reason))
        if directory:
            body += '; reachable: ' + ', '.join(directory)
        if sender_line is None:
            # §24.3: a drop must have a panel face too - capped,
            # persisted, rendered in the 留痕 section (D2 finding).
            drop = {
                'ts': time.time(), 'to': msg['to'],
                'from_line': msg['from'] or '',
                'from_session': sender_session,
                'project': sender_project or '',
                'reason': 'sender has no open line',
            }
            with self.lock:
                self.drops.append(drop)
                del self.drops[:-LINE_DROPS_MAX]
                self._persist_locked()
            self._event('message.dropped', line=msg['to'],
                        from_line=msg['from'] or '', to=msg['to'],
                        session=sender_session,
                        project=sender_project or '',
                        reason='sender has no open line')
            return ('dropped: %s (%s; you have no open line to '
                    'receive a bounce)' % (reason, msg['to']))
        bmsg = {
            'id': uuid.uuid4().hex[:8], 'kind': 'bounce',
            'from': msg['to'], 'from_session': sender_session,
            'to': msg['from'], 'text': body,
            'sent_at': time.time(), 'state': 'pending',
            'project': sender_project or '',
        }
        with self.lock:
            sender_line['log'].append(bmsg)
            sender_line['box'].append(bmsg)
            self._trim(sender_line)
            self._persist_locked()
        self._event('message.bounced', line=msg['from'],
                    from_line=msg['to'], to=msg['from'],
                    session=sender_session,
                    project=sender_project or '', reason=reason)
        self._push_line(msg['from'])
        return 'bounced: %s' % body

    # ------------------------------------------------------- close

    def close_line(self, name, actor, reason=''):
        """Close one line (owner/founder/panel/system). Box messages
        bounce to their senders; pushed history stays. A group dies
        with its last line - reopening founds it anew (0040)."""
        with self.lock:
            entry = self.lines.pop(name, None)
            if entry is None:
                return None
            pending = list(entry['box'])
            entry['box'] = []
            group = entry['group']
            if group and not any(l['group'] == group
                                 for l in self.lines.values()):
                self.groups.pop(group, None)
            trace = {
                'name': name, 'group': group or '',
                'owner': entry['owner'], 'project': entry['project'],
                'actor': actor, 'at': time.time(), 'reason': reason,
                'bounced': len(pending), 'messages': len(entry['log']),
            }
            self.history.insert(0, trace)
            del self.history[LINE_HISTORY_MAX:]
            self._persist_locked()
        self._event('line.close', line=name, group=group or '',
                    session=entry['owner'], project=entry['project'],
                    actor=actor, bounced=len(pending), reason=reason)
        for m in pending:
            self._bounce(m, m['from_session'], m.get('project', ''),
                         'line %s closed' % name)
        return trace

    def close_group(self, group, actor):
        """Whole-group teardown (0040): every line of the group,
        each bouncing its pending box."""
        with self.lock:
            names = [n for n, l in self.lines.items()
                     if l['group'] == group]
        return [self.close_line(n, actor=actor,
                                reason='group %s closed' % group)
                for n in names]

    def group_founder(self, group):
        with self.lock:
            return self.groups.get(group, {}).get('founder')

    def owned_name(self, session):
        with self.lock:
            return self._owned_name(session)

    def clear_panel(self, name=None, group=None):
        """Panel teardown (0041): 拆线/关闭整组, actor=panel."""
        if group:
            return self.close_group(group, actor='panel')
        if name:
            trace = self.close_line(name, actor='panel',
                                    reason='panel teardown')
            return [trace] if trace else []
        return []

    # ---------------------------------------------------- reads

    def _directory_names_locked(self):
        return sorted(self.lines)

    def directory_text(self):
        with self.lock:
            rows = sorted(self.lines.values(), key=lambda l: l['name'])
            groups = dict(self.groups)
        if not rows:
            return 'no open lines'
        out = []
        for l in rows:
            bits = [l['name'], l['description'] or '-']
            if l['group']:
                founder = groups.get(l['group'], {}).get('founder', '')
                bits.append('group=%s (founder %s)'
                            % (l['group'], founder[-8:]))
            if l['project']:
                bits.append(l['project'])
            out.append(' | '.join(bits))
        return '%d line(s):\n%s' % (len(rows), '\n'.join(out))

    def snapshot(self):
        """/api/state payload: lines (with log tail), groups, and the
        closed-line traces for the panel's 通话留痕 section."""
        with self.lock:
            lines = [{
                'name': l['name'], 'description': l['description'],
                'group': l['group'], 'owner': l['owner'],
                'project': l['project'], 'opened_at': l['opened_at'],
                'inflight': len(l['box']),
                'log': [dict(m) for m in l['log'][-8:]],
            } for l in sorted(self.lines.values(),
                              key=lambda l: l['name'])]
            return {'lines': lines,
                    'groups': {g: dict(v) for g, v in
                               self.groups.items()},
                    'history': list(self.history),
                    'drops': list(self.drops)}

    # --------------------------------------------- persistence

    def _persist_locked(self):
        """Snapshot to lines.json (0040 three no-loss). Best effort,
        tmp+replace like pending.json."""
        records = {
            'lines': [{
                'name': l['name'], 'description': l['description'],
                'group': l['group'], 'owner': l['owner'],
                'project': l['project'], 'opened_at': l['opened_at'],
                'log': l['log'], 'box': l['box'],
            } for l in self.lines.values()],
            'groups': self.groups,
            'drops': self.drops,
        }
        try:
            tmp = self.lines_path.with_suffix('.json.tmp')
            tmp.write_text(
                json.dumps(records, ensure_ascii=False) + '\n',
                encoding='utf-8')
            os.replace(tmp, self.lines_path)
        except OSError:
            LOG.warning('lines write failed', exc_info=True)

    def restore(self):
        """Re-open lines persisted by a previous run (0040): restored
        lines stay open, undelivered box messages re-push afterwards
        (repush_pending), pushed ones never re-send. Returns the
        count of restored lines."""
        try:
            raw = self.lines_path.read_text(encoding='utf-8')
        except OSError:
            return 0
        try:
            records = json.loads(raw or '{}')
            if not isinstance(records, dict):
                raise ValueError('lines.json: expected an object')
        except ValueError:
            LOG.warning('lines.json unreadable; skipping restore',
                        exc_info=True)
            return 0
        restored = 0
        with self.lock:
            for rec in records.get('lines') or []:
                if not isinstance(rec, dict) or not rec.get('name'):
                    continue
                if rec['name'] in self.lines:
                    continue
                rec.setdefault('description', '')
                rec.setdefault('group', None)
                rec.setdefault('project', '')
                rec.setdefault('opened_at', time.time())
                rec.setdefault('log', [])
                rec.setdefault('box', [])
                self.lines[rec['name']] = rec
                restored += 1
            self.groups.update(records.get('groups') or {})
            self.drops = [d for d in records.get('drops') or []
                          if isinstance(d, dict)][:LINE_DROPS_MAX]
        for name in list(self.lines):
            entry = self.lines[name]
            self._event('restored', line=name, group=entry['group'] or '',
                        session=entry['owner'],
                        project=entry['project'])
        return restored

    def repush_pending(self):
        """Retry every line's box (startup and the sweep loop)."""
        with self.lock:
            names = [n for n, l in self.lines.items() if l['box']]
        for name in names:
            self._push_line(name)


def primary_check(meta, session):
    """(ok, reason) - the b-full gate (0042): line tools are for
    primary sessions, proven by Session.Info.parentID being null.
    Topology, not identity (0016/0039 stand). Fail-closed: an
    unverifiable session is rejected with a retry hint (0019)."""
    if not session.startswith('ses_'):
        return False, 'no verifiable session id on this call'
    entry = meta.snapshot([session]).get(session)
    if entry is None:
        try:
            info = _service_get('/api/session/' + session) or {}
        except ServiceUnavailable:
            return False, LINE_DENY_RETRY
        if info.get('parentID'):
            return False, 'child session - line tools are primary-only'
        return True, ''
    if entry.get('parentID'):
        return False, 'child session - line tools are primary-only'
    return True, ''


# -------------------------------------------------- file viewer (/file)

def _panel_poll_file(workspace: Path) -> Path:
    return workspace / 'panel.json'


def read_panel_poll(workspace: Path) -> float:
    """Last time the panel page's own poll (?token= auth, never a
    machine client's Bearer poll) hit /api/state (0 = never)."""
    try:
        return float(json.loads(
            _panel_poll_file(workspace).read_text(encoding='utf-8')
        ).get('last_poll', 0))
    except (OSError, ValueError):
        return 0.0


_last_poll_write = 0.0


def write_panel_poll(workspace: Path, force: bool = False) -> None:
    """Persist the poll heartbeat (throttled: the panel polls every
    2s; the file needs at most one write per interval)."""
    global _last_poll_write
    now = time.time()
    if not force and now - _last_poll_write < PANEL_POLL_WRITE_INTERVAL:
        return
    _last_poll_write = now
    try:
        _panel_poll_file(workspace).write_text(
            json.dumps({'last_poll': now}), encoding='utf-8')
    except OSError:
        pass  # heartbeat is best-effort


def panel_is_alive(workspace: Path) -> bool:
    """True when some panel tab polled within PANEL_ALIVE_SEC."""
    last = read_panel_poll(workspace)
    return bool(last) and time.time() - last < PANEL_ALIVE_SEC


# 0029: a landed ticket must reach the user even when no panel tab is
# open. Auto-open respects the duplicate-tab guard (a live tab learns
# about the ticket on its next poll and chimes itself, so opening a
# second tab would be noise) plus a throttle so a burst of tickets
# cannot stack browser tabs before the first one starts polling.
PANEL_OPEN_THROTTLE_SEC = 10


def should_open_panel(panel_alive: bool, now: float,
                      last_open_at: float) -> bool:
    """Pure seam: open a browser tab only when nobody is watching and
    the previous launch is far enough back (burst throttle)."""
    if panel_alive:
        return False
    return now - last_open_at >= PANEL_OPEN_THROTTLE_SEC


_panel_open_lock = threading.Lock()
_last_panel_open = 0.0


def maybe_open_panel(workspace: Path, port: int, token: str,
                     opener=None) -> bool:
    """Open the panel in a browser when warranted; True when launched.

    ``opener`` is injectable for tests; the default is the platform
    browser dispatch. Failures are logged, never raised - the ticket
    machinery must not depend on the notifier."""
    global _last_panel_open
    with _panel_open_lock:
        now = time.time()
        if not should_open_panel(panel_is_alive(workspace), now,
                                 _last_panel_open):
            return False
        _last_panel_open = now
    open_url = opener or open_preview_browser
    open_url('http://127.0.0.1:%d/?token=%s' % (port, token), LOG)
    return True


def resolve_view_path(raw: str, project_root: Path):
    """Accept absolute or project-relative paths (agents paste both).
    Returns the resolved file Path, or None when missing/not a file."""
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = project_root / p
    try:
        p = p.resolve()
        if not p.is_file():
            return None
    except OSError:
        return None
    return p


def read_view_file(p: Path):
    """UTF-8 text (errors replaced) or None when oversized/binary/
    unreadable. Refuses rather than truncates: partial file views lie."""
    try:
        if p.stat().st_size > FILE_CAP:
            return None
        data = p.read_bytes()
    except OSError:
        return None
    if b'\x00' in data[:8192]:
        return None  # binary sniff
    return data.decode('utf-8', errors='replace')


# ---------------------------------------------------------------- files
# 2026-11-06: the /file viewer renders by file type (md documents,
# svg/mockup figures, html pages) instead of raw text. The daemon
# stays stdlib-only (module docstring): rendering happens in the
# browser, with marked vendored as a shipped asset (same precedent as
# pinpoint's static/vendor/mermaid.min.js; IR-2 rule 5 exempts vendor
# files from style rules - never edit, re-vendor instead).

VENDOR_DIR = Path(__file__).resolve().parent / 'vendor'
MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js'
# Re-vendor: curl -o relay/vendor/marked.min.js <MARKED_URL> (keep the
# URL and the version pin here in sync when bumping).

VIEW_KINDS = {
    '.md': 'md', '.markdown': 'md',
    '.svg': 'svg',
    '.html': 'html', '.htm': 'html',
}


def load_vendor_js() -> Optional[str]:
    """The vendored marked build, or None when not shipped (callers
    degrade to plain text - never break the viewer)."""
    try:
        return (VENDOR_DIR / 'marked.min.js').read_text(encoding='utf-8')
    except OSError:
        return None


def view_kind(path: Union[str, Path]) -> str:
    """How the viewer presents a file: md/svg/html render, the rest
    stay plain text with line numbers (and :line jumps)."""
    return VIEW_KINDS.get(Path(path).suffix.lower(), 'text')


VIEWER_CSS = """
  /* rendered file bodies (shared by the /file page and the overlay) */
  .mdoc{font-family:system-ui,-apple-system,sans-serif;font-size:13.5px;line-height:1.65;padding:4px 18px 24px}
  .mdoc h1{font-size:1.45em;margin:18px 0 8px;line-height:1.3}
  .mdoc h2{font-size:1.25em;margin:16px 0 6px}
  .mdoc h3{font-size:1.1em;margin:14px 0 6px}
  .mdoc p{margin:8px 0}
  .mdoc ul,.mdoc ol{margin:8px 0;padding-left:26px}
  .mdoc blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid #d0d5dd;color:#475467}
  .mdoc table{border-collapse:collapse;margin:10px 0}
  .mdoc th,.mdoc td{border:1px solid #e4e7ec;padding:5px 10px;text-align:left}
  .mdoc th{background:#f6f7f9}
  .mdoc img{max-width:100%}
  .mdoc pre{background:#f6f7f9;border:1px solid #e4e7ec;border-radius:8px;padding:10px 12px;
   overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;
   font-family:ui-monospace,Consolas,monospace}
  .mdoc code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;background:#f2f4f7;
   border-radius:4px;padding:1px 5px}
  .mdoc pre code{background:none;padding:0}
  .figv{margin:12px 18px;border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;background:#fff}
  .figi{padding:14px;overflow:auto}
  .figi svg{max-width:100%;height:auto}
  .figc{border-top:1px solid #eef0f3;padding:5px 12px;font-size:11.5px;color:#667085;background:#f9fafb}
  .vhtml{display:flex;flex-direction:column;min-height:70vh}
  .vhtmlbar{display:flex;gap:12px;align-items:center;padding:8px 14px;border-bottom:1px solid #e4e7ec;
   font-size:12px;color:#667085;font-family:system-ui,sans-serif}
  .vframe{flex:1;width:100%;border:none;background:#fff;min-height:60vh}
"""

VIEWER_JS = """
// Shared read-only renderer for the /file page and the panel overlay
// (2026-11-06): files used to show as raw text; now markdown renders,
// mockup/svg sources become sanitized figures, and html previews in a
// sandboxed frame. The daemon stays stdlib-only, so this runs in the
// browser with marked vendored at /vendor/marked.js.
// Sanitization ports pinpoint's rules (0029 mirror duty - keep in
// sync): document level = render.py normalize_html_fragment (drop
// script/iframe/object/embed, on* handlers, javascript: URLs; links
// and <style> stay); figure level = diagram.js sanitizeFigureBody
// (stricter: also drop <style>/<template>, id attrs, and A/AREA href
// outright - mockups are pictures, not controls).
const DOC_DROP = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED']);
const FIGURE_DROP = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
  'LINK', 'META', 'BASE', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
const URL_ATTRS = new Set(['HREF', 'SRC', 'XLINK:HREF', 'ACTION',
  'FORMACTION', 'POSTER', 'BACKGROUND']);
function sanitizeTree(root, dropSet, figure) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (dropSet.has(el.tagName)) { el.remove(); continue; }
    if (figure && el.tagName === 'FORM') {
      el.replaceWith(...el.childNodes);  // layout, not a control
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toUpperCase();
      if (name.startsWith('ON') || (figure && name === 'ID')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (!URL_ATTRS.has(name)) continue;
      const value = attr.value.trim().toLowerCase();
      if (value.startsWith('javascript:')
          || (figure && (name === 'HREF' || name === 'XLINK:HREF')
              && (el.tagName === 'A' || el.tagName === 'AREA'))) {
        el.removeAttribute(attr.name);
      }
    }
  }
}
function figureBox(lang, source) {
  const fig = document.createElement('div');
  fig.className = 'figv';
  const inner = document.createElement('div');
  inner.className = 'figi';
  inner.innerHTML = source;  // detached tree: innerHTML runs nothing
  sanitizeTree(inner, FIGURE_DROP, true);
  const cap = document.createElement('div');
  cap.className = 'figc';
  cap.textContent = lang;
  fig.append(inner, cap);
  return fig;
}
function upgradeFences(root) {
  // marked renders mockup/svg fences as <pre><code class="language-x">
  // - swap those for sanitized figure boxes. html and mermaid fences
  // stay code blocks (mermaid needs its own vendored renderer; a
  // deliberate non-goal here, pinpoint parity).
  for (const code of [...root.querySelectorAll('pre > code')]) {
    const lang = [...code.classList].find(
      (c) => c === 'language-mockup' || c === 'language-svg');
    if (!lang) continue;
    code.closest('pre').replaceWith(
      figureBox(lang.slice('language-'.length), code.textContent));
  }
}
function renderDoc(text) {
  // markdown -> sanitized DOM; null when the vendor failed to load
  // (the caller falls back to plain text).
  if (typeof marked === 'undefined') return null;
  const root = document.createElement('div');
  root.className = 'mdoc';
  root.innerHTML = marked.parse(text);
  upgradeFences(root);
  sanitizeTree(root, DOC_DROP, false);
  return root;
}
function renderSvg(text) {
  return figureBox('svg', text);
}
function renderHtmlFrame(text, rawUrl) {
  // .html previews sandboxed (no scripts, opaque origin); the link
  // opens the page itself - the daemon serves that with
  // Content-Security-Policy: script-src 'none'.
  const box = document.createElement('div');
  box.className = 'vhtml';
  const bar = document.createElement('div');
  bar.className = 'vhtmlbar';
  const note = document.createElement('span');
  note.textContent = '沙箱预览(禁脚本)';
  const link = document.createElement('a');
  link.href = rawUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '新标签打开页面';
  bar.append(note, link);
  const frame = document.createElement('iframe');
  frame.className = 'vframe';
  frame.setAttribute('sandbox', '');
  frame.srcdoc = text;
  box.append(bar, frame);
  return box;
}
window.relayViewer = { sanitizeTree, figureBox, upgradeFences,
  renderDoc, renderSvg, renderHtmlFrame };
"""


def file_view_html(display: str, text: str, line: str,
                   kind: str = 'text') -> str:
    """Minimal read-only viewer page, styled like the panel. The target
    line (path:line links) gets highlighted and scrolled into view.
    md/svg render instead (2026-11-06); other kinds stay text."""
    if kind in ('md', 'svg'):
        return _file_rendered_html(display, text, kind)
    target = int(line) if line.isdigit() else None
    rows = []
    for i, content in enumerate(text.split('\n'), 1):
        rows.append(
            '<div class="row%s" id="L%d"><span class="ln">%d</span>'
            '<span class="lc">%s</span></div>'
            % (' marked' if i == target else '', i, i,
               html.escape(content) or '&#160;'))
    return ('<!doctype html><html lang="zh"><head><meta charset="utf-8">'
            '<title>%s · relay</title>__FAVICON__<style>'
            'body{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;'
            'margin:0;background:#f6f7f9;color:#1a2233}'
            'header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e4e7ec;'
            'padding:10px 16px;font-family:system-ui,sans-serif;font-size:13px;'
            'display:flex;gap:12px;align-items:center}'
            'header .path{font-weight:600;word-break:break-all}'
            'header a{color:#3b5bfd;text-decoration:none;font-size:12px}'
            '.wrap{max-width:980px;margin:0 auto;padding:12px 0 40px}'
            '.row{display:flex;line-height:1.6}'
            '.ln{flex:0 0 4em;text-align:right;padding-right:14px;color:#98a2b3;'
            'user-select:none}'
            '.lc{white-space:pre;flex:1}'
            '.row.marked{background:#fff3d6;outline:1px solid #f0c36d}'
            '</style></head><body>'
            '<header><span class="path">%s</span>'
            '<span style="color:#98a2b3">%d 行</span>'
            '<a href="javascript:window.close()" title="也可直接关闭本标签页">'
            '&#215; 关闭本页</a></header>'
            '<div class="wrap">%s</div>'
            '<script>var m=document.querySelector(".row.marked");'
            'm&&m.scrollIntoView({block:"center"});</script></body></html>'
            % (html.escape(display), html.escape(display),
               len(rows), ''.join(rows))).replace('__FAVICON__',
                                                FAVICON_LINK)


def _file_rendered_html(display: str, text: str, kind: str) -> str:
    """Rendered /file page (md/svg): the text page's header plus a
    源码 link (forces mode=text); the body renders client-side via
    VIEWER_JS (md also loads the vendored marked). The payload rides
    inside a <script> as JSON with '</' escaped, so no file content
    can close the tag early."""
    payload = json.dumps(text).replace('</', '<\\/')
    marked_tag = ('<script src="/vendor/marked.js"></script>'
                  if kind == 'md' else '')
    render_call = 'renderDoc' if kind == 'md' else 'renderSvg'
    return ('<!doctype html><html lang="zh"><head><meta charset="utf-8">'
            '<title>%s · relay</title>__FAVICON__<style>'
            'body{margin:0;background:#f6f7f9;color:#1a2233}'
            'header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e4e7ec;'
            'padding:10px 16px;font-family:system-ui,sans-serif;font-size:13px;'
            'display:flex;gap:12px;align-items:center}'
            'header .path{font-weight:600;word-break:break-all}'
            'header a{color:#3b5bfd;text-decoration:none;font-size:12px}'
            '%s</style></head><body>'
            '<header><span class="path">%s</span>'
            '<a href="#" id="srclink">查看源码</a>'
            '<a href="javascript:window.close()" title="也可直接关闭本标签页">'
            '&#215; 关闭本页</a></header>'
            '<div id="fbody"></div>'
            '<script>document.getElementById("srclink").onclick=function(){'
            'var q=new URLSearchParams(location.search);q.set("mode","text");'
            'location.search=q.toString();return false;};</script>'
            '%s<script>%s</script>'
            '<script>var n=relayViewer.%s(%s);'
            'if(!n){var q=new URLSearchParams(location.search);'
            'q.set("mode","text");location.search=q.toString();}'
            'else{document.getElementById("fbody").append(n);}'
            '</script></body></html>'
            % (html.escape(display), VIEWER_CSS, html.escape(display),
               marked_tag, VIEWER_JS, render_call, payload)).replace(
                   '__FAVICON__', FAVICON_LINK)


def file_view_response(p: Path, raw: str, line: str,
                       mode: str) -> tuple[bytes, str, Optional[dict]]:
    """Pure dispatch for /file (testable without a socket): returns
    (body_bytes, content_type, extra headers).

    html jumps straight to the rendered page, served as-is with
    Content-Security-Policy: script-src 'none' - styles, links and
    images work, no script ever runs, so the token in the URL cannot
    leak. Other kinds get a viewer page; mode=text forces plain text
    for any type (the 源码 affordance)."""
    kind = view_kind(p)
    text = read_view_file(p) or ''
    if mode != 'text' and kind == 'html':
        return (text.encode('utf-8'), 'text/html; charset=utf-8',
                {'Content-Security-Policy': "script-src 'none'"})
    if mode != 'text' and kind == 'md' and load_vendor_js() is None:
        kind = 'text'  # vendor not shipped: degrade, never break
    if mode == 'text':
        kind = 'text'  # the 源码 affordance
    return (file_view_html(raw, text, line, kind).encode('utf-8'),
            'text/html; charset=utf-8', None)


# ---------------------------------------------------------------- panel

# The panel's "R" logo tile, replayed as the tab icon. base64 keeps the
# data URI free of '%' bytes, so it can ride %-format templates intact.
LOGO_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            '<rect width="64" height="64" rx="19" fill="#3b5bfd"/>'
            '<text x="32" y="44" font-family="system-ui,sans-serif" '
            'font-size="34" font-weight="700" fill="#fff" '
            'text-anchor="middle">R</text></svg>')
FAVICON_LINK = ('<link id="fav" rel="icon" type="image/svg+xml" '
                'href="data:image/svg+xml;base64,'
                + base64.b64encode(LOGO_SVG.encode('utf-8')).decode('ascii')
                + '">')


PANEL_HTML = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>relay · Agent 提问队列</title>
__FAVICON__
<style>
 :root{
  --bg:#f4f5f7;--surface:#fff;--border:#e4e7ec;--text:#1a2233;--muted:#667085;
  --accent:#3b5bfd;--accent-ink:#fff;--link:#3b5bfd;--chipbg:#eef1ff;--chipink:#3730a3;
  --warn:#d97706;--ok:#12b76a;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.08);
  --mono:ui-monospace,SFMono-Regular,Consolas,'Courier New',monospace}
 @media (prefers-color-scheme: dark){:root{
  --bg:#101319;--surface:#181d26;--border:#273043;--text:#e6eaf2;--muted:#98a2b3;
  --link:#8ba2ff;--chipbg:#232b45;--chipink:#a5b4fc;
  --shadow:0 1px 3px rgba(0,0,0,.5)}}
 *{box-sizing:border-box}
 body{font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  background:var(--bg);color:var(--text);max-width:860px;margin:0 auto;padding:0 16px 48px;font-size:14px}
 .topbar{display:flex;align-items:center;gap:10px;padding:16px 2px 12px;position:sticky;top:0;z-index:5;
  background:linear-gradient(var(--bg) 78%,transparent)}
 .logo{display:inline-flex;width:27px;height:27px;border-radius:8px;background:var(--accent);color:#fff;
  font-weight:700;align-items:center;justify-content:center;font-size:14px;flex:0 0 auto}
 .brand{font-size:16px;font-weight:700;letter-spacing:.2px}
 .brand .sub{font-size:12px;color:var(--muted);font-weight:400;margin-left:8px}
 .status{margin-left:auto;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;white-space:nowrap}
 .dot{width:8px;height:8px;border-radius:50%;background:var(--ok)}
 .dot.off{background:var(--warn);animation:pulse 1s infinite alternate}
 .bbtn{border:none;background:var(--accent);color:#fff;border-radius:8px;
  padding:5px 12px;font-size:12px;cursor:pointer;white-space:nowrap}
 @keyframes pulse{to{opacity:.35}}
 .group{margin:10px 0 16px}
 .ghead{position:sticky;top:56px;z-index:4;display:flex;align-items:center;gap:8px;padding:6px 2px;
  font-weight:600;font-size:13.5px;background:linear-gradient(var(--bg) 70%,transparent)}
 .gdot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
 .gcount{margin-left:auto;font-size:11.5px;color:var(--muted);background:var(--surface);
  border:1px solid var(--border);border-radius:999px;padding:1px 9px;font-weight:500}
 .ticket{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent);
  border-radius:10px;padding:13px 16px 14px;margin:10px 0;box-shadow:var(--shadow)}
 .meta{font-size:12px;color:var(--muted);display:flex;align-items:center;flex-wrap:wrap;gap:6px}
 .age.slow{color:var(--warn);font-weight:600}
 .agent{display:inline-block;background:var(--chipbg);color:var(--chipink);border-radius:5px;
  padding:1px 6px;font-size:11px;font-weight:600;margin-right:4px}
  .pchip{display:inline-block;background:var(--surface);color:var(--muted);border:1px solid var(--border);
   border-radius:5px;padding:1px 6px;font-size:10.5px;font-weight:600;margin-right:6px;max-width:130px;
   overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:1px}
 .q{margin:13px 0 5px;font-size:14px;line-height:1.55;white-space:pre-wrap}
 .qn{display:inline-flex;width:19px;height:19px;border-radius:5px;background:var(--chipbg);color:var(--chipink);
  font-size:11.5px;font-weight:700;align-items:center;justify-content:center;margin-right:7px;vertical-align:-4px;flex:0 0 auto}
 .opts{margin:4px 0}
 .opts button{margin:2px 6px 2px 0;padding:4px 13px;font-size:13px;background:var(--surface);
  border:1px solid var(--border);border-radius:999px;color:var(--text)}
 .opts button:hover{border-color:var(--accent);color:var(--link)}
 textarea,input{width:100%;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit;
  background:var(--surface);color:var(--text);margin:5px 0}
 textarea:focus,input:focus{outline:2px solid rgba(59,91,253,.25);border-color:var(--accent)}
 details{margin:6px 0}
 summary{color:var(--link);font-size:12.5px;cursor:pointer;user-select:none}
 summary:hover{text-decoration:underline}
 details.fold{margin:0}
 details.fold>summary{display:flex;align-items:center;gap:6px;color:inherit;
  font-size:inherit}
 details.fold>summary:hover{text-decoration:none}
 details.fold>summary::-webkit-details-marker{display:none}
 details.fold>summary .meta{flex:1 1 auto}
 .chev{flex:0 0 auto;color:var(--muted);font-size:11px;transition:transform .12s}
 details.fold[open]>summary .chev{transform:rotate(180deg)}
 .tblock+.tblock{border-top:1px dashed var(--border);margin-top:10px;padding-top:8px}
 .hist{margin:18px 2px 0;border-top:1px solid var(--border);padding-top:10px}
 .hist>summary{color:var(--muted);font-size:12.5px;cursor:pointer;user-select:none}
 .hrow{background:var(--surface);border:1px solid var(--border);border-radius:8px;
  padding:8px 12px;margin:8px 0;font-size:13px}
 .hq{line-height:1.5;white-space:pre-wrap}
 .ha{margin-top:4px;color:var(--ok);white-space:pre-wrap}
 .ha.st{color:var(--muted)}
 .hm{margin-top:4px;font-size:11px;color:var(--muted);font-family:var(--mono)}
 .bhead{display:flex;align-items:center;margin:0}
 .bhead .btag{background:var(--chipbg);color:var(--chipink);border-radius:5px;
  padding:1px 6px;font-size:11px;font-weight:600}
 .bhead .rtag{background:#fe9;color:#960;border-radius:5px;
  padding:1px 6px;font-size:11px;font-weight:600}
 .linkbtn{margin-left:auto;background:none;border:none;color:var(--muted);
  font-size:12px;padding:0}
 .linkbtn:hover{color:var(--link);text-decoration:underline}
 .q .linkbtn{float:right;margin:0 0 0 8px}
 .linkbtn.on{color:var(--warn);font-weight:600}
 textarea.qdec{opacity:.55;border-style:dashed}
 .clines{background:var(--bg);border:1px solid var(--border);border-radius:8px;
  padding:8px 0;max-height:300px;overflow:auto;font-family:var(--mono);
  font-size:12px;line-height:1.55;margin:5px 0}
 .crow{display:flex;cursor:pointer;padding:0 10px}
 .crow:hover{background:rgba(59,91,253,.08)}
 .crow .ln{flex:0 0 3.2em;text-align:right;padding-right:12px;color:var(--muted);
  user-select:none}
 .crow .lc{white-space:pre-wrap;word-break:break-all;flex:1}
 .crow.marked{background:rgba(217,119,6,.14)}
 .crow.marked .ln{color:var(--warn);font-weight:700}
 .annrow{display:flex;align-items:center;gap:6px;margin:2px 10px;background:var(--surface);
  border:1px solid var(--border);border-radius:8px;padding:4px 8px}
 .annrow .anntag{font-family:var(--mono);color:var(--warn);font-size:11.5px;flex:0 0 auto;
  font-weight:600}
 .annrow input{width:auto;flex:1 1 auto;margin:0}
 .annrow .ghost{padding:3px 10px;font-size:12px;flex:0 0 auto}
 pre{background:var(--bg);border:1px solid var(--border);padding:10px 12px;overflow:auto;max-height:300px;
  font-size:12px;line-height:1.55;font-family:var(--mono);border-radius:8px;white-space:pre-wrap;word-break:break-all;margin:5px 0}
 a{color:var(--link);text-decoration:none;border-bottom:1px dashed rgba(59,91,253,.5)}
 a:hover{border-bottom-style:solid}
 .actions{display:flex;gap:8px;margin-top:12px;align-items:center}
 button{font:inherit;cursor:pointer;border-radius:8px;font-weight:500}
 .primary{background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent);padding:7px 18px}
 .primary:hover{filter:brightness(1.08)}
 .ghost{background:var(--surface);color:var(--text);border:1px solid var(--border);padding:7px 14px}
 .ghost:hover{border-color:var(--muted)}
 .empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:72px 0;color:var(--muted);text-align:center}
 .empty .big{font-size:36px}
 .empty .hint{font-size:12.5px}
 /* wiretap (0041 variant A): sticky summary strip + group zones */
 .wa-strip{position:sticky;top:56px;z-index:4;background:var(--surface);border:1px solid var(--border);
  border-radius:10px;padding:7px 12px;margin:2px 0 12px;display:flex;align-items:center;gap:8px;
  font-size:13px;cursor:pointer;box-shadow:var(--shadow)}
 .wa-strip:hover{border-color:var(--accent)}
 .wa-strip .exp{margin-left:auto;font-size:12px;color:var(--link);white-space:nowrap}
 .wa-zone{margin:14px 0 4px}
 .wa-ghead{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin:2px 2px 6px;flex-wrap:wrap}
 .wa-gdot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
 .wa-gmeta{color:var(--muted);font-weight:400;font-size:12px}
 .lname{font-weight:700;font-size:13.5px;color:var(--text)}
 .lstate{font-size:11px;font-weight:600;border-radius:5px;padding:1px 6px}
 .lstate.busy{background:rgba(18,183,106,.14);color:var(--ok)}
 .lstate.idle{background:var(--chipbg);color:var(--chipink)}
 .stale{color:var(--warn);font-weight:600}
 .ldesc{font-size:12.5px;color:var(--muted);margin:2px 0 4px}
 .msglog{margin:6px 0 2px}
 .mrow{display:flex;gap:8px;padding:4px 8px;border-radius:8px;font-size:13px;line-height:1.5;flex-wrap:wrap}
 .mrow+.mrow{margin-top:3px}
 .mrow .at{font-family:var(--mono);color:var(--muted);font-size:11.5px;flex:0 0 auto;padding-top:2px}
 .mrow .who{flex:0 0 auto;font-weight:600;font-size:12.5px}
 .mrow .who .arr{color:var(--muted);font-weight:400}
 .mrow .txt{flex:1 1 auto;white-space:pre-wrap;word-break:break-word;min-width:12em}
 .mrow.pending{border:1px dashed var(--border);color:var(--muted)}
 .mrow.bounce{background:rgba(217,119,6,.1)}
 .linkbtn.armed{color:#e5484d;font-weight:700}
 .lh-hm{margin-top:4px;font-size:11px;color:var(--muted);font-family:var(--mono)}
 .lh-sub{font-size:12px;font-weight:600;color:var(--warn);margin:8px 0 2px}
 /*__VIEWER_CSS__*/
 /* in-panel file viewer overlay */
 .viewer{position:fixed;inset:0;background:rgba(15,20,30,.45);display:none;
  align-items:flex-start;justify-content:center;padding:5vh 16px;z-index:50}
 .viewer.on{display:flex}
 .vcard{background:var(--surface);border:1px solid var(--border);border-radius:12px;
  box-shadow:0 12px 40px rgba(0,0,0,.25);max-width:980px;width:100%;max-height:88vh;
  display:flex;flex-direction:column;overflow:hidden}
 .vhead{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);
  font-size:13px}
 .vhead .path{font-family:var(--mono);font-weight:600;word-break:break-all}
 .vhead .n{color:var(--muted);font-size:12px;white-space:nowrap}
 .vclose{margin-left:auto;border:none;background:none;font-size:18px;line-height:1;color:var(--muted);
  padding:2px 8px;border-radius:6px}
 .vclose:hover{background:var(--bg);color:var(--text)}
 .vbody{overflow:auto;padding:10px 0;font-family:var(--mono);font-size:12.5px}
 .row{display:flex;line-height:1.6}
 .ln{flex:0 0 4em;text-align:right;padding-right:14px;color:var(--muted);user-select:none}
 .lc{white-space:pre;flex:1}
 .row.marked{background:rgba(217,119,6,.14);outline:1px solid rgba(217,119,6,.45)}
 .verr{padding:28px;color:var(--muted);text-align:center;font-family:system-ui,sans-serif;font-size:13px}
</style></head><body>
<header class="topbar">
 <span class="logo">R</span>
 <span class="brand">relay<span class="sub">Agent 提问队列</span></span>
 <span class="status"><span class="dot" id="conn"></span><span id="connText">连接中</span> · <span id="count">0 会话 · 0 问</span></span>
 <button class="bbtn" id="batch" hidden onclick="batchApply()">整页批阅</button>
</header>
<div class="wa-strip" id="wireStrip" hidden></div>
<main><div id="list"></div><section id="wire" hidden></section><details class="hist" id="lhist" hidden><summary>通话留痕(已拆/投递失败)</summary><div id="lhistbody"></div></details><details class="hist" id="hist" hidden><summary>问答历史(已决)</summary><div id="histbody"></div></details></main>
<script>
const PAGE_V = '__PANEL_VERSION__';
const token = new URLSearchParams(location.search).get('token')
  || localStorage.getItem('relay_token') || '';
localStorage.setItem('relay_token', token);
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// File paths (with optional :line) become links into the /file viewer.
const PATH_RE = /(\\b[A-Za-z]:\\\\[^\\s"'<>|]+|\\\\\\\\[^\\s"'<>|]+|(?<![\\w.\\\\/-])\\/(?:[\\w.-]+\\/)+[\\w.-]+\\.[A-Za-z0-9]{1,5}|(?<![\\w.\\\\/-])[\\w.-]+(?:[\\/\\\\][\\w.-]+)+\\.[A-Za-z0-9]{1,5})(?::(\\d+))?/g;
function linkify(s) {
  return s.replace(PATH_RE, (m, p, line) => {
    const trail = m.match(/[.,;:!)]+$/);
    let end = '';
    if (trail && !line) { end = trail[0]; m = m.slice(0, -end.length); p = p.slice(0, -end.length); }
    return `<a href="/file?token=${encodeURIComponent(token)}&path=${encodeURIComponent(p)}`
      + (line ? `&line=${line}` : '')
      + `" data-path="${esc(p)}"${line ? ` data-line="${line}"` : ''}>${esc(m)}</a>` + end;
  });
}
// http(s) URLs open in a new tab (user ruling 2026-11-06: an agent
// proposing a UI/visual design serves the page itself and passes the
// link; the panel's whole job is to make it clickable, without
// leaking the relay token). Input is already esc()'d, so the match is
// entity text — inject it verbatim; entities round-trip in href and
// content, and re-escaping would print &amp; literally.
const URL_RE = /\\bhttps?:\\/\\/[^\\s<>"']+/g;
function linkifyUrls(s) {
  return s.replace(URL_RE, (m) => {
    let end = '';
    const trail = m.match(/[.,;:!?。，、；：？！）]+$/);
    if (trail) {
      let len = m.length - trail[0].length;
      const cut = m.slice(0, len);
      // esc() turned & into &amp; — never bite into that entity
      if (trail[0][0] === ';' && /&[a-zA-Z0-9#]+$/.test(cut)) len += 1;
      end = m.slice(len);
      m = m.slice(0, len);
    }
    return `<a href="${m}" target="_blank" rel="noopener noreferrer">`
      + `${m}</a>` + end;
  });
}
const fmt = s => linkifyUrls(linkify(esc(s)));
function groupColor(root) {
  let h = 0;
  for (const c of root) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 52%)`;
}
function sesLabel(c) {
  const m = c.meta;
  const tail = c.session.slice(-8);
  return (m && m.agent ? `<span class="agent">${esc(m.agent)}</span>` : '')
    + esc(m && m.title ? tail + ' · ' + m.title : 'session ' + tail);
}
function headState(c) {
  return (c.meta && c.meta.title ? 'T' : 't')
    + (c.meta && c.meta.first_msg ? 'F' : 'f');
}
function baseName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.pop() || String(p);
}
function cardHead(c) {
  return `<span class="meta">`
    + (c.project ? `<span class="pchip" title="${esc(c.project)}">`
      + `${esc(baseName(c.project))}</span>` : '')
    + `<span class="label">${sesLabel(c)}</span>`
    + `<span>·</span><span class="age ${c.age >= 120 ? 'slow' : ''}">已等待 ${c.age}s</span>`
    + `<span>·</span><span>${c.count} 问</span>`
    + (c.tickets.length > 1 ? `<span>·</span><span>${c.tickets.length} 单</span>` : '')
    + `</span><span class="chev" aria-hidden="true">&#9662;</span>`;
}
function firstHtml(c) {
  return `<details class="first"><summary>会话首条消息</summary>`
    + `<pre>${fmt(c.meta.first_msg)}</pre></details>`;
}
function ctxHtml(tid, qi, context) {
  const lines = context.split('\\n');
  const rows = lines.map((c, i) =>
    `<div class="crow" data-ln="${i + 1}"><span class="ln">${i + 1}</span>`
    + `<span class="lc">${fmt(c) || '&#160;'}</span></div>`).join('');
  return `<details class="ctx"><summary>上下文 · ${lines.length} 行 · 点行批注</summary>`
    + `<div class="clines" data-key="${esc(tid)}:${qi}">${rows}</div></details>`;
}
function annText(value, ln) {
  const hit = value.split('\\n').find(l => l.startsWith('@L' + ln + ':'));
  return hit ? hit.slice(('@L' + ln + ':').length).trim() : '';
}
function removeAnnLine(value, ln) {
  const tag = '@L' + ln + ':';
  return value.split('\\n').filter(l => !l.startsWith(tag)).join('\\n');
}
let annEditor = null;
function closeAnn() {
  if (annEditor) { annEditor.remove(); annEditor = null; }
}
function openAnn(crow) {
  // Inline annotation editor under the clicked line (user ruling,
  // panel 2026-11-03: a silent textarea append was too crude; and
  // marks must follow content, not clicks). Click an annotated line
  // again to edit it; save empty to clear that line's annotation.
  closeAnn();  // one editor at a time; switching rows discards drafts
  const clines = crow.closest('.clines');
  const ta = crow.closest('.tblock')
    .querySelector(`textarea[data-key="${clines.dataset.key}"]`);
  const ln = crow.dataset.ln;
  const row = document.createElement('div');
  row.className = 'annrow';
  row.dataset.ln = ln;
  row.dataset.key = clines.dataset.key;
  row.innerHTML = `<span class="anntag">@L${ln}:</span>`
    + `<input placeholder="批注内容;留空保存 = 清除该行批注">`
    + `<button class="ghost" onclick="saveAnn()">存</button>`
    + `<button class="ghost" onclick="closeAnn()">消</button>`;
  crow.insertAdjacentElement('afterend', row);
  const input = row.querySelector('input');
  input.value = annText(ta.value, ln);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveAnn();
    if (e.key === 'Escape') closeAnn();
  });
  annEditor = row;
  input.focus();
}
function saveAnn() {
  if (!annEditor) return;
  const text = annEditor.querySelector('input').value.trim();
  const ta = annEditor.closest('.tblock')
    .querySelector(`textarea[data-key="${annEditor.dataset.key}"]`);
  let v = removeAnnLine(ta.value, annEditor.dataset.ln);
  if (text) v += (v && !v.endsWith('\\n') ? '\\n' : '')
    + '@L' + annEditor.dataset.ln + ': ' + text;
  ta.value = v;
  closeAnn();
  syncMarks(ta.closest('.tblock'));
}
function syncMarks(tblock) {
  // A row is "annotated" only while its @L<n>: line carries content;
  // hand edits to the answer stay in sync via the input listener.
  for (const box of tblock.querySelectorAll('.clines')) {
    const ta = tblock.querySelector(`textarea[data-key="${box.dataset.key}"]`);
    for (const crow of box.querySelectorAll('.crow'))
      crow.classList.toggle('marked', !!annText(ta.value, crow.dataset.ln));
  }
}
function tblockHtml(t) {
  let h = `<div class="tblock" data-id="${esc(t.id)}">`
    + `<div class="bhead">` + (t.restored
        ? `<span class="rtag">重启前</span>` : '')
    + `<button class="linkbtn" onclick="decline('${esc(t.id)}')">这单你来定</button></div>`;
  t.questions.forEach((q, i) => {
    const qd = `<button class="linkbtn qd" onclick="`
      + `toggleQd(this,'${esc(t.id)}',${i})">你来定</button>`;
    h += `<div class="q"><span class="qn"></span>${fmt(q.text)}${qd}</div>`;
    if (q.context) h += ctxHtml(t.id, i, q.context);
    if (q.options) {
      h += '<div class="opts">' + q.options.map(o =>
        `<button onclick="pick(this,'${esc(t.id)}',${i},this.textContent)">${esc(o)}</button>`).join('') + '</div>';
    }
    h += `<textarea rows="2" data-key="${esc(t.id)}:${i}" placeholder="回答"></textarea>`;
  });
  return h + '</div>';
}
function cardHtml(c, color) {
  return `<div class="ticket" data-session="${esc(c.session)}"`
    + ` data-project="${esc(c.project || '')}"`
    + ` data-age="${c.age}"`
    + ` data-head="${headState(c)}" style="border-left-color:${color}">`
    + `<details class="fold" open><summary>${cardHead(c)}</summary>`
    + `<div class="tbody">`
    + (c.meta && c.meta.first_msg ? firstHtml(c) : '')
    + `<div class="tlist">` + c.tickets.map(tblockHtml).join('') + `</div>`
    + `<div class="foot"><input placeholder="备注(可选)" data-note>`
    + `<div class="actions">`
    + `<button class="ghost" onclick="declineCard('${esc(c.session)}')">`
    + `全部你来定</button>`
    + `<button class="primary" onclick="applyCard('${esc(c.session)}')">`
    + `Apply 本卡</button></div></div>`
    + `</div></details></div>`;
}
function pick(btn, id, qi, text) {
  const tb = btn.closest('.tblock');
  tb.querySelector(`textarea[data-key="${id}:${qi}"]`).value = text;
  syncMarks(tb);
}
let fails = 0;
let known = null;      // open-ticket ids seen by the previous poll (0029)
let flashTimer = null; // title flash until the tab regains focus
let unread = 0;        // NEW tickets that arrived unfocused: '(N)' in the tab
let flashOn = false;   // the ♪ blink half of the title
const baseTitle = document.title;
const favEl = document.getElementById('fav');
const favBase = favEl ? favEl.href : '';
// 0029: sound + title flash on NEW open tickets. System notifications
// are deliberately NOT used (user decision): the page itself is the
// alert surface. Audio can be autoplay-blocked until the tab has been
// interacted with once - the title flash is the gesture-free channel.
// The title also carries the unread count: '(N)' grows per NEW ticket
// while unfocused, and focusing the tab reads everything (N + ♪ clear).
// The favicon joins the alert (2026-11-10, user: the title alone is
// too gentle): setFavicon paints the count onto a red badge over the
// served R tile, so the tab strip itself carries a red dot; focus
// restores the plain R (tab = read, every surface at once).
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!chime.ctx) chime.ctx = new AC();
    chime.ctx.resume();
    const t0 = chime.ctx.currentTime;
    [880, 1174.66].forEach((f, i) => {
      const o = chime.ctx.createOscillator();
      const g = chime.ctx.createGain();
      o.frequency.value = f;
      o.connect(g); g.connect(chime.ctx.destination);
      const when = t0 + i * 0.16;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.3, when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
      o.start(when); o.stop(when + 0.16);
    });
  } catch (e) { /* blocked or missing: the flash carries the alert */ }
}
function setFavicon() {
  if (!favEl) return;
  if (unread < 1) { favEl.href = favBase; return; }
  const n = unread > 99 ? '99+' : String(unread);
  const fs = n.length > 2 ? 14 : (n.length > 1 ? 18 : 23);
  const y = n.length > 2 ? 24 : (n.length > 1 ? 25 : 27);
  const svg = atob(favBase.split(',')[1]).replace('</svg>',
    '<circle cx="45" cy="19" r="19" fill="#e5484d"/>'
    + '<text x="45" y="' + y + '" font-family="system-ui,sans-serif" '
    + 'font-size="' + fs + '" font-weight="700" fill="#fff" '
    + 'text-anchor="middle">' + n + '</text></svg>');
  favEl.href = 'data:image/svg+xml;base64,' + btoa(svg);
}
function paintTitle() {
  const pre = [];
  if (flashOn) pre.push('♪');
  if (unread > 0) pre.push('(' + unread + ')');
  document.title = pre.length ? pre.join(' ') + ' ' + baseTitle : baseTitle;
  setFavicon();
}
function stopFlash() {
  if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
  flashOn = false;
  unread = 0;  // focusing the tab reads every open ticket
  paintTitle();
}
function alertNew(fresh) {
  chime();
  if (!document.hasFocus()) unread += fresh;
  if (flashTimer) { paintTitle(); return; }
  flashOn = false;
  flashTimer = setInterval(() => {
    if (document.hasFocus()) { stopFlash(); return; }
    flashOn = !flashOn;
    paintTitle();
  }, 900);
  paintTitle();
}
window.addEventListener('focus', stopFlash);
async function refresh() {
  try {
    const r = await fetch('/api/state?token=' + encodeURIComponent(token));
    if (r.status === 401) {  // bad/missing token: say so, never loop
      fails = 2;
      document.getElementById('conn').classList.add('off');
      document.getElementById('connText').textContent =
        '令牌失效,请从带 token 的完整链接打开';
      return;
    }
    const s = await r.json();
    if (s.v && s.v !== PAGE_V) { location.reload(); return; }  // upgraded
    if (fails >= 2) {  // recovered: restore the status dot
      document.getElementById('conn').classList.remove('off');
    }
    fails = 0;
    document.getElementById('connText').textContent = '已连接';
    const cards = s.cards;
    const openIds = [];
    for (const c of cards) for (const t of c.tickets) openIds.push(t.id);
    if (known) {  // first paint only records; a reload must not chime
      const fresh = openIds.filter(id => !known.has(id)).length;
      if (fresh) alertNew(fresh);
    }
    known = new Set(openIds);
    document.getElementById('count').textContent =
      cards.length + ' 会话 · ' + cards.reduce((n, c) => n + c.count, 0) + ' 问';
    // 0046: page-level batch button - visible with 2+ cards (one card
    // is what the card's own Apply is for). TextContent-only updates:
    // the button holds no inputs, so the keyed reconcile below (which
    // never rebuilds live cards) stays untouched.
    const batch = document.getElementById('batch');
    batch.hidden = cards.length < 2;
    batch.textContent = '整页批阅 ' + cards.length + ' 卡';
    const list = document.getElementById('list');
    // Keyed reconcile, two levels (card by session, block by ticket):
    // never rebuild a live element - in-progress answers live in the
    // DOM, and a card's <details> keeps its fold state for free.
    const liveSes = new Set(cards.map(c => c.session));
    for (const el of [...list.querySelectorAll('.ticket')])
      if (!liveSes.has(el.dataset.session)) el.remove();
    // Groups (root sessions): create missing ones, drop emptied ones,
    // reorder containers only when the order really changed (moving a
    // focused node steals focus, so never touch an unchanged DOM).
    const groupTitle = new Map();
    for (const c of cards)
      if (!groupTitle.has(c.group)) groupTitle.set(c.group, c.group_title);
    const gEls = new Map([...list.querySelectorAll('.group')]
      .map(el => [el.dataset.root, el]));
    for (const [root, el] of gEls) if (!groupTitle.has(root)) el.remove();
    for (const [root, title] of groupTitle) {
      if (!gEls.has(root)) {
        list.insertAdjacentHTML('beforeend',
          `<div class="group" data-root="${esc(root)}"><div class="ghead">`
          + `<span class="gdot" style="background:${groupColor(root)}"></span>`
          + esc(title ? root.slice(-8) + ' · ' + title
                  : 'session ' + root.slice(-8))
          + `<span class="gcount"></span></div></div>`);
        gEls.set(root, list.lastElementChild);
      }
    }
    const want = [...groupTitle.keys()].join(',');
    const have = [...list.querySelectorAll('.group')]
      .map(el => el.dataset.root).join(',');
    if (want !== have) {
      for (const root of groupTitle.keys()) list.appendChild(gEls.get(root));
    }
    let msg = list.querySelector('.empty');
    if (!cards.length) {
      // No early return here (0041 acceptance finding): with an empty
      // ask queue the wiretap strip/section and both history sections
      // must still paint - the card pipeline below no-ops on [].
      if (!msg) list.insertAdjacentHTML('beforeend',
        '<div class="empty"><span class="big">&#128564;</span>'
        + '<span>暂无排队的问题</span>'
        + '<span class="hint">Agent 需要你裁决时,卡片会出现在这里 · 每 2 秒自动刷新</span></div>');
    } else if (msg) {
      msg.remove();
    }
    // Cards: created once per session, moved only when late metadata
    // regroups the session under another root.
    const bySes = new Map([...list.querySelectorAll('.ticket')]
      .map(el => [el.dataset.session, el]));
    for (const c of cards) {
      const gEl = gEls.get(c.group);
      const el = bySes.get(c.session);
      if (!el) {
        gEl.insertAdjacentHTML('beforeend', cardHtml(c, groupColor(c.group)));
        bySes.set(c.session, gEl.lastElementChild);
      } else if (el.parentElement !== gEl) {
        gEl.appendChild(el);
      }
    }
    // In-place updates - age, late titles, ticket set, numbering -
    // never touch inputs.
    for (const c of cards) {
      const el = bySes.get(c.session);
      if (el.dataset.age !== String(c.age)) {
        el.dataset.age = String(c.age);
        const age = el.querySelector('.age');
        age.textContent = '已等待 ' + c.age + 's';
        age.classList.toggle('slow', c.age >= 120);
      }
      const head = headState(c);
      if (el.dataset.head !== head) {
        el.dataset.head = head;
        el.querySelector('.fold>summary').innerHTML = cardHead(c);
        if (c.meta && c.meta.first_msg && !el.querySelector('details.first'))
          el.querySelector('.tbody').insertAdjacentHTML('afterbegin', firstHtml(c));
      }
      // Ticket blocks keyed by ticket id inside the card.
      const tlist = el.querySelector('.tlist');
      const live = new Set(c.tickets.map(t => t.id));
      for (const b of [...tlist.querySelectorAll('.tblock')])
        if (!live.has(b.dataset.id)) b.remove();
      for (const t of c.tickets)
        if (!tlist.querySelector(`.tblock[data-id="${t.id}"]`))
          tlist.insertAdjacentHTML('beforeend', tblockHtml(t));
      const wantIds = c.tickets.map(t => t.id).join(',');
      const haveIds = [...tlist.querySelectorAll('.tblock')]
        .map(b => b.dataset.id).join(',');
      if (wantIds !== haveIds)
        for (const t of c.tickets)
          tlist.appendChild(tlist.querySelector(`.tblock[data-id="${t.id}"]`));
      renumber(el);
    }
    for (const gEl of gEls.values()) {
      gEl.querySelector('.gcount').textContent =
        gEl.querySelectorAll('.ticket').length + ' 会话 · '
        + gEl.querySelectorAll('.tblock .q').length + ' 问';
    }
    // Wiretap (0041): ask cards stay on top; this paints below them.
    paintWire(s);
    // Q&A history (0023 user follow-up; 0034 C): asks that vanished
    // without a user answer - timed out (the agent fell back on its
    // own) or abandoned (the caller's tool call was killed) - stay
    // visible below the live cards. Rebuilt whole each cycle - it
    // holds no inputs, so the keyed-reconcile rule does not apply.
    // 0035: escalation rows died with the tool; only ask traces
    // remain, so every row is a no-answer row.
    const hist = s.resolved || [];
    document.getElementById('hist').hidden = !hist.length;
    if (hist.length) {
      document.getElementById('histbody').innerHTML = hist.map(r => {
        const label = r.status === 'timeout'
          ? '超时,agent 已按默认回退'
          : '调用方已断(' + esc(r.status) + ')';
        const sid = r.title
          ? esc(r.session.slice(-8)) + ' · ' + esc(r.title)
          : 'session ' + esc(r.session.slice(-8));
        return `<div class="hrow" data-project="${esc(r.project || '')}">`
          + `<div class="hq">${fmt(r.text)}</div>`
          + `<div class="ha st">${label}</div>`
          + `<div class="hm">${sid} · ${esc(r.status)}</div></div>`;
      }).join('');
    }
  } catch (e) {
    if (++fails >= 2) {
      document.getElementById('conn').classList.add('off');
      document.getElementById('connText').textContent = '连接中断,重试中';
    }
  }
}
// ---- wiretap (0041 variant A): sticky strip + group zones; the
// section never alerts (chime/flash stay ask-only), defaults
// collapsed, and rebuilds only when the payload actually changed so
// a two-step confirm cannot be wiped mid-arm by the 2s poll.
let wireOpen = false, wireSig = '';
function fmtAgo(sec) {
  if (sec == null) return '';
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.round(sec / 3600) + ' 小时前';
  return Math.round(sec / 86400) + ' 天前';
}
function fmtClock(ts) {
  const d = new Date(ts * 1000);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function armBtn(btn, fn) {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; fn(); return; }
  btn.dataset.armed = '1';
  btn.dataset.old = btn.textContent;
  btn.textContent = '确认' + btn.textContent + '?';
  btn.classList.add('armed');
  setTimeout(() => {
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.textContent = btn.dataset.old;
      btn.classList.remove('armed');
    }
  }, 4000);
}
async function wireClear(payload) {
  await post('/api/line/clear', payload);
  refresh();
}
function killBtn(name, group, count) {
  const label = group ? '关闭整组(' + count + ' 线)' : '拆线';
  return '<button class="linkbtn wire-kill" data-name="' + esc(name || '')
    + '" data-group="' + esc(group || '') + '">' + label + '</button>';
}
function msgRow(m) {
  const cls = ((m.state === 'pending' ? 'pending ' : '')
    + (m.kind === 'bounce' ? 'bounce' : '')).trim();
  const who = m.kind === 'bounce' ? '<span class="who">[relay]</span>'
    : '<span class="who">' + esc(m.from || m.from_session.slice(-8))
    + ' <span class="arr">→</span> ' + esc(m.to) + '</span>';
  return '<div class="mrow ' + cls + '"><span class="at">'
    + fmtClock(m.sent_at) + '</span>' + who
    + '<span class="txt">' + esc(m.text)
    + (m.state === 'pending' ? ' <span style="font-size:11px">未推</span>' : '')
    + '</span></div>';
}
function lineCardHtml(l, color) {
  const stale = l.attended_age != null && l.attended_age > 1800;
  const att = l.attended_age != null
    ? '已看 ' + fmtAgo(l.attended_age) : '新鲜度未知';
  const logRows = l.log.length ? l.log.map(msgRow).join('')
    : '<div class="ldesc">(暂无消息)</div>';
  return '<div class="ticket" style="border-left-color:' + color + '">'
    + '<details class="fold" open><summary><span class="meta">'
    + (l.project ? '<span class="pchip" title="' + esc(l.project) + '">'
      + esc(baseName(l.project)) + '</span>' : '')
    + '<span class="lname">' + esc(l.name) + '</span>'
    + '<span class="lstate ' + (l.busy ? 'busy' : 'idle') + '">'
    + (l.busy ? 'busy' : 'idle') + '</span>'
    + (l.owner_agent ? '<span class="agent">' + esc(l.owner_agent) + '</span>' : '')
    + '<span>·</span><span' + (stale ? ' class="stale"' : '')
    + ' title="last attended">' + att + '</span>'
    + (l.inflight ? '<span>·</span><span><b>' + l.inflight + '</b> 在途</span>' : '')
    + '</span><span class="chev">&#9662;</span></summary>'
    + '<div class="ldesc">' + esc(l.description || '') + '</div>'
    + '<details class="fold" open><summary><span class="meta"><span>消息 '
    + l.log.length + ' 条</span></span><span class="chev">&#9662;</span></summary>'
    + '<div class="msglog">' + logRows + '</div></details>'
    + '<div style="display:flex;align-items:center;gap:10px">'
    + '<span class="ldesc">owner ' + esc(l.owner.slice(-8)) + '</span>'
    + killBtn(l.name, '', 0) + '</div>'
    + '</details></div>';
}
function zoneHtml(g, lines, groups) {
  const color = g ? groupColor(g) : 'var(--muted)';
  const ls = lines.filter(l => g ? l.group === g : !l.group);
  if (!ls.length) return '';
  const founder = (groups[g] || {}).founder;
  const head = g
    ? '<span class="wa-gdot" style="background:' + color + '"></span>'
      + esc(g) + '<span class="wa-gmeta">founder '
      + esc(founder ? founder.slice(-8) : '?') + ' · ' + ls.length + ' 线</span>'
      + killBtn('', g, ls.length)
    : '<span class="wa-gdot" style="background:var(--muted)"></span>独立线'
      + '<span class="wa-gmeta">' + ls.length + ' 线</span>';
  return '<div class="wa-zone"><div class="wa-ghead">' + head + '</div>'
    + ls.map(l => lineCardHtml(l, color)).join('') + '</div>';
}
function dropRow(d) {
  const who = d.from_line || ('session ' + d.from_session.slice(-8));
  return '<div class="hrow"><div class="hq">投递失败 · ' + esc(who)
    + ' → ' + esc(d.to) + ' · 无处退</div><div class="lh-hm">'
    + fmtClock(d.ts) + ' · message.dropped · ' + esc(d.reason || '')
    + (d.project ? ' · ' + esc(baseName(d.project)) : '')
    + '</div></div>';
}
function paintLHist(rows, drops) {
  const ds = drops || [];
  document.getElementById('lhist').hidden = !(rows.length || ds.length);
  if (!rows.length && !ds.length) return;
  document.getElementById('lhistbody').innerHTML =
    (ds.length ? '<div class="lh-sub">投递失败(无处退信)</div>'
      + ds.map(dropRow).join('') : '')
    + rows.map(r => {
      const label = r.group
        ? '组 <b>' + esc(r.group) + '</b> · 线 <b>' + esc(r.name) + '</b>'
        : '线 <b>' + esc(r.name) + '</b>(独立)';
      return '<div class="hrow"><div class="hq">通话留痕 · ' + label
        + ' · ' + r.bounced + ' 退信 · ' + r.messages + ' 条生平</div>'
        + '<div class="lh-hm">line.close · actor ' + esc(r.actor)
        + ' · ' + esc(r.owner.slice(-8))
        + (r.project ? ' · ' + esc(baseName(r.project)) : '')
        + (r.reason ? ' · ' + esc(r.reason) : '') + '</div></div>';
    }).join('');
}
function paintWire(s) {
  const lines = s.lines || [];
  const groups = s.line_groups || {};
  paintLHist(s.line_history || [], s.line_drops || []);
  const strip = document.getElementById('wireStrip');
  const sec = document.getElementById('wire');
  if (!lines.length) { strip.hidden = true; sec.hidden = true; return; }
  const inflight = lines.reduce((n, l) => n + l.inflight, 0);
  const gnames = [...new Set(lines.map(l => l.group).filter(Boolean))];
  const indep = lines.filter(l => !l.group).length;
  const sum = gnames.length + ' 组' + (indep ? ' + ' + indep + ' 独立' : '')
    + ' · ' + lines.length + ' 线'
    + (inflight ? ' · <b>' + inflight + '</b> 在途' : '');
  // Signature = structural fields only (0041 acceptance finding):
  // attended_age ticks every second, so the whole-lines payload used
  // to change the signature EVERY poll - the section rebuilt each 2s,
  // wiping the two-step arm state mid-confirm. ages/agent chips now
  // refresh on the next structural change instead.
  const sig = JSON.stringify([lines.map(l => [l.name, l.group,
    l.description, l.owner, l.inflight, l.busy, l.log]), groups]);
  if (sig !== wireSig) {
    wireSig = sig;
    strip.innerHTML = '<span>' + sum + '</span><span class="exp">'
      + (wireOpen ? '收起 ▴' : '展开 ▾') + '</span>';
    sec.innerHTML = gnames.map(g => zoneHtml(g, lines, groups)).join('')
      + zoneHtml(null, lines, groups);
  }
  strip.hidden = false;
  sec.hidden = !wireOpen;
}
function renumber(card) {
  // Continuous question numbers across the card's tickets; the ticket
  // tag shows up only when the card holds more than one ticket.
  const blocks = [...card.querySelectorAll('.tlist .tblock')];
  let n = 0;
  blocks.forEach((b, i) => {
    if (blocks.length > 1) {
      if (!b.querySelector('.btag'))
        b.querySelector('.bhead')
          .insertAdjacentHTML('afterbegin', '<span class="btag"></span>');
      b.querySelector('.btag').textContent = '单 ' + (i + 1);
    }
    for (const qn of b.querySelectorAll('.qn')) qn.textContent = ++n;
  });
}
function cardSettlements(card) {
  // Settlements for one card, or null when a question is neither
  // answered nor ceded (0046: the page-level batch settles only
  // complete cards and holds the rest).
  const note = card.querySelector('[data-note]').value.trim();
  const settlements = [];
  for (const tb of card.querySelectorAll('.tblock')) {
    const tas = [...tb.querySelectorAll('textarea')];
    const declined = tas.flatMap(
      (t, i) => t.classList.contains('qdec') ? [i] : []);
    const answers = tas.map(t => t.value.trim());
    if (answers.some((a, i) => !a && !declined.includes(i))) return null;
    settlements.push({ticket: tb.dataset.id, action: 'answer',
      answers, declined, note});
  }
  return settlements;
}
async function applyCard(session) {
  const card = document.querySelector(`.ticket[data-session="${session}"]`);
  const settlements = cardSettlements(card);
  if (!settlements) {
    alert('还有未填写的回答;单问让出点该问的「你来定」,'
      + '整单让出点「这单你来定」');
    return;
  }
  if (settlements.length) await post('/api/apply', {settlements});
  refresh();
}
async function batchApply() {
  // 0046 L3: one click releases every COMPLETE card on the page -
  // attention cost O(1), the DESIGN §3.3 header Apply finally landed.
  // Incomplete cards hold: one lazy question must not block the other
  // agents, and only cards the user fully reviewed (every answer
  // filled or ceded) are released, so no second confirm is needed.
  // No page-level decline on purpose: mass-ceding without per-card
  // review is never offered (the per-card 全部你来定 stays the
  // ceiling for letting go).
  const ready = [], held = [];
  let readyCards = 0;
  for (const card of document.querySelectorAll('.ticket')) {
    const s = cardSettlements(card);
    if (s) { ready.push(...s); readyCards++; }
    else held.push(card.dataset.session);
  }
  if (!ready.length) {
    alert('没有填完的卡;缺答的卡保持排队');
    return;
  }
  const out = await post('/api/apply', {settlements: ready});
  const lost = Object.entries(out.results || {})
    .filter(([, ok]) => !ok).length;
  refresh();
  alert('整页批阅:放行 ' + readyCards + ' 卡'
    + (held.length ? ';缺答 ' + held.length + ' 卡保持排队' : '')
    + (lost ? ';' + lost + ' 单已超时' : ''));
}
async function declineCard(session) {
  const card = document.querySelector(`.ticket[data-session="${session}"]`);
  const note = card.querySelector('[data-note]').value.trim();
  const settlements = [...card.querySelectorAll('.tblock')]
    .map(tb => ({ticket: tb.dataset.id, action: 'decline', note}));
  if (settlements.length) await post('/api/apply', {settlements});
  refresh();
}
function toggleQd(btn, id, qi) {
  const ta = btn.closest('.tblock')
    .querySelector(`textarea[data-key="${id}:${qi}"]`);
  const on = btn.classList.toggle('on');
  btn.textContent = on ? '我来答' : '你来定';
  ta.classList.toggle('qdec', on);
  ta.disabled = on;
}
async function decline(id) {
  const tb = document.querySelector(`.tblock[data-id="${id}"]`);
  const note = tb.closest('.ticket').querySelector('[data-note]').value.trim();
  await post('/api/apply',
    {settlements: [{ticket: id, action: 'decline', note}]});
  refresh();
}
async function post(path, body) {
  const r = await fetch(path, {method: 'POST', headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token},
    body: JSON.stringify(body)});
  return r.json();
}
document.body.insertAdjacentHTML('beforeend',
  '<div class="viewer" id="viewer"><div class="vcard">'
  + '<div class="vhead"><span class="path" id="vpath"></span>'
  + '<span class="n" id="vlines"></span>'
  + '<button class="vclose" onclick="hideViewer()" title="Esc">&#215;</button></div>'
  + '<div class="vbody" id="vbody"></div></div></div>');
function hideViewer() { document.getElementById('viewer').classList.remove('on'); }
async function showFile(path, line, project) {
  const v = document.getElementById('viewer');
  v.classList.add('on');
  const body = document.getElementById('vbody');
  body.innerHTML = '<div class="verr">读取中…</div>';
  document.getElementById('vpath').textContent = path;
  try {
    // 0030: relative paths anchor at the card's checkout - one global
    // daemon serves every project, so the anchor travels per request.
    const r = await fetch('/api/file?token=' + encodeURIComponent(token)
      + '&path=' + encodeURIComponent(path)
      + (project ? '&project=' + encodeURIComponent(project) : '')
      + (line ? '&line=' + line : ''));
    const d = await r.json();
    if (!d.ok) {
      document.getElementById('vlines').textContent = '';
      body.innerHTML = '<div class="verr">' + esc(d.reason) + '</div>';
      return;
    }
    const srcUrl = '/file?token=' + encodeURIComponent(token)
      + '&path=' + encodeURIComponent(path)
      + (project ? '&project=' + encodeURIComponent(project) : '');
    let node = null;
    if (d.kind === 'md') node = renderDoc(d.text);
    else if (d.kind === 'svg') node = renderSvg(d.text);
    else if (d.kind === 'html') node = renderHtmlFrame(d.text, srcUrl);
    if (node) {
      document.getElementById('vlines').innerHTML =
        '已渲染 · <a href="' + srcUrl + '&mode=text"'
        + ' target="_blank" rel="noopener noreferrer">源码</a>';
      body.replaceChildren(node);
      body.scrollTop = 0;
      return;
    }
    // plain text (or the renderer is unavailable): numbered rows
    document.getElementById('vlines').textContent =
      d.text.split('\\n').length + ' 行';
    body.innerHTML = d.text.split('\\n').map((c, i) =>
      '<div class="row' + (line && i + 1 === +line ? ' marked' : '')
      + '" id="VL' + (i + 1) + '"><span class="ln">' + (i + 1)
      + '</span><span class="lc">' + (esc(c) || '&#160;') + '</span></div>').join('');
    const mk = body.querySelector('.row.marked');
    if (mk) mk.scrollIntoView({block: 'center'});
    else body.scrollTop = 0;
  } catch (e) {
    body.innerHTML = '<div class="verr">读取失败,请稍后重试</div>';
  }
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-path]');
  if (a) {  // paths open the viewer, never annotate their row
    e.preventDefault();
    // 0030: the owning card / history row carries the checkout.
    const card = a.closest('.ticket, .hrow');
    showFile(a.dataset.path, a.dataset.line || '',
      card ? card.dataset.project || '' : '');
    return;
  }
  const crow = e.target.closest('.crow');
  if (crow) openAnn(crow);
  if (e.target.id === 'viewer') hideViewer();  // backdrop click closes
});
document.addEventListener('input', e => {
  if (e.target.matches('.tblock textarea'))
    syncMarks(e.target.closest('.tblock'));  // marks follow content
});
document.getElementById('wireStrip').addEventListener('click', () => {
  // 0041: 默认折叠,展开体沉在人问卡之下;摘要条常驻。
  wireOpen = !wireOpen;
  const exp = document.querySelector('#wireStrip .exp');
  if (exp) exp.textContent = wireOpen ? '收起 ▴' : '展开 ▾';
  document.getElementById('wire').hidden = !wireOpen;
});
document.addEventListener('click', e => {
  const k = e.target.closest('.wire-kill');
  if (!k) return;
  armBtn(k, () => wireClear(k.dataset.group
    ? {group: k.dataset.group} : {name: k.dataset.name}));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideViewer(); });
refresh(); setInterval(refresh, 2000);
/*__VIEWER_JS__*/
</script></body></html>"""

PANEL_HTML = PANEL_HTML.replace('__PANEL_VERSION__', PANEL_VERSION)
PANEL_HTML = PANEL_HTML.replace('__FAVICON__', FAVICON_LINK)
PANEL_HTML = PANEL_HTML.replace('/*__VIEWER_CSS__*/', VIEWER_CSS)
PANEL_HTML = PANEL_HTML.replace('/*__VIEWER_JS__*/', VIEWER_JS)


# ---------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    state = None          # RelayState, set by serve()
    meta = None           # SessionMeta, set by serve()
    lines = None          # LineState, set by serve() (0036 effort)
    project_root = None   # Path, set by serve(); anchors relative paths
    token = ''
    shutdown_fn = None

    def _send(self, obj, status=200, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _raw(self, body: bytes, ctype: str, status=200, headers=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        # No cache anywhere (0041 acceptance finding): a cached panel
        # page runs stale JS; state must never be reused across polls.
        self.send_header('Cache-Control', 'no-cache')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _query_token(self) -> str:
        """The token as ``?token=...`` - the panel page's auth style:
        the served JS cannot set request headers on its fetch, so the
        browser tab always authenticates through the query. Machines
        send Authorization headers."""
        query = self.path.split('?', 1)[1] if '?' in self.path else ''
        for part in query.split('&'):
            if part.startswith('token='):
                return part[len('token='):]
        return ''

    def _authorized(self) -> bool:
        header = self.headers.get('Authorization', '')
        return self.token in (header.removeprefix('Bearer '),
                              self._query_token())

    def _panel_heartbeat_request(self) -> bool:
        """True when this /api/state GET is the panel page polling
        (0033). A machine client can share that endpoint with a
        Bearer header; a machine poll must not warm the panel
        liveness heartbeat, or 0029's auto-open never fires - the
        live regression this seam closed: a whole morning of tickets
        with zero browser launches, one ask_user timed out unseen
        (2026-11-12)."""
        return self._query_token() == self.token

    # ----------------------------------------------------------- MCP

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/mcp':
            return self._mcp_post()
        if path == '/api/apply':
            return self._panel_api()
        if path == '/api/line/clear':
            return self._line_clear()
        if path == '/admin/shutdown':
            return self._shutdown()
        self._send({'error': 'not found'}, 404)

    def _mcp_post(self):
        if not self._authorized():
            return self._send({'error': 'unauthorized'}, 401)
        length = int(self.headers.get('Content-Length', 0))
        try:
            msg = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self._send({'jsonrpc': '2.0', 'id': None, 'error': {
                'code': -32700, 'message': 'parse error'}}, 400)
        method = msg.get('method')
        if method == 'initialize':
            return self._send({
                'jsonrpc': '2.0', 'id': msg['id'], 'result': {
                    'protocolVersion': msg.get('params', {}).get(
                        'protocolVersion', '2025-06-18'),
                    'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'relay', 'version': '0.1.0'},
                    'instructions': INSTRUCTIONS,
                }})
        if method == 'tools/list':
            return self._send({'jsonrpc': '2.0', 'id': msg['id'],
                               'result': {'tools': TOOLS}})
        if method == 'tools/call':
            return self._tools_call(msg)
        if 'id' in msg:
            return self._send({'jsonrpc': '2.0', 'id': msg['id'], 'error': {
                'code': -32601, 'message': 'method not found: %s' % method}})
        self._send({}, 202)  # notification: nothing to answer

    def _tools_call(self, msg):
        params = msg.get('params', {})
        handler = {
            'ask_user': self._tool_ask_user,
            'open_line': self._tool_open_line,
            'send': self._tool_send,
            'close_line': self._tool_close_line,
            'close_group': self._tool_close_group,
            'list_lines': self._tool_list_lines,
        }.get(params.get('name'))
        if handler is None:
            return self._send({'jsonrpc': '2.0', 'id': msg['id'],
                               'error': {
                                   'code': -32602,
                                   'message': 'unknown tool: %s'
                                   % params.get('name')}})
        return handler(msg, params)

    @staticmethod
    def _session_of(params):
        return ((params.get('_meta') or {}).get(
            'ai.opencode/sessionID') or 'unknown')

    def _project_of(self):
        """0030: the checkout this MCP request came from. The plugin
        stamps it into its registration headers (ctx.location at
        setup time), so every tool call carries it. Empty when the
        caller has none (bare CLI runs, old installs) - tickets then
        stay projectless and anchor paths at the legacy default."""
        return self.headers.get('X-Relay-Project') or ''

    def _notify_panel(self):
        """0029: bring the panel to the user when a ticket lands.

        Best-effort by design: a notifier failure must never fail the
        ticket it announces."""
        try:
            maybe_open_panel(self.workspace, self.server.server_address[1],
                             self.token)
        except Exception:
            LOG.warning('panel auto-open failed', exc_info=True)

    def _tool_ask_user(self, msg, params):
        args = params.get('arguments') or {}
        questions = args.get('questions')
        if not isinstance(questions, list) or not questions:
            return self._send({'jsonrpc': '2.0', 'id': msg['id'],
                               'result': {
                                   'content': [{'type': 'text',
                                                'text': 'ask_user: '
                                                'questions must be a '
                                                'non-empty list'}],
                                   'isError': True}})
        session = self._session_of(params)
        # 0034 A: clamp agent-supplied timeouts to the user-response
        # floor (and reject non-integers here - ask_user previously
        # lacked this check, and a string timeout crashed the waiter
        # thread instead of answering the caller).
        timeout, terr = normalize_timeout(args.get('timeout_sec'),
                                          'ask_user')
        if terr:
            return self._send({'jsonrpc': '2.0', 'id': msg['id'],
                               'result': {
                                   'content': [{'type': 'text',
                                                'text': terr}],
                                   'isError': True}})
        ticket = self.state.ask(session, questions, timeout,
                                project=self._project_of())
        LOG.info('ask_user ticket=%s session=%s questions=%d '
                 'timeout=%s', ticket['id'], session, len(questions),
                 timeout)
        self._notify_panel()
        # Block until the user settles the ticket, the timeout fires,
        # or the calling agent disappears (killed tool call).
        outcome = _wait_for_ticket(ticket, self._client_gone)
        if ticket['status'] == 'open':
            self.state.settle(ticket['id'], outcome)
        text = answer_text(ticket)
        LOG.info('ask_user ticket=%s settled as %s', ticket['id'],
                 ticket['status'])
        return self._send({'jsonrpc': '2.0', 'id': msg['id'],
                           'result': {'content': [{'type': 'text',
                                                  'text': text}]}})

    # ------------------------------------------------- line tools

    def _result(self, msg, text):
        return self._send({'jsonrpc': '2.0', 'id': msg['id'],
                           'result': {'content': [
                               {'type': 'text', 'text': text}]}})

    def _err(self, msg, tool, text):
        return self._send({'jsonrpc': '2.0', 'id': msg['id'],
                           'result': {
                               'content': [{'type': 'text',
                                            'text': '%s: %s'
                                            % (tool, text)}],
                               'isError': True}})

    def _line_gate(self, msg, session, tool):
        """b-full (0042): reject non-primary callers, audit
        line.denied, answer the caller. True = rejected (caller
        already answered)."""
        ok, reason = primary_check(self.meta, session)
        if ok:
            return False
        self.lines._event('line.denied', session=session,
                          project=self._project_of(), tool=tool)
        self._err(msg, tool, reason)
        return True

    @staticmethod
    def _slug(value, field, tool):
        """(value, None) or (None, error) - the [a-z0-9-_]{1,32} slug
        both line and group names must match (0039/0040)."""
        if not isinstance(value, str) or not LINE_NAME_RE.match(value):
            return None, ('%s must match [a-z0-9-_]{1,32}' % field)
        return value, None

    def _tool_open_line(self, msg, params):
        session = self._session_of(params)
        if self._line_gate(msg, session, 'open_line'):
            return
        args = params.get('arguments') or {}
        name, err = self._slug(args.get('name') or '', 'name',
                               'open_line')
        if err:
            return self._err(msg, 'open_line', err)
        description = args.get('description') or ''
        if not isinstance(description, str):
            return self._err(msg, 'open_line',
                             'description must be a string')
        group = args.get('group') or None
        if group is not None:
            group, err = self._slug(group, 'group', 'open_line')
            if err:
                return self._err(msg, 'open_line', err)
        _, err = self.lines.open_line(session, self._project_of(),
                                      name, description, group)
        if err:
            return self._err(msg, 'open_line', err)
        return self._result(msg, self.lines.directory_text())

    def _tool_send(self, msg, params):
        session = self._session_of(params)
        if self._line_gate(msg, session, 'send'):
            return
        args = params.get('arguments') or {}
        to, err = self._slug(args.get('to') or '', 'to', 'send')
        if err:
            return self._err(msg, 'send', err)
        text = args.get('text') or ''
        if not isinstance(text, str) or not text.strip():
            return self._err(msg, 'send',
                             'text must be a non-empty string')
        summary = self.lines.send(session, self._project_of(), to,
                                  text)
        LOG.info('send session=%s to=%s', session, to)
        return self._result(msg, summary)

    def _tool_close_line(self, msg, params):
        session = self._session_of(params)
        if self._line_gate(msg, session, 'close_line'):
            return
        name = self.lines.owned_name(session)
        if not name:
            return self._err(msg, 'close_line',
                             'you have no open line')
        trace = self.lines.close_line(name, actor='owner')
        LOG.info('close_line session=%s line=%s bounced=%d',
                 session, name, trace['bounced'])
        return self._result(msg, 'closed %s; %d message(s) bounced'
                            % (name, trace['bounced']))

    def _tool_close_group(self, msg, params):
        session = self._session_of(params)
        if self._line_gate(msg, session, 'close_group'):
            return
        args = params.get('arguments') or {}
        group, err = self._slug(args.get('group') or '', 'group',
                                'close_group')
        if err:
            return self._err(msg, 'close_group', err)
        founder = self.lines.group_founder(group)
        if founder is None:
            return self._err(msg, 'close_group',
                             "unknown group '%s'" % group)
        if founder != session:
            return self._err(msg, 'close_group',
                             "only the founder (session %s) can close "
                             "group '%s'" % (founder[-8:], group))
        traces = self.lines.close_group(group, actor='founder')
        bounced = sum(t['bounced'] for t in traces)
        LOG.info('close_group session=%s group=%s lines=%d',
                 session, group, len(traces))
        return self._result(
            msg, 'closed %d line(s): %s; %d message(s) bounced'
            % (len(traces), ', '.join(t['name'] for t in traces),
               bounced))

    def _tool_list_lines(self, msg, params):
        session = self._session_of(params)
        if self._line_gate(msg, session, 'list_lines'):
            return
        return self._result(msg, self.lines.directory_text())

    def _client_gone(self) -> bool:
        """True when the MCP client disconnected while we block. EOF
        (empty peek) or a dead socket both count; a pipelined request
        (readable with data) does not."""
        conn = self.connection
        try:
            ready, _, _ = select.select([conn], [], [], 0)
            if not ready:
                return False
            return conn.recv(1, socket.MSG_PEEK) == b''
        except (OSError, ValueError):
            return True

    # ---------------------------------------------------------- panel

    def _panel_api(self):
        """Card-level Apply: one POST settles a whole batch of tickets
        (all answers of a session's card, plus per-ticket declines)."""
        if not self._authorized():
            return self._send({'error': 'unauthorized'}, 401)
        length = int(self.headers.get('Content-Length', 0))
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self._send({'error': 'bad request'}, 400)
        settlements = body.get('settlements')
        if not isinstance(settlements, list) or not settlements:
            return self._send({'error': 'bad request'}, 400)
        return self._send({'ok': True,
                           'results': self.state.apply_settlements(
                               settlements)})

    def _line_clear(self):
        """Panel teardown (0041): 拆线 / 关闭整组, actor=panel."""
        if not self._authorized():
            return self._send({'error': 'unauthorized'}, 401)
        length = int(self.headers.get('Content-Length', 0))
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self._send({'error': 'bad request'}, 400)
        name = body.get('name') or ''
        group = body.get('group') or ''
        if not name and not group:
            return self._send({'error': 'bad request'}, 400)
        traces = self.lines.clear_panel(name=name or None,
                                        group=group or None)
        LOG.info('line_clear name=%s group=%s lines=%d',
                 name, group, len(traces))
        return self._send({'ok': True,
                           'closed': [t['name'] for t in traces
                                      if t],
                           'bounced': sum(t['bounced'] for t in traces
                                          if t)})

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            return self._raw(PANEL_HTML.encode('utf-8'),
                             'text/html; charset=utf-8')
        if path == '/vendor/marked.js':
            # Public library bytes, identical to the CDN copy; no token gate - they carry no project information.
            js = load_vendor_js()
            if js is None:
                return self._empty(404)
            return self._raw(js.encode('utf-8'),
                             'text/javascript; charset=utf-8')
        if path == '/file':
            return self._file_view()
        if path == '/api/file':
            return self._file_api()
        if path == '/api/state':
            if not self._authorized():
                return self._send({'error': 'unauthorized'}, 401)
            # 0033: only the panel page's own poll warms the liveness
            # heartbeat - machine clients poll here with a header.
            if self._panel_heartbeat_request():
                write_panel_poll(self.workspace)
            tickets = self.state.open_tickets()
            resolved = self.state.resolved_history()
            # History rows show titles too (0025): their sessions
            # join the meta lookup, capped by the history snapshot.
            sessions = ({t['session'] for t in tickets}
                        | {r['session'] for r in resolved})
            # 0041 wiretap: line owners join too (freshness chips,
            # owner labels) - the snapshot carries what is cached.
            lines_snap = self.lines.snapshot() if self.lines else {
                'lines': [], 'groups': {}, 'history': [], 'drops': []}
            sessions |= {l['owner'] for l in lines_snap['lines']}
            # Refresh runs on a background thread; this response carries
            # whatever is cached (maybe the sessionID-tail fallback).
            self.meta.refresh_async(sessions)
            snap = self.meta.snapshot(sessions)
            lines_out = []
            for l in lines_snap['lines']:
                m = snap.get(l['owner']) or {}
                t = m.get('time') or {}
                viewed, busy = t.get('viewed') or 0, t.get('busy') or 0
                row = dict(l)
                row['owner_agent'] = m.get('agent') or ''
                row['owner_title'] = m.get('title') or ''
                row['attended_age'] = (
                    int((time.time() * 1000 - max(viewed, busy)) / 1000)
                    if max(viewed, busy) else None)
                row['busy'] = bool(busy and busy > viewed)
                lines_out.append(row)
            return self._send({
                'v': PANEL_VERSION,
                'cards': merge_session_cards(
                    enrich_tickets(tickets, snap)),
                'resolved': enrich_resolved(resolved, snap),
                'lines': lines_out,
                'line_groups': lines_snap['groups'],
                'line_history': lines_snap['history'],
                'line_drops': lines_snap['drops']})
        if path == '/health':
            return self._send({'ok': True})
        self._empty(404)

    def do_DELETE(self):
        self._empty(200)  # MCP session termination: accept silently

    def _empty(self, status):
        self.send_response(status)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _resolve_file(self, raw, project=''):
        """Shared /file lookup: (Path, None) or (None, reason).

        0030: relative paths anchor at the requesting ticket's project
        (the ``project`` query param, sent by the panel from the card)
        so one global daemon can serve every checkout; absolute paths
        never needed an anchor. Empty project = legacy default."""
        anchor = Path(project) if project else self.project_root
        p = resolve_view_path(raw, anchor)
        if p is None:
            return None, '文件不存在,或不是普通文件'
        if read_view_file(p) is None:
            return None, '无法读取:超过 %d KB 或二进制文件' % (FILE_CAP // 1024)
        return p, None

    def _file_api(self):
        """JSON variant powering the in-panel viewer overlay."""
        if not self._authorized():
            return self._send({'error': 'unauthorized'}, 401)
        query = self.path.split('?', 1)[1] if '?' in self.path else ''
        params = dict(part.split('=', 1) for part in query.split('&')
                      if '=' in part)
        raw = unquote(params.get('path', ''))
        p, reason = self._resolve_file(raw, unquote(params.get(
            'project', '')))
        if reason is not None:
            return self._send({'ok': False, 'reason': reason})
        self._send({'ok': True, 'path': raw,
                    'kind': view_kind(p),
                    'text': read_view_file(p)})

    def _file_view(self):
        """Standalone read-only page (middle-click / direct URLs)."""
        if not self._authorized():
            return self._send({'error': 'unauthorized'}, 401)
        query = self.path.split('?', 1)[1] if '?' in self.path else ''
        params = dict(part.split('=', 1) for part in query.split('&')
                      if '=' in part)
        raw = unquote(params.get('path', ''))
        line = unquote(params.get('line', ''))
        mode = unquote(params.get('mode', ''))
        p, reason = self._resolve_file(raw, unquote(params.get(
            'project', '')))
        if reason is not None:
            page = ('<!doctype html><html lang="zh"><head><meta charset="utf-8">'
                    '<title>relay /file</title>__FAVICON__</head><body style="font-family:'
                    'system-ui,sans-serif;padding:32px;color:#333;font-size:14px">'
                    '<b style="color:#b42318">%s</b><p style="color:#667085;'
                    'word-break:break-all">%s</p>'
                    '<span style="color:#667085;font-size:12px">可直接关闭本页</span>'
                    '</body></html>'
                    % (reason, html.escape(raw))).replace(
                        '__FAVICON__', FAVICON_LINK)
            return self._raw(page.encode('utf-8'),
                             'text/html; charset=utf-8', 404)
        body, ctype, extra = file_view_response(p, raw, line, mode)
        self._raw(body, ctype, headers=extra)

    def _shutdown(self):
        if not self._authorized():
            return self._send({'error': 'unauthorized'}, 401)
        length = int(self.headers.get('Content-Length', 0) or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            body = {}
        force = bool(body.get('force'))
        # Reply first, then drain: while we wait the server keeps
        # serving, so the panel can still settle tickets inside the
        # window (0019 cut C). Bounded - a zombie ticket delays a
        # redeploy by at most DRAIN_MAX_SEC; --force skips entirely.
        self._send({'ok': True,
                    'drain_sec': 0 if force else DRAIN_MAX_SEC})

        def stop():
            if not force:
                cleared = _drain_open_tickets(self.state, DRAIN_MAX_SEC)
                if not cleared:
                    with self.state.lock:
                        stuck = sum(
                            1 for t in self.state.tickets.values()
                            if t['status'] == 'open'
                            and not t.get('restored'))
                    LOG.warning(
                        'shutdown: %d ticket(s) still open after %.0fs '
                        'drain; persisted to pending.json, stopping '
                        'anyway', stuck, DRAIN_MAX_SEC)
            self.shutdown_fn()

        threading.Thread(target=stop, daemon=True).start()

    def log_message(self, *args):
        pass  # quiet; structured logs go to server.log


class QuietHTTPServer(ThreadingHTTPServer):
    """Downgrades client-disconnect tracebacks in server.log to one line
    (issue 0020 drive-by); real errors still log with a traceback.

    ``allow_reuse_address`` comes from the central policy (IR-1 rule 1):
    off on Windows — a reuse listen socket is exactly what let a second
    daemon double-bind 8791 (issue 0022) — and on for POSIX restarts
    over TIME_WAIT."""

    daemon_threads = True
    allow_reuse_address = LISTEN_REUSE_ADDRESS

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError)):
            LOG.info('client %s disconnected mid-response', client_address)
            return
        LOG.warning('handler error (client %s)', client_address,
                    exc_info=True)


# ---------------------------------------------------------------- main

def ensure_workspace(workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    ignore = workspace / '.gitignore'
    if not ignore.exists():
        try:
            ignore.write_text('*\n', encoding='utf-8')
        except OSError:
            pass


def read_token(workspace: Path) -> str:
    """Read-only token lookup for paths that must not (re)generate it."""
    token_file = workspace / 'token'
    try:
        return token_file.read_text(encoding='utf-8').strip()
    except OSError:
        return ''


def port_answers_state(port: int, timeout: float = 1.0) -> bool:
    """Return True when some HTTP server already answers on ``port``.

    The post-claim self-check (issue 0022), run *before* binding our own
    listener: any HTTP answer on ``/api/state`` — 401 from a foreign
    daemon (no shared token), or even 200 from an earlier instance of
    ourselves — means the port is spoken for and ``serve()`` must yield
    and rescan. Only a refused/timed-out connection reads as free. The
    probe must happen pre-bind: after our own ``listen()`` the kernel
    backlog would swallow the request and nothing answers until
    ``serve_forever`` runs, so a post-bind check could only ever hang.
    A connection that resets or a responder speaking non-HTTP also maps
    to "not ours to take" — the scan has already refused such ports, so
    those paths are last-resort defensiveness.
    """
    req = urllib.request.Request(
        'http://127.0.0.1:%d/api/state' % port, method='GET')
    try:
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except urllib.error.HTTPError:
        return True  # an HTTP response arrived: someone owns the port
    except http.client.HTTPException:
        return True  # broken/non-HTTP speaker: still not ours to take
    except OSError:
        return False  # refused or unreachable: nobody is listening


def serve(args) -> int:
    workspace = Path(args.workspace).resolve()
    ensure_workspace(workspace)
    lock_file = workspace / 'lock.json'

    existing = read_lock(lock_file)
    if existing and process_alive(existing.get('pid', 0)):
        port = existing.get('port', PREFERRED_PORT)
        print('[relay] already running at http://127.0.0.1:%d (pid %s)'
              % (port, existing.get('pid')), flush=True)
        if args.open and not panel_is_alive(workspace):
            # idempotent: show the panel, but never stack duplicate
            # tabs when one is already polling
            open_preview_browser(
                'http://127.0.0.1:%d/?token=%s' % (port, read_token(workspace)),
                LOG)
        return 0

    port = find_free_port(args.port or PREFERRED_PORT)
    # Stable per-workspace token: survives daemon restarts, so the
    # Authorization header configured in opencode.json keeps working.
    token_file = workspace / 'token'
    token = token_file.read_text(encoding='utf-8').strip() \
        if token_file.exists() else secrets.token_hex(16)
    try:
        token_file.write_text(token + '\n', encoding='utf-8')
    except OSError:
        pass
    if claim_lock(lock_file, port) is not None:
        print('[relay] another live process holds the lock', flush=True)
        return 1

    state = RelayState(workspace)
    restored = state.restore_pending()
    if restored:
        print('[relay] restored %d ticket(s) from pending.json '
              '(badged 重启前 in the panel)' % len(restored), flush=True)
    lines = LineState(workspace, state)
    restored_lines = lines.restore()
    if restored_lines:
        print('[relay] restored %d line(s) from lines.json'
              % restored_lines, flush=True)
    Handler.state = state
    Handler.lines = lines
    Handler.token = token
    Handler.meta = SessionMeta()
    # 0030: the real workspace (an explicit --workspace no longer
    # lives under project_root) - the poll heartbeat and the panel
    # notifier must never re-derive it.
    Handler.workspace = workspace
    Handler.project_root = workspace.parent

    # Claim, then prove the port is really ours before listening
    # (issue 0022). Three layers, in order: the scan probes with a
    # plain bind so occupied ports are skipped; the listen socket
    # follows LISTEN_REUSE_ADDRESS so a contested bind fails loudly;
    # and this self-check is the last layer — anything already
    # answering /api/state on the port makes us yield and rescan from
    # the next port rather than double-serve into a split-brain.
    httpd = None
    for _ in range(PORT_BIND_ATTEMPTS):
        # Stamp the current candidate port into the lock before
        # serving anything.
        lock_file.write_text(json.dumps(
            {'pid': os.getpid(), 'port': port}),
            encoding='utf-8')
        if port_answers_state(port):
            print('[relay] port %d already answers another server; '
                  'yielding' % port, flush=True)
        else:
            try:
                httpd = QuietHTTPServer(('127.0.0.1', port), Handler)
                break
            except OSError as exc:
                print('[relay] bind 127.0.0.1:%d failed (%s); rescanning'
                      % (port, exc), flush=True)
        try:
            port = find_free_port(port + 1)
        except RuntimeError:
            break
    if httpd is None:
        release_lock(lock_file)
        print('[relay] could not secure a free port near %d'
              % (args.port or PREFERRED_PORT), flush=True)
        return 1

    def delayed_shutdown():
        time.sleep(0.2)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    # staticmethod: a bare function on a class attribute would come back
    # through ``self.`` as a bound method and gain a spurious ``self``
    # argument when the thread calls it (bit us once - see issues/).
    Handler.shutdown_fn = staticmethod(delayed_shutdown)

    threading.Thread(target=_sweep_loop, args=(state, lines),
                     daemon=True).start()
    # 0040 three no-loss: a restart re-pushes what the previous run
    # could not deliver (pushed messages never re-send - their state
    # rode lines.json).
    threading.Thread(target=_repush_after_start, args=(lines,),
                     daemon=True).start()

    panel_url = 'http://127.0.0.1:%d/?token=%s' % (port, token)
    print('[relay] mcp:   http://127.0.0.1:%d/mcp' % port, flush=True)
    print('[relay] panel: %s' % panel_url, flush=True)
    print('[relay] opencode header: "Authorization": "Bearer %s"' % token,
          flush=True)
    if args.open:
        open_preview_browser(panel_url, LOG)
    try:
        httpd.serve_forever()
    finally:
        release_lock(lock_file)
        print('[relay] stopped', flush=True)
    return 0


def _sweep_loop(state: RelayState, lines: LineState):
    while True:
        time.sleep(TICKET_TIMEOUT_SWEEP)
        state.sweep_timeouts()
        lines.repush_pending()  # 0038: never silently drop a message


def _repush_after_start(lines: LineState):
    time.sleep(0.5)
    lines.repush_pending()


def shutdown_daemon(args) -> int:
    workspace = Path(args.workspace).resolve()
    lock = read_lock(workspace / 'lock.json')
    if not lock:
        print('[relay] no lock file; not running?', flush=True)
        return 1
    token_file = workspace / 'token'
    token = token_file.read_text(encoding='utf-8').strip() \
        if token_file.exists() else str(lock.get('token', ''))
    req = urllib.request.Request(
        'http://127.0.0.1:%d/admin/shutdown' % lock.get('port'),
        method='POST',
        headers={'Authorization': 'Bearer %s' % token},
        data=json.dumps({'force': bool(getattr(args, 'force', False))})
             .encode('utf-8'))
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print('[relay] shutdown: HTTP %d' % resp.status, flush=True)
    except OSError as exc:
        print('[relay] shutdown failed: %s' % exc, flush=True)
        return 1
    # HTTP 200 only asks the server to stop; it may drain live tickets
    # for up to DRAIN_MAX_SEC first. Wait until the process is really
    # gone so an immediately following --daemon does not see a
    # live-looking lock, bail out with "already running", and leave
    # nothing listening (race seen once during the 0020 redeploy).
    pid = lock.get('pid', 0)
    deadline = time.time() + DRAIN_MAX_SEC + 5
    while process_alive(pid) and time.time() < deadline:
        time.sleep(0.2)
    if process_alive(pid):
        print('[relay] shutdown: still alive after %.0fs; a client may '
              'be stuck - check .relay/server.log before restarting'
              % (DRAIN_MAX_SEC + 5), flush=True)
        return 1
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='relay')
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--workspace',
                        default=str(Path.cwd() / WORKSPACE_NAME),
                        help='state dir (lock/token/audit/log); the '
                        'global install passes ~/.relay here')
    parser.add_argument('--daemon', action='store_true',
                        help='run detached in the background')
    parser.add_argument('--open', action='store_true',
                        help='open the panel in the browser')
    parser.add_argument('--shutdown', action='store_true')
    parser.add_argument('--force', action='store_true',
                        help='with --shutdown: skip the bounded drain')
    args = parser.parse_args(argv)

    if args.shutdown:
        return shutdown_daemon(args)

    if args.daemon:
        workspace = Path(args.workspace).resolve()
        ensure_workspace(workspace)
        log_path = workspace / 'server.log'
        log_file = open(log_path, 'a', encoding='utf-8')
        logging.basicConfig(
            stream=log_file, level=logging.INFO,
            format='[%(asctime)s] [%(levelname)s] relay: %(message)s')
        popen_detached(
            [sys.executable, Path(__file__).resolve()],
            logger=LOG,
            stdout=log_file, stderr=log_file,
            cwd=str(workspace.parent),
        )
        time.sleep(0.5)  # let the child claim its lock
        lock = read_lock(workspace / 'lock.json')
        if lock and process_alive(lock.get('pid', 0)):
            print('[relay] started in background: http://127.0.0.1:%d'
                  % lock.get('port'), flush=True)
            # --open is honored here: the detached child never gets the
            # flag (popen_detached re-invokes this file bare), so the
            # parent opens the panel once the child holds the lock -
            # unless a tab is already polling (no duplicate tabs).
            if args.open:
                if panel_is_alive(workspace):
                    print('[relay] panel already open (polled recently);'
                          ' not opening another tab', flush=True)
                else:
                    open_preview_browser(
                        'http://127.0.0.1:%d/?token=%s'
                        % (lock.get('port'), read_token(workspace)), LOG)
        else:
            print('[relay] background start failed; see %s' % log_path,
                  flush=True)
            return 1
        return 0

    logging.basicConfig(
        level=logging.INFO,
        format='[%(asctime)s] [%(levelname)s] relay: %(message)s')
    return serve(args)


if __name__ == '__main__':
    raise SystemExit(main())
