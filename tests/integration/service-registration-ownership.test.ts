import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOTAgentDB } from '../../../SOTAgent/src/db.js';
import {
  ProcessManager,
  getRuntimeRegistrationChanges,
  registeredCommandMatchesRuntime,
} from '../../src/process-manager.js';
import { ServiceDB } from '../../src/service-db.js';

const TEST_DIR = path.join(os.tmpdir(), `polarprocess-ownership-${Date.now()}`);

describe('service registration ownership', () => {
  let serviceDb: ServiceDB;

  beforeAll(() => {
    const schemaOwner = new SOTAgentDB(TEST_DIR);
    schemaOwner.close();
    serviceDb = new ServiceDB(path.join(TEST_DIR, 'resources.sqlite'));
  });

  afterAll(() => {
    serviceDb.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('rejects runtime identity changes while a service is active', () => {
    serviceDb.registerService({
      id: 'active-registration-test',
      name: 'Active Registration Test',
      command: 'sleep 30',
      work_dir: TEST_DIR,
      device_id: 'any',
      start_script_dir: '-',
    });
    serviceDb.updateServiceStatus('active-registration-test', 'running', { pid: 2_147_483_647 });

    const pm = new ProcessManager(serviceDb, {});
    const result = pm.registerService({
      id: 'active-registration-test',
      name: 'Active Registration Test',
      command: 'sleep 30',
      work_dir: `${TEST_DIR}-new`,
      device_id: 'any',
      start_script_dir: '-',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'SERVICE_RUNNING',
      changed_fields: ['work_dir'],
    });
    expect(serviceDb.getService('active-registration-test')?.work_dir).toBe(TEST_DIR);
  });

  it('allows idempotent registration while a service is active', () => {
    const pm = new ProcessManager(serviceDb, {});
    const result = pm.registerService({
      id: 'active-registration-test',
      name: 'Active Registration Test',
      command: 'sleep 30',
      work_dir: TEST_DIR,
      device_id: 'any',
      start_script_dir: '-',
    });

    expect(result.ok).toBe(true);
  });

  it('computes runtime changes using database registration semantics', () => {
    const existing = serviceDb.getService('active-registration-test')!;
    expect(getRuntimeRegistrationChanges(existing, {
      id: existing.id,
      name: existing.name,
      command: existing.command,
      work_dir: existing.work_dir,
      device_id: existing.device_id,
      start_script_dir: existing.start_script_dir,
      port: null,
    })).toEqual([]);
  });

  it('matches an exec/env wrapper only when the full runtime command is preserved', () => {
    expect(registeredCommandMatchesRuntime(
      "exec env TAOCI_LOCAL_QA=1 bash Start/start-taoci-next.sh",
      'bash Start/start-taoci-next.sh',
    )).toBe(true);
    expect(registeredCommandMatchesRuntime('bash Start/start-taoci-next.sh', 'bash other.sh')).toBe(false);
  });

  it('reaps only the explicitly verified duplicate and keeps the registered PID alive', async () => {
    let current: ChildProcess | undefined;
    let stale: ChildProcess | undefined;
    try {
      current = spawn('sleep', ['30'], { cwd: TEST_DIR, stdio: 'ignore' });
      stale = spawn('sleep', ['30'], { cwd: TEST_DIR, stdio: 'ignore' });
      expect(current.pid).toBeTypeOf('number');
      expect(stale.pid).toBeTypeOf('number');

      serviceDb.registerService({
        id: 'reconcile-test',
        name: 'Reconcile Test',
        command: 'sleep 30',
        work_dir: TEST_DIR,
        device_id: 'any',
        start_script_dir: '-',
      });
      serviceDb.updateServiceStatus('reconcile-test', 'running', { pid: current.pid! });

      const pm = new ProcessManager(serviceDb, {});
      const result = await pm.reconcileServiceChildren('reconcile-test', [stale.pid!]);

      expect(result).toMatchObject({
        ok: true,
        kept_pid: current.pid,
        reaped_pids: [stale.pid],
      });
      expect(pm.isProcessAlivePublic(current.pid!)).toBe(true);
      expect(pm.isProcessAlivePublic(stale.pid!)).toBe(false);
    } finally {
      if (current?.pid) {
        try { process.kill(current.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
      if (stale?.pid) {
        try { process.kill(stale.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it('refuses an explicit PID whose runtime command does not match', async () => {
    let current: ChildProcess | undefined;
    let unrelated: ChildProcess | undefined;
    try {
      current = spawn('sleep', ['30'], { cwd: TEST_DIR, stdio: 'ignore' });
      unrelated = spawn('sleep', ['29'], { cwd: TEST_DIR, stdio: 'ignore' });
      serviceDb.registerService({
        id: 'reconcile-rejection-test',
        name: 'Reconcile Rejection Test',
        command: 'sleep 30',
        work_dir: TEST_DIR,
        device_id: 'any',
        start_script_dir: '-',
      });
      serviceDb.updateServiceStatus('reconcile-rejection-test', 'running', { pid: current.pid! });

      const pm = new ProcessManager(serviceDb, {});
      const result = await pm.reconcileServiceChildren(
        'reconcile-rejection-test',
        [unrelated.pid!],
      );

      expect(result.ok).toBe(false);
      expect(result.reaped_pids).toEqual([]);
      expect(pm.isProcessAlivePublic(current.pid!)).toBe(true);
      expect(pm.isProcessAlivePublic(unrelated.pid!)).toBe(true);
    } finally {
      for (const child of [current, unrelated]) {
        if (!child?.pid) continue;
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it('does not spawn again when a tracked child is alive but the DB says starting', async () => {
    const pm = new ProcessManager(serviceDb, {});
    let firstPid: number | undefined;
    let secondPid: number | undefined;
    try {
      serviceDb.registerService({
        id: 'tracked-child-start-test',
        name: 'Tracked Child Start Test',
        command: 'sleep 30',
        work_dir: TEST_DIR,
        device_id: 'any',
        start_script_dir: '-',
      });
      const first = await pm.startService('tracked-child-start-test');
      firstPid = first.pid;
      expect(first).toMatchObject({ ok: true, pid: expect.any(Number) });

      serviceDb.updateServiceStatus('tracked-child-start-test', 'starting');
      const second = await pm.startService('tracked-child-start-test');
      secondPid = second.pid;

      expect(second).toMatchObject({ ok: true, pid: firstPid });
      expect(serviceDb.getService('tracked-child-start-test')).toMatchObject({
        status: 'running',
        pid: firstPid,
      });
    } finally {
      await pm.stopService('tracked-child-start-test');
      await new Promise(resolve => setTimeout(resolve, 20));
      for (const pid of new Set([firstPid, secondPid])) {
        if (!pid) continue;
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });
});
