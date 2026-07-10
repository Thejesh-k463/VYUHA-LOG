// Vyuha desktop shell.
//
// The app is a full-stack Next.js server (server components + actions + better-sqlite3),
// so it cannot be a static export. Instead we run the Next standalone server as a Node
// sidecar bound to 127.0.0.1, wait for it, then point the webview at it. The per-user
// SQLite database lives in the OS app-data dir (seeded from the bundled template on first
// run by `desktop-server.mjs`).
use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, WindowEvent};

struct ServerProcess(Mutex<Option<Child>>);

const PORT: u16 = 3000;

/// Startup update check (runs in the background; never blocks the journal).
/// The webview navigates away to the local Next server, so Tauri IPC is not
/// available to the web app — the whole flow stays in Rust with native dialogs.
/// Endpoint = the latest PUBLISHED GitHub release's latest.json (drafts don't count).
fn check_for_updates(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        use tauri_plugin_updater::UpdaterExt;

        let updater = match handle.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[vyuha] updater unavailable: {e}");
                return;
            }
        };
        // Offline or endpoint unreachable → silently skip (offline-first app).
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => return,
            Err(e) => {
                eprintln!("[vyuha] update check skipped: {e}");
                return;
            }
        };

        let version = update.version.clone();
        let confirmed = handle
            .dialog()
            .message(format!(
                "Vyuha {version} is available (you have {}).\n\nDownload and install now? \
                 Your journal data is kept — a backup is taken automatically before any \
                 database migration.",
                handle.package_info().version
            ))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Update now".into(),
                "Later".into(),
            ))
            .blocking_show();
        if !confirmed {
            return;
        }

        match update.download_and_install(|_, _| {}, || {}).await {
            // On Windows the installer takes over and the app exits by itself;
            // restart() is the cross-platform fallback for other targets.
            Ok(()) => handle.restart(),
            Err(e) => {
                handle
                    .dialog()
                    .message(format!(
                        "The update could not be installed automatically ({e}). \
                         Please download the latest installer from the releases page."
                    ))
                    .title("Update failed")
                    .blocking_show();
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            check_for_updates(app.handle().clone());
            let server_dir = app.path().resource_dir()?.join("server");
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();

            let entry = server_dir.join("desktop-server.mjs");
            let child = Command::new("node")
                .arg(&entry)
                .current_dir(&server_dir)
                .env("VYUHA_DATA_DIR", &data_dir)
                .env("PORT", PORT.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .spawn()
                .map_err(|e| {
                    format!("Failed to start the Vyuha server via Node.js ({e}). Is Node.js installed and on PATH?")
                })?;
            app.state::<ServerProcess>().0.lock().unwrap().replace(child);

            // Wait for the server in the background, then navigate the webview to it.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut ready = false;
                for _ in 0..240 {
                    if TcpStream::connect(("127.0.0.1", PORT)).is_ok() {
                        ready = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                if ready {
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(win) = h.get_webview_window("main") {
                            let _ = win.eval(&format!(
                                "window.location.replace('http://127.0.0.1:{PORT}')"
                            ));
                        }
                    });
                } else {
                    eprintln!("[vyuha] server did not become ready on port {PORT}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Stop the Node sidecar when the window is closed.
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<ServerProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Vyuha");
}
