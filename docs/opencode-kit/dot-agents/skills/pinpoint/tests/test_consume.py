"""Tests for consume.py - the master-doc reconciliation CLI (0012).

consume compares the baseline snapshot (.pinpoint/state/<doc>.base.md)
against the current master (.pinpoint/docs/<doc>.md), using the prototype
semantics (branch prototype/0004-consume-interface): LCS re-anchoring on
content keys, in-order pairing of leftovers, marker reconciliation driving
acks, and the 0009 red-line (a block deleted together with its unresolved
marker refuses the whole submission).
"""

import json
from pathlib import Path

import consume


MASTER = '# Deploy plan\n\nIntro paragraph.\n\n```python\na = 1\nb = 2\n```\n'

BASELINE_MARKED = (
    '# Deploy plan\n\n'
    '<!-- pp: tighten this -->\n\nIntro paragraph.\n\n'
    '```python\na = 1\nb = 2\n```\n'
)


def make_ws(
    tmp_path: Path, name: str = 'review',
    master: str = MASTER, baseline: 'str | None' = None,
) -> Path:
    """Create a workspace with a master doc and an optional baseline."""
    docs = tmp_path / 'docs'
    docs.mkdir(exist_ok=True)
    (docs / f'{name}.md').write_text(master, encoding='utf-8')
    if baseline is not None:
        state = tmp_path / 'state'
        state.mkdir(exist_ok=True)
        (state / f'{name}.base.md').write_text(baseline, encoding='utf-8')
    return tmp_path


def read_log(ws: Path) -> list:
    log = ws / 'annotations.jsonl'
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()]


class TestStructureChanges:
    def test_delete_unmarked_block_is_allowed(self, tmp_path, capsys):
        baseline = '# T\n\nFirst.\n\nSecond.\n'
        master = '# T\n\nFirst.\n'
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b3 deleted' in out
        assert read_log(ws) == []
        assert (ws / 'state' / 'review.base.md').read_text(encoding='utf-8') == master

    def test_redline_marked_block_deleted_refuses_everything(self, tmp_path, capsys):
        baseline = '# T\n\n<!-- pp: keep this -->\n\nMarked body.\n\nPlain.\n'
        master = '# T\n\nPlain.\n'
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        before_master = (ws / 'docs' / 'review.md').read_bytes()
        before_base = (ws / 'state' / 'review.base.md').read_bytes()
        rc = consume.main(['review', '--workspace', str(ws)])
        captured = capsys.readouterr()
        assert rc == 1
        assert 'b2' in captured.err
        assert 'keep this' in captured.err
        assert 'Resolve the annotation first' in captured.err
        assert (ws / 'docs' / 'review.md').read_bytes() == before_master
        assert (ws / 'state' / 'review.base.md').read_bytes() == before_base
        assert read_log(ws) == []

    def test_lcs_reanchors_unmoved_marker_across_insertion(self, tmp_path, capsys):
        # The marked para is unchanged but shifts from position 2 to 3 (a
        # new heading is inserted before it) and its marker was removed:
        # LCS re-anchors it by content key, so the ack lands on b2.
        baseline = ('# T\n\n'
                    '<!-- pp: tighten this -->\n\nIntro paragraph.\n\n'
                    '```python\na = 1\n```\n')
        master = ('# T\n\n'
                  '# New section\n\n'
                  'Intro paragraph.\n\n'
                  '```python\na = 1\n```\n')
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 annotation acked (marker removed)' in out
        assert 'new block b4 (heading)' in out
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['element_id'] == 'b2'
        assert records[0]['new'] is None

    def test_insertion_adjacent_to_changed_block_pairs_in_order(self, tmp_path, capsys):
        # 0004 semantics: LCS anchors only content-UNCHANGED blocks; within
        # an anchor gap the leftovers pair in order. A new heading inserted
        # directly before a rewritten para therefore pairs with the old para
        # (inheriting the ack), and the rewritten para is a fresh block.
        baseline = ('# T\n\n'
                    '<!-- pp: tighten this -->\n\nIntro paragraph.\n\n'
                    '```python\na = 1\n```\n')
        master = ('# T\n\n'
                  '# New section\n\n'
                  'Tight intro.\n\n'
                  '```python\na = 1\n```\n')
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 annotation acked (content changed: fix disposes the note)' in out
        assert 'new block b4 (para)' in out
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['element_id'] == 'b2'
        assert records[0]['new'] == '# New section'

    def test_split_pairs_first_new_block_in_order(self, tmp_path, capsys):
        # One baseline block becomes two: the first new block pairs with the
        # old one (fix-and-ack), the second is a fresh block.
        baseline = ('# T\n\n'
                    '<!-- pp: split this -->\n\n'
                    'First half. Second half.\n')
        master = ('# T\n\n'
                  'First half, rewritten.\n\n'
                  'Second half.\n')
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 annotation acked (content changed: fix disposes the note)' in out
        assert 'new block b3 (para)' in out
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['element_id'] == 'b2'

    def test_unmarked_changed_block_reports_content_updated(self, tmp_path, capsys):
        baseline = '# T\n\nOld body.\n'
        master = '# T\n\nNew body.\n'
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 content updated' in out
        assert read_log(ws) == []


