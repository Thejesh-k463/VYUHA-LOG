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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
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
