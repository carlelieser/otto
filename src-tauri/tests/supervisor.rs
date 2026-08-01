//! The process-model tests `qa.md` §8 asks for, against a real spawned sidecar.
//!
//! These drive the supervisor rather than a stub: the transport, the restart,
//! and the sweep are exactly the things a stub would get wrong. They need the
//! sidecar built, and they fail loudly rather than skipping when it is not —
//! see `sidecar_script` for why.

use otto_lib::audio::write_wav;
use otto_lib::audio_dir;
use otto_lib::supervisor::{SidecarConfig, Supervisor};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The built sidecar.
///
/// Missing `dist/` is a hard failure rather than a skip. A skip here would make
/// every test in this file report success without having started a process, and
/// a suite that is green because it did nothing is worse than one that is red:
/// these are the only tests that exercise the transport, the restart, and the
/// sweep at all. CI builds the sidecar before running them, so an absent build
/// means the build order broke, which is exactly what should go red.
fn sidecar_script() -> PathBuf {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("dist/interfaces/sidecar/main.js");
    assert!(
        script.is_file(),
        "the sidecar is not built at {}; run `npm run build:sidecar`",
        script.display()
    );
    script
}

/// A supervisor pointed at the built sidecar and a private recordings directory.
fn supervisor(recordings: &Path) -> Supervisor {
    let interpreter = std::env::var("OTTO_NODE").unwrap_or_else(|_| "node".into());
    Supervisor::new(SidecarConfig::new(
        interpreter.into(),
        sidecar_script(),
        recordings.to_path_buf(),
    ))
}

#[test]
fn a_round_trip_completes_over_the_transport() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut supervisor = supervisor(directory.path());
    supervisor.start().expect("start");

    let answer = supervisor.call("ping", json!({ "message": "hello" })).expect("ping");

    // Assert the response, not merely that nothing threw.
    assert_eq!(answer, json!({ "pong": { "message": "hello" } }));
}

#[test]
fn a_method_the_sidecar_does_not_have_is_an_error_rather_than_a_crash() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut supervisor = supervisor(directory.path());
    supervisor.start().expect("start");

    assert!(supervisor.call("no_such_method", json!({})).is_err());
    // The sidecar answered rather than died, so the transport still works.
    assert!(supervisor.call("ping", json!(null)).is_ok());
}

#[test]
fn killing_the_sidecar_restarts_it_and_the_host_survives() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut supervisor = supervisor(directory.path());
    supervisor.start().expect("start");

    // Exit on request rather than by signal: a signal test is a test of the
    // operating system, and on Windows it is a test of something else.
    let _ = supervisor.call("exit", json!({ "code": 1 }));
    wait_for_exit(&mut supervisor);
    assert!(!supervisor.is_running());

    supervisor.restart().expect("restart");
    assert!(supervisor.is_running());
    assert!(supervisor.call("ping", json!("after restart")).is_ok());
}

#[test]
fn a_crash_loop_backs_off_rather_than_spinning() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut supervisor = supervisor(directory.path());
    supervisor.start().expect("start");

    let started = std::time::Instant::now();
    for _ in 0..4 {
        let _ = supervisor.call("exit", json!({ "code": 1 }));
        wait_for_exit(&mut supervisor);
        supervisor.restart().expect("restart");
    }

    // 100 + 200 + 400 + 800 ms of backoff: the loop slowed down instead of
    // spinning, and the host is still here to assert it.
    assert!(started.elapsed() >= Duration::from_millis(1500));
    assert_eq!(supervisor.restart_attempts(), 4);
    assert!(supervisor.call("ping", json!("still alive")).is_ok());
}

#[test]
fn a_sidecar_that_comes_back_healthy_clears_the_backoff() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut supervisor = supervisor(directory.path());
    supervisor.start().expect("start");

    let _ = supervisor.call("exit", json!({ "code": 1 }));
    wait_for_exit(&mut supervisor);
    supervisor.restart().expect("restart");
    assert_eq!(supervisor.restart_attempts(), 1);

    supervisor.mark_healthy();
    assert_eq!(supervisor.restart_attempts(), 0);
    assert!(!supervisor.in_crash_loop());
}

#[test]
fn audio_recorded_by_the_host_is_read_by_the_sidecar_and_then_deleted() {
    let base = tempfile::tempdir().expect("tempdir");
    let recordings = audio_dir::ensure_dir(base.path()).expect("ensure");
    let mut supervisor = supervisor(&recordings);
    supervisor.start().expect("start");

    let recording = recordings.join("handoff.wav");
    let samples: Vec<i16> = (0..1600).map(|n| (n % 512) as i16).collect();
    write_wav(&recording, &samples).expect("write wav");
    let on_disk = std::fs::metadata(&recording).expect("metadata").len();

    let answer = supervisor
        .call("readAudio", json!({ "path": recording.to_string_lossy() }))
        .expect("readAudio");

    // The sidecar read the file at the path it was given, and the ownership
    // rule holds: the host writes, the sidecar deletes (`runtime.md` §2).
    assert_eq!(answer["bytes"], json!(on_disk));
    assert_eq!(answer["deleted"], json!(true));
    assert!(!recording.exists());
}

#[test]
fn an_orphan_left_by_a_crash_is_swept_on_restart() {
    let base = tempfile::tempdir().expect("tempdir");
    let recordings = audio_dir::ensure_dir(base.path()).expect("ensure");
    let mut supervisor = supervisor(&recordings);
    supervisor.start().expect("start");

    // Write one, kill the sidecar before it reads, restart, assert it is gone.
    let orphan = recordings.join("never-read.wav");
    write_wav(&orphan, &[0; 800]).expect("write wav");
    let _ = supervisor.call("exit", json!({ "code": 1 }));
    wait_for_exit(&mut supervisor);
    assert!(orphan.exists(), "the orphan must survive the crash to be swept");

    supervisor.restart().expect("restart");

    assert!(!orphan.exists());
    assert!(supervisor.call("ping", json!(null)).is_ok());
}

/// Waits for a requested exit to actually land, so `is_running` is not racing.
fn wait_for_exit(supervisor: &mut Supervisor) {
    for _ in 0..100 {
        if !supervisor.is_running() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the sidecar did not exit");
}