class TestMarkerAcks:
    def test_marker_removed_is_a_plain_ack(self, tmp_path, capsys):
        ws = make_ws(tmp_path, baseline=BASELINE_MARKED)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 annotation acked (marker removed)' in out
        records = read_log(ws)
        assert len(records) == 1
        rec = records[0]
        assert rec['file'] == 'review.md'
        assert rec['element_id'] == 'b2'
        assert rec['action'] == 'annotation_applied'
        assert rec['old'] == 'tighten this'
        assert rec['new'] is None
        assert isinstance(rec['ts'], float)
        # nothing changed in the master: canonical text equals the file,
        # so the master stays byte-untouched; baseline is refreshed.
        assert (ws / 'docs' / 'review.md').read_text(encoding='utf-8') == MASTER
        assert (ws / 'state' / 'review.base.md').read_text(encoding='utf-8') == MASTER

    def test_content_changed_and_marker_removed_is_fix_and_ack(self, tmp_path, capsys):
        new_text = 'Tight intro sentence.'
        master = (
            '# Deploy plan\n\n'
            f'{new_text}\n\n'
            '```python\na = 1\nb = 2\n```\n'
        )
        ws = make_ws(tmp_path, master=master, baseline=BASELINE_MARKED)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 annotation acked (content changed: fix disposes the note)' in out
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['old'] == 'tighten this'
        assert records[0]['new'] == new_text
        # the edited master was already canonical: byte-untouched
        assert (ws / 'docs' / 'review.md').read_text(encoding='utf-8') == master

    def test_marker_still_present_is_pending_without_ack(self, tmp_path, capsys):
        ws = make_ws(tmp_path, baseline=BASELINE_MARKED, master=BASELINE_MARKED)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 marker still present - annotation pending' in out
        assert read_log(ws) == []
        assert '<!-- pp: tighten this -->' in (
            ws / 'docs' / 'review.md').read_text(encoding='utf-8')

    def test_unchanged_unmarked_doc_is_a_silent_noop(self, tmp_path, capsys):
        ws = make_ws(tmp_path, baseline=MASTER)
        before = (ws / 'docs' / 'review.md').read_bytes()
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert read_log(ws) == []
        assert (ws / 'docs' / 'review.md').read_bytes() == before

    def test_new_marker_on_unmarked_block_is_kept_not_acked(self, tmp_path, capsys):
        master = ('# Deploy plan\n\n'
                  '<!-- pp: brand new note -->\n\nIntro paragraph.\n\n'
                  '```python\na = 1\nb = 2\n```\n')
        ws = make_ws(tmp_path, master=master, baseline=MASTER)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 new block annotation attached' in out
        assert read_log(ws) == []
        assert '<!-- pp: brand new note -->' in (
            ws / 'docs' / 'review.md').read_text(encoding='utf-8')


