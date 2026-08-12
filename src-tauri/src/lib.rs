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

/// The signed revocation list. Fetched in the SAME launch task as the version
/// check, so this adds no new host, no new call pattern and no new timing
/// signal — but deliberately NOT from `releases/latest/download/`.
///
/// `latest` re-points at every new app release, so a list uploaded to v2.99.91
/// would 404 the moment v2.99.92 shipped without someone remembering to
/// re-upload it — a revocation silently un-revoking itself, with nothing on
/// screen to show for it. A dedicated, permanent `revocations` release holds
/// exactly one asset that app releases cannot disturb, and publishing is one
/// `--clobber` upload to a tag that never moves.
const REVOCATIONS_URL: &str =
    "https://github.com/Thejesh-k463/VYUHA-LOG/releases/download/revocations/revocations.json";

/// Download the signed revocation list and cache it beside the database.
///
/// PULL ONLY. There is no request body, no identifier in the URL and no
/// header carrying anything about this install — the app fetches a small
/// public file the way a browser fetches a certificate revocation list. That
/// is what lets every "your data never leaves this machine" claim stay true
/// while still giving the vendor a way to withdraw a refunded or leaked key.
///
/// Verification happens on the OTHER side of the wall: this writes bytes, and
/// lib/revocation.ts checks the vendor's Ed25519 signature before believing a
/// single entry. So a corrupted download, a captive-portal login page, or a
/// hostile proxy substituting a file are all inert here — the worst case is a
/// cached blob the TypeScript side refuses.
///
/// Silent on every failure, by design: offline is the normal state of an
/// offline-first journal, and a dialog about a licence list the user never
/// asked about would be both alarming and useless.
async fn fetch_revocation_list(data_dir: std::path::PathBuf) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[vyuha] revocation client unavailable: {e}");
            return;
        }
    };
    let body = match client.get(REVOCATIONS_URL).send().await {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[vyuha] revocation list unreadable: {e}");
                return;
            }
        },
        // A 404 is the normal state when nothing has ever been revoked.
        Ok(r) => {
            eprintln!("[vyuha] revocation list not published ({})", r.status());
            return;
        }
        Err(e) => {
            eprintln!("[vyuha] revocation check skipped: {e}");
            return;
        }
    };
    // Cheap sanity gate so a proxy's HTML error page never lands in the cache
    // and never replaces a good list already there.
    if !body.trim_start().starts_with('{') || !body.contains("vyuhaRevocations") {
        eprintln!("[vyuha] revocation list did not look like one; ignored");
        return;
    }
    // Write via a temp file + rename so a half-written download can never be
    // read as a truncated list by the sidecar starting up alongside us.
    let final_path = data_dir.join("revocations.json");
    let tmp_path = data_dir.join("revocations.json.part");
    if std::fs::write(&tmp_path, body.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp_path, &final_path);
    }
}

/// Startup update check (runs in the background; never blocks the journal).
/// The webview navigates away to the local Next server, so Tauri IPC is not
/// available to the web app — the whole flow stays in Rust with native dialogs.
/// Endpoint = the latest PUBLISHED GitHub release's latest.json (drafts don't count).
fn check_for_updates(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        use tauri_plugin_updater::UpdaterExt;

        // Same task, same host, same launch. Runs BEFORE the update prompt so
        // a user who sits on the dialog still gets the list cached.
        if let Ok(dir) = handle.path().app_data_dir() {
            fetch_revocation_list(dir).await;
        }

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
            // Prefer the Node runtime bundled with the installer (zero-dependency
            // distribution); fall back to system `node` for older bundles.
            let bundled_node = server_dir
                .join("node")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            let node_cmd: std::path::PathBuf = if bundled_node.exists() {
                bundled_node
            } else {
                std::path::PathBuf::from("node")
            };
            let child = Command::new(&node_cmd)
                .arg(&entry)
                .current_dir(&server_dir)
                .env("VYUHA_DATA_DIR", &data_dir)
                .env("PORT", PORT.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .spawn()
                .map_err(|e| {
                    format!(
                        "Failed to start the Vyuha server via {} ({e}). Is Node.js installed and on PATH?",
                        node_cmd.display()
                    )
                })?;
            app.state::<ServerProcess>().0.lock().unwrap().replace(child);

            // Wait for the server in the background, then navigate the webview to it.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut ready = false;
                // 1200 x 50ms keeps the same 60s ceiling the 240 x 250ms loop had.
                for _ in 0..1200 {
                    if TcpStream::connect(("127.0.0.1", PORT)).is_ok() {
                        ready = true;
                        break;
                    }
                    // 50ms, not 250: the poll granularity IS the average wasted wait after
                    // the port opens (~125ms at 250ms). Connecting is ~free on loopback.
                    std::thread::sleep(Duration::from_millis(50));
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
