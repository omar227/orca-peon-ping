import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import type { PackListView, PackRowView } from './protocol.ts'

/**
 * The panel has no network, no filesystem and no audio: every action here is a request to the
 * worker, which owns all three. It renders what `packs.list` and `packs.changed` hand it.
 */

/** The pack the worker installs on first run (worker/main.ts), so Retry can ask for it by name. */
const DEFAULT_PACK = 'peon'

/** Hundreds of packs, and `List` does not virtualise: the sidebar draws a slice of them. */
const MAX_ROWS = 60

const TIER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Installed' },
  { value: 'official', label: 'Official' },
  { value: 'verified', label: 'Verified' },
  { value: 'community', label: 'Community' }
]

const CATEGORY_LABELS: Record<string, string> = {
  'session.start': 'Started',
  'task.acknowledge': 'Picked up work',
  'input.required': 'Needs you',
  'task.complete': 'Finished',
  'task.error': 'Failed'
}

const packs = atom<PackListView | null>('packs', null)
const query = atom('query', '')
const tier = atom('tier', 'all')
/** What the last request failed with, shown until the next one is made. */
const notice = atom<string | null>('notice', null)

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('packs.changed', (next) => set(packs, next)))
  void refresh()
}

async function refresh(force = false): Promise<void> {
  try {
    set(packs, await plugin.request('packs.list', { force }))
    set(notice, null)
  } catch (error) {
    set(notice, messageOf(error))
  }
}

/** Every row action: ask the worker, report what it says, and take its new view. */
async function act(
  request: 'packs.install' | 'packs.activate' | 'packs.remove' | 'packs.preview',
  name: string
): Promise<void> {
  set(notice, null)
  try {
    await plugin.request(request, { name })
  } catch (error) {
    set(notice, messageOf(error))
    return
  }
  // A preview changes nothing; everything else does, and the worker's view is the truth. The
  // refreshed view is also what retires a first-run error the retry has just put right.
  if (request !== 'packs.preview') await refresh()
}

export default function Panel() {
  const view = read(packs)
  const problem = read(notice)

  if (view === null) {
    if (problem === null) return <Spinner label="Loading packs" />
    return (
      <Callout tone="danger" title="Could not reach Peon Ping" icon="error">
        <Stack gap="sm">
          <Text>{problem}</Text>
          <Button icon="refresh" onPress={() => void refresh(true)}>
            Try again
          </Button>
        </Stack>
      </Callout>
    )
  }

  const matching = view.rows.filter(
    (row) => matchesQuery(row, read(query)) && matchesTier(row, read(tier))
  )
  const shown = matching.slice(0, MAX_ROWS)

  return (
    <Stack gap="sm">
      <ActivePack view={view} />
      <Notices view={view} problem={problem} />
      <Input
        label="Search packs"
        labelHidden
        type="search"
        placeholder="Search packs"
        value={read(query)}
        onChange={(value) => set(query, value)}
      />
      <Select
        label="Filter packs"
        labelHidden
        value={read(tier)}
        options={TIER_OPTIONS}
        onChange={(value) => set(tier, value)}
      />
      {shown.length === 0 ? (
        <EmptyState
          title="No packs match"
          description="Try another search or filter."
          icon="search"
        />
      ) : (
        <Stack gap="xs">
          <Text muted size="xs">
            Showing {shown.length} of {matching.length}
          </Text>
          <List label="Packs">
            {shown.map((row) => (
              <PackRow key={row.name} row={row} canPlay={view.playbackUnavailable === null} />
            ))}
          </List>
        </Stack>
      )}
    </Stack>
  )
}

function ActivePack({ view }: { view: PackListView }) {
  const active = view.activePack
  if (active === null) {
    return (
      <EmptyState
        title="No pack is playing"
        description="Install a pack below to hear your agents."
        icon="bell"
      />
    )
  }

  const sounds = view.rows.find((row) => row.name === active.name)?.soundCount ?? 0
  return (
    <Card title={active.displayName} description={sounds > 0 ? `${sounds} sounds` : undefined}>
      {active.covered.length === 0 ? (
        <Text tone="warning" size="sm">
          This pack covers none of the events Peon Ping plays.
        </Text>
      ) : (
        <Text muted size="sm">
          Plays for: {active.covered.map((name) => CATEGORY_LABELS[name] ?? name).join(', ')}
        </Text>
      )}
    </Card>
  )
}

