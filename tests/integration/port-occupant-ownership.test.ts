import { describe, expect, it } from 'vitest';
import { isManagedPortOccupant } from '../../src/process-manager.js';

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
});
