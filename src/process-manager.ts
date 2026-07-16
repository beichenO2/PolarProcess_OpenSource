/**
 * process-manager.ts — 进程生命周期管理
 *
 * 负责：
 * - 根据 device_id 决定服务应在哪台设备运行
 * - 自启动 auto_start 服务
 * - 健康检查 + 自动重启（带上限）
 * - 启动 / 停止 / 重启单个服务
 * - 将非本机服务的请求转发到远程设备
 */

import { spawn, execSync, exec, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { ServiceDB, ISharedServiceRow, IServiceRegistrationParams } from './service-db.js';
import { getPeerTailscaleIP } from './tailscale-client.js';
const SOTAGENT_API_PORT = Number(process.env.SOTAGENT_API_PORT ?? 4800);
import { validateCommand, normalizeCommand } from './command-guard.js';


export interface IProcessManagerConfig {
  devices?: Record<string, { display_name: string; role: string; capabilities: string[]; ssh_user?: string; tailscale_ip?: string }>;
  silent_restart_window_sec?: number;
  process_manager?: {
    health_check_interval_sec: number;
    auto_start_delay_sec: number;
    max_restart_attempts: number;
    restart_cooldown_sec: number;
    restart_decay_min?: number;
    startup_grace_sec?: number;
  };
}

// ─── 类型 ──────────────────────────────────────────────────

export interface IProcessStatus {
  id: string;
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'error';
  pid: number | null;
  port: number | null;
  device_id: string;
  auto_start: boolean;
  restart_count: number;
  max_restarts: number;
  started_at: string | null;
  last_health_check: string | null;
  /** 是否应在本机运行 */
  is_local: boolean;
  /** 远端设备名称（若非本机） */
  remote_device?: string;
  cron_schedule?: string | null;
  last_exit_code?: number | null;
  last_error?: string | null;
  /** PID 是否经过 kill -0 实时验证 */
  pid_verified?: boolean;
  pending_restart?: boolean;
  last_change_at?: string | null;
}

export interface IServiceActionResult {
  ok: boolean;
  message: string;
  pid?: number;
}

export interface IServiceRegistrationResult {
  ok: boolean;
  message: string;
  id: string;
  code?: 'SERVICE_RUNNING';
  changed_fields?: string[];
}

export interface IServiceReconcileResult {
  ok: boolean;
  message: string;
  service_id: string;
  kept_pid?: number;
  reaped_pids: number[];
}

interface IManagedProcessIdentity {
  pid: number;
  ppid: number;
  command: string;
  cwd: string;
}

export function getRuntimeRegistrationChanges(
  existing: ISharedServiceRow,
  params: IServiceRegistrationParams,
): string[] {
  const changes: string[] = [];
  const nextValues = {
    command: params.command,
    work_dir: params.work_dir ?? null,
    device_id: params.device_id ?? 'any',
    start_script_dir: params.start_script_dir ?? null,
    port: params.port ?? existing.port,
  };
  for (const [field, value] of Object.entries(nextValues)) {
    if (existing[field as keyof ISharedServiceRow] !== value) changes.push(field);
  }
  return changes;
}

export function registeredCommandMatchesRuntime(registered: string, runtime: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
  const expected = normalize(registered).replace(/^exec\s+/, '');
  const actual = normalize(runtime);
  return expected === actual || (actual.includes('/') && expected.endsWith(` ${actual}`));
}

export function isManagedPortOccupant(input: {
  serviceId: string;
  managedPid: number | null;
  occupantPid: number;
  occupantIsDescendant: boolean;
  matchedServiceId: string | null;
}): boolean {
  return input.managedPid === input.occupantPid ||
    input.occupantIsDescendant ||
    input.matchedServiceId === input.serviceId;
}

// ─── 进程管理器 ────────────────────────────────────────────

export class ProcessManager {
  private db: ServiceDB;
  private config: IProcessManagerConfig;
  private localDeviceId: string;
  /** 内存中跟踪的子进程引用 */
  private childProcesses = new Map<string, ChildProcess>();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Skip overlapping health-check ticks (interval can fire while startService awaits 60s scripts). */
  private healthCheckRunning = false;
  /** Per-service start reentrancy guard — prevents AutoOffice-style spawn storms. */
  private startInFlight = new Set<string>();
  /** 防止 excessive_restarts 日志每次健康检查都重复 */
  private excessiveRestartLogged = new Set<string>();
  /** 启动后 grace period，在此期间跳过端口绑定检查 */
  private startupGraceUntil = new Map<string, number>();
  /** 端口检测连续失败计数，避免单次 lsof 抖动误判 */
  private portMissCount = new Map<string, number>();
  /** HTTP 健康检查连续失败计数 */
  private httpMissCount = new Map<string, number>();
  /** 每个服务最近的 stderr 输出（用于死因分析） */
  private stderrBuffers = new Map<string, string>();
  private static readonly STDERR_MAX_CHARS = 4000;
  /** Transient EADDRINUSE retry counter (reset on successful start) */
  private transientRetryCount = new Map<string, number>();
  /** Suppress repeated health_fail logs: service_id → last log timestamp */
  private lastHealthFailLog = new Map<string, number>();
  private static readonly HEALTH_FAIL_DEDUP_MS = 10 * 60_000;

  constructor(db: ServiceDB, config: IProcessManagerConfig) {
    this.db = db;
    this.config = config;
    this.localDeviceId = process.env['SOTAGENT_DEVICE_ID'] || os.hostname().split('.')[0] || os.hostname();
    this.initLocalDevice();
  }

  /** 将本机和已知设备写入 device_config 表 */
  private initLocalDevice(): void {
    const devConf = this.config.devices?.[this.localDeviceId];
    this.db.upsertDevice({
      device_id: this.localDeviceId,
      display_name: devConf?.display_name ?? os.hostname(),
      role: devConf?.role ?? 'dev',
      is_local: true,
      capabilities: devConf?.capabilities ?? [],
    });

    if (this.config.devices) {
      for (const [id, dev] of Object.entries(this.config.devices)) {
        if (id === this.localDeviceId) continue;
        this.db.upsertDevice({
          device_id: id,
          display_name: dev.display_name,
          role: dev.role ?? 'dev',
          is_local: false,
          capabilities: dev.capabilities ?? [],
        });
      }
    }
  }

  /** 判断服务是否应该在本机运行 */
  shouldRunLocally(service: ISharedServiceRow): boolean {
    if (service.device_id === 'any') return true;
    return service.device_id === this.localDeviceId;
  }

  // ─── Start/ 脚本编排 ────────────────────────────────────

  /**
   * Verify port availability with PolarPort before starting a service.
   * Returns an error message if the port is allocated to a different service, null if OK.
   * Non-blocking: 1.5s timeout, graceful degradation on any failure.
   */
  private polarPortUrl(): string {
    return process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';
  }

  /**
   * Allocate a port via PolarPort (sole port authority). Never use local ServiceDB.allocatePort.
   */
  private async claimPortFromPolarPort(params: {
    service_name: string;
    project: string;
    preferred_port?: number | null;
  }): Promise<number | null> {
    try {
      const body: Record<string, unknown> = {
        service_name: params.service_name,
        project: params.project,
      };
      if (params.preferred_port != null && params.preferred_port > 0) {
        body.preferred_port = params.preferred_port;
      }
      const resp = await fetch(`${this.polarPortUrl()}/api/allocate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { ok?: boolean; port?: number };
      return typeof data.port === 'number' ? data.port : null;
    } catch {
      return null;
    }
  }

  private async verifyPortWithPolarPort(svc: ISharedServiceRow): Promise<string | null> {
    try {
      const resp = await fetch(`${this.polarPortUrl()}/api/allocate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_name: svc.id,
          project: this.resolveProject(svc),
          preferred_port: svc.port,
        }),
        signal: AbortSignal.timeout(1500),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ message: 'unknown' })) as { message?: string };
        return `PolarPort 拒绝端口 ${svc.port}: ${errData.message ?? resp.statusText}`;
      }
      const allocData = await resp.json() as { ok?: boolean; port?: number };
      if (allocData.port && allocData.port !== svc.port) {
        console.log(`[ProcessManager] PolarPort 分配了替代端口 ${allocData.port}（原请求 ${svc.port}）for ${svc.name}`);
        this.db.updateServicePort(svc.id, allocData.port);
        svc.port = allocData.port;
      }
      return null;
    } catch {
      // PolarPort unreachable — allow start with existing port (graceful degradation)
      console.warn(`[ProcessManager] PolarPort 不可达, ${svc.name} 使用默认端口 ${svc.port}`);
      return null;
    }
  }

  private resolveProject(svc: ISharedServiceRow): string {
    if (svc.work_dir) {
      const parts = svc.work_dir.replace(/^~\/Polarisor\//, '').split('/');
      return parts[0] || svc.name;
    }
    return svc.name;
  }

  /**
   * Resolve the Start/ script directory for a service.
   * Priority: DB start_script_dir → work_dir/Start/ auto-detection → null (legacy mode).
   */
  private resolveScriptDir(svc: ISharedServiceRow): string | null {
    // Explicit opt-out: use legacy command mode (e.g. digist-engine vs digist-api Start/).
    if (svc.start_script_dir === '-') return null;

    if (svc.start_script_dir) {
      const resolved = svc.start_script_dir.replace(/^~/, os.homedir());
      if (fs.existsSync(path.join(resolved, 'start.sh'))) return resolved;
    }
    if (svc.work_dir) {
      const candidate = path.join(svc.work_dir.replace(/^~/, os.homedir()), 'Start');
      if (fs.existsSync(path.join(candidate, 'start.sh'))) return candidate;
    }
    return null;
  }

  /**
   * Execute a Start/ script and capture output.
   * Returns exit code, stdout, and stderr.
   */
  private execScript(
    scriptPath: string,
    workDir: string,
    timeoutMs = 60_000,
  ): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const resolved = scriptPath.replace(/^~/, os.homedir());
      const resolvedWorkDir = workDir.replace(/^~/, os.homedir());
      const child = spawn('/bin/bash', [resolved], {
        cwd: resolvedWorkDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      }

      child.on('error', (err) => {
        resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + err.message });
      });

      child.on('exit', (code) => {
        const exitCode = code ?? -1;
        resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
      });
    });
  }

  /**
   * Parse pid= and port= from Start/ script stdout.
   */
  private parseScriptOutput(stdout: string): { pid?: number; port?: number } {
    const result: { pid?: number; port?: number } = {};
    const pidMatch = stdout.match(/pid=(\d+)/);
    if (pidMatch) result.pid = parseInt(pidMatch[1]!, 10);
    const portMatch = stdout.match(/port=(\d+)/);
    if (portMatch) result.port = parseInt(portMatch[1]!, 10);
    return result;
  }

  /**
   * Check service status via Start/status.sh.
   * Returns: 'running' (exit 0), 'stopped' (exit 1), 'degraded' (exit 2).
   */
  async checkScriptStatus(serviceId: string): Promise<'running' | 'stopped' | 'degraded' | null> {
    const svc = this.db.getService(serviceId);
    if (!svc) return null;
    const scriptDir = this.resolveScriptDir(svc);
    if (!scriptDir) return null;
    const statusScript = path.join(scriptDir, 'status.sh');
    if (!fs.existsSync(statusScript)) return null;
    const workDir = svc.work_dir ?? scriptDir;
    const result = await this.execScript(statusScript, workDir, 10_000);
    if (result.exitCode === 0) return 'running';
    if (result.exitCode === 2) return 'degraded';
    return 'stopped';
  }

  // ─── 静默重启窗口 ──────────────────────────────────────

  private silentWindowTimer: ReturnType<typeof setInterval> | null = null;

  /** Mark a service for pending restart after code change. */
  notifyCodeChange(serviceId: string): void {
    this.db.markPendingRestart(serviceId);
    const svc = this.db.getService(serviceId);
    if (svc) {
      this.db.logServiceEvent({
        service_id: serviceId,
        service_name: svc.name,
        event_type: 'pending_restart_set',
        detail: 'Code change detected, pending restart window started',
      });
      console.log(`[SilentWindow] ${svc.name}: 标记待重启，静默窗口开始`);
    }
  }

  startSilentWindowLoop(): void {
    if (this.silentWindowTimer) return;
    const windowMs = (this.config.silent_restart_window_sec ?? 7200) * 1000;
    this.silentWindowTimer = setInterval(async () => {
      const pending = this.db.listPendingRestarts();
      for (const svc of pending) {
        if (!this.shouldRunLocally(svc)) continue;
        if (!svc.last_change_at) continue;
        const lastChange = new Date(svc.last_change_at + 'Z').getTime();
        if (Date.now() - lastChange >= windowMs) {
          console.log(`[SilentWindow] ${svc.name}: 静默窗口到期，触发重启`);
          this.db.clearPendingRestart(svc.id);
          this.db.logServiceEvent({
            service_id: svc.id,
            service_name: svc.name,
            event_type: 'silent_restart',
            detail: `Silent window expired (${Math.round(windowMs / 60_000)}min), restarting`,
          });
          await this.restartService(svc.id);
        }
      }
    }, 60_000);
    console.log(`[SilentWindow] 静默重启窗口循环已启动 (窗口=${Math.round(windowMs / 60_000)}min)`);
  }

  stopSilentWindowLoop(): void {
    if (this.silentWindowTimer) {
      clearInterval(this.silentWindowTimer);
      this.silentWindowTimer = null;
    }
  }

  // ─── 自启动 ─────────────────────────────────────────────

  /** 系统启动时调用：启动所有需要自动运行的服务 */
  async autoStartAll(): Promise<string[]> {
    const services = this.db.listAutoStartServices(this.localDeviceId);
    const started: string[] = [];
    const START_TIMEOUT_MS = 45_000;

    for (const svc of services) {
      if (!this.shouldRunLocally(svc)) continue;
      if (svc.status === 'running' && svc.pid && this.isProcessAlive(svc.pid)) continue;

      // Check if service is already running on its port (PID may be stale after restart)
      if (svc.port) {
        const occupant = await this.getPortOccupantAsync(svc.port);
        if (occupant && await this.canAdoptPortOccupant(svc.id, occupant, svc.pid)) {
          this.db.updateServiceStatus(svc.id, 'running', { pid: occupant.pid });
          this.db.updateServiceRestartCount(svc.id, 0);
          started.push(svc.name);
          continue;
        }
      }

      try {
        const result = await Promise.race([
          this.startService(svc.id),
          new Promise<IServiceActionResult>(resolve =>
            setTimeout(
              () => resolve({ ok: false, message: `autoStart timeout after ${START_TIMEOUT_MS}ms` }),
              START_TIMEOUT_MS,
            ),
          ),
        ]);
        if (result.ok) started.push(svc.name);
        else console.warn(`[PolarProcess] autoStart skip/fail ${svc.name}: ${result.message}`);
      } catch (err) {
        console.error(`[PolarProcess] autoStart error ${svc.name}:`, err);
      }

      // 延迟避免同时启动太多进程
      const delay = this.config.process_manager?.auto_start_delay_sec ?? 5;
      await new Promise(r => setTimeout(r, delay * 1000));
    }

    return started;
  }

  // ─── 启动 / 停止 / 重启 ─────────────────────────────────

  registerService(params: IServiceRegistrationParams): IServiceRegistrationResult {
    const existing = this.db.getService(params.id);
    if (existing) {
      const changedFields = getRuntimeRegistrationChanges(existing, params);
      const ownsLiveChild = this.childProcesses.has(params.id);
      const lifecycleActive = existing.status === 'running' || existing.status === 'starting';
      if (changedFields.length > 0 && (lifecycleActive || ownsLiveChild)) {
        return {
          ok: false,
          code: 'SERVICE_RUNNING',
          id: params.id,
          changed_fields: changedFields,
          message: `服务 ${params.id} 正在运行；请先停止服务再修改运行配置: ${changedFields.join(', ')}`,
        };
      }
    }

    this.db.registerService(params);
    return { ok: true, id: params.id, message: `service ${params.name} registered` };
  }

  async startService(serviceId: string): Promise<IServiceActionResult> {
    if (this.startInFlight.has(serviceId)) {
      return { ok: false, message: `服务 ${serviceId} 已在启动中` };
    }
    this.startInFlight.add(serviceId);
    try {
      return await this.startServiceInner(serviceId);
    } finally {
      this.startInFlight.delete(serviceId);
    }
  }

  private async startServiceInner(serviceId: string): Promise<IServiceActionResult> {
    const svc = this.db.getService(serviceId);
    if (!svc) return { ok: false, message: `服务 ${serviceId} 不存在` };

    if (!this.shouldRunLocally(svc)) {
      return this.forwardToRemote(svc.device_id, serviceId, 'start');
    }

    // A queued watchdog retry can observe a stale DB status after autoStart already spawned
    // the service. The live ChildProcess reference is the stronger ownership signal.
    const trackedChild = this.childProcesses.get(serviceId);
    if (trackedChild?.pid && this.isProcessAlive(trackedChild.pid)) {
      if (svc.status !== 'running' || svc.pid !== trackedChild.pid) {
        this.db.updateServiceStatus(serviceId, 'running', { pid: trackedChild.pid });
      }
      return { ok: true, message: '服务已由 PolarProcess 子进程运行', pid: trackedChild.pid };
    }

    // 如果已在运行，直接返回
    if (svc.status === 'running' && svc.pid && this.isProcessAlive(svc.pid)) {
      return { ok: true, message: '服务已在运行', pid: svc.pid };
    }

    // 端口已被占用时：先检查是否是本服务的孤儿进程（上次 SOTAgent 重启后遗留），
    // 若是则直接 adopt，避免触发 EADDRINUSE 再被记为 error。
    if (svc.port) {
      const occupant = await this.getPortOccupantAsync(svc.port);
      if (occupant && await this.canAdoptPortOccupant(svc.id, occupant, svc.pid)) {
        console.log(`[ProcessManager] 采纳孤儿进程 ${svc.name} pid=${occupant.pid} (端口 ${svc.port} 已监听)`);
        this.db.updateServiceStatus(svc.id, 'running', { pid: occupant.pid });
        this.db.updateServiceRestartCount(svc.id, 0);
        this.excessiveRestartLogged.delete(svc.id);
        return { ok: true, message: `已采纳运行中的进程 pid=${occupant.pid}`, pid: occupant.pid };
      }
    }

    if (svc.restart_count > 0) {
      this.db.updateServiceRestartCount(serviceId, 0);
      this.excessiveRestartLogged.delete(serviceId);
    }

    // ─── Script mode: delegate to Start/start.sh ────────
    const scriptDir = this.resolveScriptDir(svc);
    if (scriptDir) {
      // ─── Port conflict pre-check (consult PolarPort) ────
      if (svc.port) {
        const portConflict = await this.verifyPortWithPolarPort(svc);
        if (portConflict) {
          this.db.updateServiceStatus(serviceId, 'error', { last_error: portConflict });
          this.db.logServiceEvent({
            service_id: serviceId, service_name: svc.name,
            event_type: 'port_conflict',
            detail: portConflict,
          });
          return { ok: false, message: portConflict };
        }
      }

      this.db.updateServiceStatus(serviceId, 'starting');
      const startScript = path.join(scriptDir, 'start.sh');
      const workDir = svc.work_dir?.replace(/^~/, os.homedir()) ?? scriptDir;
      console.log(`[ProcessManager] 脚本模式启动: ${svc.name} → ${startScript}`);

      const result = await this.execScript(startScript, workDir);
      if (!result.ok) {
        const msg = `Start script failed (exit=${result.exitCode}): ${result.stderr.slice(-300)}`;
        console.error(`[ProcessManager] ${svc.name}: ${msg}`);
        const nextCount = (svc.restart_count ?? 0) + 1;
        this.db.updateServiceRestartCount(serviceId, nextCount);
        this.db.updateServiceStatus(serviceId, 'error', {
          last_error: msg.slice(0, 500),
          last_exit_code: result.exitCode,
        });
        this.db.logServiceEvent({
          service_id: serviceId, service_name: svc.name,
          event_type: 'script_start',
          detail: `FAILED: ${msg}`.slice(0, 500),
          restart_count: nextCount,
        });
        return { ok: false, message: msg };
      }

      const parsed = this.parseScriptOutput(result.stdout);
      const pid = parsed.pid ?? null;
      const port = parsed.port ?? svc.port;
      this.db.updateServiceStatus(serviceId, 'running', { pid: pid ?? undefined, port: port ?? undefined });
      this.db.logServiceEvent({
        service_id: serviceId, service_name: svc.name,
        event_type: 'script_start',
        detail: `Started via script. pid=${pid}, port=${port}`,
      });

      if (svc.port && port) {
        const startupGraceSec = this.config.process_manager?.startup_grace_sec ?? 30;
        this.startupGraceUntil.set(serviceId, Date.now() + startupGraceSec * 1000);
      }

      return { ok: true, message: `服务 ${svc.name} 已通过脚本启动`, pid: pid ?? undefined };
    }

    // ─── Legacy command mode (fallback) ─────────────────
    // @deprecated: Will be removed after all services adopt Start/ scripts

    // 端口冲突检测：启动前确保端口空闲（可能自动迁移端口）
    if (svc.port) {
      const conflict = await this.ensurePortFree(svc.port, serviceId);
      if (conflict) {
        this.db.updateServiceStatus(serviceId, 'error');
        return conflict;
      }
    }

    // Re-read: ensurePortFree may have changed the port
    const freshSvc = this.db.getService(serviceId) ?? svc;

    this.db.updateServiceStatus(serviceId, 'starting');

    try {
      // Fallback normalization: strip `cd DIR &&` from commands already in DB
      const norm = normalizeCommand(freshSvc.command, freshSvc.work_dir ?? undefined);
      if (norm.command !== freshSvc.command) {
        console.log(`[ProcessManager] 规范化命令: "${freshSvc.command}" → "${norm.command}"${norm.work_dir ? ` (work_dir=${norm.work_dir})` : ''}`);
        freshSvc.command = norm.command;
        if (norm.work_dir && !freshSvc.work_dir) freshSvc.work_dir = norm.work_dir;
        this.db.updateServiceCommand(serviceId, norm.command, norm.work_dir);
      }

      const workDir = freshSvc.work_dir ? freshSvc.work_dir.replace(/^~/, os.homedir()) : undefined;

      if (workDir && !fs.existsSync(workDir)) {
        const msg = `工作目录不存在: ${workDir}`;
        console.error(`[ProcessManager] 服务 ${svc.name} ${msg}`);
        this.db.updateServiceStatus(serviceId, 'error');
        this.db.logServiceEvent({
          service_id: serviceId, service_name: svc.name,
          event_type: 'crashed',
          detail: msg,
          restart_count: svc.restart_count,
        });
        return { ok: false, message: msg };
      }

      const cmdCheck = validateCommand(freshSvc.command);
      if (!cmdCheck.ok) {
        const msg = `命令被安全策略拒绝: ${cmdCheck.reason}`;
        console.error(`[ProcessManager] ⛔ 服务 ${svc.name} ${msg}`);
        this.db.updateServiceStatus(serviceId, 'error');
        return { ok: false, message: msg };
      }

      // Prepend `exec` if the command doesn't already have it.
      // This replaces the shell process with the actual command,
      // ensuring the recorded PID matches the long-lived process.
      // Skip exec prepend if the command starts with env var assignments
      // (e.g. "FOO=bar /bin/cmd") — POSIX `exec VAR=val cmd` is not portable.
      const rawCmd = freshSvc.command;
      const hasEnvPrefix = /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawCmd);
      const execCmd = rawCmd.startsWith('exec ') || hasEnvPrefix ? rawCmd : `exec ${rawCmd}`;

      const child = spawn('/bin/sh', ['-c', execCmd], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, PORT: freshSvc.port?.toString() ?? '' },
      });

      child.unref();

      this.stderrBuffers.delete(serviceId);
      if (child.stderr) {
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk: string) => {
          const buf = (this.stderrBuffers.get(serviceId) ?? '') + chunk;
          this.stderrBuffers.set(
            serviceId,
            buf.length > ProcessManager.STDERR_MAX_CHARS
              ? buf.slice(-ProcessManager.STDERR_MAX_CHARS)
              : buf,
          );
        });
      }

      child.on('error', (err) => {
        console.error(`[ProcessManager] 服务 ${svc.name} spawn 失败: ${err.message}`);
        if (this.childProcesses.get(serviceId) === child) this.childProcesses.delete(serviceId);
        this.db.updateServiceStatus(serviceId, 'error');
        this.db.logServiceEvent({
          service_id: serviceId, service_name: svc.name,
          event_type: 'crashed',
          detail: `spawn error: ${err.message}`,
          restart_count: svc.restart_count,
        });
      });

      if (!child.pid) {
        this.db.updateServiceStatus(serviceId, 'error');
        return { ok: false, message: '进程启动失败：未获取到 PID' };
      }

      this.childProcesses.set(serviceId, child);

      child.on('exit', async (code, signal) => {
        if (this.childProcesses.get(serviceId) === child) this.childProcesses.delete(serviceId);
        const stderr = this.stderrBuffers.get(serviceId) ?? '';
        this.stderrBuffers.delete(serviceId);
        const launchPort = freshSvc.port;
        const diagnosis = await this.diagnoseDeath(serviceId, freshSvc.name, code, signal, stderr, launchPort);

        const startupGraceSec = this.config.process_manager?.startup_grace_sec ?? 30;
        const checkDelay = launchPort ? Math.min(startupGraceSec * 1000, 15_000) : 0;
        setTimeout(async () => {
          const current = this.db.getService(serviceId);
          if (current?.status === 'running') {
            if (current.pid !== child.pid) return;

            if (launchPort) {
              const occupant = await this.getPortOccupantAsync(launchPort);
              if (occupant && await this.canAdoptPortOccupant(serviceId, occupant, child.pid ?? null)) {
                this.db.updateServiceStatus(serviceId, 'running', { pid: occupant.pid });
                return;
              }
            }

            const exitStatus = diagnosis.cause === 'clean_exit' ? 'stopped' : 'error';
            console.log(`[Watchdog] 服务 ${freshSvc.name} 退出 (code=${code}, signal=${signal}) — 死因: ${diagnosis.cause} → ${exitStatus}`);
            if (diagnosis.detail) console.log(`[Watchdog]   ↳ ${diagnosis.detail}`);

            this.db.updateServiceStatus(serviceId, exitStatus as any, {
              last_exit_code: code ?? undefined,
              last_error: diagnosis.detail?.slice(0, 500) ?? null,
            });
            this.db.logServiceEvent({
              service_id: serviceId, service_name: freshSvc.name,
              event_type: exitStatus === 'stopped' ? 'clean_exit' : 'death_diagnosed',
              detail: `cause=${diagnosis.cause}; code=${code}; signal=${signal}; ${diagnosis.detail ?? ''}`.slice(0, 500),
              restart_count: current.restart_count,
            });

            if (diagnosis.cause === 'port_conflict' && diagnosis.thirdPartyOccupant) {
              const resolved = await this.resolveThirdPartyPortConflict(serviceId, current);
              if (resolved) return;
            }

            // Transient port conflict (TIME_WAIT): occupant already gone, just wait and retry
            // without incrementing restart_count — this is not a real crash.
            if (diagnosis.cause === 'port_conflict' && !diagnosis.thirdPartyOccupant && launchPort) {
              const transientRetryKey = `transient_retry_${serviceId}`;
              const retries = this.transientRetryCount.get(transientRetryKey) ?? 0;
              if (retries < 3) {
                this.transientRetryCount.set(transientRetryKey, retries + 1);
                const waitSec = 3 + retries * 2; // 3s, 5s, 7s
                console.log(`[Watchdog] ${freshSvc.name}: transient EADDRINUSE on port ${launchPort}, retry ${retries + 1}/3 in ${waitSec}s`);
                this.db.updateServiceStatus(serviceId, 'starting');
                this.db.logServiceEvent({
                  service_id: serviceId, service_name: freshSvc.name,
                  event_type: 'transient_retry',
                  detail: `EADDRINUSE transient conflict on port ${launchPort}, retry ${retries + 1}/3 after ${waitSec}s`,
                  restart_count: current.restart_count,
                });
                setTimeout(() => this.startService(serviceId), waitSec * 1000);
                return;
              }
              this.transientRetryCount.delete(transientRetryKey);
              console.log(`[Watchdog] ${freshSvc.name}: transient EADDRINUSE exhausted 3 retries — checking for adoptable process`);
              // Final check: if a process is already listening on the port, adopt it
              // instead of spinning into another restart cycle.
              if (launchPort) {
                const finalOccupant = await this.getPortOccupantAsync(launchPort);
                if (finalOccupant) {
                  console.log(`[Watchdog] ${freshSvc.name}: 端口 ${launchPort} 已被 pid=${finalOccupant.pid} 监听，采纳为 running`);
                  this.db.updateServiceStatus(serviceId, 'running', { pid: finalOccupant.pid });
                  this.db.updateServiceRestartCount(serviceId, 0);
                  this.excessiveRestartLogged.delete(serviceId);
                  this.db.logServiceEvent({
                    service_id: serviceId, service_name: freshSvc.name,
                    event_type: 'adopted',
                    detail: `Adopted pid=${finalOccupant.pid} on port ${launchPort} after transient EADDRINUSE exhaustion`,
                  });
                  return;
                }
              }
              console.log(`[Watchdog] ${freshSvc.name}: 端口仍空闲，转入常规重启`);
            }

            if (exitStatus === 'error' && current.restart_on_failure && current.restart_count < current.max_restarts) {
              this.db.updateServiceStatus(serviceId, 'error', {
                restart_count: current.restart_count + 1,
              });
              const cooldown = (this.config.process_manager?.restart_cooldown_sec ?? 10) * 1000;
              setTimeout(() => this.startService(serviceId), cooldown);
            }
          }
        }, checkDelay);
      });

      this.db.updateServiceStatus(serviceId, 'running', { pid: child.pid });
      this.transientRetryCount.delete(`transient_retry_${serviceId}`);

      // 启动后端口验证：确保进程绑定了正确的端口
      // 给服务 30 秒的启动 grace period（Python/Node 可能需要较长时间加载模块）
      if (freshSvc.port) {
        const expectedPort = freshSvc.port;
        const expectedPid = child.pid;
        const startupGraceSec = this.config.process_manager?.startup_grace_sec ?? 30;
        this.startupGraceUntil.set(serviceId, Date.now() + startupGraceSec * 1000);
        setTimeout(async () => {
          this.startupGraceUntil.delete(serviceId);
          await this.verifyPortBinding(serviceId, svc.name, expectedPort, expectedPid);
        }, startupGraceSec * 1000);
      }

      const portNote = freshSvc.port !== svc.port ? ` (端口已迁移: ${svc.port}→${freshSvc.port})` : '';
      return { ok: true, message: `服务 ${freshSvc.name} 已启动${portNote}`, pid: child.pid };
    } catch (err) {
      this.db.updateServiceStatus(serviceId, 'error');
      return { ok: false, message: `启动失败: ${err}` };
    }
  }

  /**
   * 判断 candidate 是否为 ancestor 的后代进程（沿 ppid 链向上走，最多 6 层）。
   * npm run → npm → tsx wrapper → node 实际监听者可以有 2-3 层间隔。
   */
  private async isDescendantOf(candidatePid: number, ancestorPid: number): Promise<boolean> {
    let current = candidatePid;
    for (let depth = 0; depth < 6; depth++) {
      try {
        const { stdout } = await execAsync(`ps -p ${current} -o ppid= 2>/dev/null`, { timeout: 3000 });
        const ppid = parseInt(stdout.trim(), 10);
        if (!Number.isFinite(ppid) || ppid <= 1) return false;
        if (ppid === ancestorPid) return true;
        current = ppid;
      } catch {
        return false;
      }
    }
    return false;
  }

  private async canAdoptPortOccupant(
    serviceId: string,
    occupant: { pid: number; command: string },
    managedPid: number | null,
  ): Promise<boolean> {
    const occupantIsDescendant = managedPid != null &&
      await this.isDescendantOf(occupant.pid, managedPid);
    const matchedServiceId = this.isOwnService(occupant)?.serviceId ?? null;
    return isManagedPortOccupant({
      serviceId,
      managedPid,
      occupantPid: occupant.pid,
      occupantIsDescendant,
      matchedServiceId,
    });
  }

  /**
   * 启动后验证：检查注册端口是否被正确的 PID 占用。
   * 防止服务静默切换到其他端口（如 Vite 无 --strictPort）。
   * 增加重试机制：最多重试 12 次，每次等待 5 秒（共 60 秒）。
   */
  private async verifyPortBinding(serviceId: string, serviceName: string, port: number, pid: number): Promise<void> {
    const PORT_BIND_WAIT_MS = 5000; // 每次等待 5 秒
    const PORT_BIND_RETRIES = 12;   // 最多重试 12 次（共 60 秒）

    for (let retry = 0; retry < PORT_BIND_RETRIES; retry++) {
      const occupant = await this.getPortOccupantAsync(port);
      if (occupant) {
        // 端口有监听者
        if (occupant.pid === pid) {
          return; // exact match
        }

        if (await this.canAdoptPortOccupant(serviceId, occupant, pid)) {
          console.log(`[PortVerify] ${serviceName}: PID 校正 ${pid} → ${occupant.pid} (后代进程替代 shell wrapper)`);
          this.db.updateServiceStatus(serviceId, 'running', { pid: occupant.pid });
          this.db.logServiceEvent({
            service_id: serviceId, service_name: serviceName,
            event_type: 'pid_updated',
            detail: `PID corrected: wrapper ${pid} → descendant listener ${occupant.pid}`,
          });
          return;
        }

        // Port bound by different process
        console.error(`[PortVerify] ❌ ${serviceName}: 端口 ${port} 被 pid=${occupant.pid} 占用，不是期望的 pid=${pid}`);
        this.db.logServiceEvent({
          service_id: serviceId, service_name: serviceName,
          event_type: 'health_fail',
          detail: `Port ${port} bound by pid=${occupant.pid} (expected ${pid}). Possible port drift.`,
        });
        return;
      }

      // No occupant yet - check if process is still alive
      if (!this.isProcessAlive(pid)) {
        return; // shell already exited, Watchdog handles
      }

      // Wait and retry
      if (retry < PORT_BIND_RETRIES - 1) {
        console.log(`[PortVerify] ${serviceName}: 端口 ${port} 尚无监听者，等待 ${PORT_BIND_WAIT_MS / 1000}s 后重试 (${retry + 1}/${PORT_BIND_RETRIES})`);
        await new Promise(r => setTimeout(r, PORT_BIND_WAIT_MS));
      }
    }

    // All retries exhausted
    const graceSec = this.config.process_manager?.startup_grace_sec ?? 30;
    console.error(`[PortVerify] ⚠️ ${serviceName}: 端口 ${port} 启动 ${PORT_BIND_RETRIES * PORT_BIND_WAIT_MS / 1000}s 后无进程监听，可能启动失败或绑到了其他端口`);
    this.db.logServiceEvent({
      service_id: serviceId, service_name: serviceName,
      event_type: 'health_fail',
      detail: `Port ${port} not bound after ${PORT_BIND_RETRIES * PORT_BIND_WAIT_MS / 1000}s. Process ${pid} may have used a different port.`,
    });
  }

  private async readManagedProcessIdentity(pid: number): Promise<IManagedProcessIdentity | null> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || !this.isProcessAlive(pid)) return null;
    try {
      const { stdout } = await execFileAsync(
        'ps',
        ['-p', String(pid), '-o', 'ppid=', '-o', 'command='],
        { timeout: 3000, maxBuffer: 64 * 1024 },
      );
      const match = stdout.match(/^\s*(\d+)\s+(.+?)\s*$/s);
      if (!match) return null;

      let cwd = '';
      if (process.platform === 'linux') {
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      } else {
        const result = await execFileAsync(
          'lsof',
          ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          { timeout: 3000, maxBuffer: 64 * 1024 },
        );
        cwd = result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? '';
      }
      if (!cwd) return null;
      return { pid, ppid: Number(match[1]), command: match[2]!.trim(), cwd };
    } catch {
      return null;
    }
  }

  private canonicalPath(value: string): string {
    const resolved = value.replace(/^~/, os.homedir());
    try { return fs.realpathSync(resolved); } catch { return path.resolve(resolved); }
  }

  async reconcileServiceChildren(
    serviceId: string,
    stalePids: number[],
  ): Promise<IServiceReconcileResult> {
    const emptyResult = { service_id: serviceId, reaped_pids: [] as number[] };
    const svc = this.db.getService(serviceId);
    if (!svc) return { ok: false, message: `服务 ${serviceId} 不存在`, ...emptyResult };
    if (!this.shouldRunLocally(svc)) {
      return { ok: false, message: `服务 ${serviceId} 不属于本机`, ...emptyResult };
    }
    if (svc.status !== 'running' || !svc.pid || !this.isProcessAlive(svc.pid)) {
      return { ok: false, message: `服务 ${serviceId} 没有可验证的当前运行 PID`, ...emptyResult };
    }
    if (!Array.isArray(stalePids) || stalePids.length === 0) {
      return { ok: false, message: 'stale_pids must contain at least one PID', ...emptyResult };
    }

    const uniquePids = [...new Set(stalePids)];
    if (uniquePids.some(pid => !Number.isSafeInteger(pid) || pid <= 1 || pid === svc.pid)) {
      return { ok: false, message: 'stale_pids contains an invalid or current service PID', ...emptyResult };
    }

    const current = await this.readManagedProcessIdentity(svc.pid);
    if (!current || !registeredCommandMatchesRuntime(svc.command, current.command)) {
      return { ok: false, message: `当前 PID ${svc.pid} 与注册命令不匹配`, ...emptyResult };
    }
    const registeredCwd = this.canonicalPath(svc.work_dir ?? current.cwd);
    if (this.canonicalPath(current.cwd) !== registeredCwd) {
      return { ok: false, message: `当前 PID ${svc.pid} 的工作目录与注册记录不匹配`, ...emptyResult };
    }

    const registeredPids = new Set(
      this.db.listServices().filter(row => row.pid != null).map(row => row.pid as number),
    );
    const candidates: IManagedProcessIdentity[] = [];
    for (const pid of uniquePids) {
      if (registeredPids.has(pid)) {
        return { ok: false, message: `PID ${pid} 仍属于一个已注册服务`, ...emptyResult };
      }
      const candidate = await this.readManagedProcessIdentity(pid);
      if (!candidate) return { ok: false, message: `无法读取候选 PID ${pid}`, ...emptyResult };

      const sameCommand = candidate.command === current.command;
      const candidateCwd = this.canonicalPath(candidate.cwd);
      const sameRuntimeScope = candidateCwd === registeredCwd ||
        path.dirname(candidateCwd) === path.dirname(registeredCwd);
      const authorityOwned = candidate.ppid === process.pid || candidate.ppid === current.ppid;
      if (!sameCommand || !sameRuntimeScope || !authorityOwned) {
        return {
          ok: false,
          message: `PID ${pid} 未通过命令、工作目录和 PolarProcess 所有权校验`,
          ...emptyResult,
        };
      }
      candidates.push(candidate);
    }

    for (const candidate of candidates) {
      // Duplicate supervisors share cleanup state with the current instance. SIGKILL avoids
      // running an obsolete EXIT trap that would stop the live container stack.
      process.kill(candidate.pid, 'SIGKILL');
      for (let attempt = 0; attempt < 20 && this.isProcessAlive(candidate.pid); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (this.isProcessAlive(candidate.pid)) {
        return {
          ok: false,
          message: `PID ${candidate.pid} did not exit after reconciliation`,
          kept_pid: svc.pid,
          reaped_pids: candidates
            .filter(item => !this.isProcessAlive(item.pid))
            .map(item => item.pid),
          service_id: serviceId,
        };
      }
      this.db.logServiceEvent({
        service_id: serviceId,
        service_name: svc.name,
        event_type: 'orphan_killed',
        detail: `Reaped stale PolarProcess child pid=${candidate.pid}; kept pid=${svc.pid}`,
      });
    }

    return {
      ok: true,
      message: `已收敛 ${candidates.length} 个重复子进程`,
      service_id: serviceId,
      kept_pid: svc.pid,
      reaped_pids: candidates.map(candidate => candidate.pid),
    };
  }

  async stopService(serviceId: string): Promise<IServiceActionResult> {
    const svc = this.db.getService(serviceId);
    if (!svc) return { ok: false, message: `服务 ${serviceId} 不存在` };

    if (!this.shouldRunLocally(svc)) {
      return this.forwardToRemote(svc.device_id, serviceId, 'stop');
    }

    // ─── Script mode: delegate to Start/stop.sh ─────────
    const scriptDir = this.resolveScriptDir(svc);
    if (scriptDir) {
      const stopScript = path.join(scriptDir, 'stop.sh');
      if (fs.existsSync(stopScript)) {
        const workDir = svc.work_dir?.replace(/^~/, os.homedir()) ?? scriptDir;
        console.log(`[ProcessManager] 脚本模式停止: ${svc.name} → ${stopScript}`);
        const result = await this.execScript(stopScript, workDir, 30_000);
        this.childProcesses.delete(serviceId);
        this.db.updateServiceStatus(serviceId, 'stopped');
        this.db.logServiceEvent({
          service_id: serviceId, service_name: svc.name,
          event_type: 'script_stop',
          detail: `Stopped via script. exit=${result.exitCode}`,
        });
        if (!result.ok) {
          console.warn(`[ProcessManager] ${svc.name}: stop script exit=${result.exitCode}, stderr: ${result.stderr.slice(-200)}`);
        }
        return { ok: true, message: `服务 ${svc.name} 已通过脚本停止` };
      }
    }

    // ─── Legacy command mode (fallback) ─────────────────
    const STOP_TIMEOUT_MS = 10_000;
    const targetPid = svc.pid;

    const child = this.childProcesses.get(serviceId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
      const exited = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!exited && targetPid && this.isProcessAlive(targetPid)) {
        try { process.kill(targetPid, 'SIGKILL'); } catch { /* already dead */ }
        await new Promise(r => setTimeout(r, 500));
      }
      this.childProcesses.delete(serviceId);
    } else if (targetPid && this.isProcessAlive(targetPid)) {
      try {
        process.kill(targetPid, 'SIGTERM');
        await new Promise(r => setTimeout(r, STOP_TIMEOUT_MS));
        if (this.isProcessAlive(targetPid)) process.kill(targetPid, 'SIGKILL');
        await new Promise(r => setTimeout(r, 500));
      } catch { /* 进程已退出 */ }
    }

    this.db.updateServiceStatus(serviceId, 'stopped');
    return { ok: true, message: `服务 ${svc.name} 已停止` };
  }

  async restartService(serviceId: string): Promise<IServiceActionResult> {
    const svc = this.db.getService(serviceId);

    // Script mode: prefer restart.sh if available, else stop+start
    if (svc) {
      const scriptDir = this.resolveScriptDir(svc);
      if (scriptDir) {
        const restartScript = path.join(scriptDir, 'restart.sh');
        if (fs.existsSync(restartScript)) {
          const workDir = svc.work_dir?.replace(/^~/, os.homedir()) ?? scriptDir;
          console.log(`[ProcessManager] 脚本模式重启: ${svc.name} → ${restartScript}`);
          const result = await this.execScript(restartScript, workDir, 90_000);
          if (result.ok) {
            const parsed = this.parseScriptOutput(result.stdout);
            this.db.updateServiceStatus(serviceId, 'running', {
              pid: parsed.pid ?? undefined,
              port: parsed.port ?? undefined,
            });
            return { ok: true, message: `服务 ${svc.name} 已通过脚本重启`, pid: parsed.pid };
          }
        }
        // Fallthrough: no restart.sh or it failed → stop+start
      }
    }

    await this.stopService(serviceId);

    if (svc?.port) {
      const maxWait = 15;
      for (let i = 0; i < maxWait; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const occupant = await this.getPortOccupantAsync(svc.port);
        if (!occupant) break;
        if (i === maxWait - 1) {
          console.warn(`[ProcessManager] 端口 ${svc.port} 等待 ${maxWait}s 仍被占用 (pid=${occupant.pid})，强制继续`);
        }
      }
    } else {
      await new Promise(r => setTimeout(r, 2000));
    }

    return this.startService(serviceId);
  }

  // ─── 健康检查 ───────────────────────────────────────────

  /** 启动定时健康检查循环 */
  startHealthCheckLoop(): void {
    const interval = (this.config.process_manager?.health_check_interval_sec ?? 30) * 1000;
    this.healthCheckTimer = setInterval(() => this.runHealthChecks(), interval);
    // 首次立即执行
    setTimeout(() => this.runHealthChecks(), 5000);
  }

  stopHealthCheckLoop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    if (this.healthCheckRunning) {
      console.warn('[Watchdog] previous health-check still running — skip overlapping tick');
      return;
    }
    this.healthCheckRunning = true;
    try {
      await this.runHealthChecksInner();
    } finally {
      this.healthCheckRunning = false;
    }
  }

  private async runHealthChecksInner(): Promise<void> {
    this.healthCheckCount++;
    if (this.healthCheckCount % ProcessManager.ORPHAN_SCAN_INTERVAL === 0) {
      await this.scanOrphanProcesses();
      await this.cleanGhostPorts();
    }

    const services = this.db.listServices(this.localDeviceId);

    for (const svc of services) {
      await new Promise(r => setTimeout(r, 50));
      if (!this.shouldRunLocally(svc)) continue;

      // ─── 稳定运行恢复配额（15 分钟）────────────────────
      // 服务连续运行 15 分钟后自动清零 restart_count，视为已证明可靠。
      // 这替代了原有的慢衰减（running 30min/-1，error 120min/-1）。
      this.checkStableUptimeRecovery(svc);

      // ─── restart_count 时间衰减（旧的慢衰减，保留作兜底）────────
      // Running services: decay every 30 minutes (fast recovery).
      // Error services: decay every 2 hours (prevents permanent lockout
      // while still avoiding infinite rapid crash loops).
      if (svc.restart_count > 0 && (svc.status === 'running' || svc.status === 'error')) {
        const rcUpdatedAt = svc.restart_count_updated_at
          ? new Date(svc.restart_count_updated_at + 'Z').getTime()
          : (svc.last_health_check ? new Date(svc.last_health_check + 'Z').getTime() : 0);
        const baseDecayMin = this.config.process_manager?.restart_decay_min ?? 30;
        const decayInterval = svc.status === 'error'
          ? Math.max(baseDecayMin, 120) * 60_000
          : baseDecayMin * 60_000;
        if (rcUpdatedAt > 0 && Date.now() - rcUpdatedAt > decayInterval) {
          const newCount = Math.max(0, svc.restart_count - 1);
          this.db.updateServiceRestartCount(svc.id, newCount);
          svc.restart_count = newCount;
          if (newCount === 0) {
            this.db.logServiceEvent({
              service_id: svc.id, service_name: svc.name,
              event_type: 'decay_reset',
              detail: `restart_count decayed to 0 (status=${svc.status})`,
            });
            this.excessiveRestartLogged.delete(svc.id);
          }
        }
      }

      // ─── Watchdog：auto_start 服务未运行时自动拉起 ─────
      // 快速死亡（5 分钟内 crash）计数严格；长期运行后死亡继续拉起
      if (svc.auto_start && (svc.status === 'stopped' || svc.status === 'error')) {
        let alive = svc.pid ? this.isProcessAlive(svc.pid) : false;

        // Shell wrapper may exit while actual service (child process) keeps running.
        // If port has a listener, adopt that PID and treat as alive.
        // Also handles orphan processes from a previous SOTAgent instance.
        if (!alive && svc.port) {
          const occupant = await this.getPortOccupantAsync(svc.port);
          if (occupant && await this.canAdoptPortOccupant(svc.id, occupant, svc.pid)) {
            this.db.updateServiceStatus(svc.id, 'running', { pid: occupant.pid });
            this.db.updateServiceRestartCount(svc.id, 0);
            this.excessiveRestartLogged.delete(svc.id);
            console.log(`[Watchdog] 自动采纳端口 ${svc.port} 上的进程 pid=${occupant.pid} 作为 ${svc.name}`);
            alive = true;
          }
        }

        // Port-less services: check if the last known pid is still alive
        if (!alive && !svc.port && svc.pid && this.isProcessAlive(svc.pid)) {
          this.db.updateServiceStatus(svc.id, 'running', { pid: svc.pid });
          this.db.updateServiceRestartCount(svc.id, 0);
          this.excessiveRestartLogged.delete(svc.id);
          alive = true;
        }

        // Process is alive but status was error/stopped — recover to running
        if (alive && svc.status === 'error') {
          this.db.updateServiceStatus(svc.id, 'running', { pid: svc.pid! });
          this.db.updateServiceRestartCount(svc.id, 0);
          this.excessiveRestartLogged.delete(svc.id);
          continue;
        }

        if (!alive) {
          const FAST_DEATH_MS = 5 * 60_000;
          const uptime = svc.started_at
            ? Date.now() - new Date(svc.started_at + 'Z').getTime()
            : 0;
          const wasFastDeath = uptime < FAST_DEATH_MS;

          if (wasFastDeath && svc.restart_count >= svc.max_restarts) {
            // Before giving up, check if it's a port conflict we can fix
            if (svc.port) {
              const occupant = await this.getPortOccupantAsync(svc.port);
              if (occupant && !this.isOwnService(occupant)) {
                console.log(`[Watchdog] 服务 ${svc.name} 达到重启上限，但检测到端口 ${svc.port} 被第三方占用 (pid=${occupant.pid})，尝试迁移`);
                const resolved = await this.resolveThirdPartyPortConflict(svc.id, svc);
                if (resolved) {
                  this.db.updateServiceRestartCount(svc.id, 0);
                  this.excessiveRestartLogged.delete(svc.id);
                  continue;
                }
              }
            }
            if (!this.excessiveRestartLogged.has(svc.id)) {
              console.log(`[Watchdog] 服务 ${svc.name} 快速死亡次数达上限 (${svc.restart_count}/${svc.max_restarts})，停止重启`);
              if (svc.last_error) console.log(`[Watchdog]   ↳ 最后错误: ${svc.last_error}`);
              this.db.logServiceEvent({
                service_id: svc.id, service_name: svc.name,
                event_type: 'excessive_restarts',
                detail: `Fast death limit reached. restart_count=${svc.restart_count}/${svc.max_restarts}. last_error=${svc.last_error ?? 'none'}`,
                restart_count: svc.restart_count,
              });
              this.excessiveRestartLogged.add(svc.id);
            }
            continue;
          }

          // Mark as 'starting' immediately to prevent duplicate triggers on next health check
          this.db.updateServiceStatus(svc.id, 'starting');

          if (wasFastDeath) {
            this.db.updateServiceRestartCount(svc.id, svc.restart_count + 1);
            const backoffSec = Math.min(300, (this.config.process_manager?.restart_cooldown_sec ?? 15) * Math.pow(2, svc.restart_count));
            console.log(`[Watchdog] 服务 ${svc.name} 快速死亡 (uptime=${Math.round(uptime / 1000)}s)，${backoffSec}s 后重启 (${svc.restart_count + 1}/${svc.max_restarts})`);
            this.db.logServiceEvent({
              service_id: svc.id, service_name: svc.name,
              event_type: 'watchdog_restart',
              detail: `Fast death restart: uptime=${Math.round(uptime / 1000)}s, backoff=${backoffSec}s`,
              restart_count: svc.restart_count + 1,
            });
            setTimeout(() => this.startService(svc.id), backoffSec * 1000);
          } else {
            const lastLog = this.lastHealthFailLog.get(svc.id) ?? 0;
            const shouldLog = Date.now() - lastLog > ProcessManager.HEALTH_FAIL_DEDUP_MS;
            if (shouldLog) {
              console.log(`[Watchdog] 服务 ${svc.name} 长期运行后崩溃 (uptime=${Math.round(uptime / 60000)}min)，重启中`);
              this.db.logServiceEvent({
                service_id: svc.id, service_name: svc.name,
                event_type: 'health_fail',
                detail: `Long-running crash: uptime=${Math.round(uptime / 60000)}min. Auto-restarting.`,
                restart_count: svc.restart_count,
              });
              this.lastHealthFailLog.set(svc.id, Date.now());
            }
            this.excessiveRestartLogged.delete(svc.id);
            const cooldown = (this.config.process_manager?.restart_cooldown_sec ?? 15) * 1000;
            setTimeout(() => this.startService(svc.id), cooldown);
          }
          continue;
        }
      }

      if (svc.status !== 'running') continue;

      // ─── 原有逻辑：running 但进程已死 ──────────────────
      let aliveRunning = svc.pid ? this.isProcessAlive(svc.pid) : false;

      // Shell wrapper may exit; check port for actual service process
      if (!aliveRunning && svc.port) {
        const occupant = await this.getPortOccupantAsync(svc.port);
        if (occupant && await this.canAdoptPortOccupant(svc.id, occupant, svc.pid)) {
          this.db.updateServiceStatus(svc.id, 'running', { pid: occupant.pid });
          aliveRunning = true;
        }
      }

      // During startup grace period, shell wrapper may have exited while the
      // actual service (python/node) hasn't bound the port yet. Skip crash detection.
      if (!aliveRunning && svc.port) {
        const graceEnd = this.startupGraceUntil.get(svc.id);
        if (graceEnd && Date.now() < graceEnd) {
          continue;
        }
      }

      if (!aliveRunning) {
        console.log(`[ProcessManager] 服务 ${svc.name} (pid=${svc.pid}) 已不存在`);
        this.db.logServiceEvent({
          service_id: svc.id, service_name: svc.name,
          event_type: 'crashed',
          detail: `Process pid=${svc.pid} not found`,
          restart_count: svc.restart_count,
        });
        if (svc.restart_on_failure && svc.restart_count < svc.max_restarts) {
          this.db.updateServiceStatus(svc.id, 'starting', {
            restart_count: svc.restart_count + 1,
          });
          const cooldown = (this.config.process_manager?.restart_cooldown_sec ?? 10) * 1000;
          setTimeout(() => this.startService(svc.id), cooldown);
        } else {
          this.db.updateServiceStatus(svc.id, 'error');
        }
        continue;
      }

      // Port binding check: only mark error after consecutive failures (lsof can be flaky)
      // Skip during startup grace period to allow slow services to bind
      if (svc.port) {
        const graceEnd = this.startupGraceUntil.get(svc.id);
        if (graceEnd && Date.now() < graceEnd) {
          continue;
        }

        const occupant = await this.getPortOccupantAsync(svc.port);
        if (!occupant) {
          const key = `port_miss_${svc.id}`;
          const count = (this.portMissCount.get(key) ?? 0) + 1;
          this.portMissCount.set(key, count);
          if (count >= 3) {
            this.db.updateServiceStatus(svc.id, 'error');
            const lastLog = this.lastHealthFailLog.get(svc.id) ?? 0;
            if (Date.now() - lastLog > ProcessManager.HEALTH_FAIL_DEDUP_MS) {
              console.error(`[Watchdog] ⚠️ ${svc.name} 标记为 running 但端口 ${svc.port} 连续 ${count} 次无进程监听`);
              this.db.logServiceEvent({
                service_id: svc.id, service_name: svc.name,
                event_type: 'health_fail',
                detail: `Port ${svc.port} not bound ${count}x while status=running.`,
              });
              this.lastHealthFailLog.set(svc.id, Date.now());
            }
            this.portMissCount.delete(key);
          }
          continue;
        } else {
          this.portMissCount.delete(`port_miss_${svc.id}`);
          if (occupant.pid !== svc.pid && await this.canAdoptPortOccupant(svc.id, occupant, svc.pid)) {
            console.log(`[Watchdog] ${svc.name}: PID 变更 ${svc.pid} → ${occupant.pid} (端口 ${svc.port} 监听者更新)`);
            this.db.updateServiceStatus(svc.id, 'running', { pid: occupant.pid });
            this.db.logServiceEvent({
              service_id: svc.id, service_name: svc.name,
              event_type: 'pid_updated',
              detail: `PID changed: ${svc.pid} → ${occupant.pid} via port ${svc.port} occupant check`,
            });
          }
        }
      }

      // HTTP 健康检查（可选）— 连续 3 次失败则重启
      if (svc.health_check_url) {
        const healthy = await this.httpHealthCheck(svc.health_check_url);
        const httpKey = `http_miss_${svc.id}`;
        if (healthy) {
          this.db.updateServiceHealthCheck(svc.id);
          this.httpMissCount.delete(httpKey);
        } else {
          const count = (this.httpMissCount.get(httpKey) ?? 0) + 1;
          this.httpMissCount.set(httpKey, count);
          console.log(`[Watchdog] ${svc.name} HTTP 探活失败 (${count}/3): ${svc.health_check_url}`);
          if (count >= 3 && svc.auto_start && svc.restart_count < svc.max_restarts) {
            console.error(`[Watchdog] ⚠️ ${svc.name} HTTP 连续 ${count} 次无响应，触发重启`);
            this.db.logServiceEvent({
              service_id: svc.id, service_name: svc.name,
              event_type: 'health_fail',
              detail: `HTTP health check failed ${count}x. Restarting.`,
              restart_count: svc.restart_count + 1,
            });
            this.httpMissCount.delete(httpKey);
            this.db.updateServiceStatus(svc.id, 'starting', {
              restart_count: svc.restart_count + 1,
            });
            const cooldown = (this.config.process_manager?.restart_cooldown_sec ?? 10) * 1000;
            setTimeout(() => this.restartService(svc.id), cooldown);
          }
        }
      } else {
        this.db.updateServiceHealthCheck(svc.id);
      }
    }
  }

  private httpHealthCheck(url: string): Promise<boolean> {
    return new Promise(resolve => {
      const req = http.get(url, { timeout: 5000 }, (res) => {
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // ─── Cron 定时任务 ────────────────────────────────────────

  private cronTimer: ReturnType<typeof setInterval> | null = null;

  /** 启动 cron 调度循环（每分钟检查一次） */
  startCronLoop(): void {
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(() => {
      this.runCronCheck();
      this.cronTimer = setInterval(() => this.runCronCheck(), 60_000);
    }, msUntilNextMinute);
    console.log(`[ProcessManager] Cron 调度器已启动，${Math.round(msUntilNextMinute / 1000)}s 后首次检查`);
  }

  stopCronLoop(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
  }

  private async runCronCheck(): Promise<void> {
    const services = this.db.listCronServices(this.localDeviceId);
    const now = new Date();

    for (const svc of services) {
      if (!this.shouldRunLocally(svc)) continue;
      if (!svc.cron_schedule) continue;

      if (this.cronMatches(svc.cron_schedule, now)) {
        if (svc.status === 'running' && svc.pid && this.isProcessAlive(svc.pid)) {
          continue;
        }
        console.log(`[ProcessManager] Cron 触发: ${svc.name} (${svc.cron_schedule})`);

        if (svc.port) {
          const conflict = await this.ensurePortFree(svc.port, svc.id);
          if (conflict) {
            console.error(`[ProcessManager] Cron 任务 ${svc.name} 端口冲突，跳过: ${conflict.message}`);
            this.db.updateServiceStatus(svc.id, 'error');
            continue;
          }
        }

        const cronNorm = normalizeCommand(svc.command, svc.work_dir ?? undefined);
        if (cronNorm.command !== svc.command) {
          svc.command = cronNorm.command;
          if (cronNorm.work_dir && !svc.work_dir) svc.work_dir = cronNorm.work_dir;
          this.db.updateServiceCommand(svc.id, cronNorm.command, cronNorm.work_dir);
        }
        const workDir = svc.work_dir ? svc.work_dir.replace(/^~/, os.homedir()) : undefined;
        const cronCmdCheck = validateCommand(svc.command);
        if (!cronCmdCheck.ok) {
          console.error(`[ProcessManager] ⛔ Cron 任务 ${svc.name} 命令被拒绝: ${cronCmdCheck.reason}`);
          continue;
        }
        try {
          const child = spawn('/bin/sh', ['-c', svc.command], {
            cwd: workDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
            env: { ...process.env, PORT: svc.port?.toString() ?? '' },
          });
          child.unref();
          child.on('error', (err) => {
            console.error(`[ProcessManager] Cron 任务 ${svc.name} spawn 失败: ${err.message}`);
          });
          if (child.pid) {
            this.db.updateServiceStatus(svc.id, 'running', { pid: child.pid });
            child.on('exit', (code) => {
              console.log(`[ProcessManager] Cron 任务 ${svc.name} 完成 (code=${code})`);
              this.db.updateServiceStatus(svc.id, 'stopped');
            });
          }
        } catch (err) {
          console.error(`[ProcessManager] Cron 任务 ${svc.name} 启动失败:`, err);
        }
      }
    }
  }

  private cronMatches(schedule: string, date: Date): boolean {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length < 5) return false;

    const fields = [
      date.getMinutes(),
      date.getHours(),
      date.getDate(),
      date.getMonth() + 1,
      date.getDay(),
    ];

    for (let i = 0; i < 5; i++) {
      if (parts[i] === '*') continue;
      const allowed = parts[i]!.split(',').map(Number);
      if (!allowed.includes(fields[i]!)) return false;
    }
    return true;
  }


  /** 将请求转发到远程设备的 SOTAgent 实例 */
  private async forwardToRemote(
    deviceId: string,
    serviceId: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<IServiceActionResult> {
    const ip = getPeerTailscaleIP(deviceId);
    if (!ip) {
      return { ok: false, message: `无法获取设备 ${deviceId} 的 Tailscale 地址` };
    }

    const device = this.db.getDevice(deviceId);
    const displayName = device?.display_name ?? deviceId;

    try {
      const resp = await fetch(
        `http://${ip}:${SOTAGENT_API_PORT}/api/services/${serviceId}/${action}`,
        { method: 'POST', signal: AbortSignal.timeout(10000) },
      );
      const data = await resp.json() as IServiceActionResult;
      return data;
    } catch (err) {
      return { ok: false, message: `转发到 ${displayName} 失败: ${err}` };
    }
  }

  // ─── 端口冲突检测与清理 ──────────────────────────────────

  /**
   * 检查端口是否被占用，返回占用进程的信息。
   * 如果端口空闲返回 null。
   */
  // launchd's PATH may omit /usr/sbin, so always use the absolute lsof path.
  private static readonly LSOF = '/usr/sbin/lsof';

  private getPortOccupant(port: number): { pid: number; command: string } | null {
    try {
      const out = execSync(
        `${ProcessManager.LSOF} -iTCP:${port} -sTCP:LISTEN -P -n -t 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (!out) return null;
      const pid = parseInt(out.split('\n')[0] ?? '', 10);
      if (isNaN(pid)) return null;
      const cmd = execSync(`ps -p ${pid} -o command= 2>/dev/null || true`, {
        encoding: 'utf-8', timeout: 3000,
      }).trim();
      return { pid, command: cmd };
    } catch {
      return null;
    }
  }

  private async getPortOccupantAsync(port: number): Promise<{ pid: number; command: string } | null> {
    try {
      const { stdout } = await execAsync(
        `${ProcessManager.LSOF} -iTCP:${port} -sTCP:LISTEN -P -n -t 2>/dev/null || true`,
        { timeout: 5000 },
      );
      const out = stdout.trim();
      if (!out) return null;
      const pid = parseInt(out.split('\n')[0] ?? '', 10);
      if (isNaN(pid)) return null;
      const { stdout: cmdOut } = await execAsync(
        `ps -p ${pid} -o command= 2>/dev/null || true`,
        { timeout: 3000 },
      );
      return { pid, command: cmdOut.trim() };
    } catch {
      return null;
    }
  }

  /**
   * 判断占用端口的进程是否属于本系统管理的服务（残留进程）。
   * 匹配规则：pid 等于某个注册服务的 pid，或 command 包含服务的 work_dir/command 关键词。
   */
  private isOwnService(occupant: { pid: number; command: string }): { serviceId: string; serviceName: string } | null {
    const services = this.db.listServices();
    for (const svc of services) {
      if (svc.pid === occupant.pid) {
        return { serviceId: svc.id, serviceName: svc.name };
      }
      // Match by work_dir path
      const workDir = svc.work_dir?.replace(/^~/, os.homedir());
      if (workDir && occupant.command.includes(workDir)) {
        return { serviceId: svc.id, serviceName: svc.name };
      }
      // Match by command tail (last path segment of executable or script)
      if (svc.command) {
        const cmdTail = svc.command.replace(/^.*\s/, '').slice(0, 50);
        if (cmdTail.length > 8 && occupant.command.includes(cmdTail)) {
          return { serviceId: svc.id, serviceName: svc.name };
        }
      }
    }
    return null;
  }

  /**
   * 启动前检查端口冲突。
   * - 自己的残留进程 → kill 掉
   * - 第三方进程 → 自动分配新端口给我方服务
   * 返回 null 表示端口已就绪，返回 IServiceActionResult 表示无法解决。
   */
  private async ensurePortFree(port: number, serviceId: string): Promise<IServiceActionResult | null> {
    const occupant = await this.getPortOccupantAsync(port);
    if (!occupant) return null;

    const ownSvc = this.isOwnService(occupant);
    if (ownSvc) {
      console.log(`[Watchdog] 端口 ${port} 被残留进程 ${ownSvc.serviceName} (pid=${occupant.pid}) 占用，正在清理`);
      try {
        process.kill(occupant.pid, 'SIGTERM');
        await new Promise(r => setTimeout(r, 2000));
        if (this.isProcessAlive(occupant.pid)) {
          process.kill(occupant.pid, 'SIGKILL');
          await new Promise(r => setTimeout(r, 500));
        }
      } catch { /* 进程已退出 */ }
      this.db.updateServiceStatus(ownSvc.serviceId, 'stopped');
      const stillOccupied = await this.getPortOccupantAsync(port);
      if (stillOccupied) {
        return { ok: false, message: `端口 ${port} 清理失败：残留进程 pid=${occupant.pid} 无法杀死` };
      }
      console.log(`[Watchdog] 端口 ${port} 已清理`);
      return null;
    }

    // ─── 第三方占用 → 自动迁移端口 ─────────────────────────
    console.log(`[Watchdog] 端口 ${port} 被第三方进程占用 (pid=${occupant.pid}, cmd=${occupant.command.slice(0, 80)})`);
    const svc = this.db.getService(serviceId);
    if (!svc) {
      return { ok: false, message: `端口 ${port} 被第三方占用且服务 ${serviceId} 不存在` };
    }

    const newPort = await this.claimPortFromPolarPort({
      service_name: svc.id || svc.name,
      project: this.resolveProject(svc),
      preferred_port: null,
    });

    if (!newPort) {
      return {
        ok: false,
        message: `端口 ${port} 被第三方占用 (pid=${occupant.pid}, cmd=${occupant.command.slice(0, 80)})，且 PolarPort 无可用端口`,
      };
    }

    console.log(`[Watchdog] ⚡ 自动迁移端口: ${svc.name} ${port} → ${newPort} (原端口被 pid=${occupant.pid} 占用)`);
    this.db.updateServiceStatus(serviceId, svc.status, { port: newPort });
    this.db.logServiceEvent({
      service_id: serviceId,
      service_name: svc.name,
      event_type: 'port_conflict_resolved',
      detail: `Port ${port}→${newPort}. Third-party occupant: pid=${occupant.pid} cmd=${occupant.command.slice(0, 120)}`,
    });
    return null;
  }

  // ─── 死因分析 ──────────────────────────────────────────

  private async diagnoseDeath(
    serviceId: string,
    serviceName: string,
    code: number | null,
    signal: string | null,
    stderr: string,
    port: number | null,
  ): Promise<{ cause: string; detail: string; thirdPartyOccupant?: { pid: number; command: string } }> {
    const stderrLower = stderr.toLowerCase();

    // 1. Port conflict (EADDRINUSE)
    if (stderrLower.includes('eaddrinuse') || stderrLower.includes('address already in use')) {
      let detail = `EADDRINUSE detected in stderr`;
      let thirdPartyOccupant: { pid: number; command: string } | undefined;

      if (port) {
        const occupant = await this.getPortOccupantAsync(port);
        if (occupant) {
          const own = this.isOwnService(occupant);
          if (own) {
            detail = `Port ${port} occupied by own service "${own.serviceName}" (pid=${occupant.pid})`;
          } else {
            detail = `Port ${port} occupied by third-party process (pid=${occupant.pid}, cmd=${occupant.command.slice(0, 120)})`;
            thirdPartyOccupant = occupant;
          }
        } else {
          detail = `EADDRINUSE on port ${port} but occupant already gone (transient conflict)`;
        }
      }
      return { cause: 'port_conflict', detail, thirdPartyOccupant };
    }

    // 2. OOM / SIGKILL
    if (signal === 'SIGKILL' || code === 137) {
      return {
        cause: 'oom_kill',
        detail: `Process killed by SIGKILL (likely OOM killer). signal=${signal}, code=${code}`,
      };
    }

    // 3. Permission / module errors
    if (stderrLower.includes('eacces') || stderrLower.includes('permission denied')) {
      return { cause: 'permission', detail: `Permission error: ${stderr.slice(-300)}` };
    }
    if (stderrLower.includes('cannot find module') || stderrLower.includes('modulenotfounderror')) {
      return { cause: 'missing_module', detail: `Module not found: ${stderr.slice(-300)}` };
    }

    // 4. Signal-based death
    if (signal) {
      return { cause: 'signal', detail: `Killed by signal ${signal}` };
    }

    // 5. Non-zero exit with stderr
    if (code && code !== 0 && stderr.length > 0) {
      const lastLines = stderr.split('\n').slice(-5).join('\n');
      return { cause: 'crash', detail: `Exit code ${code}. Last stderr: ${lastLines}`.slice(0, 500) };
    }

    return { cause: code === 0 ? 'clean_exit' : 'unknown', detail: `code=${code}, signal=${signal}` };
  }

  /**
   * 第三方占用端口时自动迁移：分配新端口并重启服务。
   * 返回 true 表示已接管重启流程（调用方不需要再重启）。
   */
  private async resolveThirdPartyPortConflict(serviceId: string, svc: ISharedServiceRow): Promise<boolean> {
    if (!svc.port) return false;

    const occupant = await this.getPortOccupantAsync(svc.port);
    if (!occupant) return false;
    const own = this.isOwnService(occupant);
    if (own) {
      try {
        process.kill(occupant.pid, 'SIGTERM');
        await new Promise(r => setTimeout(r, 2000));
        if (this.isProcessAlive(occupant.pid)) process.kill(occupant.pid, 'SIGKILL');
      } catch { /* already dead */ }
      this.db.updateServiceStatus(own.serviceId, 'stopped');
      console.log(`[Watchdog] 端口 ${svc.port} 残留进程 ${own.serviceName} 已清除，准备重启 ${svc.name}`);
      const cooldown = (this.config.process_manager?.restart_cooldown_sec ?? 10) * 1000;
      setTimeout(() => this.startService(serviceId), cooldown);
      return true;
    }

    const newPort = await this.claimPortFromPolarPort({
      service_name: svc.id || svc.name,
      project: this.resolveProject(svc),
      preferred_port: null,
    });

    if (!newPort) {
      console.error(`[Watchdog] 端口 ${svc.port} 被第三方占用，PolarPort 无可用端口，${svc.name} 无法迁移`);
      return false;
    }

    console.log(`[Watchdog] ⚡ 自动迁移端口: ${svc.name} ${svc.port} → ${newPort} (原端口被 pid=${occupant.pid} 占用: ${occupant.command.slice(0, 60)})`);
    this.db.updateServiceStatus(serviceId, 'stopped', { port: newPort });
    this.db.logServiceEvent({
      service_id: serviceId,
      service_name: svc.name,
      event_type: 'port_conflict_resolved',
      detail: `Port ${svc.port}→${newPort}. Third-party: pid=${occupant.pid} cmd=${occupant.command.slice(0, 120)}`,
    });
    const cooldown = (this.config.process_manager?.restart_cooldown_sec ?? 10) * 1000;
    setTimeout(() => this.startService(serviceId), cooldown);
    return true;
  }

  // ─── 进程存活检测 ──────────────────────────────────────

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  isProcessAlivePublic(pid: number): boolean {
    return this.isProcessAlive(pid);
  }

  // ─── 状态查询 ───────────────────────────────────────────

  /** 获取所有服务状态（本地服务实时检查，远程服务从本地 DB 读） */
  getAllStatus(): IProcessStatus[] {
    const services = this.db.listServices();
    return services.map(svc => this.toProcessStatus(svc));
  }

  /**
   * 获取所有服务状态（异步版：远程服务从对端 API 实时获取）。
   * 超时或不可达时 fallback 到本地 DB 数据 + status_stale 标记。
   */
  async getAllStatusAsync(): Promise<IProcessStatus[]> {
    const services = this.db.listServices();
    const localServices = services.filter(s => this.shouldRunLocally(s));
    const remoteByDevice = new Map<string, ISharedServiceRow[]>();

    for (const svc of services) {
      if (this.shouldRunLocally(svc)) continue;
      const arr = remoteByDevice.get(svc.device_id) ?? [];
      arr.push(svc);
      remoteByDevice.set(svc.device_id, arr);
    }

    const results: IProcessStatus[] = localServices.map(s => this.toProcessStatus(s));

    for (const [devId, svcs] of remoteByDevice) {
      const remoteStatuses = await this.fetchRemoteStatuses(devId);
      for (const svc of svcs) {
        const remote = remoteStatuses?.find(r => r.id === svc.id);
        if (remote) {
          results.push(remote);
        } else {
          const ps = this.toProcessStatus(svc);
          (ps as any).status_stale = true;
          results.push(ps);
        }
      }
    }

    return results;
  }

  /**
   * Convert DB service row to process status.
   * Core logic: port has listener → running (even if DB status is error).
   * Priority: port binding > PID alive check > DB status.
   */
  private toProcessStatus(svc: ISharedServiceRow): IProcessStatus {
    const isLocal = this.shouldRunLocally(svc);
    const remoteDevice = !isLocal ? this.db.getDevice(svc.device_id)?.display_name : undefined;
    let pidVerified = false;

    // ─── 1. 优先检查 PID 存活（快速路径，不 spawn 子进程）────────
    // 端口绑定验证由 runHealthChecks 异步完成，这里只做 PID 快检
    if (isLocal && svc.pid && this.isProcessAlive(svc.pid)) {
      pidVerified = true;
      if (svc.status !== 'running') {
        this.db.updateServiceStatus(svc.id, 'running', { pid: svc.pid });
        this.db.updateServiceRestartCount(svc.id, 0);
        svc.status = 'running';
        svc.restart_count = 0;
      }
    } else if (isLocal && svc.status === 'running' && svc.pid && !this.isProcessAlive(svc.pid)) {
      pidVerified = false;
    }

    // ─── 2. 无端口监听者，检查 PID 存活 ───────────────────────
    if (isLocal && svc.pid) {
      try {
        process.kill(svc.pid, 0);
        pidVerified = true;

        // PID 存活但无端口监听 → starting（服务可能正在启动）
        if (svc.port && svc.status === 'running') {
          // 服务声称 running 但端口无监听 → 可能是启动中或已崩溃
          // 不立即改为 starting，让健康检查循环处理
        } else if (!svc.port) {
          // 无端口服务：PID 存活就是 running
          if (svc.status !== 'running') {
            this.db.updateServiceStatus(svc.id, 'running', { pid: svc.pid });
            svc.status = 'running';
          }
        }
      } catch {
        // PID 已死
        pidVerified = false;
        if (svc.status === 'running') {
          // 原来是 running，现在 PID 死了 → 根据是否有端口决定状态
          if (svc.port) {
            // 有端口但无监听者且 PID 死 → 保持 running 等健康检查处理
            // 或者改为 starting（可能刚重启）
          } else {
            // 无端口服务 PID 死 → stopped
            this.db.updateServiceStatus(svc.id, 'stopped');
            svc.status = 'stopped';
          }
        }
        // error/stopped 状态保持不变
      }
    }

    // ─── 3. 无 PID 无端口 → 依赖 DB 状态 ───────────────────────
    return {
      id: svc.id,
      name: svc.name,
      status: svc.status as IProcessStatus['status'],
      pid: svc.pid,
      port: svc.port,
      device_id: svc.device_id,
      auto_start: svc.auto_start === 1,
      restart_count: svc.restart_count,
      max_restarts: svc.max_restarts,
      started_at: svc.started_at ? svc.started_at + (svc.started_at.endsWith('Z') ? '' : 'Z') : null,
      last_health_check: svc.last_health_check ? svc.last_health_check + (svc.last_health_check.endsWith('Z') ? '' : 'Z') : null,
      is_local: isLocal,
      remote_device: remoteDevice,
      cron_schedule: svc.cron_schedule,
      last_exit_code: svc.last_exit_code,
      last_error: svc.last_error,
      pid_verified: isLocal ? pidVerified : undefined,
      pending_restart: svc.pending_restart === 1,
      last_change_at: svc.last_change_at ? svc.last_change_at + (svc.last_change_at.endsWith('Z') ? '' : 'Z') : null,
    };
  }

  /**
   * 获取所有设备（本地 + 远程）的服务状态。
   * 远程设备直接从对端 API 获取本地服务列表。
   */
  async getAllDevicesStatus(): Promise<IProcessStatus[]> {
    const local = this.db.listServices(this.localDeviceId).map(s => this.toProcessStatus(s));
    const devices = this.db.listDevices().filter(d => d.device_id !== this.localDeviceId);

    const remotePromises = devices.map(async (dev) => {
      const statuses = await this.fetchRemoteStatuses(dev.device_id);
      if (!statuses) return [];
      return statuses.map(s => ({ ...s, is_local: false, remote_device: dev.display_name }));
    });

    const remoteResults = await Promise.all(remotePromises);
    return [...local, ...remoteResults.flat()];
  }

  /** 解析远程设备 IP：config 静态 → DB 记录 → Tailscale 动态解析 */
  private async resolveDeviceIP(deviceId: string): Promise<string | null> {
    const devConf = this.config.devices?.[deviceId] as Record<string, unknown> | undefined;
    if (devConf?.tailscale_ip) return devConf.tailscale_ip as string;

    const dbDevice = this.db.getDevice(deviceId);
    if (dbDevice?.tailscale_ip) return dbDevice.tailscale_ip;

    return getPeerTailscaleIP(deviceId);
  }

  /** 从远程设备的 SOTAgent API 获取服务状态 */
  private async fetchRemoteStatuses(deviceId: string): Promise<IProcessStatus[] | null> {
    const ip = await this.resolveDeviceIP(deviceId);
    if (!ip) return null;
    try {
      const resp = await fetch(`http://${ip}:${SOTAGENT_API_PORT}/api/services`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      return await resp.json() as IProcessStatus[];
    } catch {
      return null;
    }
  }

  /** 检查所有注册服务的端口冲突状态 */
  async checkAllPortConflicts(): Promise<Array<{
    serviceId: string;
    serviceName: string;
    port: number;
    conflict: 'none' | 'own_residual' | 'third_party';
    occupantPid?: number;
    occupantCommand?: string;
  }>> {
    const services = this.db.listServices(this.localDeviceId);
    const results: Array<{
      serviceId: string;
      serviceName: string;
      port: number;
      conflict: 'none' | 'own_residual' | 'third_party';
      occupantPid?: number;
      occupantCommand?: string;
    }> = [];

    for (const svc of services) {
      if (!svc.port) continue;
      const occupant = await this.getPortOccupantAsync(svc.port);
      if (!occupant) {
        results.push({ serviceId: svc.id, serviceName: svc.name, port: svc.port, conflict: 'none' });
        continue;
      }
      // If the occupant IS this service's current running process, it's not a conflict
      if (svc.status === 'running' && svc.pid === occupant.pid) {
        results.push({ serviceId: svc.id, serviceName: svc.name, port: svc.port, conflict: 'none' });
        continue;
      }
      const own = this.isOwnService(occupant);
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        port: svc.port,
        conflict: own ? 'own_residual' : 'third_party',
        occupantPid: occupant.pid,
        occupantCommand: occupant.command.slice(0, 200),
      });
    }
    return results;
  }

  // ─── 孤儿进程巡逻 ──────────────────────────────────────

  private orphanFirstSeen = new Map<number, number>();
  private healthCheckCount = 0;
  private static readonly ORPHAN_SCAN_INTERVAL = 10; // every 10th health check (~5min)
  private static readonly ORPHAN_GRACE_MS = 5 * 60_000; // 5 minutes (was 30 minutes)
  private static readonly STABLE_UPTIME_MS = 15 * 60 * 1000; // 稳定运行 15 分钟后恢复 restart_count

  /**
   * 检查服务是否稳定运行超过 15 分钟，如果是则清零 restart_count。
   *
   * 这是"正常重启"和"异常退出"的核心区分逻辑：
   * - 频繁崩溃的服务：restart_count 持续累加，最终被放弃
   * - 偶尔崩溃但能稳定运行的服务：15 分钟后自动恢复配额
   *
   * 在健康检查循环中调用（每次 ~120s），只要服务处于 running 状态且
   * restart_count > 0，就检查连续运行时间。
   */
  private checkStableUptimeRecovery(svc: ISharedServiceRow): void {
    if (svc.restart_count <= 0) return;
    if (svc.status !== 'running') return;
    if (!svc.started_at) return;

    const uptimeMs = Date.now() - new Date(svc.started_at + 'Z').getTime();
    if (uptimeMs < ProcessManager.STABLE_UPTIME_MS) return;

    const oldCount = svc.restart_count;
    this.db.updateServiceRestartCount(svc.id, 0);
    svc.restart_count = 0;
    this.excessiveRestartLogged.delete(svc.id);
    this.db.logServiceEvent({
      service_id: svc.id,
      service_name: svc.name,
      event_type: 'restart_recovery',
      detail: `Stable uptime ${Math.round(uptimeMs / 60000)}min reached. restart_count ${oldCount}→0.`,
      restart_count: oldCount,
    });
    console.log(`[Watchdog] 服务 ${svc.name} 稳定运行 ${Math.round(uptimeMs / 60000)} 分钟，restart_count ${oldCount}→0`);
  }

  /**
   * Scan for orphan processes: listening on registered ports but not matching any service PID.
   * Unregistered listeners are logged as warnings. Orphans surviving past grace period are killed.
   */
  private async scanOrphanProcesses(): Promise<void> {
    let listenLines: string;
    try {
      const { stdout } = await execAsync(
        `${ProcessManager.LSOF} -iTCP -sTCP:LISTEN -P -n -F pn 2>/dev/null`,
        { timeout: 5000 },
      );
      listenLines = stdout;
    } catch {
      return;
    }

    const listeners = new Map<number, Set<number>>();
    let currentPid = 0;
    for (const line of listenLines.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = parseInt(line.slice(1), 10);
        if (!listeners.has(currentPid)) listeners.set(currentPid, new Set());
      } else if (line.startsWith('n') && currentPid) {
        const match = line.match(/:(\d+)$/);
        if (match?.[1]) listeners.get(currentPid)!.add(parseInt(match[1], 10));
      }
    }

    const services = this.db.listServices(this.localDeviceId);
    const registeredPorts = new Map<number, ISharedServiceRow>();
    for (const svc of services) {
      if (svc.port) registeredPorts.set(svc.port, svc);
    }

    const now = Date.now();
    const activeOrphans = new Set<number>();

    for (const [pid, ports] of listeners) {
      if (pid === process.pid) continue;

      for (const port of ports) {
        const svc = registeredPorts.get(port);
        if (!svc) continue; // unregistered port — not our concern

        if (svc.status === 'running' && svc.pid === pid) continue; // legitimate service

        let command = '';
        try {
          const { stdout } = await execAsync(`ps -p ${pid} -o command= 2>/dev/null || true`, { timeout: 3000 });
          command = stdout.trim();
        } catch { /* process may have exited */ }
        const occupant = { pid, command };
        const managed = await this.canAdoptPortOccupant(svc.id, occupant, svc.pid);
        if (!managed) continue; // external proxy or third-party listener: never signal it
        if (svc.status === 'running') {
          this.db.updateServiceStatus(svc.id, 'running', { pid });
          continue;
        }

        // Orphan: listening on registered port but PID doesn't match
        activeOrphans.add(pid);

        if (!this.orphanFirstSeen.has(pid)) {
          this.orphanFirstSeen.set(pid, now);
          console.log(`[OrphanScan] 发现孤儿进程: pid=${pid} 占用注册端口 ${port} (服务 ${svc.name})`);
          this.db.logServiceEvent({
            service_id: svc.id, service_name: svc.name,
            event_type: 'orphan_detected',
            detail: `Orphan pid=${pid} on port ${port}`,
          });
        }

        const age = now - this.orphanFirstSeen.get(pid)!;
        if (age >= ProcessManager.ORPHAN_GRACE_MS) {
          console.log(`[OrphanScan] 孤儿进程 pid=${pid} 超过 ${Math.round(age / 60_000)}min，发送 SIGTERM`);
          try {
            process.kill(pid, 'SIGTERM');
            this.db.logServiceEvent({
              service_id: svc.id, service_name: svc.name,
              event_type: 'orphan_killed',
              detail: `Killed orphan pid=${pid} after ${Math.round(age / 60_000)}min`,
            });
          } catch { /* already dead */ }
          this.orphanFirstSeen.delete(pid);
        }
      }
    }

    // Clean up tracking for processes that disappeared
    for (const pid of this.orphanFirstSeen.keys()) {
      if (!activeOrphans.has(pid)) this.orphanFirstSeen.delete(pid);
    }
  }

  /**
   * Clean ghost port registrations: ports registered in port_registry but with no
   * process actually listening on them. Prevents stale entries from accumulating.
   */
  private async cleanGhostPorts(): Promise<void> {
    try {
      const activePorts = this.db.listActivePortEntries();
      for (const row of activePorts) {
        const occupant = await this.getPortOccupantAsync(row.port);
        if (!occupant) {
          console.log(`[GhostClean] 幽灵端口 :${row.port} (${row.service_name}) — 无进程监听，释放`);
          this.db.releasePort(row.port);
        }
      }
    } catch (e) {
      console.error('[GhostClean] 清理失败:', e);
    }
  }

  /** Stop health checks on shutdown. Detached services keep running and
   *  get re-adopted by the next SOTAgent instance via the watchdog. */
  async shutdownAll(): Promise<void> {
    this.stopHealthCheckLoop();
    this.stopSandboxMonitor();
    this.stopSilentWindowLoop();
  }

  // ═══════════════════════════════════════════════════════
  // ─── 沙箱进程管理 ────────────────────────────────────
  // ═══════════════════════════════════════════════════════

  private sandboxProcesses = new Map<string, ISandboxRuntime>();
  private sandboxIdCounter = 0;
  private sandboxMonitorTimer: ReturnType<typeof setInterval> | null = null;

  startSandboxMonitor(): void {
    if (this.sandboxMonitorTimer) return;
    this.sandboxMonitorTimer = setInterval(() => this.checkSandboxProcesses(), 30_000);
  }

  stopSandboxMonitor(): void {
    if (this.sandboxMonitorTimer) {
      clearInterval(this.sandboxMonitorTimer);
      this.sandboxMonitorTimer = null;
    }
  }

  async startSandbox(cfg: ISandboxConfig): Promise<ISandboxStartResult> {
    const id = `sandbox-${++this.sandboxIdCounter}-${Date.now().toString(36)}`;
    const name = cfg.name || `Sandbox ${this.sandboxIdCounter}`;
    const nicePri = cfg.nice_priority ?? 10;
    const workDir = cfg.work_dir?.replace(/^~/, os.homedir()) ?? undefined;

    if (workDir && !fs.existsSync(workDir)) {
      return { ok: false, message: `工作目录不存在: ${workDir}` };
    }

    const cmdCheck = validateCommand(cfg.command);
    if (!cmdCheck.ok) {
      return { ok: false, message: `命令被安全策略拒绝: ${cmdCheck.reason}` };
    }

    // Build wrapped command with resource limits
    const parts: string[] = [];
    if (nicePri !== 0) parts.push(`nice -n ${nicePri}`);
    if (cfg.max_memory_mb) {
      const limitKb = cfg.max_memory_mb * 1024;
      parts.push(`ulimit -v ${limitKb};`);
    }
    parts.push(cfg.command);
    const wrappedCmd = parts.join(' ');

    try {
      const child = spawn('/bin/sh', ['-c', wrappedCmd], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env },
      });
      child.unref();

      if (!child.pid) {
        return { ok: false, message: '沙箱进程启动失败：未获取到 PID' };
      }

      let stderrBuf = '';
      if (child.stderr) {
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk: string) => {
          stderrBuf = (stderrBuf + chunk).slice(-4000);
        });
      }

      const runtime: ISandboxRuntime = {
        id,
        name,
        config: cfg,
        child,
        pid: child.pid,
        startedAt: new Date(),
        status: 'running',
        exitCode: null,
        lastOutputCheck: new Date(),
        outputFileCount: 0,
        stderrBuffer: '',
      };

      child.on('exit', (code) => {
        runtime.exitCode = code;
        runtime.status = code === 0 ? 'completed' : 'error';
        runtime.stderrBuffer = stderrBuf;
        console.log(`[Sandbox] ${name} (pid=${child.pid}) 退出 code=${code}`);
      });

      child.on('error', (err) => {
        runtime.status = 'error';
        runtime.stderrBuffer = err.message;
        console.error(`[Sandbox] ${name} spawn 失败: ${err.message}`);
      });

      // Schedule timeout kill
      if (cfg.max_duration_sec) {
        setTimeout(() => {
          if (runtime.status === 'running' && this.isProcessAlive(runtime.pid)) {
            console.log(`[Sandbox] ${name}: 运行超时 (${cfg.max_duration_sec}s)，发送 SIGTERM`);
            runtime.status = 'timeout';
            try { process.kill(runtime.pid, 'SIGTERM'); } catch { /* dead */ }
            setTimeout(() => {
              if (this.isProcessAlive(runtime.pid)) {
                try { process.kill(runtime.pid, 'SIGKILL'); } catch { /* dead */ }
              }
            }, 5000);
          }
        }, cfg.max_duration_sec * 1000);
      }

      // Initial output scan
      if (cfg.output_dir) {
        runtime.outputFileCount = this.countOutputFiles(cfg.output_dir);
      }

      this.sandboxProcesses.set(id, runtime);
      this.startSandboxMonitor();

      console.log(`[Sandbox] 启动 ${name}: pid=${child.pid}, nice=${nicePri}${cfg.max_duration_sec ? `, timeout=${cfg.max_duration_sec}s` : ''}${cfg.output_dir ? `, output=${cfg.output_dir}` : ''}`);

      return { ok: true, id, pid: child.pid, message: `沙箱进程 ${name} 已启动` };
    } catch (err) {
      return { ok: false, message: `沙箱启动失败: ${err}` };
    }
  }

  async stopSandbox(sandboxId: string): Promise<IServiceActionResult> {
    const runtime = this.sandboxProcesses.get(sandboxId);
    if (!runtime) return { ok: false, message: `沙箱 ${sandboxId} 不存在` };

    if (runtime.status !== 'running' && runtime.status !== 'stale') {
      return { ok: true, message: `沙箱 ${runtime.name} 已经停止 (status=${runtime.status})` };
    }

    try {
      if (this.isProcessAlive(runtime.pid)) {
        process.kill(runtime.pid, 'SIGTERM');
        await new Promise(r => setTimeout(r, 5000));
        if (this.isProcessAlive(runtime.pid)) {
          process.kill(runtime.pid, 'SIGKILL');
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch { /* already dead */ }

    runtime.status = 'stopped';
    return { ok: true, message: `沙箱 ${runtime.name} 已停止` };
  }

  async getSandboxStatus(): Promise<ISandboxStatus[]> {
    const results: ISandboxStatus[] = [];
    for (const [, rt] of this.sandboxProcesses) {
      // Live-check running processes
      if (rt.status === 'running' && !this.isProcessAlive(rt.pid)) {
        rt.status = rt.exitCode === 0 ? 'completed' : 'error';
      }
      results.push(await this.toSandboxStatus(rt));
    }
    return results;
  }

  async getSandboxMetrics(sandboxId: string): Promise<ISandboxStatus | null> {
    const rt = this.sandboxProcesses.get(sandboxId);
    if (!rt) return null;
    if (rt.status === 'running' && !this.isProcessAlive(rt.pid)) {
      rt.status = rt.exitCode === 0 ? 'completed' : 'error';
    }
    return await this.toSandboxStatus(rt);
  }

  private async toSandboxStatus(rt: ISandboxRuntime): Promise<ISandboxStatus> {
    const elapsed = (Date.now() - rt.startedAt.getTime()) / 1000;
    let cpuPercent: number | null = null;
    let memRssMb: number | null = null;

    if (rt.status === 'running' && this.isProcessAlive(rt.pid)) {
      try {
        const { stdout: psOut } = await execAsync(
          `ps -p ${rt.pid} -o %cpu=,%mem=,rss= 2>/dev/null`,
          { timeout: 3000 },
        );
        const parts = psOut.trim().split(/\s+/);
        if (parts.length >= 3) {
          cpuPercent = parseFloat(parts[0]!) || 0;
          memRssMb = Math.round((parseInt(parts[2]!, 10) || 0) / 1024);
        }
      } catch { /* ps failed */ }
    }

    return {
      id: rt.id,
      name: rt.name,
      status: rt.status,
      pid: rt.pid,
      command: rt.config.command,
      work_dir: rt.config.work_dir ?? '',
      started_at: rt.startedAt.toISOString(),
      elapsed_sec: Math.round(elapsed),
      nice_priority: rt.config.nice_priority ?? 10,
      max_duration_sec: rt.config.max_duration_sec ?? null,
      max_memory_mb: rt.config.max_memory_mb ?? null,
      output_dir: rt.config.output_dir ?? null,
      last_output_at: rt.lastOutputCheck?.toISOString() ?? null,
      output_file_count: rt.outputFileCount,
      cpu_percent: cpuPercent,
      mem_rss_mb: memRssMb,
      exit_code: rt.exitCode,
    };
  }

  private checkSandboxProcesses(): void {
    for (const [id, rt] of this.sandboxProcesses) {
      if (rt.status !== 'running') continue;

      if (!this.isProcessAlive(rt.pid)) {
        rt.status = rt.exitCode === 0 ? 'completed' : 'error';
        continue;
      }

      // Output stale detection
      if (rt.config.output_dir && rt.config.output_timeout_sec) {
        const currentCount = this.countOutputFiles(rt.config.output_dir);
        if (currentCount > rt.outputFileCount) {
          rt.outputFileCount = currentCount;
          rt.lastOutputCheck = new Date();
        } else {
          const silentSec = (Date.now() - rt.lastOutputCheck.getTime()) / 1000;
          if (silentSec > rt.config.output_timeout_sec) {
            console.log(`[Sandbox] ${rt.name}: 无产出超过 ${Math.round(silentSec)}s，标记为疑似僵死`);
            rt.status = 'stale';
          }
        }
      }
    }

    // Prune completed sandbox entries older than 1 hour
    const pruneThreshold = Date.now() - 3600_000;
    for (const [id, rt] of this.sandboxProcesses) {
      if (rt.status !== 'running' && rt.status !== 'stale' && rt.startedAt.getTime() < pruneThreshold) {
        this.sandboxProcesses.delete(id);
      }
    }

    if (this.sandboxProcesses.size === 0) {
      this.stopSandboxMonitor();
    }
  }

  private countOutputFiles(dirPath: string): number {
    const resolved = dirPath.replace(/^~/, os.homedir());
    try {
      if (!fs.existsSync(resolved)) return 0;
      return fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isFile()).length;
    } catch {
      return 0;
    }
  }
}

// ─── 沙箱类型定义 ──────────────────────────────────────

export interface ISandboxConfig {
  command: string;
  work_dir?: string;
  /** nice 优先级 (-20~19, 默认 10 = 低优先级) */
  nice_priority?: number;
  /** 最大运行时长（秒），超时后 SIGTERM→SIGKILL */
  max_duration_sec?: number;
  /** 最大内存（MB），通过 ulimit -v 限制 */
  max_memory_mb?: number;
  /** 产出检测目录 */
  output_dir?: string;
  /** 无产出超时（秒），超时标记为疑似僵死 */
  output_timeout_sec?: number;
  /** 显示名称 */
  name?: string;
}

export interface ISandboxStatus {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'stale' | 'completed' | 'timeout' | 'error';
  pid: number | null;
  command: string;
  work_dir: string;
  started_at: string | null;
  elapsed_sec: number;
  nice_priority: number;
  max_duration_sec: number | null;
  max_memory_mb: number | null;
  output_dir: string | null;
  last_output_at: string | null;
  output_file_count: number;
  cpu_percent: number | null;
  mem_rss_mb: number | null;
  exit_code: number | null;
}

export interface ISandboxStartResult {
  ok: boolean;
  message: string;
  id?: string;
  pid?: number;
}

interface ISandboxRuntime {
  id: string;
  name: string;
  config: ISandboxConfig;
  child: ChildProcess;
  pid: number;
  startedAt: Date;
  status: ISandboxStatus['status'];
  exitCode: number | null;
  lastOutputCheck: Date;
  outputFileCount: number;
  stderrBuffer: string;
}
