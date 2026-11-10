//! Answering from the phone (naru task 2699): a workflow approval gate's
//! Telegram message carries Approve and Cancel buttons, and a reply to that
//! message decides it too.
//!
//! `serve` runs the one `vox events --json` reader ([`start_reader`]);
//! Telegram allows a single update consumer per bot. Each line it prints is
//! untrusted input: it is parsed ([`parse_line`]), matched against the
//! `phone_prompts` row of the message it names, and can do exactly one thing,
//! `Store::decide_workflow_gate` — which is also what makes the first answer
//! win and a redelivered event harmless. See `docs/notify.md`.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::notify;
use super::store::{Error, Store};
use super::types::{WorkflowGate, WorkflowGateStatus};

/// What a reply that is neither an approval nor a cancellation gets back.
const HINT: &str = "Reply approve or cancel, or tap a button.";

/// How long the reader waits before looking again for a vox that has `events`.
const PROBE_EVERY: Duration = Duration::from_secs(300);

/// The longest pause between restarts of an exited `vox events`.
const BACKOFF_MAX: Duration = Duration::from_secs(60);

/// A `phone_prompts` row: Telegram message `message_id` asks about record
/// `ref_id` of `kind` (`gate` = a workflow gate), and said `text`.
#[derive(Debug, Clone, PartialEq)]
pub struct PhonePrompt {
    pub message_id: i64,
    pub kind: String,
    pub ref_id: i64,
    pub text: String,
}

/// One line of `vox events --json`.
#[derive(Debug, PartialEq)]
pub enum Event {
    /// A button tap on message `message_id`, carrying the button's `data`.
    Choice { message_id: i64, data: String },
    /// Message `message_id`, a text reply to message `reply_to`.
    Reply {
        reply_to: i64,
        message_id: i64,
        text: String,
    },
}

/// Parses one event line; anything else is `None`.
pub fn parse_line(line: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let int = |key: &str| v.get(key)?.as_i64();
    let text = |key: &str| Some(v.get(key)?.as_str()?.to_string());
    match v.get("kind")?.as_str()? {
        "choice" => Some(Event::Choice {
            message_id: int("message_id")?,
            data: text("data")?,
        }),
        "reply" => Some(Event::Reply {
            reply_to: int("reply_to_message_id")?,
            message_id: int("message_id")?,
            text: text("text")?,
        }),
        _ => None,
    }
}

/// The callback data of a gate's button: `gate:<id>:approve|reject`.
pub fn gate_data(gate_id: i64, approve: bool) -> String {
    let verb = if approve { "approve" } else { "reject" };
    format!("gate:{gate_id}:{verb}")
}

/// The gate and decision a button's data names — exactly what [`gate_data`]
/// writes, nothing looser.
pub fn parse_gate_data(data: &str) -> Option<(i64, WorkflowGateStatus)> {
    let (id, verb) = data.strip_prefix("gate:")?.split_once(':')?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let status = match verb {
        "approve" => WorkflowGateStatus::Approved,
        "reject" => WorkflowGateStatus::Rejected,
        _ => return None,
    };
    Some((id.parse().ok()?, status))
}

/// The decision a reply's text gives: one of a fixed list of words, trimmed
/// and lowercased. Any other text decides nothing.
pub fn reply_word(text: &str) -> Option<WorkflowGateStatus> {
    match text.trim().to_lowercase().as_str() {
        "approve" | "approved" | "yes" | "y" | "ok" => Some(WorkflowGateStatus::Approved),
        "cancel" | "reject" | "rejected" | "no" | "n" => Some(WorkflowGateStatus::Rejected),
        _ => None,
    }
}

/// A decided gate's message: what was sent, then the outcome and where the
/// decision came from.
pub fn decided_text(text: &str, gate: &WorkflowGate) -> String {
    let outcome = if gate.status == WorkflowGateStatus::Approved {
        "Approved"
    } else {
        "Cancelled"
    };
    let how = match gate.reason.as_deref() {
        Some("telegram") => "from Telegram",
        Some("timed out") => "timed out",
        _ => "in Naru",
    };
    format!("{text} - {outcome} ({how})")
}

/// What handling a line asks of vox, done after the store lock is released.
#[derive(Debug, PartialEq)]
pub enum Action {
    Nothing,
    /// Replace message `message_id`'s text (its buttons go with it).
    Edit {
        message_id: i64,
        text: String,
    },
    /// Tell the sender of message `reply_to` what a reply may say.
    Hint {
        reply_to: i64,
    },
}

