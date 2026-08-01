//! The capture window: the tray affordance the hotkey opens.
//!
//! It opens, accepts text, and closes. It stores nothing — `CaptureStore`
//! arrives in Slice 2. Shipping the affordance without the persistence is
//! deliberate: it makes hotkey-to-window latency measurable before there is a
//! pipeline to blame.
//!
//! Not a window with navigation in it. The dashboard is Slice 11.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const CAPTURE_WINDOW: &str = "capture";

const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 180.0;

/// Shows the capture window, building it the first time it is asked for.
///
/// Reusing the window rather than rebuilding it is what keeps the reopen path
/// under the 200 ms bar: constructing a WebView is the expensive part, and the
/// user opens this window many times a day.
pub fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    match app.get_webview_window(CAPTURE_WINDOW) {
        Some(window) => reveal(&window),
        None => build(app).and_then(|window| reveal(&window)),
    }
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, CAPTURE_WINDOW, WebviewUrl::default())
        .title("Otto")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .always_on_top(true)
        .center()
        .decorations(false)
        .skip_taskbar(true)
        .visible(false)
        .build()
}

/// Brings the window up focused, so the caret is ready without a click.
fn reveal<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    window.show()?;
    window.center()?;
    window.set_focus()
}

/// Hides rather than closes, so the next open reuses the built WebView.
pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    match app.get_webview_window(CAPTURE_WINDOW) {
        Some(window) => window.hide(),
        None => Ok(()),
    }
}
