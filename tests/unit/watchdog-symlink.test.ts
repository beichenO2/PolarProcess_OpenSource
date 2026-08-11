import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Watchdog } from '../../src/watchdog.js'

function writeProject(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'polaris.json'),
    JSON.stringify({
      name,
      service_management: {
        // Port 1 never listens; discovery does not health-check anyway.
        health_endpoint: 'http://127.0.0.1:1/health',
        restart_command: 'true',
      },
    }),
  )
}

describe('watchdog discovers projects behind directory symlinks', () => {
  let root: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'polarisor-root-'))
    outside = mkdtempSync(join(tmpdir(), 'polarisor-real-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('treats a symlinked project directory the same as a real one', async () => {
    // Control: plain real directory.
    writeProject(join(root, 'RealProj'), 'real-proj')

    // PolarManager monorepo layout: the top-level entry is a symlink,
    // e.g. ~/Polarisor/PolarBudget -> PolarManager/packages/budget.
    writeProject(join(outside, 'budget'), 'sym-proj')
    symlinkSync(join(outside, 'budget'), join(root, 'SymProj'), 'dir')

    const wd = new Watchdog({ polarisorRoot: root })
    const discovered = await wd.discoverTargets()

    const names = wd.getStatus().map((t) => t.name).sort()
    expect(names).toContain('real-proj')
    expect(names).toContain('sym-proj')
    expect(discovered).toBe(2)
  })

  it('ignores dangling symlinks without throwing', async () => {
    writeProject(join(root, 'RealProj'), 'real-proj')
    symlinkSync(join(outside, 'does-not-exist'), join(root, 'Dangling'), 'dir')

    const wd = new Watchdog({ polarisorRoot: root })
    const discovered = await wd.discoverTargets()

    expect(discovered).toBe(1)
    expect(wd.getStatus().map((t) => t.name)).toEqual(['real-proj'])
  })
})
