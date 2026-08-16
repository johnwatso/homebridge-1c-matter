import assert from 'node:assert/strict';
import test from 'node:test';

import { OneCVacuumAccessory } from '../dist/accessory.js';

const logger = () => ({ debug() {}, error() {}, info() {}, warn() {} });

function createFixture(t, config = {}) {
  t.mock.method(global, 'setInterval', () => ({ timer: 'interval' }));
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
      { siid: 3, piid: 1, value: 0 },
      { siid: 3, piid: 2, value: 1 },
      { siid: 2, piid: 1, value: 80 },
      { siid: 2, piid: 2, value: 2 },
      { siid: 18, piid: 6, value: 3 },
    ],
    setProperty: async () => {},
  };
  const accessory = { UUID: 'test-vacuum', handlers: {} };
  const platform = { api: { matter }, config, log: logger() };

  const controller = new OneCVacuumAccessory(platform, accessory, client);
  return { accessory, actions, controller, updates };
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
