//! Spawns the Node sidecar, talks to it, and restarts it when it dies
//! (`runtime.md` §1).
//!
//! The tray does not die with the sidecar — that is the property the
//! three-process split was chosen for. A crash loop degrades to "Captures
//! accumulate", which `add.md` §11 already treats as a handled state.

use crate::audio_dir;
use crate::backoff::Backoff;
use crate::rpc::{Channel, TransportError};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;

/// Where the sidecar comes from, and where its recordings live.
///
/// The interpreter path is configurable because the Node-shipping question is
/// Slice 11's: the host spawns the developer's installed Node now, and
/// packaging substitutes a bundled binary by changing this rather than by
/// rewriting the supervisor.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub interpreter: PathBuf,
    pub script: PathBuf,
    pub recordings: PathBuf,
    /// Extra environment for the spawned sidecar: where its database lives, and
    /// where the transcriber's binary and model are. The host does not read any
    /// of them — it only passes them on, because the sidecar owns SQLite
    /// (`runtime.md` §1) and the `Transcriber` port.
    pub environment: Vec<(String, String)>,
}

impl SidecarConfig {
    pub fn new(interpreter: PathBuf, script: PathBuf, recordings: PathBuf) -> Self {
        Self { interpreter, script, recordings, environment: Vec::new() }
    }

    /// Adds a variable the sidecar is spawned with.
    pub fn with_environment(mut self, key: &str, value: &str) -> Self {
        self.environment.push((key.to_string(), value.to_string()));
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("could not spawn the sidecar: {0}")]
    Spawn(std::io::Error),
    #[error(transparent)]
    Transport(#[from] TransportError),
}

/// One running sidecar and the state its restarts are paced by.
pub struct Supervisor {
    config: SidecarConfig,
    backoff: Backoff,
    running: Option<Running>,
}

struct Running {
    child: Child,
    channel: Channel,
}

impl Supervisor {
    pub fn new(config: SidecarConfig) -> Self {
        Self { config, backoff: Backoff::new(), running: None }
    }

    /// Starts the sidecar, sweeping any recording the last one left behind.
    ///
    /// The sweep is here rather than at shutdown because a crash has no orderly
    /// shutdown to hook — the restart is the only moment both processes agree
    /// nothing is being read.
    pub fn start(&mut self) -> Result<(), SupervisorError> {
        let _ = audio_dir::sweep_orphans(&self.config.recordings);
        let mut child = self.spawn()?;
        let channel = take_channel(&mut child);
        self.running = Some(Running { child, channel });
        Ok(())
    }

    fn spawn(&self) -> Result<Child, SupervisorError> {
        Command::new(&self.config.interpreter)
            .arg(&self.config.script)
            .envs(self.config.environment.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(SupervisorError::Spawn)
    }

    /// Calls a method on the running sidecar.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, SupervisorError> {
        let running = self.running.as_mut().ok_or(TransportError::NoChannel)?;
        Ok(running.channel.call(method, params)?)
    }

    /// Whether the sidecar is still running, reaping it if it has exited.
    pub fn is_running(&mut self) -> bool {
        match self.running.as_mut() {
            Some(running) => matches!(running.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Waits out the backoff and starts a replacement sidecar.
    pub fn restart(&mut self) -> Result<(), SupervisorError> {
        self.drop_running();
        thread::sleep(self.backoff.next_delay());
        self.start()
    }

    /// Marks the current sidecar as healthy, clearing the restart sequence.
    pub fn mark_healthy(&mut self) {
        self.backoff.reset();
    }

    /// Whether restarts are frequent enough to report as a crash loop.
    pub fn in_crash_loop(&self) -> bool {
        self.backoff.in_crash_loop()
    }

    pub fn restart_attempts(&self) -> u32 {
        self.backoff.attempts()
    }

    pub fn recordings_dir(&self) -> &Path {
        &self.config.recordings
    }

    fn drop_running(&mut self) {
        if let Some(mut running) = self.running.take() {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

/// Takes the pipes the spawn configured. They are always present because
/// `spawn` asks for both, so this cannot fail in practice.
fn take_channel(child: &mut Child) -> Channel {
    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    Channel::new(stdin, stdout)
}

impl Drop for Supervisor {
    /// A sidecar must not outlive the host that spawned it.
    fn drop(&mut self) {
        self.drop_running();
    }
}
