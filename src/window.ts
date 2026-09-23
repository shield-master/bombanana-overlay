import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { overlaySize } from "./config";

export class WindowManager {
  private appWindow = getCurrentWindow();

  /** Разово выставляет стартовый размер/позицию оверлея. Дальше окно тянет мышью сам игрок. */
  async enterOverlay(tilesCount: number) {
    const size = overlaySize(tilesCount);
    await invoke("set_overlay", { on: true, width: size.width, height: size.height });
  }

  async exitOverlay() {
    await invoke("set_overlay", { on: false, width: 0, height: 0 });
  }

  /**
   * Подгоняет размер оверлея под число плиток — например, подключился третий
   * игрок. Через тот же set_overlay, что и вход: он каждый раз пересчитывает
   * позицию от левого нижнего угла, поэтому окно растёт вверх, а не съезжает
   * вниз за край экрана при простом ресайзе с фиксированным левым верхним углом.
   */
  async fitOverlay(tilesCount: number) {
    const size = overlaySize(tilesCount);
    await invoke("set_overlay", { on: true, width: size.width, height: size.height });
  }

  async minimize() {
    await this.appWindow.minimize();
  }

  async close() {
    await this.appWindow.close();
  }
}
