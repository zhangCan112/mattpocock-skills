"""Regression tests for editor bugs reported against real usage.

Bug 1 (layout): with many staged annotations the Apply button was pushed
    out of the viewport by a non-scrolling annotation list - the right
    panel clipped it (overflow: hidden). Browser test, skipped when no
    playwright/system-Chromium is available.

Bug 2 (lost notes): staged annotations are keyed by positional temp ids
    (_pp_N). Any change to the master while notes are staged (the live
    loop's consume step edits docs between user rounds) renumbers the ids:
    notes silently landed on the WRONG block after an edit above them, or
    were silently DROPPED by Apply when their id vanished. The fix re-
    anchors staged work to the current projection by content fingerprint
    and makes Apply refuse (listing the notes) instead of dropping.

Bug 3 (anchor drift on Apply): _build_mapping assumed the projection
    body's top-level children correspond 1:1 to master blocks. Blocks
    that render to zero elements (a lone link-reference definition) or
    several (a paragraph run with a quote or raw HTML) shifted every
    later element's block index, so Apply silently wrote markers onto the
    WRONG block - reported as "annotated the first list option, Apply
    put the note on the heading above it". The fix translates ids through
    master.projection_blocks spans, the true block -> children ranges.
"""

import json
import shutil
import sys
import threading
import time
from pathlib import Path

import pytest

import master
from annotations import parse_doc_text
from server import create_app

MD_DOC = """# Anchoring test

Alpha paragraph one.

Beta paragraph two.

Gamma paragraph three.

Delta paragraph four.
"""


@pytest.fixture
def md_workspace(tmp_path: Path) -> Path:
    docs = tmp_path / 'docs'
    docs.mkdir()
    (tmp_path / 'assets').mkdir()
    (docs / 'anchor.md').write_text(MD_DOC, encoding='utf-8')
    return tmp_path


@pytest.fixture
def md_client(md_workspace: Path):
    app = create_app(md_workspace, idle_timeout=0)
    app.config['TESTING'] = True
    with app.test_client() as c:
        yield c, md_workspace


def _annotate(c, doc, eid, text):
    resp = c.post(f'/api/doc/{doc}/annotate',
                  json={'element_id': eid, 'annotation': text})
    assert resp.status_code == 200, resp.get_json()


def _ids_by_text(c, doc):
    """element id -> visible text, from the served projection."""
    data = c.get(f'/api/doc/{doc}').get_json()
    import re
    ids = {}
    for m in re.finditer(r'<(\w+)[^>]*id="(_pp_\d+)"[^>]*>(.*?)</\1>', data['content'], re.S):
        ids[m.group(2)] = re.sub(r'<[^>]+>', '', m.group(3)).strip()
    return ids


