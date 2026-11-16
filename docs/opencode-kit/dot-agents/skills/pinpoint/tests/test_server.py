"""Tests for server.py - the Flask annotation editor backend.

Adapted from ppt-master's svg_editor/server.py request semantics:
staged in-memory annotations and direct text edits, Apply (save-all) as the
only disk write, audit JSONL history, path traversal guards, Host/Origin
checks.

Since 0013 the truth source is the markdown master (docs/<name>.md):
GET serves a freshly rendered projection (cached by master content hash,
never written to disk), legacy docs/<name>.html migrate on first open
(master created, HTML archived), and Apply writes markers / block text
back into the master plus the consume baseline snapshot.
"""

import json
import time
from pathlib import Path

import pytest

import master
import migrate
from annotations import parse_doc_text, parse_annotations
from server import create_app, idle_stop_decision, _has_staged_work


DOC = """<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>review</title></head><body>
<h1 id="_pp_0" data-edit-target="true" data-edit-annotation="existing note">Title</h1>
<p>First para.</p>
<p>Second para.</p>
</body></html>
"""

CLEAN_DOC = """<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>empty</title></head><body>
<p>Nothing marked.</p>
</body></html>
"""


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    docs = tmp_path / 'docs'
    docs.mkdir()
    (tmp_path / 'assets').mkdir()
    (docs / 'review.html').write_text(DOC, encoding='utf-8')
    (docs / 'empty.html').write_text(CLEAN_DOC, encoding='utf-8')
    return tmp_path


@pytest.fixture
def client(workspace: Path):
    app = create_app(workspace, idle_timeout=0)
    app.config['TESTING'] = True
    app.config['SHUTDOWN_DELAY'] = 0.01
    exits: list = []
    app.config['EXIT_HOOK'] = lambda code=0: exits.append(code)
    with app.test_client() as c:
        yield c, exits, app


class TestBasicRoutes:
    def test_health(self, client, workspace):
        c, _, _ = client
        resp = c.get('/api/health')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'ok'
        assert data['service'] == 'pinpoint'
        assert data['workspace'] == str(workspace.resolve())
        assert data['docs'] == 2

    def test_docs_list_counts_disk_annotations(self, client):
        c, _, _ = client
        data = c.get('/api/docs').get_json()
        names = {d['name']: d for d in data['docs']}
        assert names['review.html']['annotation_count'] == 1
        assert names['review.html']['annotated'] is True
        assert names['empty.html']['annotation_count'] == 0
        assert names['empty.html']['ok'] is True

    def test_get_doc_assigns_temp_ids_and_lists_disk_annotations(self, client):
        c, _, _ = client
        resp = c.get('/api/doc/review.html')
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'id="_pp_' in data['content']
        assert data['content'].index('<h1') < data['content'].index('<p')
        anns = {a['element_id']: a for a in data['annotations']}
        assert anns['_pp_0']['annotation'] == 'existing note'
        assert data['undo_depth'] == 0

    def test_get_missing_doc_404(self, client):
        c, _, _ = client
        assert c.get('/api/doc/nope.html').status_code == 404

    def test_index_served(self, client):
        c, _, _ = client
        resp = c.get('/')
        assert resp.status_code == 200

    def test_static_not_cached(self, client):
        c, _, _ = client
        resp = c.get('/static/app.js')
        assert resp.status_code == 200
        assert resp.headers['Cache-Control'] == 'no-cache'


class TestAnnotate:
    def test_stage_annotation(self, client):
        c, _, _ = client
        resp = c.post('/api/doc/review.html/annotate',
                      json={'element_id': '_pp_1', 'annotation': 'new note'})
        assert resp.status_code == 200
        data = c.get('/api/doc/review.html').get_json()
        anns = {a['element_id']: a for a in data['annotations']}
        assert anns['_pp_1']['annotation'] == 'new note'
        assert anns['_pp_0']['annotation'] == 'existing note'

    def test_validation_errors(self, client):
        c, _, _ = client
        assert c.post('/api/doc/review.html/annotate', json={}).status_code == 400
        assert c.post('/api/doc/review.html/annotate',
                      json={'element_id': 1, 'annotation': 'x'}).status_code == 400
        long_note = 'x' * 10001
        assert c.post('/api/doc/review.html/annotate',
                      json={'element_id': '_pp_1', 'annotation': long_note}).status_code == 400

    def test_delete_staged_annotation(self, client):
        c, _, _ = client
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'temp'})
        resp = c.delete('/api/doc/review.html/annotate/_pp_1')
        assert resp.status_code == 200
        ids = [a['element_id'] for a in c.get('/api/doc/review.html').get_json()['annotations']]
        assert '_pp_1' not in ids

    def test_delete_disk_annotation_via_stage(self, client):
        # Deleting a disk-loaded annotation stages an empty snapshot on save.
        c, _, _ = client
        resp = c.delete('/api/doc/review.html/annotate/_pp_0')
        assert resp.status_code == 200
        ids = [a['element_id'] for a in c.get('/api/doc/review.html').get_json()['annotations']]
        assert '_pp_0' not in ids

    def test_delete_unknown_annotation_404(self, client):
        c, _, _ = client
        assert c.delete('/api/doc/review.html/annotate/_pp_9').status_code == 404


