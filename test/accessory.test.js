import assert from 'node:assert/strict';
import test from 'node:test';

import { OneCVacuumAccessory } from '../dist/accessory.js';

const logger = () => ({ debug() {}, error() {}, info() {}, warn() {} });

function createFixture(t, config = {}, propertyValues = {}) {
  const intervals = [];
  t.mock.method(global, 'setInterval', (_callback, delay) => {
    intervals.push(delay);
    return { timer: 'interval' };
  });
  t.mock.method(global, 'setTimeout', () => ({ timer: 'timeout' }));

  const updates = [];
  const actions = [];
  const matter = {
    clusterNames: {
      RvcOperationalState: 'rvcOperationalState',
      RvcRunMode: 'rvcRunMode',
      RvcCleanMode: 'rvcCleanMode',
      PowerSource: 'powerSource',
    },
    updateAccessoryState: async (uuid, cluster, payload) => {
      updates.push({ uuid, cluster, payload });
    },
  };
  const client = {
    doAction: async (...args) => { actions.push(args); },
    getProperties: async () => [
      { siid: 3, piid: 1, value: propertyValues.fault ?? 0 },
      { siid: 3, piid: 2, value: propertyValues.status ?? 1 },
      { siid: 2, piid: 1, value: propertyValues.battery ?? 80 },
      { siid: 2, piid: 2, value: propertyValues.charging ?? 2 },
      { siid: 18, piid: 6, value: propertyValues.cleaningMode ?? 3 },
    ],
    setProperty: async () => {},
  };
  const accessory = { UUID: 'test-vacuum', handlers: {} };
  const platform = { api: { matter }, config, log: logger() };

  const controller = new OneCVacuumAccessory(platform, accessory, client);
  return { accessory, actions, controller, intervals, updates };
}

test('maps a cleaning status response to Matter clusters', async t => {
  const { controller, updates } = createFixture(t);

  await controller.updateStatus();

  assert.deepEqual(updates, [
    { uuid: 'test-vacuum', cluster: 'rvcOperationalState', payload: { operationalState: 1 } },
    { uuid: 'test-vacuum', cluster: 'rvcRunMode', payload: { currentMode: 1 } },
    { uuid: 'test-vacuum', cluster: 'rvcCleanMode', payload: { currentMode: 3 } },
    { uuid: 'test-vacuum', cluster: 'powerSource', payload: { batPercentRemaining: 160, batChargeState: 3 } },
  ]);
});

test('go-home handler sends the expected action and optimistic Matter state', async t => {
  const { accessory, actions, updates } = createFixture(t);

  await accessory.handlers.rvcOperationalState.goHome();

  assert.deepEqual(actions, [[2, 1]]);
  assert.deepEqual(updates, [
    { uuid: 'test-vacuum', cluster: 'rvcOperationalState', payload: { operationalState: 64 } },
    { uuid: 'test-vacuum', cluster: 'rvcRunMode', payload: { currentMode: 0 } },
  ]);
});

test('checks Mi Home state every five seconds without changing the full poll interval', t => {
  const { intervals } = createFixture(t, { pollInterval: 60 });

  assert.deepEqual(intervals, [60000, 5000]);
});

test('reports charging and fully charged dock states to Matter', async t => {
  const charging = createFixture(t, {}, { status: 6, charging: 1, battery: 75 });
  await charging.controller.updateStatus();
  assert.deepEqual(charging.updates[0], {
    uuid: 'test-vacuum',
    cluster: 'rvcOperationalState',
    payload: { operationalState: 65 },
  });

  const docked = createFixture(t, {}, { status: 13, charging: 4, battery: 100 });
  await docked.controller.updateStatus();
  assert.deepEqual(docked.updates[0], {
    uuid: 'test-vacuum',
    cluster: 'rvcOperationalState',
    payload: { operationalState: 66 },
  });
});