class TestAnnotationReanchor:
    def test_notes_follow_blocks_after_master_edit(self, md_client):
        c, ws = md_client
        ids = _ids_by_text(c, 'anchor.md')
        gamma = next(k for k, v in ids.items() if v.startswith('Gamma'))
        delta = next(k for k, v in ids.items() if v.startswith('Delta'))
        _annotate(c, 'anchor.md', gamma, 'note-gamma')
        _annotate(c, 'anchor.md', delta, 'note-delta')

        # the live loop's consume round: remove the first paragraph,
        # shifting every later _pp_N down by one
        master_path = ws / 'docs' / 'anchor.md'
        text = master_path.read_text(encoding='utf-8')
        text = text.replace('Alpha paragraph one.\n\n', '', 1)
        master_path.write_text(text, encoding='utf-8')

        data = c.get('/api/doc/anchor.md').get_json()
        notes = {a['element_id']: a['annotation'] for a in data['annotations']}
        assert len(notes) == 2
        assert set(notes.values()) == {'note-gamma', 'note-delta'}
        # every note must point at an element that EXISTS now (no ghosts)
        current = _ids_by_text(c, 'anchor.md')
        for eid in notes:
            assert eid in current, f'ghost annotation id {eid}'
            assert 'Gamma' in current[eid] or 'Delta' in current[eid]

        # Apply: markers must land on the RIGHT blocks (not shifted)
        resp = c.post('/api/save-all')
        assert resp.status_code == 200, resp.get_json()
        saved = master_path.read_text(encoding='utf-8')
        blocks = master.parse_master(saved)
        texts = ['\n'.join(b.block.lines) for b in blocks]
        idx = {t[:5]: i for i, t in enumerate(texts)}
        markers = {i: [m.note for m in b.markers] for i, b in enumerate(blocks)}
        assert markers[idx['Gamma']] == ['note-gamma']
        assert markers[idx['Delta']] == ['note-delta']
        assert markers[idx['Beta ']] == []  # no mis-anchored leftovers

    def test_apply_refuses_when_annotated_block_was_deleted(self, md_client):
        c, ws = md_client
        ids = _ids_by_text(c, 'anchor.md')
        beta = next(k for k, v in ids.items() if v.startswith('Beta'))
        _annotate(c, 'anchor.md', beta, 'note-beta')

        master_path = ws / 'docs' / 'anchor.md'
        text = master_path.read_text(encoding='utf-8')
        text = text.replace('Beta paragraph two.\n\n', '', 1)
        master_path.write_text(text, encoding='utf-8')

        resp = c.post('/api/save-all')
        assert resp.status_code == 500
        err = resp.get_json()['error']
        assert 'note-beta' in err, err

        # the staged note survives the refusal (not silently dropped)
        data = c.get('/api/doc/anchor.md').get_json()
        assert 'note-beta' in [a['annotation'] for a in data['annotations']]

    def test_direct_edit_follows_block_after_master_edit(self, md_client):
        c, ws = md_client
        ids = _ids_by_text(c, 'anchor.md')
        gamma = next(k for k, v in ids.items() if v.startswith('Gamma'))
        resp = c.post('/api/doc/anchor.md/edit',
                      json={'element_id': gamma, 'text': 'Gamma rewritten.'})
        assert resp.status_code == 200

        master_path = ws / 'docs' / 'anchor.md'
        text = master_path.read_text(encoding='utf-8')
        text = text.replace('Alpha paragraph one.\n\n', '', 1)
        master_path.write_text(text, encoding='utf-8')

        resp = c.post('/api/save-all')
        assert resp.status_code == 200, resp.get_json()
        saved = master_path.read_text(encoding='utf-8')
        # the edit must land on Gamma (matched by its old text), and Delta
        # must keep its own text - not be overwritten by the shifted id
        assert 'Gamma rewritten.' in saved
        assert 'Gamma paragraph three.' not in saved
        assert 'Delta paragraph four.' in saved
        assert 'Alpha paragraph one.' not in saved


DRIFT_MD = """# Title

Some intro text with a citation.[1]

[1]: http://example.com/source

## Options

1. First option
2. Second option
"""


class TestApplyAnchorDrift:
    """Bug 3: notes drifting to the wrong block on Apply because the
    temp-id mapping assumed one top-level element per master block."""

    def _element_id(self, c, doc, tag, text_startswith):
        data = c.get(f'/api/doc/{doc}').get_json()
        root = parse_doc_text(f"<body>{data['content']}</body>")
        for el in root.iter():
            text = ''.join(el.itertext()).strip()
            if el.tag == tag and text.startswith(text_startswith):
                return el.get('id')
        raise AssertionError(f'no {tag} starting {text_startswith!r} in {doc}')

    def test_note_on_option_lands_on_list_not_heading(self, md_client):
        """The reported case: a link-reference definition renders to
        nothing, so the options list's element index used to point one
        block too early - at the heading above the list."""
        c, ws = md_client
        (ws / 'docs' / 'reply.md').write_text(DRIFT_MD, encoding='utf-8')
        first_option = self._element_id(c, 'reply.md', 'li', 'First option')

        c.post('/api/doc/reply.md/annotate',
               json={'element_id': first_option, 'annotation': 'pick this'})
        resp = c.post('/api/save-all')
        assert resp.status_code == 200, resp.get_json()

        saved = (ws / 'docs' / 'reply.md').read_text(encoding='utf-8')
        blocks = master.parse_master(saved)
        notes = {('\n'.join(b.block.lines), tuple(m.note for m in b.markers))
                 for b in blocks}
        assert ('1. First option\n2. Second option', ('pick this',)) in notes
        assert ('## Options', ()) in notes  # not on the heading
        assert ('# Title', ()) in notes

    def test_note_on_quote_block_stays_on_its_block(self, md_client):
        """A paragraph run ending in a quote renders to two elements;
        everything after it used to map one block too late."""
        c, ws = md_client
        (ws / 'docs' / 'quote.md').write_text(
            'Choose one:\n> fast\n\n## After\n\nTail.\n', encoding='utf-8')
        quote = self._element_id(c, 'quote.md', 'blockquote', 'fast')

        c.post('/api/doc/quote.md/annotate',
               json={'element_id': quote, 'annotation': 'slow down'})
        assert c.post('/api/save-all').status_code == 200

        saved = (ws / 'docs' / 'quote.md').read_text(encoding='utf-8')
        blocks = master.parse_master(saved)
        notes = {('\n'.join(b.block.lines), tuple(m.note for m in b.markers))
                 for b in blocks}
        # the note stays on the paragraph+quote block, not on ## After
        assert ('Choose one:\n> fast', ('slow down',)) in notes
        assert ('## After', ()) in notes
        assert ('Tail.', ()) in notes

    def test_direct_edit_after_zero_render_block_hits_right_block(self, md_client):
        """Direct edits shared the same shifted mapping: editing an
        option after a link-reference definition must not touch the
        heading (or crash on an out-of-range block index)."""
        c, ws = md_client
        (ws / 'docs' / 'reply.md').write_text(DRIFT_MD, encoding='utf-8')
        first_option = self._element_id(c, 'reply.md', 'li', 'First option')

        resp = c.post('/api/doc/reply.md/edit',
                      json={'element_id': first_option, 'text': 'Option uno'})
        assert resp.status_code == 200, resp.get_json()
        assert c.post('/api/save-all').status_code == 200

        saved = (ws / 'docs' / 'reply.md').read_text(encoding='utf-8')
        assert '1. Option uno' in saved
        assert '2. Second option' in saved
        assert '## Options' in saved  # heading untouched


