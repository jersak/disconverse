// Chosen input/output devices, remembered per browser. An empty id means "system default".

export type DeviceKind = "audioinput" | "audiooutput" | "videoinput";

export type DeviceSettings = Record<DeviceKind, string>;

export type DeviceLists = Record<DeviceKind, MediaDeviceInfo[]>;

const STORAGE_KEY = "disconverse.devices";
const NO_DEVICES: DeviceSettings = { audioinput: "", audiooutput: "", videoinput: "" };

export function loadDeviceSettings(): DeviceSettings {
  try {
    return { ...NO_DEVICES, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") };
  } catch {
    return NO_DEVICES;
  }
}

export function saveDeviceSettings(settings: DeviceSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: choices just won't persist.
  }
}

/** Safari (and so every iPhone browser) can't choose the output device. */
export const canPickOutput = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** deviceId for capture constraints: undefined lets the browser use the system default. */
export const deviceIdOrDefault = (id: string) => id || undefined;
