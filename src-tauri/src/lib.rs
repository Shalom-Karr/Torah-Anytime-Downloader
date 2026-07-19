// Tauri desktop shell for the TorahAnytime Downloader.
//
// On launch it spawns the bundled Node proxy (the `ta-proxy` sidecar running
// the esbuild-bundled server.cjs) starting at the configured port (default
// 8787). If that port is taken the proxy walks upward until one binds, prints
// "proxy running at http://127.0.0.1:<port>", and the shell parses that line
// and navigates the window there. The sidecar is killed when the app quits.
//
// It doubles as a regular desktop TorahAnytime app: closing the window hides it
// to the system tray instead of quitting (configurable), so audio/video keeps
// playing in the background. The tray also offers Settings (a small embedded
// window backed by settings.json in the app config dir) and Check for Updates
// (queries GitHub releases; downloads and runs the new installer).

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Sidecar(Mutex<Option<CommandChild>>);
struct SettingsState(Mutex<Settings>);
struct ProxyPort(Arc<Mutex<Option<u16>>>);

const DEFAULT_PORT: u16 = 8787;
const MAIN_WINDOW: &str = "main";
const SETTINGS_WINDOW: &str = "settings";
// Update traffic goes through the local proxy sidecar rather than straight to
// GitHub: the proxy already accommodates TLS-intercepting content filters
// (it talks upstream with certificate verification relaxed), which would make
// a direct rustls request fail on exactly the machines this app targets.
const RELEASES_API_PATH: &str =
    "/__ta/api.github.com/repos/Shalom-Karr/Torah-Anytime-Downloader/releases/latest";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    start_port: u16,
    close_to_tray: bool,
    auto_check_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            start_port: DEFAULT_PORT,
            close_to_tray: true,
            auto_check_updates: true,
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_settings(state: State<SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    if settings.start_port < 1024 {
        return Err("Port must be between 1024 and 65535.".into());
    }
    let path = settings_path(&app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
    download_url: Option<String>,
}

fn parse_ver(s: &str) -> (u64, u64, u64) {
    let mut it = s
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.trim().parse::<u64>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

fn proxy_base(app: &AppHandle) -> Result<String, String> {
    let port = app
        .try_state::<ProxyPort>()
        .and_then(|p| *p.0.lock().unwrap())
        .ok_or("the local proxy is not running yet")?;
    Ok(format!("http://127.0.0.1:{}", port))
}

fn fetch_update_info(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let base = proxy_base(app)?;
    let body = ureq::get(&format!("{}{}", base, RELEASES_API_PATH))
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| format!("could not reach GitHub: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let latest = json["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    if latest.is_empty() {
        return Err("no releases found".into());
    }
    let has_update = parse_ver(&latest) > parse_ver(&current);
    // The proxy may or may not have rewritten the asset URL to its own
    // /__ta/<host>/… form — normalize either shape to a local-proxy URL.
    let download_url = json["assets"].as_array().and_then(|assets| {
        assets.iter().find_map(|a| {
            let name = a["name"].as_str().unwrap_or("");
            if !name.to_ascii_lowercase().ends_with("setup.exe") {
                return None;
            }
            let url = a["browser_download_url"].as_str().unwrap_or("");
            if let Some(idx) = url.find("/__ta/") {
                // Already rewritten by the proxy (relative or absolute localhost
                // form) — rebase it onto the current proxy address.
                Some(format!("{}{}", base, &url[idx..]))
            } else if let Some(path) =
                url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))
            {
                Some(format!("{}/__ta/{}", base, path))
            } else {
                None
            }
        })
    });
    Ok(UpdateInfo {
        current,
        latest,
        has_update,
        download_url,
    })
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_update_info(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Only ever download through the local proxy, from GitHub paths.
        let base = proxy_base(&app)?;
        if !url.starts_with(&format!("{}/__ta/github.com/", base))
            && !url.starts_with(&format!("{}/__ta/objects.githubusercontent.com/", base))
            && !url.starts_with(&format!("{}/__ta/release-assets.githubusercontent.com/", base))
        {
            return Err("unexpected download URL".to_string());
        }
        let resp = ureq::get(&url)
            .call()
            .map_err(|e| format!("download failed: {e}"))?;
        let path = std::env::temp_dir().join("Torah-Anytime-Downloader-Setup.exe");
        let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        std::io::copy(&mut resp.into_reader(), &mut file).map_err(|e| e.to_string())?;
        drop(file);
        std::process::Command::new(&path)
            .spawn()
            .map_err(|e| format!("could not launch installer: {e}"))?;
        // Get out of the installer's way once it's on screen.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            app.exit(0);
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

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
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            app_version,
            check_update,
            install_update
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let settings = load_settings(app.handle());
            let start_port = settings.start_port.max(1);
            app.manage(SettingsState(Mutex::new(settings.clone())));

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
                .args([script, start_port.to_string()])
                .spawn()?;

            app.state::<Sidecar>().0.lock().unwrap().replace(child);

            // The proxy may bind a higher port than requested (it walks upward
            // past ports that are in use), so the real port comes from its
            // "proxy running at http://127.0.0.1:<port>" stdout line. Once seen,
            // navigate the main window (still on the loading page) to it.
            let proxy_port: Arc<Mutex<Option<u16>>> = Arc::new(Mutex::new(None));
            app.manage(ProxyPort(proxy_port.clone()));

            let port_state = proxy_port.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let Ok(line) = String::from_utf8(bytes) else { continue };
                            let line = line.trim();
                            if !line.is_empty() {
                                log::info!("[proxy] {}", line);
                            }
                            if port_state.lock().unwrap().is_some() {
                                continue;
                            }
                            let Some(rest) = line.split("proxy running at http://127.0.0.1:").nth(1)
                            else {
                                continue;
                            };
                            let digits: String =
                                rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                            let Ok(port) = digits.parse::<u16>() else { continue };
                            port_state.lock().unwrap().replace(port);
                            let handle = handle.clone();
                            std::thread::spawn(move || {
                                // The window may not have been built yet — wait for it.
                                for _ in 0..200 {
                                    if let Some(win) = handle.get_webview_window(MAIN_WINDOW) {
                                        if let Ok(url) = format!("http://127.0.0.1:{}/", port).parse()
                                        {
                                            let _ = win.navigate(url);
                                        }
                                        return;
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                }
                            });
                        }
                        CommandEvent::Stderr(bytes) => {
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
            // re-issued through the local proxy (http://127.0.0.1:<port>/__ta/<host>/…),
            // so the webview can never leave the machine's own proxy.
            let handle = app.handle().clone();
            let nav_port = proxy_port.clone();
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
                        let port = nav_port.lock().unwrap().unwrap_or(start_port);
                        let query = url.query().map(|q| format!("?{}", q)).unwrap_or_default();
                        let target = format!(
                            "http://127.0.0.1:{}/__ta/{}{}{}",
                            port,
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

            // Close-to-tray (configurable): hide the window instead of destroying
            // it, so the proxy and the webview (and any lecture that's playing)
            // keep running. With the setting off, closing the window quits.
            let win = window.clone();
            let close_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let close_to_tray = close_handle
                        .state::<SettingsState>()
                        .0
                        .lock()
                        .unwrap()
                        .close_to_tray;
                    if close_to_tray {
                        api.prevent_close();
                        let _ = win.hide();
                    } else {
                        close_handle.exit(0);
                    }
                }
            });

            build_tray(app.handle())?;

            if std::env::args().any(|a| a == "--settings") {
                open_settings(app.handle(), false);
            }

            if settings.auto_check_updates {
                let handle = app.handle().clone();
                let port_ready = proxy_port.clone();
                std::thread::spawn(move || {
                    // The check goes through the proxy, so wait for it to be up.
                    for _ in 0..60 {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        if port_ready.lock().unwrap().is_some() {
                            break;
                        }
                    }
                    if let Ok(info) = fetch_update_info(&handle) {
                        if info.has_update {
                            let h = handle.clone();
                            let _ = handle.run_on_main_thread(move || open_settings(&h, true));
                        }
                    }
                });
            }

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

// System tray: Show / Settings / Check for Updates / Quit, plus left-click to
// restore. "Quit" is the only path that always exits (and kills the proxy
// sidecar) — with close-to-tray on, the window's X only hides to the tray.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Show Torah Anytime", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let update_i = MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_i, &sep1, &settings_i, &update_i, &sep2, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Torah Anytime Downloader")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_and_focus(app),
            "settings" => open_settings(app, false),
            "update" => open_settings(app, true),
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

fn show_and_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// The Settings window doubles as the updater UI; `check_updates` starts a check
// as soon as it opens (used by the tray item and the startup auto-check).
fn open_settings(app: &AppHandle, check_updates: bool) {
    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        if check_updates {
            let _ = win.emit("ta-check-updates", ());
        }
        return;
    }
    let url = if check_updates {
        "settings.html?check=1"
    } else {
        "settings.html"
    };
    let _ = WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App(url.into()))
        .title("Torah Anytime — Settings")
        .inner_size(520.0, 640.0)
        .center()
        .build();
}
