/**
 * service-db.ts — Adapter for SOTAgent's resources.sqlite shared_services schema.
 *
 * Opens the existing SOTAgent resources database in read-write mode.
 * Does not create tables; schema is owned by SOTAgent.
 */

import Database from 'better-sqlite3';

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

  registerService(params: {
    id: string;
    name: string;
    command: string;
    work_dir?: string | null;
    mem_requirement_mb?: number;
    gpu_mem_requirement_mb?: number;
    device_id?: string;
    auto_start?: boolean;
    restart_on_failure?: boolean;
    max_restarts?: number;
    port?: number | null;
    health_check_url?: string | null;
    cron_schedule?: string | null;
    start_script_dir?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO shared_services (id, name, command, work_dir, mem_requirement_mb, gpu_mem_requirement_mb, device_id, auto_start, restart_on_failure, max_restarts, port, health_check_url, cron_schedule, start_script_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        command = excluded.command,
        work_dir = excluded.work_dir,
        mem_requirement_mb = excluded.mem_requirement_mb,
        gpu_mem_requirement_mb = excluded.gpu_mem_requirement_mb,
        device_id = excluded.device_id,
        auto_start = excluded.auto_start,
        restart_on_failure = excluded.restart_on_failure,
        max_restarts = excluded.max_restarts,
        port = COALESCE(excluded.port, port),
        health_check_url = excluded.health_check_url,
        cron_schedule = excluded.cron_schedule,
        start_script_dir = excluded.start_script_dir
    `).run(
      params.id,
      params.name,
      params.command,
      params.work_dir ?? null,
      params.mem_requirement_mb ?? 0,
      params.gpu_mem_requirement_mb ?? 0,
      params.device_id ?? 'any',
      params.auto_start ? 1 : 0,
      params.restart_on_failure ? 1 : 0,
      params.max_restarts ?? 3,
      params.port ?? null,
      params.health_check_url ?? null,
      params.cron_schedule ?? null,
      params.start_script_dir ?? null,
    );
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

  /**
   * @deprecated Port allocation is PolarPort's sole authority (2026-07-09).
   * Callers must use PolarPort HTTP `/api/allocate` (see ProcessManager.claimPortFromPolarPort).
   * This local port_registry path is retained only so old call sites fail loudly.
   */
  allocatePort(_params: {
    service_name: string;
    project: string;
    device_id: string;
    preferred_port?: number;
    range_start?: number;
    range_end?: number;
  }): number | null {
    throw new Error(
      'ServiceDB.allocatePort removed — use PolarPort /api/allocate (sole port authority). ' +
      'See Agent_core P27 / PolarProcess ProcessManager.claimPortFromPolarPort.',
    );
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
}
