/**
 * tailscale-client.ts — Tailscale IP query.
 *
 * Migrated from SOTAgent/src/tailscale-client.ts.
 * Queries `tailscale status --json` CLI to discover device IPs.
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execAsync = promisify(exec);

interface ITailscaleStatus {
  Self: { TailscaleIPs: string[]; HostName: string };
  Peer: Record<string, { TailscaleIPs: string[]; HostName: string; Online: boolean }>;
}

let _cache: { data: ITailscaleStatus; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

let _resolvedBin: string | null = null;

function resolveTailscaleBin(): string {
  if (_resolvedBin) return _resolvedBin;

  try {
    execSync('tailscale version', { timeout: 3_000, stdio: 'pipe' });
    _resolvedBin = 'tailscale';
    return _resolvedBin;
  } catch { /* fallthrough */ }

  const appStorePath = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (fs.existsSync(appStorePath)) {
    _resolvedBin = appStorePath;
    return _resolvedBin;
  }

  _resolvedBin = 'tailscale';
  return _resolvedBin;
}

async function queryTailscaleStatus(): Promise<ITailscaleStatus | null> {
  const cached = _cache;
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const bin = resolveTailscaleBin();
    const { stdout } = await execAsync(`${bin} status --json`, { timeout: 5_000 });
    const data = JSON.parse(stdout) as ITailscaleStatus;
    _cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return data;
  } catch {
    return null;
  }
}

export async function getLocalTailscaleIP(): Promise<string | null> {
  const status = await queryTailscaleStatus();
  if (!status) return null;
  return status.Self.TailscaleIPs.find((ip) => !ip.includes(':')) ?? null;
}

export async function getPeerTailscaleIP(deviceId: string): Promise<string | null> {
  const status = await queryTailscaleStatus();
  if (!status) return null;

  const normalized = deviceId.toLowerCase().replace(/-/g, '');

  for (const peer of Object.values(status.Peer)) {
    const peerName = peer.HostName.toLowerCase().replace(/-/g, '').replace(/ /g, '');
    if (peerName.includes(normalized) || normalized.includes(peerName)) {
      return peer.TailscaleIPs.find((ip) => !ip.includes(':')) ?? null;
    }
  }
  return null;
}

export async function isTailscaleAvailable(): Promise<boolean> {
  return (await queryTailscaleStatus()) !== null;
}

export function clearTailscaleCache(): void {
  _cache = null;
}
