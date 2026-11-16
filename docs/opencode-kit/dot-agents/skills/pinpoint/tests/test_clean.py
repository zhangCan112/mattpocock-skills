"""Tests for clean.py - archive provably finished reviews safely.

The cleaner reuses export's convergence gate (0026) as its only
notion of "done": unconsumed markers and an undecided last Apply keep
a doc alive forever. Everything else must be provably finished (or
provably stale, marker-free and stance-less) before it leaves the
workspace — and it leaves to archive/, not the void.
"""

import json
import os
import time
from pathlib import Path

import clean as clean_mod
import review_state

DAYS = 86400

MASTER_PENDING = """# Plan

<!-- pp: reword this -->
The intro paragraph.

<!-- pp@2: rename B -->
```mermaid
flowchart LR
A --> B
```
"""

MASTER_CLEAN = """# Plan

The intro paragraph.
"""

LEGACY_PENDING = (
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"/>'
    '<title>t</title></head><body>'
    '<h1>Plan</h1><p>Hello world.</p>'
    '<h2 id="_pp_0" data-edit-target="true" '
    'data-edit-annotation="reword">Head</h2>'
    '</body></html>'
)

LEGACY_CLEAN = (
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"/>'
    '<title>t</title></head><body>'
    '<h1>Plan</h1><p>Hello world.</p>'
    '</body></html>'
)


def make_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / '.pinpoint'
    (workspace / 'docs').mkdir(parents=True)
    (workspace / 'state').mkdir()
    return workspace


def age(file: Path, days_old: float) -> None:
    stamp = time.time() - days_old * DAYS
    os.utime(file, (stamp, stamp))


def set_agreed(workspace: Path, doc: str) -> None:
    """A full-agreement Apply approves the doc (0015/0026)."""
    review_state.record(workspace, [], 'agreed', [doc])


def set_undecided(workspace: Path, doc: str) -> None:
    """A partial Apply left the untouched blocks undecided (0026)."""
    review_state.record(workspace, [doc], 'undecided', [doc])


