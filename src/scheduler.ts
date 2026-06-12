/**
 * scheduler.ts — Resource scheduler.
 *
 * Migrated from SOTAgent/src/scheduler.ts.
 * Manages heavy task queues, detects idle windows, and pauses tasks when resources are constrained.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import type { ProcessDB, IHeavyTaskRow } from './db.js';
import { ResourceProfiler } from './profiler.js';
import { validateCommand } from './command-guard.js';

const managedProcesses = new Map<string, ChildProcess>();

export interface IAdmissionResult {
  admitted: boolean;
  reason?: string;
  estimated: { cpuPercent: number; memMb: number; gpuMemMb: number };
  available: { cpuPercent: number; memMb: number; gpuMemMb: number };
}

export class ResourceScheduler {
  private db: ProcessDB;
  private deviceId: string;
  private profiler: ResourceProfiler;
  private maxConcurrent = 1;

  constructor(db: ProcessDB, deviceId: string, profiler: ResourceProfiler) {
    this.db = db;
    this.deviceId = deviceId;
    this.profiler = profiler;
  }

  isSystemIdle(): { idle: boolean; avgCpu: number; avgMem: number } {
    const pressure = this.profiler.samplePressure(this.deviceId);
    return {
      idle: pressure.idle,
      avgCpu: pressure.cpu_pressure,
      avgMem: pressure.mem_pressure,
    };
  }

  getStatus(): { idle: boolean; running_tasks: number; queue_depth: number; avg_cpu: number; avg_mem: number } {
    const sys = this.isSystemIdle();
    const running = this.db.listTasks('running');
    const queued = this.db.listTasks('queued');
    return {
      idle: sys.idle,
      running_tasks: running.length,
      queue_depth: queued.length,
      avg_cpu: sys.avgCpu,
      avg_mem: sys.avgMem,
    };
  }

  listTasks(status?: string): IHeavyTaskRow[] {
    return this.db.listTasks(status);
  }

  getTask(taskId: string): IHeavyTaskRow | null {
    return this.db.getTask(taskId);
  }

  createTask(params: {
    task_type: string;
    command: string;
    work_dir?: string;
    env?: Record<string, string>;
    priority?: number;
    owner?: string;
    estimated_cpu_percent?: number;
    estimated_mem_mb?: number;
    estimated_gpu_mem_mb?: number;
    callback_url?: string;
    callback_meta?: Record<string, unknown>;
  }): { ok: boolean; task_id: string; message?: string } {
    const validation = validateCommand(params.command);
    if (!validation.ok) {
      return { ok: false, task_id: '', message: `command validation failed: ${validation.reason}` };
    }

    const taskId = `task_${nanoid(10)}`;
    this.db.insertTask({
      task_id: taskId,
      task_type: params.task_type,
      command: params.command,
      work_dir: params.work_dir ?? null,
      env_json: params.env ? JSON.stringify(params.env) : null,
      status: 'queued',
      priority: params.priority ?? 5,
      pid: null,
      progress: 0,
      estimated_cpu_percent: params.estimated_cpu_percent ?? 0,
      estimated_mem_mb: params.estimated_mem_mb ?? 0,
      estimated_gpu_mem_mb: params.estimated_gpu_mem_mb ?? 0,
      owner: params.owner ?? null,
      callback_url: params.callback_url ?? null,
      callback_meta_json: params.callback_meta ? JSON.stringify(params.callback_meta) : null,
    });

    return { ok: true, task_id: taskId };
  }

  async startNextTask(): Promise<boolean> {
    const running = this.db.listTasks('running');
    if (running.length >= this.maxConcurrent) return false;

    const sys = this.isSystemIdle();
    if (!sys.idle && running.length > 0) return false;

    const queued = this.db.listTasks('queued');
    if (queued.length === 0) return false;

    const next = queued[0]!;
    return this.launchTask(next);
  }

  launchTask(task: IHeavyTaskRow): boolean {
    const env = task.env_json ? { ...process.env, ...JSON.parse(task.env_json) } : process.env;

    try {
      const child = spawn(task.command, [], {
        cwd: task.work_dir ?? undefined,
        env: env as Record<string, string>,
        shell: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      managedProcesses.set(task.task_id, child);

      this.db.updateTaskStatus(task.task_id, 'running', {
        pid: child.pid ?? null,
        started_at: new Date().toISOString(),
      });

      child.on('exit', (code) => {
        managedProcesses.delete(task.task_id);
        const finalStatus = code === 0 ? 'done' : 'failed';
        this.db.updateTaskStatus(task.task_id, finalStatus, {
          finished_at: new Date().toISOString(),
          error: code !== 0 ? `exited with code ${code}` : null,
          progress: 100,
        });
        void this.fireCallback(task.task_id, finalStatus, code !== 0 ? `exited with code ${code}` : null);
      });

      return true;
    } catch (err) {
      this.db.updateTaskStatus(task.task_id, 'failed', {
        error: err instanceof Error ? err.message : String(err),
        finished_at: new Date().toISOString(),
      });
      return false;
    }
  }

  cancelTask(taskId: string): { ok: boolean; message: string } {
    const task = this.db.getTask(taskId);
    if (!task) return { ok: false, message: `task ${taskId} not found` };

    const child = managedProcesses.get(taskId);
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already dead */ }
      managedProcesses.delete(taskId);
    }

    this.db.updateTaskStatus(taskId, 'cancelled', {
      finished_at: new Date().toISOString(),
    });
    return { ok: true, message: `task ${taskId} cancelled` };
  }

  private async fireCallback(taskId: string, status: string, error: string | null): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task?.callback_url) return;

    let meta: Record<string, unknown> = {};
    if (task.callback_meta_json) {
      try { meta = JSON.parse(task.callback_meta_json); } catch { /* ignore */ }
    }

    try {
      await fetch(task.callback_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: taskId,
          task_type: task.task_type,
          status,
          error,
          meta,
          finished_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error(`[Scheduler] callback failed for ${taskId}:`, err instanceof Error ? err.message : err);
    }
  }

  updateConfig(config: { max_concurrent?: number; idle_threshold_cpu?: number; idle_threshold_mem?: number }): void {
    if (config.max_concurrent !== undefined) this.maxConcurrent = config.max_concurrent;
  }
}
