// Keep the console window away from the packaged build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=UseSkiaRenderer --enable-features=MediaFoundationVideoCapture"
    );
    
    bombanana_lib::run()
}
