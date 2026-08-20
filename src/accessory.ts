import { OneCMatterPlatform } from './platform.js';
import { XiaomiLocalClient } from './mi-local.js';

const SUCTION_MODES = [
  { label: 'Quiet', mode: 0, modeTags: [{ value: 2 }, { value: 16385 }] },
  { label: 'Default', mode: 1, modeTags: [{ value: 0 }, { value: 16385 }] },
  { label: 'Medium', mode: 2, modeTags: [{ value: 16384 }, { value: 16385 }] },
  { label: 'Strong', mode: 3, modeTags: [{ value: 7 }, { value: 16385 }] },
];

const DEVICE_STATUS_LABELS: Record<number, string> = {
  1: 'Cleaning',
  2: 'Idle',
  3: 'Paused',
  4: 'Error',
  5: 'Returning to dock',
  6: 'Charging',
  7: 'Mopping',
  12: 'Sweeping and mopping',
  13: 'Charging complete',
  14: 'Upgrading',
};

const FAULT_LABELS: Record<number, string> = {
  0: 'No fault',
  1: 'Left wheel error',
  2: 'Right wheel error',
  3: 'Cliff sensor error',
  4: 'Low battery',
  5: 'Main brush blocked',
  6: 'Side brush error',
  7: 'Fan error',
  8: 'Dust compartment or water tank issue',
  9: 'Charging error',
  10: 'Water shortage',
  11: 'Vacuum is lifted or off the ground',
  12: 'Stuck or trapped',
  13: 'Restricted area or virtual wall detected',
  14: 'Dust compartment missing',
  15: 'Water tank missing',
};

// Segment ("room") cleaning, exposed via the Matter ServiceArea cluster.
// dreame.vacuum.mc1808: action siid 18 / aiid 1 (start-clean), with work-mode
// piid 1 = 18 (room mode) and clean-info piid 21 = {"selects":[[id,repeats,suction,3,1]]}.
const CLEAN_SIID = 18;
const CLEAN_START_AIID = 1;
const WORK_MODE_PIID = 1;
const CLEAN_INFO_PIID = 21;
const WORK_MODE_ROOM = 18;
const DEFAULT_MATTER_UPDATE_TIMEOUT_MS = 10000;
const DEFAULT_STATUS_UPDATE_WATCHDOG_MS = 90000;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
// Mi Home changes are not pushed over the local miIO transport. Keep the
// Matter view fresh enough that Siri does not act on an old docked state.
const EXTERNAL_STATE_POLL_INTERVAL_MS = 5000;

const CONSUMABLES = [
  { key: 'mainBrush', label: 'Main brush', siid: 26, timePiid: 1, lifePiid: 2 },
  { key: 'filter', label: 'Filter', siid: 27, timePiid: 2, lifePiid: 1 },
  { key: 'sideBrush', label: 'Side brush', siid: 28, timePiid: 1, lifePiid: 2 },
];

function describeStatus(status: number | undefined) {
  return status === undefined ? 'Unknown' : DEVICE_STATUS_LABELS[status] || `Unknown status ${status}`;
}

function describeFault(fault: number | undefined) {
  return fault === undefined ? 'Unknown fault' : FAULT_LABELS[fault] || `Unknown fault ${fault}`;
}

