import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  composeRuntimeIdentityFromSsot,
  isManagedComposePortBinding,
  isManagedPortOccupant,
} from '../../src/process-manager.js';

describe('managed port occupant ownership', () => {
  it('does not adopt or kill a host container port proxy', () => {
    expect(isManagedPortOccupant({
      serviceId: 'web-native-web-qa',
      managedPid: 1200,
      occupantPid: 2200,
      occupantIsDescendant: false,
      matchedServiceId: null,
    })).toBe(false);
  });

  it('accepts the managed process, its descendant, or a verified same-service process', () => {
    expect(isManagedPortOccupant({
      serviceId: 'web-native-web-qa', managedPid: 1200, occupantPid: 1200,
      occupantIsDescendant: false, matchedServiceId: null,
    })).toBe(true);
    expect(isManagedPortOccupant({
      serviceId: 'web-native-web-qa', managedPid: 1200, occupantPid: 1201,
      occupantIsDescendant: true, matchedServiceId: null,
    })).toBe(true);
    expect(isManagedPortOccupant({
      serviceId: 'web-native-web-qa', managedPid: 1200, occupantPid: 1202,
      occupantIsDescendant: false, matchedServiceId: 'web-native-web-qa',
    })).toBe(true);
  });

  it('recognizes only an exact running Compose port binding in the registered work directory', () => {
    const container = {
      state: { running: true },
      labels: {
        'com.docker.compose.project': 'sub2api-local',
        'com.docker.compose.project.working_dir': '~/Desktop/sub2api',
        'com.docker.compose.project.config_files': '~/Desktop/sub2api/docker-compose.yml',
      },
      portBindings: {
        '8080/tcp': [{ hostIp: '127.0.0.1', hostPort: '8085' }],
      },
    };

    expect(isManagedComposePortBinding({
      occupantCommand: '/Applications/Docker.app/Contents/MacOS/com.docker.backend services',
      serviceWorkDir: '~/Desktop/sub2api',
      port: 8085,
      expectedProject: 'sub2api-local',
      expectedConfigFiles: ['~/Desktop/sub2api/docker-compose.yml'],
      containers: [container],
    })).toBe(true);
    expect(isManagedComposePortBinding({
      occupantCommand: '/Applications/Docker.app/Contents/MacOS/com.docker.backend services',
      serviceWorkDir: '~/Desktop/other',
      port: 8085,
      expectedProject: 'sub2api-local',
      expectedConfigFiles: ['~/Desktop/other/docker-compose.yml'],
      containers: [container],
    })).toBe(false);
    expect(isManagedComposePortBinding({
      occupantCommand: '/usr/local/bin/unrelated-server',
      serviceWorkDir: '~/Desktop/sub2api',
      port: 8085,
      expectedProject: 'sub2api-local',
      expectedConfigFiles: ['~/Desktop/sub2api/docker-compose.yml'],
      containers: [container],
    })).toBe(false);
    expect(isManagedComposePortBinding({
      occupantCommand: '/Applications/Docker.app/Contents/MacOS/com.docker.backend services',
      serviceWorkDir: '~/Desktop/sub2api',
      port: 8000,
      expectedProject: 'sub2api-local',
      expectedConfigFiles: ['~/Desktop/sub2api/docker-compose.yml'],
      containers: [container],
    })).toBe(false);
    expect(isManagedComposePortBinding({
      occupantCommand: '/Applications/Docker.app/Contents/MacOS/com.docker.backend services',
      serviceWorkDir: '~/Desktop/sub2api',
      port: 8085,
      expectedProject: 'sub2api-local',
      expectedConfigFiles: ['~/Desktop/sub2api/docker-compose.yml'],
      containers: [container, structuredClone(container)],
    })).toBe(false);
    expect(isManagedComposePortBinding({
      occupantCommand: '/Applications/Docker.app/Contents/MacOS/com.docker.backend services',
      serviceWorkDir: '~/Desktop/sub2api',
      port: 8085,
      expectedProject: 'different-project',
      expectedConfigFiles: ['~/Desktop/sub2api/docker-compose.yml'],
      containers: [container],
    })).toBe(false);
    expect(isManagedComposePortBinding({
      occupantCommand: '/Applications/Docker.app/Contents/MacOS/com.docker.backend services',
      serviceWorkDir: '~/Desktop/sub2api',
      port: 8085,
      expectedProject: 'sub2api-local',
      expectedConfigFiles: ['~/Desktop/sub2api/compose.other.yml'],
      containers: [container],
    })).toBe(false);
  });

  it('derives Compose identity only from a matching explicit project SSoT contract', () => {
    const ssot = {
      service_management: {
        service_id: 'sub2api',
        start_command: 'bash Start/start.sh',
        process_mode: 'foreground_command',
        compose_project: 'sub2api-local',
        compose_files: ['docker-compose.yml'],
      },
    };
    expect(composeRuntimeIdentityFromSsot({
      serviceId: 'sub2api',
      registeredCommand: 'bash Start/start.sh',
      serviceWorkDir: '~/Desktop/sub2api',
      ssot,
    })).toEqual({
      project: 'sub2api-local',
      configFiles: ['~/Desktop/sub2api/docker-compose.yml'],
    });
    expect(composeRuntimeIdentityFromSsot({
      serviceId: 'other',
      registeredCommand: 'bash Start/start.sh',
      serviceWorkDir: '~/Desktop/sub2api',
      ssot,
    })).toBeNull();
    expect(composeRuntimeIdentityFromSsot({
      serviceId: 'sub2api',
      registeredCommand: 'npm run dev',
      serviceWorkDir: '~/Desktop/sub2api',
      ssot,
    })).toBeNull();
    expect(composeRuntimeIdentityFromSsot({
      serviceId: 'sub2api',
      registeredCommand: 'bash Start/start.sh',
      serviceWorkDir: '~/Desktop/sub2api',
      ssot: { service_management: { ...ssot.service_management, compose_files: ['../other.yml'] } },
    })).toBeNull();
  });

  it('records Compose reattachment through the existing service-event contract', () => {
    const source = fs.readFileSync(new URL('../../src/process-manager.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("event_type: 'compose_reattach'");
    expect(source).toMatch(/event_type: 'script_start',[\s\S]*Keeping registered Compose binding/u);
  });
});
