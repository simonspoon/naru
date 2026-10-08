//! The cost guard: deciding whether a *currently running* Claude Code session
//! has gone wrong, and saying so in prose a person can read (mesa task 1018,
//! `docs/cost-guard.md`).
//!
//! The motivating incident is the whole design brief. One session spent
//! $1,413.72 across 2.76B tokens in 7h55m, 91.2% of it inside a single 6h14m
//! window that was 99.8% cache **reads** with almost no output — an agent
//! re-reading the same context forever. Every part of that was visible in
//! `mesa cc` the entire time; nothing was *watching*. So this module is
//! deliberately small: it turns the numbers [`crate::core::cc::live`] already
//! computes into a verdict, and the verdict into a sentence.
//!
//! The rules themselves read nothing — no files, no db, no clock; every input
//! arrives as an argument, which is what makes them testable and what keeps
//! the guard from becoming a second transcript-ingestion path. Only
//! [`resolve_task`] and [`report`] touch the store, and only to *read*: the
//! guard writes nothing of its own except the inbox item its watcher files.

use crate::core::store::{Result, Store};
use crate::core::types::{Artifact, CcLive, CcLiveSession, Status, Task};
use serde::Serialize;

/// How far back the guard looks: one hour.
///
/// Wider than `cc live`'s own 15-minute default (`cc::DEFAULT_LIVE_MINUTES`)
/// and narrower than its 1440-minute ceiling, for two reasons. Every figure
/// the rules read is a **window** total, not a session lifetime, so the window
/// is also the unit the thresholds are denominated in — and an hour of spend
/// is the unit a person already thinks in. And a session that pauses for a few
/// minutes between tool calls must not drop out of view between ticks; fifteen
/// minutes is short enough that a thinking agent can.
pub const DEFAULT_GUARD_WINDOW_MINUTES: i64 = 60;

/// The dollars-in-the-window rule.
pub const COST: &str = "cost";
/// The tokens-in-the-window rule.
pub const TOKENS: &str = "tokens";
/// The spin-loop rule: enormous volume that is almost entirely cache reads.
pub const SPIN: &str = "spin";
/// The repeat rule: the same trivial shell command, over and over.
pub const REPEAT: &str = "repeat";
/// The context-size rule: the newest main-thread turn re-read a huge context.
/// Alert-only by design — it never stops a session by itself ([`wants_stop`]).
pub const CONTEXT: &str = "context";

/// What the watcher does about a breach (mesa task 1054).
///
/// A switch and not a boolean because the two answers are different postures
/// rather than a feature being on or off, and because the default changed: the
/// guard shipped reporting only, on the reasoning that a person should decide.
/// The incident that followed — a session that ran `echo idle` 4,600 times
/// across eight hours and $1,373 while three inbox items about it went unread
/// — is what settled that argument. A person who is not there cannot decide.
///
/// Stopping is [`crate::core::agents::stop`], `claude stop <job id>`: the
/// session's conversation survives it and `claude attach <job id>` resumes it,
/// so the destructive-sounding verb is closer to a pause than a kill. Only a
/// **background** session mesa can find a job id for can be stopped at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GuardAction {
    /// Stop the session, then file the alert saying so. The built-in.
    Stop,
    /// File the alert and nothing else — the behaviour before task 1054.
    Report,
}

impl GuardAction {
    /// The config spelling, or `None` for a word mesa does not know — the
    /// clamp posture every other guard key takes.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stop" => Some(Self::Stop),
            "report" => Some(Self::Report),
            _ => None,
        }
    }

    /// The config spelling of this action.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Report => "report",
        }
    }
}

/// What actually happened to a breaching session on this tick — the sentence
/// the alert closes with, and the reason [`alert_body`] takes it as an
/// argument rather than restating policy. A person reading an alert needs to
/// know whether the thing is still running, and only the caller knows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum StopOutcome {
    /// mesa ran `claude stop <job_id>` and it succeeded.
    Stopped { job_id: String },
    /// mesa found a session to stop on an earlier tick and already did.
    AlreadyStopped,
    /// mesa tried and could not; the session is still running.
    StopFailed { reason: String },
    /// No background job id names this session, so there is nothing mesa can
    /// stop — an interactive session in someone's own terminal, or one started
    /// by something other than `claude --bg`.
    NotBackground,
    /// The `report` action: mesa did not try.
    Reported,
    /// Every breach this time was the `context` rule, which only reports:
    /// mesa did not try to stop it, whatever the action says.
    ContextOnly,
    /// The relay (mesa task 1527): the session was a todo-watcher dispatch past
    /// the context ceiling with a checkpoint written, so mesa stopped it and
    /// started a fresh session on the same task. `new_job` is `None` when the
    /// spawn printed no receipt.
    Relayed {
        old_job: String,
        new_job: Option<String>,
        artifact_id: i64,
    },
    /// The relay's stop worked but the fresh session did not start; the task
    /// stays `in_progress` and the todo-watcher's reaper reports it.
    RelaySpawnFailed {
        old_job: String,
        artifact_id: i64,
        reason: String,
    },
}