export class OneCVacuumAccessory {
  private isUpdating = false;
  private updateStartedAt = 0;
  private updateToken = 0;
  private consecutiveFailures = 0;
  private nextAllowedUpdate = 0;
  private readonly lastClusterState = new Map<string, string>();
  private lastConsumableSummary = '';
  private readonly matterUpdateTimeoutMs: number;
  private readonly statusUpdateWatchdogMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly platform: OneCMatterPlatform,
    private readonly accessory: any, // MatterAccessory
    private readonly client: XiaomiLocalClient,
  ) {
    const matter = this.platform.api.matter!;
    const matterUpdateTimeout = Number(this.platform.config.matterUpdateTimeout);
    const statusUpdateWatchdog = Number(this.platform.config.statusUpdateWatchdog);
    this.matterUpdateTimeoutMs = Number.isFinite(matterUpdateTimeout) && matterUpdateTimeout > 0
      ? matterUpdateTimeout
      : DEFAULT_MATTER_UPDATE_TIMEOUT_MS;
    this.statusUpdateWatchdogMs = Number.isFinite(statusUpdateWatchdog) && statusUpdateWatchdog > 0
      ? statusUpdateWatchdog
      : DEFAULT_STATUS_UPDATE_WATCHDOG_MS;
    const pollInterval = Number(this.platform.config.pollInterval);
    this.pollIntervalMs = (Number.isFinite(pollInterval) && pollInterval > 0
      ? pollInterval
      : DEFAULT_POLL_INTERVAL_SECONDS) * 1000;

    // Register handlers
    this.accessory.handlers = {
      identify: {
        identify: async () => {
          this.platform.log.info('Matter: Identify command');
          await this.client.doAction(17, 1); // Locate vacuum / play prompt
          this.scheduleStatusUpdate();
        },
      },
      rvcOperationalState: {
        pause: async () => {
          this.platform.log.info('Matter: Pause command');
          await this.client.doAction(3, 2); // Stop Sweep
          await this.setOptimisticRunState(2, 0);
          this.scheduleStatusUpdate();
        },
        resume: async () => {
          this.platform.log.info('Matter: Resume command');
          await this.client.doAction(3, 1); // Start Sweep
          await this.setOptimisticRunState(1, 1);
          this.scheduleStatusUpdate();
        },
        goHome: async () => {
          this.platform.log.info('Matter: Go Home command');
          await this.client.doAction(2, 1); // Start Charge
          await this.setOptimisticRunState(64, 0);
          this.scheduleStatusUpdate();
        },
      },
      rvcRunMode: {
        changeToMode: async (args: any) => {
          this.platform.log.info('Matter: Change to mode', args.newMode);
          if (args.newMode === 1) {
            await this.client.doAction(3, 1); // Start Sweep
            await this.setOptimisticRunState(1, 1);
          } else {
            await this.client.doAction(3, 2); // Stop Sweep
            await this.setOptimisticRunState(0, 0);
          }
          this.scheduleStatusUpdate();
        },
      },
      rvcCleanMode: {
        changeToMode: async (args: any) => {
          const nextMode = Number(args.newMode);
          if (!SUCTION_MODES.some(mode => mode.mode === nextMode)) {
            throw new Error(`Unsupported suction mode: ${args.newMode}`);
          }

          this.platform.log.info(`Matter: Change suction mode to ${SUCTION_MODES[nextMode].label}`);
          await this.client.setProperty(18, 6, nextMode); // Cleaning Mode / suction level
          const matter = this.platform.api.matter!;
          await this.updateClusterState(matter.clusterNames.RvcCleanMode, { currentMode: nextMode }, true);
          this.scheduleStatusUpdate(500);
        },
      },
    };

    // Experimental, opt-in: room-by-room cleaning via the ServiceArea cluster.
    const rooms = Array.isArray(this.platform.config.rooms) ? this.platform.config.rooms : [];
    if (this.platform.config.enableRoomCleaning === true && rooms.length > 0) {
      this.accessory.handlers.serviceArea = {
        selectAreas: async (args: any) => {
          const areaIds: number[] = Array.isArray(args?.newAreas) ? args.newAreas : [];
          await this.startRoomClean(areaIds);
        },
      };
    }

    // Polling
    setInterval(() => this.updateStatus(), this.pollIntervalMs);
    setInterval(() => this.updateStatus(false, false), EXTERNAL_STATE_POLL_INTERVAL_MS);
    setTimeout(() => this.updateStatus(), 1000); // Initial update after Matter registration settles
  }

  private scheduleStatusUpdate(delay = 500) {
    setTimeout(() => this.updateStatus(true), delay);
  }

  private async startRoomClean(areaIds: number[]) {
    if (!areaIds.length) {
      this.platform.log.warn('Room clean requested with no areas selected; ignoring.');
      return;
    }

    const repeats = Number(this.platform.config.roomCleanRepeats ?? 1);
    const suction = Number(this.platform.config.roomCleanSuction ?? 2);
    // mc1808 selects tuple: [roomId, repeats, suction, 3, 1]
    const selects = areaIds.map(id => [Number(id), repeats, suction, 3, 1]);
    const cleanInfo = JSON.stringify({ selects });

    this.platform.log.info(`Matter: Start room clean for area(s) ${areaIds.join(', ')} -> ${cleanInfo}`);
    await this.client.doAction(CLEAN_SIID, CLEAN_START_AIID, [
      { piid: WORK_MODE_PIID, value: WORK_MODE_ROOM },
      { piid: CLEAN_INFO_PIID, value: cleanInfo },
    ]);
    await this.setOptimisticRunState(1, 1);
    this.scheduleStatusUpdate();
  }

  private async setOptimisticRunState(operationalState: number, currentMode: number) {
    const matter = this.platform.api.matter!;
    await this.updateClusterState(matter.clusterNames.RvcOperationalState, { operationalState }, true);
    await this.updateClusterState(matter.clusterNames.RvcRunMode, { currentMode }, true);
  }

  private async updateClusterState(clusterName: string, payload: Record<string, any>, force = false) {
    const cacheKey = `${this.accessory.UUID}:${clusterName}`;
    const serialized = JSON.stringify(payload);

    if (!force && this.lastClusterState.get(cacheKey) === serialized) {
      return;
    }

    const matter = this.platform.api.matter!;
    await this.withTimeout(
      matter.updateAccessoryState(this.accessory.UUID, clusterName, payload),
      this.matterUpdateTimeoutMs,
      `Matter state update for ${clusterName}`,
    );
    this.lastClusterState.set(cacheKey, serialized);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async updateStatus(force = false, includeConsumables = true) {
    const now = Date.now();
    if (this.isUpdating) {
      const updateAge = now - this.updateStartedAt;
      if (updateAge > this.statusUpdateWatchdogMs) {
        this.platform.log.warn(`Previous status update has been running for ${Math.round(updateAge / 1000)} seconds; allowing a fresh poll.`);
        this.isUpdating = false;
      } else {
        this.platform.log.debug('Skipping status update because a previous update is still running');
        return;
      }
    }
    if (!force && now < this.nextAllowedUpdate) {
      this.platform.log.debug('Skipping status update during temporary backoff');
      return;
    }

    this.isUpdating = true;
    this.updateStartedAt = now;
    const token = ++this.updateToken;
    try {
      const props = await this.client.getProperties([
        { siid: 3, piid: 1 }, // Fault
        { siid: 3, piid: 2 }, // Status
        { siid: 2, piid: 1 }, // Battery Level
        { siid: 2, piid: 2 }, // Charging State
        { siid: 18, piid: 6 }, // Cleaning Mode / suction level
        ...(includeConsumables ? CONSUMABLES.flatMap(item => [
          { siid: item.siid, piid: item.timePiid },
          { siid: item.siid, piid: item.lifePiid },
        ]) : []),
      ]);

      if (!props || props.length === 0) return;

      const fault = props.find((p: any) => p.siid === 3 && p.piid === 1)?.value;
      const status = props.find((p: any) => p.siid === 3 && p.piid === 2)?.value;
      const battery = props.find((p: any) => p.siid === 2 && p.piid === 1)?.value;
      const charging = props.find((p: any) => p.siid === 2 && p.piid === 2)?.value;
      const cleaningMode = props.find((p: any) => p.siid === 18 && p.piid === 6)?.value;
      const consumables = CONSUMABLES.map(item => ({
        ...item,
        time: props.find((p: any) => p.siid === item.siid && p.piid === item.timePiid)?.value,
        life: props.find((p: any) => p.siid === item.siid && p.piid === item.lifePiid)?.value,
      }));

      this.platform.log.debug(`Vacuum status: ${describeStatus(status)}, fault: ${describeFault(fault)}`);
      if (fault !== undefined && fault !== 0) {
        this.platform.log.warn(`Vacuum fault ${fault}: ${describeFault(fault)}`);
      }
      if (includeConsumables) {
        this.logConsumables(consumables);
      }
      this.consecutiveFailures = 0;
      this.nextAllowedUpdate = 0;

      // Map Dreame 1C status to Matter RVC Operational State.
      // DeviceStatus: 1 Sweeping, 2 Idle, 3 Paused, 4 Error, 5 GoCharging, 6 Charging, 12 SweepingAndMopping, 13 ChargingComplete
      // Matter OperationalState: 0: Stopped, 1: Running, 2: Paused, 3: Error,
      // 64: SeekingCharger, 65: Charging, 66: Docked.
      let opState = 0;
      if ([1, 7, 12].includes(status)) opState = 1;
      else if (status === 3) opState = 2;
      else if (status === 4 || (fault !== undefined && fault !== 0)) opState = 3;
      else if (status === 5) opState = 64;
      else if (status === 13 || (charging === 4 && battery === 100)) opState = 66;
      else if (status === 6 || [1, 5].includes(charging)) opState = 65;

      const matter = this.platform.api.matter!;
      await this.updateClusterState(matter.clusterNames.RvcOperationalState, {
        operationalState: opState,
      }, force);

      // Map to RvcRunMode
      await this.updateClusterState(matter.clusterNames.RvcRunMode, {
        currentMode: [1, 7, 12].includes(status) ? 1 : 0,
      }, force);

      if (cleaningMode !== undefined) {
        await this.updateClusterState(matter.clusterNames.RvcCleanMode, {
          currentMode: cleaningMode,
        }, force);
      }

      // Battery (PowerSource cluster)
      if (battery !== undefined) {
        // Matter batPercentRemaining is 0-200 (0.5% steps)
        let chargeState = 0; // Unknown
        if ([1, 5].includes(charging)) {
          chargeState = 1; // IsCharging
        } else if (charging === 4) {
          chargeState = battery === 100 ? 2 : 1; // IsAtFullCharge or IsCharging
        } else if (charging === 2) {
          chargeState = 3; // IsNotCharging
        }

        await this.updateClusterState(matter.clusterNames.PowerSource, {
          batPercentRemaining: battery * 2,
          batChargeState: chargeState,
        }, force);
      }

    } catch (e: any) {
      this.consecutiveFailures++;
      const baseInterval = Math.min(this.pollIntervalMs, EXTERNAL_STATE_POLL_INTERVAL_MS);
      const backoff = Math.min(baseInterval * 2 ** this.consecutiveFailures, 5 * 60 * 1000);
      this.nextAllowedUpdate = Date.now() + backoff;
      this.platform.log.error('Error updating status:', e.message);
      this.platform.log.warn(`Backing off vacuum polling for ${Math.round(backoff / 1000)} seconds`);
    } finally {
      if (token === this.updateToken) {
        this.isUpdating = false;
        this.updateStartedAt = 0;
      }
    }
  }

  private logConsumables(consumables: Array<{ label: string; time: any; life: any }>) {
    if (this.platform.config.enableConsumableLogs === false) {
      return;
    }

    const summary = consumables
      .filter(item => item.life !== undefined || item.time !== undefined)
      .map(item => `${item.label}: ${item.life ?? '?'}% (${item.time ?? '?'}h left)`)
      .join(', ');

    if (!summary || summary === this.lastConsumableSummary) {
      return;
    }

    this.lastConsumableSummary = summary;
    this.platform.log.info(`Vacuum consumables: ${summary}`);

    const lowThreshold = Number(this.platform.config.lowConsumableThreshold ?? 20);
    for (const item of consumables) {
      if (typeof item.life === 'number' && item.life <= lowThreshold) {
        this.platform.log.warn(`${item.label} life is low: ${item.life}% remaining`);
      }
    }
  }
}
