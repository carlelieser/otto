//! The capture window's behaviour, against Tauri's mock runtime.
//!
//! **This file does not measure latency.** An earlier version did, and the
//! number was meaningless: the mock runtime builds no WebView and paints
//! nothing, so timing `show` against it described the host's bookkeeping rather
//! than a window appearing. The real hotkey-to-window measurement needs a
//! windowing session and lives in `src/bin/measure_latency.rs`.
//!
//! What the mock can attest to is the branch structure — that the window is
//! built once and reused, and that hiding one that was never built is not an
//! error. That is worth testing here because it is what keeps the reopen path
//! off the expensive branch, and it runs anywhere.

use tauri::Manager;

#[test]
fn the_capture_window_opens_once_and_is_reused() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    otto_lib::capture_window::show(&handle).expect("first open");
    assert!(
        handle.get_webview_window(otto_lib::capture_window::CAPTURE_WINDOW).is_some(),
        "the hotkey opens the capture window"
    );

    // Reopening reuses rather than rebuilds — the property that keeps a reopen
    // off the WebView-construction path.
    otto_lib::capture_window::show(&handle).expect("reopen");
    otto_lib::capture_window::hide(&handle).expect("hide");
    assert_eq!(handle.webview_windows().len(), 1);
}

#[test]
fn hiding_a_window_that_was_never_opened_is_not_an_error() {
    let app = tauri::test::mock_app();
    otto_lib::capture_window::hide(app.handle()).expect("hide with no window");
}
