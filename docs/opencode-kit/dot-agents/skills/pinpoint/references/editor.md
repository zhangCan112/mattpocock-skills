# Editor server

Browser editor behind pinpoint. Behavior and lifecycle adapted from
ppt-master's live preview server. The loop in `SKILL.md` owns when to
launch it and how annotations get applied.

## Commands

```bash
python ${SKILL_DIR}/scripts/server.py --daemon              # start in background, open browser
python ${SKILL_DIR}/scripts/server.py --daemon --no-browser # remote host
python ${SKILL_DIR}/scripts/server.py --shutdown            # stop (idempotent)
python ${SKILL_DIR}/scripts/server.py --port 6200           # bind exactly this port
python ${SKILL_DIR}/scripts/server.py --timeout 0           # never auto-stop
python ${SKILL_DIR}/scripts/wait.py                         # block until the user applies, print the digest
python ${SKILL_DIR}/scripts/clean.py [--apply]              # archive finished reviews out of the doc list
```

(Use `python3` on macOS/Linux.) The launcher starts the server detached,
waits for `/api/health`, records `pid` + `port` in
`<project>/.pinpoint/lock.json`, then opens the browser.

## Lifecycle

- **Port**: first free port from `6160` unless `--port N` binds strictly.
  Read the real URL from launch output or `lock.json`; never assume `6160`.
- **One server per workspace**: a second launch reuses the running one
  (and prints its URL) instead of failing. A different explicit `--port`
  while one runs is an error — `--shutdown` first.
- **Idle timeout**: 900 s without any request stops the server
  (`--timeout N` overrides, `0` disables) — but only when nothing is
  staged and no editor tab is open. The page heartbeats `/api/health`
  every 60 s (and immediately on tab wake), so an open tab keeps the
  server alive through any review gap. While unapplied staged work
  exists, auto-stop never fires at all; an over-time reading also needs
  two consecutive watchdog ticks (wake grace). Staged work is lost only
  via the **Exit** button (the UI warns first), `--shutdown`, or an
  external kill — never via idleness. The agent-side waiter
  (`wait.py`, holding a `/api/wait` request open) deliberately does
  **not** count as activity: it must not keep the server alive, so the
  wait is bounded by the server's own lifecycle.
- **Stop conditions**: **Exit** button in the browser (only UI action that
  stops the server), `--shutdown`, idle timeout (see its guard above),
  or external kill. Stale locks (dead pid) are overwritten on next
  launch.
- **Workspace cleanup**: reviews accumulate in `docs/` and every open
  lists them all. `clean.py` archives what is provably finished —
  converged by the same gate `export.py` enforces — into
  `archive/<timestamp>/` (baselines, empties entries and orphaned
  assets swept with the batch). Dry-run by default; `--apply`
  executes, `--hard` deletes, `--stale-days` (default 30) governs
  never-reviewed leftovers. Docs with unconsumed markers or an
  `undecided` hold always stay, `annotations.jsonl` is never touched,
  and `--apply` refuses while a server holds the workspace (a live
  Apply would resurrect archived docs; `--force` overrides).

## The two channels

- **Opening a document**: the editor auto-opens the most recently modified
  document on load; a URL hash (`/#<doc-name>.html`) deep-links to a
  specific document and survives refresh.

- **Annotate** (AI changes): click a block, write the instruction,
  **Add annotation**. Staged in server memory. Nothing touches disk until
  **Apply changes**. Re-clicking an annotated block (or its entry in the
  annotation list) backfills the note for review; editing and re-adding
  updates it — the button switches to **Update annotation**.
- **Direct edit** (no AI): click a plain-text block, edit the text,
  **Stage edit**. Shows in the preview at once. Plain-text blocks only —
  a paragraph with inline markup (`<strong>`, links) must use annotation.
  **Undo** drops the last staged edit on the current document (LIFO).

