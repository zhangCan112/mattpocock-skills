"""Tests for wait.py - the blocking wait CLI (0015).

wait.py replaces the manual go signal: it blocks on /api/wait until a
confirmed Apply changes succeeds, then prints the digest. The HTTP
release semantics live in test_server.py (TestWaitEndpoint); these
tests cover the launch-decision logic and the startup failure modes.
"""

from pathlib import Path

import pytest

import wait


class TestDecideImmediate:
    def test_fresh_workspace_blocks(self):
        # nothing applied yet, nothing pending: sleep until the first Apply
        assert wait.decide_immediate(saved=None, current=0, pending=False) is False

    def test_pending_work_digests_now(self):
        # annotations applied before the wait started must not be slept on
        assert wait.decide_immediate(saved=0, current=0, pending=True) is True
        assert wait.decide_immediate(saved=5, current=5, pending=True) is True

    def test_missed_epoch_digests_now(self):
        # an Apply the last digest never saw — including a delete-only
        # Apply, which leaves no digest trace of its own
        assert wait.decide_immediate(saved=3, current=4, pending=False) is True

    def test_caught_up_blocks(self):
        assert wait.decide_immediate(saved=4, current=4, pending=False) is False


class TestFullAgreement:
    def test_only_explicitly_empty_files_count(self):
        assert wait.full_agreement([]) is True          # nothing staged
        assert wait.full_agreement(None) is False       # unknown / immediate
        assert wait.full_agreement(['a.md']) is False   # a real apply

    def test_approval_note_is_self_contained(self):
        assert 'full agreement' in wait.APPROVAL_NOTE


class TestReleaseNote:
    """0026: a witnessed release says what the Apply's untouched blocks
    mean — full agreement, undecided (a held position), or agreed."""

    def test_full_agreement_wins_over_empties(self):
        assert wait.release_note([], 'agreed') == wait.APPROVAL_NOTE
        assert wait.release_note([], None) == wait.APPROVAL_NOTE

    def test_undecided_release_gets_its_note(self):
        note = wait.release_note(['plan.md'], 'undecided')
        assert note == wait.UNDECIDED_NOTE
        assert 'empties=undecided' in note
        assert 'not approval' in note

    def test_agreed_release_gets_its_note(self):
        note = wait.release_note(['plan.md'], 'agreed')
        assert note == wait.AGREED_NOTE
        assert 'empties=agreed' in note
        assert 'converged' in note

    def test_immediate_or_old_server_release_says_nothing(self):
        assert wait.release_note(None, None) is None
        assert wait.release_note(None, 'undecided') is None

    def test_unknown_empties_value_says_nothing(self):
        assert wait.release_note(['plan.md'], None) is None
        assert wait.release_note(['plan.md'], 'banana') is None


class TestStartup:
    def test_no_server_exit_1(self, tmp_path, capsys):
        rc = wait.main([str(tmp_path)])
        assert rc == 1
        assert 'no pinpoint server running' in capsys.readouterr().err

    def test_missing_workspace_exit_1(self, tmp_path, capsys):
        rc = wait.main([str(tmp_path / 'nope')])
        assert rc == 1
        assert 'not found' in capsys.readouterr().err

    def test_stale_lock_exit_1(self, tmp_path, capsys):
        (tmp_path / 'lock.json').write_text(
            '{"pid": 99999999, "port": 6160}', encoding='utf-8')
        rc = wait.main([str(tmp_path)])
        assert rc == 1
        assert 'no pinpoint server running' in capsys.readouterr().err