class TestLineMarkers:
    BASELINE = ('```python\n'
                'deploy:\n'
                '  timeout: 120\n'
                '  retries: 3\n'
                '```\n')

    def baseline(self) -> str:
        return ('<!-- pp@2: timeout 改成 30 -->\n\n' + self.BASELINE)

    def test_line_changed_and_marker_removed_is_fix_and_ack(self, tmp_path, capsys):
        master = self.BASELINE.replace('  timeout: 120', '  timeout: 30')
        ws = make_ws(tmp_path, master=master, baseline=self.baseline())
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b1 line 2 annotation acked (content changed: fix disposes the note)' in out
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['old'] == 'timeout 改成 30'
        assert records[0]['new'] == '  timeout: 30'

    def test_line_marker_removed_but_other_line_changed_is_plain_ack(self, tmp_path, capsys):
        # refinement over the prototype: fix+ack attribution is per line,
        # not per block - line 2 is byte-identical, so the note was
        # explained away, not fixed by the edit to line 3.
        master = self.BASELINE.replace('  retries: 3', '  retries: 5')
        ws = make_ws(tmp_path, master=master, baseline=self.baseline())
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b1 line 2 annotation acked (marker removed)' in out
        assert read_log(ws)[0]['new'] is None

    def test_line_marker_still_present_is_pending(self, tmp_path, capsys):
        ws = make_ws(tmp_path, master=self.baseline(), baseline=self.baseline())
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b1 line 2 marker still present - annotation pending' in out
        assert read_log(ws) == []
        assert '<!-- pp@2: timeout 改成 30 -->' in (
            ws / 'docs' / 'review.md').read_text(encoding='utf-8')

    def test_new_line_marker_attached(self, tmp_path, capsys):
        master = '<!-- pp@3: dead code? -->\n\n' + self.BASELINE
        ws = make_ws(tmp_path, master=master, baseline=self.BASELINE)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b1 new line marker pp@3 attached' in out
        assert read_log(ws) == []

    def test_insert_above_marker_moves_with_line_stays_pending(self, tmp_path, capsys):
        # Line notes align old->new fence lines by CONTENT, not position:
        # an unrelated line inserted above the annotated line shifts the
        # note from pp@2 to pp@3, and the marker moving with its line is
        # the SAME note, still pending - never acked via its old position.
        master = ('<!-- pp@3: timeout 改成 30 -->\n\n'
                  '```python\n'
                  'deploy:\n'
                  '  protocol: https\n'
                  '  timeout: 120\n'
                  '  retries: 3\n'
                  '```\n')
        ws = make_ws(tmp_path, master=master, baseline=self.baseline())
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b1 line 2 marker still present - annotation pending' in out
        assert 'new line marker' not in out  # moved, not newly attached
        assert read_log(ws) == []
        assert '<!-- pp@3: timeout 改成 30 -->' in (
            ws / 'docs' / 'review.md').read_text(encoding='utf-8')

    def test_insert_above_removed_marker_is_plain_ack_not_fix(self, tmp_path, capsys):
        # Same insertion with the marker deleted: the annotated line is
        # byte-identical, so the note was explained away, not fixed by
        # the unrelated insertion - plain ack, no fabricated fix content.
        master = ('```python\n'
                  'deploy:\n'
                  '  protocol: https\n'
                  '  timeout: 120\n'
                  '  retries: 3\n'
                  '```\n')
        ws = make_ws(tmp_path, master=master, baseline=self.baseline())
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b1 line 2 annotation acked (marker removed)' in out
        assert 'fix disposes' not in out
        assert read_log(ws) == [
            {'ts': read_log(ws)[0]['ts'], 'file': 'review.md',
             'element_id': 'b1', 'action': 'annotation_applied',
             'old': 'timeout 改成 30', 'new': None},
        ]

    def test_marker_line_deleted_alone_is_plain_ack(self, tmp_path, capsys):
        # (regression) deleting just the marker line disposes the note as
        # a plain ack; the fence content is untouched.
        ws = make_ws(tmp_path, master=self.BASELINE, baseline=self.baseline())
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b1 line 2 annotation acked (marker removed)' in out
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['new'] is None


