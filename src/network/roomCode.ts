/**
 * Короткий код комнаты = id пира в PeerJS. Никакой адрес в нём не зашит —
 * брокер сам находит хоста по этому коду из любой сети, так что генерируем
 * просто случайную человекочитаемую строку.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // без 0/O/1/I/L — легко спутать на слух и на глаз

export function generateRoomCode(): string {
  const group = () =>
    Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  return `${group()}-${group()}`;
}

/** Нормализует введённый код и проверяет, что это похоже на код комнаты (правила id PeerJS). */
export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  if (!/^[A-Z0-9]+(?:[ _-][A-Z0-9]+)*$/.test(code)) return null;
  return code;
}
