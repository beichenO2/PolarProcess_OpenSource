/**
 * server.ts — PolarProcess Hono server.
 *
 * Mounts service/process/task/scheduler endpoints.
 * Now the sole owner of ProcessManager lifecycle (migrated from SOTAgent).
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { ProcessDB } from './db.js';
import { ServiceDB } from './service-db.js';
import { ProcessManager, type IProcessStatus, type IServiceActionResult, type IProcessManagerConfig } from './process-manager.js';
import { ResourceScheduler } from './scheduler.js';
import { ResourceProfiler } from './profiler.js';
import { Watchdog } from './watchdog.js';
import { bootstrapOutboundProxy, getProxyEnvSnapshot } from './proxy-env.js';
import { installExitForensics } from './exit-forensics.js';
import {
  notifyPolarBudgetRegister,
  notifyPolarBudgetUnregister,
} from './polar-budget-notify.js';

const DATA_DIR = process.env.POLARPROCESS_DATA_DIR
  ?? path.join(process.env.HOME ?? '', 'Polarisor', 'PolarProcess', 'data');
const DB_PATH = process.env.POLARPROCESS_DB ?? path.join(DATA_DIR, 'process.sqlite');
const SHARED_DB_PATH = process.env.POLARPROCESS_SHARED_DB
  ?? path.join(process.env.HOME ?? '', 'Polarisor', 'SOTAgent', 'data', 'resources.sqlite');
/** Infrastructure pin — never accept PolarPort sticky/alternate ports. */
const FIXED_PORT = Number(process.env.POLARPROCESS_PORT ?? 11055);
const POLARPORT_URL = process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';

const PM_CONFIG: IProcessManagerConfig = {
  process_manager: {
    health_check_interval_sec: 30,
    auto_start_delay_sec: 5,
    max_restart_attempts: 5,
    restart_cooldown_sec: 15,
    restart_decay_min: 30,
    startup_grace_sec: 30,
  },
  silent_restart_window_sec: 7200,
};

export type PolarProcessApp = Hono & { startLifecycle: () => void };

