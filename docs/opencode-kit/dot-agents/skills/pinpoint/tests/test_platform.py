"""Platform-form tests (AGENTS.md IR-1): written artifacts are
byte-identical between Windows and macOS.

Each assertion here is platform-independent: it passes on any OS and
fails when a write path regresses to ``os.linesep`` translation (CRLF
on Windows) or a read path stops tolerating foreign newlines. macOS has
no test environment in this repo — these tests are how the LF contract
stays enforced from Windows alone.
"""

from pathlib import Path

import export as export_mod
import migrate
import render
from server_common import write_text_lf


def assert_lf_only(path: Path) -> None:
    data = path.read_bytes()
    assert b'\r' not in data, f'{path.name} carries CR bytes (CRLF write)'


class TestWriteTextLf:
    def test_lf_only_on_every_platform(self, tmp_path):
        target = tmp_path / 'f.txt'
        write_text_lf(target, 'a\nb\n')
        assert target.read_bytes() == b'a\nb\n'

    def test_workspace_gitignore_guard_is_lf(self, tmp_path):
        from server_common import ensure_workspace
        ensure_workspace(tmp_path / '.pinpoint')
        assert_lf_only(tmp_path / '.pinpoint' / '.gitignore')


class TestArtifactsAreLfOnly:
    def test_rendered_doc_html_is_lf_only(self, tmp_path):
        src = tmp_path / 'in.md'
        src.write_text(
            '# T\n\nbody\n\n```mermaid\nflowchart LR\nA-->B\n```\n',
            encoding='utf-8',
        )
        out = render.build_doc_from_input(src, tmp_path / 'ws', name='doc')
        assert_lf_only(out)

    def test_migrated_master_and_baseline_are_lf_only(self, tmp_path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'legacy.html').write_text(
            '<h1>Plan</h1><p>Body.</p>', encoding='utf-8',
        )
        migrate.migrate_legacy_doc(
            docs / 'legacy.html',
            docs / 'legacy.md',
            tmp_path / 'archive' / 'legacy.html',
            tmp_path / 'state' / 'legacy.base.md',
        )
        assert_lf_only(docs / 'legacy.md')
        assert_lf_only(tmp_path / 'state' / 'legacy.base.md')

    def test_exported_markdown_is_lf_only(self, tmp_path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'review.md').write_text(
            '# Plan\n\n<!-- pp: fix -->\nbody\n', encoding='utf-8',
        )
        out = tmp_path / 'final.md'
        # the marker makes the doc unconverged (0026): --draft still
        # exports, and every written byte stays LF-only
        rc = export_mod.main(
            ['review', '--workspace', str(tmp_path), '--draft',
             '--output', str(out)],
        )
        assert rc == 0
        assert_lf_only(out)


class TestForeignNewlineTolerance:
    def test_crlf_master_input_is_consumed_as_lf(self, tmp_path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'crlf.md').write_bytes(b'# Plan\r\nbody\r\n')
        out = tmp_path / 'final.md'
        rc = export_mod.main(
            ['crlf', '--workspace', str(tmp_path), '--output', str(out)],
        )
        assert rc == 0
        # canonical serialization separates blocks with a blank line
        assert out.read_bytes() == b'# Plan\n\nbody\n'
