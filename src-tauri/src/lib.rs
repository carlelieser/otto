//! Otto's Tauri host.
//!
//! A shell around OS APIs: the tray, the global hotkey, the capture window,
//! audio recording, and the sidecar's lifecycle. No domain types, no
//! persistence, and no knowledge of what a Capture means — `add.md` §3's layer
//! rules govern `src/`, and the host stays thin enough that they never need to
//! reach it.

pub mod app;
pub mod audio;
pub mod audio_dir;
pub mod backoff;
pub mod capture_window;
pub mod rpc;
pub mod supervisor;
pub mod timestamp;

pub use app::run;
