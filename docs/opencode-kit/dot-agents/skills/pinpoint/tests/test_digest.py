"""Tests for digest.py - the per-round digest CLI (0011, format per 0002).

The digest is what the AI reads instead of the doc: every pending
annotation (master markers, quoted with their master region), every
unconsumed direct edit (edits.jsonl, read incrementally via
state/digest.json), printed to stdout.
"""

from pathlib import Path

import json

import digest


def make_workspace(tmp_path: Path) -> Path:
    docs = tmp_path / 'docs'
    docs.mkdir()
    return tmp_path


MASTER_ONE_NOTE = (
    '<!-- pp: rewrite this intro -->\n'
    '\n'
    'Intro paragraph with stale content.\n'
)

MASTER_CODE_BLOCK_NOTE = (
    '<!-- pp: review the whole block -->\n'
    '```python\n'
    'a = 1\n'
    'b = 2\n'
    '```\n'
)


def write_master(ws: Path, name: str, text: str) -> Path:
    path = ws / 'docs' / name
    path.write_text(text, encoding='utf-8')
    return path


MASTER_LINE_NOTE = (
    '<!-- pp@2: rename this variable -->\n'
    '```python\n'
    'a = 1\n'
    'b = 2\n'
    'c = 3\n'
    '```\n'
)

MASTER_LONG_FENCE = (
    '<!-- pp@5: dead code here -->\n'
    '```\n'
    'line-1\n'
    'line-2\n'
    'line-3\n'
    'line-4\n'
    'line-5\n'
    'line-6\n'
    'line-7\n'
    'line-8\n'
    '```\n'
)


class TestMultiDoc:
    def test_docs_grouped_with_global_section_numbers(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'b-second.md', MASTER_ONE_NOTE)
        write_master(ws, 'a-first.md',
                     '<!-- pp: fix heading -->\n\n# Stale title\n')
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'a-first.md · 1 annotation' in out
        assert 'b-second.md · 1 annotation' in out
        # sections numbered across the whole digest, doc order respected
        assert out.index('── 1 · a-first.md ──') < out.index('── 2 · b-second.md ──')

    def test_header_counts_only_matching_stem_edits(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'review.md', MASTER_ONE_NOTE)
        records = [
            '{"ts": 1, "file": "review.md", "element_id": "_pp_1", '
            '"action": "edit", "kind": "text", "old": "a", "new": "b"}',
            '{"ts": 2, "file": "review.html", "element_id": "_pp_2", '
            '"action": "edit", "kind": "text", "old": "c", "new": "d"}',
            '{"ts": 3, "file": "other.md", "element_id": "_pp_3", '
            '"action": "edit", "kind": "text", "old": "e", "new": "f"}',
        ]
        (ws / 'edits.jsonl').write_text('\n'.join(records) + '\n', encoding='utf-8')
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        # stem-matched across the old (.html) and new (.md) naming
        assert 'review.md · 1 annotation · 2 direct edits' in out
        # the edits section lists every new record, even non-master ones
        assert '── direct edits · 3 ──' in out
        assert 'other.md _pp_3: f(原:e)' in out


