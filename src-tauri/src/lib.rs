// Tauri desktop shell for the TorahAnytime Downloader.
//
// On launch it spawns the bundled Node proxy (the `ta-proxy` sidecar running
// the esbuild-bundled server.cjs) on 127.0.0.1:8787, and the window loads the
// loading page (../dist/index.html), which polls the proxy and redirects to it
// once it's up. The sidecar is killed when the app fully quits.
//
// It doubles as a regular desktop TorahAnytime app: closing the window hides it
// to the system tray instead of quitting, so audio/video keeps playing in the
// background. Right-click the tray icon (or "Quit") to actually exit.

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Sidecar(Mutex<Option<CommandChild>>);

const PROXY_PORT: &str = "8787";
const MAIN_WINDOW: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep playback alive while the window is hidden to the tray. WebView2/Chromium
    // otherwise throttles background timers and suspends occluded/hidden renderers,
    // which freezes audio and video. Must be set before the webview is created.
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion",
    );

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

            // resource_dir() returns a \\?\-verbatim path; Node (e.g. the 20.x
            // runtime CI bundles) can't load a main module through that prefix
            // (EISDIR in resolveMainPath), so hand it a plain path.
            let script = script.to_string_lossy().to_string();
            let script = if let Some(rest) = script.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{}", rest)
            } else if let Some(rest) = script.strip_prefix(r"\\?\") {
                rest.to_string()
            } else {
                script
            };

            let (mut rx, child) = app
                .shell()
                .sidecar("ta-proxy")?
                .args([script, PROXY_PORT.to_string()])
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
            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
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
                                (handle.get_webview_window(MAIN_WINDOW), target.parse())
                            {
                                let _ = win.navigate(dest);
                            }
                        });
                    }
                    false
                })
                .build()?;

            // Close-to-tray: hide the window instead of destroying it, so the proxy
            // and the webview (and therefore any lecture that's playing) keep running
            // in the background. The only real exit is the tray's "Quit".
            let win = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win.hide();
                }
            });

            build_tray(app.handle())?;

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

// System tray: a "Show" / "Quit" menu, plus left-click to restore. "Quit" is the
// only path that actually exits (and thus kills the proxy sidecar) — the window's
// X button only hides to the tray, keeping playback alive.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Show Torah Anytime", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_i, &sep, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Torah Anytime Downloader")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_and_focus(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_and_focus(tray.app_handle()),
            _ => {}
        });

    // Reuse the bundled app icon; degrade gracefully if it's missing.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show_and_focus(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
