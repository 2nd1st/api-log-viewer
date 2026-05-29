# Philosophy — viewer

> This is the rendering layer's constitution. It is a companion to
> [`api-log/PHILOSOPHY.md`](../api-log/PHILOSOPHY.md), the backend constitution
> — read that first. The backend's job is to capture faithfully; the
> viewer's job is to help a human or AI agent understand what was
> captured. Different jobs, same discipline.

---

## Position

`api-log-viewer` is a **single-page Svelte 5 client that reads api-log's
public HTTP API** and renders the result for an operator who needs to
understand LLM-gateway traffic at a glance.

It is one of many possible consumers of the recorded JSONL — a desktop
GUI, a CLI tape player, a Jupyter notebook, an AI agent reading the
files directly are all equally legitimate. The viewer happens to be
the one that ships in-tree because every recording deployment needs
*some* way for a human to look at the data on day one. It is not
*the* frontend; it is *a* frontend.

Two consequences follow.

- **The viewer never holds state the backend doesn't already know
  about.** Filters, default paths, the admin token live in `localStorage`
  on the operator's device. Refreshing the page or opening a second
  device gives the same view from the same data. The viewer is
  stateless against the recording.
- **Anything the viewer can compute, an external tool can compute too.**
  Block adapters, conversation extraction, dashboards — they all read
  the same `/api/traces` and `/api/traces/:id` JSON. If the viewer
  computes something nobody else can, that's a signal we have pulled
  a feature behind a UI boundary that should have been left in the open.

---

## Why this exists (the gap)

The backend's recording is correct and queryable — but raw JSONL is
not human-legible. A multi-turn agent session is hundreds of HTTP
transactions, each with a thousand-line streaming SSE body containing
function calls, reasoning, tool results, image blobs and Chinese
prose. Asking the operator to `cat | jq` their way through that is the
modern equivalent of asking them to read pcap dumps with `od -c`.

The viewer's job is to do the per-block rendering work *once*, in
shared adapter code, so the operator's question — "what did the model
just do?" — costs one click instead of fifteen minutes of jq. The
backend made the data structurally legible; the viewer makes it
visually legible.

The viewer is the operator's `wireshark` to the backend's `tcpdump`.

---

## Seven principles

> **The chrome is what we cut, not what we add.** The capture surface is
> already small (backend principle 2). The render surface is the project's
> visible face — every pixel of chrome must earn its place. PRs that grow
> the chrome bear the burden of proof; the default answer to "let's also
> show X" is *no*.

### 1. Content owns the viewport.

The trace content — system prompts, user messages, assistant text,
tool calls, tool results, reasoning tombstones, media blobs — is the
king. Sidebars, headers, tab strips, filter pills, KPI cards exist
only to deliver the operator to content. They are not the product.

The testable consequence: at any breakpoint ≥1280px, the active
reading surface (the rendered transcript or dashboard chart row)
must hold **≥60% of the viewport width**. Filter sidebars, lists,
navigation rails together get the remaining ≤40%.

A PR that adds a permanent chrome surface — a permanent right-pane
inspector, a permanent breadcrumb rail, a permanent legend — must
either delete an existing chrome surface or shrink one. The chrome
budget is fixed.

### 2. Blocks are the unit of conversation, not messages.

The backend captures HTTP transactions. A protocol turn contains
*blocks*: `text`, `reasoning`, `tool_call`, `tool_result`, `media`,
`error`, `unknown`. The viewer renders blocks; it does not collapse
them into the legacy "user message / assistant message" pair the way
chat UIs traditionally do.