/// Applies one event line to the store. A tap must name, in its data, the
/// gate its own message was sent for; a reply must be to a gate's message.
/// Everything else — a malformed line, an unknown message or gate — changes
/// nothing. An already-decided gate is not an error: its message is edited
/// so the stale buttons disappear.
pub fn handle_line(store: &mut Store, line: &str) -> Action {
    let gate_prompt = |store: &Store, message_id: i64| match store.phone_prompt(message_id) {
        Ok(Some(p)) if p.kind == "gate" => Some(p),
        Ok(_) => None,
        Err(e) => {
            eprintln!("naru: phone event: {e}");
            None
        }
    };
    match parse_line(line) {
        Some(Event::Choice { message_id, data }) => {
            let Some((gate_id, status)) = parse_gate_data(&data) else {
                return Action::Nothing;
            };
            match gate_prompt(store, message_id) {
                Some(p) if p.ref_id == gate_id => decide(store, &p, status),
                _ => {
                    eprintln!(
                        "naru: phone tap ignored: message {message_id} is not gate {gate_id}'s"
                    );
                    Action::Nothing
                }
            }
        }
        Some(Event::Reply {
            reply_to,
            message_id,
            text,
        }) => {
            let Some(p) = gate_prompt(store, reply_to) else {
                return Action::Nothing;
            };
            match reply_word(&text) {
                Some(status) => decide(store, &p, status),
                None => match store.get_workflow_gate(p.ref_id) {
                    Ok(g) if g.status == WorkflowGateStatus::Pending => Action::Hint {
                        reply_to: message_id,
                    },
                    Ok(g) => closed(&p, &g),
                    Err(_) => Action::Nothing,
                },
            }
        }
        None => Action::Nothing,
    }
}

fn closed(prompt: &PhonePrompt, gate: &WorkflowGate) -> Action {
    Action::Edit {
        message_id: prompt.message_id,
        text: decided_text(&prompt.text, gate),
    }
}

/// Decides `prompt`'s gate and closes its message, whether this answer won
/// or the gate was already decided. (`workflow::run_gate` closes the message
/// for every other path, and leaves a `telegram` decision to this one, so a
/// gate whose run is gone still loses its buttons.)
fn decide(store: &mut Store, prompt: &PhonePrompt, status: WorkflowGateStatus) -> Action {
    match store.decide_workflow_gate(prompt.ref_id, status, Some("telegram")) {
        Ok(g) => closed(prompt, &g),
        Err(Error::Conflict(_)) => match store.get_workflow_gate(prompt.ref_id) {
            Ok(g) => closed(prompt, &g),
            Err(_) => Action::Nothing,
        },
        Err(e) => {
            eprintln!("naru: phone answer for gate {} ignored: {e}", prompt.ref_id);
            Action::Nothing
        }
    }
}

/// Carries out an [`Action`] through vox; a failure is only logged.
fn perform(action: Action) {
    let done = match action {
        Action::Nothing => Ok(()),
        Action::Edit { message_id, text } => notify::edit_message(message_id, &text),
        Action::Hint { reply_to } => notify::reply_to(reply_to, HINT),
    };
    if let Err(e) = done {
        eprintln!("naru: phone answer follow-up not sent: {e}");
    }
}

/// The running reader; [`Reader::stop`] ends it.
pub struct Reader {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Reader {
    /// Kills `vox events` and stops restarting it.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        kill(&self.child);
    }
}

