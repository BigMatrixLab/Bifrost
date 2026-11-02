fn main() {
    // tauri-build embeds icons/icon.ico in the Windows exe (and the window
    // and tray icon), but by itself only re-runs when tauri.conf.json or the
    // capabilities change. Re-run when an icon changes too, or incremental
    // builds keep showing the old icon.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