The testable consequence: every block type has its own renderer
component. Conversation tab is composition over those renderers. Block
counts are surfaced (operator wants to know "this trace had 7
tool_calls"). Tool_call ↔ tool_result are visually paired by id, not
by adjacency.

A PR that adds a "messages view" — even a "simpler messages view for
non-technical operators" — is rejected on sight. Block-native is the
viewer's identity.

### 3. Protocol knowledge lives in adapters; nowhere else.

`lib/adapters/{chat,messages,responses,gemini}.ts` is the only code
that knows that `function_call_arguments.delta` accumulates into a
`tool_call.input`, that Anthropic's `tool_use` and OpenAI Responses'
`function_call` are the same block, that Gemini's `parts` array maps
onto our `Block` union. Everything else — renderers, dashboards,
overview, exports — consumes the unified `Block[]` shape.

The testable consequence: adding a new protocol is exactly one new
file under `lib/adapters/` plus a routing entry in `adapters/index.ts`.
Renderers do not change. Dashboards do not change.

A PR that puts protocol-specific code in a renderer (e.g.
"if path includes /v1/responses, then ...") is rejected. The
discipline is the same as the backend's principle 1 carve-out: the
boundary is *provenance, not difficulty*. Anything a renderer needs
to know about a protocol must be expressed in the `Block` shape the
adapter emits.

### 4. We render what the recording shows; we synthesize nothing.

Mirroring backend principle 1: the viewer's data layer is the
captured JSONL. If a value is in the JSONL, we render it. If it
requires a price table, a tokenizer, a classifier, a heuristic, a
second-pass model — it does not live in the viewer.

`cost_usd` is not surfaced. `model_family = "claude"` is not
inferred. `quality_score`, `sentiment`, `topic` — none of these
exist as viewer concepts.

The carve-outs are the same as the backend's, and exactly the same
size:

1. **Per-block deterministic transforms.** Markdown rendering of text
   content, JSON pretty-print of tool inputs, base64 → image data-URL
   for media — all are encodings of named fields, not synthesis.
2. **Aggregation over loaded rows.** Block-type counts, top-tools
   bar chart, time-span sums — all are functions of the rows the
   viewer fetched. No external data, no second-pass model.

Note one carve-out the viewer takes that the backend does not:
**client-family detection from User-Agent strings** (`OverviewTab.svelte`
identifies codex / claude-code / opencode / cursor / curl / browser
from the captured UA header). This is a deterministic transform of a
named field — the UA is on the wire — but the labels are a small
hardcoded heuristic table. We accept it as a visualization aid;
operators see the raw UA right next to the label. If we ever wanted
this as backend-stored data, principle 1 of the backend would
forbid it as synthesis; that's why it lives in the renderer, not
on the wire.

### 5. Restraint is the aesthetic.

The viewer renders dense technical content. The chrome must get out
of the way of that content. We commit to a single visual register:

- **Single accent color.** Currently teal-300 (`#5eead4`). `--ok`,
  `--warn`, `--err` exist for severity signaling only and may not
  appear as decoration.
- **No role-coded background fills.** User / assistant / tool / system
  blocks differ by left-edge accent, weight, and spacing — never by
  background tint.
- **System fonts only.** `-apple-system` / `ui-monospace` stack.
  No webfonts. No `@import url(fonts.googleapis.com)`. The default
  Mac / Linux / Windows monospace is part of the restraint signature.
- **No motion as decoration.** Transitions exist only where they
  carry signal (collapse open, hover state, scroll-into-view). No
  parallax, no entrance animation, no decorative gradient.
- **No icons where text fits.** ASCII glyphs (`⚙`, `▸`, `←`, `─`,
  `▢`, `⚠`, `?`) for type markers; no SVG icon font.

The testable consequence: a fresh visitor's first impression should
read as "engineer's terminal tool", not "consumer SaaS dashboard".
The operator's first feedback on the initial pass — "AI 味重" (too
AI-flavored) — is the failure mode we measure against.

### 6. The viewer is composable, not authoritative.

The viewer is not the only way to look at this data and does not
claim to be. The recording is the source of truth; we are one
projection of it. PRs that make the viewer the dominant surface
(e.g. "operators must use the viewer to set retention policy") are
rejected. Operator policy lives in the backend config; we render it.

The testable consequence: a feature whose value depends on the
viewer being installed is wrongly placed. Examples that *belong*
elsewhere:

- **Plugin / gate / redact configuration** belongs in backend YAML
  config, not a viewer settings page. The viewer may *display* the
  current config, but does not own it.
- **Export of recorded JSONL** belongs equally well as a backend CLI
  subcommand and a viewer download page. We ship the viewer one
  because it's more discoverable for casual operators; the CLI exists
  for scripting.
- **Retention / archival rules** are backend concerns. The viewer
  shows the result; it does not author the rule.

### 7. The bundle stays small.

The current target is **<80 KB gzipped JavaScript**. The current
floor is ~47 KB. Each PR records the delta to the gzipped bundle
in its description.