/// Everything [`relay_decision`] needs, gathered by the caller (a job lookup, a
/// store read) so the decision itself reads nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayFacts {
    pub action: GuardAction,
    /// The session's *current* breaches include `context` (not merely a fresh
    /// one: the checkpoint is often written after the first breach tick).
    pub context_breached: bool,
    /// The task the todo-watcher dispatched this session's job for, if any.
    pub dispatched_task: Option<i64>,
    pub task_in_progress: bool,
    /// Id and `updated_at` of the task's `checkpoint-task-<id>` artifact, if
    /// one exists.
    pub checkpoint: Option<(i64, String)>,
    /// The `updated_at` of the checkpoint the last relay of this task seeded
    /// its successor with. A checkpoint still carrying it is the predecessor's
    /// and must not be relayed again: only one rewritten since counts.
    pub seeded: Option<String>,
    /// The task's project has a folder to start a session in.
    pub has_local_path: bool,
    /// Already relayed or stopped by this process.
    pub already_handled: bool,
}

/// The name of the artifact a supervisor session writes at the context ceiling
/// (`core::supervisor`, "Context ceiling checkpoint").
pub fn checkpoint_name(task_id: i64) -> String {
    format!("checkpoint-task-{task_id}")
}

/// The id and `updated_at` of `task_id`'s checkpoint among a project's
/// `artifacts`: the artifact named [`checkpoint_name`] (case-insensitively, as
/// names are unique) and attached to that task.
pub fn find_checkpoint(artifacts: &[Artifact], task_id: i64) -> Option<(i64, String)> {
    let name = checkpoint_name(task_id);
    artifacts
        .iter()
        .find(|a| a.task_id == Some(task_id) && a.name.eq_ignore_ascii_case(&name))
        .map(|a| (a.id, a.updated_at.clone()))
}

/// Whether a context-ceiling breach is answered by a relay rather than an
/// alert-only report: `Some((task id, checkpoint artifact id))` iff the action
/// is `stop`, the session is a todo-watcher dispatch for an `in_progress` task
/// that has a checkpoint **rewritten since the last relay seeded one** (a
/// successor starts with its predecessor's checkpoint still on the task, and
/// relaying that again would discard everything the successor did) and a
/// folder, and it has not been relayed or stopped already. Pure — every input is an argument.
pub fn relay_decision(f: &RelayFacts) -> Option<(i64, i64)> {
    if f.action != GuardAction::Stop
        || !f.context_breached
        || !f.task_in_progress
        || !f.has_local_path
        || f.already_handled
    {
        return None;
    }
    let (artifact_id, updated_at) = f.checkpoint.as_ref()?;
    if f.seeded.as_deref() == Some(updated_at.as_str()) {
        return None;
    }
    Some((f.dispatched_task?, *artifact_id))
}

/// The resolved numbers one tick guards against, read fresh from
/// `~/.mesa/config.json` each time (`core::config::guard_thresholds`). A plain
/// value struct rather than a handle to the config, so [`breaches`] can be
/// exercised against numbers no config file would ever hold.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GuardThresholds {
    /// Estimated dollars in the guard window at or above which `cost` fires.
    pub cost_usd: f64,
    /// Tokens in the guard window at or above which `tokens` fires.
    pub total_tokens: i64,
    /// Share of tokens that must be cache reads for `spin` to fire.
    pub cache_read_share: f64,
    /// Tokens a session must have *before* `spin` is allowed to fire at all.
    pub cache_read_min_tokens: i64,
    /// Identical trivial `Bash` calls in a row at or above which `repeat`
    /// fires.
    #[serde(rename = "repeat_count")]
    pub repeat_count: u64,
    /// Input-side tokens of a session's newest main-thread turn at or above
    /// which `context` fires.
    #[serde(rename = "context_tokens")]
    pub context_tokens: u64,
    /// What the watcher does about any of the above.
    pub action: GuardAction,
}

/// One rule a session has tripped: which rule, what mesa measured, and the
/// number it was measured against. Both figures are `f64` so a breach is one
/// shape whether the rule counts dollars, tokens or a ratio; a token count
/// well past 2^53 is not a number this feature can reach.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GuardBreach {
    /// [`COST`], [`TOKENS`] or [`SPIN`] — the fire-once key, paired with the
    /// session id, that stops one runaway filing the same alert every minute.
    pub threshold: &'static str,
    /// What this session actually shows.
    pub observed: f64,
    /// The threshold it reached.
    pub limit: f64,
}

/// Whether any of `fresh` calls for a stop: anything but `context`, which is
/// alert-only by design — a long conversation is not a runaway, and stopping
/// one for its size alone would interrupt good work.
pub fn wants_stop(fresh: &[GuardBreach]) -> bool {
    fresh.iter().any(|b| b.threshold != CONTEXT)
}

