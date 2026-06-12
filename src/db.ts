/**
 * db.ts — PolarProcess local database layer.
 *
 * Minimal sqlite schema for process/scheduler state persistence.
 * Migrated concept from SOTAgent's db.ts but scoped to PolarProcess's needs.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface IServiceRow {
  id: string;
  name: string;
  command: string;
  work_dir: string | null;
  device_id: string;
  port: number | null;
  auto_start: boolean;
  restart_count: number;
  max_restarts: number;
  status: 'stopped' | 'starting' | 'running' | 'error';
  pid: number | null;
  started_at: string | null;
  last_health_check: string | null;
  last_error: string | null;
  env_json: string | null;
  cron_schedule: string | null;
}

export interface IHeavyTaskRow {
  task_id: string;
  task_type: string;
  command: string;
  work_dir: string | null;
  env_json: string | null;
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  priority: number;
  pid: number | null;
  progress: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  estimated_cpu_percent: number;
  estimated_mem_mb: number;
  estimated_gpu_mem_mb: number;
  owner: string | null;
  callback_url: string | null;
  callback_meta_json: string | null;
}

export interface IResourceProfileRow {
  task_type: string;
  avg_cpu_percent: number;
  peak_cpu_percent: number;
  avg_mem_mb: number;
  peak_mem_mb: number;
  avg_gpu_mem_mb: number;
  peak_gpu_mem_mb: number;
  avg_duration_sec: number;
  sample_count: number;
  confidence: 'low' | 'medium' | 'high';
  last_updated: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS services (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  command           TEXT NOT NULL,
  work_dir          TEXT,
  device_id         TEXT NOT NULL,
  port              INTEGER,
  auto_start        INTEGER NOT NULL DEFAULT 0,
  restart_count     INTEGER NOT NULL DEFAULT 0,
  max_restarts      INTEGER NOT NULL DEFAULT 3,
  status            TEXT NOT NULL DEFAULT 'stopped',
  pid               INTEGER,
  started_at        TEXT,
  last_health_check TEXT,
  last_error        TEXT,
  env_json          TEXT,
  cron_schedule     TEXT
);

CREATE TABLE IF NOT EXISTS heavy_tasks (
  task_id               TEXT PRIMARY KEY,
  task_type             TEXT NOT NULL,
  command               TEXT NOT NULL,
  work_dir              TEXT,
  env_json              TEXT,
  status                TEXT NOT NULL DEFAULT 'queued',
  priority              INTEGER NOT NULL DEFAULT 5,
  pid                   INTEGER,
  progress              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  started_at            TEXT,
  finished_at           TEXT,
  error                 TEXT,
  estimated_cpu_percent REAL NOT NULL DEFAULT 0,
  estimated_mem_mb      REAL NOT NULL DEFAULT 0,
  callback_url          TEXT,
  callback_meta_json    TEXT,
  estimated_gpu_mem_mb  REAL NOT NULL DEFAULT 0,
  owner                 TEXT
);

CREATE TABLE IF NOT EXISTS resource_profiles (
  task_type         TEXT PRIMARY KEY,
  avg_cpu_percent   REAL NOT NULL DEFAULT 0,
  peak_cpu_percent  REAL NOT NULL DEFAULT 0,
  avg_mem_mb        REAL NOT NULL DEFAULT 0,
  peak_mem_mb       REAL NOT NULL DEFAULT 0,
  avg_gpu_mem_mb    REAL NOT NULL DEFAULT 0,
  peak_gpu_mem_mb   REAL NOT NULL DEFAULT 0,
  avg_duration_sec  REAL NOT NULL DEFAULT 0,
  sample_count      INTEGER NOT NULL DEFAULT 0,
  confidence        TEXT NOT NULL DEFAULT 'low',
  last_updated      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON heavy_tasks(status);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
`;

export class ProcessDB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(DDL);
  }

  // ─── Services ──────────────────────────────────────

  listServices(): IServiceRow[] {
    return this.db.prepare('SELECT * FROM services ORDER BY name').all() as IServiceRow[];
  }

  getService(id: string): IServiceRow | null {
    return (this.db.prepare('SELECT * FROM services WHERE id = ?').get(id) as IServiceRow | undefined) ?? null;
  }

  upsertService(row: Partial<IServiceRow> & { id: string; name: string; command: string; device_id: string }): void {
    const merged = {
      work_dir: null,
      port: null,
      restart_count: 0,
      max_restarts: 3,
      status: 'stopped' as const,
      pid: null,
      started_at: null,
      last_health_check: null,
      last_error: null,
      env_json: null,
      cron_schedule: null,
      ...row,
      auto_start: row.auto_start ? 1 : 0,
    }
    const finalMerged = {
      ...merged,
      restart_count: row.restart_count ?? merged.restart_count,
      max_restarts: row.max_restarts ?? merged.max_restarts,
    }
    this.db.prepare(`
      INSERT INTO services (id, name, command, work_dir, device_id, port, auto_start, restart_count, max_restarts, status, pid, started_at, last_health_check, last_error, env_json, cron_schedule)
      VALUES (@id, @name, @command, @work_dir, @device_id, @port, @auto_start, @restart_count, @max_restarts, @status, @pid, @started_at, @last_health_check, @last_error, @env_json, @cron_schedule)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, command=excluded.command, work_dir=excluded.work_dir,
        device_id=excluded.device_id, port=excluded.port, auto_start=excluded.auto_start,
        restart_count=excluded.restart_count, max_restarts=excluded.max_restarts,
        status=excluded.status, pid=excluded.pid, started_at=excluded.started_at,
        last_health_check=excluded.last_health_check, last_error=excluded.last_error,
        env_json=excluded.env_json, cron_schedule=excluded.cron_schedule
    `).run(finalMerged);
  }

  updateServiceStatus(id: string, status: string, pid?: number | null, error?: string | null): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    if (pid !== undefined) { sets.push('pid = ?'); vals.push(pid); }
    if (error !== undefined) { sets.push('last_error = ?'); vals.push(error); }
    if (status === 'running') { sets.push("started_at = datetime('now')"); }
    if (status === 'running') { sets.push("last_health_check = datetime('now')"); }
    vals.push(id);
    this.db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ─── Heavy Tasks ───────────────────────────────────

  listTasks(status?: string): IHeavyTaskRow[] {
    if (status) {
      return this.db.prepare('SELECT * FROM heavy_tasks WHERE status = ? ORDER BY priority DESC, created_at').all(status) as IHeavyTaskRow[];
    }
    return this.db.prepare('SELECT * FROM heavy_tasks ORDER BY priority DESC, created_at').all() as IHeavyTaskRow[];
  }

  getTask(taskId: string): IHeavyTaskRow | null {
    return (this.db.prepare('SELECT * FROM heavy_tasks WHERE task_id = ?').get(taskId) as IHeavyTaskRow | undefined) ?? null;
  }

  insertTask(row: Pick<IHeavyTaskRow, 'task_id' | 'task_type' | 'command' | 'status' | 'priority'> & Partial<IHeavyTaskRow>): void {
    this.db.prepare(`
      INSERT INTO heavy_tasks (task_id, task_type, command, work_dir, env_json, status, priority, pid, progress, created_at, started_at, finished_at, error, estimated_cpu_percent, estimated_mem_mb, estimated_gpu_mem_mb, owner, callback_url, callback_meta_json)
      VALUES (@task_id, @task_type, @command, @work_dir, @env_json, @status, @priority, @pid, @progress, @created_at, @started_at, @finished_at, @error, @estimated_cpu_percent, @estimated_mem_mb, @estimated_gpu_mem_mb, @owner, @callback_url, @callback_meta_json)
    `).run({
      created_at: new Date().toISOString(),
      work_dir: null,
      env_json: null,
      pid: null,
      progress: 0,
      started_at: null,
      finished_at: null,
      error: null,
      estimated_cpu_percent: 0,
      estimated_mem_mb: 0,
      estimated_gpu_mem_mb: 0,
      owner: null,
      callback_url: null,
      callback_meta_json: null,
      ...row as Record<string, unknown>,
    });
  }

  updateTaskStatus(taskId: string, status: string, updates?: Partial<IHeavyTaskRow>): void {
    if (updates) {
      const sets = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
      this.db.prepare(`UPDATE heavy_tasks SET status = @status, ${sets} WHERE task_id = @task_id`)
        .run({ status, task_id: taskId, ...updates });
    } else {
      this.db.prepare('UPDATE heavy_tasks SET status = ? WHERE task_id = ?').run(status, taskId);
    }
  }

  // ─── Resource Profiles ─────────────────────────────

  getProfile(taskType: string): IResourceProfileRow | null {
    return (this.db.prepare('SELECT * FROM resource_profiles WHERE task_type = ?').get(taskType) as IResourceProfileRow | undefined) ?? null;
  }

  upsertProfile(row: IResourceProfileRow): void {
    this.db.prepare(`
      INSERT INTO resource_profiles (task_type, avg_cpu_percent, peak_cpu_percent, avg_mem_mb, peak_mem_mb, avg_gpu_mem_mb, peak_gpu_mem_mb, avg_duration_sec, sample_count, confidence, last_updated)
      VALUES (@task_type, @avg_cpu_percent, @peak_cpu_percent, @avg_mem_mb, @peak_mem_mb, @avg_gpu_mem_mb, @peak_gpu_mem_mb, @avg_duration_sec, @sample_count, @confidence, @last_updated)
      ON CONFLICT(task_type) DO UPDATE SET
        avg_cpu_percent=excluded.avg_cpu_percent, peak_cpu_percent=excluded.peak_cpu_percent,
        avg_mem_mb=excluded.avg_mem_mb, peak_mem_mb=excluded.peak_mem_mb,
        avg_gpu_mem_mb=excluded.avg_gpu_mem_mb, peak_gpu_mem_mb=excluded.peak_gpu_mem_mb,
        avg_duration_sec=excluded.avg_duration_sec, sample_count=excluded.sample_count,
        confidence=excluded.confidence, last_updated=excluded.last_updated
    `).run(row);
  }

  close(): void {
    this.db.close();
  }
}
