# Peon Ping for Orca — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Orca plugin that plays CESP sound-pack voice lines when agents start, finish, fail, or need you, with the whole OpenPeon registry browsable and installable from a sidebar panel.

**Architecture:** A `trusted-worker` plugin. The worker (Node, unsandboxed) owns everything with side effects: it subscribes to `agent.status.changed`, maps state transitions to CESP categories, picks a sound, and spawns `afplay`. It also fetches the registry and installs packs under `~/.openpeon/packs/`. The panel is a components TSX panel with no network and no file access; it reaches the worker through `plugin.request` and hears back through `panels.post`. Pure logic (mapping, gating, manifest parsing, path safety) lives in small modules with no I/O so it can be tested in plain Node.

**Tech Stack:** TypeScript with no build step (Orca transpiles `.ts`/`.tsx` on load), Orca host API 1 / `ui.catalog` 4, `node:` builtins only — no runtime dependencies. Tests run on `node:test` via `orca plugin test`.

**Spec:** `docs/superpowers/specs/2026-11-18-orca-peon-ping-design.md`

## Global Constraints

- `engines.orca` is `>=1.4.259`. `sessionId` on `agent.status.changed` arrives with host API 1.8 (Orca 1.4.259) and the manifest validator cannot catch its absence.
- Exactly four capabilities: `agent:read`, `storage:own`, `settings:own`, `notifications:show`. Never add `workspace:read` or `terminal:read`.
- **No runtime dependencies.** `node_modules` must not be required for the plugin to run. Use `node:` builtins; shell out to the system `tar` rather than taking a tar library.
- No audio files, archives, executables, or symlinks committed. The repository ships code and text only.
- `publisher` is omitted from the manifest. Orca derives it from the repository owner, `omar227`.
- v1.0 plays audio on **macOS only**, via `afplay`. Other platforms load the plugin and show "Audio playback is macOS-only in this version."
- Registry index: `https://peonping.github.io/registry/index.json`, cached 24 h (`86_400_000` ms).
- Pack tarball: `https://github.com/{source_repo}/archive/refs/tags/{source_ref}.tar.gz`.
- Single-file preview: `https://raw.githubusercontent.com/{source_repo}/{source_ref}/{source_path}/{file}`.
- Packs install to `~/.openpeon/packs/<name>/`, shared with peon-ping.
- Both rate-limit gates are `500` ms. `input.required` bypasses the global floor only.
- Default first-run pack is `peon`.
- Every `spawn` uses an argument array, never a shell string.

## Review Focus

These are the failure modes the spec implies but does not call out. Each one's test is assigned to the task that owns the code.

1. **Repeated same-state events.** Orca republishes `agent.status.changed` for a pane on tool pings without the state changing. Only transitions may fire a sound, or a working agent becomes a machine gun. → Task 2.
2. **A manifest `file` that escapes the pack directory** (`../../../.ssh/id_rsa`). Packs come from a community registry; a sound path must resolve inside its own pack or be refused. → Task 4.
3. **Tar entries that escape the destination** (zip-slip). Same threat, one layer down, and `tar` will happily write them. → Task 8.
4. **A registry fetch that returns non-JSON or an HTTP error** — captive portal, GitHub Pages 404, proxy interstitial. The cached index must survive; clobbering it leaves an empty panel with no way back. → Task 7.
5. **A category present in the manifest with an empty `sounds` array.** Lookup must skip silently rather than pick `undefined` and crash the worker. → Task 4.

---

### Task 1: Repository skeleton that Orca validates and loads

**Files:**
- Create: `orca-plugin.json`, `LICENSE`, `.gitignore`, `worker/main.ts`, `src/panel.tsx`, `src/protocol.ts`, `worker/main.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the manifest every later task extends; `src/protocol.ts` declaring the `orca` module's `PluginRequests` and `PluginPanelEvents` interfaces, which Tasks 9 and 10 add members to.

- [ ] **Step 1: Write `orca-plugin.json`**

Manifest format 2, `execution: "trusted-worker"`, `id: "peon-ping"`, `name: "Peon Ping"`, `version: "1.0.0"`, `license: "MIT"`, `engines.orca: ">=1.4.259"`, `pluginApi: 1`, `main: "worker/main.ts"`. No `publisher` field.

`description`: `Character voice lines when your agents finish, fail, or need you. 380+ sound packs from the OpenPeon registry. macOS only in this version.`

`contributes`:
- `panels`: one entry — `{ "id": "packs", "title": "Peon Ping", "icon": "bell", "entry": "src/panel.tsx", "ui": "components" }`
- `statusBarItems`: one entry — `{ "id": "active-pack", "text": "Peon Ping", "icon": "bell" }`
- `events`: `["agent.status.changed"]`
- `settings`: the eight keys in the table below, in this order.

| key | type | default | title | notes |
|---|---|---|---|---|
| `volume` | number | `0.5` | Volume | `minimum` 0, `maximum` 1 |
| `muted` | boolean | `false` | Mute all sounds | |
| `playSessionStart` | boolean | `true` | Play when an agent starts | |
| `playTaskAcknowledge` | boolean | `true` | Play when an agent picks up work | |
| `playInputRequired` | boolean | `true` | Play when an agent needs you | |
| `playTaskComplete` | boolean | `true` | Play when an agent finishes | |
| `playTaskError` | boolean | `true` | Play when an agent fails | |
| `notifyWhenMuted` | boolean | `true` | Show a notification when a sound can't play | |

`capabilities`: `agent:read`, `storage:own`, `settings:own`, `notifications:show`.

- [ ] **Step 2: Write the MIT `LICENSE`** with copyright `2026 omar227`, and `.gitignore` containing `.orca/`, `node_modules/`, `.superpowers/`, `.DS_Store`.

- [ ] **Step 3: Write `src/protocol.ts`**

An `export {}` module that `declare module 'orca'` with empty `PluginRequests` and `PluginPanelEvents` interfaces. Later tasks add members.

- [ ] **Step 4: Write stub `worker/main.ts` and `src/panel.tsx`**

`worker/main.ts` default-exports `activate(orca: OrcaWorkerApi)` that calls `orca.log('peon-ping worker started')` and nothing else. Import the type with `import type { OrcaWorkerApi } from 'orca/worker'`.

`src/panel.tsx` default-exports a component rendering a single `<Text>Peon Ping</Text>` inside a `<Stack>`.

- [ ] **Step 5: Write the failing test**

```ts
// worker/main.test.ts
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './main'