class TestDiagramDocs:
    DIAGRAM_DOC = """<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>flow</title></head><body>
<p>Architecture overview.</p>
<figure class="pp-diagram" data-lang="mermaid"><div class="line">flowchart LR</div><div class="line">client --&gt; gateway</div><div class="line">gateway --&gt; db</div></figure>
</body></html>
"""

    def test_diagram_lines_addressable_and_annotatable(self, client, workspace):
        c, _, _ = client
        (workspace / 'docs' / 'flow.html').write_text(self.DIAGRAM_DOC, encoding='utf-8')
        data = c.get('/api/doc/flow.html').get_json()
        assert 'pp-diagram' in data['content']
        # Document order: _pp_0 = p, _pp_1 = figure, _pp_2.. = source lines.
        assert 'id="_pp_2"' in data['content']
        resp = c.post('/api/doc/flow.html/annotate',
                      json={'element_id': '_pp_3', 'annotation': 'rename gateway to edge'})
        assert resp.status_code == 200
        assert c.post('/api/save-all').status_code == 200
        # Apply writes the line marker above the mermaid fence in the
        # master; the old HTML is archived.
        master_text = (workspace / 'docs' / 'flow.md').read_text(encoding='utf-8')
        assert '<!-- pp@2: rename gateway to edge -->' in master_text
        doc = master.parse_master(master_text)
        fence = [mb for mb in doc if mb.block.kind == 'code'][0]
        assert fence.block.lines[1] == 'client --> gateway'
        assert fence.markers == [master.Marker('line', 2, 'rename gateway to edge')]

    def test_diagram_line_direct_edit(self, client, workspace):
        c, _, _ = client
        (workspace / 'docs' / 'flow.html').write_text(self.DIAGRAM_DOC, encoding='utf-8')
        resp = c.post('/api/doc/flow.html/edit',
                      json={'element_id': '_pp_3', 'text': 'client --> edge'})
        assert resp.status_code == 200
        data = c.get('/api/doc/flow.html').get_json()
        assert 'client --&gt; edge' in data['content']


class TestIdleStopDecision:
    """Pure decision logic behind the idle watchdog."""

    def test_staged_work_vetoes_stop(self):
        assert idle_stop_decision(10_000, 900, True, False) == (False, False)
        assert idle_stop_decision(10_000, 900, True, True) == (False, False)

    def test_requires_two_consecutive_over_time_ticks(self):
        # First over-time tick: grace only (a just-woken tab may heartbeat).
        assert idle_stop_decision(1000, 900, False, False) == (False, True)
        # Second consecutive tick: stop.
        assert idle_stop_decision(1000, 900, False, True) == (True, True)

    def test_within_timeout_never_stops(self):
        assert idle_stop_decision(899, 900, False, False) == (False, False)
        # Recent activity resets the consecutive counter.
        assert idle_stop_decision(100, 900, False, True) == (False, False)

    def test_zero_timeout_disabled_by_caller(self):
        # create_app skips the watchdog thread for timeout<=0; the decision
        # helper stays honest: anything over 0s is over-time.
        assert idle_stop_decision(1, 0, False, True) == (True, True)


class TestHasStagedWork:
    def test_clean_state_is_false(self, client):
        _, _, app = client
        assert _has_staged_work(app) is False

    def test_staged_annotation_snapshot_counts(self, client):
        _, _, app = client
        app.config['ANNOTATIONS']['review.html'] = {}
        assert _has_staged_work(app) is True  # even empty: pending deletion

    def test_pending_edits_count(self, client):
        _, _, app = client
        app.config['PENDING_EDITS']['review.html'] = [
            {'element_id': '_pp_1', 'text': 'x', 'old': 'y'},
        ]
        assert _has_staged_work(app) is True

    def test_heartbeat_endpoint_resets_activity(self, client):
        c, _, app = client
        before = app.config['LAST_REQUEST_TIME']
        assert c.get('/api/health').status_code == 200
        assert app.config['LAST_REQUEST_TIME'] >= before


class TestDirectEdit:
    def test_stage_text_edit_shows_in_preview(self, client):
        c, _, _ = client
        resp = c.post('/api/doc/review.html/edit',
                      json={'element_id': '_pp_1', 'text': 'Replaced.'})
        assert resp.status_code == 200
        data = c.get('/api/doc/review.html').get_json()
        assert 'Replaced.' in data['content']
        assert data['undo_depth'] == 1

    def test_edit_refuses_element_with_children(self, client):
        c, _, _ = client
        resp = c.post('/api/doc/empty.html/edit',
                      json={'element_id': 'nope', 'text': 'x'})
        assert resp.status_code == 400

    def test_edit_validation(self, client):
        c, _, _ = client
        assert c.post('/api/doc/review.html/edit', json={}).status_code == 400
        too_long = 'x' * 5001
        assert c.post('/api/doc/review.html/edit',
                      json={'element_id': '_pp_1', 'text': too_long}).status_code == 400

    def test_undo_pops_last_edit(self, client):
        c, _, _ = client
        c.post('/api/doc/review.html/edit',
               json={'element_id': '_pp_1', 'text': 'First attempt.'})
        c.post('/api/doc/review.html/edit',
               json={'element_id': '_pp_2', 'text': 'Second attempt.'})
        assert c.post('/api/doc/review.html/undo').get_json()['undo_depth'] == 1
        data = c.get('/api/doc/review.html').get_json()
        assert 'Second attempt.' not in data['content']
        assert 'First attempt.' in data['content']

    def test_undo_empty(self, client):
        c, _, _ = client
        assert c.post('/api/doc/review.html/undo').get_json()['status'] == 'empty'


