# Annotation protocol

How annotations are stored, addressed, and consumed. Evolved from
ppt-master's SVG annotation mechanism (and an interim HTML-attribute
medium) to the C route: marker lines in a markdown master document; the
HTML the editor shows is a projection rendered on the fly.

## Storage: annotations are marker lines in the master

The truth source is the master, `.pinpoint/docs/<name>.md`. An
annotation lives in it as an HTML-comment line directly above the block
it refers to:

    <!-- pp: rewrite this intro -->        block note: annotates the block below
    <!-- pp@3: rename this variable -->    line note: line 3 of the fenced block below

- There is no sidecar file and no database. The annotation travels with
  its block through any edit that does not delete the block.
- Marker lines are structurally transparent: they never split or merge
  blocks, and a master with all marker lines removed is plain markdown —
  which is exactly what `export.py` produces.
- Line notes address fenced blocks only (code or drawn figures); N
  counts content lines, 1-based, blanks included, and must fall inside
  the fence. A block carries at most one block note.
- A note's text must fit on one line and cannot contain `-->`.

## Addressing: temp ids live in the projection only

- The editor never reads the master itself; the server renders it to a
  projection HTML on every request (cached in memory by the master's
  content hash, never written to disk). A master edit invalidates the
  cache automatically.
- While the editor runs, every annotatable element in the projection
  gets a temporary id `_pp_0`, `_pp_1`, ... (assigned fresh per served
  version, in document order). The server keeps that version's mapping
  `temp id -> (master block index, fence line)` in memory.
- On **Apply changes** the server translates staged annotations back
  into marker lines in the master (block note above the block, `pp@N`
  above the fence); direct edits rewrite the master's block text. Temp
  ids never reach disk: the master at rest is clean markdown.
- Annotatable elements in the projection: `p h1-h6 ul ol li dl dt dd
  blockquote pre table tr td th img hr figure figcaption div section
  article header footer main aside nav`. Inline elements (`strong em
  code a`) are reached through their block ancestor. Code fences get
  one `<span class="line">` per source line, each addressable; a `pp@N`
  marker lands on that Nth line.
