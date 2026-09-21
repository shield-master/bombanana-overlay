// Keep the console window away from the packaged build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bombanana_lib::run()
}