The testable consequence: no chart libraries (we draw bars in
flexbox), no UI libraries (we write the components), no routing
libraries (we use hash routing), no state management libraries (we
use Svelte 5 runes), no webfonts. The maximum third-party
dependency we will accept is a ~3 KB markdown subset parser. The
day we cross 80 KB is the day we have an honest "what got bigger"
conversation in a PR review.

System budgets are how restraint stays alive past the first
honeymoon week.

---

## The "no" list

The following are out of scope. Not "maybe later." Out of scope.

- No prompt management UI, no template editor, no system-prompt
  library. The recording is read-only.
- No "AI-powered" features in the viewer: no auto-summarize, no
  auto-classify, no auto-tag, no model-inferred labeling. The
  viewer renders captured content; it does not reinterpret it. (Same
  bar as backend principle 1.)
- No editing of recorded traces. The viewer is read-only on the JSONL.
  Replay re-emits captured bytes; it does not mutate the recording.
- No multi-tenant model. No per-user views, no role-based access,
  no SSO. The deployment is `docker run` and the admin token is the
  authorization model.
- No saved searches, no shared filters, no per-user dashboards. State
  lives in URL hash + localStorage on the operator's device. If two
  operators want to share a view, they share the URL.
- No alerting / notifications / paging from the viewer. The browser
  is not a daemon. Alerting belongs to whatever the operator already
  runs (Loki + alertmanager, Grafana, Datadog).
- No real-time streaming dashboard. The viewer polls. If you need
  sub-second observability, you wanted Grafana, not us.
- No webfonts (principle 5).
- No router library, no UI library, no charting library (principle 7).
- No dark / light theme toggle. Dark only. The operator looking at
  HTTP traces at 2am does not want a sun-mode option.
- No translation framework. The chrome is English; the content is
  whatever the model wrote (markdown renderer handles any UTF-8).
- No A/B testing of the viewer itself. The viewer is a tool, not a
  product.
- No telemetry, no phone-home, no usage analytics. The deployment is
  local-only by design and tracking the operator would betray the
  trust that ships api-log inside private homelab networks.
- No third-party plugins / extensions / marketplaces. The viewer
  ships in-tree and operators who want different rendering write a
  different viewer.
- No mobile responsive layout. The viewer assumes ≥1280 px wide. If
  you need mobile, send the trace URL to a desktop session.
- **No "messages view" as a fallback for block-native** (principle 2).

---

## Why we said no to alternatives

### Why Svelte 5, not React / Vue / Solid

We considered React + Vite. The bundle floor was ~110 KB gz before
we wrote a line of feature code. We considered Vue 3 + Vite. The
bundle was lighter but the runes-style reactivity in Svelte 5 is
genuinely the cleanest expression of `derived + state` we have
written. We considered Solid for size; the ecosystem is too thin for
an operator who might one day need to read the source.

Svelte 5 hits the test: a single accent on this project is the
language, not a library. The runtime is ~5 KB and the compiler
generates code we can audit.

### Why hash routing, not a router library

Routing in this app is "which top-level view, and which trace id
selected". Two state slots. Adding `svelte-spa-router` or a
SvelteKit dependency for two state slots is overspend. Hash routing
in 40 lines of `$effect` is forever, and it does not break on
`file://` previews of the dist directory.

### Why a hand-written markdown parser, not `marked`

`marked` is 30 KB gz and `markdown-it` is 80 KB. We render a tiny
markdown subset (headers, emphasis, code, lists, links, blockquotes
— no tables, no raw HTML, no plugins). ~150 lines of regex
substitutions cover it at 1 KB. The cost saved is real budget
elsewhere, and refusing raw HTML eliminates the need for DOMPurify.

### Why localStorage, not a backend-managed user state

The viewer is stateless against the recording. If we put filter
preferences server-side, we have invented a user model — and once we
have a user model, we have RBAC, SSO, account recovery, etc. The
backend's `/healthz` endpoint and admin token are the whole identity
model. The viewer stays on that level.

### Why polling, not WebSocket / SSE

A live-streaming viewer is a different product. Polling at 5–10 s
cadence is enough resolution for the operator's actual question:
"is anything happening, and is it healthy?" The single answer "yes
or no" arrives in ≤10 s either way, and we get to skip an entire
class of backend WebSocket lifecycle code, reconnection state, lost-
event recovery. Backend principle 5 ("one process, one config")
informs this — pushing real-time delivery into the backend would
violate that for very little visible benefit.

