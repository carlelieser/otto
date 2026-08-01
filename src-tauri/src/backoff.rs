//! Restart backoff for the sidecar supervisor (`runtime.md` §1).
//!
//! A crash loop must degrade rather than escalate: repeated immediate exits back
//! off instead of spinning, and the host stays responsive throughout. Because
//! the pipeline is resumable per stage, a restart resumes rather than replays,
//! so backing off costs latency rather than work.

use std::time::Duration;

/// Doubling from 100 ms to a 30 s ceiling.
///
/// The ceiling matters more than the curve: an unbounded doubling would take a
/// sidecar that is broken for a minute and leave it unstarted for an hour, which
/// turns a transient failure into a dead application. Capping it means "Captures
/// accumulate" stays a state the system recovers from on its own (`add.md` §11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    attempt: u32,
}

const FIRST_DELAY_MS: u64 = 100;
const CEILING: Duration = Duration::from_secs(30);

/// Consecutive restarts after which the supervisor is in a crash loop.
///
/// Not a stop condition — the supervisor keeps trying, because the cause is
/// often a resource that comes back. It is the point where the degradation is
/// worth reporting rather than absorbing silently.
pub const CRASH_LOOP_THRESHOLD: u32 = 5;

impl Backoff {
    pub fn new() -> Self {
        Self { attempt: 0 }
    }

    /// How long to wait before the next start, and advances the sequence.
    pub fn next_delay(&mut self) -> Duration {
        let delay = self.peek();
        self.attempt = self.attempt.saturating_add(1);
        delay
    }

    /// The delay the next restart would take, without advancing.
    pub fn peek(&self) -> Duration {
        let doublings = self.attempt.min(u32::BITS - 1);
        Duration::from_millis(FIRST_DELAY_MS.saturating_mul(1u64 << doublings)).min(CEILING)
    }

    /// Consecutive failed starts so far.
    pub fn attempts(&self) -> u32 {
        self.attempt
    }

    /// Whether restarts are happening often enough to call it a crash loop.
    pub fn in_crash_loop(&self) -> bool {
        self.attempt >= CRASH_LOOP_THRESHOLD
    }

    /// Clears the sequence once a sidecar has run long enough to count as up.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_restart_is_immediate_enough_to_be_invisible() {
        let mut backoff = Backoff::new();
        assert_eq!(backoff.next_delay(), Duration::from_millis(100));
    }

    #[test]
    fn repeated_failures_back_off_rather_than_spinning() {
        let mut backoff = Backoff::new();
        let delays: Vec<Duration> = (0..4).map(|_| backoff.next_delay()).collect();
        assert_eq!(
            delays,
            vec![
                Duration::from_millis(100),
                Duration::from_millis(200),
                Duration::from_millis(400),
                Duration::from_millis(800),
            ]
        );
    }

    #[test]
    fn backoff_is_capped_so_a_broken_sidecar_still_gets_retried() {
        let mut backoff = Backoff::new();
        for _ in 0..40 {
            backoff.next_delay();
        }
        assert_eq!(backoff.peek(), CEILING);
    }

    #[test]
    fn a_crash_loop_is_recognised_after_repeated_immediate_exits() {
        let mut backoff = Backoff::new();
        assert!(!backoff.in_crash_loop());
        for _ in 0..CRASH_LOOP_THRESHOLD {
            backoff.next_delay();
        }
        assert!(backoff.in_crash_loop());
    }

    #[test]
    fn a_sidecar_that_stays_up_clears_the_sequence() {
        let mut backoff = Backoff::new();
        backoff.next_delay();
        backoff.next_delay();
        backoff.reset();
        assert_eq!(backoff.attempts(), 0);
        assert_eq!(backoff.peek(), Duration::from_millis(100));
    }
}