class TestSaveAll:
    def test_save_writes_annotations_and_edits_to_master(self, client, workspace):
        c, _, _ = client
        c.post('/api/doc/review.html/edit',
               json={'element_id': '_pp_1', 'text': 'Edited para.'})
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_2', 'annotation': 'tighten this'})
        resp = c.post('/api/save-all')
        assert resp.status_code == 200
        assert 'review.md' in resp.get_json()['files_modified']

        master_text = (workspace / 'docs' / 'review.md').read_text(encoding='utf-8')
        doc = master.parse_master(master_text)
        by_block = [(mb.block, mb.markers) for mb in doc]
        # _pp_0 = the annotated h1, marker above it
        assert by_block[0][1] == [master.Marker('block', None, 'existing note')]
        # _pp_1 = first para, direct edit replaced its text
        assert by_block[1][0].lines == ['Edited para.']
        assert by_block[1][1] == []
        # _pp_2 = second para, staged annotation became a block marker
        assert by_block[2][0].lines == ['Second para.']
        assert by_block[2][1] == [master.Marker('block', None, 'tighten this')]
        # baseline snapshot updated to the new master (consume contract)
        baseline = (workspace / 'state' / 'review.base.md').read_text(encoding='utf-8')
        assert baseline == master_text

    def test_save_strips_unannotated_temp_ids(self, client, workspace):
        # The master at rest is clean markdown: no temp ids ever, and
        # only annotated blocks carry markers.
        c, _, _ = client
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_2', 'annotation': 'note'})
        c.post('/api/save-all')
        master_text = (workspace / 'docs' / 'review.md').read_text(encoding='utf-8')
        assert '_pp_' not in master_text
        doc = master.parse_master(master_text)
        assert [mb.markers for mb in doc] == [
            [master.Marker('block', None, 'existing note')],
            [],
            [master.Marker('block', None, 'note')],
        ]

    def test_save_clears_disk_annotations_deleted_in_session(self, client, workspace):
        c, _, _ = client
        c.delete('/api/doc/review.html/annotate/_pp_0')
        c.post('/api/save-all')
        master_text = (workspace / 'docs' / 'review.md').read_text(encoding='utf-8')
        assert 'pp:' not in master_text
        assert 'existing note' not in master_text

    def test_save_appends_audit_records(self, client, workspace):
        c, _, _ = client
        c.post('/api/doc/review.html/edit',
               json={'element_id': '_pp_1', 'text': 'Edited.'})
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_2', 'annotation': 'tighten this'})
        c.post('/api/save-all')

        ann_log = (workspace / 'annotations.jsonl').read_text(encoding='utf-8')
        records = [json.loads(line) for line in ann_log.strip().splitlines()]
        assert any(r['action'] == 'annotation_saved' and r['element_id'] == '_pp_2'
                   for r in records)

        edit_log = (workspace / 'edits.jsonl').read_text(encoding='utf-8')
        edit_records = [json.loads(line) for line in edit_log.strip().splitlines()]
        assert any(r['kind'] == 'text' and r['new'] == 'Edited.' for r in edit_records)

    def test_save_resets_staged_state(self, client):
        c, _, _ = client
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'x'})
        c.post('/api/save-all')
        data = c.get('/api/doc/review.html').get_json()
        assert data['undo_depth'] == 0
        data2 = c.get('/api/docs').get_json()
        review = [d for d in data2['docs'] if d['name'] == 'review.md'][0]
        assert review['annotation_count'] == 2  # _pp_0 existing + _pp_1 staged-then-saved


class TestSecurity:
    def test_path_traversal_rejected(self, client, workspace):
        c, _, _ = client
        (workspace.parent / 'secret.html').write_text('<p>secret</p>', encoding='utf-8')
        for bad in ('..%2Fsecret.html', '..\\secret.html', 'sub/dir.html', '...'):
            resp = c.get(f'/api/doc/{bad}')
            assert resp.status_code in (400, 404), bad

    def test_assets_served_with_traversal_guard(self, client, workspace):
        c, _, _ = client
        (workspace / 'assets' / 'pic.png').write_bytes(b'PNG')
        assert c.get('/assets/pic.png').status_code == 200
        assert c.get('/assets/pic.png').data == b'PNG'
        resp = c.get('/assets/..%2Fdocs%2Freview.html')
        assert resp.status_code in (400, 404)

    def test_foreign_host_header_403(self, client):
        c, _, _ = client
        resp = c.get('/api/health', headers={'Host': 'evil.example.com'})
        assert resp.status_code == 403

    def test_foreign_origin_403(self, client):
        c, _, _ = client
        resp = c.post('/api/save-all',
                      headers={'Origin': 'http://evil.example.com'})
        assert resp.status_code == 403

    def test_shutdown_invokes_exit_hook(self, client):
        c, exits, _ = client
        resp = c.post('/api/shutdown', json={'reason': 'test'})
        assert resp.status_code == 200
        for _ in range(50):
            if exits:
                break
            time.sleep(0.02)
        assert exits == [0]


MASTER_DOC = """<!-- pp: existing note -->
# Plan

Intro paragraph.

<!-- pp@2: rename gateway -->
```mermaid
flowchart LR
client --> gateway
```

| A | B |
|---|---|
| 1 | 2 |
"""


@pytest.fixture
def master_workspace(tmp_path: Path) -> Path:
    docs = tmp_path / 'docs'
    docs.mkdir()
    (tmp_path / 'assets').mkdir()
    (docs / 'plan.md').write_text(MASTER_DOC, encoding='utf-8')
    return tmp_path


@pytest.fixture
def master_client(master_workspace: Path):
    app = create_app(master_workspace, idle_timeout=0)
    app.config['TESTING'] = True
    app.config['SHUTDOWN_DELAY'] = 0.01
    exits: list = []
    app.config['EXIT_HOOK'] = lambda code=0: exits.append(code)
    with app.test_client() as c:
        yield c, exits, app


