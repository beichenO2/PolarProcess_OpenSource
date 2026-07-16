import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessDB } from '../../src/db.js';
import { ServiceDB } from '../../src/service-db.js';
import { SOTAgentDB } from '../../../SOTAgent/src/db.js';
import { ProcessManager } from '../../src/process-manager.js';
import { ResourceScheduler } from '../../src/scheduler.js';
import { ResourceProfiler } from '../../src/profiler.js';
import { createApp } from '../../src/server.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_DB = path.join(os.tmpdir(), `polarprocess-test-${Date.now()}.sqlite`);
const TEST_SERVICE_DIR = path.join(os.tmpdir(), `polarprocess-services-test-${Date.now()}`);

describe('PolarProcess integration', () => {
  let db: ProcessDB;
  let serviceDb: ServiceDB;

  beforeAll(() => {
    db = new ProcessDB(TEST_DB);
    const schemaOwner = new SOTAgentDB(TEST_SERVICE_DIR);
    schemaOwner.close();
    serviceDb = new ServiceDB(path.join(TEST_SERVICE_DIR, 'resources.sqlite'));
  });

  afterAll(() => {
    db.close();
    serviceDb.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
    fs.rmSync(TEST_SERVICE_DIR, { recursive: true, force: true });
  });

  describe('ProcessManager', () => {
    it('registers and lists services', async () => {
      const pm = new ProcessManager(serviceDb, {});
      serviceDb.registerService({
        id: 'test-svc-1',
        name: 'Test Service',
        command: 'echo hello',
        device_id: 'any',
      });

      const services = pm.getAllStatus();
      expect(services.length).toBe(1);
      expect(services[0]!.id).toBe('test-svc-1');
      expect(services[0]!.status).toBe('stopped');
    });

    it('stops a service', async () => {
      const pm = new ProcessManager(serviceDb, {});
      const result = await pm.stopService('test-svc-1');
      expect(result.ok).toBe(true);
    });

    it('reports a missing process as not alive', () => {
      const pm = new ProcessManager(serviceDb, {});
      expect(pm.isProcessAlivePublic(2_147_483_647)).toBe(false);
    });
  });

  describe('ResourceScheduler', () => {
    it('creates a task', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const result = scheduler.createTask({
        task_type: 'test-task',
        command: 'echo test',
        priority: 5,
      });
      expect(result.ok).toBe(true);
      expect(result.task_id).toBeTruthy();
    });

    it('lists tasks', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const tasks = scheduler.listTasks('queued');
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it('cancels a task', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const tasks = scheduler.listTasks('queued');
      const taskId = tasks[0]!.task_id;
      const result = scheduler.cancelTask(taskId);
      expect(result.ok).toBe(true);
    });

    it('returns scheduler status', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const status = scheduler.getStatus();
      expect(status).toHaveProperty('idle');
      expect(status).toHaveProperty('running_tasks');
      expect(status).toHaveProperty('queue_depth');
    });
  });

  describe('Hono app', () => {
    it('health check returns ok', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/health'));
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toBe('polar-process');
    });

    it('GET /api/services returns array', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/services'));
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/tasks returns array', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/tasks'));
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/scheduler/status returns status', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/scheduler/status'));
      const body = await res.json();
      expect(body).toHaveProperty('idle');
      expect(body).toHaveProperty('running_tasks');
      expect(body).toHaveProperty('queue_depth');
    });

    it('POST /api/services/register registers a service', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/services/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'integration-test-svc',
          name: 'Integration Test Service',
          command: 'sleep 999',
          device_id: 'local',
        }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('POST /api/services/register rejects active runtime identity changes', async () => {
      serviceDb.registerService({
        id: 'http-active-svc',
        name: 'HTTP Active Service',
        command: 'sleep 999',
        work_dir: '/tmp/http-active-old',
        device_id: 'any',
        start_script_dir: '-',
      });
      serviceDb.updateServiceStatus('http-active-svc', 'running', { pid: 2_147_483_647 });
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/services/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'http-active-svc',
          name: 'HTTP Active Service',
          command: 'sleep 999',
          work_dir: '/tmp/http-active-new',
          device_id: 'any',
          start_script_dir: '-',
        }),
      }));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body).toMatchObject({ ok: false, code: 'SERVICE_RUNNING' });
      expect(serviceDb.getService('http-active-svc')?.work_dir).toBe('/tmp/http-active-old');
    });

    it('POST /api/services/:id/reconcile-children validates explicit PIDs', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request(
        'http://localhost/api/services/http-active-svc/reconcile-children',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ));
      expect(res.status).toBe(400);
    });

    it('GET /api/processes/:id returns 404 for unknown id', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/processes/nonexistent'));
      expect(res.status).toBe(404);
    });

    it('POST /api/services/:id/start returns result', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/services/integration-test-svc/start', { method: 'POST' }));
      const body = await res.json();
      expect(body).toHaveProperty('ok');
    });

    it('POST /api/services/:id/stop returns result', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/services/integration-test-svc/stop', { method: 'POST' }));
      const body = await res.json();
      expect(body).toHaveProperty('ok');
    });

    it('POST /api/services/:id/restart returns result', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/services/integration-test-svc/restart', { method: 'POST' }));
      const body = await res.json();
      expect(body).toHaveProperty('ok');
    });

    it('POST /api/tasks/create creates a task via HTTP', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'http-test', command: 'echo hi', priority: 3 }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.task_id).toBeTruthy();
    });

    it('GET /api/tasks/:id/status returns task or 404', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/tasks/nonexistent-task/status'));
      expect(res.status).toBe(404);
    });

    it('POST /api/tasks/:id/cancel via HTTP', async () => {
      const app = createApp(db, serviceDb);
      const createRes = await app.fetch(new Request('http://localhost/api/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'cancel-test', command: 'sleep 99', priority: 1 }),
      }));
      const created = await createRes.json();
      const cancelRes = await app.fetch(new Request('http://localhost/api/tasks/' + created.task_id + '/cancel', { method: 'POST' }));
      const body = await cancelRes.json();
      expect(body.ok).toBe(true);
    });

    it('GET /api/scheduler/queue returns array', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/scheduler/queue'));
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('POST /api/scheduler/config updates config', async () => {
      const app = createApp(db, serviceDb);
      const res = await app.fetch(new Request('http://localhost/api/scheduler/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_concurrent: 4 }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });
});
