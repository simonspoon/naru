//! Answering from the phone (naru tasks 2699 and 2700): a workflow approval
//! gate's Telegram message carries Approve and Cancel buttons, and a reply to
//! that message decides it too; an agent's `naru ask` question, once it is
//! sent to the phone ([`send_question`]), carries A/B/C buttons for its
//! choices and takes a reply as its answer.
//!
//! `serve` runs the one `vox events --json` reader ([`start_reader`]);
//! Telegram allows a single update consumer per bot. Each line it prints is
//! untrusted input: it is parsed ([`parse_line`]), matched against the
//! `phone_prompts` row of the message it names, and can do exactly one thing:
//! `Store::decide_workflow_gate` for a gate, `Store::answer_question` for a
//! question — which is also what makes the first answer win and a redelivered
//! event harmless. See `docs/notify.md`.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::notify;
use super::store::{Error, Store};
use super::types::{AgentQuestion, WorkflowGate, WorkflowGateStatus};

/// The longest piece of a question or an answer put in a Telegram message
/// (its limit is 4096 characters).
const PHONE_TEXT_MAX: usize = 900;

/// How long `naru ask` waits on vox: to learn whether it has `events`, and to
/// send or edit a message. A hung vox must not hold the agent.
const PROBE_LIMIT: Duration = Duration::from_secs(2);
const VOX_LIMIT: Duration = Duration::from_secs(8);

/// The line under a question that says how to answer it.
const QUESTION_HINT: &str = "Tap a choice or reply to this message with your answer.";
const QUESTION_HINT_NO_CHOICES: &str = "Reply to this message with your answer.";

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

/// The callback data of a question's button: `q:<id>:<index>`.
pub fn question_data(question_id: i64, index: usize) -> String {
    format!("q:{question_id}:{index}")
}

/// The question and choice index a button's data names — exactly what
/// [`question_data`] writes, nothing looser.
pub fn parse_question_data(data: &str) -> Option<(i64, usize)> {
    let (id, index) = data.strip_prefix("q:")?.split_once(':')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(id) || !digits(index) {
        return None;
    }
    Some((id.parse().ok()?, index.parse().ok()?))
}

/// `text` cut to at most `max` characters, with `…` when it was longer.
fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}…")
}

/// The choice label letter: A, B, C ...
fn letter(index: usize) -> char {
    (b'A' + index as u8) as char
}

/// What a question's message says (without the how-to-answer line), and what
/// the edit that closes it starts from.
pub fn question_text(q: &AgentQuestion) -> String {
    let mut text = cut(&q.body, PHONE_TEXT_MAX);
    if let Some(task) = q.task_id {
        text.push_str(&format!(" (task {task})"));
    }
    text
}

/// A question's message once it is answered, or no longer needed.
fn question_closed_text(prompt_text: &str, q: &AgentQuestion) -> Option<String> {
    match (q.status.as_str(), q.answer.as_deref()) {
        ("answered", Some(a)) => Some(format!(
            "{prompt_text} - Answered: {}",
            cut(a, PHONE_TEXT_MAX)
        )),
        ("expired", _) => Some(format!("{prompt_text} - No longer needed")),
        _ => None,
    }
}

/// Sends question `q` to the phone and remembers the message, so a tap or a
/// reply can answer it. Only where the phone may be reached
/// (`notify::reader_bin`); with a vox older than `events` it is sent as plain
/// text, with no buttons and no how-to-answer line. Every vox call is bounded
/// ([`PROBE_LIMIT`], [`VOX_LIMIT`]). Returns the Telegram message id.
pub fn send_question(store: &mut Store, q: &AgentQuestion) -> Result<i64, Error> {
    let bin = notify::reader_bin().ok_or_else(|| {
        Error::Unavailable("the phone is not reachable from this environment".into())
    })?;
    let prompt_text = question_text(q);
    let mut text = prompt_text.clone();
    let mut choices = Vec::new();
    if notify::events_supported_within(&bin, PROBE_LIMIT) {
        text.push('\n');
        text.push_str(if q.choices.is_empty() {
            QUESTION_HINT_NO_CHOICES
        } else {
            QUESTION_HINT
        });
        for (i, label) in q.choices.iter().enumerate() {
            choices.push((format!("{}: {label}", letter(i)), question_data(q.id, i)));
        }
    }
    let message_id = notify::send_bounded(&bin, &text, "Naru: question", &choices, VOX_LIMIT)?;
    store.record_phone_prompt(message_id, "question", q.id, &prompt_text)?;
    Ok(message_id)
}

