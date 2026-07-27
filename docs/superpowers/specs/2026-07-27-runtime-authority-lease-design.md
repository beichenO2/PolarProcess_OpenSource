# Runtime Authority Lease Design

## Goal

Keep PolarPort leases for slow-starting services and prevent PolarProcess's internal watchdog from starting a second copy of either runtime authority.

## Evidence and scope

PolarPort stores SQLite timestamps with `datetime('now')`, which is UTC but has no timezone suffix. PolarProcess's watchdog parses those strings as local time, so fresh leases can appear hours old. During a Docker warm-up, the TCP probe can then run before the container binds and release a valid lease. The same watchdog discovers PolarProcess and PolarPort from `polaris.json` and may execute their `npm start` commands, although launchd is the required authority-service supervisor.

## Design

1. Add one pure timestamp helper that treats SQLite date-time strings as UTC when they have no explicit timezone. Use it for stale-lease age calculations. A timestamp with an explicit offset remains unchanged.
2. Exclude `PolarPort` and `PolarProcess` authority projects from the application watchdog's target discovery. Their launchd labels remain the only restart path; application services keep the existing watchdog behavior.
3. Preserve existing TCP probing and lease release semantics. A lease is released only when its corrected age exceeds the stale threshold and the port is not reachable. No PID ownership exception or unmanaged restart is added.

## Error handling

- Invalid or missing timestamps are treated as non-stale so the watchdog fails closed rather than releasing an unknown lease.
- Authority projects are skipped only by exact case-insensitive project-directory/name match (`PolarPort` or `PolarProcess`); similarly named application projects are unaffected.

## Verification

- Unit tests cover UTC-without-offset, explicit-offset, invalid timestamp, and authority-target filtering behavior.
- Existing PolarProcess contract/integration tests and TypeScript build must remain green.
- After deployment, re-allocate Sub2API's 8085 through PolarPort, observe two watchdog intervals, and verify one active lease plus healthy PolarProcess/Docker/Sub2API endpoints.
