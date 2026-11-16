"""Tests for export.py - export the converged master as clean markdown.

Export reads a master (doc name or path), strips the marker lines, and
emits the content only. Legacy HTML docs without a master route through
the migration serializer; export never writes to the workspace.
"""

from pathlib import Path

import pytest

import export as export_mod
from export import export_document


BODY = """<h1>Plan</h1>
<p>Hello <strong>world</strong> with <em>emphasis</em> and <code>inline()</code> and <a href="http://x">a link</a>.</p>
<ul><li>one</li><li>two <strong>bold</strong></li></ul>
<ol><li>first</li><li>second</li></ol>
<blockquote><p>quoted wisdom</p></blockquote>
<pre data-lang="python"><code><span class="line">a = 1</span><span class="line">b = 2</span></code></pre>
<table><thead><tr><th>name</th><th>value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>
<hr/>
<p><img src="../assets/pic.png" alt="pic"/></p>
<h2 id="_pp_0" data-edit-target="true" data-edit-annotation="reword this">Annotated Heading</h2>
<p id="_pp_1" data-edit-target="true" data-edit-annotation="中文注解">带注解的段落。</p>"""


FULL_HTML = (
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"/><title>t</title></head>'
    f'<body>{BODY}</body></html>'
)


MASTER = """# Plan

<!-- pp: reword this -->
The intro paragraph.

<!-- pp@2: rename B -->
```mermaid
flowchart LR
A --> B
```
"""


class TestDocNameResolution:
    def test_name_resolves_to_workspace_master(self, tmp_path, capsys):
        # the name resolves (the refusal is the 0026 convergence gate,
        # not a resolution failure: MASTER carries unconsumed markers)
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'review.md').write_text(MASTER, encoding='utf-8')
        rc = export_mod.main(['review', '--workspace', str(tmp_path)])
        assert rc == 1
        assert 'not converged' in capsys.readouterr().err

    def test_name_with_md_suffix_resolves(self, tmp_path, capsys):
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'review.md').write_text(MASTER, encoding='utf-8')
        rc = export_mod.main(['review.md', '--workspace', str(tmp_path)])
        assert rc == 1
        assert 'not converged' in capsys.readouterr().err

    def test_name_prefers_master_over_legacy_html(self, tmp_path, capsys):
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'review.html').write_text(
            '<!DOCTYPE html>\n<html><body><p>stale legacy</p></body></html>',
            encoding='utf-8',
        )
        (docs / 'review.md').write_text('# fresh master\n', encoding='utf-8')
        rc = export_mod.main(['review', '--workspace', str(tmp_path)])
        assert rc == 0
        md = capsys.readouterr().out
        assert 'fresh master' in md and 'stale legacy' not in md

    def test_unknown_name_errors(self, tmp_path, capsys):
        (tmp_path / 'docs').mkdir()
        rc = export_mod.main(['ghost', '--workspace', str(tmp_path)])
        assert rc == 1
        assert 'ghost' in capsys.readouterr().err

    def test_missing_path_errors(self, tmp_path, capsys):
        rc = export_mod.main([str(tmp_path / 'nope.md')])
        assert rc == 1
        assert 'not found' in capsys.readouterr().err

    def test_unsupported_suffix_errors(self, tmp_path):
        txt = tmp_path / 'x.rst'
        txt.write_text('content\n', encoding='utf-8')
        assert export_mod.main([str(txt)]) == 1