# ---------------------------------------------------------------------------
# Bug 1: browser layout regression (optional - needs playwright + system
# Edge/Chrome; skipped otherwise, like scripts/verify-mapping.cjs is manual).
# ---------------------------------------------------------------------------

playwright = pytest.importorskip('playwright.sync_api', reason='playwright not installed')


def _browser_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            for ch in ('msedge', 'chrome'):
                try:
                    b = p.chromium.launch(channel=ch, headless=True)
                    b.close()
                    return True
                except Exception:
                    continue
    except Exception:
        pass
    return False


@pytest.mark.skipif(not _browser_available(), reason='no system Chromium')
class TestUnresolvedFlagging:
    def test_external_edit_flags_note_and_apply_refuses(self, md_workspace):
        from playwright.sync_api import sync_playwright
        from werkzeug.serving import make_server

        app = create_app(md_workspace, idle_timeout=0)
        httpd = make_server('127.0.0.1', 0, app)
        port = httpd.server_port
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(channel='msedge', headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 900})
                page.goto(f'http://127.0.0.1:{port}/#anchor.md')
                page.wait_for_selector('#doc-content [id]')
                ids = page.evaluate(
                    "() => Array.from(document.querySelectorAll(\"#doc-content [id]\"))"
                    ".filter(e => e.tagName === 'P').map(e => e.id)")
                # note on Gamma (kept) and on Beta (deleted below)
                texts = page.evaluate(
                    "() => Array.from(document.querySelectorAll(\"#doc-content p\"))"
                    ".map(e => e.textContent)")
                beta = ids[next(i for i, x in enumerate(texts) if x.startswith('Beta'))]
                gamma = ids[next(i for i, x in enumerate(texts) if x.startswith('Gamma'))]
                for i, (eid, note) in enumerate(
                        ((gamma, 'note-gamma'), (beta, 'note-beta'))):
                    page.click(f"#doc-content [id='{eid}']")
                    page.fill('#annotation-text', note)
                    page.click('#btn-add-annotation')
                    page.wait_for_function(
                        'n => document.querySelectorAll("#annotations .ann-item").length === n',
                        arg=i + 1, timeout=8000)

                # consume-round edit: delete Beta's paragraph
                master_path = md_workspace / 'docs' / 'anchor.md'
                text = master_path.read_text(encoding='utf-8')
                master_path.write_text(
                    text.replace('Beta paragraph two.\n\n', '', 1), encoding='utf-8')

                # user's UI reset: re-click the doc entry
                page.locator('#doc-list .doc-item', has_text='anchor').first.click()
                page.wait_for_selector('.ann-item.ann-unresolved', timeout=8000)
                flagged = page.evaluate(
                    "document.querySelectorAll('.ann-item.ann-unresolved').length")
                assert flagged == 1

                # Apply refuses, names the note, message visible in status
                # (through the 0015 confirm modal — the anti-misclick gate)
                page.evaluate(
                    "document.querySelector('#btn-apply').scrollIntoView({block: 'center'})")
                page.click('#btn-apply')
                page.click('#modal-confirm')
                page.wait_for_function(
                    "() => document.querySelector('#doc-status').textContent.includes('note-beta')",
                    timeout=8000)
                browser.close()
        finally:
            httpd.shutdown()
            t.join(timeout=5)


