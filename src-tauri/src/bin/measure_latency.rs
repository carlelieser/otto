//! The real hotkey-to-window measurement: a running Tauri app, the real global
//! shortcut, a real WebView, timed to first paint.
//!
//! This exists because the mock runtime cannot measure what the slice asks for.
//! It builds no WebView and paints nothing, so a number taken against it
//! describes the host's bookkeeping rather than the latency a user feels. The
//! bar in `01-runtime.md` is about a window appearing on screen, so the
//! measurement has to involve a window appearing on screen.
//!
//! Run it deliberately — it needs a windowing session and takes over the
//! display for a few seconds:
//!
//! ```sh
//! cargo run --bin measure-latency
//! ```
//!
//! **What is timed.** From the global shortcut handler firing — the real one,
//! registered with the OS and delivered by it — to the WebView reporting that
//! it has painted a frame. The page signals with `requestAnimationFrame` after
//! load, which is the browser's own "a frame went to the compositor" callback,
//! so the paint is observed rather than assumed.
//!
//! **What is still not timed**: the milliseconds between the physical keypress
//! and the OS delivering it to the handler. That is the OS's, it is not
//! something Otto can affect, and no test can observe it from inside the
//! process.

use serde::Serialize;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const BAR: Duration = Duration::from_millis(200);
const RUNS: usize = 30;
const WINDOW: &str = "capture";

/// When the hotkey fired, set by the shortcut handler and read on paint.
struct Pressed(Mutex<Option<Instant>>);

/// Where a completed timing goes, so the driver thread can collect it.
struct Timings(Mutex<Sender<Duration>>);

fn main() {
    let (sender, receiver) = channel::<Duration>();

    tauri::Builder::default()
        .plugin(shortcut_plugin())
        .manage(Pressed(Mutex::new(None)))
        .manage(Timings(Mutex::new(sender)))
        .setup(move |app| {
            let handle = app.handle().clone();
            register(&handle)?;
            build_window(&handle)?;
            listen_for_paint(&handle);
            drive(handle, receiver);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the measurement app failed to start");
}

fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SHIFT | Modifiers::SUPER), Code::Space)
}

/// The real plugin, with the real handler, registered with the OS.
fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, pressed_shortcut, event| {
            if event.state() != ShortcutState::Pressed || pressed_shortcut != &shortcut() {
                return;
            }
            *app.state::<Pressed>().0.lock().expect("pressed") = Some(Instant::now());
            let window = app.get_webview_window(WINDOW).expect("window");
            window.show().and_then(|()| window.set_focus()).expect("show");
            window.emit("measure", ()).expect("ask the page for a frame");
        })
        .build()
}

fn register(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut().register(shortcut())?;
    Ok(())
}

/// The real capture window, built once and hidden, exactly as the host does.
fn build_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
        .title("Otto")
        .inner_size(640.0, 180.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .decorations(false)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    Ok(())
}

/// The page reports a painted frame; the elapsed time since the keypress is the
/// measurement.
fn listen_for_paint(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.listen_any("painted", move |_| {
        let Some(started) = handle.state::<Pressed>().0.lock().expect("pressed").take() else {
            return;
        };
        let elapsed = started.elapsed();
        let timings = handle.state::<Timings>();
        timings.0.lock().expect("timings").send(elapsed).expect("send");
        let window = handle.get_webview_window(WINDOW).expect("window");
        window.hide().expect("hide");
    });
}

/// Presses the hotkey `RUNS` times, collects the timings, and reports.
///
/// The presses are synthesised at the OS level rather than by calling the
/// handler, so the delivery path is the real one.
fn drive(app: tauri::AppHandle, receiver: std::sync::mpsc::Receiver<Duration>) {
    std::thread::spawn(move || {
        // The WebView is built at startup but its first paint costs seconds of
        // process warm-up that no hotkey press pays. Discard a warm-up press so
        // the reported first-open is the cold *window* open a user sees, not
        // the cold application launch.
        std::thread::sleep(Duration::from_millis(2500));
        press_hotkey();
        let warmed = receiver.recv_timeout(Duration::from_secs(15)).is_ok();
        assert!(warmed, "no frame arrived at all — see the hotkey delivery note below");

        let mut timings = Vec::with_capacity(RUNS);
        let mut dropped = 0;
        for _ in 0..RUNS {
            std::thread::sleep(Duration::from_millis(250));
            press_hotkey();
            match receiver.recv_timeout(Duration::from_secs(5)) {
                Ok(elapsed) => timings.push(elapsed),
                Err(_) => dropped += 1,
            }
        }
        report(&mut timings, dropped);
        app.exit(0);
    });
}

