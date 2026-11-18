import { spawn as nodeSpawn } from 'node:child_process'

export type SpawnFn = (command: string, args: readonly string[]) => void

export type Player = {
  readonly kind: 'afplay' | 'unsupported'
  readonly unavailableReason: string | null
  play(absolutePath: string, volume: number): void
}

const UNSUPPORTED_REASON = 'Audio playback is macOS-only in this version.'

/**
 * Spawns a detached player process. A child that cannot be launched at all (no such command, a
 * sandbox denial) emits `error`, which Node turns into an uncaught exception — and a dead worker
 * is the loudest way for this plugin to stop working — so the listener is never optional.
 */
export function spawnDetached(onError?: (error: Error) => void): SpawnFn {
  return (command, args) => {
    const child = nodeSpawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', (error) => onError?.(error))
    child.unref()
  }
}

const defaultSpawn: SpawnFn = spawnDetached()

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