@pytest.mark.skipif(not _browser_available(), reason='no system Chromium')
class TestApplyButtonVisibility:
    def test_apply_visible_with_many_annotations(self, md_workspace):
        from playwright.sync_api import sync_playwright
        from werkzeug.serving import make_server

        # a doc with plenty of annotatable blocks: 8 two-line notes must
        # overflow the list, which then has to scroll internally instead
        # of pushing #actions out of the viewport
        big = md_workspace / 'docs' / 'big.md'
        big.write_text(
            '# Big doc\n\n' + '\n\n'.join(
                f'Paragraph number {i} carries some ordinary review text.'
                for i in range(1, 13)) + '\n', encoding='utf-8')

        app = create_app(md_workspace, idle_timeout=0)
        httpd = make_server('127.0.0.1', 0, app)
        port = httpd.server_port
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(channel='msedge', headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 900})
                page.goto(f'http://127.0.0.1:{port}/#big.md')
                page.wait_for_selector('#doc-content [id]')
                ids = page.evaluate(
                    "() => Array.from(document.querySelectorAll(\"#doc-content [id]\"))"
                    ".filter(e => e.tagName === 'P').map(e => e.id)")
                assert len(ids) >= 8
                for i, eid in enumerate(ids[:8]):
                    page.click(f"#doc-content [id='{eid}']")
                    page.fill('#annotation-text',
                              f'regression note {i + 1}: please revisit this '
                              f'block and rewrite the reasoning here')
                    page.click('#btn-add-annotation')
                    page.wait_for_function(
                        'n => document.querySelectorAll("#annotations .ann-item").length === n',
                        arg=i + 1, timeout=8000)
                geo = page.evaluate(
                    """() => {
                        const vh = window.innerHeight;
                        const btn = document.querySelector('#btn-apply').getBoundingClientRect();
                        const list = document.querySelector('#annotations');
                        return {vh, btnTop: btn.top, btnBottom: btn.bottom,
                                listScrolls: list.scrollHeight > list.clientHeight,
                                listClientH: list.clientHeight};
                    }""")
                assert geo['btnBottom'] <= geo['vh'], geo
                assert geo['btnTop'] >= 0, geo
                assert geo['listScrolls'], geo  # the list absorbs overflow itself
                browser.close()
        finally:
            httpd.shutdown()
            t.join(timeout=5)


@pytest.mark.skipif(not _browser_available(), reason='no system Chromium')
class TestFullAgreementApply:
    def test_apply_with_nothing_staged_submits_agreement(self, md_workspace):
        """0015 amendment: an Apply with nothing staged is a meaningful
        submission — the modal asks for full agreement, confirming it
        submits (releasing any AI-side waiter), and the status says so."""
        from playwright.sync_api import sync_playwright
        from werkzeug.serving import make_server

        app = create_app(md_workspace, idle_timeout=0)
        httpd = make_server('127.0.0.1', 0, app)
        port = httpd.server_port
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(channel='msedge', headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 900})
                page.goto(f'http://127.0.0.1:{port}/#anchor.md')
                page.wait_for_selector('#doc-content [id]')
                page.evaluate(
                    "document.querySelector('#btn-apply').scrollIntoView({block: 'center'})")
                page.click('#btn-apply')
                page.wait_for_function(
                    "() => document.querySelector('#modal-message').textContent"
                    ".includes('full agreement')", timeout=8000)
                page.click('#modal-confirm')
                page.wait_for_function(
                    "() => document.querySelector('#doc-status').textContent"
                    ".includes('full agreement')", timeout=8000)
                browser.close()
        finally:
            httpd.shutdown()
            t.join(timeout=5)