class TestExplainFlag:
    """--explain REF=TEXT: the explanation channel for notes resolved
    without a content change (0004: 解释文本进审计). No flag -> records
    carry no explain field, behavior unchanged."""

    def test_explain_attaches_to_plain_ack(self, tmp_path, capsys):
        ws = make_ws(tmp_path, baseline=BASELINE_MARKED)
        rc = consume.main(['review', '--workspace', str(ws),
                           '--explain', 'b2=kept as-is, on purpose'])
        captured = capsys.readouterr()
        assert rc == 0
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['element_id'] == 'b2'
        assert records[0]['new'] is None
        assert records[0]['explain'] == 'kept as-is, on purpose'

    def test_explain_attaches_to_line_note_ack(self, tmp_path, capsys):
        baseline = ('<!-- pp@2: timeout 改成 30 -->\n\n'
                    '```python\ndeploy:\n  timeout: 120\n```\n')
        master = '```python\ndeploy:\n  timeout: 120\n```\n'
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws),
                           '--explain', 'b1=line kept, explained in chat'])
        captured = capsys.readouterr()
        assert rc == 0
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['explain'] == 'line kept, explained in chat'

    def test_unmatched_explain_warns_and_does_not_fail(self, tmp_path, capsys):
        ws = make_ws(tmp_path, baseline=BASELINE_MARKED)
        rc = consume.main(['review', '--workspace', str(ws),
                           '--explain', 'b99=no such note'])
        captured = capsys.readouterr()
        assert rc == 0
        assert 'b99' in captured.err
        records = read_log(ws)
        assert len(records) == 1
        assert 'explain' not in records[0]

    def test_explain_on_fixed_note_warns(self, tmp_path, capsys):
        # a fix-and-ack carries its own content; an explanation for it
        # matches no plain ack
        master = ('# Deploy plan\n\nTight intro sentence.\n\n'
                  '```python\na = 1\nb = 2\n```\n')
        ws = make_ws(tmp_path, master=master, baseline=BASELINE_MARKED)
        rc = consume.main(['review', '--workspace', str(ws),
                           '--explain', 'b2=why'])
        captured = capsys.readouterr()
        assert rc == 0
        assert 'b2' in captured.err
        records = read_log(ws)
        assert len(records) == 1
        assert records[0]['new'] == 'Tight intro sentence.'
        assert 'explain' not in records[0]

    def test_malformed_explain_warns_and_does_not_fail(self, tmp_path, capsys):
        ws = make_ws(tmp_path, baseline=BASELINE_MARKED)
        rc = consume.main(['review', '--workspace', str(ws),
                           '--explain', 'no-equals-sign'])
        captured = capsys.readouterr()
        assert rc == 0
        assert 'no-equals-sign' in captured.err
        assert len(read_log(ws)) == 1
        assert 'explain' not in read_log(ws)[0]


class TestNormalization:
    def test_non_canonical_master_is_normalized(self, tmp_path, capsys):
        # same blocks minus the resolved marker, sloppy layout: doubled
        # blank lines, missing trailing newline.
        master = '# T\n\n\nIntro paragraph.\n\n\nSecond.\n'
        baseline = ('# T\n\n'
                    '<!-- pp: tighten this -->\n\n'
                    'Intro paragraph.\n\n'
                    'Second.\n')
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'b2 annotation acked (marker removed)' in out
        canonical = ('# T\n\nIntro paragraph.\n\nSecond.\n')
        assert (ws / 'docs' / 'review.md').read_text(encoding='utf-8') == canonical
        assert (ws / 'state' / 'review.base.md').read_text(encoding='utf-8') == canonical


