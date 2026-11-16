#!/usr/bin/env python3
"""
pinpoint - Legacy HTML doc to markdown master migration (read side).

The serializer below is the empirically validated design from research
branch `research/html-md-roundtrip` (ticket 0003): a ~200-line bs4
serializer whose output re-renders to the identical IR for 25 of the 31
probed shapes - the fidelity contract this module ports faithfully. The
key IR conventions it encodes:

- ``<pre data-lang="..."><code><span class="line">`` per-line spans join
  with '\\n'; ``\\u00a0`` placeholders become empty lines; ``data-lang``
  becomes the fence info string.
- ``figure.pp-diagram > div.line`` becomes a ```mermaid fence (same rule).
- span-less ``<pre><code>`` (write-side artifact): text split on '\\n',
  python-markdown's trailing newline stripped, fenced as-is.
- tables read ``text-align`` from ``th`` styles into ':---' separators;
  ragged rows pad to the widest row; ``|`` in cells is escaped.
- nested lists indent a full 4 spaces (python-markdown flattens 2/3);
  any li holding a p/pre serializes loose; ``ol`` reads ``start``.
- inline whitespace: single newlines kept (soft breaks), other runs
  collapse; ``<br/>`` becomes '  \\n' and eats the IR's stray newline.
- escaping: backslash/backtick/asterisk/underscore always; line-start
  hashes/quotes/list markers/ordered numbers; ``[`` only when it starts
  a literal ``[x](y)`` link/image pattern.
- unknown inline tags (kbd, mark, ...) pass through raw - python-markdown
  forwards raw inline HTML to the IR unchanged; unknown block containers
  (div, section, ...) flatten transparently.

Migration (issue 0008 resolution, implemented for 0013): the first open
of a legacy ``docs/<name>.html`` produces ``docs/<name>.md``, moves the
old file to ``archive/<name>.html``, and snapshots the new master as the
consume baseline ``state/<name>.base.md``. Pending annotations travel
along as marker lines (block notes above the block, ``pp@N`` above the
fence for class="line" targets).

Dependencies: beautifulsoup4 - auto-installed via
server_common.import_or_install (same mechanism as render.py).
"""

import os
import re
from pathlib import Path
from typing import Union

from server_common import import_or_install, write_text_lf

import_or_install('bs4', 'beautifulsoup4')

from bs4 import BeautifulSoup, Comment, NavigableString, Tag

import master
from annotations import ATTR_ANNOTATION, ATTR_TARGET


class MigrationError(Exception):
    """The legacy document could not be converted to a master."""


# ---------------------------------------------------------------------------
# HTML IR -> markdown (port of research/roundtrip_harness.py conv_handrolled)
# ---------------------------------------------------------------------------

def _esc_text(s: str, line_start: bool) -> str:
    s = s.replace('\\', '\\\\')
    s = s.replace('`', '\\`').replace('*', '\\*').replace('_', '\\_')
    # a literal "[x](y)" in text would re-render as a link: escape the
    # opening bracket only when it starts a link/image pattern
    s = re.sub(
        r'(!?)\[([^\\\]]*)\]\(',
        lambda m: m.group(1) + r'\[' + m.group(2) + r'\](', s)
    if line_start:
        s = s.replace('#', '\\#').replace('>', '\\>')
        s = re.sub(r'^([-+]) ', r'\\\1 ', s)
        s = re.sub(r'^(\d+)([.)]) ', r'\1\\\2 ', s)
    return s


def _inline(el: Tag, inside_code: bool = False) -> str:
    parts = []
    after_break = False
    for node in el.children:
        if isinstance(node, Comment):
            continue
        if isinstance(node, NavigableString):
            # python-markdown keeps single newlines (soft breaks) in <p>
            # text but collapses every other whitespace run to one space.
            t = str(node)
            t = re.sub(r'[ \t]*\n[ \t]*', '\n', t)
            t = re.sub(r'[ \t]{2,}', ' ', t)
            if after_break:
                # the IR always has a bare newline text node after <br/>;
                # strip it so the emitted '  \n' is the only break
                t = t.lstrip(' \n')
                after_break = False
            parts.append(_esc_text(t, False))
        elif isinstance(node, Tag):
            name = node.name.lower()
            if name in ('strong', 'b'):
                inner = _inline(node)
                parts.append(f'**{inner}**' if inner.strip() else '')
            elif name in ('em', 'i'):
                inner = _inline(node)
                parts.append(f'*{inner}*' if inner.strip() else '')
            elif name == 'code':
                txt = node.get_text()
                if '`' in txt:
                    parts.append(f'`` {txt} ``')
                else:
                    parts.append(f'`{txt}`')
            elif name == 'a':
                href = node.get('href', '')
                parts.append(f'[{_inline(node)}]({href})')
            elif name == 'br':
                parts.append('  \n')
                after_break = True
            elif name == 'img':
                alt = node.get('alt', '')
                src = node.get('src', '')
                title = node.get('title')
                parts.append(f'![{alt}]({src}' +
                             (f' "{title}"' if title else '') + ')')
            elif name in ('del', 's'):
                parts.append(f'~~{_inline(node)}~~')
            else:
                # unknown inline tag (kbd, mark, span...): pass through raw,
                # python-markdown forwards raw inline HTML to the IR.
                parts.append(str(node))
    return ''.join(parts)