### Why a single bundled SPA, not server-side rendering

There is no SEO. There are no anonymous visitors. The viewer loads
inside a homelab network for an authenticated operator. SSR's
benefits (initial paint speed, crawlability) do not apply; its costs
(separate Node process, hydration mismatches, framework lock-in to
Next/SvelteKit) are real. We ship `dist/` as static files; Caddy
file-serves them, reverse-proxies `/api/*` to the Go backend, done.

### Why CSS variables, not Tailwind

Tailwind is good when the design surface is large and changes
weekly. Our design surface is small and changes rarely. CSS variables
in `app.css` express the palette and spacing once; Svelte's scoped
`<style>` blocks make components self-contained without class
collisions. We considered Tailwind for the productivity boost; the
restraint we want (single accent, no role fills) is easier to police
when the palette is six lines of CSS variables than when it's a
sprawling utility class library.

---

## Engineering standards

The bar is **community standard** for a Svelte 5 + TypeScript SPA.
Reference points: SvelteKit's own UI, Vite's, Linear's web client.

**Style.** Prettier defaults for TS / Svelte. `svelte-check` clean —
0 errors at every commit on `main`. Warnings tolerated only when
they are documented pre-existing patterns (e.g. `<a onclick>` tab
strips inherited from the original viewer; we will replace with
`<button role="tab">` during the next visual pass).

**Components.** Single-file `.svelte` components. Script + markup +
scoped style live together. Per-component CSS uses the CSS variables
in `src/app.css`; no hex literals outside that file.

**State.** Svelte 5 runes only: `$state`, `$derived`, `$derived.by`,
`$effect`, `$props`, `$bindable`. No legacy `let` reactive
declarations. No store pattern unless the state genuinely needs to
cross component-tree boundaries — `localStorage` accessors in
`lib/api.ts` are the only such case today.

**Adapters.** Pure functions. Inputs: protocol-specific `TraceBlob`.
Output: `Block[]`. No side effects, no fetches, no DOM access.
Error path: emit an `error` Block, never throw.

**Renderers.** One per Block type, each in `components/blocks/`.
Renderers consume a single `Block` discriminant and an optional
`onJumpToPair` callback. No `$effect` doing fetches inside a
renderer — if you need data the adapter didn't provide, the adapter
is wrong, not the renderer.

**Bundle reporting.** Every PR description records the gzipped JS +
CSS delta from `pnpm build`. PRs that grow the bundle without a
clear "why" in the description are rejected.

**Tests.** Adapter unit tests against real samples in
`/tmp/sub2api-samples/details/` (or a checked-in fixture subset when
those rotate). The renderer surface is small enough that visual
regression is done by hand against the live `apilog-sub2gpt`
deployment per the iteration model (memory:
`project_iteration_model`). svelte-check is the only automated
gate.

**Deploy.** `pnpm build` produces `dist/`. Caddy serves it as
static. There is no Node process in production. There is no
hydration. There is no SSR build step.

---

## What this project looks like in five years

If we get the principles right, the following should still be true:

- The viewer is still a Svelte 5 SPA (or whatever Svelte 5 has
  become — runes were a good bet). The data adapters did the protocol
  work; the renderers stayed simple.
- The bundle is still under 80 KB gzipped JS.
- The aesthetic is still "engineer's terminal tool". A fresh
  operator's first impression matches Linear / Raycast / Cursor, not
  consumer-SaaS.
- The `lib/blocks.ts` shape has gained optional fields; the seven
  block discriminants are unchanged.
- New protocols have arrived (Gemini native, whatever comes after)
  and they were added as single adapter files. Renderers did not
  learn about them.
- A separate desktop GUI exists, written by someone else, consuming
  the same `/api/traces` endpoint. The viewer in this repo is one of
  several clients to the recording. We never tried to own the
  consumer ecosystem; we only own this one consumer.
- The `no` list is **longer**, not shorter.

That is what success looks like. Not feature parity with a SaaS
dashboard. Not a plugin marketplace. A small, sharp, durable client
for a small, sharp, durable recording — the way `wireshark` is to
`tcpdump`.
