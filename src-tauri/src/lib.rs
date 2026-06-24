//! Vivicy desktop shell.
//!
//! Vivicy's UI is a Next.js app that REQUIRES a Node server at runtime: its API
//! routes spawn the agent CLIs via `child_process`, browse the filesystem, and
//! stream map/status. A static export is therefore impossible. The desktop app
//! runs that exact same Node/Next server as a Tauri **sidecar** on a free
//! localhost port and points the webview at it.
//!
//! Lifecycle (Tauri owns it end to end):
//!   1. Pick a free TCP port.
//!   2. Spawn the Node sidecar: `node <resources>/server/server.js`, with `PORT`
//!      and `HOSTNAME=127.0.0.1` in its env (the Next standalone server reads
//!      these). The sidecar handle is kept in app state.
//!   3. Poll `http://127.0.0.1:<port>` until it answers (bounded), then navigate
//!      the main window there.
//!   4. On window-destroyed and on app-exit, kill the sidecar so no orphaned
//!      Node server is ever left running.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running Next sidecar child so it can be killed on exit. `Mutex` +
/// `Option` because the child is taken (moved out) exactly once at teardown.
#[derive(Default)]
struct Sidecar(Mutex<Option<CommandChild>>);

impl Sidecar {
    /// Kill the sidecar if it is still running. Idempotent: a second call (e.g.
    /// window-destroyed then app-exit) finds `None` and does nothing.
    fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

/// Poll the sidecar URL until it responds or the deadline passes. Any HTTP reply
/// (even a 4xx/5xx) proves the server is up and serving; only connection errors
/// mean "not ready yet".
fn wait_for_server(url: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .build();
    while Instant::now() < deadline {
        match agent.get(url).call() {
            // Reached the server (2xx) — ready.
            Ok(_) => return true,
            // Got an HTTP status error — the server answered, so it is up.
            Err(ureq::Error::Status(_, _)) => return true,
            // Transport error (connection refused etc.) — keep polling.
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    }
    false
}

/// Show the main window with an inline error page instead of a blank shell. Used
/// when the sidecar cannot be started or never binds — the user sees what went
/// wrong rather than the app silently crashing or hanging on a blank window.
fn show_error(window: &tauri::WebviewWindow, message: &str) {
    eprintln!("[vivicy] startup error: {message}");
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>Vivicy</title>\
         <body style=\"font-family:system-ui;margin:0;display:flex;align-items:center;\
         justify-content:center;height:100vh;background:#0a0a0a;color:#fafafa\">\
         <div style=\"max-width:32rem;padding:2rem\">\
         <h1 style=\"font-size:1rem;font-weight:600\">Vivicy could not start its server</h1>\
         <p style=\"font-size:.875rem;color:#a1a1a1;line-height:1.5\">{}</p></div></body>",
        html_escape(message)
    );
    if let Ok(url) = format!("data:text/html,{}", urlencode(&html)).parse() {
        let _ = window.navigate(url);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Minimal HTML-escape for the error message body.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Minimal percent-encoding for embedding HTML in a data: URL.
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Spawn the Next standalone server as the Node sidecar and return the URL to
/// navigate to once it is up. Fallible end to end: every failure that would have
/// panicked is surfaced as an `Err` so the caller can show the error page instead
/// of crashing the app.
fn start_sidecar(app: &tauri::AppHandle) -> Result<String, String> {
    // A free port, chosen fresh each launch so two instances never clash and we
    // never collide with whatever else is bound on the machine.
    let port = portpicker::pick_unused_port().ok_or("no free TCP port is available")?;
    let url = format!("http://127.0.0.1:{port}");

    // Resolve the bundled launcher and the Next standalone server entry. Both
    // live under the bundle's resource dir (and `tauri dev` resolves them from the
    // same `resources` mapping in tauri.conf.json). The launcher boots server.js
    // and self-terminates if this app dies abnormally, so the sidecar can never be
    // orphaned holding its port.
    let launcher = app
        .path()
        .resolve("server/launch-server.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("could not locate the sidecar launcher: {e}"))?
        .to_string_lossy()
        .to_string();
    let server_entry = app
        .path()
        .resolve("server/server.js", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("could not locate the bundled Next server: {e}"))?
        .to_string_lossy()
        .to_string();

    // Spawn the Node sidecar (the `node` external binary) running the launcher,
    // which boots the Next standalone server. PORT + HOSTNAME are what server.js
    // binds to; NODE_NO_WARNINGS keeps the streamed log clean.
    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("the Node sidecar is not configured: {e}"))?
        .args([launcher, server_entry])
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("NODE_NO_WARNINGS", "1")
        .spawn()
        .map_err(|e| format!("failed to start the Next server: {e}"))?;

    // Stash the child so the exit handlers can kill it. A poisoned lock here is
    // unrecoverable, so propagate it as an error rather than panicking.
    app.state::<Sidecar>()
        .0
        .lock()
        .map_err(|_| "internal lock error".to_string())?
        .replace(child);

    // Drain sidecar output to the app's stdout (also keeps the OS pipe from
    // filling and blocking the server). Ends when the sidecar closes its streams.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[vivicy-server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[vivicy-server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[vivicy-server] exited: {:?}", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar::default())
        .setup(|app| {
            // The main window starts hidden (tauri.conf.json) so the user never
            // sees a blank shell while Node boots; we show it once the app is
            // actually serving, or with an error page if startup fails.
            let window = app
                .get_webview_window("main")
                .ok_or("main window is missing")?;

            // Start the sidecar; on any failure show the error page (not a crash).
            let url = match start_sidecar(app.handle()) {
                Ok(url) => url,
                Err(message) => {
                    show_error(&window, &message);
                    return Ok(());
                }
            };

            // Wait for the server to bind, then point the window at it.
            tauri::async_runtime::spawn(async move {
                let wait_url = url.clone();
                let ready = tauri::async_runtime::spawn_blocking(move || {
                    wait_for_server(&wait_url, Duration::from_secs(90))
                })
                .await
                .unwrap_or(false);

                if !ready {
                    show_error(
                        &window,
                        "The local server did not start in time. Please reopen Vivicy.",
                    );
                    return;
                }
                match url.parse() {
                    Ok(parsed) => {
                        let _ = window.navigate(parsed);
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    Err(_) => show_error(&window, "Internal error: invalid server URL."),
                }
            });

            Ok(())
        })
        // Kill the sidecar when the main window is destroyed (user closed it).
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.app_handle().state::<Sidecar>().kill();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Vivicy desktop app")
        // Belt-and-suspenders: also kill on the app-exit event, covering quit
        // paths that don't destroy the window first (Cmd-Q, app menu Quit).
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                app_handle.state::<Sidecar>().kill();
            }
        });
}
