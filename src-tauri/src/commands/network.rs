use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;
use tauri::State;
use crate::signaling;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub port: u16,
    pub ip: String,
    /// Внешний IP, если его удалось определить — для друзей из другой сети.
    pub public_ip: Option<String>,
    /// Удалось ли автоматически пробросить порт на роутере через UPnP.
    pub upnp_ok: bool,
}

fn detect_lan_ip() -> String {
    // Проверяем привязку к стандартным приватным подсетям (UDP connect в Rust не отправляет сетевые пакеты)
    let targets = [
        "192.168.1.1:80",
        "192.168.0.1:80",
        "10.0.0.1:80",
        "172.16.0.1:80",
    ];

    for target in targets {
        if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    let ip = addr.ip().to_string();
                    // Игнорируем loopback, APIPA (169.254) и виртуальные TUN/Bench подсети (198.18)
                    if !ip.starts_with("127.") 
                        && !ip.starts_with("198.18.") 
                        && !ip.starts_with("169.254.") 
                    {
                        return ip;
                    }
                }
            }
        }
    }

    // Резервный поиск через внешний маршрут
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|sock| {
            sock.connect("8.8.8.8:80")?;
            sock.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[tauri::command]
pub fn lan_ip() -> String {
    detect_lan_ip()
}

/// Синхронный HTTP GET без TLS и внешних зависимостей — чтобы узнать внешний IP,
/// даже если UPnP на роутере не поддерживается или выключен.
fn fetch_public_ip_blocking() -> Option<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let addr = "api.ipify.org:80".to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok()?;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n")
        .ok()?;

    let mut resp = String::new();
    stream.read_to_string(&mut resp).ok()?;
    let body = resp.split("\r\n\r\n").nth(1)?.trim();
    let looks_like_ip = !body.is_empty() && body.len() <= 15 && body.split('.').count() == 4;
    looks_like_ip.then(|| body.to_string())
}

async fn fetch_public_ip() -> Option<String> {
    tokio::task::spawn_blocking(fetch_public_ip_blocking).await.ok().flatten()
}

fn upnp_search_options() -> igd_next::SearchOptions {
    igd_next::SearchOptions {
        timeout: Some(Duration::from_secs(3)),
        single_search_timeout: Some(Duration::from_secs(3)),
        ..Default::default()
    }
}

/// Best-effort: просим роутер сам открыть порт (UPnP IGD), чтобы хосту не пришлось
/// лезть в настройки вручную. Если роутер не поддерживает UPnP или он выключен — просто false.
async fn try_upnp_map(port: u16) -> bool {
    let Ok(local_ip) = detect_lan_ip().parse::<Ipv4Addr>() else { return false };

    let gateway = match igd_next::aio::tokio::search_gateway(upnp_search_options()).await {
        Ok(g) => g,
        Err(_) => return false,
    };

    let local_addr = SocketAddr::from((local_ip, port));
    gateway
        .add_port(igd_next::PortMappingProtocol::TCP, port, local_addr, 0, "Bombanana Overlay")
        .await
        .is_ok()
}

async fn try_upnp_unmap(port: u16) {
    if let Ok(gateway) = igd_next::aio::tokio::search_gateway(upnp_search_options()).await {
        let _ = gateway.remove_port(igd_next::PortMappingProtocol::TCP, port).await;
    }
}

#[tauri::command]
pub async fn host_start(port: u16, state: State<'_, AppState>) -> Result<HostInfo, String> {
    if state.server.lock().unwrap().is_some() {
        return Err("Лобби уже запущено".into());
    }
    let (bound, task) = signaling::serve(port)
        .await
        .map_err(|e| format!("Не удалось занять порт {port}: {e}"))?;

    *state.server.lock().unwrap() = Some(task);

    let (upnp_ok, public_ip) = tokio::join!(try_upnp_map(bound), fetch_public_ip());
    *state.upnp_port.lock().unwrap() = upnp_ok.then_some(bound);

    Ok(HostInfo {
        port: bound,
        ip: detect_lan_ip(),
        public_ip,
        upnp_ok,
    })
}

#[tauri::command]
pub async fn host_stop(state: State<'_, AppState>) -> Result<(), ()> {
    if let Some(task) = state.server.lock().unwrap().take() {
        task.abort();
    }
    let mapped = state.upnp_port.lock().unwrap().take();
    if let Some(port) = mapped {
        try_upnp_unmap(port).await;
    }
    Ok(())
}