/// Every rule `session` currently trips, in a fixed order (cost, tokens,
/// spin, repeat, context).
///
/// A session can trip several at once and each is reported separately: they
/// are different findings, not three spellings of one. "$40 spent" tells a
/// person to look; "$40 spent, 99.8% of it re-reading the same context" tells
/// them what they will find.
///
/// Every comparison is `>=`, so a threshold set to exactly what a session
/// shows fires — a limit is a limit, not a number to exceed.
pub fn breaches(session: &CcLiveSession, t: &GuardThresholds) -> Vec<GuardBreach> {
    let mut out = Vec::new();
    if session.est_cost_usd >= t.cost_usd {
        out.push(GuardBreach {
            threshold: COST,
            observed: session.est_cost_usd,
            limit: t.cost_usd,
        });
    }
    if session.total_tokens >= t.total_tokens {
        out.push(GuardBreach {
            threshold: TOKENS,
            observed: session.total_tokens as f64,
            limit: t.total_tokens as f64,
        });
    }
    // The floor is checked first and does double duty: it keeps a three-message
    // session that is trivially 100% cache-read from being called a runaway,
    // and — because it is at least 1 by construction — it is also what makes
    // the division below safe. A session with no tokens can never reach it.
    // Judged on the session's own main-thread transcript: a subagent's cache
    // reads are its own, and a healthy supervisor must not inherit them.
    let main = &session.main_tokens;
    let main_total = main.input + main.output + main.cache_read + main.cache_creation;
    if main_total >= t.cache_read_min_tokens && main_total > 0 {
        let share = main.cache_read as f64 / main_total as f64;
        if share >= t.cache_read_share {
            out.push(GuardBreach {
                threshold: SPIN,
                observed: share,
                limit: t.cache_read_share,
            });
        }
    }
    // The one rule that reads a *shape* off the transcript rather than a
    // number off the meter — and therefore the only one that can fire before
    // any real money is spent.
    if let Some(repeat) = &session.repeat
        && repeat.count >= t.repeat_count
    {
        out.push(GuardBreach {
            threshold: REPEAT,
            observed: repeat.count as f64,
            limit: t.repeat_count as f64,
        });
    }
    if let Some(context) = session.context_tokens
        && context >= t.context_tokens
    {
        out.push(GuardBreach {
            threshold: CONTEXT,
            observed: context as f64,
            limit: t.context_tokens as f64,
        });
    }
    out
}

/// The share of `session`'s main-thread tokens that are cache reads — the
/// measure `spin` judges, for reporting. `0.0` for a session with no tokens —
/// there is no ratio to state, and a report is not the place to invent one.
pub fn cache_read_share(session: &CcLiveSession) -> f64 {
    let m = &session.main_tokens;
    let total = m.input + m.output + m.cache_read + m.cache_creation;
    if total <= 0 {
        return 0.0;
    }
    m.cache_read as f64 / total as f64
}

/// The alert an inbox item carries: **prose**, not a table.
///
/// The inbox's play button may read this aloud through `kokoro-rs`
/// (`docs/inbox.md`), so it has to survive being spoken — which rules out
/// markdown tables, bullet grids and bare numbers with no unit. The session
/// id, cwd and project name are **data** and are stated as data; nothing here
/// is ever handed to a shell.
///
/// `minutes` is how long the session has been running (first to last in-window
/// event), `None` when the timestamps could not be read — then the sentence
/// simply omits the duration rather than guessing at one.
pub fn alert_body(
    session: &CcLiveSession,
    breaches: &[GuardBreach],
    window_minutes: i64,
    minutes: Option<i64>,
    outcome: &StopOutcome,
) -> String {
    let short: String = session.session_id.chars().take(8).collect();
    let where_ = match (&session.project, &session.cwd) {
        (Some(project), Some(cwd)) => format!(" in project {project} ({cwd})"),
        (Some(project), None) => format!(" in project {project}"),
        (None, Some(cwd)) => format!(" in {cwd}"),
        (None, None) => String::new(),
    };
    let running = match minutes {
        Some(m) if m >= 1 => format!(" It has been running for about {}.", humanize(m)),
        _ => String::new(),
    };

    let mut body = format!(
        "Cost guard: Claude Code session {short} (full id {full}){where_} has crossed a \
         threshold.{running} Over the last {window_minutes} minutes it used {tokens} tokens \
         at an estimated cost of ${cost:.2}, of which {share:.1} percent were cache reads. \
         It last produced {output} output tokens across {messages} assistant messages and is \
         currently {status}.\n\n",
        full = session.session_id,
        tokens = session.total_tokens,
        cost = session.est_cost_usd,
        share = cache_read_share(session) * 100.0,
        output = session.tokens.output,
        messages = session.messages,
        status = session.status,
    );
    for b in breaches {
        body.push_str(&explain(b, session));
        body.push('\n');
    }
    body.push('\n');
    body.push_str(&outcome_sentence(outcome));
    body.push_str(" Run `mesa cc guard` to see every live session currently over a threshold.\n");
    body
}

/// What mesa did about it, as one spoken sentence. Every branch says plainly
/// whether the session is still running, because that is the only thing a
/// person woken by this alert actually needs to decide about.
fn outcome_sentence(outcome: &StopOutcome) -> String {
    match outcome {
        StopOutcome::Stopped { job_id } => format!(
            "mesa has stopped this session by running claude stop {job_id}. The conversation is \
             not lost: run claude attach {job_id} to look at it or carry it on."
        ),
        StopOutcome::AlreadyStopped => {
            "mesa already stopped this session on an earlier check, so it is not running now."
                .to_string()
        }
        StopOutcome::StopFailed { reason } => format!(
            "mesa tried to stop this session and could not: {reason}. It is still running, so it \
             is the one to interrupt."
        ),
        StopOutcome::NotBackground => "mesa could not find a background session to stop, so it \
             is still running. Only a session mesa started in the background can be stopped this \
             way; this one has to be interrupted wherever it is running."
            .to_string(),
        StopOutcome::Reported => "mesa is configured to report rather than stop, so this session \
             is still running. If it is working as intended, no action is needed; otherwise it is \
             the one to interrupt."
            .to_string(),
        StopOutcome::Relayed {
            old_job,
            new_job,
            artifact_id,
        } => {
            let fresh = match new_job {
                Some(job) => format!("a fresh session on the same task, job {job}"),
                None => "a fresh session on the same task".to_string(),
            };
            format!(
                "mesa relayed this session: it stopped it by running claude stop {old_job} and \
                 started {fresh}, which reads the checkpoint artifact {artifact_id} and carries \
                 on. The old conversation is not lost: run claude attach {old_job} to look at it."
            )
        }
        StopOutcome::RelaySpawnFailed {
            old_job,
            artifact_id,
            reason,
        } => format!(
            "mesa stopped this session by running claude stop {old_job} to relay it, but the \
             fresh session did not start: {reason}. The task is still in progress with nothing \
             running on it; its checkpoint is artifact {artifact_id}, and the todo watcher will \
             report it as abandoned."
        ),
        StopOutcome::ContextOnly => "mesa left this session running: the context rule only \
             reports, it never stops a session. If it is working as intended, no action is \
             needed; otherwise it is the one to wrap up."
            .to_string(),
    }
}