class TestServeFromMaster:
    def test_projection_served_with_temp_ids_and_annotations(self, master_client):
        c, _, _ = master_client
        resp = c.get('/api/doc/plan.md')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['name'] == 'plan.md'
        # Marker lines never leak into the projection; markers become
        # annotation attributes on the rendered blocks.
        assert '<!-- pp:' not in data['content']
        assert 'id="_pp_' in data['content']
        assert 'data-edit-annotation="existing note"' in data['content']
        assert 'data-edit-annotation="rename gateway"' in data['content']
        anns = {a['element_id']: a['annotation'] for a in data['annotations']}
        assert anns['_pp_0'] == 'existing note'
        assert 'rename gateway' in anns.values()
        assert data['undo_depth'] == 0

    def test_projection_matches_master_module(self, master_client):
        c, _, _ = master_client
        data = c.get('/api/doc/plan.md').get_json()
        assert 'pp-diagram' in data['content']
        assert '<table' in data['content']
        assert 'id="_pp_' in data['content']

    def test_missing_master_404(self, master_client):
        c, _, _ = master_client
        assert c.get('/api/doc/nope.md').status_code == 404

    def test_projection_cached_by_content_hash(self, master_client, master_workspace):
        c, _, _ = master_client
        calls = []
        original = master.projection_blocks

        def spy(text):
            calls.append(text)
            return original(text)

        monkey_original = master.projection_blocks
        import server
        server.master.projection_blocks = spy
        try:
            c.get('/api/doc/plan.md')
            c.get('/api/doc/plan.md')
            assert len(calls) == 1  # second GET served from the hash cache
            (master_workspace / 'docs' / 'plan.md').write_text(
                '# Rewritten\n', encoding='utf-8')
            data = c.get('/api/doc/plan.md').get_json()
            assert len(calls) == 2  # hash changed -> re-render
            assert 'Rewritten' in data['content']
        finally:
            server.master.projection_blocks = monkey_original

    def test_no_html_written_to_disk(self, master_client, master_workspace):
        c, _, _ = master_client
        c.get('/api/doc/plan.md')
        assert not (master_workspace / 'docs' / 'plan.html').exists()

    def test_docs_list_counts_master_markers(self, master_client):
        c, _, _ = master_client
        data = c.get('/api/docs').get_json()
        assert len(data['docs']) == 1
        doc = data['docs'][0]
        assert doc['name'] == 'plan.md'
        assert doc['annotation_count'] == 2  # one block note + one line note
        assert doc['annotated'] is True
        assert doc['ok'] is True

    def test_health_counts_master_docs(self, master_client):
        c, _, _ = master_client
        assert c.get('/api/health').get_json()['docs'] == 1

    def test_invalid_master_reported_in_listing(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'broken.md').write_text(
            '<!-- pp: dangling -->', encoding='utf-8')
        data = c.get('/api/docs').get_json()
        broken = [d for d in data['docs'] if d['name'] == 'broken.md'][0]
        assert broken['ok'] is False
        assert broken['error']

    def test_master_parse_failure_serves_500(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'broken.md').write_text(
            '<!-- pp: dangling -->', encoding='utf-8')
        assert c.get('/api/doc/broken.md').status_code == 500


class TestLegacyMigrationOnOpen:
    def test_first_open_migrates_and_serves_master(self, client, workspace):
        c, _, _ = client
        resp = c.get('/api/doc/review.html')
        assert resp.status_code == 200
        data = resp.get_json()
        # Served from the freshly created master.
        assert data['name'] == 'review.md'
        assert 'id="_pp_' in data['content']
        anns = {a['element_id']: a['annotation'] for a in data['annotations']}
        assert anns.get('_pp_0') == 'existing note'
        # Master on disk carries the annotation as a marker above the h1.
        master_text = (workspace / 'docs' / 'review.md').read_text(encoding='utf-8')
        assert '<!-- pp: existing note -->' in master_text
        # Old HTML archived out of docs/.
        assert not (workspace / 'docs' / 'review.html').exists()
        assert (workspace / 'archive' / 'review.html').read_text(
            encoding='utf-8') == DOC
        # Baseline snapshot for consume (0012) taken at migration time.
        baseline = (workspace / 'state' / 'review.base.md').read_text(encoding='utf-8')
        assert baseline == master_text

    def test_second_open_serves_master(self, client, workspace):
        c, _, _ = client
        c.get('/api/doc/review.html')
        data = c.get('/api/doc/review.html').get_json()
        assert data['name'] == 'review.md'

    def test_migration_failure_falls_back_to_legacy_path(self, client, workspace, monkeypatch):
        c, _, _ = client

        def boom(*args, **kwargs):
            raise migrate.MigrationError('boom')

        monkeypatch.setattr(migrate, 'migrate_legacy_doc', boom)
        resp = c.get('/api/doc/review.html')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['name'] == 'review.html'
        assert 'existing note' in data['content']  # today's HTML path
        assert (workspace / 'docs' / 'review.html').exists()

    def test_migration_failure_fallback_stages_like_today(self, client, workspace, monkeypatch):
        c, _, _ = client

        def boom(*args, **kwargs):
            raise migrate.MigrationError('boom')

        monkeypatch.setattr(migrate, 'migrate_legacy_doc', boom)
        c.get('/api/doc/review.html')
        resp = c.post('/api/doc/review.html/annotate',
                      json={'element_id': '_pp_1', 'annotation': 'new note'})
        assert resp.status_code == 200
        data = c.get('/api/doc/review.html').get_json()
        anns = {a['element_id']: a['annotation'] for a in data['annotations']}
        assert anns['_pp_1'] == 'new note'
        assert anns['_pp_0'] == 'existing note'

    def test_staged_work_keys_follow_resolved_master_name(self, client, workspace):
        c, _, app = client
        c.get('/api/doc/review.html')  # migrates
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'new note'})
        # Staged state lives under the master name, not the legacy one.
        assert 'review.md' in app.config['ANNOTATIONS']
        assert 'review.html' not in app.config['ANNOTATIONS']

    def test_docs_list_hides_archived_html(self, client, workspace):
        c, _, _ = client
        c.get('/api/doc/review.html')  # migrates review
        names = {d['name'] for d in c.get('/api/docs').get_json()['docs']}
        assert names == {'review.md', 'empty.html'}