def _fence(lang: str, lines: list) -> str:
    body = '\n'.join('' if l == '\u00a0' else l for l in lines)
    return f'```{lang}\n{body}\n```'


def _table_md(el: Tag) -> str:
    ths = el.find_all('th')
    aligns = []
    for th in ths:
        style = th.get('style', '') or th.get('align', '')
        if 'center' in style:
            aligns.append(':---:')
        elif 'right' in style:
            aligns.append('---:')
        elif 'left' in style:
            aligns.append(':---')
        else:
            aligns.append('---')
    rows = el.find_all('tr')
    grid = [[_inline(c).replace('|', '\\|') if c.name in ('td', 'th')
             else c.get_text().replace('|', '\\|')
             for c in tr.find_all(['td', 'th'])] for tr in rows]
    if not grid:
        return ''
    width = max(len(r) for r in grid)
    grid = [r + [''] * (width - len(r)) for r in grid]
    header, body_rows = grid[0], grid[1:]
    aligns = aligns[:width] + ['---'] * max(0, width - len(aligns))
    sep = aligns
    out = ['| ' + ' | '.join(header) + ' |',
           '| ' + ' | '.join(sep) + ' |']
    for r in body_rows:
        out.append('| ' + ' | '.join(r) + ' |')
    return '\n'.join(out)


def _blocks_md(container: Union[BeautifulSoup, Tag]) -> list[str]:
    blocks = []
    for node in container.children:
        if isinstance(node, Comment):
            continue
        if isinstance(node, NavigableString):
            if str(node).strip():
                blocks.append(_esc_text(str(node).strip(), False))
            continue
        if not isinstance(node, Tag):
            continue
        blocks.append(_block_md(node))
    return [b for b in blocks if b]


def _list_md(el: Tag, ordered: bool = False) -> str:
    lines = []
    idx = int(el.get('start', 1) or 1)
    loose = any(li.find(['p', 'pre'])
                for li in el.find_all('li', recursive=False))
    sep = '\n\n' if loose else '\n'
    for li in el.find_all('li', recursive=False):
        marker = f'{idx}. ' if ordered else '- '
        own, nested = [], []
        for child in li.children:
            if isinstance(child, Tag) and child.name in ('ul', 'ol'):
                nested.append(child)
            elif isinstance(child, Tag) and child.name == 'p':
                own.append(_inline(child))
            elif isinstance(child, Tag):
                own.append(_inline(child))
            else:
                t = re.sub(r'[ \t]*\n[ \t]*', '\n', str(child))
                t = re.sub(r'[ \t]{2,}', ' ', t)
                if t.strip():
                    own.append(t)
        text = ''.join(own).strip()
        # 4 spaces: python-markdown nests reliably with a full indent
        # stop (2 or 3 spaces flatten the sublist into sibling items).
        indent = '    '
        item = marker + text
        sub = '\n'.join(
            _indent(_block_md(n), indent) for n in nested)
        lines.append(item + ('\n' + sub if sub else ''))
        idx += 1
    return sep.join(lines)


def _indent(text: str, prefix: str) -> str:
    return '\n'.join(
        prefix + l if l.strip() else l for l in text.split('\n'))


def _block_md(el: Tag) -> str:
    name = el.name.lower()
    if name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
        return '#' * int(name[1]) + ' ' + _inline(el)
    if name == 'p':
        return _inline(el)
    if name == 'pre':
        lang = el.get('data-lang', '')
        code = el.find('code') or el
        spans = code.find_all('span', class_='line')
        if spans:
            return _fence(lang, [s.get_text() for s in spans])
        # span-less shape (write-side artifact of indented paragraphs,
        # or raw-HTML intake): python-markdown ends the content with \n
        text = code.get_text()
        if text.endswith('\n'):
            text = text[:-1]
        return _fence(lang, text.split('\n'))
    if name == 'figure':
        classes = el.get('class') or []
        if isinstance(classes, str):
            classes = classes.split()
        if 'pp-diagram' in classes:
            diagram_lines = [
                d.get_text() for d in el.find_all('div', class_='line')]
            return _fence(el.get('data-lang', 'mermaid'), diagram_lines)
        img = el.find('img')
        if img is not None:
            cap = el.find('figcaption')
            alt = cap.get_text() if cap else img.get('alt', '')
            return f'![{alt}]({img.get("src", "")})'
        return _inline(el)
    if name in ('ul', 'ol'):
        return _list_md(el, ordered=(name == 'ol'))
    if name == 'blockquote':
        inner = '\n\n'.join(_blocks_md(el))
        return _indent(inner, '> ')
    if name == 'table':
        return _table_md(el)
    if name == 'hr':
        return '---'
    if name in ('div', 'section', 'article', 'main', 'aside', 'header',
                'footer', 'nav', 'dl', 'dt', 'dd', 'figcaption'):
        # transparent container (raw-HTML intake): flatten children
        return '\n\n'.join(_blocks_md(el))
    return _inline(el)


