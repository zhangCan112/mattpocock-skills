"""Tests for master.py - the markdown master format (0004/0008): a master
doc is blocks + marker lines (<!-- pp: note --> / <!-- pp@N: note -->).
Parsing reads markers + blocks, serialization is the inverse, and the
projection renders the master to HTML with markers translated into
data-edit-target / data-edit-annotation attributes.
"""

import xml.etree.ElementTree as ET

import pytest

import render
from render import Block
from annotations import ATTR_ANNOTATION, ATTR_TARGET

from master import (
    Marker,
    MasterBlock,
    MasterError,
    parse_master,
    projection,
    projection_blocks,
    serialize_master,
)


def body_parses(body_html: str) -> ET.Element:
    return ET.fromstring(f'<html><body>{body_html}</body></html>')


class TestParsePlain:
    def test_no_markers_yields_bare_blocks(self):
        md = "# Title\n\nIntro.\n\n```python\na = 1\n```\n"
        doc = parse_master(md)
        assert [mb.markers for mb in doc] == [[], [], []]
        assert [mb.block for mb in doc] == [
            Block('heading', '', ['# Title']),
            Block('para', '', ['Intro.']),
            Block('code', 'python', ['a = 1']),
        ]

    def test_empty_document(self):
        assert parse_master('') == []
        assert parse_master('\n\n') == []


class TestParseBlockMarkers:
    def test_marker_attaches_to_following_block(self):
        md = "<!-- pp: rewrite this -->\n\nIntro paragraph.\n"
        doc = parse_master(md)
        assert len(doc) == 1
        assert doc[0].markers == [Marker('block', None, 'rewrite this')]
        assert doc[0].block == Block('para', '', ['Intro paragraph.'])

    def test_marker_line_is_structurally_transparent(self):
        # A marker between two paragraphs does not split or merge blocks:
        # removing marker lines must leave the exact block structure.
        md = "# T\n\n<!-- pp: note -->\n\nFirst.\n\nSecond.\n"
        doc = parse_master(md)
        assert [mb.block.kind for mb in doc] == ['heading', 'para', 'para']
        assert doc[1].markers == [Marker('block', None, 'note')]
        assert doc[2].markers == []

    def test_marker_whitespace_is_stripped_from_note(self):
        md = "<!--   pp:   tidy the table   -->\n\n| a |\n|---|\n| 1 |\n"
        (mb,) = parse_master(md)
        assert mb.markers == [Marker('block', None, 'tidy the table')]

    def test_multiple_markers_above_one_block(self):
        md = "\n".join([
            "<!-- pp: review the whole block -->",
            "<!-- pp@1: rename this -->",
            "<!-- pp@3: dead code -->",
            "",
            "```python",
            "a = 1",
            "b = 2",
            "c = 3",
            "```",
        ])
        doc = parse_master(md)
        assert len(doc) == 1
        assert doc[0].markers == [
            Marker('block', None, 'review the whole block'),
            Marker('line', 1, 'rename this'),
            Marker('line', 3, 'dead code'),
        ]
        assert doc[0].block == Block('code', 'python', ['a = 1', 'b = 2', 'c = 3'])


class TestParseLineMarkers:
    def test_line_marker_counts_fence_content_lines(self):
        md = "<!-- pp@2: this line -->\n```mermaid\nflowchart LR\nA --> B\n```\n"
        (mb,) = parse_master(md)
        assert mb.markers == [Marker('line', 2, 'this line')]
        assert mb.block == Block('code', 'mermaid', ['flowchart LR', 'A --> B'])

    def test_blank_fence_lines_are_counted(self):
        # N counts content lines inside the fence, blank ones included.
        md = "<!-- pp@2: middle -->\n```\na\n\nb\n```\n"
        (mb,) = parse_master(md)
        assert mb.markers == [Marker('line', 2, 'middle')]


