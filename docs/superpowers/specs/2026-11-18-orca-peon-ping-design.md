# Peon Ping for Orca — design

Status: approved design, not yet built. v1.0 is macOS-only; see *Later, not now*.
Date: 2026-11-18
Owner: omar227 (GitHub), published as `omar227.peon-ping`

## Intent and why

Orca runs a fleet of coding agents in parallel. When one of them finishes, fails, or
stops to ask for something, Orca's only signal is a small OS notification in the corner
of the screen plus the default system notification chime.

That is not enough. The person using Orca is typically in a browser, in Slack, often
with music playing. The corner toast goes unseen and the default chime is short, quiet,
and identical for every kind of event. An agent can sit blocked on a permission prompt
for ten minutes before anyone notices.

peon-ping solved this for terminal agents: loud, long, character voice lines, with a
*different* line depending on what happened. OpenPeon then turned that into an open
standard — CESP, the Coding Event Sound Pack specification — with a public registry of
382 sound packs (Warcraft peons, GLaDOS, StarCraft, Duke Nukem, and a long tail of
community packs).

This project brings that into Orca as a first-class plugin, so that an Orca user who
has never heard of peon-ping can install one thing and immediately get audible,
distinguishable feedback from their agent fleet.

## Goals

1. Audible feedback for Orca agent lifecycle events, loud enough and long enough to cut
   through music and a browser window.
2. Different sounds for different kinds of event, so the sound alone tells you whether
   to go look.
3. Access to **every** pack in the OpenPeon registry — all 382 today, and new ones as
   they are added, without needing a plugin update.
4. Works on a fresh machine with nothing else installed. No peon-ping, no Node toolchain,
   no manual setup.
5. Published and listed on orca.dev so other Orca users can install it.

## Non-goals

- **Not** a peon-ping front end. It does not shell out to, depend on, or configure an
  existing peon-ping install. It is a standalone CESP player.
- **Not** cross-client. Audio playback shells out to the operating system's audio player
  and the status bar item is desktop-only, so Orca in a browser tab (`orca serve`) and
  Orca mobile get nothing. This is accepted.
- **macOS only in v1.0** (owner's decision). The author can only verify playback on
  macOS, and shipping an unheard audio path is exactly the anti-goal below. Linux and
  Windows are not attempted in v1.0; on those platforms the plugin loads, the panel works,
  and a clear "audio playback is macOS-only in this version" line replaces the pack list's
  install affordances. See *Later, not now* for how they get added.
- **Not** bundling audio. No `.wav`/`.mp3` files ship in the plugin repository. Every
  sound is fetched from the registry at runtime.
- **Not** reading terminal output. No `terminal:read` capability, no text sniffing, no
  heuristics about what an agent is saying.
- No telemetry, no analytics, no network traffic to anywhere except `github.com` and
  `peonping.github.io`.

## Anti-goals — what failure looks like

Per the owner: the only failure modes that matter are **the sounds don't play** or
**the plugin doesn't work**. Everything else is detail. Concretely:

- Sounds that fire but are inaudible, truncated, or delayed by seconds.
- A worker that idles out so the first event after a quiet period is silent.
- A pack install that half-completes and leaves a broken pack directory.
- A plugin that fails Orca's validator and never gets listed.

Reliability of playback beats feature surface everywhere they conflict.

## Constraints discovered during design

These were verified against Orca's source and docs (`docs/reference/plugin-*.md` in
`stablyai/orca`) and the OpenPeon registry. They are load-bearing; a builder should not
rediscover them the hard way.

### Orca cannot distinguish a plan review from a permission prompt

Orca's plugin event `agent.status.changed` reports a `state` of `working`, `blocked`,
`waiting`, or `done`, plus on `done` a `mainAgent.outcome` of `success`, `failure`,
`cancellation`, `superseded`, `interruption`, or `unconfirmed`.

`blocked` and `waiting` both mean "a human is needed." Orca's own sidebar collapses them
into a single `permission` status (see `src/shared/agent-status/presentation/agent-list-status.ts`,
which comments: *"Sidebar combines blocked/waiting as permission"*). There is no field
that separates "review this plan" from "approve this tool call."