FENCED_MASTER = """<!-- pp@1: rename this -->

```python
a = 1
b = 2
```
"""


@pytest.fixture
def fenced_workspace(tmp_path: Path) -> Path:
    docs = tmp_path / 'docs'
    docs.mkdir()
    (tmp_path / 'assets').mkdir()
    (docs / 'code.md').write_text(FENCED_MASTER, encoding='utf-8')
    return tmp_path


@pytest.fixture
def fenced_client(fenced_workspace: Path):
    app = create_app(fenced_workspace, idle_timeout=0)
    app.config['TESTING'] = True
    app.config['SHUTDOWN_DELAY'] = 0.01
    exits: list = []
    app.config['EXIT_HOOK'] = lambda code=0: exits.append(code)
    with app.test_client() as c:
        yield c, exits, app


class TestApplyToMaster:
    def test_line_annotation_updates_exact_marker(self, fenced_client, fenced_workspace):
        c, _, _ = fenced_client
        data = c.get('/api/doc/code.md').get_json()
        anns = {a['element_id']: a['annotation'] for a in data['annotations']}
        # The pp@1 target (span.line) carries a temp id even though span
        # is not an annotatable tag: the editor must be able to address it.
        span_id = [eid for eid, note in anns.items() if note == 'rename this'][0]
        resp = c.post('/api/doc/code.md/annotate',
                      json={'element_id': span_id, 'annotation': 'renamed'})
        assert resp.status_code == 200
        assert c.post('/api/save-all').status_code == 200
        master_text = (fenced_workspace / 'docs' / 'code.md').read_text(encoding='utf-8')
        assert '<!-- pp@1: renamed -->' in master_text
        assert 'a = 1' in master_text and 'b = 2' in master_text

    def test_line_direct_edit_replaces_fence_line(self, fenced_client, fenced_workspace):
        c, _, _ = fenced_client
        data = c.get('/api/doc/code.md').get_json()
        anns = {a['element_id']: a['annotation'] for a in data['annotations']}
        span_id = [eid for eid, note in anns.items() if note == 'rename this'][0]
        resp = c.post('/api/doc/code.md/edit',
                      json={'element_id': span_id, 'text': 'a = 42'})
        assert resp.status_code == 200
        assert c.post('/api/save-all').status_code == 200
        master_text = (fenced_workspace / 'docs' / 'code.md').read_text(encoding='utf-8')
        doc = master.parse_master(master_text)
        assert len(doc) == 1
        fence = doc[0].block
        assert fence.lines == ['a = 42', 'b = 2']
        # annotation and edit are independent: the marker stays
        assert doc[0].markers == [master.Marker('line', 1, 'rename this')]

    def test_annotation_on_li_coarsens_to_list_marker(self, master_client, master_workspace):
        c, _, _ = master_client
        # plan.md has no list; add one via the master file and re-serve.
        (master_workspace / 'docs' / 'list.md').write_text(
            '- a\n- b\n- c\n', encoding='utf-8')
        data = c.get('/api/doc/list.md').get_json()
        # _pp_0 = ul, _pp_1..3 = li a/b/c
        resp = c.post('/api/doc/list.md/annotate',
                      json={'element_id': '_pp_2', 'annotation': 'reword b'})
        assert resp.status_code == 200
        assert c.post('/api/save-all').status_code == 200
        master_text = (master_workspace / 'docs' / 'list.md').read_text(encoding='utf-8')
        doc = master.parse_master(master_text)
        assert len(doc) == 1
        assert doc[0].block.kind == 'ul'
        assert doc[0].markers == [master.Marker('block', None, 'reword b')]

    def test_subblock_direct_edit_preserves_list(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'list.md').write_text(
            '- a\n- b\n- c\n', encoding='utf-8')
        resp = c.post('/api/doc/list.md/edit',
                      json={'element_id': '_pp_2', 'text': 'bee'})
        assert resp.status_code == 200
        assert c.post('/api/save-all').status_code == 200
        master_text = (master_workspace / 'docs' / 'list.md').read_text(encoding='utf-8')
        assert '- a\n- bee\n- c' in master_text

    def test_edits_and_annotations_on_different_blocks(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'three.md').write_text(
            'One.\n\nTwo.\n\nThree.\n', encoding='utf-8')
        c.post('/api/doc/three.md/edit', json={'element_id': '_pp_0', 'text': 'Uno.'})
        c.post('/api/doc/three.md/annotate', json={'element_id': '_pp_1', 'annotation': 'mid note'})
        c.post('/api/doc/three.md/edit', json={'element_id': '_pp_2', 'text': 'Tres.'})
        assert c.post('/api/save-all').status_code == 200
        master_text = (master_workspace / 'docs' / 'three.md').read_text(encoding='utf-8')
        assert master_text == 'Uno.\n\n<!-- pp: mid note -->\nTwo.\n\nTres.\n'

    def test_apply_recomputes_mapping_after_external_master_edit(
            self, master_client, master_workspace):
        # The AI edited the master between serve and stage: staging and
        # Apply resolve ids against the CURRENT master (positional ids,
        # same semantics as the HTML path).
        c, _, _ = master_client
        c.get('/api/doc/three.md')  # nothing there yet -> 404 is fine to ignore
        (master_workspace / 'docs' / 'three.md').write_text(
            'One.\n\nTwo.\n\nThree.\n', encoding='utf-8')
        c.get('/api/doc/three.md')
        (master_workspace / 'docs' / 'three.md').write_text(
            'Preamble.\n\nOne.\n\nTwo.\n\nThree.\n', encoding='utf-8')
        # Fresh serve renumbers: _pp_1 is now "One."
        c.post('/api/doc/three.md/annotate', json={'element_id': '_pp_1', 'annotation': 'note'})
        assert c.post('/api/save-all').status_code == 200
        master_text = (master_workspace / 'docs' / 'three.md').read_text(encoding='utf-8')
        assert '<!-- pp: note -->\nOne.' in master_text

    def test_unknown_annotation_target_refused_not_dropped(self, master_client, master_workspace):
        """A staged note whose target matches no block must never be
        dropped silently (it was, log-only — reported as vanishing
        annotations). Apply refuses the doc, names the note, keeps the
        staged work; removing the stale note unblocks the save."""
        c, _, _ = master_client
        (master_workspace / 'docs' / 'three.md').write_text(
            'One.\n\nTwo.\n', encoding='utf-8')
        c.get('/api/doc/three.md')
        c.post('/api/doc/three.md/annotate', json={'element_id': '_pp_0', 'annotation': 'keep'})
        c.post('/api/doc/three.md/annotate', json={'element_id': '_pp_99', 'annotation': 'bogus'})
        resp = c.post('/api/save-all')
        assert resp.status_code == 500
        assert 'bogus' in resp.get_json()['error']
        # refusal left the master untouched and the notes staged
        master_text = (master_workspace / 'docs' / 'three.md').read_text(encoding='utf-8')
        assert 'keep' not in master_text
        data = c.get('/api/doc/three.md').get_json()
        assert 'keep' in [a['annotation'] for a in data['annotations']]
        # deleting the stale note unblocks Apply
        c.delete('/api/doc/three.md/annotate/_pp_99')
        assert c.post('/api/save-all').status_code == 200
        master_text = (master_workspace / 'docs' / 'three.md').read_text(encoding='utf-8')
        assert '<!-- pp: keep -->\nOne.' in master_text
        assert 'bogus' not in master_text

    def test_audit_records_reference_master_file(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'three.md').write_text(
            'One.\n\nTwo.\n', encoding='utf-8')
        c.get('/api/doc/three.md')
        c.post('/api/doc/three.md/annotate', json={'element_id': '_pp_0', 'annotation': 'keep'})
        c.post('/api/doc/three.md/edit', json={'element_id': '_pp_1', 'text': 'Dos.'})
        c.post('/api/save-all')
        ann_records = [
            json.loads(line)
            for line in (master_workspace / 'annotations.jsonl')
            .read_text(encoding='utf-8').strip().splitlines()
        ]
        # 0026 appends apply-event records too; these assertions are
        # about annotation records only.
        ann_records = [r for r in ann_records
                       if str(r.get('action', '')).startswith('annotation_')]
        assert all(r['file'] == 'three.md' for r in ann_records)
        assert any(r['action'] == 'annotation_saved' and r['new'] == 'keep'
                   for r in ann_records)
        edit_records = [
            json.loads(line)
            for line in (master_workspace / 'edits.jsonl')
            .read_text(encoding='utf-8').strip().splitlines()
        ]
        assert any(r['kind'] == 'text' and r['old'] == 'Two.' and r['new'] == 'Dos.'
                   for r in edit_records)

    def test_removed_annotation_audited(self, master_client, master_workspace):
        c, _, _ = master_client
        c.get('/api/doc/plan.md')
        data = c.get('/api/doc/plan.md').get_json()
        anns = {a['element_id']: a['annotation'] for a in data['annotations']}
        block_id = [eid for eid, note in anns.items() if note == 'existing note'][0]
        c.delete(f'/api/doc/plan.md/annotate/{block_id}')
        assert c.post('/api/save-all').status_code == 200
        records = [
            json.loads(line)
            for line in (master_workspace / 'annotations.jsonl')
            .read_text(encoding='utf-8').strip().splitlines()
        ]
        assert any(r['action'] == 'annotation_removed' and r['old'] == 'existing note'
                   for r in records)
        master_text = (master_workspace / 'docs' / 'plan.md').read_text(encoding='utf-8')
        assert 'existing note' not in master_text

    def test_edits_only_save_does_not_touch_annotation_audit(
            self, master_client, master_workspace):
        # Staging an edit without touching annotations must not log
        # annotation_removed for the markers already on disk.
        c, _, _ = master_client
        c.get('/api/doc/plan.md')  # carries one block note + one line note
        c.post('/api/doc/plan.md/edit', json={'element_id': '_pp_1', 'text': 'New intro.'})
        assert c.post('/api/save-all').status_code == 200
        if (master_workspace / 'annotations.jsonl').exists():
            records = [
                json.loads(line)
                for line in (master_workspace / 'annotations.jsonl')
                .read_text(encoding='utf-8').strip().splitlines()
            ]
            # Same audit shape as the HTML path: disk annotations are
            # re-set (updated), never reported removed. (0026 apply
            # events are not annotation records.)
            ann_only = [r for r in records
                        if str(r.get('action', '')).startswith('annotation_')]
            assert all(r['action'] == 'annotation_updated' for r in ann_only)
            assert not any(r['action'] == 'annotation_removed'
                           for r in ann_only)
        master_text = (master_workspace / 'docs' / 'plan.md').read_text(encoding='utf-8')
        assert 'New intro.' in master_text
        assert '<!-- pp: existing note -->' in master_text

    def test_block_and_line_notes_share_one_fence(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'flow.md').write_text(
            '```mermaid\nflowchart LR\nA --> B\nB --> C\n```\n', encoding='utf-8')
        data = c.get('/api/doc/flow.md').get_json()
        # _pp_0 = figure, _pp_1..3 = div.line source lines
        c.post('/api/doc/flow.md/annotate',
               json={'element_id': '_pp_0', 'annotation': 'overall flow note'})
        c.post('/api/doc/flow.md/annotate',
               json={'element_id': '_pp_2', 'annotation': 'swap edge'})
        assert c.post('/api/save-all').status_code == 200
        master_text = (master_workspace / 'docs' / 'flow.md').read_text(encoding='utf-8')
        assert master_text == (
            '<!-- pp: overall flow note -->\n'
            '<!-- pp@2: swap edge -->\n'
            '```mermaid\nflowchart LR\nA --> B\nB --> C\n```\n')

    def test_note_with_comment_end_survives_apply(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'three.md').write_text('One.\n', encoding='utf-8')
        c.get('/api/doc/three.md')
        c.post('/api/doc/three.md/annotate',
               json={'element_id': '_pp_0', 'annotation': 'keep --> marker'})
        assert c.post('/api/save-all').status_code == 200
        master_text = (master_workspace / 'docs' / 'three.md').read_text(encoding='utf-8')
        doc = master.parse_master(master_text)  # must stay parseable
        assert doc[0].markers[0].note == 'keep \u2014> marker'