class TestParseValidation:
    def test_dangling_markers_at_end_of_document(self):
        with pytest.raises(MasterError):
            parse_master('# T\n\nBody.\n\n<!-- pp: nobody below -->\n')

    def test_line_number_zero_rejected(self):
        with pytest.raises(MasterError):
            parse_master('<!-- pp@0: no such line -->\n```\nx\n```')

    def test_line_marker_on_non_fenced_block_rejected(self):
        with pytest.raises(MasterError):
            parse_master('<!-- pp@1: lines need a fence -->\nJust a para.\n')

    def test_line_number_past_fence_end_rejected(self):
        with pytest.raises(MasterError):
            parse_master('<!-- pp@3: only two lines -->\n```python\na\nb\n```')

    def test_two_block_notes_on_one_block_rejected(self):
        with pytest.raises(MasterError):
            parse_master('<!-- pp: one -->\n<!-- pp: two -->\nPara.\n')

    def test_two_notes_on_same_line_rejected(self):
        with pytest.raises(MasterError):
            parse_master('<!-- pp@1: a -->\n<!-- pp@1: b -->\n```\nx\n```')


class TestParseLeniency:
    def test_blank_line_between_marker_and_block_is_tolerated(self):
        md = "<!-- pp: note -->\n\n\nBody text.\n"
        (mb,) = parse_master(md)
        assert mb.markers == [Marker('block', None, 'note')]
        assert mb.block == Block('para', '', ['Body text.'])

    def test_marker_looking_line_inside_fence_is_content(self):
        md = "```markdown\n<!-- pp: not a marker -->\n```\n\nAfter.\n"
        doc = parse_master(md)
        assert len(doc) == 2
        assert doc[0].markers == []
        assert doc[0].block == Block('code', 'markdown', ['<!-- pp: not a marker -->'])
        assert doc[1].markers == []

    def test_crlf_and_bom_tolerated(self):
        md = "﻿# T\r\n\r\n<!-- pp: note -->\r\n\r\nBody.\r\n"
        doc = parse_master(md)
        assert [mb.block.kind for mb in doc] == ['heading', 'para']
        assert doc[1].markers == [Marker('block', None, 'note')]


class TestSerialize:
    def test_markers_sit_flush_above_their_block(self):
        md = "<!-- pp: note -->\n\n\nBody text.\n"
        out = serialize_master(parse_master(md))
        assert out == "<!-- pp: note -->\nBody text.\n"

    def test_blocks_are_separated_by_blank_lines(self):
        md = "```mermaid\nA --> B\n```\n\n| a |\n|---|\n| 1 |\n"
        out = serialize_master(parse_master(md))
        assert out == "```mermaid\nA --> B\n```\n\n| a |\n|---|\n| 1 |\n"

    def test_line_markers_use_canonical_form(self):
        md = "<!--   pp@02:   x   -->\n```\na\nb\n```"
        out = serialize_master(parse_master(md))
        assert out == "<!-- pp@2: x -->\n```\na\nb\n```\n"

    def test_empty_document_serializes_empty(self):
        assert serialize_master(parse_master('')) == ''

    def test_rejects_unrepresentable_marker_notes(self):
        marked = parse_master('<!-- pp: fine -->\nPara.\n')
        bad_linebreak = [MasterBlock([Marker('block', None, 'two\nlines')],
                                     marked[0].block)]
        bad_comment_end = [MasterBlock([Marker('block', None, 'a --> b')],
                                       marked[0].block)]
        with pytest.raises(MasterError):
            serialize_master(bad_linebreak)
        with pytest.raises(MasterError):
            serialize_master(bad_comment_end)

    def test_rejects_code_line_that_looks_like_a_fence(self):
        fence_block = Block('code', 'python', ['x = 1', '```'])
        with pytest.raises(MasterError):
            serialize_master([MasterBlock([], fence_block)])

    def test_rejects_validation_failures_too(self):
        # Serialize accepts programmatically built blocks, so the same
        # representation rules as parse apply.
        para = Block('para', '', ['Para.'])
        with pytest.raises(MasterError):
            serialize_master([MasterBlock([Marker('line', 1, 'x')], para)])


