/**
 * service-db.ts — Adapter for SOTAgent's resources.sqlite shared_services schema.
 *
 * Opens the existing SOTAgent resources database in read-write mode.
 * Does not create tables; schema is owned by SOTAgent.
 */

import Database from 'better-sqlite3';
import { execSync as execSyncFn } from 'node:child_process';

export interface ISharedServiceRow {
  id: string;
  name: string;
  command: string;
  work_dir: string | null;
  mem_requirement_mb: number;
  gpu_mem_requirement_mb: number;
  status: string;
  pid: number | null;
  port: number | null;
  device_id: string;
  auto_start: number;
  restart_on_failure: number;
  max_restarts: number;
  restart_count: number;
  started_at: string | null;
  last_used: string | null;
  last_health_check: string | null;
  health_check_url: string | null;
  cron_schedule: string | null;
  last_exit_code: number | null;
  last_error: string | null;
  restart_count_updated_at: string | null;
  pending_restart: number;
  last_change_at: string | null;
  start_script_dir: string | null;
}

export interface IDeviceConfigRow {
  device_id: string;
  display_name: string;
  tailscale_ip: string | null;
  role: string;
  is_local: number;
  capabilities: string | null;
  last_seen: string;
}

interface IPortRegistryRow {
  port: number;
  service_name: string;
  project: string;
  device_id: string;
  allocated_at: string;
  last_verified: string;
  status: 'active' | 'released' | 'stale';
}

export class ServiceDB {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  close(): void {
    this.db.close();
  }

  getService(id: string): ISharedServiceRow | undefined {
    return this.db.prepare('SELECT * FROM shared_services WHERE id = ?').get(id) as ISharedServiceRow | undefined;
  }

  listServices(deviceId?: string): ISharedServiceRow[] {
    if (deviceId) {
      return this.db.prepare(
        "SELECT * FROM shared_services WHERE device_id = ? OR device_id = 'any' ORDER BY name"
      ).all(deviceId) as ISharedServiceRow[];
    }
    return this.db.prepare('SELECT * FROM shared_services ORDER BY name').all() as ISharedServiceRow[];
  }

  listAutoStartServices(deviceId: string): ISharedServiceRow[] {
    return this.db.prepare(
      "SELECT * FROM shared_services WHERE auto_start = 1 AND (device_id = ? OR device_id = 'any') ORDER BY name"
    ).all(deviceId) as ISharedServiceRow[];
  }

  listCronServices(deviceId: string): ISharedServiceRow[] {
    return this.db.prepare(
      "SELECT * FROM shared_services WHERE cron_schedule IS NOT NULL AND (device_id = ? OR device_id = 'any') ORDER BY name"
    ).all(deviceId) as ISharedServiceRow[];
  }