/// One breach as a sentence, saying what the rule means rather than restating
/// its name — an inbox item is read by a person who did not write the config.
fn explain(b: &GuardBreach, session: &CcLiveSession) -> String {
    match b.threshold {
        COST => format!(
            "Cost: estimated spend of ${:.2} reached the ${:.2} guard threshold.",
            b.observed, b.limit
        ),
        TOKENS => format!(
            "Volume: {} tokens reached the {} token guard threshold.",
            b.observed as i64, b.limit as i64
        ),
        SPIN => format!(
            "Spin loop: {:.1} percent of this session's tokens are cache reads, at or above the \
             {:.1} percent threshold. That pattern is an agent re-reading the same context \
             instead of making progress.",
            b.observed * 100.0,
            b.limit * 100.0
        ),
        REPEAT => {
            let command = session
                .repeat
                .as_ref()
                .map(|r| r.command.as_str())
                .unwrap_or("the same command");
            format!(
                "Repeat: this session has run the command {command} {} times in a row, at or \
                 above the {} the guard allows, and each run produced almost no output. That is \
                 an agent stuck in a loop rather than working.",
                b.observed as i64, b.limit as i64
            )
        }
        CONTEXT => format!(
            "Context: its latest turn re-read {} tokens of context, past the {} ceiling; a fresh \
             session seeded with a checkpoint would be cheaper.",
            group(b.observed as u64),
            group(b.limit as u64)
        ),
        other => format!("{other}: {} reached {}.", b.observed, b.limit),
    }
}

/// A count with thousands separators — "584,000".
fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A whole number of minutes as English — "45 minutes", "1 hour 5 minutes",
/// "6 hours". Spoken aloud, so no `6h14m`.
fn humanize(minutes: i64) -> String {
    let hours = minutes / 60;
    let rest = minutes % 60;
    let plural = |n: i64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    match (hours, rest) {
        (0, m) => plural(m, "minute"),
        (h, 0) => plural(h, "hour"),
        (h, m) => format!("{} {}", plural(h, "hour"), plural(m, "minute")),
    }
}

/// One live session as `mesa cc guard` reports it: the identity, the numbers
/// the rules read, the rules it tripped, and the task the alert would be filed
/// against — `null` when the ladder in [`resolve_task`] dead-ends, which is
/// the whole reason this command exists.
#[derive(Debug, Clone, Serialize)]
pub struct GuardSessionReport {
    pub session_id: String,
    pub project: Option<String>,
    pub cwd: Option<String>,
    /// `active` or `idle`, straight from [`crate::core::cc::live`].
    pub status: String,
    pub started: String,
    pub last_activity: String,
    /// Wall-clock minutes from this session's first **in-window** event to its
    /// last, so it never exceeds the window; `null` if the timestamps could
    /// not be parsed.
    pub running_minutes: Option<i64>,
    pub messages: i64,
    pub total_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub est_cost_usd: f64,
    pub cache_read_share: f64,
    /// The trailing run of identical trivial `Bash` calls, or `null`.
    pub repeat: Option<crate::core::types::CcRepeat>,
    /// The newest main-thread turn's input-side tokens, or `null`.
    pub context_tokens: Option<u64>,
    pub breaches: Vec<GuardBreach>,
    /// The task an alert about this session would name, resolved through
    /// [`resolve_task`]; `null` when nothing in mesa claims it.
    pub task_id: Option<i64>,
}

/// The `mesa cc guard` payload: what was in force, and every live session
/// currently over one of those lines.
#[derive(Debug, Clone, Serialize)]
pub struct GuardReport {
    pub generated_at_unix: i64,
    pub window_minutes: i64,
    pub thresholds: GuardThresholds,
    /// Only the breaching sessions — a quiet machine reports an empty array.
    pub sessions: Vec<GuardSessionReport>,
}

/// Minutes from a session's first in-window event to its last, `None` when
/// either timestamp is unparseable. Not "since it started": [`crate::core::cc::live`]
/// only sees events inside the window, so a session older than the window
/// reports the window, not its true age.
pub fn running_minutes(session: &CcLiveSession) -> Option<i64> {
    let start = crate::core::cc::parse_ts(&session.started)?;
    let end = crate::core::cc::parse_ts(&session.last_activity)?;
    Some(((end - start).max(0)) / 60)
}

