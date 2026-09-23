use std::sync::atomic::AtomicBool;

#[derive(Default)]
pub struct AppState {
    pub overlay: AtomicBool,
    pub clickthrough: AtomicBool,
}