/* Verify the diagram node->line mapping heuristic against the vendored
 * mermaid bundle, without a browser: render diagrams in jsdom, then run
 * the REAL mapping module the editor ships — static/diagram.js, imported
 * below — and report what maps where. No copied logic lives here, so the
 * verifier cannot drift from the editor.
 *
 * Manual dev tool (needs node + jsdom; not part of pytest):
 *   npm install jsdom            # anywhere resolvable, or set JS DOM_PATH
 *   node scripts/verify-mapping.cjs
 *
 * Re-run after upgrading static/vendor/mermaid.min.js — if node ids change
 * format, update MERMAID_ID_PREFIXES / tokensFromId in static/diagram.js
 * to match.
 */
const path = require('path');
const { pathToFileURL } = require('url');

function loadJsdom() {
  const candidates = [
    'jsdom',
    process.env.JSDOM_PATH,
    path.join(
        process.env.TEMP || '/tmp', 'opencode', 'pp-jsdom',
        'node_modules', 'jsdom'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      // try next
    }
  }
  console.error('jsdom not found; npm install jsdom (or set JSDOM_PATH)');
  process.exit(1);
}
const { JSDOM } = loadJsdom();

const SKILL = path.resolve(__dirname); // run with cwd = pinpoint/scripts

const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="d"></div></body></html>',
    {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/',
    });
const { window } = dom;

// jsdom lacks the geometry APIs mermaid uses; stub enough of them.
const zero = () => ({
  x: 0, y: 0, width: 10, height: 10,
  top: 0, left: 0, right: 10, bottom: 10,
});
window.HTMLElement.prototype.getBBox = zero;
window.SVGElement.prototype.getBBox = zero;
window.SVGGraphicsElement = window.SVGElement;
if (!window.Element.prototype.getScreenCTM) {
  window.Element.prototype.getScreenCTM = () => ({
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
    inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  });
}

// Execute the vendored bundle as a real global <script> (strict-mode vars
// only attach to globalThis via script evaluation, not via eval()).
const fs = require('fs');
const bundlePath = path.join(SKILL, 'static', 'vendor', 'mermaid.min.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');
try {
  const scriptEl = window.document.createElement('script');
  scriptEl.textContent = bundle;
  window.document.body.appendChild(scriptEl);
} catch (err) {
  console.error('bundle eval failed:', err && err.message);
  process.exit(1);
}
const mermaid = window.mermaid;
if (!mermaid) {
  console.error('window.mermaid missing after eval');
  process.exit(1);
}

// The mapping under test: the exact module the editor loads.
let buildNodeMap;
let buildMockupMap;
let diagramModuleForTests;

async function check(name, source) {
  const lines = source.split('\n');
  mermaid.initialize(
      { startOnLoad: false, securityLevel: 'strict', theme: 'default' });
  const { svg } = await mermaid.render(`${name}-1`, source);
  const host = window.document.createElement('div');
  host.innerHTML = svg;
  const lineEls = lines.map((t, i) => {
    const d = window.document.createElement('div');
    d.textContent = t || '\u00a0';
    d.id = `_L${i}`;
    return d;
  });
  const map = buildNodeMap(host, lineEls);
  console.log(`\n=== ${name} ===`);
  for (const m of map) {
    const tag = m.el.tagName.toLowerCase();
    const cls = (m.el.getAttribute('class') || '')
        .split(/\s+/).slice(0, 2).join('.');
    const raw = m.el.getAttribute('data-id') || m.el.getAttribute('id');
    const text = JSON.stringify(lines[Number(m.lineId.slice(2))]);
    console.log(
        `${tag} ${cls} id=${JSON.stringify(raw)} -> ${m.lineId} : ${text}`);
  }
  // Which ids exist but did NOT map?
  const mapped = new Set(map.map((m) => m.el));
  const unmapped = [];
  for (const el of host.querySelectorAll('svg [id], svg [data-id]')) {
    if (!mapped.has(el)) {
      unmapped.push(el.getAttribute('id') || el.getAttribute('data-id'));
    }
  }
  console.log('unmapped:', JSON.stringify(unmapped.slice(0, 12)));
}

// --- mockup figures: sanitized injection + sequential tag alignment ---