The owner's explicit decision: **stay honest to what Orca reports.** Both map to a single
`input.required` sound. Do not add `terminal:read` and classify by text.

### Packs must be downloaded at runtime

The registry is 382 packs totalling ~890 MB. Orca caps a plugin at 50 MiB and 2,000
files, and the plugin directory rejects archives and binaries outright. Bundling is not
on the table at any scale. This is fine — runtime fetch also means new registry packs
appear without a plugin release.

### Panels have no network and cannot play audio

Orca plugin frames run with the network fully fenced off: anything not inside the plugin
folder, `data:`, or `blob:` fails to load, regardless of CSP. Packs live in
`~/.openpeon/packs/`, outside the plugin folder, so the panel can neither fetch the
registry nor load a sound file.

Therefore **all** network and audio work happens in the worker. The panel is a thin view
that talks to the worker over `plugin.request` / `panels.post`. One consequence for the
UI: no pack artwork, text only.

### The worker is a real Node process, and that is what makes this possible

The `trusted-worker` execution profile runs `main` in a separate Node process with
`node:` builtins and no sandbox. It can `fetch`, write to `~`, and `spawn` a system audio
player. Orca withholds tokens and `DISPLAY`/`WAYLAND_DISPLAY` from the worker env but
deliberately **keeps** `PATH`, `HOME`, `XDG_RUNTIME_DIR`, and `DBUS_SESSION_BUS_ADDRESS`
— which is exactly what PipeWire and PulseAudio need to reach the user's audio session.

### Worker lifecycle

A worker may be stopped when idle and restarted on its next event. A plugin that
contributes `statusBarItems` has its worker **started when enabled and kept running**
while it stays enabled. The plugin contributes a status bar item partly for its own sake
and partly to guarantee the worker is warm, so no event is lost to a cold start.

## The design

### Event mapping

The worker subscribes to `agent.status.changed` (capability `agent:read`) and keeps a map
keyed by `paneKey`. **Transitions fire sounds, not states.** For each event, compare the
incoming state to the last state recorded for that pane.

| Transition | CESP category |
|---|---|
| First time a pane (new `sessionId`) enters `working` | `session.start` |
| A later entry into `working` | `task.acknowledge` |
| Entry into `blocked` **or** `waiting` | `input.required` |
| Entry into `done` with `mainAgent.outcome === "success"` | `task.complete` |
| Entry into `done` with `mainAgent.outcome === "failure"` | `task.error` |
| Entry into `done` with outcome `cancellation` or `interruption` | *silent* |
| Entry into `done` with outcome `superseded` or `unconfirmed` | *silent* |
| Entry into `done` with **no** `mainAgent.outcome` at all | `task.complete` |

`resource.limit`, `user.spam`, `session.end`, and `task.progress` have no Orca signal and
are never played. Packs that ship them simply don't use them; CESP expects partial
coverage. The panel should show which categories of the active pack are reachable so this
is visible rather than mysterious.

Silent on cancellation/interruption is deliberate: the user pressed stop, they already
know.

**On a missing outcome** — *builder's call, flowing from the stated anti-goal.* Both
`mainAgent` and `mainAgent.outcome` are optional on the event, and Orca's own store
treats an absent outcome as "no outcome known," inferring `cancellation` only when
`interrupted === true`. A bare `state: "done"` with no outcome is therefore common, not
exceptional. Defaulting it to silence would mean the headline sound — "Job's done!" —
never fires for those agents, which is failure mode number one. So an absent outcome
plays `task.complete`. The cost is an occasional completion sound after a stop; that is
the right side to err on here.

### Rate limiting

Two gates, both in the worker, checked in this order:

1. **Global floor, 500 ms.** If any sound started less than 500 ms ago, drop this one.
   Drop, do not queue — a backlog of stale "Job's done!" is worse than silence.
2. **Per-category debounce, 500 ms**, as the CESP player rules require.

With a fleet, four agents finishing within 500 ms produce one sound. That is intended.

