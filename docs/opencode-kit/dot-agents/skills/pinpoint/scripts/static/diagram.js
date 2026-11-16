/* pinpoint drawn-figure module: mermaid rendering + node mapping, plus
 * mockup/svg rendering + element mapping.
 *
 * Extracted from app.js so that scripts/verify-mapping.cjs imports the
 * SAME mapping modules the editor ships (it used to carry a verbatim copy
 * that drifted). Consumers:
 *   - static/app.js:            enhanceDiagrams / refreshDiagramMarkers
 *   - scripts/verify-mapping.cjs: buildNodeMap, buildMockupMap (dynamic import)
 *
 * No window/document access at module top level: the module must stay
 * importable from Node. Everything DOM-ish happens inside functions.
 *
 * deps = {
 *   mermaid:        the mermaid instance (undefined -> degrade to source view)
 *   isAnnotated(id): true when the source line carries an annotation
 *   isSelected(id):  true when the source line is the current selection
 *   onSelect(id):    select a doc element; onSelect(null) clears selection
 * }
 */
'use strict';

let mermaidInitialized = false;
let diagramSeq = 0;

const MERMAID_ID_PREFIXES = [
  'flowchart-', 'state-', 'statediagram-state-', 'classId-', 'mindmap-', 'er-',
];

// Figure languages that are NOT mermaid: the source lines are markup
// (inline-styled HTML for mockup, SVG for svg) and the editor renders
// them with a sanitized DOM injection instead of mermaid.render.
const MOCKUP_LANGS = new Set(['mockup', 'svg']);

// Elements the HTML parser synthesizes that never appear as source lines
// ("<table>" implies a tbody the source never wrote) — skipped by the
// mockup element mapping so following elements stay aligned.
const MOCKUP_SYNTHETIC_TAGS = new Set(['TBODY']);

// Elements dropped outright from mockup/svg source before injection.
// <style> is dropped because its rules would leak into the whole editor
// page (mockups express styling inline); scripts etc. are also blocked
// by the CSP — this is defense in depth, not the only gate.
const FIGURE_DROP_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE',
  'STYLE', 'TEMPLATE', 'NOSCRIPT',
]);

// URL-bearing attributes: javascript: values are stripped everywhere;
// on A/AREA the href is stripped outright (a mockup link that really
// navigated would leave the editor page — mockups are pictures).
const FIGURE_URL_ATTRS = new Set([
  'HREF', 'XLINK:HREF', 'ACTION', 'FORMACTION', 'POSTER', 'BACKGROUND',
]);

function ensureMermaid(mermaid) {
  if (!mermaid) return false;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });
    mermaidInitialized = true;
  }
  return true;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function diagramLines(fig) {
  return Array.from(fig.children).filter(
    (el) => el.tagName === 'DIV' && el.classList.contains('line'),
  );
}

function lineTextsOf(lines) {
  return lines.map((el) => el.textContent.replace(/\u00a0/g, ''));
}

function tokensFromId(raw) {
  let value = raw;
  for (const prefix of MERMAID_ID_PREFIXES) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length);
  }
  value = value.replace(/[-_]\d+$/, '');
  if (!value) return [];
  if (value.startsWith('L_')) {
    // Flowchart edge path L_A_B_0: both endpoints are useful tokens.
    return value.slice(2).replace(/_\d+$/, '').split('_');
  }
  return [value];
}

function wordMatch(token, text) {
  // Word-boundary match so node "B" does not hit a line defining "AB".
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_])${escapeRegExp(token)}($|[^A-Za-z0-9_])`,
  );
  return pattern.test(text);
}

function lineIndexForTokens(tokens, lineTexts) {
  if (!tokens.length) return -1;
  if (tokens.length === 1) {
    return lineTexts.findIndex((t) => wordMatch(tokens[0], t));
  }
  // An edge's id carries both endpoints, in traversal order: prefer the
  // line mentioning them in that order, then in any order, then the first.
  const inOrder = lineTexts.findIndex((t) => {
    let pos = 0;
    for (const token of tokens) {
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9_])${escapeRegExp(token)}($|[^A-Za-z0-9_])`,
      );
      const found = pattern.exec(t.slice(pos));
      if (!found) return false;
      pos += found.index + found[0].length;
    }
    return true;
  });
  if (inOrder !== -1) return inOrder;
  const all = lineTexts.findIndex(
    (t) => tokens.every((token) => wordMatch(token, t)),
  );
  if (all !== -1) return all;
  return lineTexts.findIndex((t) => wordMatch(tokens[0], t));
}