class TestRoundTrip:
    def _round_trip(self, md: str):
        return parse_master(serialize_master(parse_master(md)))

    def test_kitchen_sink(self):
        md = "\n".join([
            "# 设计评审",
            "",
            "<!-- pp: 整段重写 -->",
            "Intro **para** with AT&T.",
            "",
            "- one",
            "- two",
            "",
            "1. first",
            "2. second",
            "",
            "> quoted",
            "> more",
            "",
            "<!-- pp@2: rename -->",
            "<!-- pp@3: dead -->",
            "```python",
            "a = 1",
            "",
            "b = 2",
            "```",
            "",
            "```mermaid",
            "flowchart LR",
            "A --> B",
            "```",
            "",
            "| a | b |",
            "|---|---|",
            "| 1 | 2 |",
            "",
            "---",
            "",
            "Final para.",
            "",
        ])
        assert self._round_trip(md) == parse_master(md)

    def test_property_holds_after_marker_drift(self):
        # Lenient input (loose blank lines, padded notes) converges to the
        # canonical form and is stable from there on.
        loose = "  <!-- pp:   spaced   -->  \n\n\nPara one.\n\nPara two.\n"
        once = self._round_trip(loose)
        assert parse_master(serialize_master(once)) == once

    def test_crlf_input_round_trips(self):
        md = "# T\r\n\r\n<!-- pp: note -->\r\n\r\nBody.\r\n"
        assert self._round_trip(md) == parse_master(md)

    def test_empty_document(self):
        assert self._round_trip('') == []


def parse_body(body_html: str) -> ET.Element:
    return ET.fromstring(f'<html><body>{body_html}</body></html>')


def line_elements(root, tag: str) -> list:
    return [e for e in root.iter(tag)
            if 'line' in (e.get('class') or '').split()]


class TestProjection:
    def test_clean_master_renders_like_plain_markdown(self):
        md = "# T\n\nBody.\n\n```python\nx = 1\n```\n"
        assert projection(md) == render.render_blocks(md)

    def test_block_marker_lands_on_the_block_element(self):
        md = "<!-- pp: rewrite this -->\nIntro paragraph.\n"
        root = parse_body(projection(md))
        p = root.find('.//p')
        assert p.get(ATTR_TARGET) == 'true'
        assert p.get(ATTR_ANNOTATION) == 'rewrite this'

    def test_block_marker_on_fenced_code_lands_on_pre(self):
        md = "<!-- pp: tighten -->\n```python\na = 1\nb = 2\n```\n"
        root = parse_body(projection(md))
        pre = root.find('.//pre')
        assert pre.get(ATTR_TARGET) == 'true'
        assert pre.get(ATTR_ANNOTATION) == 'tighten'
        assert all(span.get(ATTR_TARGET) is None for span in line_elements(root, 'span'))

    def test_block_marker_on_diagram_lands_on_figure(self):
        md = "<!-- pp: simplify -->\n```mermaid\nA --> B\n```\n"
        root = parse_body(projection(md))
        figure = root.find('.//figure')
        assert figure.get(ATTR_TARGET) == 'true'
        assert figure.get(ATTR_ANNOTATION) == 'simplify'

    def test_line_marker_lands_on_nth_code_line(self):
        md = "<!-- pp@2: off by one -->\n```python\na = 1\nb = 2\n```\n"
        root = parse_body(projection(md))
        spans = line_elements(root, 'span')
        assert len(spans) == 2
        assert spans[1].get(ATTR_TARGET) == 'true'
        assert spans[1].get(ATTR_ANNOTATION) == 'off by one'
        assert spans[0].get(ATTR_TARGET) is None

    def test_line_marker_counts_blank_fence_lines(self):
        md = "<!-- pp@2: middle -->\n```\na\n\nb\n```\n"
        root = parse_body(projection(md))
        spans = line_elements(root, 'span')
        assert len(spans) == 3
        assert spans[1].get(ATTR_ANNOTATION) == 'middle'

    def test_line_marker_lands_on_nth_diagram_line(self):
        md = "<!-- pp@1: label -->\n```mermaid\nflowchart LR\nA --> B\n```\n"
        root = parse_body(projection(md))
        divs = line_elements(root, 'div')
        assert divs[0].get(ATTR_TARGET) == 'true'
        assert divs[0].get(ATTR_ANNOTATION) == 'label'
        assert divs[1].get(ATTR_TARGET) is None

    def test_line_marker_on_mockup_fence(self):
        # Mockup/svg fences are fenced blocks like any other: pp@N needs
        # no special casing anywhere in the master layer.
        md = ("<!-- pp@2: wider button -->\n"
              '```mockup\n<div style="padding: 8px">\n'
              '<button style="width: 60px">Save</button>\n```\n')
        root = parse_body(projection(md))
        divs = line_elements(root, 'div')
        assert len(divs) == 2
        assert divs[1].get(ATTR_TARGET) == 'true'
        assert divs[1].get(ATTR_ANNOTATION) == 'wider button'

    def test_marker_lines_never_reach_the_projection(self):
        md = "<!-- pp: note -->\n<!-- pp@1: line note -->\n```python\nx\n```\n"
        out = projection(md)
        assert '<!--' not in out
        assert 'pp:' not in out and 'pp@' not in out

    def test_marked_blocks_do_not_leak_onto_neighbors(self):
        md = "\n".join([
            "First.",
            "",
            "<!-- pp: middle note -->",
            "Middle.",
            "",
            "<!-- pp@1: line note -->",
            "```python",
            "x = 1",
            "```",
            "",
            "Last.",
        ])
        root = parse_body(projection(md))
        paras = root.findall('.//p')
        assert len(paras) == 3
        assert paras[0].get(ATTR_TARGET) is None
        assert paras[1].get(ATTR_ANNOTATION) == 'middle note'
        assert paras[2].get(ATTR_TARGET) is None
        assert line_elements(root, 'span')[0].get(ATTR_ANNOTATION) == 'line note'

    def test_tricky_note_is_xml_safe_and_exact(self):
        note = 'say "hi" & <exit> 请改'
        md = f'<!-- pp: {note} -->\nIntro.\n'
        root = parse_body(projection(md))
        assert root.find('.//p').get(ATTR_ANNOTATION) == note

    def test_mixed_document_is_xml_well_formed(self):
        md = "\n".join([
            "# 方案 & 备选",
            "",
            "<!-- pp@2: A -> B 换位置 -->",
            "```mermaid",
            "flowchart LR",
            "A[草&案] --> B{评审}",
            "```",
            "",
            "<!-- pp: 表格加列 -->",
            "| a | b |",
            "|---|---|",
            "| 1 | 2 |",
        ])
        body_parses(projection(md))