class TestWaitEndpoint:
    """The blocking wait primitive behind wait.py (0015): /api/wait
    releases when a fully successful save-all bumps the apply epoch; a
    failed Apply releases nothing; the waiter never feeds the idle
    watchdog."""

    def test_timeout_when_nothing_applied(self, client):
        c, _, _ = client
        resp = c.get('/api/wait?since=0&timeout=0')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'timeout'
        assert data['epoch'] == 0

    def test_released_by_successful_apply(self, client):
        c, _, _ = client
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        assert c.post('/api/save-all').status_code == 200
        data = c.get('/api/wait?since=0&timeout=0').get_json()
        assert data['status'] == 'applied'
        assert data['epoch'] >= 1
        # an already-seen epoch waits again
        data = c.get(f"/api/wait?since={data['epoch']}&timeout=0").get_json()
        assert data['status'] == 'timeout'

    def test_epoch_bumps_once_per_apply(self, client):
        c, _, _ = client
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'one'})
        c.post('/api/save-all')
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'two'})
        c.post('/api/save-all')
        assert c.get('/api/wait?since=0&timeout=0').get_json()['epoch'] == 2

    def test_failed_apply_releases_nothing(self, master_client, master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'three.md').write_text('One.\n', encoding='utf-8')
        c.get('/api/doc/three.md')
        c.post('/api/doc/three.md/annotate',
               json={'element_id': '_pp_99', 'annotation': 'ghost'})
        assert c.post('/api/save-all').status_code == 500
        data = c.get('/api/wait?since=0&timeout=0').get_json()
        assert data['status'] == 'timeout'
        assert data['epoch'] == 0
        # resolving and applying again releases
        c.delete('/api/doc/three.md/annotate/_pp_99')
        assert c.post('/api/save-all').status_code == 200
        assert c.get('/api/wait?since=0&timeout=0').get_json()['status'] == 'applied'

    def test_blocks_until_apply_releases(self, client):
        import threading
        c, _, app = client
        result = {}

        def waiter():
            with app.test_client() as wc:
                result['resp'] = wc.get('/api/wait?since=0&timeout=10')

        thread = threading.Thread(target=waiter)
        thread.start()
        time.sleep(0.3)  # let the waiter block inside the condition
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        assert c.post('/api/save-all').status_code == 200
        thread.join(timeout=5)
        assert not thread.is_alive()
        data = result['resp'].get_json()
        assert data['status'] == 'applied'
        assert data['epoch'] == 1

    def test_wait_does_not_feed_idle_watchdog(self, client):
        c, _, app = client
        frozen = time.time() - 9999
        app.config['LAST_REQUEST_TIME'] = frozen
        c.get('/api/wait?since=0&timeout=0')
        assert app.config['LAST_REQUEST_TIME'] == frozen
        # every other endpoint still counts as activity
        c.get('/api/health')
        assert app.config['LAST_REQUEST_TIME'] > frozen

    def test_wait_validates_params(self, client):
        c, _, _ = client
        assert c.get('/api/wait?since=abc').status_code == 400
        assert c.get('/api/wait?since=-1').status_code == 400
        assert c.get('/api/wait?timeout=abc').status_code == 400
        assert c.get('/api/wait?timeout=-1').status_code == 400

    def test_empty_apply_is_full_agreement(self, client):
        # Submitting with nothing staged is a real submission (0015
        # amendment): the epoch bumps, the waiter releases, files == [].
        c, _, _ = client
        resp = c.post('/api/save-all')
        assert resp.status_code == 200
        assert resp.get_json()['files_modified'] == []
        data = c.get('/api/wait?since=0&timeout=0').get_json()
        assert data['status'] == 'applied'
        assert data['epoch'] == 1
        assert data['files'] == []

    def test_wait_files_reflect_modified_docs(self, master_client):
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        assert c.post('/api/save-all').status_code == 200
        data = c.get('/api/wait?since=0&timeout=0').get_json()
        assert data['status'] == 'applied'
        assert data['files'] == ['plan.md']

    def test_wait_timeout_has_no_files(self, client):
        c, _, _ = client
        data = c.get('/api/wait?since=0&timeout=0').get_json()
        assert data['status'] == 'timeout'
        assert 'files' not in data

    def test_docs_list_exposes_staged_counts(self, client):
        c, _, _ = client
        c.post('/api/doc/review.html/annotate',
               json={'element_id': '_pp_1', 'annotation': 'staged note'})
        c.post('/api/doc/review.html/edit',
               json={'element_id': '_pp_2', 'text': 'Second para, edited.'})
        # key by stem: opening review.html migrates it to review.md
        docs = {Path(d['name']).stem: d
                for d in c.get('/api/docs').get_json()['docs']}
        review = docs['review']
        # the staged snapshot is the complete desired set: the disk note
        # ('existing note' on _pp_0) rides along with the new one
        assert review['staged_notes'] == 2
        assert review['staged_snapshot'] is True
        assert review['staged_edits'] == 1
        empty = docs['empty']
        assert empty['staged_notes'] == 0
        assert empty['staged_snapshot'] is False
        assert empty['staged_edits'] == 0

    def test_staged_empty_snapshot_counts_as_staged(self, client):
        # Deleting every disk note stages an empty snapshot: Apply is
        # still pending (delete-all intent), the confirm modal must say so.
        c, _, _ = client
        c.delete('/api/doc/review.html/annotate/_pp_0')
        docs = {Path(d['name']).stem: d
                for d in c.get('/api/docs').get_json()['docs']}
        review = docs['review']
        assert review['staged_notes'] == 0
        assert review['staged_snapshot'] is True


