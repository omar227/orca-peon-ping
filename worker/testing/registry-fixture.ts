import type { RegistryIndex, RegistryPack } from '../registry.ts'

const TIERS = ['official', 'verified', 'community'] as const
const CATEGORIES = [
  'session.start',
  'task.acknowledge',
  'input.required',
  'task.complete',
  'task.error'
]

/**
 * One registry entry at the size the real ones are: the live index is ~540 KB across 382
 * packs, roughly 1.4 KB an entry, most of it description, tags and preview sound names.
 * Fixtures of six tidy rows are what let a 256 KiB limit hide through twelve reviews.
 */
export function syntheticPack(ordinal: number): RegistryPack {
  const name = `synthetic-pack-${String(ordinal).padStart(4, '0')}`
  return {
    name,
    display_name: `Synthetic Pack ${ordinal} — Voices of the Overworked Build Agent`,
    version: `1.${ordinal % 20}.${ordinal % 7}`,
    description:
      `A full-length registry description for ${name}, long enough to match the real ` +
      'index: who recorded the lines, which game or show they are from, what the pack ' +
      'sounds like when an agent finishes a long task, and the usual note about the ' +
      'licence covering personal use only. Roughly the length the registry really ships.',
    author: { name: `Pack Author ${ordinal}`, github: `pack-author-${ordinal}` },
    trust_tier: TIERS[ordinal % TIERS.length] as RegistryPack['trust_tier'],
    categories: CATEGORIES.slice(0, (ordinal % CATEGORIES.length) + 1),
    language: ordinal % 5 === 0 ? 'de' : 'en',
    license: 'CC-BY-NC-4.0',
    sound_count: 4 + (ordinal % 30),
    total_size_bytes: 1_200_000 + ordinal * 913,
    source_repo: `PeonPingCommunity/sound-pack-collection-${ordinal % 40}`,
    source_ref: `v2.${ordinal % 12}.0`,
    source_path: `packs/${name}`,
    manifest_sha256: `${String(ordinal).padStart(4, '0')}`.repeat(16),
    tags: ['retro', 'gaming', 'voice', `tag-${ordinal % 50}`, `mood-${ordinal % 9}`],
    preview_sounds: [
      `sounds/${name}-task-complete-01.wav`,
      `sounds/${name}-input-required-01.wav`,
      `sounds/${name}-task-error-01.wav`
    ]
  }
}

/** A registry index of `count` realistic packs, generated rather than committed. */
export function syntheticIndex(count: number): RegistryIndex {
  const packs: RegistryPack[] = []
  for (let ordinal = 1; ordinal <= count; ordinal++) packs.push(syntheticPack(ordinal))
  return { version: 1, packs }
}