test('the worker activates without refusals', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
```

- [ ] **Step 6: Run the test and the validator**

Run: `orca plugin types . && orca plugin test . && orca plugin validate .`
Expected: all three exit 0. `validate` may warn; warnings do not fail.

- [ ] **Step 7: Commit**

```bash
git add orca-plugin.json LICENSE .gitignore worker src
git commit -m "feat: plugin skeleton that validates and activates"
```

---

### Task 2: Agent state transitions to CESP categories

**Files:**
- Create: `worker/mapping.ts`, `worker/mapping.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type PlayableCategory =
    | 'session.start' | 'task.acknowledge' | 'input.required'
    | 'task.complete' | 'task.error'
  export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
  export type TurnOutcome =
    | 'success' | 'failure' | 'cancellation'
    | 'superseded' | 'interruption' | 'unconfirmed'
  export type AgentStatusEvent = {
    paneKey: string
    state: AgentState
    sessionId?: string
    title?: string
    workspaceId?: string | null
    receivedAt?: number
    mainAgent?: { state: AgentState; outcome?: TurnOutcome; stateStartedAt?: number }
  }
  export class PaneTracker {
    constructor(options?: { ttlMs?: number; maxPanes?: number; now?: () => number })
    observe(event: AgentStatusEvent): PlayableCategory | null
    get size(): number
  }
  ```
  Defaults: `ttlMs` `3_600_000`, `maxPanes` `500`, `now` `Date.now`.

- [ ] **Step 1: Write the failing tests**

```ts
import { assert, test } from 'orca/testing'
import { PaneTracker } from './mapping'

const ev = (over: Partial<AgentStatusEvent> = {}): AgentStatusEvent =>
  ({ paneKey: 'tab-1:pane-1', state: 'working', sessionId: 's1', ...over })

test('first working for a session is session.start', () => {
  assert.equal(new PaneTracker().observe(ev()), 'session.start')
})

test('a later return to working is task.acknowledge', () => {
  const t = new PaneTracker()
  t.observe(ev())
  t.observe(ev({ state: 'done', mainAgent: { state: 'done', outcome: 'success' } }))
  assert.equal(t.observe(ev()), 'task.acknowledge')
})

test('a new sessionId in the same pane is session.start again', () => {
  const t = new PaneTracker()
  t.observe(ev())
  t.observe(ev({ state: 'done', mainAgent: { state: 'done', outcome: 'success' } }))
  assert.equal(t.observe(ev({ sessionId: 's2' })), 'session.start')
})

test('blocked and waiting both map to input.required', () => {
  assert.equal(new PaneTracker().observe(ev({ state: 'blocked' })), 'input.required')
  assert.equal(new PaneTracker().observe(ev({ state: 'waiting' })), 'input.required')
})

test('done with success is task.complete and with failure is task.error', () => {
  const done = (outcome: TurnOutcome) =>
    new PaneTracker().observe(ev({ state: 'done', mainAgent: { state: 'done', outcome } }))
  assert.equal(done('success'), 'task.complete')
  assert.equal(done('failure'), 'task.error')
})

test('done with no outcome at all is task.complete', () => {
  assert.equal(new PaneTracker().observe(ev({ state: 'done' })), 'task.complete')
  assert.equal(
    new PaneTracker().observe(ev({ state: 'done', mainAgent: { state: 'done' } })),
    'task.complete'
  )
})

test('a stopped turn is silent', () => {
  for (const outcome of ['cancellation', 'interruption', 'superseded', 'unconfirmed'] as const) {
    assert.equal(
      new PaneTracker().observe(ev({ state: 'done', mainAgent: { state: 'done', outcome } })),
      null
    )
  }
})

// Review Focus 1
test('a repeated event in the same state fires nothing', () => {
  const t = new PaneTracker()
  assert.equal(t.observe(ev({ state: 'working' })), 'session.start')
  assert.equal(t.observe(ev({ state: 'working' })), null)
  assert.equal(t.observe(ev({ state: 'working' })), null)
})

test('panes untouched past the ttl are evicted', () => {
  let now = 0
  const t = new PaneTracker({ ttlMs: 1000, now: () => now })
  t.observe(ev())
  now = 2000
  t.observe(ev({ paneKey: 'tab-2:pane-2', sessionId: 's9' }))
  assert.equal(t.size, 1)
})

test('the pane map is capped at maxPanes', () => {
  const t = new PaneTracker({ maxPanes: 2 })
  for (const n of [1, 2, 3, 4]) t.observe(ev({ paneKey: `p${n}`, sessionId: `s${n}` }))
  assert.ok(t.size <= 2)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL — `Cannot find module './mapping'`.

- [ ] **Step 3: Implement `worker/mapping.ts`**

`PaneTracker` keeps a `Map<string, { state: AgentState; sessionId?: string; seenAt: number }>`. `observe` evicts entries older than `ttlMs` first, then compares against the stored record and returns a category only on a genuine change of state or session. When the map exceeds `maxPanes` after insert, drop the oldest `seenAt` entries until it fits. Outcome is read from `event.mainAgent?.outcome`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/mapping.ts worker/mapping.test.ts
git commit -m "feat: map Orca agent status transitions to CESP categories"
```

---

### Task 3: The rate-limit gate

**Files:**
- Create: `worker/gate.ts`, `worker/gate.test.ts`

**Interfaces:**
- Consumes: `PlayableCategory` from `worker/mapping.ts`.
- Produces:
  ```ts
  export class SoundGate {
    constructor(options?: {
      globalFloorMs?: number
      categoryDebounceMs?: number
      now?: () => number
    })
    allow(category: PlayableCategory): boolean
  }
  ```
  Defaults: both `500`, `now` `Date.now`. `allow` records the attempt when it returns `true` and records nothing when it returns `false`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a second sound inside the global floor is dropped', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  assert.equal(g.allow('task.complete'), true)
  now = 400
  assert.equal(g.allow('task.error'), false)
  now = 600
  assert.equal(g.allow('task.error'), true)
})

test('input.required ignores the global floor', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  assert.equal(g.allow('task.acknowledge'), true)
  now = 400
  assert.equal(g.allow('input.required'), true)
})

test('input.required still honours its own debounce', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  assert.equal(g.allow('input.required'), true)
  now = 400
  assert.equal(g.allow('input.required'), false)
  now = 600
  assert.equal(g.allow('input.required'), true)
})

test('a preempting input.required resets the floor behind it', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  g.allow('task.acknowledge')
  now = 400
  g.allow('input.required')
  now = 700
  assert.equal(g.allow('task.complete'), false)
  now = 950
  assert.equal(g.allow('task.complete'), true)
})

test('a dropped sound does not move either clock', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  g.allow('task.complete')
  now = 300
  assert.equal(g.allow('task.error'), false)
  now = 510
  assert.equal(g.allow('task.error'), true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL — `Cannot find module './gate'`.

- [ ] **Step 3: Implement `worker/gate.ts`**

One `lastSoundAt` number and a `Map<PlayableCategory, number>`. The category debounce is checked for every category including `input.required`; the global floor is skipped only for `input.required`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/gate.ts worker/gate.test.ts
git commit -m "feat: rate-limit gate with input.required preemption"
```

---

### Task 4: CESP manifest parsing, sound resolution and path safety

**Files:**
- Create: `worker/cesp.ts`, `worker/cesp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type CespSound = { file: string; label?: string; sha256?: string }
  export type CespManifest = {
    cesp_version: string
    name: string
    display_name?: string
    version?: string
    description?: string
    license?: string
    categories?: Record<string, { sounds?: CespSound[] }>
    category_aliases?: Record<string, string>
  }
  export function parseManifest(text: string): CespManifest
  export function resolveCategory(manifest: CespManifest, category: string): CespSound[]
  export function resolveSoundPath(packDir: string, file: string): string
  export function pickSound(
    sounds: CespSound[],
    lastFile: string | null,
    random?: () => number
  ): CespSound | null
  export function coveredCategories(manifest: CespManifest, of: readonly string[]): string[]
  ```
  `parseManifest` throws `Error` on non-JSON or a missing `name`/`cesp_version`. `resolveSoundPath` throws `Error` when the resolved path is not inside `packDir`.

- [ ] **Step 1: Write the failing tests**

```ts
const manifest: CespManifest = {
  cesp_version: '1.0',
  name: 'peon',
  categories: {
    'task.complete': { sounds: [{ file: 'sounds/JobsDone.wav' }, { file: 'sounds/WorkComplete.wav' }] },
    'task.error': { sounds: [] },
    greeting: { sounds: [{ file: 'Hello.wav' }] }
  },
  category_aliases: { 'session.start': 'greeting' }
}

test('a present category returns its sounds', () => {
  assert.equal(resolveCategory(manifest, 'task.complete').length, 2)
})

test('an absent category falls through category_aliases', () => {
  assert.deepEqual(resolveCategory(manifest, 'session.start'), [{ file: 'Hello.wav' }])
})

test('an unknown category returns nothing', () => {
  assert.deepEqual(resolveCategory(manifest, 'resource.limit'), [])
})

// Review Focus 5
test('a category with an empty sounds array returns nothing', () => {
  assert.deepEqual(resolveCategory(manifest, 'task.error'), [])
  assert.equal(pickSound(resolveCategory(manifest, 'task.error'), null), null)
})

test('a file with no slash is resolved under sounds/', () => {
  assert.equal(resolveSoundPath('/packs/peon', 'Hello.wav'), '/packs/peon/sounds/Hello.wav')
})

test('a file with a slash is resolved as given', () => {
  assert.equal(resolveSoundPath('/packs/peon', 'sounds/a.wav'), '/packs/peon/sounds/a.wav')
})

// Review Focus 2
test('a file escaping the pack directory is refused', () => {
  for (const bad of ['../../../.ssh/id_rsa', '/etc/passwd', 'sounds/../../x.wav']) {
    assert.throws(() => resolveSoundPath('/packs/peon', bad))
  }
})

test('pickSound avoids the last file when another exists', () => {
  for (let i = 0; i < 20; i++) {
    const picked = pickSound(resolveCategory(manifest, 'task.complete'), 'sounds/JobsDone.wav')
    assert.equal(picked?.file, 'sounds/WorkComplete.wav')
  }
})

test('pickSound replays the only sound rather than going silent', () => {
  assert.equal(pickSound([{ file: 'a.wav' }], 'a.wav')?.file, 'a.wav')
})

test('parseManifest rejects non-JSON and manifests with no name', () => {
  assert.throws(() => parseManifest('<!DOCTYPE html>'))
  assert.throws(() => parseManifest('{"cesp_version":"1.0"}'))
})

test('coveredCategories lists only categories with at least one sound', () => {
  assert.deepEqual(
    coveredCategories(manifest, ['session.start', 'task.complete', 'task.error']),
    ['session.start', 'task.complete']
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL — `Cannot find module './cesp'`.

- [ ] **Step 3: Implement `worker/cesp.ts`**

`resolveSoundPath` normalises with `node:path` `resolve`, then requires the result to equal `packDir` or start with `packDir + path.sep`. Reject absolute `file` values before joining. `pickSound` filters out `lastFile` only when more than one candidate remains, then indexes with `Math.floor(random() * candidates.length)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/cesp.ts worker/cesp.test.ts
git commit -m "feat: CESP manifest parsing, alias fallback and sound-path containment"
```

---

### Task 5: The audio player

**Files:**
- Create: `worker/player.ts`, `worker/player.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type SpawnFn = (command: string, args: readonly string[]) => void
  export type Player = {
    readonly kind: 'afplay' | 'unsupported'
    readonly unavailableReason: string | null
    play(absolutePath: string, volume: number): void
  }
  export function createPlayer(platform: NodeJS.Platform, spawn?: SpawnFn): Player
  ```
  The unsupported reason is exactly `Audio playback is macOS-only in this version.`

- [ ] **Step 1: Write the failing tests**

```ts
const calls: { command: string; args: readonly string[] }[] = []
const spy: SpawnFn = (command, args) => { calls.push({ command, args }) }

test('darwin spawns afplay with the volume and path as separate arguments', () => {
  calls.length = 0
  createPlayer('darwin', spy).play('/packs/peon/sounds/Job s Done.wav', 0.5)
  assert.deepEqual(calls, [
    { command: 'afplay', args: ['-v', '0.50', '/packs/peon/sounds/Job s Done.wav'] }
  ])
})

test('volume is clamped to 0..1', () => {
  calls.length = 0
  createPlayer('darwin', spy).play('/a.wav', 5)
  createPlayer('darwin', spy).play('/a.wav', -1)
  assert.equal(calls[0].args[1], '1.00')
  assert.equal(calls[1].args[1], '0.00')
})

test('an unsupported platform plays nothing and says why', () => {
  calls.length = 0
  const player = createPlayer('linux', spy)
  player.play('/a.wav', 0.5)
  assert.equal(calls.length, 0)
  assert.equal(player.kind, 'unsupported')
  assert.equal(player.unavailableReason, 'Audio playback is macOS-only in this version.')
})

test('a supported player reports no reason', () => {
  assert.equal(createPlayer('darwin', spy).unavailableReason, null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL — `Cannot find module './player'`.

- [ ] **Step 3: Implement `worker/player.ts`**

The default `SpawnFn` uses `node:child_process` `spawn` with `{ detached: true, stdio: 'ignore' }` and calls `unref()` on the child, so playback never blocks the worker and never inherits its streams. Volume is formatted with `toFixed(2)` after clamping. Never build a shell string.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Verify a real sound plays**

Run, on macOS, with any WAV on the machine:
`node -e "require('child_process').spawn('afplay',['-v','0.5','/System/Library/Sounds/Glass.aiff'],{detached:true,stdio:'ignore'}).unref()"`
Expected: the sound is audible. This confirms the spawn shape the player uses.

- [ ] **Step 6: Commit**

```bash
git add worker/player.ts worker/player.test.ts
git commit -m "feat: macOS afplay player behind a platform-selected interface"
```

---

### Task 6: Paths and the persisted store

**Files:**
- Create: `worker/paths.ts`, `worker/store.ts`, `worker/paths.test.ts`, `worker/store.test.ts`

**Interfaces:**
- Consumes: `PlayableCategory` from `worker/mapping.ts`.
- Produces:
  ```ts
  // paths.ts
  export function packsRoot(home?: string): string          // <home>/.openpeon/packs
  export function packDir(name: string, home?: string): string
  export const PACK_NAME_PATTERN: RegExp                     // /^[a-z0-9][a-z0-9_-]{0,63}$/

  // store.ts
  export type InstalledPack = {
    name: string
    version: string | null
    sourceRef: string | null
    manifestSha256: string | null
    installedAt: number
    adopted: boolean
  }
  export type StoreApi = {
    get<T>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
  }
  export class Store {
    constructor(api: StoreApi)
    getActivePack(): Promise<string | null>
    setActivePack(name: string | null): Promise<void>
    getInstalled(): Promise<Record<string, InstalledPack>>
    recordInstalled(pack: InstalledPack): Promise<void>
    forgetInstalled(name: string): Promise<void>
    getLastPlayed(category: PlayableCategory): Promise<string | null>
    setLastPlayed(category: PlayableCategory, file: string): Promise<void>
    isFirstRunDone(): Promise<boolean>
    markFirstRunDone(): Promise<void>
  }
  ```
  Storage keys: `activePack`, `installedPacks`, `lastPlayed`, `firstRunDone`, and `registryCache` (Task 7).

`packDir` throws when `name` fails `PACK_NAME_PATTERN` — this is the second line of defence against a registry entry with a crafted name.

- [ ] **Step 1: Write the failing tests**

```ts
test('packDir builds a path under ~/.openpeon/packs', () => {
  assert.equal(packDir('peon', '/Users/x'), '/Users/x/.openpeon/packs/peon')
})

test('packDir refuses a name that is not a plain pack id', () => {
  for (const bad of ['../evil', 'a/b', '.hidden', 'UPPER', '']) {
    assert.throws(() => packDir(bad, '/Users/x'))
  }
})

test('the store round-trips the active pack', async () => {
  const store = new Store(memoryStoreApi())
  assert.equal(await store.getActivePack(), null)
  await store.setActivePack('peon')
  assert.equal(await store.getActivePack(), 'peon')
})

test('installed packs accumulate and can be forgotten', async () => {
  const store = new Store(memoryStoreApi())
  await store.recordInstalled({ name: 'peon', version: '1.0.0', sourceRef: 'v1.1.0', manifestSha256: null, installedAt: 1, adopted: false })
  await store.recordInstalled({ name: 'glados', version: '1.0.0', sourceRef: 'v1.1.0', manifestSha256: null, installedAt: 2, adopted: true })
  assert.deepEqual(Object.keys(await store.getInstalled()).sort(), ['glados', 'peon'])
  await store.forgetInstalled('peon')
  assert.deepEqual(Object.keys(await store.getInstalled()), ['glados'])
})

test('lastPlayed is tracked per category', async () => {
  const store = new Store(memoryStoreApi())
  await store.setLastPlayed('task.complete', 'a.wav')
  assert.equal(await store.getLastPlayed('task.complete'), 'a.wav')
  assert.equal(await store.getLastPlayed('task.error'), null)
})

test('firstRunDone starts false and latches', async () => {
  const store = new Store(memoryStoreApi())
  assert.equal(await store.isFirstRunDone(), false)
  await store.markFirstRunDone()
  assert.equal(await store.isFirstRunDone(), true)
})
```

Write `memoryStoreApi()` as a local helper in the test file: a `Map`-backed `StoreApi`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `worker/paths.ts` and `worker/store.ts`**

`packsRoot` defaults `home` to `node:os` `homedir()`. `Store` wraps the `StoreApi` the worker builds from `orca.host.call('storage.get' | 'storage.set')`; it owns key names and default values so no other module spells a key.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/paths.ts worker/store.ts worker/paths.test.ts worker/store.test.ts
git commit -m "feat: pack paths and the plugin's persisted store"
```

---

### Task 7: The registry client

**Files:**
- Create: `worker/registry.ts`, `worker/registry.test.ts`
- Modify: `worker/store.ts` — add `getRegistryCache()` / `setRegistryCache()`

**Interfaces:**
- Consumes: `Store` from Task 6.
- Produces:
  ```ts
  export const REGISTRY_URL = 'https://peonping.github.io/registry/index.json'
  export const REGISTRY_TTL_MS = 86_400_000
  export type RegistryPack = {
    name: string
    display_name: string
    version: string
    description?: string
    author?: { name?: string; github?: string }
    trust_tier: 'official' | 'verified' | 'community'
    categories: string[]
    language: string
    license?: string
    sound_count: number
    total_size_bytes?: number
    source_repo: string
    source_ref: string
    source_path?: string
    manifest_sha256?: string
    tags?: string[]
    preview_sounds?: string[]
  }
  export type RegistryIndex = { version: number; packs: RegistryPack[] }
  export function parseRegistryIndex(text: string): RegistryIndex
  export type RegistryResult = {
    index: RegistryIndex | null
    fetchedAt: number | null
    stale: boolean
    error: string | null
  }
  export class RegistryClient {
    constructor(store: Store, options?: { fetchImpl?: typeof fetch; now?: () => number })
    load(options?: { force?: boolean }): Promise<RegistryResult>
  }
  ```
  `parseRegistryIndex` throws on non-JSON, a missing `packs` array, or `version !== 1`.

- [ ] **Step 1: Write the failing tests**

```ts
const index = { version: 1, packs: [{ name: 'peon', display_name: 'Peon', version: '1.0.0', trust_tier: 'official', categories: ['task.complete'], language: 'en', sound_count: 7, source_repo: 'PeonPing/og-packs', source_ref: 'v1.1.0' }] }
const ok = (body: string) => async () => new Response(body, { status: 200 })

test('a fresh cache is served without fetching', async () => {
  let fetches = 0
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 1000, index })
  const client = new RegistryClient(store, {
    now: () => 1000 + REGISTRY_TTL_MS - 1,
    fetchImpl: (async () => { fetches++; return new Response('{}') }) as typeof fetch
  })
  const result = await client.load()
  assert.equal(fetches, 0)
  assert.equal(result.index?.packs.length, 1)
  assert.equal(result.stale, false)
})

test('an expired cache triggers a fetch and is replaced', async () => {
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 0, index: { version: 1, packs: [] } })
  const client = new RegistryClient(store, {
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: ok(JSON.stringify(index)) as typeof fetch
  })
  assert.equal((await client.load()).index?.packs.length, 1)
})

// Review Focus 4
test('an HTML error page leaves the cached index intact', async () => {
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 0, index })
  const client = new RegistryClient(store, {
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: ok('<!DOCTYPE html><title>404</title>') as typeof fetch
  })
  const result = await client.load()
  assert.equal(result.index?.packs.length, 1)
  assert.equal(result.stale, true)
  assert.ok(result.error)
  assert.equal((await store.getRegistryCache())?.index.packs.length, 1)
})

