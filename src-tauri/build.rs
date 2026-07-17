fn main() {
    // Re-embed the Windows exe icon whenever it changes (otherwise an
    // incremental build keeps the previously-compiled icon resource).
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