export function createApp(db: ProcessDB, serviceDb: ServiceDB): PolarProcessApp {
  const app = new Hono() as PolarProcessApp;
  const deviceId = process.env['SOTAGENT_DEVICE_ID'] || os.hostname().split('.')[0] || os.hostname();
  const profiler = new ResourceProfiler(db);
  const scheduler = new ResourceScheduler(db, deviceId, profiler);

  // ─── Health ──────────────────────────────────────
  app.get('/api/health', (c) => c.json({ ok: true, service: 'polar-process' }));

  app.get('/api/runtime/proxy', (c) => {
    const snapshot = getProxyEnvSnapshot();
    return c.json({
      ok: true,
      proxy: snapshot ?? { mode: 'unknown', applied: false, source: 'none' },
      processEnv: {
        HTTP_PROXY: process.env.HTTP_PROXY ?? null,
        HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
        NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? null,
        NO_PROXY: process.env.NO_PROXY ?? null,
      },
    });
  });

  // ─── Tasks ───────────────────────────────────────
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status');
    const tasks = scheduler.listTasks(status);
    return c.json(tasks);
  });

  app.post('/api/tasks/create', async (c) => {
    const body = await c.req.json();
    const result = scheduler.createTask(body);
    return c.json(result);
  });

  app.get('/api/tasks/:id/status', (c) => {
    const id = c.req.param('id');
    const task = scheduler.getTask(id);
    if (!task) return c.json({ ok: false, message: `task ${id} not found` }, 404);
    return c.json(task);
  });

  app.post('/api/tasks/:id/cancel', (c) => {
    const id = c.req.param('id');
    const result = scheduler.cancelTask(id);
    return c.json(result);
  });

  // ─── Scheduler ───────────────────────────────────
  app.get('/api/scheduler/status', (c) => {
    const status = scheduler.getStatus();
    return c.json(status);
  });

  app.get('/api/scheduler/queue', (c) => {
    const tasks = scheduler.listTasks('queued');
    return c.json(tasks);
  });

  app.post('/api/scheduler/config', async (c) => {
    const body = await c.req.json();
    scheduler.updateConfig(body);
    return c.json({ ok: true });
  });

  // ─── Watchdog ─────────────────────────────────
  const watchdog = new Watchdog();
  watchdog.discoverTargets().then(n => {
    console.log(`[Watchdog] Discovered ${n} targets`);
    watchdog.start();
  });

  app.get('/api/watchdog/status', (c) => c.json(watchdog.getStatus()));

  app.post('/api/watchdog/rediscover', async (c) => {
    const n = await watchdog.discoverTargets();
    return c.json({ ok: true, discovered: n, total: watchdog.getStatus().length });
  });

  app.post('/api/watchdog/pause/:service', (c) => {
    watchdog.pause(c.req.param('service'));
    return c.json({ ok: true, message: `paused watchdog for ${c.req.param('service')}` });
  });

  app.post('/api/watchdog/resume/:service', (c) => {
    watchdog.resume(c.req.param('service'));
    return c.json({ ok: true, message: `resumed watchdog for ${c.req.param('service')}` });
  });

  // ─── Services (Process Management — Full lifecycle) ─────────────
  const pm = new ProcessManager(serviceDb, PM_CONFIG);

  app.get('/api/services', (c) => {
    const services = pm.getAllStatus();
    return c.json(services);
  });

  app.get('/api/services/by-port/:port', (c) => {
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ ok: false, message: 'invalid port' }, 400);
    }
    const svc = pm.findServiceByPort(port);
    if (!svc) return c.json({ ok: false, message: `no registered service on port ${port}` }, 404);
    return c.json({ ok: true, service: svc, port });
  });

  app.get('/api/services/:id', (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `service ${id} not found` }, 404);
    return c.json(svc);
  });

  app.post('/api/services/:id/start', async (c) => {
    const id = c.req.param('id');
    const result = await pm.startService(id);
    if (result.ok && result.pid) {
      void notifyPolarBudgetRegister(id, result.pid, 'service_bg');
    }
    return c.json(result, result.ok ? 200 : 500);
  });

  app.post('/api/services/:id/stop', async (c) => {
    const id = c.req.param('id');
    const result = await pm.stopService(id);
    if (result.ok) {
      void notifyPolarBudgetUnregister(id);
    }
    return c.json(result, result.ok ? 200 : 500);
  });

  app.post('/api/services/:id/restart', async (c) => {
    const id = c.req.param('id');
    const result = await pm.restartService(id);
    return c.json(result, result.ok ? 200 : 500);
  });

  app.post('/api/services/:id/stop-and-verify', async (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `service ${id} not found` }, 404);
    const body = await c.req.json().catch(() => ({})) as {
      timeout_ms?: unknown;
      clear_own_residual?: unknown;
    };
    const options: { timeout_ms?: number; clear_own_residual?: boolean } = {};
    if (typeof body.timeout_ms === 'number') options.timeout_ms = body.timeout_ms;
    if (typeof body.clear_own_residual === 'boolean') {
      options.clear_own_residual = body.clear_own_residual;
    }
    const result = await pm.stopAndVerifyPort(id, options);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/services/:id/restart-clean', async (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `service ${id} not found` }, 404);
    const result = await pm.restartClean(id);
    return c.json(result, result.ok ? 200 : 500);
  });

  app.post('/api/services/:id/reconcile-children', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { stale_pids?: unknown };
    if (!Array.isArray(body.stale_pids)) {
      return c.json({ ok: false, message: 'stale_pids array is required' }, 400);
    }
    const result = await pm.reconcileServiceChildren(id, body.stale_pids as number[]);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/services/:id/reset-restart-count', (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `service ${id} not found` }, 404);
    serviceDb.updateServiceRestartCount(id, 0);
    return c.json({ ok: true, message: `restart count reset for ${svc.name}` });
  });

  // ─── Processes (legacy SOTAgent compat + safe scoped kill) ───
  app.get('/api/processes', (c) => {
    const processes = pm.getAllStatus();
    return c.json(processes);
  });

  app.get('/api/processes/:id', (c) => {
    const id = c.req.param('id');
    const proc = pm.getProcessById(id);
    if (!proc) return c.json({ ok: false, message: `process ${id} not found` }, 404);
    return c.json(proc);
  });

  app.post('/api/processes/:id/kill', async (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `process ${id} not found` }, 404);
    const result = await pm.killManagedProcess(id);
    return c.json(result, result.ok ? 200 : 500);
  });

  // ─── Diagnostics (safe substitutes for lsof/kill/port-free checks) ───
  app.get('/api/diagnostics/port-conflicts', async (c) => {
    const conflicts = await pm.checkAllPortConflicts();
    return c.json({ ok: true, conflicts });
  });

  app.get('/api/diagnostics/listening-ports', async (c) => {
    const listeners = await pm.listListeningPorts();
    return c.json({ ok: true, listeners, count: listeners.length });
  });

  app.get('/api/diagnostics/ports-batch', async (c) => {
    const raw = c.req.query('ports') ?? '';
    const ports = raw.split(/[,\s]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 65535);
    if (ports.length === 0) {
      return c.json({ ok: false, message: 'ports query required (comma-separated)' }, 400);
    }
    if (ports.length > 50) {
      return c.json({ ok: false, message: 'max 50 ports per batch request' }, 400);
    }
    const diagnostics = await pm.getBatchPortDiagnostics(ports);
    return c.json({ ok: true, diagnostics });
  });

  app.get('/api/diagnostics/ports/:port', async (c) => {
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ ok: false, message: 'invalid port' }, 400);
    }
    try {
      const diagnostic = await pm.getPortDiagnostic(port);
      return c.json({ ok: true, ...diagnostic });
    } catch (err) {
      return c.json(
        { ok: false, message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post('/api/diagnostics/ports/:port/clear-own', async (c) => {
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ ok: false, message: 'invalid port' }, 400);
    }
    const result = await pm.clearOwnPortOccupant(port);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/diagnostics/ports/:port/wait-free', async (c) => {
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ ok: false, message: 'invalid port' }, 400);
    }
    const body = await c.req.json().catch(() => ({})) as {
      timeout_ms?: unknown;
      interval_ms?: unknown;
    };
    const options: { timeout_ms?: number; interval_ms?: number } = {};
    if (typeof body.timeout_ms === 'number') options.timeout_ms = body.timeout_ms;
    if (typeof body.interval_ms === 'number') options.interval_ms = body.interval_ms;
    const result = await pm.waitForPortFree(port, options);
    return c.json(result, result.free ? 200 : 409);
  });

  app.post('/api/diagnostics/ports/:port/clear-and-verify', async (c) => {
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ ok: false, message: 'invalid port' }, 400);
    }
    const result = await pm.clearOwnPortOccupantAndVerify(port);
    return c.json(result, result.free ? 200 : 409);
  });

  app.get('/api/diagnostics/process/:pid', async (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      return c.json({ ok: false, message: 'invalid pid' }, 400);
    }
    const probe = await pm.probeProcess(pid);
    return c.json({ ok: true, ...probe });
  });

  app.get('/api/services/:id/port-status', async (c) => {
    const id = c.req.param('id');
    const result = await pm.getServicePortStatus(id);
    if ('ok' in result && result.ok === false && !('port' in result)) {
      return c.json(result, 404);
    }
    if ('ok' in result && result.ok === false) {
      return c.json(result, 400);
    }
    return c.json({ ok: true, ...(result as object) });
  });

  app.post('/api/services/:id/ensure-port-ready', async (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `service ${id} not found` }, 404);
    const result = await pm.ensureServicePortReady(id);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/services/register', async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.name || !body.command) {
      return c.json({ ok: false, message: 'id, name and command are required' }, 400);
    }
    const result = pm.registerService(body);
    return c.json(result, result.ok ? 200 : 409);
  });

  /** Explicit deregister (stop then delete). Non-ephemeral requires body.confirm === id. */
  app.delete('/api/services/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { confirm?: unknown };
    const confirm = typeof body.confirm === 'string' ? body.confirm : undefined;
    const result = await pm.unregisterService(id, { confirm });
    if (!result.ok && result.message.includes('not found')) {
      return c.json(result, 404);
    }
    return c.json(result, result.ok ? 200 : 409);
  });

  /**
   * GC ephemeral cursor-cli- / rr-cursor- rows that are error/stopped and missing start scripts.
   * dry_run defaults to true (safe).
   */
  app.post('/api/services/sweep-ephemeral', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dry_run?: unknown };
    const dry_run = body.dry_run !== false;
    const result = await pm.sweepEphemeral({ dry_run });
    return c.json(result);
  });

  app.post('/api/services/register-and-start', async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.name || !body.command) {
      return c.json({ ok: false, message: 'id, name and command are required' }, 400);
    }
    const registration = pm.registerService(body);
    if (!registration.ok) return c.json(registration, 409);
    const result = await pm.startService(body.id);
    return c.json({ ...result, id: body.id }, result.ok ? 200 : 500);
  });

  // Backward compat: SOTAgent bridge proxies POST /api/services here
  app.post('/api/services', async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.name || !body.command) {
      return c.json({ ok: false, message: 'id, name and command are required' }, 400);
    }
    const result = pm.registerService(body);
    return c.json(result, result.ok ? 200 : 409);
  });

  // Lifecycle starts AFTER listen (see main) so autoStartAll cannot starve accept.
  app.startLifecycle = () => {
    pm.startHealthCheckLoop();
    pm.startCronLoop();
    pm.startSilentWindowLoop();
    pm.startSandboxMonitor();
    void pm.autoStartAll().then(started => {
      if (started.length > 0) {
        console.log(`[PolarProcess] 自启动了 ${started.length} 个服务: ${started.join(', ')}`);
      }
    }).catch(err => {
      console.error('[PolarProcess] autoStartAll failed:', err);
    });
  };

  return app;
}