test('a non-200 response leaves the cached index intact', async () => {
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 0, index })
  const client = new RegistryClient(store, {
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch
  })
  const result = await client.load()
  assert.equal(result.index?.packs.length, 1)
  assert.ok(result.error)
})

test('a failed first fetch reports no index rather than throwing', async () => {
  const client = new RegistryClient(new Store(memoryStoreApi()), {
    fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch
  })
  const result = await client.load()
  assert.equal(result.index, null)
  assert.ok(result.error)
})

test('force refetches a cache that is still fresh', async () => {
  let fetches = 0
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 1000, index: { version: 1, packs: [] } })
  const client = new RegistryClient(store, {
    now: () => 1000,
    fetchImpl: (async () => { fetches++; return new Response(JSON.stringify(index)) }) as typeof fetch
  })
  await client.load({ force: true })
  assert.equal(fetches, 1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL — `Cannot find module './registry'`.

- [ ] **Step 3: Implement `worker/registry.ts` and extend `worker/store.ts`**

`load` reads the cache, returns it when within TTL and not forced, otherwise fetches. Any failure — network throw, non-OK status, or a `parseRegistryIndex` throw — returns the cached index with `stale: true` and a human-readable `error`, and writes nothing. Only a successful parse replaces the cache.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Verify against the live registry**

Run: `node -e "fetch('https://peonping.github.io/registry/index.json').then(r=>r.json()).then(d=>console.log(d.version, d.packs.length))"`
Expected: `1` and a count of 380 or more. Confirms the shape `parseRegistryIndex` accepts is the shape the registry serves.

- [ ] **Step 6: Commit**

```bash
git add worker/registry.ts worker/registry.test.ts worker/store.ts worker/store.test.ts
git commit -m "feat: registry client that never clobbers its cache on a bad response"
```

---

### Task 8: Pack installation, adoption, update and removal

**Files:**
- Create: `worker/install.ts`, `worker/install.test.ts`

**Interfaces:**
- Consumes: `packDir` (Task 6), `Store` / `InstalledPack` (Task 6), `RegistryPack` (Task 7), `parseManifest` (Task 4).
- Produces:
  ```ts
  export function tarEntryTarget(destDir: string, entryPath: string): string
  export function verifySoundFile(absolutePath: string, expectedSha256: string | null): Promise<boolean>
  export type PackStatus = {
    name: string
    present: boolean
    adopted: boolean
    installedVersion: string | null
    updateAvailable: boolean
    removable: boolean
  }
  export class PackInstaller {
    constructor(store: Store, options?: { home?: string; fetchImpl?: typeof fetch; now?: () => number })
    install(entry: RegistryPack): Promise<void>
    adoptIfPresent(name: string): Promise<boolean>
    remove(name: string): Promise<void>
    status(entry: RegistryPack): Promise<PackStatus>
    manifestPath(name: string): string
    downloadPreview(entry: RegistryPack, file: string): Promise<string>
  }
  ```
  `remove` throws when the recorded pack is `adopted` or absent from the store — the plugin never deletes what it did not install.

- [ ] **Step 1: Write the failing tests**

```ts
// Review Focus 3
test('a tar entry escaping the destination is refused', () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'peon/../../x']) {
    assert.throws(() => tarEntryTarget('/tmp/dest', bad))
  }
  assert.equal(tarEntryTarget('/tmp/dest', 'peon/sounds/a.wav'), '/tmp/dest/peon/sounds/a.wav')
})

test('install writes the pack and records its version', async () => {
  // fetchImpl serves a tarball fixture built in a temp dir by the test
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome, fetchImpl: servingFixture })
  await installer.install(entry)
  assert.ok(existsSync(installer.manifestPath('peon')))
  const recorded = (await store.getInstalled())['peon']
  assert.equal(recorded.version, entry.version)
  assert.equal(recorded.sourceRef, entry.source_ref)
  assert.equal(recorded.adopted, false)
})

test('a failed install leaves no pack directory behind', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, {
    home: tmpHome,
    fetchImpl: (async () => new Response('not a tarball')) as typeof fetch
  })
  await assert.rejects(() => installer.install(entry))
  assert.equal(existsSync(packDir('peon', tmpHome)), false)
  assert.deepEqual(await store.getInstalled(), {})
})

test('an existing pack directory is adopted, not overwritten', async () => {
  // write a valid openpeon.json into packDir('peon', tmpHome) first
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome })
  assert.equal(await installer.adoptIfPresent('peon'), true)
  const recorded = (await store.getInstalled())['peon']
  assert.equal(recorded.adopted, true)
  assert.equal((await installer.status(entry)).removable, false)
})

test('adoptIfPresent ignores a directory with no readable manifest', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), { home: tmpHome })
  assert.equal(await installer.adoptIfPresent('nothing-here'), false)
})

test('remove refuses an adopted pack and deletes an installed one', async () => {
  // adopt 'peon', install 'glados'
  await assert.rejects(() => installer.remove('peon'))
  await installer.remove('glados')
  assert.equal(existsSync(packDir('glados', tmpHome)), false)
})

test('status reports an update when the recorded version differs', async () => {
  // record peon at 1.0.0, ask status for an entry at 1.1.0
  assert.equal((await installer.status({ ...entry, version: '1.1.0' })).updateAvailable, true)
  assert.equal((await installer.status({ ...entry, version: '1.0.0' })).updateAvailable, false)
})

test('verifySoundFile accepts a matching hash, rejects a wrong one, and passes when none is given', async () => {
  const file = join(tmpHome, 'a.wav')
  writeFileSync(file, 'abc')
  const sha = createHash('sha256').update('abc').digest('hex')
  assert.equal(await verifySoundFile(file, sha), true)
  assert.equal(await verifySoundFile(file, 'deadbeef'), false)
  assert.equal(await verifySoundFile(file, null), true)
  assert.equal(await verifySoundFile(join(tmpHome, 'missing.wav'), null), false)
})
```

Build the tarball fixture inside the test with `node:child_process` `tar -czf` over a temp directory containing `og-packs-1.1.0/peon/openpeon.json` and one small file, and serve its bytes from `fetchImpl`. Use `node:fs` `mkdtempSync` for `tmpHome` and remove it in an `afterEach`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL — `Cannot find module './install'`.

- [ ] **Step 3: Implement `worker/install.ts`**

`install` writes the downloaded tarball to a temp file, extracts to a temp directory with `spawn('tar', ['-xzf', tarball, '-C', tmp, '--strip-components', '2', `${archiveRoot}/${sourcePath}`])` — or extracts fully and moves the subtree, whichever the implementer finds more robust across GNU and BSD tar — validating every entry path through `tarEntryTarget` before it lands. Then `parseManifest` the extracted `openpeon.json`, verify `manifest_sha256` when the entry carries one, and `rename` the temp directory onto `packDir`. On any failure, remove the temp directory and rethrow; never touch `packDir`. `source_path` defaults to the entry's `name` when absent.

`downloadPreview` fetches the raw URL to a file under `node:os` `tmpdir()` and returns its path.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Verify a real install end to end**

Run: `node --input-type=module -e "..."` driving `PackInstaller.install` against the live `peon` registry entry into a temp home, then `afplay` one file from the result.
Expected: the pack directory contains `openpeon.json` and a `sounds/` folder, and a voice line is audible.

- [ ] **Step 6: Commit**

```bash
git add worker/install.ts worker/install.test.ts
git commit -m "feat: atomic pack install, adoption, update and guarded removal"
```

---

### Task 9: Worker wiring — events to sound, settings, notifications, status bar, first run

**Files:**
- Modify: `worker/main.ts`, `worker/main.test.ts`, `src/protocol.ts`
- Create: `worker/sound-service.ts`, `worker/sound-service.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 2–8.
- Produces:
  ```ts
  export type Settings = {
    volume: number
    muted: boolean
    playSessionStart: boolean
    playTaskAcknowledge: boolean
    playInputRequired: boolean
    playTaskComplete: boolean
    playTaskError: boolean
    notifyWhenMuted: boolean
  }
  export const SETTING_FOR: Record<PlayableCategory, keyof Settings>
  export const NOTIFY_CATEGORIES: readonly PlayableCategory[]  // input.required, task.error
  export class SoundService {
    constructor(deps: {
      store: Store
      gate: SoundGate
      player: Player
      readSettings: () => Promise<Settings>
      notify: (title: string, body: string) => Promise<void>
      verifyFile?: typeof verifySoundFile
      home?: string
    })
    handle(category: PlayableCategory, agentTitle: string | undefined): Promise<void>
  }
  ```
  `src/protocol.ts` gains these `PluginRequests` members, used by Task 10:
  ```ts
  'packs.list': { input: { force?: boolean }; output: PackListView }
  'packs.install': { input: { name: string }; output: { ok: true } }
  'packs.activate': { input: { name: string }; output: { ok: true } }
  'packs.remove': { input: { name: string }; output: { ok: true } }
  'packs.preview': { input: { name: string }; output: { ok: true } }
  ```
  and `PluginPanelEvents`: `'packs.changed': PackListView`.
  ```ts
  export type PackRowView = {
    name: string; displayName: string; description: string | null
    trustTier: string; sizeBytes: number | null; soundCount: number
    present: boolean; active: boolean; adopted: boolean
    updateAvailable: boolean; removable: boolean; busy: boolean
  }
  export type PackListView = {
    rows: PackRowView[]
    activePack: { name: string; displayName: string; covered: string[] } | null
    stale: boolean
    error: string | null
    playbackUnavailable: string | null
    firstRunError: string | null
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// sound-service.test.ts
test('a muted plugin notifies for input.required and stays quiet otherwise', async () => {
  // settings: muted true, notifyWhenMuted true
  await service.handle('input.required', 'Claude')
  await service.handle('task.acknowledge', 'Claude')
  assert.equal(played.length, 0)
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].body, /Claude/)
})