class TestLegacyHtml:
    def test_legacy_doc_without_master_exports_content(self, tmp_path, capsys):
        # the legacy doc carries annotations -> unconsumed markers, so a
        # plain export refuses; --draft exports the working snapshot
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'review.html').write_text(FULL_HTML, encoding='utf-8')
        rc = export_mod.main(
            ['review', '--workspace', str(tmp_path), '--draft'])
        assert rc == 0
        md = capsys.readouterr().out
        assert 'data-edit' not in md and '_pp_' not in md
        assert 'reword this' not in md and '中文注解' not in md
        assert '## Annotated Heading' in md and '带注解的段落。' in md
        assert md.startswith('<!-- pinpoint draft:')
        # export is read-only: no master created, legacy file untouched
        assert not (docs / 'review.md').exists()
        assert (docs / 'review.html').exists()

    def test_legacy_path_with_sibling_master_exports_master(self, tmp_path, capsys):
        docs = tmp_path / 'docs'
        docs.mkdir()
        (docs / 'review.html').write_text(
            '<!DOCTYPE html>\n<html><body><p>stale legacy</p></body></html>',
            encoding='utf-8',
        )
        (docs / 'review.md').write_text('# fresh master\n', encoding='utf-8')
        rc = export_mod.main([str(docs / 'review.html')])
        assert rc == 0
        md = capsys.readouterr().out
        assert 'fresh master' in md and 'stale legacy' not in md


class TestExportDocumentFile:
    def test_md_file(self, tmp_path: Path):
        master = tmp_path / 'm.md'
        master.write_text(MASTER, encoding='utf-8')
        md = export_document(master)
        assert 'The intro paragraph.' in md
        assert 'pp:' not in md

    def test_html_file(self, tmp_path: Path):
        doc = tmp_path / 'doc.html'
        doc.write_text(FULL_HTML, encoding='utf-8')
        md = export_document(doc)
        assert '# Plan' in md and '```python' in md


class TestExportDocument:
    def test_render_then_export_preserves_mermaid(self, tmp_path: Path):
        import render as render_mod
        src = tmp_path / 'arch.md'
        src.write_text(
            '# Arch\n\n```mermaid\nflowchart LR\nclient --> server\n```\n',
            encoding='utf-8',
        )
        assert render_mod.main(['--out', str(tmp_path), str(src)]) == 0
        md = export_document(tmp_path / 'docs' / 'arch.html')
        assert '```mermaid\nflowchart LR\nclient --> server\n```' in md

    def test_render_then_export_preserves_mockup(self, tmp_path: Path):
        import render as render_mod
        src = tmp_path / 'ui.md'
        fence = ('```mockup\n<div style="display: flex">\n'
                 '<button style="padding: 4px">Save</button>\n```\n')
        src.write_text(f'# UI\n\n{fence}', encoding='utf-8')
        assert render_mod.main(['--out', str(tmp_path), str(src)]) == 0
        md = export_document(tmp_path / 'docs' / 'ui.html')
        assert fence.strip() in md


class TestCli:
    def test_stdout_default(self, tmp_path, capsys):
        doc = tmp_path / 'doc.html'
        doc.write_text(
            '<!DOCTYPE html>\n<html><body><p>hello</p></body></html>',
            encoding='utf-8',
        )
        rc = export_mod.main([str(doc)])
        assert rc == 0
        assert 'hello' in capsys.readouterr().out

    def test_output_file(self, tmp_path):
        doc = tmp_path / 'doc.html'
        doc.write_text(
            '<!DOCTYPE html>\n<html><body><p>saved</p></body></html>',
            encoding='utf-8',
        )
        out = tmp_path / 'out.md'
        rc = export_mod.main([str(doc), '-o', str(out)])
        assert rc == 0
        assert 'saved' in out.read_text(encoding='utf-8')


class TestExportMaster:
    def test_master_path_markers_stripped_content_kept(self, tmp_path, capsys):
        # markers unconsumed -> only --draft exports; the strip itself
        # is unchanged, the draft marker rides on top
        master = tmp_path / 'review.md'
        master.write_text(MASTER, encoding='utf-8')
        rc = export_mod.main([str(master), '--draft'])
        assert rc == 0
        md = capsys.readouterr().out
        assert md.startswith('<!-- pinpoint draft:')
        assert 'pp:' not in md and 'pp@' not in md
        assert 'reword this' not in md and 'rename B' not in md
        assert '# Plan' in md
        assert 'The intro paragraph.' in md
        assert '```mermaid\nflowchart LR\nA --> B\n```' in md

    def test_converged_master_exports_unchanged(self, tmp_path, capsys):
        clean = '# Plan\n\nJust text.\n'
        master = tmp_path / 'done.md'
        master.write_text(clean, encoding='utf-8')
        rc = export_mod.main([str(master)])
        assert rc == 0
        assert capsys.readouterr().out == clean