  updateServiceStatus(id: string, status: string, extra?: {
    pid?: number;
    port?: number;
    restart_count?: number;
    last_exit_code?: number | null;
    last_error?: string | null;
  }): void {
    const sets = ['status = ?'];
    const vals: unknown[] = [status];
    if (status === 'running') sets.push("started_at = datetime('now')");
    if (status === 'starting' && extra?.pid == null) sets.push('pid = NULL');
    if (status === 'stopped') {
      sets.push('pid = NULL');
      sets.push('restart_count = 0');
      sets.push("restart_count_updated_at = datetime('now')");
    }
    if (extra?.pid != null) { sets.push('pid = ?'); vals.push(extra.pid); }
    if (extra?.port != null) {
      const portOwner = this.db.prepare(
        'SELECT id FROM shared_services WHERE port = ? AND id != ? LIMIT 1'
      ).get(extra.port, id) as { id: string } | undefined;
      if (portOwner) {
        console.warn(
          `[ServiceDB] skip port update for ${id}: ${extra.port} already assigned to ${portOwner.id}`
        );
      } else {
        sets.push('port = ?');
        vals.push(extra.port);
      }
    }
    if (extra?.restart_count != null) {
      sets.push('restart_count = ?');
      vals.push(extra.restart_count);
      sets.push("restart_count_updated_at = datetime('now')");
    }
    if (extra?.last_exit_code !== undefined) { sets.push('last_exit_code = ?'); vals.push(extra.last_exit_code); }
    if (extra?.last_error !== undefined) { sets.push('last_error = ?'); vals.push(extra.last_error); }
    vals.push(id);
    this.db.prepare(`UPDATE shared_services SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  updateServiceRestartCount(id: string, restartCount: number): void {
    this.db.prepare(
      "UPDATE shared_services SET restart_count = ?, restart_count_updated_at = datetime('now') WHERE id = ?"
    ).run(restartCount, id);
  }

  updateServiceHealthCheck(id: string): void {
    this.db.prepare(
      "UPDATE shared_services SET last_health_check = datetime('now') WHERE id = ?"
    ).run(id);
  }

  updateServiceCommand(id: string, command: string, workDir?: string): void {
    if (workDir) {
      this.db.prepare(
        'UPDATE shared_services SET command = ?, work_dir = ? WHERE id = ?'
      ).run(command, workDir, id);
    } else {
      this.db.prepare(
        'UPDATE shared_services SET command = ? WHERE id = ?'
      ).run(command, id);
    }
  }

  updateServicePort(id: string, port: number): void {
    this.db.prepare(
      'UPDATE shared_services SET port = ? WHERE id = ?'
    ).run(port, id);
  }

  markPendingRestart(id: string): void {
    this.db.prepare(
      "UPDATE shared_services SET pending_restart = 1, last_change_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  clearPendingRestart(id: string): void {
    this.db.prepare(
      'UPDATE shared_services SET pending_restart = 0 WHERE id = ?'
    ).run(id);
  }

  listPendingRestarts(): ISharedServiceRow[] {
    return this.db.prepare(
      'SELECT * FROM shared_services WHERE pending_restart = 1'
    ).all() as ISharedServiceRow[];
  }

  logServiceEvent(params: {
    service_id: string;
    service_name: string;
    event_type: string;
    detail?: string;
    restart_count?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO service_events (service_id, service_name, event_type, detail, restart_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      params.service_id,
      params.service_name,
      params.event_type,
      params.detail ?? null,
      params.restart_count ?? null,
    );
  }

  upsertDevice(params: {
    device_id: string;
    display_name: string;
    tailscale_ip?: string;
    role?: string;
    is_local?: boolean;
    capabilities?: string[];
  }): void {
    this.db.prepare(`
      INSERT INTO device_config (device_id, display_name, tailscale_ip, role, is_local, capabilities, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(device_id) DO UPDATE SET
        display_name = excluded.display_name,
        tailscale_ip = COALESCE(excluded.tailscale_ip, tailscale_ip),
        role = excluded.role,
        is_local = excluded.is_local,
        capabilities = excluded.capabilities,
        last_seen = datetime('now')
    `).run(
      params.device_id,
      params.display_name,
      params.tailscale_ip ?? null,
      params.role ?? 'dev',
      params.is_local ? 1 : 0,
      params.capabilities ? JSON.stringify(params.capabilities) : null,
    );
  }

  getDevice(deviceId: string): IDeviceConfigRow | undefined {
    return this.db.prepare(
      'SELECT * FROM device_config WHERE device_id = ?'
    ).get(deviceId) as IDeviceConfigRow | undefined;
  }

  listDevices(): IDeviceConfigRow[] {
    return this.db.prepare(
      'SELECT * FROM device_config ORDER BY display_name'
    ).all() as IDeviceConfigRow[];
  }

  static isPortCompliant(port: number): boolean {
    const lastDigit = port % 10;
    return lastDigit === 0 || lastDigit === 5;
  }

  allocatePort(params: {
    service_name: string;
    project: string;
    device_id: string;
    preferred_port?: number;
    range_start?: number;
    range_end?: number;
  }): number | null {
    const rangeStart = params.range_start ?? 3000;
    const rangeEnd = params.range_end ?? 9999;

    // Phase 0: reuse active port for same service_name if not in use
    const sameServiceRow = this.db.prepare(
      "SELECT port FROM port_registry WHERE service_name = ? AND status = 'active' ORDER BY last_verified DESC LIMIT 1"
    ).get(params.service_name) as { port: number } | undefined;

    if (
      sameServiceRow &&
      sameServiceRow.port > 0 &&
      ServiceDB.isPortCompliant(sameServiceRow.port) &&
      !this.isPortInUse(sameServiceRow.port)
    ) {
      this.db.prepare(`
        UPDATE port_registry SET
          project = ?, device_id = ?, status = 'active',
          allocated_at = datetime('now'), last_verified = datetime('now')
        WHERE port = ?
      `).run(params.project, params.device_id, sameServiceRow.port);
      this.db.prepare(
        "UPDATE port_registry SET status = 'released' WHERE service_name = ? AND status = 'active' AND port != ?"
      ).run(params.service_name, sameServiceRow.port);
      return sameServiceRow.port;
    }

    // Phase 1: preferred port
    if (params.preferred_port != null) {
      if (!ServiceDB.isPortCompliant(params.preferred_port)) {
        console.warn(`[port] 拒绝分配端口 ${params.preferred_port}：不以 0 或 5 结尾`);
        return null;
      }

      const existing = this.db.prepare(
        "SELECT port, service_name FROM port_registry WHERE port = ? AND status = 'active'"
      ).get(params.preferred_port) as { port: number; service_name: string } | undefined;

      if (!existing && !this.isPortInUse(params.preferred_port)) {
        this.db.prepare(`
          INSERT INTO port_registry (port, service_name, project, device_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(port) DO UPDATE SET
            service_name = excluded.service_name,
            project = excluded.project,
            device_id = excluded.device_id,
            status = 'active',
            allocated_at = datetime('now'),
            last_verified = datetime('now')
        `).run(params.preferred_port, params.service_name, params.project, params.device_id);
        return params.preferred_port;
      }

      if (existing && existing.service_name === params.service_name && !this.isPortInUse(params.preferred_port)) {
        this.db.prepare(`
          UPDATE port_registry SET
            project = ?, device_id = ?, status = 'active',
            allocated_at = datetime('now'), last_verified = datetime('now')
          WHERE port = ?
        `).run(params.project, params.device_id, params.preferred_port);
        return params.preferred_port;
      }

      if (!existing) {
        const staleRow = this.db.prepare(
          "SELECT * FROM port_registry WHERE port = ? AND status IN ('released', 'stale')"
        ).get(params.preferred_port) as IPortRegistryRow | undefined;

        if (
          staleRow &&
          staleRow.service_name === params.service_name &&
          staleRow.project === params.project &&
          this.isPortInUse(params.preferred_port)
        ) {
          this.db.prepare(`
            UPDATE port_registry SET
              status = 'active', device_id = ?,
              allocated_at = datetime('now'), last_verified = datetime('now')
            WHERE port = ?
          `).run(params.device_id, params.preferred_port);
          console.log(`[port] allocatePort: 复活 released/stale 端口 ${params.preferred_port} (${params.service_name}/${params.project})`);
          return params.preferred_port;
        }
      }
    }

    // Phase 2: search available ports
    const allocatedPorts = new Set(
      (this.db.prepare(
        "SELECT port FROM port_registry WHERE status = 'active'"
      ).all() as { port: number }[]).map(r => r.port)
    );

    const firstCompliant = rangeStart % 5 === 0 ? rangeStart : rangeStart + (5 - rangeStart % 5);
    for (let port = firstCompliant; port <= rangeEnd; port += 5) {
      if (!allocatedPorts.has(port) && !this.isPortInUse(port)) {
        this.db.prepare(`
          INSERT INTO port_registry (port, service_name, project, device_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(port) DO UPDATE SET
            service_name = excluded.service_name,
            project = excluded.project,
            device_id = excluded.device_id,
            status = 'active',
            allocated_at = datetime('now'),
            last_verified = datetime('now')
        `).run(port, params.service_name, params.project, params.device_id);
        return port;
      }
    }

    return null;
  }

  releasePort(port: number): void {
    this.db.prepare(
      "UPDATE port_registry SET status = 'released' WHERE port = ?"
    ).run(port);
  }

  listActivePortEntries(): Array<{ port: number; service_name: string }> {
    return this.db.prepare(
      "SELECT port, service_name FROM port_registry WHERE status = 'active'"
    ).all() as Array<{ port: number; service_name: string }>;
  }

  private isPortInUse(port: number): boolean {
    try {
      const result = execSyncFn(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf-8' });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }
}