fn kill(child: &Mutex<Option<Child>>) {
    if let Some(mut c) = child.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Starts the one `vox events --json` reader on its own thread, or returns
/// `None` where it must not run (`notify::reader_bin`). The child is
/// restarted with backoff when it exits; a vox without `events` (older, or
/// not installed) is looked for again every [`PROBE_EVERY`]. The store lock
/// is held only to apply a line, never across a vox call or a read.
pub fn start_reader(store: Arc<Mutex<Store>>) -> Option<Reader> {
    let bin = notify::reader_bin()?;
    let reader = Reader {
        stop: Arc::new(AtomicBool::new(false)),
        child: Arc::new(Mutex::new(None)),
    };
    let (stop, child) = (reader.stop.clone(), reader.child.clone());
    std::thread::spawn(move || {
        let mut backoff = Duration::from_secs(1);
        let mut told = false;
        while !stop.load(Ordering::SeqCst) {
            if !notify::events_supported(&bin) {
                if !told {
                    eprintln!(
                        "naru: `{bin}` has no `events` subcommand (not installed, or older \
                         than vox task 2698); answers from Telegram are off"
                    );
                    told = true;
                }
                std::thread::sleep(PROBE_EVERY);
                continue;
            }
            told = false;
            let started = Instant::now();
            match Command::new(&bin)
                .args(["events", "--json"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .spawn()
            {
                Ok(mut c) => {
                    let out = c.stdout.take();
                    *child.lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
                    if stop.load(Ordering::SeqCst) {
                        kill(&child);
                        break;
                    }
                    for line in out.into_iter().flat_map(|o| BufReader::new(o).lines()) {
                        let line = match line {
                            Ok(line) => line,
                            // Not UTF-8: that line is consumed; read on.
                            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => continue,
                            Err(_) => break,
                        };
                        let action = handle_line(
                            &mut store.lock().unwrap_or_else(|e| e.into_inner()),
                            &line,
                        );
                        perform(action);
                    }
                    kill(&child);
                }
                Err(e) => eprintln!("naru: could not run `{bin} events`: {e}"),
            }
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if started.elapsed() > BACKOFF_MAX {
                backoff = Duration::from_secs(1);
            }
            eprintln!(
                "naru: `{bin} events` exited; restarting in {}s",
                backoff.as_secs()
            );
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    });
    Some(reader)
}

#[cfg(test)]
mod tests {
    use super::*;
    use WorkflowGateStatus::{Approved, Pending, Rejected};

    #[test]
    fn parses_event_lines_and_nothing_else() {
        assert_eq!(
            parse_line(r#"{"kind":"choice","message_id":7,"data":"gate:3:approve","user_id":1}"#),
            Some(Event::Choice {
                message_id: 7,
                data: "gate:3:approve".into()
            })
        );
        assert_eq!(
            parse_line(
                r#"{"kind":"reply","reply_to_message_id":7,"message_id":9,"text":"ok","user_id":1}"#
            ),
            Some(Event::Reply {
                reply_to: 7,
                message_id: 9,
                text: "ok".into()
            })
        );
        for bad in [
            "",
            "not json",
            "[]",
            r#"{"kind":"other","message_id":7,"data":"x"}"#,
            r#"{"kind":"choice","data":"gate:3:approve"}"#,
            r#"{"kind":"choice","message_id":"7","data":"gate:3:approve"}"#,
            r#"{"kind":"choice","message_id":7,"data":3}"#,
            r#"{"kind":"reply","message_id":9,"text":"ok"}"#,
            r#"{"kind":"reply","reply_to_message_id":7,"message_id":9}"#,
        ] {
            assert_eq!(parse_line(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn gate_data_round_trips_and_is_strict() {
        assert_eq!(parse_gate_data(&gate_data(12, true)), Some((12, Approved)));
        assert_eq!(parse_gate_data(&gate_data(12, false)), Some((12, Rejected)));
        for bad in [
            "",
            "gate:",
            "gate:12",
            "gate::approve",
            "gate:12:",
            "gate:12:yes",
            "gate:12:approve:x",
            "gate:-1:approve",
            "gate:+1:approve",
            "gate: 1:approve",
            "gate:1e3:approve",
            "gate:99999999999999999999:approve",
            "question:12:approve",
            "GATE:12:approve",
        ] {
            assert_eq!(parse_gate_data(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn reply_words() {
        for w in ["approve", "Approved", " YES ", "y", "ok\n"] {
            assert_eq!(reply_word(w), Some(Approved), "{w:?}");
        }
        for w in ["cancel", "Reject", "rejected", " NO", "n"] {
            assert_eq!(reply_word(w), Some(Rejected), "{w:?}");
        }
        for w in [
            "",
            "maybe",
            "yes please",
            "approve it",
            "okay",
            "gate:1:approve",
        ] {
            assert_eq!(reply_word(w), None, "{w:?}");
        }
    }

    /// A store with a workflow and a running run of it.
    fn fixture() -> (Store, tempfile::TempDir, i64, i64) {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(&dir.path().join("t.db")).unwrap();
        let wf = s.create_workflow(None, "G", None).unwrap().id;
        let run = s
            .create_workflow_run(wf, crate::core::types::WorkflowTrigger::Manual, "")
            .unwrap()
            .id;
        (s, dir, run, 1)
    }

    fn gate(s: &mut Store, run: i64, node: i64, message_id: i64) -> i64 {
        let id = s.create_workflow_gate(run, node, "ship?").unwrap().id;
        s.record_phone_prompt(message_id, "gate", id, "Ship?")
            .unwrap();
        id
    }

    fn edit(message_id: i64, text: &str) -> Action {
        Action::Edit {
            message_id,
            text: text.into(),
        }
    }

    fn tap(message_id: i64, data: &str) -> String {
        serde_json::json!({"kind": "choice", "message_id": message_id, "data": data, "user_id": 1})
            .to_string()
    }

    fn reply(reply_to: i64, text: &str) -> String {
        serde_json::json!({"kind": "reply", "reply_to_message_id": reply_to, "message_id": 900,
            "text": text, "user_id": 1})
        .to_string()
    }

    #[test]
    fn a_tap_decides_only_the_gate_its_message_was_sent_for() {
        let (mut s, _d, run, node) = fixture();
        let a = gate(&mut s, run, node, 100);
        let b = gate(&mut s, run, node, 101);
        let status = |s: &Store, id| s.get_workflow_gate(id).unwrap().status;

        // Data naming another gate, an unknown message, an unknown gate,
        // malformed data and a malformed line all change nothing.
        for line in [
            tap(100, &gate_data(b, true)),
            tap(555, &gate_data(a, true)),
            tap(100, "gate:9999:approve"),
            tap(100, "gate:x:approve"),
            tap(100, "question:1:approve"),
            "garbage".to_string(),
        ] {
            assert_eq!(handle_line(&mut s, &line), Action::Nothing, "{line}");
        }
        assert_eq!((status(&s, a), status(&s, b)), (Pending, Pending));

        assert_eq!(
            handle_line(&mut s, &tap(100, &gate_data(a, true))),
            edit(100, "Ship? - Approved (from Telegram)")
        );
        let g = s.get_workflow_gate(a).unwrap();
        assert_eq!(
            (g.status, g.reason.as_deref()),
            (Approved, Some("telegram"))
        );
        assert_eq!(status(&s, b), Pending);

        // First answer wins, and a redelivered or late event only closes
        // the message.
        for line in [
            tap(100, &gate_data(a, false)),
            tap(100, &gate_data(a, true)),
        ] {
            assert_eq!(
                handle_line(&mut s, &line),
                Action::Edit {
                    message_id: 100,
                    text: "Ship? - Approved (from Telegram)".into()
                }
            );
        }
        assert_eq!(status(&s, a), Approved);

        assert_eq!(
            handle_line(&mut s, &tap(101, &gate_data(b, false))),
            edit(101, "Ship? - Cancelled (from Telegram)")
        );
        assert_eq!(status(&s, b), Rejected);
    }

    #[test]
    fn a_reply_decides_with_a_known_word_and_is_hinted_otherwise() {
        let (mut s, _d, run, node) = fixture();
        let a = gate(&mut s, run, node, 100);
        let b = gate(&mut s, run, node, 101);

        assert_eq!(handle_line(&mut s, &reply(555, "approve")), Action::Nothing);
        assert_eq!(
            handle_line(&mut s, &reply(100, "what is this?")),
            Action::Hint { reply_to: 900 }
        );
        assert_eq!(s.get_workflow_gate(a).unwrap().status, Pending);

        assert_eq!(
            handle_line(&mut s, &reply(100, " Approve ")),
            edit(100, "Ship? - Approved (from Telegram)")
        );
        assert_eq!(s.get_workflow_gate(a).unwrap().status, Approved);
        assert_eq!(
            handle_line(&mut s, &reply(101, "cancel")),
            edit(101, "Ship? - Cancelled (from Telegram)")
        );
        assert_eq!(s.get_workflow_gate(b).unwrap().status, Rejected);

        // Decided in Naru first: a later reply changes nothing.
        let c = gate(&mut s, run, node, 102);
        s.decide_workflow_gate(c, Rejected, None).unwrap();
        for text in ["approve", "hello"] {
            assert_eq!(
                handle_line(&mut s, &reply(102, text)),
                Action::Edit {
                    message_id: 102,
                    text: "Ship? - Cancelled (in Naru)".into()
                }
            );
        }
        assert_eq!(s.get_workflow_gate(c).unwrap().status, Rejected);
    }
}