class TestConvergenceGate:
    """0026: export refuses an unconverged review; --draft exports a
    marked working snapshot. Converged = no unconsumed markers and a
    last Apply that did not leave the rest undecided."""

    CLEAN = '# Plan\n\nJust text.\n'

    def _doc(self, tmp_path, text=None):
        docs = tmp_path / 'docs'
        docs.mkdir(exist_ok=True)
        (docs / 'plan.md').write_text(text or self.CLEAN, encoding='utf-8')
        return tmp_path

    def test_never_applied_clean_master_exports(self, tmp_path, capsys):
        self._doc(tmp_path)
        rc = export_mod.main(['plan', '--workspace', str(tmp_path)])
        assert rc == 0
        assert capsys.readouterr().out == self.CLEAN

    def test_undecided_last_apply_refuses(self, tmp_path, capsys):
        import review_state
        self._doc(tmp_path)
        review_state.record(
            tmp_path, modified=['plan.md'], empties='undecided',
            doc_names=['plan.md'])
        rc = export_mod.main(['plan', '--workspace', str(tmp_path)])
        assert rc == 1
        err = capsys.readouterr().err
        assert 'not converged' in err
        assert 'undecided' in err
        assert '--draft' in err

    def test_agreed_last_apply_exports(self, tmp_path, capsys):
        import review_state
        self._doc(tmp_path)
        review_state.record(
            tmp_path, modified=['plan.md'], empties='agreed',
            doc_names=['plan.md'])
        rc = export_mod.main(['plan', '--workspace', str(tmp_path)])
        assert rc == 0
        assert capsys.readouterr().out == self.CLEAN

    def test_full_agreement_state_exports(self, tmp_path, capsys):
        import review_state
        self._doc(tmp_path)
        review_state.record(
            tmp_path, modified=[], empties='undecided',
            doc_names=['plan.md'])
        rc = export_mod.main(['plan', '--workspace', str(tmp_path)])
        assert rc == 0

    def test_draft_on_undecided_marks_the_snapshot(self, tmp_path, capsys):
        import review_state
        self._doc(tmp_path)
        review_state.record(
            tmp_path, modified=['plan.md'], empties='undecided',
            doc_names=['plan.md'])
        rc = export_mod.main(
            ['plan', '--workspace', str(tmp_path), '--draft'])
        assert rc == 0
        captured = capsys.readouterr()
        assert '[DRAFT]' in captured.err
        md = captured.out
        assert md.startswith('<!-- pinpoint draft:')
        assert 'undecided' in md.splitlines()[0]
        assert md.endswith(self.CLEAN)

    def test_draft_on_converged_doc_adds_no_marker(self, tmp_path, capsys):
        self._doc(tmp_path)
        rc = export_mod.main(
            ['plan', '--workspace', str(tmp_path), '--draft'])
        assert rc == 0
        assert capsys.readouterr().out == self.CLEAN

    def test_marker_and_undecided_reasons_combined(self, tmp_path, capsys):
        import review_state
        self._doc(tmp_path, MASTER)
        review_state.record(
            tmp_path, modified=['plan.md'], empties='undecided',
            doc_names=['plan.md'])
        rc = export_mod.main(['plan', '--workspace', str(tmp_path)])
        assert rc == 1
        err = capsys.readouterr().err
        assert 'marker(s) unconsumed' in err
        assert 'undecided' in err