class TestEmptySemantics:
    """0026: an Apply says what its untouched blocks mean. The choice
    ('undecided' default, 'agreed' explicit) is recorded per doc, shown
    by the editor APIs, and carried to wait.py through /api/wait."""

    def test_partial_apply_records_interpretation(self, master_client):
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        assert c.post('/api/save-all',
                      json={'empties': 'undecided'}).status_code == 200
        docs = {d['name']: d for d in c.get('/api/docs').get_json()['docs']}
        assert docs['plan.md']['empties'] == 'undecided'
        doc = c.get('/api/doc/plan.md').get_json()
        assert doc['empties'] == 'undecided'

    def test_agreed_apply_supersedes_undecided(self, master_client):
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        c.post('/api/save-all', json={'empties': 'undecided'})
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'again'})
        c.post('/api/save-all', json={'empties': 'agreed'})
        docs = {d['name']: d for d in c.get('/api/docs').get_json()['docs']}
        assert docs['plan.md']['empties'] == 'agreed'

    def test_missing_choice_defaults_to_undecided(self, master_client):
        # old clients / bare POST: silence is not consent
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        assert c.post('/api/save-all').status_code == 200
        docs = {d['name']: d for d in c.get('/api/docs').get_json()['docs']}
        assert docs['plan.md']['empties'] == 'undecided'

    def test_unknown_choice_defaults_to_undecided(self, master_client):
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        c.post('/api/save-all', json={'empties': 'whatever'})
        docs = {d['name']: d for d in c.get('/api/docs').get_json()['docs']}
        assert docs['plan.md']['empties'] == 'undecided'

    def test_full_agreement_marks_all_docs_agreed(self, master_client,
                                                  master_workspace):
        c, _, _ = master_client
        (master_workspace / 'docs' / 'other.md').write_text(
            'Other.\n', encoding='utf-8')
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        c.post('/api/save-all', json={'empties': 'undecided'})
        # a later nothing-staged Apply approves every document
        assert c.post('/api/save-all').status_code == 200
        docs = {d['name']: d for d in c.get('/api/docs').get_json()['docs']}
        assert docs['plan.md']['empties'] == 'agreed'
        assert docs['other.md']['empties'] == 'agreed'

    def test_wait_release_carries_empties(self, master_client):
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        c.post('/api/save-all', json={'empties': 'undecided'})
        data = c.get('/api/wait?since=0&timeout=0').get_json()
        assert data['status'] == 'applied'
        assert data['files'] == ['plan.md']
        assert data['empties'] == 'undecided'

    def test_wait_full_agreement_carries_agreed(self, master_client):
        c, _, _ = master_client
        assert c.post('/api/save-all').status_code == 200
        data = c.get('/api/wait?since=0&timeout=0').get_json()
        assert data['files'] == []
        assert data['empties'] == 'agreed'

    def test_failed_apply_records_nothing(self, master_client):
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_99', 'annotation': 'ghost'})
        assert c.post(
            '/api/save-all', json={'empties': 'agreed'}).status_code == 500
        docs = {d['name']: d for d in c.get('/api/docs').get_json()['docs']}
        assert docs['plan.md']['empties'] is None

    def test_apply_event_is_audited(self, master_client, master_workspace):
        import json as _json
        c, _, _ = master_client
        c.post('/api/doc/plan.md/annotate',
               json={'element_id': '_pp_1', 'annotation': 'note'})
        c.post('/api/save-all', json={'empties': 'undecided'})
        records = [
            _json.loads(line) for line in
            (master_workspace / 'annotations.jsonl').read_text(
                encoding='utf-8').splitlines() if line.strip()]
        applies = [r for r in records if r.get('action') == 'apply']
        assert len(applies) == 1
        assert applies[0]['empties'] == 'undecided'
        assert applies[0]['files'] == ['plan.md']