**`input.required` preempts the global floor** (owner's decision). An agent needing a
human is the event this plugin exists to surface; letting a routine "work, work" 400 ms
earlier swallow it would defeat the point. So a sound in the `input.required` category
ignores gate 1 and plays anyway, resetting the floor behind it. It still respects gate 2,
so a burst of simultaneously-blocked agents is still one sound. No other category gets
this exemption.

### Sound selection

Per the CESP player rules in OpenPeon's `INTEGRATE.md`:

1. Look up `categories[category]` in the pack's `openpeon.json`.
2. If absent, check `category_aliases` for a mapping to a category that is present.
3. If still absent, skip silently. No error, no fallback to another category.
4. From the category's `sounds[]`, exclude the last file played for that category when
   more than one candidate exists, then pick uniformly at random.
5. Resolve `file` relative to the manifest, forward slashes. A path with no slash gets
   `sounds/` prefixed.

Last-played-per-category is kept in `storage:own` so it survives a worker restart.

### Playback

Spawn detached, never block, never await the player's exit.

v1.0 supports **macOS only**: `afplay -v <vol> <path>`. Master volume is a 0.0–1.0
setting passed straight to `-v`. Supported formats are WAV, MP3, OGG; most packs are WAV.

Even so, write playback behind a small player interface with one implementation
(`AfplayPlayer`) selected by `process.platform`. On any other platform the selector
returns an `UnsupportedPlayer` that plays nothing and reports why, so the panel can show
"Audio playback is macOS-only in this version" instead of going quietly dead. That
interface is the seam Linux and Windows drop into later; it costs almost nothing now and
avoids a refactor when they arrive.

If `afplay` is somehow missing or a spawn fails, the plugin must say so plainly in the
panel rather than fail silently — a silent plugin is indistinguishable from the bug this
project exists to fix.

### Pack storage and installation

Packs live in `~/.openpeon/packs/<name>/`, the same path peon-ping uses, so the two
coexist and share a cache if both are installed.

Registry index: `https://peonping.github.io/registry/index.json` (~540 KB, 382 entries).
Cache it in `storage:own` with a timestamp; refresh on panel open if older than 24 hours,
and on explicit refresh. Serve the cached copy immediately so the panel never blocks on
the network.

To install pack `<name>` from its registry entry:

1. Fetch `https://github.com/{source_repo}/archive/refs/tags/{source_ref}.tar.gz`.
2. Extract only the `{source_path}/` subtree into a temp directory.
3. Verify `openpeon.json` exists at the pack root and parses.
4. Verify the manifest's `manifest_sha256` from the registry entry matches, when present.
5. Atomically move the temp directory into `~/.openpeon/packs/<name>/`.

Step 5 is what prevents the half-installed pack named in the anti-goals. Never extract
directly into the final path.

Record `version`, `source_ref`, and `manifest_sha256` from the registry entry into
`storage:own` alongside the install, keyed by pack name. *Builder's call:* this is nearly
free at install time and impossible to reconstruct later, and without it the plugin can
never tell that an installed pack has gone stale. The panel offers **Update** on a row
whose recorded `version` differs from the registry's; updating is just a reinstall through
the same atomic path.

Sound entries in `openpeon.json` carry a `sha256`. Verify a file's hash before playing it
the first time after install; a mismatch means skip that sound, not fail the pack.

**Sharing `~/.openpeon/packs/` with peon-ping.** *Builder's call.* The directory is
deliberately shared, so the plugin must not behave as though it owns it. If a pack
directory already exists and its `openpeon.json` parses, adopt it as-is and mark it
*adopted* — no overwrite, no hash enforcement against the registry, since peon-ping may
have put a different version there legitimately. An adopted pack still offers Update,
which replaces it with the registry version. **Delete** is offered only for packs this
plugin recorded installing; adopted packs show no Delete, so the plugin can never remove
something peon-ping is relying on.

**Preview before install** fetches just the one file from
`https://raw.githubusercontent.com/{source_repo}/{source_ref}/{source_path}/{file}` into
a temp path and plays it. `preview_sounds[]` in the registry entry names good candidates.
*Builder's call:* preview bypasses `muted` and both rate-limit gates. It is an explicit
button press — if someone clicks play, they want to hear it.

**First run:** if no pack is installed and none has ever been chosen, install `peon`
(Warcraft III Orc Peon, ~2 MB, the namesake) and make it active.

*Builder's call on "once":* the flag that stops this from recurring is set on a
**successful** install, not an attempt. A fresh machine that is offline or behind a proxy
at first enable is precisely goal #4's scenario, and treating that failed attempt as done
would leave that user with a permanently silent plugin and no explanation. So: retry at
each worker start until one install succeeds, and surface the failure in the panel with
the reason and a Retry button in the meantime. Once it succeeds, never again — if the
user later deletes every pack, do not re-install behind their back.

### The panel — "Peon Ping", right sidebar

Library-first, chosen from three mocked options. Top to bottom:

- **Active pack card.** Display name, sound count, and which of the five *reachable*
  categories it covers. A warning line if it covers none.
- **Search box** filtering on name, display name, description, and tags.
- **Filter chips**: All / Installed / Official / Verified / Community.
- **Pack list.** One row per registry entry: display name, trust tier, size, a preview
  button, and an action — Install, or Use when installed, or Active when active.
  Installed packs also offer Delete.
- Download progress shown inline on the row being installed.

Every row action is a `plugin.request` to the worker. The worker posts progress and
completion back with `panels.post`. The list is long; render it windowed or capped with
a "showing N of M" line rather than mounting 382 rows.

### Settings (Orca Settings → Plugins → Peon Ping)

Declared in `contributes.settings`, capability `settings:own`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `volume` | number 0–1 | `0.5` | Master volume |
| `muted` | boolean | `false` | Silence everything |
| `playSessionStart` | boolean | `true` | Agent started |
| `playTaskAcknowledge` | boolean | `true` | Agent picked up work |
| `playInputRequired` | boolean | `true` | Agent needs you |
| `playTaskComplete` | boolean | `true` | Agent finished |
| `playTaskError` | boolean | `true` | Agent failed |
| `notifyWhenMuted` | boolean | `true` | Desktop notification naming the agent when a sound can't play |

The active pack is **not** a setting — 382 options cannot be a static enum. It lives in
`storage:own` and is set from the panel.

**What `notifyWhenMuted` actually covers.** *Builder's call.* It fires only for
`input.required` and `task.error` — the two categories where you'd want to go look. A
desktop toast per `task.acknowledge` across a fleet would be strictly worse than the
notification chime this plugin exists to replace. It respects the per-category toggles
and both rate-limit gates, so it can never be noisier than the sound would have been.

It is the shared fallback for every path where a sound was warranted but could not play:
global mute, the active pack missing that category, an unsupported platform, or a spawn
failure. One mechanism, four triggers — not a special case per failure.

### Status bar

One `contributes.statusBarItems` entry showing the active pack name and mute state, with
a tooltip. Clicking it toggles mute. Its real job is keeping the worker warm.

### Manifest sketch

```jsonc
{
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "peon-ping",
  "name": "Peon Ping",
  "version": "1.0.0",
  "description": "Character voice lines when your agents finish, fail, or need you. 380+ sound packs from the OpenPeon registry. macOS only in this version.",
  "license": "MIT",
  "engines": { "orca": ">=1.4.259" },
  "pluginApi": 1,
  "main": "worker/main.ts",
  "contributes": {
    "panels": [{ "id": "packs", "title": "Peon Ping", "icon": "bell",
                 "entry": "src/panel.tsx", "ui": "components" }],
    "statusBarItems": [{ "id": "active-pack", "text": "Peon", "icon": "bell" }],
    "events": ["agent.status.changed"],
    "settings": [ /* table above */ ]
  },
  "capabilities": [
    { "kind": "agent:read" },
    { "kind": "storage:own" },
    { "kind": "settings:own" },
    { "kind": "notifications:show" }
  ]
}
```

`publisher` is deliberately omitted — it is deprecated, and Orca derives it from the
repository owner (`omar227`).

**Why the floor is 1.4.259, not 1.4.248.** *Builder's call.* `statusBarItems` only needs
1.4.248, but `session.start` detection keys on the event's `sessionId`, which arrives with
host API 1.8 — Orca 1.4.259. Orca's validator cannot catch this, because `sessionId` is a
payload field, not a manifest field, so on 1.4.248–1.4.258 it would simply be `undefined`
and session detection would quietly misbehave. Raising the floor trades a sliver of the
install base for a mapping that is correct by construction. The owner is on 1.4.261 and
Orca auto-updates by default, so the practical cost is near zero.

Note the manifest also drops the `workspace.removed` subscription the mapping table
originally carried. *Builder's call:* that event requires the `workspace:read` capability,
whose consent copy reads "Read your projects and workspaces (names, branches, paths and
agent status) and the terminals in them" — a markedly scarier install prompt for a plugin
that plays sounds. It bought only pane-map cleanup, and it keys on `workspaceId` rather
than `paneKey` so it would need extra bookkeeping to even do that. TTL eviction of the
pane map (drop entries untouched for an hour, cap the map) achieves the same thing with
no extra consent. Four capabilities, all obviously justified by the feature.

