// Tauri desktop shell for the TorahAnytime Downloader.
//
// On launch it spawns the bundled Node proxy (the `ta-proxy` sidecar running
// the esbuild-bundled server.cjs) on 127.0.0.1:8787, and the window loads the
// loading page (../dist/index.html), which polls the proxy and redirects to it
// once it's up. The sidecar is killed when the app exits.

use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Sidecar(Mutex<Option<CommandChild>>);

const PROXY_PORT: &str = "8787";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // The proxy server bundle is shipped as a Tauri resource.
            let script = app
                .path()
                .resource_dir()?
                .join("sidecar")
                .join("server.cjs");

            let (mut rx, child) = app
                .shell()
                .sidecar("ta-proxy")?
                .args([script.to_string_lossy().to_string(), PROXY_PORT.to_string()])
                .spawn()?;

            app.state::<Sidecar>().0.lock().unwrap().replace(child);

            // Forward sidecar output to the log (debug builds).
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                            if let Ok(line) = String::from_utf8(bytes) {
                                let line = line.trim_end();
                                if !line.is_empty() {
                                    log::info!("[proxy] {}", line);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            });

            // Create the main window with a navigation guard that locks the app to
            // localhost: any attempt to navigate to another domain is cancelled and
            // re-issued through the local proxy (http://127.0.0.1:8787/__ta/<host>/…),
            // so the webview can never leave the machine's own proxy.
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Torah Anytime Downloader")
                .inner_size(1200.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .on_navigation(move |url| {
                    // Allow in-app schemes and the loopback origin itself.
                    let scheme = url.scheme();
                    if scheme == "tauri" || scheme == "data" || scheme == "blob" || scheme == "about" {
                        return true;
                    }
                    let host = url.host_str().unwrap_or("");
                    if host == "127.0.0.1" || host == "localhost" {
                        return true;
                    }
                    // Any external http(s) target: rewrite through the proxy and
                    // navigate there instead of following the original URL.
                    if (scheme == "http" || scheme == "https") && !host.is_empty() {
                        let query = url.query().map(|q| format!("?{}", q)).unwrap_or_default();
                        let target = format!(
                            "http://127.0.0.1:{}/__ta/{}{}{}",
                            PROXY_PORT,
                            host,
                            url.path(),
                            query
                        );
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let (Some(win), Ok(dest)) =
                                (handle.get_webview_window("main"), target.parse())
                            {
                                let _ = win.navigate(dest);
                            }
                        });
                    }
                    false
                })
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