/// Which mesa task a runaway session belongs to — a **resolution**, never a
/// fabrication.
///
/// `Store::create_inbox_item` requires a real task id, because the inbox's
/// rule is that every item names the task it came from (`docs/inbox.md`, task
/// 847). The guard does not get to loosen that: an alert nobody can trace back
/// to work is worth less than the invariant it would cost. So it asks two
/// questions and accepts "no" as an answer:
///
/// 1. **Did a claim name this session?** A task whose `owner` is the session
///    id — the same link `docs/receipts.md` uses. This is exact: the agent
///    itself said so.
/// 2. **Whose folder is it working in?** The session's `cwd` matched by
///    **exact** equality against a project's `local_path` or any of its
///    `previous_paths` (the rule `cc::collect_for_project` already uses — no
///    prefix or subdirectory matching, because a worktree is not its parent
///    repo; a current `local_path` outranks another project's previous one,
///    since the folder has moved on to its new owner), then that
///    project's `in_progress` tasks, oldest claim first and otherwise the most
///    recently updated. A guess, but a narrow one, and the alert says which
///    session it is about so a wrong task is a wrong *filing cabinet*, not a
///    wrong story.
///
/// `Ok(None)` is the third answer and a normal one — `mesa cc guard` is where
/// such a session stays visible.
pub fn resolve_task(store: &Store, session: &CcLiveSession) -> Result<Option<i64>> {
    if let Some(task) = store.find_task_by_owner(&session.session_id)? {
        return Ok(Some(task.id));
    }
    let Some(cwd) = session.cwd.as_deref() else {
        return Ok(None);
    };
    // `list_projects_all`, not `list_projects`: an archived project's runaway
    // agent is still spending money.
    let projects = store.list_projects_all()?;
    let Some(project) = projects
        .iter()
        .find(|p| p.local_path.as_deref() == Some(cwd))
        .or_else(|| {
            projects
                .iter()
                .find(|p| p.previous_paths.iter().any(|path| path == cwd))
        })
    else {
        return Ok(None);
    };
    let mut candidates: Vec<Task> = store
        .list_tasks(Some(project.id))?
        .into_iter()
        .filter(|t| t.status == Status::InProgress)
        .collect();
    // Oldest claim first — the task that has been open longest is the one a
    // long-running session is most likely still on. An unclaimed in-progress
    // task sorts last (`None` after every `Some`), where the most recently
    // updated one wins.
    candidates.sort_by(|a, b| {
        (a.claimed_at.is_none(), &a.claimed_at)
            .cmp(&(b.claimed_at.is_none(), &b.claimed_at))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    Ok(candidates.first().map(|t| t.id))
}

/// Every live session currently over a threshold, with its task resolved —
/// the shared body of `mesa cc guard` and, minus the report shell, of the
/// watcher's own tick.
pub fn report(store: &Store, live: &CcLive, thresholds: &GuardThresholds) -> Result<GuardReport> {
    let mut sessions = Vec::new();
    for session in &live.sessions {
        let breaches = breaches(session, thresholds);
        if breaches.is_empty() {
            continue;
        }
        sessions.push(GuardSessionReport {
            session_id: session.session_id.clone(),
            project: session.project.clone(),
            cwd: session.cwd.clone(),
            status: session.status.clone(),
            started: session.started.clone(),
            last_activity: session.last_activity.clone(),
            running_minutes: running_minutes(session),
            messages: session.messages,
            total_tokens: session.total_tokens,
            cache_read_tokens: session.tokens.cache_read,
            output_tokens: session.tokens.output,
            est_cost_usd: session.est_cost_usd,
            cache_read_share: cache_read_share(session),
            repeat: session.repeat.clone(),
            context_tokens: session.context_tokens,
            breaches,
            task_id: resolve_task(store, session)?,
        });
    }
    Ok(GuardReport {
        generated_at_unix: live.generated_at_unix,
        window_minutes: live.window_minutes,
        thresholds: *thresholds,
        sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::{CcRepeat, CcTokens};

    fn thresholds() -> GuardThresholds {
        GuardThresholds {
            cost_usd: 25.0,
            total_tokens: 100_000_000,
            cache_read_share: 0.98,
            cache_read_min_tokens: 20_000_000,
            repeat_count: 30,
            context_tokens: 120_000,
            action: GuardAction::Stop,
        }
    }

    fn session(cost: f64, input: i64, output: i64, cache_read: i64) -> CcLiveSession {
        let tokens = CcTokens {
            input,
            output,
            cache_read,
            cache_creation: 0,
        };
        let total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation;
        CcLiveSession {
            session_id: "c2b83256-0000-0000-0000-000000000000".into(),
            project: Some("mesa".into()),
            cwd: Some("/home/me/mesa".into()),
            git_branch: None,
            models: vec![],
            started: "2026-09-01T01:00:00Z".into(),
            last_activity: "2026-09-01T07:00:00Z".into(),
            idle_seconds: 3,
            status: "active".into(),
            messages: 400,
            main_tokens: tokens.clone(),
            tokens,
            total_tokens: total,
            est_cost_usd: cost,
            used_subagent: false,
            subagents: vec![],
            spark: vec![],
            repeat: None,
            context_tokens: None,
        }
    }

    fn kinds(s: &CcLiveSession) -> Vec<&'static str> {
        breaches(s, &thresholds())
            .into_iter()
            .map(|b| b.threshold)
            .collect()
    }

    #[test]
    fn the_resolution_ladder_prefers_a_claim_then_the_cwd_then_gives_up() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("test.db")).unwrap();
        let repo = "/home/me/guarded";
        let project = store
            .create_project("guarded", None, None, Some(repo), None)
            .unwrap()
            .id;
        let older = store
            .create_task(
                project,
                "older work",
                crate::core::types::Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
            .id;
        let newer = store
            .create_task(
                project,
                "newer work",
                crate::core::types::Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
            .id;

        let mut s = session(50.0, 10, 10, 10);
        s.cwd = Some(repo.to_string());

        // Rung 3 first: nothing claimed, nothing in progress — a dead end, and
        // not an error.
        assert_eq!(resolve_task(&store, &s).unwrap(), None);

        // Rung 2: the cwd matches this project. A claimed in-progress task
        // outranks an unclaimed one — a claim dates the work, an ordinary
        // status flip does not.
        store
            .update_task(
                older,
                &crate::core::store::TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        store.claim_task(newer, "someone-else", false).unwrap();
        assert_eq!(resolve_task(&store, &s).unwrap(), Some(newer));

        // Rung 1 outranks it: a task claimed by this very session id.
        store.claim_task(older, &s.session_id, false).unwrap();
        assert_eq!(resolve_task(&store, &s).unwrap(), Some(older));

        // A cwd no project names is a dead end even with claims about.
        s.cwd = Some("/somewhere/else".to_string());
        s.session_id = "unknown-session".to_string();
        assert_eq!(resolve_task(&store, &s).unwrap(), None);
        // Matching is exact: a subdirectory of the project folder is not it.
        s.cwd = Some(format!("{repo}/frontend"));
        assert_eq!(resolve_task(&store, &s).unwrap(), None);
    }

    #[test]
    fn a_cwd_matching_a_previous_path_resolves_exactly_and_below_the_current_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("test.db")).unwrap();
        let moved = store
            .create_project("moved", None, None, Some("/home/me/new"), None)
            .unwrap()
            .id;
        store.add_project_path(moved, "/home/me/old").unwrap();
        let task = store
            .create_task(
                moved,
                "moved work",
                crate::core::types::Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
            .id;
        store.claim_task(task, "someone-else", false).unwrap();

        let mut s = session(50.0, 10, 10, 10);
        s.session_id = "unknown-session".to_string();

        // A session still running in the folder the project moved away from.
        s.cwd = Some("/home/me/old".to_string());
        assert_eq!(resolve_task(&store, &s).unwrap(), Some(task));
        // Exact, as for `local_path`: a subdirectory of a previous path is not it.
        s.cwd = Some("/home/me/old/frontend".to_string());
        assert_eq!(resolve_task(&store, &s).unwrap(), None);

        // A folder that is one project's `local_path` and another's previous
        // path belongs to its current owner.
        let current = store
            .create_project("current", None, None, Some("/home/me/old"), None)
            .unwrap()
            .id;
        let current_task = store
            .create_task(
                current,
                "current work",
                crate::core::types::Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
            .id;
        store
            .claim_task(current_task, "someone-else", false)
            .unwrap();
        s.cwd = Some("/home/me/old".to_string());
        assert_eq!(resolve_task(&store, &s).unwrap(), Some(current_task));
    }

    #[test]
    fn a_quiet_session_breaches_nothing() {
        assert!(kinds(&session(1.5, 1_000, 500, 10_000)).is_empty());
    }

    #[test]
    fn cost_fires_at_the_threshold_not_past_it() {
        assert_eq!(kinds(&session(25.0, 1_000, 500, 1_000)), vec![COST]);
        assert!(kinds(&session(24.99, 1_000, 500, 1_000)).is_empty());
    }

    #[test]
    fn volume_fires_on_tokens_alone() {
        // Cheap model, enormous volume: no cost breach, but the tokens rule
        // catches it. Cache read share is low, so `spin` stays quiet.
        let s = session(2.0, 60_000_000, 40_000_000, 0);
        assert_eq!(kinds(&s), vec![TOKENS]);
    }

    #[test]
    fn a_zero_token_session_never_divides_by_zero() {
        let s = session(0.0, 0, 0, 0);
        assert!(kinds(&s).is_empty());
        assert_eq!(cache_read_share(&s), 0.0);
    }

    #[test]
    fn a_small_all_cache_read_session_is_under_the_spin_floor() {
        // 100% cache reads, but only 5M tokens — an ordinary session reading
        // its own context, which is exactly what the floor exists to spare.
        let s = session(1.0, 0, 0, 5_000_000);
        assert_eq!(cache_read_share(&s), 1.0);
        assert!(kinds(&s).is_empty());
    }

    #[test]
    fn the_motivating_incident_trips_all_three() {
        // 99.8% cache reads, 2.76B tokens, $1413.72 — session c2b83256.
        let s = session(1_413.72, 5_000_000, 520_000, 2_754_480_000);
        assert_eq!(kinds(&s), vec![COST, TOKENS, SPIN]);
        let spin = breaches(&s, &thresholds())
            .into_iter()
            .find(|b| b.threshold == SPIN)
            .unwrap();
        assert!(spin.observed >= 0.998, "{spin:?}");
    }

    #[test]
    fn spin_fires_alone_when_volume_is_over_the_floor_but_under_the_ceiling() {
        // 30M tokens: over the 20M spin floor, well under the 100M volume
        // ceiling, and cheap enough not to trip cost.
        let s = session(3.0, 40_000, 20_000, 29_940_000);
        assert_eq!(kinds(&s), vec![SPIN]);
    }

    #[test]
    fn a_subagents_cache_reads_do_not_trip_its_parents_spin() {
        // The supervisor's own thread is small; its implementer subagent read
        // 30M tokens of cache at 99%. Whole-session share is over the line,
        // the main thread's is not.
        let mut s = session(3.0, 40_000, 20_000, 29_940_000);
        s.main_tokens = CcTokens {
            input: 200_000,
            output: 20_000,
            cache_read: 400_000,
            cache_creation: 0,
        };
        assert!(kinds(&s).is_empty(), "{:?}", kinds(&s));
        // A true loop in the main thread still trips it, subagent or not.
        s.main_tokens.cache_read = 29_940_000;
        assert_eq!(kinds(&s), vec![SPIN]);
    }

    #[test]
    fn the_alert_body_is_speakable_prose_naming_the_session() {
        let s = session(1_413.72, 5_000_000, 520_000, 2_754_480_000);
        let body = alert_body(
            &s,
            &breaches(&s, &thresholds()),
            60,
            Some(475),
            &StopOutcome::Reported,
        );
        assert!(body.contains("c2b83256"), "{body}");
        assert!(body.contains(&s.session_id), "{body}");
        assert!(body.contains("project mesa"), "{body}");
        assert!(body.contains("7 hours 55 minutes"), "{body}");
        assert!(body.contains("Spin loop"), "{body}");
        assert!(!body.contains('|'), "no markdown tables: {body}");
    }

    #[test]
    fn an_unknown_duration_is_simply_omitted() {
        let s = session(30.0, 1_000, 500, 1_000);
        let body = alert_body(
            &s,
            &breaches(&s, &thresholds()),
            60,
            None,
            &StopOutcome::Reported,
        );
        assert!(!body.contains("running for"), "{body}");
    }

    fn looping(count: u64, command: &str) -> CcLiveSession {
        let mut s = session(0.10, 5_000, 400, 1_000);
        s.repeat = Some(CcRepeat {
            command: command.to_string(),
            count,
        });
        s
    }

    #[test]
    fn repeat_fires_at_the_count_and_costs_nothing_to_reach() {
        // The whole point of this rule: a session far under every money
        // threshold is still a runaway if it is looping.
        assert_eq!(kinds(&looping(30, "echo idle")), vec![REPEAT]);
        assert_eq!(kinds(&looping(4_600, "echo idle")), vec![REPEAT]);
        assert!(kinds(&looping(29, "echo idle")).is_empty());
        assert!(kinds(&session(0.10, 5_000, 400, 1_000)).is_empty());
    }

    #[test]
    fn a_repeat_breach_names_the_command_and_the_count() {
        let s = looping(4_600, "echo idle");
        let body = alert_body(
            &s,
            &breaches(&s, &thresholds()),
            60,
            Some(480),
            &StopOutcome::Stopped {
                job_id: "89dc6ccd".into(),
            },
        );
        assert!(body.contains("echo idle"), "{body}");
        assert!(body.contains("4600 times in a row"), "{body}");
        assert!(!body.contains('|'), "no markdown tables: {body}");
    }

    #[test]
    fn the_closing_sentence_says_what_happened_to_the_session() {
        let s = looping(50, "echo ok");
        let breaches = breaches(&s, &thresholds());
        let body = |outcome: StopOutcome| alert_body(&s, &breaches, 60, None, &outcome);

        let stopped = body(StopOutcome::Stopped {
            job_id: "89dc6ccd".into(),
        });
        assert!(stopped.contains("claude stop 89dc6ccd"), "{stopped}");
        assert!(stopped.contains("claude attach 89dc6ccd"), "{stopped}");

        let already = body(StopOutcome::AlreadyStopped);
        assert!(already.contains("already stopped"), "{already}");

        let failed = body(StopOutcome::StopFailed {
            reason: "claude stop 89dc6ccd failed: no such session".into(),
        });
        assert!(failed.contains("could not: claude stop"), "{failed}");
        assert!(failed.contains("still running"), "{failed}");

        let not_bg = body(StopOutcome::NotBackground);
        assert!(
            not_bg.contains("could not find a background session"),
            "{not_bg}"
        );

        let reported = body(StopOutcome::Reported);
        assert!(reported.contains("report rather than stop"), "{reported}");

        // Every outcome still points at the read-only inspector.
        for text in [stopped, failed, not_bg, reported] {
            assert!(text.contains("mesa cc guard"), "{text}");
        }
    }

    fn with_context(tokens: u64) -> CcLiveSession {
        let mut s = session(0.10, 5_000, 400, 1_000);
        s.context_tokens = Some(tokens);
        s
    }

    #[test]
    fn context_fires_at_the_ceiling_and_not_below_it() {
        assert_eq!(kinds(&with_context(120_000)), vec![CONTEXT]);
        assert_eq!(kinds(&with_context(584_000)), vec![CONTEXT]);
        assert!(kinds(&with_context(119_999)).is_empty());
        // No main-thread usage seen: never a breach.
        assert!(kinds(&session(0.10, 5_000, 400, 1_000)).is_empty());
    }

    #[test]
    fn a_context_only_breach_never_wants_a_stop() {
        let only = breaches(&with_context(584_000), &thresholds());
        assert!(!wants_stop(&only));
        // Any other rule alongside it does.
        let mut both = with_context(584_000);
        both.est_cost_usd = 30.0;
        assert!(wants_stop(&breaches(&both, &thresholds())));
        assert!(!wants_stop(&[]));
    }

    #[test]
    fn a_context_breach_is_prose_and_says_it_was_left_running() {
        let s = with_context(584_000);
        let body = alert_body(
            &s,
            &breaches(&s, &thresholds()),
            60,
            None,
            &StopOutcome::ContextOnly,
        );
        assert!(
            body.contains("Context: its latest turn re-read 584,000 tokens"),
            "{body}"
        );
        assert!(body.contains("120,000 ceiling"), "{body}");
        assert!(body.contains("left this session running"), "{body}");
        assert!(!body.contains('|'), "no markdown tables: {body}");
        assert_eq!(group(999), "999");
        assert_eq!(group(1_000), "1,000");
        assert_eq!(group(1_234_567), "1,234,567");
    }

    fn facts() -> RelayFacts {
        RelayFacts {
            action: GuardAction::Stop,
            context_breached: true,
            dispatched_task: Some(7),
            task_in_progress: true,
            checkpoint: Some((42, "2026-01-01 10:00:00".to_string())),
            seeded: None,
            has_local_path: true,
            already_handled: false,
        }
    }

    #[test]
    fn a_relay_needs_every_condition() {
        assert_eq!(relay_decision(&facts()), Some((7, 42)));
        let none = |f: RelayFacts| assert_eq!(relay_decision(&f), None, "{f:?}");
        none(RelayFacts {
            action: GuardAction::Report,
            ..facts()
        });
        none(RelayFacts {
            context_breached: false,
            ..facts()
        });
        none(RelayFacts {
            dispatched_task: None,
            ..facts()
        });
        none(RelayFacts {
            task_in_progress: false,
            ..facts()
        });
        none(RelayFacts {
            checkpoint: None,
            ..facts()
        });
        none(RelayFacts {
            has_local_path: false,
            ..facts()
        });
        none(RelayFacts {
            already_handled: true,
            ..facts()
        });
    }

    #[test]
    fn a_checkpoint_the_last_relay_seeded_is_not_relayed_again() {
        let same = RelayFacts {
            seeded: Some("2026-01-01 10:00:00".to_string()),
            ..facts()
        };
        assert_eq!(relay_decision(&same), None);
        let rewritten = RelayFacts {
            seeded: Some("2026-01-01 09:00:00".to_string()),
            ..facts()
        };
        assert_eq!(relay_decision(&rewritten), Some((7, 42)));
    }

    fn artifact(id: i64, task_id: Option<i64>, name: &str) -> Artifact {
        Artifact {
            id,
            project_id: 1,
            task_id,
            name: name.to_string(),
            content_type: "text/markdown".to_string(),
            body: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn a_checkpoint_is_named_for_and_attached_to_its_task() {
        let all = [
            artifact(1, Some(7), "notes"),
            artifact(2, None, "checkpoint-task-7"),
            artifact(3, Some(8), "checkpoint-task-8"),
            artifact(4, Some(7), "Checkpoint-Task-7"),
        ];
        assert_eq!(find_checkpoint(&all, 7).map(|c| c.0), Some(4));
        assert_eq!(find_checkpoint(&all, 8).map(|c| c.0), Some(3));
        assert_eq!(find_checkpoint(&all, 9), None);
        assert_eq!(checkpoint_name(7), "checkpoint-task-7");
    }

    #[test]
    fn a_relay_alert_names_the_checkpoint_and_the_new_job() {
        let relayed = outcome_sentence(&StopOutcome::Relayed {
            old_job: "job-old".into(),
            new_job: Some("job-new".into()),
            artifact_id: 42,
        });
        assert!(relayed.contains("claude stop job-old"), "{relayed}");
        assert!(relayed.contains("job-new"), "{relayed}");
        assert!(relayed.contains("artifact 42"), "{relayed}");
        assert!(relayed.contains("claude attach job-old"), "{relayed}");
        let failed = outcome_sentence(&StopOutcome::RelaySpawnFailed {
            old_job: "job-old".into(),
            artifact_id: 42,
            reason: "boom".into(),
        });
        assert!(failed.contains("did not start: boom"), "{failed}");
        assert!(failed.contains("artifact 42"), "{failed}");
    }

    #[test]
    fn an_action_is_two_words_and_nothing_else() {
        assert_eq!(GuardAction::parse("stop"), Some(GuardAction::Stop));
        assert_eq!(GuardAction::parse("report"), Some(GuardAction::Report));
        assert_eq!(GuardAction::parse("pause"), None);
        assert_eq!(GuardAction::parse("Stop"), None);
        assert_eq!(GuardAction::parse(""), None);
        assert_eq!(GuardAction::Stop.as_str(), "stop");
        assert_eq!(GuardAction::Report.as_str(), "report");
    }

    #[test]
    fn durations_read_as_english() {
        assert_eq!(humanize(1), "1 minute");
        assert_eq!(humanize(45), "45 minutes");
        assert_eq!(humanize(60), "1 hour");
        assert_eq!(humanize(65), "1 hour 5 minutes");
        assert_eq!(humanize(360), "6 hours");
    }
}