**Apply changes** asks for confirmation first (a modal listing what
would be submitted — N annotations, M direct edits, note deletions —
because the click immediately releases the AI-side waiter; the modal
also carries the 0026 radio *Blocks you did NOT annotate mean…*:
**not decided yet** (the default, re-selected every time it opens) or
**agree** — silence is not consent, so the user must say which; with
nothing staged the radio is hidden and the modal asks to **submit as
full agreement**, which is a real submission: the epoch bumps, the
waiter releases, and the agent prints an explicit approval note). On
confirm it writes staged annotations and direct edits to
`.pinpoint/docs/*.md`, appends audit records (including an `apply`
event carrying the empties choice), records the doc's empty-block
state in `state/empties.json` (a nothing-staged Apply approves every
doc), bumps the apply epoch (releasing any `/api/wait` caller —
`wait.py` then prints the digest with an `empties=…` line), and keeps
the server running. A **failed** Apply releases nothing: fix what it
names and Apply again. After the AI consumes notes, the user presses
**Reload** to see the revised document. The status strip shows the
doc's last-Apply state — `last apply: rest not decided (not
converged)` or `rest agreed` — so a held position stays visible to
its holder.

**Notes follow their blocks.** While work is staged, the AI's consume
round may edit the same master; every `_pp_N` id after the edit shifts.
The server re-anchors staged annotations and direct edits to the current
projection by content fingerprint on every serve, so notes follow their
blocks through unrelated edits. A note whose block was deleted or
rewritten is flagged in the list (*block changed or deleted — re-place
or remove this note*), keeps out of the body highlights, and **Apply
refuses the document, naming the note**, instead of silently dropping
it — resolve it (re-place or delete), then Apply again.

## Drawn figures

Docs written from markdown may contain drawn figures (`figure.pp-diagram`
holding the source as per-line divs): ` ```mermaid ` diagrams, ` ```mockup `
UI sketches (inline-styled HTML), ` ```svg ` pictures. The editor renders
them client-side:

- **Mermaid**: `static/vendor/mermaid.min.js` (mermaid 11, IIFE build,
  loaded same-origin before `app.js`). No CDN, no network at edit time;
  the strict CSP stands (`script-src 'self'`). If the file is missing,
  diagrams degrade to their source lines — still annotatable.
- **Mermaid rendering**: `securityLevel: strict` (labels sanitized, click
  callbacks off), `theme: default`, rendered per figure on load and
  Reload. A failed render shows the error and falls back to source view.
- **Mockup/svg rendering**: the source lines are parsed, sanitized
  (scripts, iframes, `<style>`, templates, `on*` attributes, element ids,
  and link/form navigation are stripped — the strict CSP is the second
  gate), and injected into the figure canvas. Mockups render in normal
  block flow, so inline-styled layout shows as authored.
- **Toggle**: each figure carries a *View source* / *View diagram*
  (*View mockup* for mockups) toggle. In source view the per-line divs
  behave like code lines — clickable, annotatable, directly editable.
- **Element clicks**: clicking a drawn element selects the source line
  that defines it (heuristic: mermaid id/label matching; sequential
  opening-tag alignment for mockup/svg), so the annotation lands on an
  element that exists in the doc. Clicking anything else selects the
  figure. Lines carrying annotations glow amber on the drawn elements.

## Remote access

On a remote host run with `--no-browser`, then with `<P>` from launch
output or `lock.json`: VS Code / Cursor Remote-SSH — forward `<P>` in the
**PORTS** panel; plain SSH — `ssh -L <P>:127.0.0.1:<P> <user>@<host>`.
Open `http://localhost:<P>`.

The server binds `127.0.0.1` only, rejects foreign `Host`/`Origin`
headers, and serves a strict-CSP page (scripts, connect, and images are
same-origin only).

## Dependencies

`annotations.py` uses only the standard library. The CLI tools
(`render.py`, `master.py`, `digest.py`, `consume.py`, `export.py`,
`migrate.py`) and the editor server need `markdown`, `beautifulsoup4`,
and `flask>=3.0.0` (auto-installed on first use):

```bash
pip install flask markdown beautifulsoup4
```

Python 3.9+ on Windows and macOS.