def html_body_to_markdown(body_html: str) -> str:
    """Serialize a clean HTML IR body fragment to markdown."""
    soup = BeautifulSoup(f'<body>{body_html}</body>', 'html.parser')
    container = soup.body if soup.body is not None else soup
    return '\n\n'.join(_blocks_md(container))


# ---------------------------------------------------------------------------
# Migration orchestration: annotations travel along as marker lines
# ---------------------------------------------------------------------------

_NOTE_NEWLINE_RE = re.compile(r'[\r\n]+')


def sanitize_note(note: str) -> str:
    """Make an annotation note representable as a single marker line.

    Marker lines are single-line HTML comments (master._check_note
    refuses newlines and '-->'); newlines collapse to spaces and a
    literal comment end becomes an em dash so the note stays readable.
    """
    note = _NOTE_NEWLINE_RE.sub(' ', note).strip()
    return note.replace('-->', '\u2014>')


def _is_fence_container(el: Tag) -> bool:
    if el.name == 'pre':
        return True
    classes = el.get('class') or []
    if isinstance(classes, str):
        classes = classes.split()
    return el.name == 'figure' and 'pp-diagram' in classes


def _strip_transient_attrs(soup: BeautifulSoup) -> None:
    """Master docs are clean markdown: no ids, no annotation attributes."""
    for el in soup.find_all(True):
        el.attrs.pop('id', None)
        el.attrs.pop(ATTR_TARGET, None)
        el.attrs.pop(ATTR_ANNOTATION, None)


def _master_from_html(html_text: str) -> str:
    """Convert a legacy pinpoint doc to master markdown with markers."""
    try:
        soup = BeautifulSoup(html_text, 'html.parser')
    except Exception as exc:  # bs4 rarely raises, but be honest if it does
        raise MigrationError(f'cannot parse legacy doc: {exc}') from exc
    body = soup.body if soup.body is not None else soup

    # Collect annotations before stripping: {element: note}.
    annotated = {}
    for el in body.find_all(True):
        if el.get(ATTR_TARGET) == 'true':
            annotated[el] = el.get(ATTR_ANNOTATION, '')
    _strip_transient_attrs(soup)

    # Place each note: block note on its top-level block, pp@N above the
    # fence for class="line" targets; notes on sub-blocks (td/li/...)
    # coarsen to the enclosing top-level block, merged when several land
    # on the same one.
    block_notes = {}   # top-level element -> [notes]
    line_notes = {}    # (top-level element, line no) -> note
    for el, note in annotated.items():
        note = sanitize_note(note)
        top = el
        while top.parent is not None and top.parent is not body:
            top = top.parent
        if top is body:
            continue  # annotation not inside any block; drop
        if el is not top and 'line' in (el.get('class') or []) \
                and _is_fence_container(top):
            line_notes[(top, master.line_rank(top, el))] = note
        else:
            block_notes.setdefault(top, []).append(note)

    pieces = []
    for child in body.children:
        if isinstance(child, Comment):
            continue
        if isinstance(child, NavigableString):
            text = str(child).strip()
            if text:
                pieces.append(_esc_text(text, False))
            continue
        if not isinstance(child, Tag):
            continue
        lines = [master._marker_line(master.Marker('block', None, note))
                 for note in block_notes.get(child, [])]
        for (top, rank), note in line_notes.items():
            if top is child:
                lines.append(
                    master._marker_line(master.Marker('line', rank, note)))
        md = _block_md(child)
        if md:
            pieces.append('\n'.join(lines + [md]))
        elif lines:
            raise MigrationError('annotated block serialized to nothing')

    raw = '\n\n'.join(pieces)
    if not raw.strip():
        return ''
    try:
        return master.serialize_master(master.parse_master(raw))
    except master.MasterError as exc:
        raise MigrationError(
            f'migrated master is not representable: {exc}') from exc


def migrate_legacy_doc(
    html_path: Path,
    master_path: Path,
    archive_path: Path,
    baseline_path: Path,
) -> str:
    """Convert a legacy HTML doc into a markdown master (first open).

    Writes ``master_path`` and snapshots it as the consume baseline
    (``baseline_path``), then moves the old file to ``archive_path``.
    Returns the master markdown text.
    """
    try:
        html_text = html_path.read_text(encoding='utf-8-sig')
    except UnicodeDecodeError as exc:
        raise MigrationError(f'legacy doc is not UTF-8 text: {exc}') from exc
    except OSError as exc:
        raise MigrationError(f'cannot read legacy doc: {exc}') from exc

    master_text = _master_from_html(html_text)

    try:
        master_path.parent.mkdir(parents=True, exist_ok=True)
        write_text_lf(master_path, master_text)
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        write_text_lf(baseline_path, master_text)
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(html_path, archive_path)
    except OSError as exc:
        raise MigrationError(f'migration write failed: {exc}') from exc
    return master_text