/** Best-effort registry hygiene. Never bind whatever PolarPort returns. */
async function announceFixedPort(port: number): Promise<void> {
  try {
    // Drop sticky alternate ports left from prior claim_port reuse (8000/8030).
    const listed = await fetch(`${POLARPORT_URL}/api/list`, { signal: AbortSignal.timeout(3000) });
    if (listed.ok) {
      const body = (await listed.json()) as
        | Array<{ port?: number; service_name?: string }>
        | { ports?: Array<{ port?: number; service_name?: string }> };
      const rows = Array.isArray(body) ? body : (body.ports ?? []);
      for (const row of rows) {
        if (row.service_name === 'polar-process' && typeof row.port === 'number' && row.port !== port) {
          await fetch(`${POLARPORT_URL}/api/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: row.port }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => undefined);
          console.warn(`[PolarProcess] released stale PolarPort claim on ${row.port}`);
        }
      }
    }

    const r = await fetch(`${POLARPORT_URL}/api/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_name: 'polar-process',
        project: 'PolarProcess',
        preferred_port: port,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return;
    const data = (await r.json()) as { ok?: boolean; port?: number };
    if (data.port != null && data.port !== port) {
      console.warn(
        `[PolarProcess] PolarPort returned ${data.port} for polar-process; releasing sticky claim — pinned to ${port}`,
      );
      await fetch(`${POLARPORT_URL}/api/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: data.port }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
      // Second pass: prefer FIXED_PORT after sticky row is released
      await fetch(`${POLARPORT_URL}/api/allocate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_name: 'polar-process',
          project: 'PolarProcess',
          preferred_port: port,
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
    }
  } catch {
    /* PolarPort unreachable — fine; we already listen on FIXED_PORT */
  }
}

async function registerCapabilities(port: number): Promise<void> {
  const sotagentBase = process.env.SOTAGENT_URL ?? 'http://127.0.0.1:4800';
  try {
    const caps = (await import('../capabilities.json', { with: { type: 'json' } })).default;
    await fetch(`${sotagentBase}/api/capabilities/register-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'PolarProcess',
        service_name: 'polar-process',
        capabilities: caps.capabilities,
      }),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[PolarProcess] Capabilities registered with SOTAgent`);
  } catch {
    console.log(`[PolarProcess] SOTAgent not reachable, skipping capability registration`);
  }
}

async function main(): Promise<void> {
  installExitForensics();
  const proxySnapshot = bootstrapOutboundProxy(process.argv.slice(2));
  if (proxySnapshot.applied) {
    console.log(
      `[PolarProcess] Outbound proxy enabled (${proxySnapshot.source}): HTTP_PROXY=${proxySnapshot.httpProxy ?? '-'} HTTPS_PROXY=${proxySnapshot.httpsProxy ?? '-'}`,
    );
  } else if (proxySnapshot.mode === 'off') {
    console.log('[PolarProcess] Outbound proxy disabled (--no-proxy / POLAR_PROXY_MODE=off)');
  } else if (proxySnapshot.source === 'existing') {
    console.log(
      `[PolarProcess] Outbound proxy inherited from environment: HTTP_PROXY=${proxySnapshot.httpProxy ?? '-'}`,
    );
  } else {
    console.log('[PolarProcess] Outbound proxy not applied (no system proxy detected)');
  }

  const db = new ProcessDB(DB_PATH);

  if (!existsSync(SHARED_DB_PATH)) {
    console.error(`[PolarProcess] FATAL: shared DB not found at ${SHARED_DB_PATH}`);
    process.exit(1);
  }
  const serviceDb = new ServiceDB(SHARED_DB_PATH);
  console.log(`[PolarProcess] ServiceDB opened: ${SHARED_DB_PATH}`);

  if (!Number.isFinite(FIXED_PORT) || FIXED_PORT <= 0) {
    console.error(`[PolarProcess] FATAL: invalid POLARPROCESS_PORT=${process.env.POLARPROCESS_PORT}`);
    process.exit(1);
  }

  const app = createApp(db, serviceDb);
  const port = FIXED_PORT;

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`PolarProcess listening on http://127.0.0.1:${info.port} (pinned, skip PolarPort claim)`);
    app.startLifecycle();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[PolarProcess] FATAL listen error on ${port}:`, err.message);
    process.exit(1);
  });

  void announceFixedPort(port);
  await registerCapabilities(port);
}

if (import.meta.url.endsWith(process.argv[1] ?? '') || (process.argv[1] ?? '').includes('server')) {
  void main();
}