class TestCliEdges:
    def test_doc_name_with_md_suffix(self, tmp_path, capsys):
        ws = make_ws(tmp_path)
        rc = consume.main(['review.md', '--workspace', str(ws)])
        assert rc == 0
        assert 'nothing to reconcile' in capsys.readouterr().out

    def test_unparseable_master_exit_1(self, tmp_path, capsys):
        # a marker at the end of the document annotates nothing
        master = '# T\n\n<!-- pp: dangling -->\n'
        ws = make_ws(tmp_path, master=master, baseline='# T\n')
        rc = consume.main(['review', '--workspace', str(ws)])
        err = capsys.readouterr().err
        assert rc == 1
        assert 'annotates nothing' in err

    def test_redline_refusal_writes_no_partial_audit(self, tmp_path, capsys):
        baseline = ('# T\n\n'
                    '<!-- pp: doomed note -->\n\nDoomed.\n\n'
                    '<!-- pp: resolved note -->\n\nResolved.\n')
        master = '# T\n\nResolved.\n'
        ws = make_ws(tmp_path, master=master, baseline=baseline)
        rc = consume.main(['review', '--workspace', str(ws)])
        assert rc == 1
        assert read_log(ws) == []

    def test_audit_records_are_utf8_json_lines(self, tmp_path, capsys):
        ws = make_ws(tmp_path, baseline=BASELINE_MARKED)
        assert consume.main(['review', '--workspace', str(ws)]) == 0
        raw = (ws / 'annotations.jsonl').read_text(encoding='utf-8')
        assert 'tighten this' in raw
        rec = json.loads(raw.splitlines()[0])
        assert set(rec) == {'ts', 'file', 'element_id', 'action', 'old', 'new'}

    def test_lcs_pairs_unit(self):
        assert consume.lcs_pairs([], []) == []
        assert consume.lcs_pairs(['a'], []) == []
        assert consume.lcs_pairs(['a', 'b'], ['a', 'b']) == [(0, 0), (1, 1)]
        assert consume.lcs_pairs(['a', 'b', 'c'], ['c', 'a', 'b']) == [(0, 1), (1, 2)]

    def test_fence_line_matches_unit(self):
        match = consume._fence_line_matches
        assert match([], []) == {}
        assert match(['a', 'b'], ['a', 'b']) == {0: 0, 1: 1}
        # an unrelated insertion above: each line follows its content
        assert match(['a', 'b', 'c'], ['a', 'x', 'b', 'c']) == {0: 0, 1: 2, 2: 3}
        # an edited line pairs in order within the anchor gap
        assert match(['a', 'b1', 'c'], ['a', 'b2', 'c']) == {0: 0, 1: 1, 2: 2}
        # deleted / inserted lines stay unmatched
        assert match(['a', 'b', 'c'], ['a', 'c']) == {0: 0, 2: 1}
        assert match(['a', 'c'], ['a', 'x', 'c']) == {0: 0, 1: 2}


class TestFirstRun:
    def test_corrupt_master_creates_no_baseline(self, tmp_path, capsys):
        # The master is parse-validated BEFORE the first-run baseline is
        # created: a corrupt master must not poison the baseline.
        master = '# T\n\n<!-- pp: dangling -->\n'  # annotates nothing
        ws = make_ws(tmp_path, master=master)
        rc = consume.main(['review', '--workspace', str(ws)])
        err = capsys.readouterr().err
        assert rc == 1
        assert 'annotates nothing' in err
        assert not (ws / 'state' / 'review.base.md').exists()
        assert (ws / 'docs' / 'review.md').read_text(encoding='utf-8') == master

    def test_no_baseline_creates_snapshot_and_reports_nothing(self, tmp_path, capsys):
        ws = make_ws(tmp_path)
        before = (ws / 'docs' / 'review.md').read_text(encoding='utf-8')
        rc = consume.main(['review', '--workspace', str(ws)])
        out = capsys.readouterr().out
        assert rc == 0
        assert 'nothing to reconcile' in out
        baseline = ws / 'state' / 'review.base.md'
        assert baseline.exists()
        assert baseline.read_text(encoding='utf-8') == before
        assert (ws / 'docs' / 'review.md').read_text(encoding='utf-8') == before

    def test_missing_master_exit_1(self, tmp_path, capsys):
        ws = tmp_path
        (ws / 'docs').mkdir()
        rc = consume.main(['review', '--workspace', str(ws)])
        err = capsys.readouterr().err
        assert rc == 1
        assert 'review' in err
