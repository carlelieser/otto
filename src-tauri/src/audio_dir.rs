//! The Otto-owned directory temporary recordings live in, and the sweep that
//! clears the ones nobody read.
//!
//! The host writes the WAV and the sidecar deletes it after a successful read
//! (`runtime.md` §2), so a file still present when the sidecar restarts is one
//! whose reader died mid-read. Those are the orphans, and this is what removes
//! them.
//!
//! Deliberately not the system temp root. The sweep deletes on a timer, and a
//! sweep pointed at a shared directory deletes other applications' files the
//! first time a pattern is written badly. Scoping it to a directory Otto
//! created makes the blast radius the thing Otto owns.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The extension every recording carries; the sweep removes nothing else.
const RECORDING_EXTENSION: &str = "wav";

/// Creates the recordings directory under `base` if it is not already there.
pub fn ensure_dir(base: &Path) -> io::Result<PathBuf> {
    let directory = base.join("otto").join("recordings");
    fs::create_dir_all(&directory)?;
    Ok(directory)
}

/// Deletes every recording left in `directory`, returning how many went.
///
/// Errors on individual files are counted as not-swept rather than aborting the
/// pass: one undeletable file must not leave the rest to accumulate.
pub fn sweep_orphans(directory: &Path) -> io::Result<usize> {
    let mut swept = 0;
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if is_recording(&path) && fs::remove_file(&path).is_ok() {
            swept += 1;
        }
    }
    Ok(swept)
}

/// Whether a path is one of Otto's recordings, and so safe to remove.
fn is_recording(path: &Path) -> bool {
    path.is_file() && path.extension().is_some_and(|ext| ext == RECORDING_EXTENSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, b"not really audio").expect("write");
        path
    }

    #[test]
    fn the_recordings_directory_is_created_under_otto() {
        let base = tempfile::tempdir().expect("tempdir");
        let directory = ensure_dir(base.path()).expect("ensure");
        assert!(directory.is_dir());
        assert!(directory.ends_with("otto/recordings"));
    }

    #[test]
    fn ensuring_an_existing_directory_is_not_an_error() {
        let base = tempfile::tempdir().expect("tempdir");
        let first = ensure_dir(base.path()).expect("ensure");
        let second = ensure_dir(base.path()).expect("ensure again");
        assert_eq!(first, second);
    }

    #[test]
    fn an_orphaned_recording_is_swept() {
        let base = tempfile::tempdir().expect("tempdir");
        let directory = ensure_dir(base.path()).expect("ensure");
        let orphan = write(&directory, "abandoned.wav");

        assert_eq!(sweep_orphans(&directory).expect("sweep"), 1);
        assert!(!orphan.exists());
    }

    #[test]
    fn the_sweep_leaves_files_that_are_not_recordings_alone() {
        let base = tempfile::tempdir().expect("tempdir");
        let directory = ensure_dir(base.path()).expect("ensure");
        let bystander = write(&directory, "notes.txt");

        assert_eq!(sweep_orphans(&directory).expect("sweep"), 0);
        assert!(bystander.exists());
    }

    #[test]
    fn sweeping_an_empty_directory_removes_nothing() {
        let base = tempfile::tempdir().expect("tempdir");
        let directory = ensure_dir(base.path()).expect("ensure");
        assert_eq!(sweep_orphans(&directory).expect("sweep"), 0);
    }
}