/// After a question was answered outside Telegram (`naru ask answer`), edits
/// its phone message, if it had one, to show the answer. Best-effort and
/// bounded; no phone prompt means no vox call at all.
pub fn close_question_prompt(store: &Store, q: &AgentQuestion) {
    let Ok(Some(prompt)) = store.phone_prompt_for("question", q.id) else {
        return;
    };
    let (Some(text), Some(bin)) = (question_closed_text(&prompt.text, q), notify::reader_bin())
    else {
        return;
    };
    if let Err(e) = notify::edit_bounded(&bin, prompt.message_id, &text, VOX_LIMIT) {
        eprintln!("naru: question {} phone message not updated: {e}", q.id);
    }
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
    let prompt_of =
        |store: &Store, message_id: i64, kind: &str| match store.phone_prompt(message_id) {
            Ok(Some(p)) if p.kind == kind => Some(p),
            Ok(_) => None,
            Err(e) => {
                eprintln!("naru: phone event: {e}");
                None
            }
        };
    match parse_line(line) {
        Some(Event::Choice { message_id, data }) => {
            if let Some((question_id, index)) = parse_question_data(&data) {
                return match prompt_of(store, message_id, "question") {
                    Some(p) if p.ref_id == question_id => tap_question(store, &p, index),
                    _ => {
                        eprintln!(
                            "naru: phone tap ignored: message {message_id} is not question {question_id}'s"
                        );
                        Action::Nothing
                    }
                };
            }
            let Some((gate_id, status)) = parse_gate_data(&data) else {
                return Action::Nothing;
            };
            match prompt_of(store, message_id, "gate") {
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
            if let Some(p) = prompt_of(store, reply_to, "question") {
                return reply_question(store, &p, &text);
            }
            let Some(p) = prompt_of(store, reply_to, "gate") else {
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

/// A tap on choice `index` of the question `prompt` was sent for.
fn tap_question(store: &mut Store, prompt: &PhonePrompt, index: usize) -> Action {
    let label = match store.get_question(prompt.ref_id) {
        Ok(q) => q.choices.get(index).cloned(),
        Err(e) => {
            eprintln!("naru: phone tap ignored: {e}");
            return Action::Nothing;
        }
    };
    match label {
        Some(label) => answer_question(store, prompt, &label),
        None => {
            eprintln!(
                "naru: phone tap ignored: question {} has no choice {index}",
                prompt.ref_id
            );
            Action::Nothing
        }
    }
}

/// A reply to the message of the question `prompt` was sent for: its trimmed
/// text is the answer, verbatim (data, never interpreted) — except that a
/// single letter naming a choice (`a`, `B` ...) answers with that choice.
fn reply_question(store: &mut Store, prompt: &PhonePrompt, text: &str) -> Action {
    let text = text.trim();
    if text.is_empty() {
        return Action::Nothing;
    }
    let mut chars = text.chars();
    let picked = match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphabetic() => {
            store.get_question(prompt.ref_id).ok().and_then(|q| {
                q.choices
                    .get((c.to_ascii_uppercase() as u8 - b'A') as usize)
                    .cloned()
            })
        }
        _ => None,
    };
    answer_question(store, prompt, picked.as_deref().unwrap_or(text))
}

/// Answers `prompt`'s question and closes its message, whether this answer
/// won or the question was already settled (answered, or expired).
fn answer_question(store: &mut Store, prompt: &PhonePrompt, answer: &str) -> Action {
    let q = match store.answer_question(prompt.ref_id, answer) {
        Ok(q) => q,
        Err(Error::Conflict(_)) => match store.get_question(prompt.ref_id) {
            Ok(q) => q,
            Err(_) => return Action::Nothing,
        },
        Err(e) => {
            eprintln!(
                "naru: phone answer for question {} ignored: {e}",
                prompt.ref_id
            );
            return Action::Nothing;
        }
    };
    match question_closed_text(&prompt.text, &q) {
        Some(text) => Action::Edit {
            message_id: prompt.message_id,
            text,
        },
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

    fn question(s: &mut Store, message_id: i64, choices: &[&str]) -> i64 {
        let choices: Vec<String> = choices.iter().map(|c| c.to_string()).collect();
        let q = s
            .add_question("Which?", None, None, "question", &choices)
            .unwrap();
        s.record_phone_prompt(message_id, "question", q.id, &question_text(&q))
            .unwrap();
        q.id
    }

    #[test]
    fn question_data_round_trips_and_is_strict() {
        assert_eq!(parse_question_data(&question_data(12, 2)), Some((12, 2)));
        for bad in [
            "",
            "q:",
            "q:12",
            "q::1",
            "q:12:",
            "q:12:1:x",
            "q:-1:0",
            "q:1:-1",
            "q:+1:0",
            "q: 1:0",
            "q:1e3:0",
            "q:99999999999999999999:0",
            "q:1:99999999999999999999",
            "Q:1:0",
            "gate:1:approve",
        ] {
            assert_eq!(parse_question_data(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_tap_answers_only_the_question_its_message_was_sent_for() {
        let (mut s, _d, run, node) = fixture();
        let a = question(&mut s, 200, &["Red", "Green", "Blue"]);
        let b = question(&mut s, 201, &["Yes", "No"]);
        let g = gate(&mut s, run, node, 100);
        let answer = |s: &Store, id| s.get_question(id).unwrap().answer;

        for line in [
            tap(200, &question_data(b, 0)),   // another question's data
            tap(555, &question_data(a, 0)),   // unknown message
            tap(200, &question_data(999, 0)), // unknown question
            tap(200, &question_data(a, 3)),   // out of range
            tap(200, "q:x:1"),
            tap(100, &question_data(a, 0)), // a gate's message
            tap(200, &gate_data(g, true)),  // gate data on a question's message
            "garbage".to_string(),
        ] {
            assert_eq!(handle_line(&mut s, &line), Action::Nothing, "{line}");
        }
        assert_eq!((answer(&s, a), answer(&s, b)), (None, None));
        assert_eq!(s.get_workflow_gate(g).unwrap().status, Pending);

        assert_eq!(
            handle_line(&mut s, &tap(200, &question_data(a, 1))),
            edit(200, "Which? - Answered: Green")
        );
        assert_eq!(answer(&s, a).as_deref(), Some("Green"));
        // First answer wins; a late tap or reply only repeats the stored one.
        for line in [tap(200, &question_data(a, 0)), reply(200, "Blue")] {
            assert_eq!(
                handle_line(&mut s, &line),
                edit(200, "Which? - Answered: Green")
            );
        }
        assert_eq!(answer(&s, a).as_deref(), Some("Green"));
        assert_eq!(answer(&s, b), None);
    }

    #[test]
    fn a_reply_answers_verbatim_and_a_letter_picks_a_choice() {
        let (mut s, _d, _run, _node) = fixture();
        let a = question(&mut s, 200, &["Red", "Green"]);
        let b = question(&mut s, 201, &["Red", "Green"]);
        let c = question(&mut s, 202, &[]);
        let d = question(&mut s, 203, &["Red", "Green"]);

        assert_eq!(handle_line(&mut s, &reply(200, "  \n ")), Action::Nothing);
        assert_eq!(handle_line(&mut s, &reply(555, "x")), Action::Nothing);
        assert_eq!(
            handle_line(&mut s, &reply(200, " b ")),
            edit(200, "Which? - Answered: Green")
        );
        assert_eq!(
            handle_line(&mut s, &reply(201, " Fish; rm -rf / `x` ")),
            edit(201, "Which? - Answered: Fish; rm -rf / `x`")
        );
        // A letter beyond the choices, or on a question with none, is text.
        assert_eq!(
            handle_line(&mut s, &reply(202, "a")),
            edit(202, "Which? - Answered: a")
        );
        assert_eq!(
            handle_line(&mut s, &reply(203, "C")),
            edit(203, "Which? - Answered: C")
        );
        let answer = |s: &Store, id| s.get_question(id).unwrap().answer.unwrap();
        assert_eq!(answer(&s, a), "Green");
        assert_eq!(answer(&s, b), "Fish; rm -rf / `x`");
        assert_eq!(answer(&s, c), "a");
        assert_eq!(answer(&s, d), "C");

        // Over-long: a validation error, nothing stored.
        let e = question(&mut s, 204, &[]);
        let long = "x".repeat(Store::QUESTION_MAX + 1);
        assert_eq!(handle_line(&mut s, &reply(204, &long)), Action::Nothing);
        assert_eq!(s.get_question(e).unwrap().status, "open");
    }

    #[test]
    fn the_closing_edit_cuts_a_long_answer_and_notes_an_expired_question() {
        let (mut s, _d, _run, _node) = fixture();
        let a = question(&mut s, 200, &[]);
        let long = "y".repeat(3000);
        let Action::Edit { text, .. } = handle_line(&mut s, &reply(200, &long)) else {
            panic!("no edit");
        };
        assert!(text.chars().count() < 1600, "{}", text.chars().count());
        assert!(text.ends_with('…'));
        assert_eq!(s.get_question(a).unwrap().answer.unwrap(), long);

        let b = question(&mut s, 201, &["Red", "Green"]);
        rusqlite::Connection::open(_d.path().join("t.db"))
            .unwrap()
            .execute(
                "UPDATE agent_questions SET status = 'expired' WHERE id = ?1",
                [b],
            )
            .unwrap();
        assert_eq!(
            handle_line(&mut s, &tap(201, &question_data(b, 0))),
            edit(201, "Which? - No longer needed")
        );
    }

    #[test]
    fn question_text_cuts_the_body_and_names_the_task() {
        let (mut s, _d, _run, _node) = fixture();
        let mut q = s
            .add_question(&"z".repeat(2000), None, None, "question", &[])
            .unwrap();
        let text = question_text(&q);
        assert_eq!(text.chars().count(), PHONE_TEXT_MAX + 1);
        assert!(text.ends_with('…') && !text.contains("(task"));
        q.body = "Which?".into();
        q.task_id = Some(7);
        assert_eq!(question_text(&q), "Which? (task 7)");
    }
}
