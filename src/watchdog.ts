/**
 * watchdog.ts — PolarProcess Watchdog.
 *
 * Periodically health-checks all registered services. If a service fails
 * health checks repeatedly, it restarts it. After exhaust restarts,
 * emits a lobster-event for PolarPilot Agentic healing.
 */

import { readFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as net from 'node:net'

export interface WatchdogTarget {
  name: string
  healthEndpoint: string
  restartCommand: string
  failures: number
  restartAttempts: number
  status: 'healthy' | 'unhealthy' | 'restarting' | 'crash_loop'
  lastCheck: string | null
  restartTimestamps: number[]
}

export interface WatchdogConfig {
  checkIntervalMs: number
  maxFailures: number
  maxRestarts: number
  crashLoopWindowMs: number
  crashLoopThreshold: number
  polarisorRoot: string
  polarportUrl: string
  staleSweepIntervalMs: number
}

const DEFAULT_CONFIG: WatchdogConfig = {
  checkIntervalMs: 30_000,
  maxFailures: 3,
  maxRestarts: 10,
  crashLoopWindowMs: 5 * 60 * 1000,
  crashLoopThreshold: 10,
  polarisorRoot: process.env.HOME
    ? join(process.env.HOME, 'Polarisor')
    : '~/Polarisor',
  polarportUrl: process.env.POLARPORT_URL || 'http://127.0.0.1:11050',
  staleSweepIntervalMs: 60_000,
}

export class Watchdog {
  private targets = new Map<string, WatchdogTarget>()
  private timer: ReturnType<typeof setInterval> | null = null
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null
  private paused = new Set<string>()
  private config: WatchdogConfig

  constructor(config?: Partial<WatchdogConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async discoverTargets(): Promise<number> {
    const root = this.config.polarisorRoot
    let discovered = 0
    const validNames = new Set<string>()

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const polarisPath = join(root, entry.name, 'polaris.json')
      if (!existsSync(polarisPath)) continue

      try {
        const polaris = JSON.parse(readFileSync(polarisPath, 'utf-8'))
        if (polaris.status === 'archived' || polaris.status === 'deprecated') continue
        const sm = polaris.service_management
        if (!sm?.health_endpoint) continue

        const name = polaris.name || entry.name
        validNames.add(name)
        this.targets.set(name, {
          name,
          healthEndpoint: sm.health_endpoint,
          restartCommand: sm.restart_command || '',
          failures: 0,
          restartAttempts: 0,
          status: 'healthy',
          lastCheck: null,
          restartTimestamps: [],
        })
        discovered++
      } catch { /* skip unparseable */ }
    }

    for (const name of this.targets.keys()) {
      if (!validNames.has(name)) {
        this.targets.delete(name)
        this.paused.delete(name)
        console.log(`[Watchdog] Removed stale target: ${name}`)
      }
    }

    return discovered
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.checkAll(), this.config.checkIntervalMs)
    this.staleSweepTimer = setInterval(() => this.sweepStalePorts(), this.config.staleSweepIntervalMs)
    console.log(`[Watchdog] Started, checking ${this.targets.size} targets every ${this.config.checkIntervalMs / 1000}s, stale sweep every ${this.config.staleSweepIntervalMs / 1000}s`)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.staleSweepTimer) { clearInterval(this.staleSweepTimer); this.staleSweepTimer = null }
  }

  pause(serviceName: string): void { this.paused.add(serviceName) }
  resume(serviceName: string): void { this.paused.delete(serviceName) }

  getStatus(): WatchdogTarget[] {
    return Array.from(this.targets.values())
  }

  private async checkAll(): Promise<void> {
    for (const [name, target] of this.targets) {
      if (this.paused.has(name)) continue

      if (target.status === 'crash_loop') {
        const windowStart = Date.now() - this.config.crashLoopWindowMs
        const recentRestarts = target.restartTimestamps.filter(t => t > windowStart)
        if (recentRestarts.length === 0) {
          target.status = 'unhealthy'
          target.restartTimestamps = []
          target.restartAttempts = 0
          target.failures = 0
          console.log(`[Watchdog] ${name} crash_loop window expired, allowing restarts again`)
        } else {
          continue
        }
      }

      const healthy = await this.healthCheck(target.healthEndpoint)
      target.lastCheck = new Date().toISOString()

      if (healthy) {
        target.failures = 0
        target.status = 'healthy'
        continue
      }

      target.failures++
      target.status = 'unhealthy'

      if (target.failures >= this.config.maxFailures) {
        if (this.isCrashLoop(target)) {
          target.status = 'crash_loop'
          this.emitLobsterEvent(name, 'crash_loop', `${name} entered crash loop — ${target.restartAttempts} restarts in ${this.config.crashLoopWindowMs / 1000}s`)
          await this.releasePortForService(name)
          continue
        }

        await this.restartService(target)
      }
    }
  }

  /**
   * Stale sweeper: fetch PolarPort's active port list, TCP-probe each port,
   * release any that are unreachable, and attempt restart via the watchdog targets.
   */
  private async sweepStalePorts(): Promise<void> {
    let ports: Array<{ port: number; service_name: string; project: string; last_verified: string }>
    try {
      const resp = await fetch(`${this.config.polarportUrl}/api/list`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) return
      ports = await resp.json() as typeof ports
    } catch {
      return
    }

    const now = Date.now()
    for (const row of ports) {
      const lastVerified = new Date(row.last_verified).getTime()
      if (now - lastVerified < 90_000) continue

      const alive = await this.tcpProbe(row.port)
      if (alive) continue

      console.log(`[Watchdog] Stale port detected: ${row.port} (${row.service_name}/${row.project}), last_verified ${row.last_verified}`)

      try {
        await fetch(`${this.config.polarportUrl}/api/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: row.port }),
          signal: AbortSignal.timeout(3000),
        })
        console.log(`[Watchdog] Released stale port ${row.port}`)
      } catch { /* best effort */ }

      const target = this.targets.get(row.service_name) || this.targets.get(row.project)
      if (target && target.status !== 'crash_loop') {
        console.log(`[Watchdog] Attempting restart of ${target.name} after stale port release`)
        await this.restartService(target)
      }

      this.emitLobsterEvent(row.service_name, 'stale_port_released', `Port ${row.port} released (stale since ${row.last_verified})`)
    }
  }

  private tcpProbe(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket()
      sock.setTimeout(2000)
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => { sock.destroy(); resolve(false) })
      sock.once('timeout', () => { sock.destroy(); resolve(false) })
      sock.connect(port, '127.0.0.1')
    })
  }

  private async releasePortForService(serviceName: string): Promise<void> {
    try {
      const resp = await fetch(`${this.config.polarportUrl}/api/list`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) return
      const ports = await resp.json() as Array<{ port: number; service_name: string }>
      for (const row of ports) {
        if (row.service_name !== serviceName) continue
        await fetch(`${this.config.polarportUrl}/api/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: row.port }),
          signal: AbortSignal.timeout(3000),
        })
        console.log(`[Watchdog] Released port ${row.port} for crash_loop service ${serviceName}`)
      }
    } catch { /* best effort */ }
  }

  private async healthCheck(endpoint: string): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const timeout = setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch(endpoint, { signal: ctrl.signal })
      clearTimeout(timeout)
      return res.ok
    } catch {
      return false
    }
  }

  private async restartService(target: WatchdogTarget): Promise<void> {
    const now = Date.now()
    target.restartTimestamps.push(now)

    const windowStart = now - this.config.crashLoopWindowMs
    target.restartTimestamps = target.restartTimestamps.filter(t => t > windowStart)
    target.restartAttempts = target.restartTimestamps.length

    target.status = 'restarting'

    if (!target.restartCommand) {
      this.emitLobsterEvent(target.name, 'no_restart_command', `${target.name} unhealthy but no restart_command configured`)
      return
    }

    if (target.restartAttempts > this.config.maxRestarts) {
      this.emitLobsterEvent(target.name, 'restart_exhausted', `${target.name} restart exhausted after ${this.config.maxRestarts} attempts in ${this.config.crashLoopWindowMs / 1000}s window`)
      return
    }

    try {
      const { exec } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => {
        exec(target.restartCommand, { timeout: 30_000 }, (err) => {
          if (err) reject(err); else resolve()
        })
      })
      target.failures = 0
      console.log(`[Watchdog] Restarted ${target.name} (attempt ${target.restartAttempts})`)
    } catch (err) {
      console.error(`[Watchdog] Failed to restart ${target.name}:`, err)
    }
  }

  private isCrashLoop(target: WatchdogTarget): boolean {
    const now = Date.now()
    const windowStart = now - this.config.crashLoopWindowMs
    const recentRestarts = target.restartTimestamps.filter(t => t > windowStart)
    return recentRestarts.length >= this.config.crashLoopThreshold
  }

  private emitLobsterEvent(source: string, type: string, detail: string): void {
    const event = {
      timestamp: new Date().toISOString(),
      source_project: source,
      type: `watchdog.${type}`,
      severity: type === 'crash_loop' ? 'critical' : 'warning',
      detail,
    }
    const eventPath = join(this.config.polarisorRoot, 'lobster-events.jsonl')
    try {
      appendFileSync(eventPath, JSON.stringify(event) + '\n')
    } catch { /* best effort */ }
    console.warn(`[Watchdog] Event: ${type} — ${detail}`)
  }
}
