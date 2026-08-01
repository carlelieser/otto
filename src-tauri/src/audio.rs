//! Recording from the default input device to a WAV file.
//!
//! Audio capture is in Rust because that is where the OS APIs are
//! (`runtime.md` §1). Transcription is not: it sits behind the `Transcriber`
//! port, and `ports/` is TypeScript, so the host writes a file and passes the
//! *path* over stdio. Audio bytes never cross the transport — a path is small
//! and a WAV is not.
//!
//! The format is what `whisper.cpp` accepts in Slice 2: 16 kHz mono, 16-bit
//! signed. No mixing, no device selection, no conversion beyond that.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, Stream};
use hound::{WavSpec, WavWriter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// What `whisper.cpp` expects, so no resampling is needed downstream.
pub const SAMPLE_RATE: u32 = 16_000;
pub const CHANNELS: u16 = 1;

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no default input device")]
    NoInputDevice,
    #[error("the input device offers no usable configuration: {0}")]
    NoConfig(String),
    #[error("could not build the input stream: {0}")]
    Stream(String),
    #[error("could not write the recording: {0}")]
    Write(String),
}

pub fn wav_spec() -> WavSpec {
    WavSpec {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    }
}

type Samples = Arc<Mutex<Vec<i16>>>;

/// A recording in progress. Dropping it stops the stream without writing.
pub struct Recording {
    stream: Stream,
    samples: Samples,
    path: PathBuf,
}

impl Recording {
    /// Opens the default input device and begins recording to `path`.
    pub fn start(path: PathBuf) -> Result<Self, AudioError> {
        let device =
            cpal::default_host().default_input_device().ok_or(AudioError::NoInputDevice)?;
        let config = device
            .default_input_config()
            .map_err(|error| AudioError::NoConfig(error.to_string()))?;
        let samples: Samples = Arc::new(Mutex::new(Vec::new()));
        let stream = build_stream(&device, &config, Arc::clone(&samples))?;
        stream.play().map_err(|e| AudioError::Stream(e.to_string()))?;
        Ok(Self { stream, samples, path })
    }

    /// Stops the stream and writes the WAV, returning where it landed.
    pub fn finish(self) -> Result<PathBuf, AudioError> {
        drop(self.stream);
        let samples = self.samples.lock().expect("samples lock").clone();
        write_wav(&self.path, &samples)?;
        Ok(self.path)
    }
}

fn build_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    samples: Samples,
) -> Result<Stream, AudioError> {
    let stream_config = config.config();
    let channels = stream_config.channels;
    let error_handler = |error| eprintln!("otto: input stream error: {error}");
    let stream = match config.sample_format() {
        SampleFormat::F32 => device.build_input_stream(
            stream_config,
            move |data: &[f32], _: &_| collect(data, channels, &samples),
            error_handler,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            stream_config,
            move |data: &[i16], _: &_| collect(data, channels, &samples),
            error_handler,
            None,
        ),
        format => return Err(AudioError::NoConfig(format!("unsupported format {format:?}"))),
    };
    stream.map_err(|error| AudioError::Stream(error.to_string()))
}

/// Downmixes to mono by taking the first channel of each frame.
///
/// Averaging would be defensible, but whisper wants one channel and the first
/// is what a single-microphone device puts the signal on anyway.
fn collect<T: Sample + cpal::SizedSample>(data: &[T], channels: u16, samples: &Samples)
where
    i16: cpal::FromSample<T>,
{
    let mut buffer = samples.lock().expect("samples lock");
    buffer.extend(
        data.chunks(channels.max(1) as usize)
            .filter_map(|frame| frame.first())
            .map(|sample| sample.to_sample::<i16>()),
    );
}

/// Writes samples as a whisper-shaped WAV.
pub fn write_wav(path: &Path, samples: &[i16]) -> Result<(), AudioError> {
    let mut writer =
        WavWriter::create(path, wav_spec()).map_err(|e| AudioError::Write(e.to_string()))?;
    for sample in samples {
        writer.write_sample(*sample).map_err(|e| AudioError::Write(e.to_string()))?;
    }
    writer.finalize().map_err(|e| AudioError::Write(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spec_is_what_whisper_accepts() {
        let spec = wav_spec();
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.bits_per_sample, 16);
    }

    #[test]
    fn a_written_wav_reads_back_with_the_samples_it_was_given() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("tone.wav");
        let samples: Vec<i16> =
            (0..800).map(|n| ((n as f32 / 8.0).sin() * 3000.0) as i16).collect();

        write_wav(&path, &samples).expect("write");

        let reader = hound::WavReader::open(&path).expect("read");
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(reader.len() as usize, samples.len());
    }

    #[test]
    fn stereo_input_is_downmixed_to_one_channel() {
        let samples: Samples = Arc::new(Mutex::new(Vec::new()));
        collect::<i16>(&[100, -100, 200, -200], 2, &samples);
        assert_eq!(*samples.lock().expect("lock"), vec![100, 200]);
    }
}