class TestProjectionBlocks:
    """projection_blocks tracks which body children each master block
    rendered to - the spans the server needs to map element ids back to
    master block indexes (the body's children are NOT 1:1 with blocks:
    a link-reference definition renders to none, a paragraph run with a
    quote or raw HTML to several)."""

    DRIFTY_MD = "\n".join([
        "# Title",
        "",
        "[1]: http://example.com/source",
        "",
        "Choose one:",
        "> fast",
        "",
        "```python",
        "x = 1",
        "```",
    ]) + "\n"

    def test_spans_partition_the_body_children(self):
        html, spans = projection_blocks(self.DRIFTY_MD)
        children = list(body_parses(html).find('body'))
        assert len(spans) == len(parse_master(self.DRIFTY_MD))
        cursor = 0
        for start, end in spans:
            assert start == cursor  # contiguous, in block order
            assert end >= start
            cursor = end
        assert cursor == len(children)  # every child owned by a block

    def test_zero_render_block_gets_empty_span(self):
        # the link-reference definition renders to nothing
        html, spans = projection_blocks(self.DRIFTY_MD)
        tags = [child.tag for child in body_parses(html).find('body')]
        assert tags == ['h1', 'p', 'blockquote', 'pre']
        assert spans == [(0, 1), (1, 1), (1, 3), (3, 4)]

    def test_plain_document_is_all_single_spans(self):
        md = "# T\n\nBody.\n\n```python\nx = 1\n```\n"
        html, spans = projection_blocks(md)
        assert spans == [(0, 1), (1, 2), (2, 3)]
        assert html == projection(md)
        assert html == render.render_blocks(md)