## Testing

The failure modes that matter are runtime ones, so the test strategy weights integration
over unit coverage.

- **Pure logic, unit tested:** the state-machine transition mapping (every state pair and
  every outcome), category resolution including alias fallback and missing categories,
  no-repeat selection, both rate-limit gates, path resolution for `file` entries.
- **Worker against a stand-in host:** `orca/testing`'s `mountWorker(...)` to fire
  `agent.status.changed` sequences and assert which categories were requested, with the
  player stubbed.
- **Panel:** `<entry>.check.ts` scenarios plus `orca plugin shot --scenario` for visual
  confirmation.
- **Real audio, by hand, on macOS:** install the plugin as a development folder, run an
  agent, and confirm each of the five sounds actually plays. This is the acceptance test.
  The design is not done until a sound has been heard.
- `orca plugin validate .` must pass clean, and should run in CI on every push.

## Publishing

1. `orca plugin validate .` passes.
2. Repository `omar227/orca-peon-ping`, public, MIT `LICENSE` file at root.
3. Commit the version in `orca-plugin.json`, then
   `git tag -a v1.0.0 -m v1.0.0 && git push origin v1.0.0`.
4. `gh repo edit omar227/orca-peon-ping --add-topic orca-plugin`.
5. Listing appears at `https://orca.dev/plugins/omar227/orca-peon-ping` within ~1 hour.

