/**
 * Публичный фасад сетевого слоя — всё остальное приложение работает только
 * через эти экспорты и не знает про PeerJS, heartbeat или grace-периоды.
 */
export { Signal, type SignalHandlers } from "./signal";
export { VideoMesh, type MeshHandlers } from "./videoMesh";
export { generateRoomCode, normalizeRoomCode } from "./roomCode";