function lineIndexForLabel(label, lineTexts) {
  const text = label.trim();
  if (text.length < 2) return -1;
  return lineTexts.findIndex((t) => t.includes(text));
}

export function buildNodeMap(canvas, lines) {
  // Best-effort mapping of drawn SVG parts -> source line element id.
  const lineTexts = lineTextsOf(lines);
  const map = [];
  for (const el of canvas.querySelectorAll('svg [id], svg [data-id]')) {
    const raw = el.getAttribute('data-id') || el.getAttribute('id');
    let idx = -1;
    if (raw) {
      idx = lineIndexForTokens(tokensFromId(raw), lineTexts);
    }
    if (idx === -1) {
      idx = lineIndexForLabel(el.textContent || '', lineTexts);
    }
    if (idx !== -1 && lines[idx].id) {
      map.push({ el, lineId: lines[idx].id });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Mockup / svg figures: sanitized injection + element mapping
// ---------------------------------------------------------------------------

function openingTagPattern(tag) {
  // An opening tag for tag: not a closing tag, tag name on a word
  // boundary (button must not match <buttonx), case-insensitive
  // (HTML tags are lowercased by the parser, svg keeps camelCase).
  return new RegExp(`<(?!/)${tag}(?=[\\s/>])`, 'i');
}

export function buildMockupMap(canvas, lines) {
  // Best-effort mapping of injected mockup elements -> source line id.
  // Heuristic: sequential alignment over opening tags, with a per-line
  // budget (a line like "<tr><td>a</td></tr>" holds two opening tags and
  // may claim two elements before the cursor moves past it). Works when
  // the source keeps roughly the "one element per line" discipline the
  // skill asks for; any element whose tag cannot be found from the
  // cursor onward stays unmapped and its click degrades to the figure.
  const lineTexts = lineTextsOf(lines);
  const budget = lineTexts.map(countOpeningTags);
  const used = lineTexts.map(() => 0);
  const map = [];
  let cursor = 0;
  for (const el of canvas.querySelectorAll('*')) {
    if (MOCKUP_SYNTHETIC_TAGS.has(el.tagName)) continue;
    const pattern = openingTagPattern(el.tagName);
    let idx = -1;
    for (let j = cursor; j < lineTexts.length; j++) {
      if (used[j] < budget[j] && pattern.test(lineTexts[j])) {
        idx = j;
        break;
      }
    }
    if (idx === -1) continue; // cursor unchanged: a later sibling may match
    used[idx] += 1;
    if (used[idx] >= budget[idx]) cursor = idx + 1;
    else cursor = idx;
    if (lines[idx].id) {
      el.classList.add('pp-mapped');
      map.push({ el, lineId: lines[idx].id });
    }
  }
  return map;
}

function countOpeningTags(text) {
  const matches = text.match(/<(?!\/)[a-zA-Z][a-zA-Z0-9-]*(?=[\s/>])/g);
  return matches ? matches.length : 0;
}

export function sanitizeFigureBody(body) {
  // Strip everything that could execute, navigate, or leak styles from
  // parsed mockup/svg markup before it is injected into the editor page.
  // The CSP (script-src 'self', no object-src) is the second gate.
  // Exported so verify-mapping.cjs can exercise the exact editor path.
  for (const el of [...body.querySelectorAll('*')]) {
    if (FIGURE_DROP_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    if (el.tagName === 'FORM') {
      // A form is layout, not a control: keep its children unwrapped.
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toUpperCase();
      if (name === 'ID' || name.startsWith('ON')) {
        el.removeAttribute(attr.name); // ids are projection-only; on* is script
        continue;
      }
      if (FIGURE_URL_ATTRS.has(name)) {
        const value = attr.value.trim().toLowerCase();
        const inert = (name === 'HREF' || name === 'XLINK:HREF')
          && (el.tagName === 'A' || el.tagName === 'AREA');
        if (inert || value.startsWith('javascript:')) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
}

// Re-apply annotation + selection markers to every mapped node under
// root. Replaces app.js's old markNotedNodes + updateDiagramNodeSelection.
export function refreshDiagramMarkers(root, deps) {
  for (const fig of root.querySelectorAll('figure.pp-diagram')) {
    refreshFigureMarkers(fig, deps);
  }
}

function refreshFigureMarkers(fig, deps) {
  const map = fig.__ppMap || [];
  let any = false;
  for (const entry of map) {
    const noted = deps.isAnnotated(entry.lineId);
    entry.el.classList.toggle('pp-noted', noted);
    any = any || noted;
  }
  fig.classList.toggle('pp-has-notes', any);
  for (const entry of map) {
    entry.el.classList.toggle(
        'pp-node-selected', deps.isSelected(entry.lineId));
  }
}

// Enhance every figure.pp-diagram under root: dispatch on data-lang
// (mermaid -> SVG rendering; mockup/svg -> sanitized DOM injection),
// map drawn elements to source lines, wire the source toggle and click
// routing.
export function enhanceDiagrams(root, deps) {
  for (const fig of root.querySelectorAll('figure.pp-diagram')) {
    setupDiagramFigure(fig, deps);
  }
}

function setupDiagramFigure(fig, deps) {
  if (fig.dataset.ppReady === 'true') return;
  fig.dataset.ppReady = 'true';

  const lang = (fig.dataset.lang || 'mermaid').toLowerCase();
  const isMockup = MOCKUP_LANGS.has(lang);
  const viewLabel = lang === 'mockup' ? 'View mockup' : 'View diagram';

  const lines = diagramLines(fig);
  const source = lineTextsOf(lines).join('\n');

  const canvas = document.createElement('div');
  canvas.className = 'pp-canvas';
  fig.appendChild(canvas);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pp-toggle';
  toggle.textContent = 'View source';
  toggle.title = 'Switch between the rendered figure and its source';
  fig.appendChild(toggle);

  function setSourceMode(on) {
    fig.dataset.ppSource = on ? 'true' : 'false';
    fig.classList.toggle('pp-source-mode', on);
    toggle.textContent = on ? viewLabel : 'View source';
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setSourceMode(fig.dataset.ppSource !== 'true');
  });

  fig.addEventListener('click', (e) => {
    if (e.target.closest('.pp-toggle')) return;
    e.stopPropagation(); // mermaid assigns its own ids inside the svg
    // A click on a visible source line (or the figure chrome) keeps the
    // default closest-[id] behaviour.
    const idEl = e.target.closest('[id]');
    if (idEl && fig.contains(idEl) && !canvas.contains(idEl) && idEl.id) {
      deps.onSelect(idEl.id);
      return;
    }
    let hit = null;
    for (let node = e.target; node && node !== fig; node = node.parentElement) {
      const found = (fig.__ppMap || []).find((m) => m.el === node);
      if (found) { hit = found; break; }
    }
    if (hit) {
      deps.onSelect(hit.lineId);
      if (fig.dataset.ppSource !== 'true') {
        fig.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } else if (fig.id) {
      deps.onSelect(fig.id);
    } else {
      deps.onSelect(null);
    }
  });

  function renderMockupFigure() {
    // The source lines are markup: parse, sanitize, inject. Mapping
    // clicks back to lines works like the mermaid path — via __ppMap.
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    sanitizeFigureBody(parsed.body);
    if (parsed.body.children.length === 0) {
      fig.classList.add('pp-failed');
      const note = document.createElement('div');
      note.className = 'pp-error';
      note.textContent = 'Mockup render failed: source has no elements';
      canvas.replaceChildren(note);
      setSourceMode(true); // degrade: keep source visible + annotatable
      return;
    }
    for (const child of [...parsed.body.childNodes]) {
      canvas.appendChild(document.importNode(child, true));
    }
    fig.__ppMap = buildMockupMap(canvas, lines);
    refreshFigureMarkers(fig, deps);
  }

  async function renderDiagram() {
    if (!ensureMermaid(deps.mermaid)) {
      toggle.hidden = true;
      setSourceMode(true); // degrade: keep source visible + annotatable
      return;
    }
    try {
      const id = `pp-mermaid-${++diagramSeq}`;
      const { svg } = await deps.mermaid.render(id, source);
      if (!canvas.isConnected) return; // doc switched mid-render
      canvas.innerHTML = svg;
      fig.__ppMap = buildNodeMap(canvas, lines);
      refreshFigureMarkers(fig, deps);
    } catch (err) {
      if (!canvas.isConnected) return;
      fig.classList.add('pp-failed');
      const note = document.createElement('div');
      note.className = 'pp-error';
      const reason = err && err.message ? err.message : err;
      note.textContent = `Diagram render failed: ${reason}`;
      canvas.replaceChildren(note);
      setSourceMode(true);
    }
  }

  setSourceMode(false);
  if (isMockup) renderMockupFigure();
  else renderDiagram();
}
