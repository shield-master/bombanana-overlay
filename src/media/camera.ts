export interface CameraManager {
  stream: MediaStream | null;
  deviceId: string | null;
  start(deviceId?: string): Promise<MediaStream>;
  stop(): void;
  listDevices(): Promise<MediaDeviceInfo[]>;
}

export class LocalCamera implements CameraManager {
  stream: MediaStream | null = null;
  deviceId: string | null = null;

  async listDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  async start(deviceId?: string): Promise<MediaStream> {
    this.stop();
    this.deviceId = deviceId ?? null;

    const constraints: MediaStreamConstraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    return this.stream;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}