test('a disabled category plays nothing and notifies nothing', async () => {
  // settings: playTaskComplete false, muted false
  await service.handle('task.complete', 'Claude')
  assert.equal(played.length, 0)
  assert.equal(notifications.length, 0)
})

test('a category the pack does not cover notifies when it is notify-worthy', async () => {
  // active pack has no task.error sounds
  await service.handle('task.error', 'Codex')
  assert.equal(played.length, 0)
  assert.equal(notifications.length, 1)
})

test('an unsupported platform notifies instead of playing', async () => {
  // player is createPlayer('linux')
  await service.handle('input.required', 'Claude')
  assert.equal(notifications.length, 1)
})

test('playing records lastPlayed so the next pick differs', async () => {
  await service.handle('task.complete', 'Claude')
  assert.equal(await store.getLastPlayed('task.complete'), played[0])
})

test('a gated sound neither plays nor notifies', async () => {
  // gate always denies
  await service.handle('task.complete', 'Claude')
  assert.equal(played.length, 0)
  assert.equal(notifications.length, 0)
})

test('no active pack is silent and does not throw', async () => {
  await service.handle('task.complete', 'Claude')
  assert.equal(played.length, 0)
})

test('a sound whose hash does not match is skipped and another is tried', async () => {
  // pack has two task.complete sounds; verifyFile rejects the first file it sees
  await service.handle('task.complete', 'Claude')
  assert.equal(played.length, 1)
  assert.notEqual(played[0], firstCandidatePath)
})