class TestDirectEdits:
    def test_doc_with_only_edits_gets_header(self, tmp_path, capsys):
        # 0002: the header (doc name · annotation count · direct-edit
        # count) is per doc - a zero-marker doc with pending edits must
        # still be announced, not just dumped in the edits section.
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing marked.\n')
        (ws / 'edits.jsonl').write_text(
            '{"ts": 1, "file": "clean.md", "element_id": "_pp_0", '
            '"action": "edit", "kind": "text", "old": "a", "new": "b"}\n',
            encoding='utf-8')
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'clean.md · 0 annotations · 1 direct edit' in out
        assert '(原:a)' in out

    def test_edit_record_shown_as_new_vs_old(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing marked.\n')
        (ws / 'edits.jsonl').write_text(
            '{"ts": 1, "file": "clean.md", "element_id": "_pp_3", '
            '"action": "edit", "kind": "text", '
            '"old": "old text", "new": "new text"}\n',
            encoding='utf-8',
        )
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'new text(原:old text)' in out
        assert '_pp_3' in out

    def test_second_run_shows_nothing_new(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing marked.\n')
        (ws / 'edits.jsonl').write_text(
            '{"ts": 1, "file": "clean.md", "element_id": "_pp_3", '
            '"action": "edit", "kind": "text", "old": "a", "new": "b"}\n',
            encoding='utf-8',
        )
        assert digest.main([str(ws)]) == 0
        capsys.readouterr()
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert '(原:' not in out
        assert '[OK]' in out
        state = json.loads((ws / 'state' / 'digest.json').read_text(encoding='utf-8'))
        assert state['edits_pos'] == 1

    def test_truncated_log_is_reread_from_start(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing marked.\n')
        (ws / 'edits.jsonl').write_text('\n'.join(['{}'] * 5) + '\n', encoding='utf-8')
        assert digest.main([str(ws)]) == 0
        capsys.readouterr()
        # log recreated from scratch (e.g. workspace reset): 1 real record
        (ws / 'edits.jsonl').write_text(
            '{"ts": 1, "file": "clean.md", "element_id": "_pp_0", '
            '"action": "edit", "kind": "text", "old": "a", "new": "b"}\n',
            encoding='utf-8',
        )
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'new text' not in out  # sanity: different record
        assert '(原:a)' in out

    def test_unreadable_master_does_not_consume_edits(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'broken.md', '<!-- pp: dangling -->\n')  # annotates nothing
        (ws / 'edits.jsonl').write_text(
            '{"ts": 1, "file": "broken.md", "element_id": "_pp_0", '
            '"action": "edit", "kind": "text", "old": "a", "new": "b"}\n',
            encoding='utf-8',
        )
        rc = digest.main([str(ws)])
        captured = capsys.readouterr()
        assert rc == 1
        assert 'broken.md' in captured.err
        # fix the master: the edit must still be shown next round
        write_master(ws, 'broken.md', '<!-- pp: fine now -->\n\nText.\n')
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert '(原:a)' in out

    def test_missing_edits_log_is_fine(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing marked.\n')
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'direct edits' not in out

    def test_bom_in_edits_log_is_tolerated(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing marked.\n')
        record = ('{"ts": 1, "file": "clean.md", "element_id": "_pp_0", '
                  '"action": "edit", "kind": "text", "old": "a", "new": "b"}\n')
        (ws / 'edits.jsonl').write_bytes(b'\xef\xbb\xbf' + record.encode('utf-8'))
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert '(原:a)' in out


class TestLineNotes:
    def test_line_note_quotes_fence_with_pointer(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'review.md', MASTER_LINE_NOTE)
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'review.md · 1 annotation · 0 direct edits' in out
        # fence quoted, annotated line carries the pp@N pointer + note
        assert '```python' in out
        assert 'b = 2   ← pp@2: rename this variable' in out
        assert 'a = 1' in out and 'c = 3' in out
        # no bare marker line for line notes (the pointer replaces it)
        assert '<!-- pp@2:' not in out

    def test_line_note_window_is_plus_minus_two(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'long.md', MASTER_LONG_FENCE)
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        # window = lines 3..7 of the fence, plus both fence lines
        for line in ('line-3', 'line-4', 'line-5', 'line-6', 'line-7'):
            assert line in out
        assert 'line-5   ← pp@5: dead code here' in out
        assert 'line-1' not in out and 'line-8' not in out
        # elision is visible, the fence never silently shrinks
        assert '…' in out
        assert out.count('```') >= 2


class TestBlockNotes:
    def test_header_summary_reminder_hint(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'review.md', MASTER_ONE_NOTE)
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        # header: doc name · annotation count · direct-edit count
        assert 'review.md · 1 annotation · 0 direct edits' in out
        # one-line marker syntax reminder + next-step hint
        assert '<!-- pp:' in out and '<!-- pp@N:' in out
        assert '下一步' in out and 'consume' in out
        # section header carries the doc name
        assert 'review.md' in out

    def test_block_note_quotes_marker_line_and_block(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'review.md', MASTER_ONE_NOTE)
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'rewrite this intro' in out
        assert '<!-- pp: rewrite this intro -->' in out
        assert 'Intro paragraph with stale content.' in out
        # the note is consumed nowhere else; nothing from the doc is dropped silently
        assert '[OK]' not in out

    def test_block_note_on_code_block_quotes_fence(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'code.md', MASTER_CODE_BLOCK_NOTE)
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'review the whole block' in out
        assert '```python' in out
        assert 'a = 1' in out and 'b = 2' in out

    def test_unannotated_docs_are_not_listed(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing marked.\n')
        write_master(ws, 'review.md', MASTER_ONE_NOTE)
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'clean.md' not in out


class TestCli:
    def test_no_annotations_quiet_ok(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        (ws / 'docs' / 'clean.md').write_text('# T\n\nNothing marked.\n', encoding='utf-8')
        rc = digest.main([str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert '[OK]' in out
        assert 'No annotations' in out

    def test_missing_workspace_exit_1(self, tmp_path, capsys):
        rc = digest.main([str(tmp_path / 'nope')])
        assert rc == 1
        assert 'not found' in capsys.readouterr().err

    def test_workspace_without_docs_dir_exit_1(self, tmp_path, capsys):
        rc = digest.main([str(tmp_path)])
        assert rc == 1
        assert 'docs' in capsys.readouterr().err


class TestStateSharing:
    """digest.py and wait.py share state/digest.json: the edits
    position and wait.py's apply_epoch must survive each other's
    writes (0015)."""

    def test_write_state_merges_keys(self, tmp_path):
        digest.write_state(tmp_path, 5)
        digest.write_state(tmp_path, 7, apply_epoch=3)
        state = json.loads(
            (tmp_path / 'state' / 'digest.json').read_text(encoding='utf-8'))
        assert state == {'edits_pos': 7, 'apply_epoch': 3}

    def test_plain_run_preserves_apply_epoch(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        digest.write_state(ws, 0, apply_epoch=4)
        write_master(ws, 'a.md', MASTER_ONE_NOTE)
        assert digest.main([str(ws)]) == 0
        state = json.loads(
            (ws / 'state' / 'digest.json').read_text(encoding='utf-8'))
        assert state['apply_epoch'] == 4

    def test_run_with_apply_epoch_updates_it(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        digest.write_state(ws, 0, apply_epoch=4)
        write_master(ws, 'a.md', MASTER_ONE_NOTE)
        assert digest.run(ws, apply_epoch=9) == 0
        state = json.loads(
            (ws / 'state' / 'digest.json').read_text(encoding='utf-8'))
        assert state['apply_epoch'] == 9

    def test_read_apply_epoch(self, tmp_path):
        assert digest.read_apply_epoch(tmp_path) is None
        digest.write_state(tmp_path, 0, apply_epoch=2)
        assert digest.read_apply_epoch(tmp_path) == 2
        (tmp_path / 'state' / 'digest.json').write_text(
            '{"apply_epoch": -1}', encoding='utf-8')
        assert digest.read_apply_epoch(tmp_path) is None

    def test_peek_pending(self, tmp_path):
        ws = make_workspace(tmp_path)
        write_master(ws, 'clean.md', '# T\n\nNothing.\n')
        assert digest.peek_pending(ws) is False
        write_master(ws, 'noted.md', MASTER_ONE_NOTE)
        assert digest.peek_pending(ws) is True
        # new edits.jsonl records count too
        (ws / 'noted.md').write_text('# T\n\nNothing.\n', encoding='utf-8')
        with open(ws / 'edits.jsonl', 'a', encoding='utf-8') as fh:
            fh.write(json.dumps({'action': 'edit', 'new': 'x'}) + '\n')
        assert digest.peek_pending(ws) is True