function checkMockup(name, source, expect) {
  const lines = source.split('\n');
  const canvas = window.document.createElement('div');
  const parsed = new window.DOMParser().parseFromString(source, 'text/html');
  diagramModuleForTests.sanitizeFigureBody(parsed.body);
  for (const child of [...parsed.body.childNodes]) {
    canvas.appendChild(window.document.importNode(child, true));
  }
  const lineEls = lines.map((t, i) => {
    const d = window.document.createElement('div');
    d.textContent = t || '\u00a0';
    d.id = `_L${i}`;
    return d;
  });
  const map = buildMockupMap(canvas, lineEls);
  console.log(`\n=== ${name} ===`);
  for (const m of map) {
    const text = JSON.stringify(lines[Number(m.lineId.slice(2))]);
    console.log(`${m.el.tagName.toLowerCase()} -> ${m.lineId} : ${text}`);
  }
  if (expect) {
    const got = map.map(
        (m) => `${m.el.tagName.toLowerCase()}@${m.lineId.slice(2)}`);
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) {
      console.log('PASS');
    } else {
      const detail =
          `expected ${JSON.stringify(expect)}, got ${JSON.stringify(got)}`;
      console.log(`FAIL: ${detail}`);
      process.exitCode = 1;
    }
  }
}

function checkSanitizer(name, source, expectAbsent, expectPresent) {
  const parsed = new window.DOMParser().parseFromString(source, 'text/html');
  const sanitize = diagramModuleForTests.sanitizeFigureBody;
  sanitize(parsed.body);
  const html = parsed.body.innerHTML.toLowerCase();
  const missing = expectAbsent.filter((s) => html.includes(s));
  const missingPresent = expectPresent.filter((s) => !html.includes(s));
  if (missing.length || missingPresent.length) {
    console.log(`\n=== ${name} === FAIL`);
    if (missing.length) {
      console.log('  still present:', JSON.stringify(missing));
    }
    if (missingPresent.length) {
      console.log('  lost:', JSON.stringify(missingPresent));
    }
    process.exitCode = 1;
  } else {
    console.log(`\n=== ${name} === PASS`);
  }
}

(async () => {
  const mod = await import(
    pathToFileURL(path.join(SKILL, 'static', 'diagram.js')).href
  );
  buildNodeMap = mod.buildNodeMap;
  buildMockupMap = mod.buildMockupMap;
  diagramModuleForTests = mod;
  await check('flow',
      'flowchart LR\n    client --> gateway --> service\n'
      + '    service --> db[(replica)]');
  await check('flow-multiline',
      'flowchart TD\n    A[Draft] --> B{Review}\n'
      + '    B -->|reject| A\n    B -->|approve| C[Published]');
  await check('seq',
      'sequenceDiagram\n    Alice->>Bob: Hi\n    Bob-->>Alice: Hello');
  await check('class', 'classDiagram\n    Animal <|-- Dog\n    Animal: +name');
  await check('state',
      'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running: start');

  checkMockup(
    'mockup-toolbar',
    '<div style="display: flex; gap: 8px">\n'
    + '  <button style="padding: 4px 12px">Save</button>\n'
    + '  <button style="padding: 4px 12px">Cancel</button>\n'
    + '</div>',
    ['div@0', 'button@1', 'button@2'],
  );
  checkMockup(
    'mockup-nested',
    '<div style="padding: 10px">\n'
    + '  <div style="border: 1px solid #ccc">Card</div>\n'
    + '</div>',
    ['div@0', 'div@1'],
  );
  checkMockup(
    'mockup-table-tbody-synthesized',
    '<table style="border-collapse: collapse">\n'
    + '  <tr><td style="padding: 4px">a</td></tr>\n'
    + '  <tr><td style="padding: 4px">b</td></tr>\n'
    + '</table>',
    ['table@0', 'tr@1', 'td@1', 'tr@2', 'td@2'],
  );
  checkSanitizer(
    'mockup-sanitized',
    '<div id="keep"><style>.x{color:red}</style>'
    + '<script>alert(1)</script>'
    + '<a href="https://evil.example" onclick="pwn()">link</a>'
    + '<img src="x.png" alt="pic"></div>',
    ['<style', '<script', 'onclick', 'href=', 'id="'],
    ['<img', 'alt="pic"', '<a'],
  );
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error('FAILED:', err && (err.stack || err.message || err));
  process.exit(1);
});
