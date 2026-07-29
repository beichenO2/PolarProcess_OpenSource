import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  notifyPolarBudgetRegister,
  notifyPolarBudgetUnregister,
} from '../../src/polar-budget-notify.js';

describe('polar-budget-notify', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.POLARBUDGET_URL;
  });

  it('POSTs registry on register when pid is valid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.POLARBUDGET_URL = 'http://127.0.0.1:11060';

    await notifyPolarBudgetRegister('autooffice', 4242, 'service_bg');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11060/api/registry');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      kind: 'service',
      ref: 'autooffice',
      pid: 4242,
      pool: 'service_bg',
    });
  });

  it('swallows fetch errors on register', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(notifyPolarBudgetRegister('x', 1)).resolves.toBeUndefined();
  });

  it('DELETEs by-ref on unregister', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await notifyPolarBudgetUnregister('autooffice');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://127.0.0.1:11060/api/registry/by-ref/autooffice',
    );
  });
});
