/** Геометрия оверлея — по ней же считается размер окна. */
export const TILE_W = 260;
export const TILE_H = 195;
export const OV_PAD = 10;
export const OV_GAP = 10;
export const OV_CHROME = 54; // шапка в два ряда: код/статус/выход + подсказка шортката
/** С какого числа плиток переключаемся с одного столбца на сетку в 2 колонки (свободное лобби). */
export const GRID_FROM = 4;
const GRID_COLS = 2;

/**
 * До 3 плиток (обычная комната BOMBANANA) — один вертикальный столбец,
 * компактнее сбоку экрана. От 4 и выше (свободное лобби, до 8 человек) —
 * сетка в 2 колонки, иначе окно вытянется на весь экран по высоте.
 */
export function overlaySize(tilesCount: number) {
  const n = Math.max(1, tilesCount);

  if (n < GRID_FROM) {
    return {
      width: OV_PAD * 2 + TILE_W,
      height: Math.max(240, OV_PAD * 2 + OV_CHROME + OV_GAP + n * TILE_H + (n - 1) * OV_GAP),
    };
  }

  const rows = Math.ceil(n / GRID_COLS);
  return {
    width: OV_PAD * 2 + GRID_COLS * TILE_W + (GRID_COLS - 1) * OV_GAP,
    height: OV_PAD * 2 + OV_CHROME + OV_GAP + rows * TILE_H + (rows - 1) * OV_GAP,
  };
}