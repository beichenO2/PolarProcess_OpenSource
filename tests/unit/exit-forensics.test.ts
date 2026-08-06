import { afterEach, describe, expect, it } from 'vitest'

import { installExitForensics } from '../../src/exit-forensics.js'

let teardown: (() => void) | null = null

afterEach(() => {
  teardown?.()
  teardown = null
})

describe('exit forensics', () => {
  it('names the process on boot so a later death can be correlated', () => {
    const lines: string[] = []
    teardown = installExitForensics({ log: (l) => lines.push(l), exit: () => {} })

    expect(lines[0]).toContain('[ExitForensics] boot')
    expect(lines[0]).toContain(`pid=${process.pid}`)
    expect(lines[0]).toContain(`ppid=${process.ppid}`)
  })

  it('records which signal arrived, and re-exits with the conventional status', () => {
    const lines: string[] = []
    const exits: number[] = []
    teardown = installExitForensics({ log: (l) => lines.push(l), exit: (c) => exits.push(c) })

    process.emit('SIGTERM')

    const death = lines.find((l) => l.includes('received SIGTERM'))
    expect(death).toBeTruthy()
    expect(death).toContain(`ppid=${process.ppid}`)
    // 128 + SIGTERM: the supervisor keeps seeing the same status it saw before.
    expect(exits).toEqual([143])
  })

  it('stops listening once torn down', () => {
    const lines: string[] = []
    const stop = installExitForensics({ log: (l) => lines.push(l), exit: () => {} })
    stop()
    const before = lines.length

    process.emit('SIGHUP')

    expect(lines).toHaveLength(before)
  })
})