**Credential note:** `gh` on this machine is authenticated as `omar227`, a work account.
Orca requires `publisher` to equal the repository owner, so every step above must run as
`omar227`. The owner adds that account with `gh auth login` when the build reaches this
point.

Optionally, submit to the OpenPeon ecosystem as a CESP implementation, and to Orca's
community catalog via `orca plugin release-entry`.

## Later, not now

- **Linux and Windows playback.** The commands are documented in OpenPeon's
  `INTEGRATE.md` — a six-backend probe chain for Linux (`pw-play`, `paplay`, `ffplay`,
  `mpv`, SoX `play`, `aplay`) and `System.Windows.Media.MediaPlayer` for Windows. They
  drop in behind the player interface. Add each one when someone who runs that platform
  can confirm they hear it, not before.
- Submission to Orca's community catalog via `orca plugin release-entry`.
- Per-workspace or per-agent pack assignment, if the fleet ever gets loud enough to want
  different voices for different projects.

The README should mention turning Orca's own notification sound off, so the system chime
and the peon don't both fire. *Builder's call:* a README line, not a setting — the plugin
should not reach into Orca's notification preferences.

## Left to the builder

- Whether the panel is a components panel (`ui: "components"`) or an HTML frame.
  Components is the default assumption; it hot-reloads and needs no build step.
- Tar extraction strategy in the worker: a small dependency versus spawning `tar`.
  Note that Windows has `tar.exe` built in since Windows 10 1803.
- The exact windowing approach for 382 rows.
- Module layout within `worker/`.
- Whether registry refresh is lazy-on-open or also on a timer.
