import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Watchdog } from '../../src/watchdog.js'

/** A discoverable Polarisor project whose restart script only works from its own directory. */
function writeProject(root: string, dir: string, name: string): string {
  const projectDir = join(root, dir)
  mkdirSync(join(projectDir, 'Start'), { recursive: true })
  writeFileSync(
    join(projectDir, 'polaris.json'),
    JSON.stringify({
      name,
      service_management: {
        // Port 1 is never listening, so every health check fails.
        health_endpoint: 'http://127.0.0.1:1/health',
        restart_command: 'bash Start/restart.sh',
      },
    }),
  )
  writeFileSync(join(projectDir, 'Start', 'restart.sh'), 'printf ok > restarted.marker\n')
  return projectDir
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

describe('watchdog restarts a target inside its own project directory', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'polarisor-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('records the directory a target was discovered in, even when it differs from the name', async () => {
    // PolarClock is the real case: polaris.json says "PolarClock", the directory is "Clock".
    writeProject(root, 'Clock', 'PolarClock')
    writeProject(root, 'AutoOffice', 'AutoOffice')

    const watchdog = new Watchdog({ polarisorRoot: root })
    expect(await watchdog.discoverTargets()).toBe(2)

    const byName = new Map(watchdog.getStatus().map((t) => [t.name, t.dir]))
    expect(byName.get('PolarClock')).toBe(join(root, 'Clock'))
    expect(byName.get('AutoOffice')).toBe(join(root, 'AutoOffice'))
  })

  it('runs restart_command in the project directory, not in PolarProcess itself', async () => {
    const projectDir = writeProject(root, 'Clock', 'PolarClock')

    const watchdog = new Watchdog({
      polarisorRoot: root,
      checkIntervalMs: 25,
      maxFailures: 1,
      // Keep the stale-port sweeper out of this test.
      staleSweepIntervalMs: 3_600_000,
    })
    await watchdog.discoverTargets()
    watchdog.start()

    // `bash Start/restart.sh` writes its marker relative to the cwd it runs in: the marker
    // only appears here if the restart inherited the project directory.
    const restarted = await waitFor(() => existsSync(join(projectDir, 'restarted.marker')))
    watchdog.stop()

    expect(restarted).toBe(true)
  })
})