/// Synthesises Cmd+Shift+Space through the OS, so the global shortcut fires the
/// way it does for a user.
#[cfg(target_os = "macos")]
fn press_hotkey() {
    // 49 is the virtual key code for Space.
    let script =
        r#"tell application "System Events" to key code 49 using {command down, shift down}"#;
    let status = std::process::Command::new("osascript").arg("-e").arg(script).status();
    if !matches!(status, Ok(exit) if exit.success()) {
        eprintln!(
            "could not synthesise the hotkey; grant Accessibility permission to the terminal"
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn press_hotkey() {
    eprintln!("hotkey synthesis is implemented for macOS only; see the module docs");
}

#[derive(Debug, Serialize)]
struct Baseline {
    measurement: &'static str,
    what_is_timed: &'static str,
    runs: usize,
    median_ms: f64,
    p95_ms: f64,
    bar_ms: u64,
    machine: String,
    os: String,
    excluded: &'static str,
}

/// Reports, or refuses to.
///
/// Dropped presses fail the run rather than being averaged away. A press that
/// produced no frame is a press the OS did not deliver — on macOS, almost
/// always a missing Accessibility permission — and a percentile over whichever
/// presses happened to land is a number that looks like a measurement without
/// being one.
fn report(timings: &mut [Duration], dropped: usize) {
    if dropped > 0 {
        eprintln!(
            "FAIL: {dropped} of {RUNS} presses produced no frame.\n\
             The hotkey is not reaching the handler. On macOS, grant Accessibility\n\
             permission to this terminal (System Settings › Privacy & Security ›\n\
             Accessibility) so `osascript` may synthesise keystrokes, then re-run.\n\
             No baseline was written."
        );
        std::process::exit(1);
    }
    let median = percentile(timings, 50.0);
    let p95 = percentile(timings, 95.0);
    println!("hotkey-to-paint over {RUNS} presses: median {median:?}, p95 {p95:?}, bar {BAR:?}");
    write_baseline(median, p95);
    if p95 >= BAR {
        eprintln!("FAIL: p95 {p95:?} exceeded the {BAR:?} bar");
        std::process::exit(1);
    }
}

fn percentile(timings: &mut [Duration], percent: f64) -> Duration {
    timings.sort_unstable();
    let index = ((percent / 100.0) * (timings.len() - 1) as f64).round() as usize;
    timings[index.min(timings.len() - 1)]
}

fn write_baseline(median: Duration, p95: Duration) {
    let baseline = Baseline {
        measurement: "hotkey-to-window",
        what_is_timed: "Real global shortcut handler firing to the WebView reporting a painted \
                        frame via requestAnimationFrame. One warm-up press is discarded so the \
                        figures describe opening the window, not launching the application.",
        runs: RUNS,
        median_ms: median.as_secs_f64() * 1000.0,
        p95_ms: p95.as_secs_f64() * 1000.0,
        bar_ms: BAR.as_millis() as u64,
        machine: std::env::consts::ARCH.to_string(),
        os: std::env::consts::OS.to_string(),
        excluded: "The interval between the physical keypress and the OS delivering it to the \
                   handler, which Otto cannot observe or affect.",
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("tests/baselines/runtime-latency.json");
    std::fs::create_dir_all(path.parent().expect("dir")).expect("create");
    let json = serde_json::to_string_pretty(&baseline).expect("serialise");
    std::fs::write(&path, format!("{json}\n")).expect("write baseline");
}