- Diagram figures (`figure.pp-diagram`, from drawn-figure fences:
  ` ```mermaid `, ` ```mockup `, ` ```svg `) get one `<div class="line">`
  per source line. The editor renders the source live at runtime —
  mermaid SVG, or a sanitized DOM injection for mockup/svg (scripts,
  `<style>`, `on*` handlers, and link navigation are stripped; the CSP
  is the second gate) — and maps drawn elements back to the line that
  defines them, so an element click annotates that line; the mapping is
  heuristic (mermaid id/label matching; sequential opening-tag alignment
  for mockup/svg) and falls back to the whole figure. The rendering never
  enters any file — only the master's source lines do.

## Lifecycle

```
user clicks element, writes note, presses "Add annotation"
        │  (staged in server memory)
        ▼
"Apply changes"  → marker lines written into docs/<name>.md
        │           + direct edits applied to the master's block text
        │           + empty-block claim recorded: untouched blocks are
        │             'undecided' (default) or 'agreed' (0026);
        │             nothing staged anywhere = full agreement (0015)
        │           + baseline snapshot state/<name>.base.md updated
        │           + apply event + annotation_saved / annotation_updated /
        │             annotation_removed records → annotations.jsonl
        │           + state/empties.json updated (per-doc, survives rounds)
        │           + apply epoch bumped → /api/wait releases wait.py
        ▼
wait.py prints the digest  →  AI edits the master,
        │           resolves the note (deletes the marker)
        ▼
consume.py <doc>  →  re-anchors the edits, acks deleted markers,
        │           appends annotation_applied to annotations.jsonl,
        │           refreshes the baseline snapshot
        ▼
next round, or convergence
```

The apply epoch makes the round-trip automatic: `wait.py` blocks on
`/api/wait` until a fully successful Apply moves the epoch past its
last-digested snapshot (kept in `state/digest.json`), then prints the
digest itself — the user never has to repeat the apply in chat. A
failed Apply (a note no longer matches any block) bumps nothing, so
the waiter sleeps on until the user resolves and Applies again. An
Apply with **nothing staged** is a valid submission — full agreement:
the epoch bumps, the waiter releases with an empty file list, and
`wait.py` says so explicitly instead of printing a bare empty digest.
An Apply **with** staged work releases with an `empties` line saying
what its untouched blocks mean (see Empty-block semantics).

Every note must end in one of exactly two ways: consumed (marker
deleted, consume recorded the ack — content changed too means
fix-and-ack; nothing changed means the decision gets explained in chat)
or explicitly withdrawn by the user in the UI (annotation_removed audit
record). A note that is read but neither fixed nor explained is a
protocol violation — and deleting a marked block together with its
marker refuses the whole consume round (the red line: resolve the note
first, then restructure).

## Empty-block semantics (0026)

An Apply with staged work must say what the blocks it did **not**
touch mean — the confirm modal's radio, defaulting to **not decided
yet**. Silence is not consent; "undecided" is a stated position, not
an oversight or approval.

- `undecided` (default): the un-annotated blocks are held, not
  approved. `wait.py` prints `[APPLIED] empties=undecided` — consume
  the notes, then wait again; the round is not converged.
- `agreed`: the rest is approved. `wait.py` prints
  `[APPLIED] empties=agreed` — once the notes are consumed the
  document is converged.
- Nothing staged anywhere (full agreement, 0015) approves every
  document; the choice does not apply.

The claim is first-class state: recorded per doc in
`state/empties.json` and as an `apply` audit record, surviving rounds
until a later Apply supersedes it. Docs untouched by a partial Apply
keep their own state — an undecided round on one doc never
un-converges another. `export.py` enforces convergence as a hard
gate (unconsumed markers or `undecided` refuse with a reason);
`--draft` exports a marked working snapshot for the case where the
answered part must steer the work while the rest is still held.

## Baseline snapshots

`state/<name>.base.md` is the master as of the last sync point; consume
reconciles the AI's edits against it (LCS re-anchoring over block
content; changed content = the same block updated, inheriting identity
and markers; new blocks get fresh labels). It is written at exactly
three points:

- the server's **Apply changes**;
- a successful **consume**;
- **migration** (a master comes into existence).

## Direct edits (the no-AI channel)

The user can edit the text of an element themselves in the browser.
Staged edits are held in server memory and written by **Apply changes**
directly into the master. Each edit appends a record to
`.pinpoint/edits.jsonl`:

```json
{"ts": 0, "file": "<name>.md", "element_id": "<id>", "action": "edit",
 "kind": "text", "old": "<old text>", "new": "<new text>"}
```

The AI never acts on them individually: `digest.py` shows only the
edits since its last run (read position kept in `state/digest.json`),
for awareness — Apply already changed the master. Limitations: only
elements with no element children can be direct-edited (a paragraph
containing `<strong>` must go through annotation), and edits are plain
text — inline markup would be flattened, so the editor refuses.

## Legacy migration

A legacy `docs/<name>.html` (the pre-master storage medium, still what
`render.py` writes) migrates on first open: the server serializes the
HTML to master markdown (`migrate.py` — the validated 0003 read-side
serializer), writes `docs/<name>.md`, snapshots the baseline, and
archives the old file to `archive/<name>.html`. Pending annotations
travel along: block notes above their block, line targets as `pp@N`
above the fence; notes on sub-blocks (td/li/...) coarsen to the
enclosing top-level block. If migration fails, the legacy doc is served
as before and the old staging path keeps working. The doc's identity is
its filename, so the UI name changes `<name>.html` → `<name>.md` once,
at migration time (the editor auto-reopens the doc).

## Workspace cleanup (0027)

The workspace is append-only by design; `clean.py` is the exit. It
classifies every doc with the same convergence gate `export.py`
enforces (0026) — there is no second, looser notion of "done" for
cleaning than for exporting:

| Verdict | Condition |
|---|---|
| KEEP | unconsumed markers, or the last Apply left the rest `undecided` — the user's words and stated positions are never garbage, at any age |
| ARCHIVE | converged: no markers and `empties=agreed`; a `--name`d doc that passes the gate outright |
| ARCHIVE (time rule) | no markers, no Apply stance on record, untouched for `--stale-days` days (default 30; `0` disables) — the never-reviewed pile, mostly legacy HTML |

Migration leftovers (a legacy `docs/<name>.html` whose master exists)
always archive: the master is the truth. Dry-run is the default — the
verdict table prints, nothing is written; `--apply` executes,
`--hard` deletes instead of archiving. Archived files keep their
workspace-relative paths under `archive/<YYYYmmdd-HHMMSS>/`: one
reversible batch, restored by moving it back. A leaving doc's
baseline snapshot and `empties.json` entry go with it; orphaned
baselines and assets nothing references are swept into the same
batch. `annotations.jsonl` is never touched (audit memory outlives
docs), and `--apply` refuses while a server holds the workspace — a
live Apply would resurrect archived docs (`--force` overrides).

## Audit files

All JSONL, one record per line, UTF-8, under the workspace root
(`<project>/.pinpoint/`):

| File | Written by | Records |
|---|---|---|
| `annotations.jsonl` | server (Apply), consume (acks) | `annotation_saved`, `annotation_updated`, `annotation_removed`, `annotation_applied`, `apply` (0026: `{empties, files}` — the Apply's empty-block claim) |
| `edits.jsonl` | server (Apply) | `edit` |
| `state/<name>.base.md` | server (Apply), consume, migration | baseline snapshot (markdown, not JSONL) |
| `state/empties.json` | server (Apply) | per-doc last-Apply empty-block state: `undecided` \| `agreed` (0026; read by the editor APIs and export.py's gate) |
| `state/digest.json` | digest.py, wait.py | `{"edits_pos": N}` — edits.jsonl read position; `{"apply_epoch": N}` (wait.py only) — last apply epoch digested, the baseline the next wait blocks from |
| `lock.json` | server | `{"pid": N, "port": N}` while running |
| `archive/<batch>/…` | server (migration), clean.py (0027) | archived legacy files, docs, baselines, assets — relative paths kept, reversible batches |
| `server.log` | server | daemon stdout/stderr |

Common record shape: `{ts, file, element_id, action, old, new}`. The AI
writes none of them by hand — Apply and consume handle the bookkeeping.
A consume ack of a note resolved without a content change can carry
`explain`: pass `--explain b<N>=<text>` to consume so a fix-less
resolution is recorded in the audit, not just spoken in chat.

## Intake normalization

`render.py` accepts any of these and produces the same clean IR
(no ids, no annotations, XML-well-formed):

- **Markdown** — split into top-level blocks; fenced code blocks become
  per-line spans; drawn-figure fences (` ```mermaid `, ` ```mockup `,
  ` ```svg `) become `figure.pp-diagram` with per-line divs (rendered
  live by the editor); local images are copied to `.pinpoint/assets/`
  and `src` rewritten to `../assets/<name>`; named HTML entities are
  converted to numeric form so ElementTree can parse the result.
- **HTML** — sanitized (scripts, iframes, objects, embeds, `on*` handlers,
  and `javascript:` URLs are stripped) and serialized as well-formed XHTML.
  Not full HTML5 error recovery: heavily malformed markup may nest oddly.
- **Image** — wrapped in a `<figure>`, asset copied. Images are annotated
  as a whole; for content you control, prefer a drawn figure, where
  annotation reaches individual elements via their source lines.

The rendered doc lands in `docs/` in the legacy `.html` format and
migrates to its master on first open (see Legacy migration).

UTF-8 BOM in input files is tolerated on read.
