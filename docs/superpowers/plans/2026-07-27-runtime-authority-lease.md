# Runtime Authority Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop false stale-lease release and prevent the application watchdog from attempting unmanaged authority-service restarts.

**Architecture:** Keep PolarPort as the lease authority and launchd as the PolarPort/PolarProcess supervisor. PolarProcess adds pure parsing/filter helpers; the watchdog uses them without changing port ownership or process adoption rules.

**Tech Stack:** TypeScript, Vitest, Hono runtime, SQLite UTC timestamps.

---

### Task 1: Add failing timestamp and authority-filter tests

**Files:**
- Modify: `tests/integration/port-occupant-ownership.test.ts`
- Modify: `tests/integration/server.test.ts`
- Test target: `src/watchdog.ts`

- [ ] **Step 1: Export pure helpers from `src/watchdog.ts`**

Expose `parseSqliteUtcTimestamp(value: string): number | null` and `isAuthorityProject(name: string): boolean` only after the tests describe their behavior.

- [ ] **Step 2: Write the failing tests**

Add tests asserting that `2026-07-27 04:47:34` is interpreted as UTC, an explicit `+08:00` offset is respected, malformed input returns `null`, and `PolarPort`/`PolarProcess` are authority projects while `TaoCi` is not.

- [ ] **Step 3: Run the focused tests**

Run `npx vitest run tests/integration/port-occupant-ownership.test.ts -t 'timestamp|authority'`.
Expected: FAIL because the helpers do not exist.

### Task 2: Implement the minimal runtime fix

**Files:**
- Modify: `src/watchdog.ts`
- Modify: `polaris.json`

- [ ] **Step 1: Implement the pure helpers**

Parse timezone-less SQLite timestamps as `${value.replace(' ', 'T')}Z`; preserve explicit timezone strings; return `null` for invalid dates.

- [ ] **Step 2: Use the helper in stale-lease sweep**

Treat `null` as non-stale. Compare `Date.now()` to the parsed UTC epoch before TCP probing.

- [ ] **Step 3: Filter authority projects during discovery**

Skip exact `PolarPort` and `PolarProcess` directory/name matches before adding watchdog targets. Leave all application projects unchanged.

- [ ] **Step 4: Mark the SSoT feature tested**

Update the new `polaris.json` feature from `in-progress` to `tested` only after the focused and full tests pass, including dated evidence.

- [ ] **Step 5: Run focused tests and build**

Run `npx vitest run tests/integration/port-occupant-ownership.test.ts -t 'timestamp|authority'`, then `npm test && npm run build`.
Expected: all tests pass and TypeScript exits 0.

### Task 3: Deploy and verify the runtime fix

**Files:**
- Deploy the verified commit to `~/Polarisor/PolarProcess` main; do not edit the live service in place.

- [ ] **Step 1: Commit the isolated change**

Run `git add docs polaris.json src/watchdog.ts tests/integration/port-occupant-ownership.test.ts && git commit -m "fix: keep runtime authority leases under launchd"`.

- [ ] **Step 2: Integrate to live main and rebuild dependencies**

Cherry-pick the commit into the clean live PolarProcess main, run `npm ci --prefer-offline --no-audit`, and `npm run build` there.

- [ ] **Step 3: Restart only PolarProcess through its launchd bootstrap**

Use the existing `com.polarisor.polarprocess` launchd label, then verify `GET http://127.0.0.1:11055/api/health`; do not start `npm start` directly.

- [ ] **Step 4: Re-claim and verify Sub2API 8085**

Use the exact PolarProcess `POST /api/services/sub2api/restart` action. Verify `/health`, three Docker containers, one PolarPort 8085 active record, and two 30-second watchdog intervals without release.

- [ ] **Step 5: Re-run governance audit**

Run `runtime-governance-audit.sh --project ~/Desktop/sub2api` and record the health, lease, service PID, Docker, and audit evidence before moving on.
