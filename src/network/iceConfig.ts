/**
 * Общий список ICE-серверов для всех WebRTC-соединений в приложении: и для
 * PeerJS-канала сигналинга (peerBroker.ts), и для собственных видео-соединений
 * (videoMesh.ts). STUN пробивает большинство NAT, TURN — резервный маршрут
 * через сервер, когда прямое соединение между двумя разными сетями не удаётся.
 */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/**
 * Свой coturn на VPS — основной релей, не завязан на чужой рейт-лимит/блокировки.
 * Логин/пароль читаются из .env (см. .env.example) и подставляются Vite на
 * этапе сборки — секрет не лежит в исходниках и не попадает в публичный репо.
 */
const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME ?? "";
const TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL ?? "";

const OWN_TURN_SERVERS: RTCIceServer[] = TURN_USERNAME
  ? [
      {
        urls: ["turn:turn.sync-file.com:3478", "turn:turn.sync-file.com:3478?transport=tcp"],
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
      },
      {
        urls: ["turns:turn.sync-file.com:5349?transport=tcp"],
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
      },
    ]
  : [];

/**
 * Бесплатный публичный TURN-релей Open Relay Project — доп. резерв поверх
 * своего coturn. TURN поверх TLS (turns:, порт 443) — настоящий TLS-хендшейк,
 * неотличим снаружи от обычного HTTPS; в отличие от turn:...?transport=tcp
 * (голый STUN/TURN-протокол без шифрования, DPI режет его так же легко, как
 * обычный UDP) это тот же трюк, что у DoH с DNS-запросами. Отдельная запись,
 * потому что смешивать turn: и turns: в одном RTCIceServer нельзя.
 */
const FALLBACK_TURN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: ["turns:openrelay.metered.ca:443?transport=tcp"],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/**
 * Тестовый рубильник: "relay" запрещает WebRTC использовать host/srflx-кандидаты
 * вообще — соединение пойдёт ТОЛЬКО через TURN, даже если оба узла в одной
 * локальной сети. Заодно убирает из списка все запасные сервера (бесплатные
 * публичные + дефолтные TURN от PeerJS в peerBroker.ts), чтобы соединению
 * физически неоткуда было пройти, кроме как через свой coturn — единственный
 * способ железно доказать, что связь идёт именно через него, а не напрямую.
 * В проде должно быть "all" и все резервы на месте — иначе каждое соединение
 * искусственно тормозим через сторонний сервер там, где прекрасно работает
 * напрямую, и теряем резервные пути на случай, если свой coturn отвалится.
 */
const DEBUG_FORCE_RELAY = false;

export const ICE_SERVERS: RTCIceServer[] = DEBUG_FORCE_RELAY
  ? OWN_TURN_SERVERS
  : [...STUN_SERVERS, ...OWN_TURN_SERVERS, ...FALLBACK_TURN_SERVERS];

/** Готовый RTCConfiguration, опционально с дополнительными ICE-серверами (например, от PeerJS). */
export function buildIceConfig(extra: RTCIceServer[] = []): RTCConfiguration {
  return {
    iceServers: [...(DEBUG_FORCE_RELAY ? [] : extra), ...ICE_SERVERS],
    iceTransportPolicy: DEBUG_FORCE_RELAY ? "relay" : "all",
  };
}
