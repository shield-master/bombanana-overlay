/**
 * Стабильный id этого клиента на время жизни процесса. В отличие от id,
 * который раньше назначал брокер на каждый `new Peer()`, этот переживает
 * переподключение — хост узнаёт вернувшегося гостя по тому же id и не
 * теряет его роль/место в списке игроков.
 */
let clientId: string | null = null;

export function getClientId(): string {
  if (!clientId) clientId = crypto.randomUUID();
  return clientId;
}