function Notices({ view, problem }: { view: PackListView; problem: string | null }) {
  return (
    <Stack gap="sm">
      {problem === null ? null : (
        <Callout tone="danger" icon="error">
          <Text>{problem}</Text>
        </Callout>
      )}
      {view.firstRunError === null ? null : (
        <Callout tone="warning" title="Peon Ping has no pack yet" icon="warning">
          <Stack gap="sm">
            <Text>{view.firstRunError}</Text>
            <Button icon="download" onPress={() => void act('packs.install', DEFAULT_PACK)}>
              Retry
            </Button>
          </Stack>
        </Callout>
      )}
      {view.playbackUnavailable === null ? null : (
        <Callout tone="warning" title="No sound on this machine" icon="warning">
          <Text>{view.playbackUnavailable}</Text>
        </Callout>
      )}
      {view.stale || view.error !== null ? (
        <Callout
          tone="warning"
          title={view.stale ? 'Showing the last pack list' : 'Could not read the pack registry'}
          icon="warning"
        >
          <Stack gap="sm">
            {view.error === null ? null : <Text>{view.error}</Text>}
            <Button icon="refresh" onPress={() => void refresh(true)}>
              Refresh
            </Button>
          </Stack>
        </Callout>
      ) : null}
    </Stack>
  )
}

function PackRow({ row, canPlay }: { row: PackRowView; canPlay: boolean }) {
  return (
    <ListItem title={row.displayName} description={row.description ?? undefined}>
      <Stack gap="xs">
        <Row gap="xs" align="center" wrap>
          <Badge tone={tierTone(row.trustTier)}>{row.trustTier}</Badge>
          {row.active ? <Badge tone="success">Active</Badge> : null}
          <Text muted size="xs">
            {metaOf(row)}
          </Text>
        </Row>
        {row.busy ? (
          <Spinner label={`Working on ${row.displayName}`} />
        ) : (
          <Row gap="xs" align="center" wrap>
            <IconButton
              icon="play"
              label={`Preview ${row.displayName}`}
              variant="ghost"
              disabled={!canPlay}
              onPress={() => void act('packs.preview', row.name)}
            />
            {row.present ? null : (
              <IconButton
                icon="download"
                label={`Install ${row.displayName}`}
                onPress={() => void act('packs.install', row.name)}
              />
            )}
            {row.present && !row.active ? (
              <IconButton
                icon="check"
                label={`Use ${row.displayName}`}
                onPress={() => void act('packs.activate', row.name)}
              />
            ) : null}
            {row.updateAvailable ? (
              <IconButton
                icon="refresh"
                label={`Update ${row.displayName}`}
                onPress={() => void act('packs.install', row.name)}
              />
            ) : null}
            {row.removable ? (
              <IconButton
                icon="delete"
                label={`Delete ${row.displayName}`}
                variant="ghost"
                tone="danger"
                onPress={() => void act('packs.remove', row.name)}
              />
            ) : null}
          </Row>
        )}
      </Stack>
    </ListItem>
  )
}

function matchesQuery(row: PackRowView, text: string): boolean {
  const needle = text.trim().toLowerCase()
  if (needle === '') return true
  const haystack = `${row.name} ${row.displayName} ${row.description ?? ''} ${row.trustTier}`
  return haystack.toLowerCase().includes(needle)
}

function matchesTier(row: PackRowView, filter: string): boolean {
  if (filter === 'all') return true
  if (filter === 'installed') return row.present
  return row.trustTier === filter
}

function tierTone(trustTier: string): Tone {
  if (trustTier === 'official') return 'accent'
  if (trustTier === 'verified') return 'success'
  return 'neutral'
}

/** The one line of metadata a 340px row has space for. */
function metaOf(row: PackRowView): string {
  const parts = [`${row.soundCount} sounds`]
  if (row.sizeBytes !== null) parts.push(formatSize(row.sizeBytes))
  return parts.join(' · ')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
