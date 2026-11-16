"""Tests for migrate.py - legacy HTML docs to markdown masters (0003/0008).

The read side is the empirically validated bs4 serializer from the
research branch `research/html-md-roundtrip`: HTML IR -> markdown whose
re-render equals the input IR. IR stability is the fidelity metric.
Migration preserves pending annotations as marker lines and archives the
old HTML file.
"""

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

import render
from render import render_blocks

import master

from migrate import (
    MigrationError,
    html_body_to_markdown,
    migrate_legacy_doc,
)


def md_roundtrip(md: str) -> str:
    """render_blocks(md) — the fidelity yardstick."""
    return render_blocks(md)


class TestSerializerBlocks:
    def test_heading_and_paras(self):
        ir = render_blocks('# Title\n\nFirst para.\n\nSecond **para**.\n')
        md = html_body_to_markdown(ir)
        assert md == '# Title\n\nFirst para.\n\nSecond **para**.'
        assert md_roundtrip(md) == ir.strip()

    def test_setext_heading_normalizes_to_atx_shape(self):
        ir = render_blocks('Title\n=====\n\nbody')
        md = html_body_to_markdown(ir)
        assert md_roundtrip(md) == ir.strip()

    def test_code_fence_preserves_lines_byte_for_byte(self):
        src = '```python\ndef f(x):\n    return x < 2\n\n# blank above\ns = "q & apos"\n```'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md == src
        assert md_roundtrip(md) == ir.strip()

    def test_mermaid_figure_back_to_fence(self):
        src = '```mermaid\nflowchart LR\nA[Draft & plan] --> B{Review}\n\nB --> C\n```'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md == src
        assert md_roundtrip(md) == ir.strip()

    def test_mockup_figure_back_to_fence(self):
        src = ('```mockup\n<div style="display: flex">\n'
               '<button style="padding: 4px">Save</button>\n```\n').strip()
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md == src
        assert md_roundtrip(md) == ir.strip()

    def test_plain_table(self):
        src = '| A | B |\n|---|---|\n| 1 | 2 |'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md_roundtrip(md) == ir.strip()

    def test_table_alignment_kept(self):
        src = ('| Left | Center | Right |\n'
               '|:-----|:------:|------:|\n'
               '| a **b** | `c` | [d](http://x) |')
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert '|:---|' in md.replace(' ', '') or ':---' in md
        assert md_roundtrip(md) == ir.strip()

    def test_nested_lists_keep_four_space_indent(self):
        src = '- a\n- b\n    - b1\n        - b1x\n- c'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert '    - b1' in md
        assert '        - b1x' in md
        assert md_roundtrip(md) == ir.strip()

    def test_ordered_list_start_kept(self):
        # The serializer reads the start attribute when a version of
        # python-markdown keeps it in the IR; this one normalizes 3. to
        # <ol> on render, so compare against that environment truth.
        ir = '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>'
        md = html_body_to_markdown(ir)
        assert md.startswith('3. three')
        assert md_roundtrip(md) == render_blocks('3. three\n4. four')

    def test_loose_list_stays_loose(self):
        src = '- one\n\n- two'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md_roundtrip(md) == ir.strip()

    def test_blockquote(self):
        src = '> line a\n> line b with **bold** and `code`\n>\n> para two'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md_roundtrip(md) == ir.strip()

    def test_hr(self):
        ir = render_blocks('---')
        md = html_body_to_markdown(ir)
        assert md == '---'

    def test_inline_mix_survives(self):
        # Byte form may differ (e.g. a_b -> a\_b); IR stability is the metric.
        src = ('**bold and `code`** and *em with [link](http://x)* '
               'and a_b star*raw*')
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md_roundtrip(md) == ir.strip()
        assert '**bold and `code`**' in md
        assert '*em with [link](http://x)*' in md

    def test_hard_break_kept(self):
        src = 'line one  \nline two'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert md_roundtrip(md) == ir.strip()

    def test_literal_link_syntax_escaped(self):
        # Literal "[x](y)" text in the IR must stay literal after the round
        # trip: the serializer escapes the bracket, not the whole pattern.
        src = ('the pattern \\[foo\\]\\(http://bar\\) and '
               '\\![pic\\]\\(x.png\\) appear literally in text')
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert '\\[' in md
        assert md_roundtrip(md) == ir.strip()

    def test_bracket_reference_left_alone(self):
        src = 'see reference [1] and [Note 2] here'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert '[1]' in md
        assert md_roundtrip(md) == ir.strip()

    def test_inline_code_with_backtick(self):
        # Double-backtick wrapping may gain padding spaces; IR stable.
        src = 'text with ``code with ` backtick`` inside'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert '` backtick' in md
        assert md_roundtrip(md) == ir.strip()

    def test_pipe_in_table_cell_escaped(self):
        src = '| A | B |\n|---|---|\n| a \\| b | 2 |'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert '\\|' in md
        assert md_roundtrip(md) == ir.strip()

    def test_raw_inline_html_passthrough(self):
        src = 'press <kbd>Ctrl</kbd> key and <mark>highlight</mark> me'
        ir = render_blocks(src)
        md = html_body_to_markdown(ir)
        assert '<kbd>Ctrl</kbd>' in md
        assert md_roundtrip(md) == ir.strip()


