import { spawn as nodeSpawn } from 'node:child_process'

export type SpawnFn = (command: string, args: readonly string[]) => void

export type Player = {
  readonly kind: 'afplay' | 'unsupported'
  readonly unavailableReason: string | null
  play(absolutePath: string, volume: number): void
}

const UNSUPPORTED_REASON = 'Audio playback is macOS-only in this version.'

const defaultSpawn: SpawnFn = (command, args) => {
  const child = nodeSpawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume))
}

class AfplayPlayer implements Player {
  readonly kind = 'afplay'
  readonly unavailableReason = null

  constructor(private readonly spawn: SpawnFn) {}

  play(absolutePath: string, volume: number): void {
    const formattedVolume = clampVolume(volume).toFixed(2)
    this.spawn('afplay', ['-v', formattedVolume, absolutePath])
  }
}

class UnsupportedPlayer implements Player {
  readonly kind = 'unsupported'
  readonly unavailableReason = UNSUPPORTED_REASON

  play(_absolutePath: string, _volume: number): void {
    // No-op: audio playback is not implemented for this platform.
  }
}

export function createPlayer(platform: NodeJS.Platform, spawn: SpawnFn = defaultSpawn): Player {
  if (platform === 'darwin') {
    return new AfplayPlayer(spawn)
  }
  return new UnsupportedPlayer()
}
