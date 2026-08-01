//! Wiring: the tray, the global hotkey, the sidecar's lifecycle, and the
//! commands the capture window calls.

use crate::audio_dir;
use crate::capture_window;
use crate::supervisor::{SidecarConfig, Supervisor};
use crate::timestamp;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// PRD §5.1's affordance. Cmd/Ctrl+Shift+Space is unclaimed on all three
/// platforms and reachable without moving off the home row.
fn capture_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SHIFT | Modifiers::SUPER), Code::Space)
}

pub struct SidecarState(pub Mutex<Supervisor>);

/// Starts the host: tray, hotkey, sidecar, and the capture window's commands.
pub fn run() {
    tauri::Builder::default()
        .plugin(global_shortcut_plugin())
        .invoke_handler(tauri::generate_handler![
            ping_sidecar,
            capture_text,
            close_capture_window
        ])
        .setup(|app| {
            let handle = app.handle();
            app.manage(SidecarState(Mutex::new(start_sidecar(handle)?)));
            build_tray(handle)?;
            register_shortcut(handle)?;
            Ok(())
        })
        // The tray outlives every window: closing the capture window must not
        // exit the application (`runtime.md` §1's tray-resident model).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("otto failed to start")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed && shortcut == &capture_shortcut() {
                let _ = capture_window::show(app);
            }
        })
        .build()
}

fn register_shortcut(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut().register(capture_shortcut())?;
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Otto", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture, &quit])?;
    TrayIconBuilder::with_id("otto")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => {
                let _ = capture_window::show(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Spawns the sidecar through a configurable interpreter path.
///
/// Slice 1 takes the development answer only: the developer's installed Node.
/// `OTTO_NODE` and `OTTO_SIDECAR` are what let Slice 11 substitute a bundled
/// runtime without rewriting the supervisor.
fn start_sidecar(app: &AppHandle) -> tauri::Result<Supervisor> {
    let recordings = audio_dir::ensure_dir(&app.path().temp_dir()?)?;
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let mut supervisor = Supervisor::new(sidecar_config(recordings, data_dir.join("otto.db")));
    if let Err(error) = supervisor.start() {
        eprintln!("otto: the sidecar did not start: {error}");
    }
    Ok(supervisor)
}

fn sidecar_config(recordings: PathBuf, database: PathBuf) -> SidecarConfig {
    let interpreter = std::env::var("OTTO_NODE").unwrap_or_else(|_| "node".into());
    let script = std::env::var("OTTO_SIDECAR").unwrap_or_else(|_| "dist/sidecar/main.js".into());
    SidecarConfig::new(interpreter.into(), script.into(), recordings)
        .with_environment("OTTO_DATABASE", &database.to_string_lossy())
}

/// The round-trip proof, reachable from the WebView.
#[tauri::command]
fn ping_sidecar(state: State<'_, SidecarState>, message: String) -> Result<Value, String> {
    let mut supervisor = state.0.lock().map_err(|_| "sidecar state poisoned".to_string())?;
    supervisor.call("ping", json!({ "message": message })).map_err(|error| error.to_string())
}

/// Stores what the user typed, returning the Capture the sidecar made durable.
///
/// The error is returned rather than swallowed: capture is the one path where
/// the user is waiting, and a write failure has to surface synchronously rather
/// than losing their words silently (`qa.md` §4.2).
#[tauri::command]
fn capture_text(state: State<'_, SidecarState>, text: String) -> Result<Value, String> {
    let mut supervisor = state.0.lock().map_err(|_| "sidecar state poisoned".to_string())?;
    let params = json!({ "text": text, "sourceTimestamp": now_iso8601() });
    supervisor.call("ingestTyped", params).map_err(|error| error.to_string())
}

/// The exact shape `capture_id` is derived from: `YYYY-MM-DDTHH:MM:SS.sssZ`.
///
/// Formatted here rather than in the sidecar because the sidecar requires it
/// and refuses anything else (ADR-0018) — and for voice, only the host knows
/// when recording started.
pub fn now_iso8601() -> String {
    let now =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    timestamp::format_iso8601(now.as_millis() as i64)
}

#[tauri::command]
fn close_capture_window(app: AppHandle) -> Result<(), String> {
    capture_window::hide(&app).map_err(|error| error.to_string())
}
