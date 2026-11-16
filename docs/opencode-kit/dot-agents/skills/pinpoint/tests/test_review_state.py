"""Tests for review_state.py - the per-doc empty-block state (0026).

An Apply's interpretation of its untouched blocks ('undecided' by
default, 'agreed' on explicit choice) is first-class state: recorded
on disk, superseded only by a later Apply, with a full-agreement
Apply (nothing staged) approving every doc.
"""

from pathlib import Path

import review_state


def test_read_absent_state_is_empty(tmp_path: Path):
    assert review_state.read(tmp_path) == {}


def test_read_corrupt_state_is_empty(tmp_path: Path):
    state_dir = tmp_path / 'state'
    state_dir.mkdir()
    (state_dir / 'empties.json').write_text('{not json', encoding='utf-8')
    assert review_state.read(tmp_path) == {}


def test_record_partial_apply_touches_only_modified(tmp_path: Path):
    state = review_state.record(
        tmp_path, modified=['plan.md'], empties='undecided',
        doc_names=['plan.md', 'other.md'])
    assert state == {'plan.md': 'undecided'}
    assert review_state.read(tmp_path) == {'plan.md': 'undecided'}


def test_record_does_not_touch_unmodified_docs(tmp_path: Path):
    review_state.record(
        tmp_path, modified=['other.md'], empties='undecided',
        doc_names=['plan.md', 'other.md'])
    # a later agreed Apply on plan.md must not un-converge other.md
    state = review_state.record(
        tmp_path, modified=['plan.md'], empties='agreed',
        doc_names=['plan.md', 'other.md'])
    assert state == {'other.md': 'undecided', 'plan.md': 'agreed'}


def test_record_full_agreement_approves_every_doc(tmp_path: Path):
    review_state.record(
        tmp_path, modified=['plan.md'], empties='undecided',
        doc_names=['plan.md', 'other.md'])
    state = review_state.record(
        tmp_path, modified=[], empties='ignored-on-full-agreement',
        doc_names=['plan.md', 'other.md'])
    assert state == {'plan.md': 'agreed', 'other.md': 'agreed'}


def test_normalize_accepts_only_known_values():
    assert review_state.normalize('undecided') == 'undecided'
    assert review_state.normalize('agreed') == 'agreed'
    assert review_state.normalize(None) is None
    assert review_state.normalize('yes') is None
    assert review_state.normalize(['agreed']) is None


def test_state_file_is_lf_only(tmp_path: Path):
    # IR-1: written artifacts are byte-identical across platforms.
    review_state.record(
        tmp_path, modified=['plan.md'], empties='undecided', doc_names=[])
    raw = review_state.state_path(tmp_path).read_bytes()
    assert b'\r' not in raw
