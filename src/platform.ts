import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { isIP } from 'node:net';
import { OneCVacuumAccessory } from './accessory.js';
import { XiaomiLocalClient } from './mi-local.js';

export class OneCMatterPlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];
  public client?: XiaomiLocalClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', async () => {
      this.log.debug('Executed didFinishLaunching callback');
      await this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    if (!this.config.ip || !this.config.token || !this.config.deviceId) {
      this.log.error('Missing Local LAN configuration (IP, Token, or Device ID). Please check your config.json');
      return;
    }

    const tokenRegex = /^[a-fA-F0-9]{32}$/;
    const deviceIdRegex = /^\d+$/;

    if (isIP(this.config.ip) !== 4) {
      this.log.error(`Invalid IP address format: "${this.config.ip}". Please check your config.json`);
      return;
    }

    if (!tokenRegex.test(this.config.token)) {
      this.log.error('Invalid Token format. The local token must be exactly 32 hexadecimal characters.');
      return;
    }

    if (!deviceIdRegex.test(String(this.config.deviceId))) {
      this.log.error(`Invalid Device ID (DID) format: "${this.config.deviceId}". The device ID must be a numeric value.`);
      return;
    }

    this.client = new XiaomiLocalClient(this.log, this.config);

    const uuid = this.api.hap.uuid.generate(String(this.config.deviceId));
    
    // Check if we should use Matter
    if (this.api.isMatterEnabled()) {
      this.log.info('Matter is enabled. Registering as Matter accessory.');

      // Unregister any cached legacy HAP accessories to avoid duplicates/stale accessories in Homebridge
      if (this.accessories.length > 0) {
        this.log.info(`Removing ${this.accessories.length} cached legacy HAP accessories.`);
        this.api.unregisterPlatformAccessories('homebridge-1c-matter', 'OneCMatter', this.accessories);
        this.accessories.length = 0;
      }

      let firmwareRevision = '1.0.0';
      try {
        const info = await this.client.getDeviceInfo();
        if (info && info.fw_ver) {
          firmwareRevision = info.fw_ver;
          this.log.info(`Discovered vacuum firmware version: ${firmwareRevision}`);
        }
      } catch (e: any) {
        this.log.warn(`Could not fetch vacuum firmware version dynamically at startup (${e.message}). Using default "1.0.0".`);
      }

      const matter = this.api.matter!;
      const displayName = this.config.name || 'Xiaomi 1C Vacuum';
      
      const accessory: any = {
        UUID: uuid,
        displayName,
        deviceType: matter.deviceTypes.RoboticVacuumCleaner,
        manufacturer: 'Xiaomi',
        model: '1C Vacuum (MC1808)',
        serialNumber: String(this.config.deviceId),
        firmwareRevision,
        context: { device: { ip: this.config.ip, did: this.config.deviceId } },
        clusters: {
          rvcOperationalState: {
            operationalState: 0, // Stopped
            operationalStateList: [
              { operationalStateId: 0 }, // Stopped
              { operationalStateId: 1 }, // Running
              { operationalStateId: 2 }, // Paused
              { operationalStateId: 3 }, // Error
              { operationalStateId: 64 }, // SeekingCharger
            ],
          },
          rvcRunMode: {
            currentMode: 0,
            supportedModes: [
              { label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] }, // RvcRunMode.ModeTag.Idle
              { label: 'Cleaning', mode: 1, modeTags: [{ value: 16385 }] }, // RvcRunMode.ModeTag.Cleaning
            ],
          },
          rvcCleanMode: {
            currentMode: 1,
            supportedModes: [
              { label: 'Quiet', mode: 0, modeTags: [{ value: 2 }, { value: 16385 }] },
              { label: 'Default', mode: 1, modeTags: [{ value: 0 }, { value: 16385 }] },
              { label: 'Medium', mode: 2, modeTags: [{ value: 16384 }, { value: 16385 }] },
              { label: 'Strong', mode: 3, modeTags: [{ value: 7 }, { value: 16385 }] },
            ],
          },
          powerSource: {
            batPercentRemaining: 200,
            batChargeState: 0,
          },
        },
      };

      // Experimental, opt-in: expose configured rooms as Matter service areas.
      const rooms = Array.isArray(this.config.rooms) ? this.config.rooms : [];
      if (this.config.enableRoomCleaning === true && rooms.length > 0) {
        accessory.clusters.serviceArea = {
          supportedAreas: rooms.map((room: any) => ({
            areaId: Number(room.id),
            mapId: null,
            areaInfo: {
              locationInfo: {
                locationName: String(room.name),
                floorNumber: null,
                areaType: null,
              },
              landmarkInfo: null,
            },
          })),
          selectedAreas: [],
        };
        this.log.info(`Experimental room cleaning enabled with ${rooms.length} room(s).`);
      }

      new OneCVacuumAccessory(this, accessory, this.client);
      await matter.registerPlatformAccessories('homebridge-1c-matter', 'OneCMatter', [accessory]);
    } else {
      this.log.warn('Matter is NOT enabled. This plugin is optimized for Matter but will fallback to legacy mode if implemented.');
      // Legacy fallback could be implemented here if desired, but user wants Matter.
    }
  }
}
