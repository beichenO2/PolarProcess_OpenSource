/**
 * profiler.ts — Resource profiling module.
 *
 * Migrated from SOTAgent/src/profiler.ts.
 * Observes running processes to build resource usage profiles over time.
 */

import os from 'node:os';
import { execSync } from 'node:child_process';
import type { ProcessDB, IHeavyTaskRow, IResourceProfileRow } from './db.js';

export interface IResourceSnapshot {
  cpu_percent: number;
  mem_mb: number;
  gpu_mem_mb: number;
  timestamp: string;
}

export interface IPressureState {
  idle: boolean;
  cpu_pressure: number;
  mem_pressure: number;
  mem_availability: number;
  gpu_mem_used_mb: number;
  gpu_mem_total_mb: number;
}

export interface IProcessSample {
  pid: number;
  cpu_percent: number;
  mem_mb: number;
}

export interface ISamplingReport {
  sampled: Array<{ task_id: string; cpu: number; mem: number }>;
  failed: string[];
}

export class ResourceProfiler {
  private db: ProcessDB;
  private _lastGpuMb: number | undefined;

  constructor(db: ProcessDB) {
    this.db = db;
  }

  sampleProcess(pid: number): IProcessSample | null {
    try {
      const output = execSync(
        `ps -p ${pid} -o %cpu=,rss=,vsz= 2>/dev/null`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();

      if (!output) return null;

      const parts = output.split(/\s+/);
      if (parts.length < 2) return null;

      const cpuPercent = parseFloat(parts[0]!) || 0;
      const memMb = Math.round((parseInt(parts[1]!, 10) || 0) / 1024);

      return { pid, cpu_percent: cpuPercent, mem_mb: memMb };
    } catch {
      return null;
    }
  }

  sampleProcessTree(pid: number): IProcessSample | null {
    try {
      const output = execSync(
        `pgrep -P ${pid} 2>/dev/null || echo ""`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();

      const pids = [pid];
      if (output) {
        pids.push(...output.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p)));
      }

      let totalCpu = 0;
      let totalMem = 0;

      for (const p of pids) {
        const sample = this.sampleProcess(p);
        if (sample) {
          totalCpu += sample.cpu_percent;
          totalMem += sample.mem_mb;
        }
      }

      return { pid, cpu_percent: totalCpu, mem_mb: totalMem };
    } catch {
      return this.sampleProcess(pid);
    }
  }

  sampleRunningTasks(): ISamplingReport {
    const running = this.db.listTasks('running');
    const report: ISamplingReport = { sampled: [], failed: [] };

    for (const task of running) {
      if (!task.pid) continue;

      const sample = this.sampleProcessTree(task.pid);
      if (sample) {
        report.sampled.push({ task_id: task.task_id, cpu: sample.cpu_percent, mem: sample.mem_mb });
        this.updateProfile(task.task_type, sample.cpu_percent, sample.mem_mb);
      } else {
        report.failed.push(task.task_id);
      }
    }

    return report;
  }

  updateProfile(taskType: string, cpu: number, mem: number, durationSec?: number): void {
    const existing = this.db.getProfile(taskType);

    if (!existing || existing.sample_count === 0) {
      this.db.upsertProfile({
        task_type: taskType,
        avg_cpu_percent: cpu,
        peak_cpu_percent: cpu,
        avg_mem_mb: mem,
        peak_mem_mb: mem,
        avg_gpu_mem_mb: 0,
        peak_gpu_mem_mb: 0,
        avg_duration_sec: durationSec ?? 0,
        sample_count: 1,
        confidence: 'low',
        last_updated: new Date().toISOString(),
      });
      return;
    }

    const n = existing.sample_count + 1;
    const newAvg = (existing.avg_cpu_percent * existing.sample_count + cpu) / n;
    const newMemAvg = (existing.avg_mem_mb * existing.sample_count + mem) / n;

    this.db.upsertProfile({
      task_type: taskType,
      avg_cpu_percent: Math.round(newAvg * 10) / 10,
      peak_cpu_percent: Math.max(existing.peak_cpu_percent, cpu),
      avg_mem_mb: Math.round(newMemAvg),
      peak_mem_mb: Math.max(existing.peak_mem_mb, mem),
      avg_gpu_mem_mb: existing.avg_gpu_mem_mb,
      peak_gpu_mem_mb: existing.peak_gpu_mem_mb,
      avg_duration_sec: durationSec
        ? (existing.avg_duration_sec * existing.sample_count + durationSec) / n
        : existing.avg_duration_sec,
      sample_count: n,
      confidence: n >= 10 ? 'high' : n >= 3 ? 'medium' : 'low',
      last_updated: new Date().toISOString(),
    });
  }

  samplePressure(_deviceId: string): IPressureState {
    const cpus = os.cpus().length;
    const loadAvg = os.loadavg();
    const cpuPercent = (loadAvg[0]! / cpus) * 100;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsed = totalMem - freeMem;
    const memPercent = (memUsed / totalMem) * 100;

    return {
      idle: cpuPercent < 50 && memPercent < 70,
      cpu_pressure: cpuPercent,
      mem_pressure: memPercent,
      mem_availability: ((freeMem / totalMem) * 100),
      gpu_mem_used_mb: this._lastGpuMb ?? 0,
      gpu_mem_total_mb: 0,
    };
  }

  getResourceSnapshot(): IResourceSnapshot {
    const cpus = os.cpus().length;
    const loadAvg = os.loadavg();
    const cpuPercent = (loadAvg[0]! / cpus) * 100;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      cpu_percent: Math.round(cpuPercent),
      mem_mb: Math.round((totalMem - freeMem) / (1024 * 1024)),
      gpu_mem_mb: this._lastGpuMb ?? 0,
      timestamp: new Date().toISOString(),
    };
  }
}
