//! Hotkey-to-window latency, and the baseline it writes.
//!
//! PRD §4's first principle is capture that costs nothing, and 200 ms is where
//! an opening window stops reading as a response to the keypress and starts
//! reading as a wait. It is a generous ceiling on purpose: an empty window with
//! no I/O behind it should land far under, and if it does not, something is
//! wrong with the process model rather than with the budget.
//!
//! **Ignored by default.** `qa.md` §8's point is that every bar passes by 20×
//! or better, so a shared runner's timing is noise and a flaky red build gets
//! deleted rather than fixed. Run it deliberately:
//!
//! ```sh
//! cargo test --test latency -- --ignored --nocapture
//! ```
//!
//! **What is measured, and what is not.** This times `capture_window::show`
//! end to end — the window-lookup branch, the builder on the first call, and
//! the show/center/focus on every call — against Tauri's mock runtime. That is
//! the whole of the path Otto owns on the hotkey.
//!
//! What it excludes is the compositor's paint, which happens after `show`
//! returns and belongs to the OS, and the real WebView's construction, which
//! the mock runtime stands in for. So this is a floor rather than the whole
//! user-visible number. Stated rather than implied, so the baseline is not read
//! as more than it is: it catches the host doing something expensive on the
//! hotkey path, which is the regression that is actually Otto's to prevent.

use serde::Serialize;
use std::time::{Duration, Instant};

const BAR: Duration = Duration::from_millis(200);
const RUNS: usize = 200;

#[derive(Debug, Serialize)]
struct Baseline {
    measurement: &'static str,
    runs: usize,
    first_open_ms: f64,
    median_ms: f64,
    p95_ms: f64,
    bar_ms: u64,
    machine: String,
    os: String,
    note: &'static str,
}

#[test]
#[ignore = "timing-sensitive; run deliberately with --ignored"]
fn hotkey_to_window_is_under_the_bar_and_records_its_baseline() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    // The first open builds the window; every one after it reuses the built
    // WebView. Both must clear the bar, and they are reported separately
    // because a regression in either has a different cause.
    let first_open = time_show(&handle);
    let timings: Vec<Duration> = (0..RUNS).map(|_| time_show(&handle)).collect();

    let median = percentile(&timings, 50.0);
    let p95 = percentile(&timings, 95.0);
    write_baseline(first_open, median, p95);
    println!("hotkey-to-window: first {first_open:?}, median {median:?}, p95 {p95:?}");

    assert!(first_open < BAR, "first open {first_open:?} exceeded the {BAR:?} bar");
    assert!(p95 < BAR, "p95 {p95:?} exceeded the {BAR:?} bar");
}

/// One hotkey press worth of work: everything `show` does, timed.
fn time_show(handle: &tauri::AppHandle<tauri::test::MockRuntime>) -> Duration {
    let started = Instant::now();
    otto_lib::capture_window::show(handle).expect("show the capture window");
    started.elapsed()
}

#[test]
fn the_capture_window_opens_once_and_is_reused() {
    use tauri::Manager;
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    otto_lib::capture_window::show(&handle).expect("first open");
    assert!(
        handle.get_webview_window(otto_lib::capture_window::CAPTURE_WINDOW).is_some(),
        "the hotkey opens the capture window"
    );

    // Reopening reuses rather than rebuilds — the property the latency bar
    // depends on, and the one the mock runtime can actually attest to. Its
    // `hide` is a no-op and its `is_visible` is hard-coded to `true`, so
    // asserting on visibility here would be asserting about the mock rather
    // than about Otto; that the window survives for reuse is the real claim.
    otto_lib::capture_window::show(&handle).expect("reopen");
    otto_lib::capture_window::hide(&handle).expect("hide");
    assert_eq!(handle.webview_windows().len(), 1);
}

#[test]
fn hiding_a_window_that_was_never_opened_is_not_an_error() {
    let app = tauri::test::mock_app();
    otto_lib::capture_window::hide(app.handle()).expect("hide with no window");
}

fn percentile(timings: &[Duration], percent: f64) -> Duration {
    let mut sorted = timings.to_vec();
    sorted.sort_unstable();
    let index = ((percent / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn write_baseline(first_open: Duration, median: Duration, p95: Duration) {
    let baseline = Baseline {
        measurement: "hotkey-to-window",
        runs: RUNS,
        first_open_ms: first_open.as_secs_f64() * 1000.0,
        median_ms: median.as_secs_f64() * 1000.0,
        p95_ms: p95.as_secs_f64() * 1000.0,
        bar_ms: BAR.as_millis() as u64,
        machine: std::env::consts::ARCH.to_string(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::FAMILY),
        note: "capture_window::show against Tauri's mock runtime; \
               compositor paint and real WebView construction are not included.",
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("tests/baselines/runtime-latency.json");
    std::fs::create_dir_all(path.parent().expect("baselines dir")).expect("create baselines");
    let json = serde_json::to_string_pretty(&baseline).expect("serialise");
    std::fs::write(&path, format!("{json}\n")).expect("write baseline");
}
