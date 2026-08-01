//! The client half of the JSON-RPC transport (`runtime.md` §1).
//!
//! Newline-delimited JSON over the sidecar's stdin and stdout. The host is the
//! only caller, so ids are assigned here and correlated by reading the response
//! to each request before sending the next — the pipeline is serialised to one
//! Capture at a time (`add.md` §4), so there is no concurrency to multiplex.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};

#[derive(Debug, Serialize)]
pub struct Request {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
    pub id: u64,
}

impl Request {
    pub fn new(id: u64, method: &str, params: Value) -> Self {
        Self { jsonrpc: "2.0", method: method.to_string(), params, id }
    }
}

#[derive(Debug, Deserialize)]
pub struct Response {
    #[allow(dead_code)]
    pub jsonrpc: String,
    pub result: Option<Value>,
    pub error: Option<RpcError>,
    #[allow(dead_code)]
    pub id: Option<Value>,
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("the sidecar's stdio is not available")]
    NoChannel,
    #[error("the sidecar closed its output before answering")]
    Closed,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed response: {0}")]
    Malformed(#[from] serde_json::Error),
    #[error("sidecar returned an error: {} ({})", .0.message, .0.code)]
    Remote(RpcError),
}

/// The host's end of one sidecar's stdio.
pub struct Channel {
    writer: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: u64,
}

impl Channel {
    pub fn new(writer: ChildStdin, stdout: ChildStdout) -> Self {
        Self { writer, reader: BufReader::new(stdout), next_id: 1 }
    }

    /// Sends a request and returns the result it was answered with.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, TransportError> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&Request::new(id, method, params))?;
        self.receive()
    }

    fn send(&mut self, request: &Request) -> Result<(), TransportError> {
        writeln!(self.writer, "{}", serde_json::to_string(request)?)?;
        self.writer.flush()?;
        Ok(())
    }

    fn receive(&mut self) -> Result<Value, TransportError> {
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Err(TransportError::Closed);
        }
        into_result(serde_json::from_str(line.trim())?)
    }
}

/// A response is one of the two halves, never both (JSON-RPC 2.0 §5).
fn into_result(response: Response) -> Result<Value, TransportError> {
    if let Some(error) = response.error {
        return Err(TransportError::Remote(error));
    }
    Ok(response.result.unwrap_or(Value::Null))
}