test('a category whose every sound fails verification stays silent', async () => {
  // verifyFile always false
  await service.handle('task.complete', 'Claude')
  assert.equal(played.length, 0)
})
```

```ts
// main.test.ts
test('a blocked agent event plays one sound', async () => {
  const worker = await mountWorker(main, { /* storage seeded with an installed pack */ })
  await worker.emit('agent.status.changed', {
    workspaceId: null, paneKey: 'tab-1:pane-1', state: 'blocked', receivedAt: Date.now()
  })
  assert.deepEqual(worker.refusals, [])
  // assert through an injected player spy exported for tests, or through host calls
})

test('the status bar item is updated on activation', async () => {
  const worker = await mountWorker(main)
  assert.ok(worker.host.callsOf('statusBar.update').length >= 1)
  await worker.deactivate()
})

test('first run installs the default pack once and latches on success', async () => {
  // with a stubbed installer that succeeds; activate twice, assert one install
})

test('a failed first run does not latch and surfaces in the pack list', async () => {
  // with a stubbed installer that rejects; assert firstRunDone is still false
  // and packs.list reports firstRunError
})

test('packs.preview plays even when muted and even inside the rate-limit floor', async () => {
  // settings: muted true; fire two packs.preview requests back to back
  const worker = await mountWorker(main, { /* storage seeded with an installed pack */ })
  await worker.request('packs.preview', { name: 'peon' })
  await worker.request('packs.preview', { name: 'peon' })
  assert.equal(played.length, 2)
  await worker.deactivate()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/sound-service.ts`**

`handle` resolves in this order and stops at the first miss: the category's setting is on; `muted` is false; the gate allows it; an active pack exists; the pack's manifest resolves at least one sound for the category; a candidate survives `verifyFile` against its manifest `sha256` (retry with the next candidate on a mismatch, so one corrupt file does not silence a category); the player is available. A miss at the setting or the gate is silent. A miss at `muted`, pack coverage, or player availability falls through to `notify` when `notifyWhenMuted` is on **and** the category is in `NOTIFY_CATEGORIES`. The notification title is `Peon Ping`; the body names the agent and what happened, for example `Claude needs you`.

- [ ] **Step 4: Implement `worker/main.ts`**

`activate` builds the `StoreApi` from `orca.host.call('storage.get'|'storage.set')`, reads settings through `settings.get`, constructs `PaneTracker`, `SoundGate`, `createPlayer(process.platform)`, `RegistryClient`, `PackInstaller` and `SoundService`, then:
- `orca.events.on('agent.status.changed', …)` → `tracker.observe(event)` → `service.handle(category, event.title)`.
- `orca.panels.handle` for each `packs.*` request, posting `packs.changed` after any mutation. `packs.preview` goes **straight to the player**, not through `SoundService`: it ignores `muted` and both gates, because it is an explicit button press. For an installed pack it plays a `session.start` sound from disk; for one that is not installed it uses `downloadPreview` with the entry's first `preview_sounds` file.
- `statusBar.update` with the active pack name on activation and after every change.
- First run: when `isFirstRunDone()` is false and no pack is active, `adoptIfPresent('peon')` first, then `install` the registry's `peon` entry. `markFirstRunDone()` only after one of those succeeds; on failure, keep the message for `PackListView.firstRunError`.

Export the dependency-construction as a function taking overrides so the tests can inject a spy player and installer.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker src/protocol.ts
git commit -m "feat: wire agent events to playback, notifications and first-run install"
```

---

### Task 10: The pack library panel

**Files:**
- Modify: `src/panel.tsx`
- Create: `src/panel.test.tsx`, `src/panel.check.ts`

**Interfaces:**
- Consumes: `PluginRequests` and `PluginPanelEvents` from `src/protocol.ts` (Task 9).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing tests**

```tsx
import { assert, mount, test } from 'orca/testing'
import * as panel from './panel'

const view = (over = {}) => ({ rows: [...], activePack: {...}, stale: false, error: null, playbackUnavailable: null, firstRunError: null, ...over })

test('the active pack and its covered categories are shown', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view() } }) })
  assert.ok(v.find({ text: /Warcraft Peon/ }))
  assert.deepEqual(v.refusals, [])
  await v.unmount()
})

test('typing in the search box filters the rows', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view() } }) })
  await v.type({ label: 'Search packs' }, 'glados')
  assert.equal(v.findAll({ type: 'ListItem' }).length, 1)
  await v.unmount()
})

test('Install calls packs.install and refreshes', async () => {
  const calls: string[] = []
  const v = await mount(panel, { host: mockHost({ requests: {
    'packs.list': () => view(),
    'packs.install': ({ name }) => { calls.push(name); return { ok: true } }
  } }) })
  await v.press({ label: 'Install GLaDOS' })
  assert.deepEqual(calls, ['glados'])
  await v.unmount()
})

test('an adopted pack offers no Delete', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view({ rows: [adoptedRow] }) } }) })
  assert.equal(v.find({ label: /Delete/ }), null)
  await v.unmount()
})

test('a stale registry shows a warning and keeps the list usable', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view({ stale: true, error: 'offline' }) } }) })
  assert.ok(v.find({ type: 'Callout' }))
  assert.ok(v.findAll({ type: 'ListItem' }).length > 0)
  await v.unmount()
})

test('an unavailable player is stated plainly', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view({ playbackUnavailable: 'Audio playback is macOS-only in this version.' }) } }) })
  assert.ok(v.find({ text: /macOS-only/ }))
  await v.unmount()
})

test('a first-run failure offers Retry', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view({ firstRunError: 'offline' }) } }) })
  assert.ok(v.find({ text: /Retry/ }))
  await v.unmount()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `orca plugin test .`
Expected: FAIL.

- [ ] **Step 3: Implement `src/panel.tsx`**

A `setup` export calls `plugin.request('packs.list', {})` into an atom and subscribes with `plugin.on('packs.changed', …)`. Render, top to bottom: a `Card` for the active pack (title, sound count, covered categories, or an `EmptyState` when none); a `Callout` when `stale`, `playbackUnavailable`, or `firstRunError` is set, the last with a Retry `Button`; an `Input` with `type="search"` and `label="Search packs"`; a `Select` for the trust-tier filter with options All / Installed / Official / Verified / Community; and a `List` of `ListItem`s.

Filtering is client-side over `name`, `displayName`, `description` and tier. Cap the rendered rows at 60 and show a `Text muted` line reading `Showing N of M` — `List` does not virtualise, and 382 `ListItem`s in a sidebar is the one thing that will make this panel feel bad.

Each row carries `IconButton`s whose `label` includes the pack's display name, so tests and screen readers can tell them apart: `Preview <name>`, `Install <name>`, `Use <name>`, `Update <name>`, `Delete <name>`. Omit Delete when `removable` is false.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `orca plugin test .`
Expected: PASS.

- [ ] **Step 5: Write `src/panel.check.ts` scenarios and look at them**

Scenarios: `default`, `empty` (no packs installed), `stale`, `unsupported-platform`.

Run: `orca plugin check . --json` then `orca plugin shot . --scenario default`
Expected: check reports no issues; read the PNG and confirm nothing is cut off at sidebar width.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat: pack library panel with search, install and preview"
```

---

### Task 11: Documentation, CI, and the acceptance run

**Files:**
- Create: `README.md`, `.github/workflows/ci.yml`

- [ ] **Step 1: Write `README.md`**

What it does, a screenshot from Task 10, install instructions, the macOS-only note, credit to peon-ping and OpenPeon with links, the CESP categories it maps and the four it cannot, and a line telling people to turn Orca's own notification sound off so the chime and the voice line don't both fire.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

Orca is not installed on GitHub runners, so CI cannot run `orca plugin test` or `orca plugin validate`. CI therefore runs `node --test` over the dependency-free modules only — `worker/mapping`, `worker/gate`, `worker/cesp`, `worker/player`, `worker/paths` — on `ubuntu-latest` with Node 22. Those are plain TypeScript with no `orca` imports, so `node --test --experimental-strip-types` runs them directly.

`orca plugin validate .` and the full `orca plugin test .` stay in the pre-tag checklist in the README, run locally where Orca exists. Say exactly this in a header comment in the workflow file, so the next person does not assume CI green means the plugin validates.

This means the `orca/testing` suites (Tasks 1, 9, 10) are not gated by CI. That is a known limit, not an oversight.

- [ ] **Step 3: The acceptance run**

Load the plugin into the real Orca and use it:

```bash
orca plugin types .
orca plugin validate .
orca plugin dev watch . --check
```

Approve it when prompted. Then, in Orca: open the Peon Ping panel, confirm the registry list populates, install a second pack, preview a sound, switch the active pack. Start an agent in a workspace and confirm by ear:
- a sound when it starts,
- a sound when it stops for a permission prompt,
- a different sound when it finishes,
- silence when you interrupt it.

Expected: every one of those is audible and distinguishable. **The plan is not done until a sound has been heard in Orca.** Record what you heard in the commit message.

- [ ] **Step 4: Commit**

```bash
git add README.md .github
git commit -m "docs: README and CI, verified by ear in Orca"
```

---

### Task 12: Publish

**Files:** none — this task is release mechanics.

- [ ] **Step 1: Confirm the credential**

Run: `gh auth status`
Expected: an entry for `omar227`. If that account is not the one `gh` is signed in as, stop and ask the user to run `gh auth login`. The repository owner must be `omar227` or Orca will reject the publisher.

- [ ] **Step 2: Final validation**

Run: `orca plugin validate . && orca plugin test . && orca plugin inspect .`
Expected: exit 0; `inspect` lists exactly the four capabilities and the `trusted-worker` profile.

- [ ] **Step 3: Create the public repository and push**

```bash
gh repo create omar227/orca-peon-ping --public --source=. --remote=origin --push
```

- [ ] **Step 4: Tag the release**

```bash
git tag -a v1.0.0 -m v1.0.0 && git push origin v1.0.0
```

- [ ] **Step 5: Add the directory topic**

```bash
gh repo edit omar227/orca-peon-ping --add-topic orca-plugin
```

- [ ] **Step 6: Confirm the listing**

Check `https://orca.dev/plugins/omar227/orca-peon-ping` within about an hour.
Expected: the plugin is listed. If it is not, `orca plugin validate .` against the tagged commit is the first thing to re-run.
