//! Tiny WebSocket relay that the host runs in-process.
//!
//! It is deliberately dumb: it hands out peer ids, tells everybody who is in the
//! room, and forwards opaque JSON payloads. All game rules live in the frontend,
//! where the host client is authoritative.
//!
//! Wire protocol
//!   server -> client  {"t":"hello","id":"p1","hostId":"p1"}
//!                     {"t":"peers","peers":["p1","p2"],"hostId":"p1"}
//!                     {"t":"relay","from":"p2","data":{...}}
//!   client -> server  {"t":"send","to":"p3","data":{...}}   // omit `to` to broadcast

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

type Tx = mpsc::UnboundedSender<Message>;

#[derive(Default)]
struct Room {
    peers: HashMap<String, Tx>,
    /// Join order. The first entry is the host, so the room survives the host leaving.
    order: Vec<String>,
}

impl Room {
    fn host_id(&self) -> String {
        self.order.first().cloned().unwrap_or_default()
    }

    fn broadcast_roster(&self) {
        let msg = Message::text(
            json!({ "t": "peers", "peers": self.order, "hostId": self.host_id() }).to_string(),
        );
        for tx in self.peers.values() {
            let _ = tx.send(msg.clone());
        }
    }
}

/// Binds the relay and returns the port it actually listens on.
/// Pass `port = 0` to let the OS pick a free one.
pub async fn serve(port: u16) -> std::io::Result<(u16, tauri::async_runtime::JoinHandle<()>)> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    let bound = listener.local_addr()?.port();
    let room: Arc<Mutex<Room>> = Arc::new(Mutex::new(Room::default()));

    let task = tauri::async_runtime::spawn(async move {
        let seq = AtomicU64::new(0);
        while let Ok((stream, _)) = listener.accept().await {
            let id = format!("p{}", seq.fetch_add(1, Ordering::Relaxed) + 1);
            let room = room.clone();
            tauri::async_runtime::spawn(async move {
                handle_peer(stream, id, room).await;
            });
        }
    });

    Ok((bound, task))
}

async fn handle_peer(stream: TcpStream, id: String, room: Arc<Mutex<Room>>) {
    let _ = stream.set_nodelay(true);
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (mut sink, mut incoming) = ws.split();
    let (tx, mut outbox) = mpsc::unbounded_channel::<Message>();

    let writer = tauri::async_runtime::spawn(async move {
        while let Some(msg) = outbox.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    {
        let mut r = room.lock().await;
        r.peers.insert(id.clone(), tx.clone());
        r.order.push(id.clone());
        let _ = tx.send(Message::text(
            json!({ "t": "hello", "id": id, "hostId": r.host_id() }).to_string(),
        ));
        r.broadcast_roster();
    }

    while let Some(Ok(raw)) = incoming.next().await {
        let text = match &raw {
            Message::Text(_) => raw.to_text().unwrap_or_default().to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
        if msg.get("t").and_then(Value::as_str) != Some("send") {
            continue;
        }
        let data = msg.get("data").cloned().unwrap_or(Value::Null);
        let out = Message::text(json!({ "t": "relay", "from": id, "data": data }).to_string());

        let r = room.lock().await;
        match msg.get("to").and_then(Value::as_str) {
            Some(target) => {
                if let Some(peer) = r.peers.get(target) {
                    let _ = peer.send(out);
                }
            }
            None => {
                for (peer_id, peer) in r.peers.iter() {
                    if peer_id != &id {
                        let _ = peer.send(out.clone());
                    }
                }
            }
        }
    }

    {
        let mut r = room.lock().await;
        r.peers.remove(&id);
        r.order.retain(|p| p != &id);
        r.broadcast_roster();
    }
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;

    type Client = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn next_json(ws: &mut Client) -> Value {
        loop {
            let msg = ws.next().await.expect("поток закрылся").expect("ошибка кадра");
            if msg.is_text() {
                return serde_json::from_str(msg.to_text().unwrap()).unwrap();
            }
        }
    }

    /// Проходит весь путь: выдача id, рассылка списка, адресная и широковещательная пересылка.
    #[tokio::test]
    async fn relays_between_three_peers() {
        let (port, _task) = serve(0).await.expect("порт не занялся");
        let url = format!("ws://127.0.0.1:{port}");

        let (mut a, _) = connect_async(&url).await.unwrap();
        let hello_a = next_json(&mut a).await;
        assert_eq!(hello_a["id"], "p1");
        assert_eq!(hello_a["hostId"], "p1", "первый вошедший становится хостом");
        assert_eq!(next_json(&mut a).await["peers"], json!(["p1"]));

        let (mut b, _) = connect_async(&url).await.unwrap();
        assert_eq!(next_json(&mut b).await["id"], "p2");
        // Оба узнают о пополнении.
        assert_eq!(next_json(&mut a).await["peers"], json!(["p1", "p2"]));
        assert_eq!(next_json(&mut b).await["peers"], json!(["p1", "p2"]));

        let (mut c, _) = connect_async(&url).await.unwrap();
        assert_eq!(next_json(&mut c).await["id"], "p3");
        assert_eq!(next_json(&mut a).await["peers"], json!(["p1", "p2", "p3"]));
        assert_eq!(next_json(&mut b).await["peers"], json!(["p1", "p2", "p3"]));
        assert_eq!(next_json(&mut c).await["peers"], json!(["p1", "p2", "p3"]));

        // Адресно: offer от p1 к p3 не должен попасть к p2.
        a.send(Message::text(
            json!({ "t": "send", "to": "p3", "data": { "k": "rtc" } }).to_string(),
        ))
        .await
        .unwrap();
        let got = next_json(&mut c).await;
        assert_eq!(got["t"], "relay");
        assert_eq!(got["from"], "p1");
        assert_eq!(got["data"]["k"], "rtc");

        // Широковещательно: снимок состояния уходит всем, кроме автора.
        a.send(Message::text(
            json!({ "t": "send", "data": { "k": "state", "phase": "game" } }).to_string(),
        ))
        .await
        .unwrap();
        assert_eq!(next_json(&mut b).await["data"]["phase"], "game");
        assert_eq!(next_json(&mut c).await["data"]["phase"], "game");

        // Уход участника виден остальным.
        drop(c);
        assert_eq!(next_json(&mut a).await["peers"], json!(["p1", "p2"]));

        // Предыдущая широковещалка не должна была вернуться отправителю:
        // сразу после ухода p3 у p1 в очереди оказался именно новый список.
    }
}