LEGACY_DOC = """<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>review</title></head><body>
<h1 id="_pp_0" data-edit-target="true" data-edit-annotation="existing note">Title</h1>
<p>First para.</p>
<figure class="pp-diagram" data-lang="mermaid"><div class="line">flowchart LR</div><div class="line" id="_pp_2" data-edit-target="true" data-edit-annotation="rename gateway">client --&gt; gateway</div></figure>
</body></html>
"""


class TestMigrateLegacyDoc:
    @pytest.fixture
    def migrated(self, tmp_path: Path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        html_path = docs / 'legacy.html'
        html_path.write_text(LEGACY_DOC, encoding='utf-8')
        master_text = migrate_legacy_doc(
            html_path=html_path,
            master_path=docs / 'legacy.md',
            archive_path=tmp_path / 'archive' / 'legacy.html',
            baseline_path=tmp_path / 'state' / 'legacy.base.md',
        )
        return tmp_path, master_text

    def test_master_created_with_markers(self, migrated):
        tmp_path, master_text = migrated
        doc = master.parse_master(master_text)
        by_kind = [(mb.block.kind, mb.markers) for mb in doc]
        assert [k for k, _ in by_kind] == ['heading', 'para', 'code']
        assert by_kind[0][1] == [master.Marker('block', None, 'existing note')]
        # line note above the mermaid fence, line 2 = the annotated div
        assert by_kind[2][1] == [master.Marker('line', 2, 'rename gateway')]
    def test_html_archived_and_removed_from_docs(self, migrated):
        tmp_path, _ = migrated
        assert not (tmp_path / 'docs' / 'legacy.html').exists()
        archived = (tmp_path / 'archive' / 'legacy.html').read_text(encoding='utf-8')
        assert archived == LEGACY_DOC

    def test_baseline_snapshot_equals_master(self, migrated):
        tmp_path, master_text = migrated
        baseline = (tmp_path / 'state' / 'legacy.base.md').read_text(encoding='utf-8')
        assert baseline == master_text

    def test_projection_carries_annotations(self, migrated):
        _, master_text = migrated
        html = master.projection(master_text)
        assert 'data-edit-annotation="existing note"' in html
        assert 'data-edit-annotation="rename gateway"' in html

    def test_no_temp_ids_or_attrs_in_master(self, migrated):
        _, master_text = migrated
        assert '_pp_' not in master_text
        assert 'data-edit' not in master_text

    def test_crlf_and_bom_tolerated(self, tmp_path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        html_path = docs / 'crlf.html'
        html_path.write_bytes(
            b'\xef\xbb\xbf<!DOCTYPE html>\r\n<html><body><p>CRLF doc.</p></body></html>\r\n')
        master_text = migrate_legacy_doc(
            html_path=html_path,
            master_path=docs / 'crlf.md',
            archive_path=tmp_path / 'archive' / 'crlf.html',
            baseline_path=tmp_path / 'state' / 'crlf.base.md',
        )
        assert master.parse_master(master_text)[0].block.lines == ['CRLF doc.']

    def test_unreadable_html_raises(self, tmp_path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        html_path = docs / 'bad.html'
        html_path.write_bytes(b'\xff\xfe<\x00p\x00>\x00\xff\xfe')
        with pytest.raises(MigrationError):
            migrate_legacy_doc(
                html_path=html_path,
                master_path=docs / 'bad.md',
                archive_path=tmp_path / 'archive' / 'bad.html',
                baseline_path=tmp_path / 'state' / 'bad.base.md',
            )

    def test_subblock_annotation_coarsens_to_enclosing_block(self, tmp_path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        html_path = docs / 'table.html'
        html_path.write_text(
            '<html><body>'
            '<table><tr><td data-edit-target="true" '
            'data-edit-annotation="fix this cell">a</td><td>b</td></tr></table>'
            '</body></html>', encoding='utf-8')
        master_text = migrate_legacy_doc(
            html_path=html_path,
            master_path=docs / 'table.md',
            archive_path=tmp_path / 'archive' / 'table.html',
            baseline_path=tmp_path / 'state' / 'table.base.md',
        )
        (mb,) = master.parse_master(master_text)
        assert mb.markers == [master.Marker('block', None, 'fix this cell')]
        assert mb.block.kind == 'table'

    def test_note_with_comment_end_sanitized(self, tmp_path):
        docs = tmp_path / 'docs'
        docs.mkdir()
        html_path = docs / 'note.html'
        html_path.write_text(
            '<html><body><p data-edit-target="true" '
            'data-edit-annotation="keep --&gt; marker">text</p></body></html>',
            encoding='utf-8')
        master_text = migrate_legacy_doc(
            html_path=html_path,
            master_path=docs / 'note.md',
            archive_path=tmp_path / 'archive' / 'note.html',
            baseline_path=tmp_path / 'state' / 'note.base.md',
        )
        (mb,) = master.parse_master(master_text)
        assert '-->' not in mb.markers[0].note
        assert 'keep' in mb.markers[0].note and 'marker' in mb.markers[0].note

    def test_kitchen_sink_migration_roundtrips_ir(self, tmp_path):
        """0003 fidelity contract: migrated master renders back to the
        exact IR the legacy doc carried (headings/paras/nested list/
        code+spans/mermaid/tables/quote/hr, no annotations)."""
        src_md = (
            '# Plan\n\nIntro with **bold** and `code`.\n\n'
            '- a\n- b\n    - b1\n- c\n\n'
            '```python\ndef f(x):\n    return x < 2\n\n# tail comment\n```\n\n'
            '```mermaid\nflowchart LR\nA --> B\n\nB --> C\n```\n\n'
            '| Left | Right |\n|:-----|------:|\n| 1 | 2 |\n\n'
            '> quoted **line**\n>\n> second para\n\n---\n\n'
            'Last para.\n'
        )
        ir = render_blocks(src_md)
        docs = tmp_path / 'docs'
        docs.mkdir()
        html_path = docs / 'kitchen.html'
        html_path.write_text(render.doc_document('kitchen', ir), encoding='utf-8')
        master_text = migrate_legacy_doc(
            html_path=html_path,
            master_path=docs / 'kitchen.md',
            archive_path=tmp_path / 'archive' / 'kitchen.html',
            baseline_path=tmp_path / 'state' / 'kitchen.base.md',
        )
        assert master.projection(master_text) == ir

    def test_annotated_migration_roundtrips_through_projection(self, tmp_path):
        """The 25/31 class: shapes + annotations survive as attributes."""
        ir = render_blocks(
            '# Title\n\nPara one.\n\n```mermaid\nflowchart TB\nA --> B\n```\n')
        body = (
            '<h1 data-edit-target="true" data-edit-annotation="retitle">Title</h1>'
            '<p>Para one.</p>'
            '<figure class="pp-diagram" data-lang="mermaid">'
            '<div class="line">flowchart TB</div>'
            '<div class="line" data-edit-target="true" '
            'data-edit-annotation="swap nodes">A --&gt; B</div></figure>'
        )
        docs = tmp_path / 'docs'
        docs.mkdir()
        html_path = docs / 'ann.html'
        html_path.write_text(render.doc_document('ann', body), encoding='utf-8')
        master_text = migrate_legacy_doc(
            html_path=html_path,
            master_path=docs / 'ann.md',
            archive_path=tmp_path / 'archive' / 'ann.html',
            baseline_path=tmp_path / 'state' / 'ann.base.md',
        )
        html = master.projection(master_text)
        root = ET.fromstring(f'<html><body>{html}</body></html>')
        # markers became attributes again, on the same elements
        anns = {(e.tag, e.get('data-edit-annotation'))
                for e in root.iter() if e.get('data-edit-target') == 'true'}
        assert ('h1', 'retitle') in anns
        assert ('div', 'swap nodes') in anns
        # and the unannotated parts are byte-stable IR
        assert '<p>Para one.</p>' in html
        assert 'flowchart TB' in html
