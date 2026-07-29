/**
 * Best-effort PolarBudget registry notifications.
 * Failures never block PolarProcess start/stop.
 */

export type BudgetPool = 'service_bg' | 'service_fg';

export async function notifyPolarBudgetRegister(
  serviceId: string,
  pid: number,
  pool: BudgetPool = 'service_bg',
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const base = process.env.POLARBUDGET_URL ?? 'http://127.0.0.1:11060';
  try {
    await fetch(`${base}/api/registry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'service',
        ref: serviceId,
        pid,
        pool,
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Budget optional at boot — do not fail service start
  }
}

export async function notifyPolarBudgetUnregister(serviceId: string): Promise<void> {
  const base = process.env.POLARBUDGET_URL ?? 'http://127.0.0.1:11060';
  try {
    await fetch(`${base}/api/registry/by-ref/${encodeURIComponent(serviceId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Best-effort
  }
}