class TestDocVerdicts:
    def test_pending_markers_keep_even_with_apply(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'review.md'
        doc.write_text(MASTER_PENDING, encoding='utf-8')
        set_agreed(ws, 'review.md')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        out = capsys.readouterr().out
        assert 'KEEP    docs/review.md' in out
        assert 'unconsumed' in out
        assert doc.exists()  # the user's words are never garbage

    def test_undecided_hold_keeps(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'review.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_undecided(ws, 'review.md')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert 'undecided' in capsys.readouterr().out
        assert doc.exists()

    def test_converged_archived_with_state(
            self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'review.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        (ws / 'state' / 'review.base.md').write_text(
            MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'review.md')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        out = capsys.readouterr().out
        assert not doc.exists()
        assert not (ws / 'state' / 'review.base.md').exists()
        batches = list((ws / 'archive').iterdir())
        assert len(batches) == 1
        assert (batches[0] / 'docs' / 'review.md').is_file()
        assert (batches[0] / 'state' / 'review.base.md').is_file()
        # the archived doc's empties entry left with it
        state = json.loads(
            (ws / 'state' / 'empties.json').read_text(encoding='utf-8'))
        assert 'review.md' not in state
        assert 'archived docs/review' in out

    def test_no_stance_stale_swept(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'old.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        age(doc, 40)
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert not doc.exists()
        assert list((ws / 'archive').iterdir())

    def test_no_stance_fresh_kept(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'new.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert doc.exists()
        assert 'no stance recorded' in capsys.readouterr().out

    def test_stale_days_zero_disables_time_rule(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'old.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        age(doc, 400)
        rc = clean_mod.main([str(ws), '--apply', '--stale-days', '0'])
        assert rc == 0
        assert doc.exists()

    def test_legacy_with_annotations_kept(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'legacy.html'
        doc.write_text(LEGACY_PENDING, encoding='utf-8')
        age(doc, 400)  # even ancient: the user's words survive
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert doc.exists()
        assert 'unconsumed' in capsys.readouterr().out

    def test_legacy_stale_swept(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'legacy.html'
        doc.write_text(LEGACY_CLEAN, encoding='utf-8')
        age(doc, 40)
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert not doc.exists()


class TestLeftoversAndOrphans:
    def test_migration_leftover_swept_master_alive(self, tmp_path):
        ws = make_workspace(tmp_path)
        master = ws / 'docs' / 'x.md'
        master.write_text(MASTER_PENDING, encoding='utf-8')  # alive: KEEP
        leftover = ws / 'docs' / 'x.html'
        leftover.write_text(LEGACY_CLEAN, encoding='utf-8')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert master.exists()
        assert not leftover.exists()
        assert list((ws / 'archive').rglob('x.html'))

    def test_orphan_baseline_swept(self, tmp_path):
        ws = make_workspace(tmp_path)
        base = ws / 'state' / 'ghost.base.md'
        base.write_text(MASTER_CLEAN, encoding='utf-8')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert not base.exists()
        assert list((ws / 'archive').rglob('ghost.base.md'))

    def test_living_docs_baseline_stays(self, tmp_path):
        ws = make_workspace(tmp_path)
        (ws / 'docs' / 'x.md').write_text(MASTER_PENDING,
                                          encoding='utf-8')
        base = ws / 'state' / 'x.base.md'
        base.write_text(MASTER_CLEAN, encoding='utf-8')
        clean_mod.main([str(ws), '--apply'])
        assert base.exists()


class TestAssets:
    def test_unreferenced_asset_swept_referenced_kept(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text('# T\n\nsee assets/keep.png\n', encoding='utf-8')
        assets = ws / 'assets'
        assets.mkdir()
        (assets / 'keep.png').write_bytes(b'png')
        (assets / 'drop.png').write_bytes(b'png')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert (assets / 'keep.png').exists()
        assert not (assets / 'drop.png').exists()
        assert list((ws / 'archive').rglob('drop.png'))

    def test_asset_referenced_by_root_source_kept(self, tmp_path):
        ws = make_workspace(tmp_path)
        (ws / 'docs' / 'x.md').write_text(MASTER_CLEAN, encoding='utf-8')
        (ws / 'source.md').write_text(
            'original reply used ![](img/shot.png)', encoding='utf-8')
        assets = ws / 'assets'
        assets.mkdir()
        (assets / 'shot.png').write_bytes(b'png')
        clean_mod.main([str(ws), '--apply'])
        assert (assets / 'shot.png').exists()

    def test_archived_docs_asset_follows_it(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text('# T\n\nsee assets/fig.png\n', encoding='utf-8')
        set_agreed(ws, 'x.md')
        (ws / 'assets').mkdir()
        (ws / 'assets' / 'fig.png').write_bytes(b'png')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert not (ws / 'assets' / 'fig.png').exists()
        assert list((ws / 'archive').rglob('fig.png'))


class TestNameMode:
    def test_converged_named_doc_archived(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        rc = clean_mod.main([str(ws), '--name', 'x', '--apply'])
        assert rc == 0
        assert not doc.exists()
        assert list((ws / 'archive').rglob('x.md'))

    def test_unconverged_named_doc_refused(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_PENDING, encoding='utf-8')
        rc = clean_mod.main([str(ws), '--name', 'x', '--apply'])
        assert rc == 1
        assert doc.exists()
        assert 'unconsumed' in capsys.readouterr().err

    def test_name_leaves_other_docs_and_their_assets_alone(
            self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        other = ws / 'docs' / 'y.md'
        other.write_text('# Y\n\nuses assets/y.png\n', encoding='utf-8')
        (ws / 'assets').mkdir()
        (ws / 'assets' / 'y.png').write_bytes(b'png')
        rc = clean_mod.main([str(ws), '--name', 'x', '--apply'])
        assert rc == 0
        assert other.exists()
        assert (ws / 'assets' / 'y.png').exists()

    def test_unknown_name_refused(self, tmp_path):
        ws = make_workspace(tmp_path)
        rc = clean_mod.main([str(ws), '--name', 'nope', '--apply'])
        assert rc == 1


class TestSafety:
    def test_dry_run_writes_nothing(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        rc = clean_mod.main([str(ws)])
        assert rc == 0
        out = capsys.readouterr().out
        assert 'ARCHIVE docs/x.md' in out
        assert 'dry-run' in out
        assert doc.exists()
        assert not (ws / 'archive').exists()
        empties = json.loads(
            (ws / 'state' / 'empties.json').read_text(encoding='utf-8'))
        assert 'x.md' in empties

    def test_audit_log_never_touched(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        log = ws / 'annotations.jsonl'
        log.write_text('{"ts": 1}\n', encoding='utf-8')
        clean_mod.main([str(ws), '--apply', '--hard'])
        assert log.read_text(encoding='utf-8') == '{"ts": 1}\n'

    def test_hard_deletes_instead_of_archiving(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        rc = clean_mod.main([str(ws), '--hard'])
        assert rc == 0
        assert not doc.exists()
        assert not (ws / 'archive').exists()

    def test_live_server_refuses_apply(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        (ws / 'lock.json').write_text(
            json.dumps({'pid': os.getpid(), 'port': 8901}),
            encoding='utf-8')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 1
        assert doc.exists()  # refused: a live Apply would resurrect it
        assert 'server is holding' in capsys.readouterr().err

    def test_force_overrides_live_server(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        (ws / 'lock.json').write_text(
            json.dumps({'pid': os.getpid(), 'port': 8901}),
            encoding='utf-8')
        rc = clean_mod.main([str(ws), '--apply', '--force'])
        assert rc == 0
        assert not doc.exists()

    def test_stale_lock_does_not_block(self, tmp_path):
        ws = make_workspace(tmp_path)
        doc = ws / 'docs' / 'x.md'
        doc.write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        (ws / 'lock.json').write_text(
            json.dumps({'pid': 99999999, 'port': 8901}), encoding='utf-8')
        rc = clean_mod.main([str(ws), '--apply'])
        assert rc == 0
        assert not doc.exists()

    def test_bad_workspace_refused(self, tmp_path):
        rc = clean_mod.main([str(tmp_path / 'nope')])
        assert rc == 1

    def test_restore_path_printed(self, tmp_path, capsys):
        ws = make_workspace(tmp_path)
        (ws / 'docs' / 'x.md').write_text(MASTER_CLEAN, encoding='utf-8')
        set_agreed(ws, 'x.md')
        clean_mod.main([str(ws), '--apply'])
        out = capsys.readouterr().out
        assert 'restore anytime: move files back from archive/' in out
