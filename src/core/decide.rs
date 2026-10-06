//! `naru decide` (mesa task 1653): a small, fast, local "pick one of these
//! options" call — a System One — that hooks and workflows shell out to.
//!
//! No network, no model, no key. The decision comes from a [`DecideBackend`];
//! two exist today, [`Rules`] (an ordered list of keyword rules in a plain
//! JSON file, first match wins) and [`Off`] (never decides). The trait is the
//! seam a local-model backend would plug into later. "No decision" is a normal
//! answer (`choice: null`), never an error — callers pass it through.
//! See `docs/decide.md`.

use std::path::Path;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::store::{Error, Result};

/// The built-in ruleset, a port of the agent-routing keyword rules.
pub const DEFAULT_RULES: &str = include_str!("decide-rules.json");

/// A rule's confidence when the file names none.
const DEFAULT_CONFIDENCE: f64 = 0.8;

pub struct Request<'a> {
    pub question: &'a str,
    pub input: &'a str,
    pub options: &'a [String],
}

/// The answer. `choice: None` is "no decision": confidence 0, agreement 0.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Decision {
    pub choice: Option<String>,
    pub confidence: f64,
    pub agreement: f64,
    pub backend: &'static str,
    pub rule: Option<String>,
}

impl Decision {
    fn none(backend: &'static str) -> Self {
        Decision {
            choice: None,
            confidence: 0.0,
            agreement: 0.0,
            backend,
            rule: None,
        }
    }
}

pub trait DecideBackend {
    fn decide(&self, req: &Request) -> Result<Decision>;
}

/// The backend that never decides (`decide.backend: "off"`).
pub struct Off;

impl DecideBackend for Off {
    fn decide(&self, _req: &Request) -> Result<Decision> {
        Ok(Decision::none("off"))
    }
}

#[derive(Deserialize)]
struct RulesFile {
    rules: Vec<RuleDef>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleDef {
    id: String,
    choice: String,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    all: Vec<CondDef>,
    #[serde(default)]
    none: Vec<CondDef>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CondDef {
    field: Field,
    pattern: String,
    #[serde(default)]
    max_chars: Option<usize>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Field {
    Question,
    Input,
}

struct Cond {
    field: Field,
    re: Regex,
    max_chars: Option<usize>,
}

struct Rule {
    id: String,
    choice: String,
    confidence: f64,
    all: Vec<Cond>,
    none: Vec<Cond>,
}

/// Lowercase, whitespace runs collapsed to one space, ends trimmed.
pub fn normalise(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

impl Cond {
    fn matches(&self, question: &str, input: &str) -> bool {
        let text = match self.field {
            Field::Question => question,
            Field::Input => input,
        };
        match self.max_chars {
            Some(n) => match text.char_indices().nth(n) {
                Some((end, _)) => self.re.is_match(&text[..end]),
                None => self.re.is_match(text),
            },
            None => self.re.is_match(text),
        }
    }
}

impl Rule {
    fn matches(&self, question: &str, input: &str) -> bool {
        self.all.iter().all(|c| c.matches(question, input))
            && !self.none.iter().any(|c| c.matches(question, input))
    }
}

/// The keyword-rules backend: ordered rules, first match wins.
pub struct Rules {
    rules: Vec<Rule>,
}

impl Rules {
    /// Parse a rules document. `label` names it in errors (a path, or
    /// "built-in rules").
    pub fn from_json(text: &str, label: &str) -> Result<Rules> {
        let file: RulesFile = serde_json::from_str(text)
            .map_err(|e| Error::Validation(format!("invalid decide rules {label}: {e}")))?;
        let compile = |rule: &str, c: CondDef| -> Result<Cond> {
            let re = Regex::new(&c.pattern).map_err(|e| {
                Error::Validation(format!(
                    "invalid decide rules {label}: rule '{rule}': bad regex '{}': {e}",
                    c.pattern
                ))
            })?;
            Ok(Cond {
                field: c.field,
                re,
                max_chars: c.max_chars,
            })
        };
        let mut rules = Vec::new();
        for def in file.rules {
            let confidence = def.confidence.unwrap_or(DEFAULT_CONFIDENCE);
            if !(0.0..=1.0).contains(&confidence) {
                return Err(Error::Validation(format!(
                    "invalid decide rules {label}: rule '{}': confidence {confidence} is outside 0..1",
                    def.id
                )));
            }
            let mut all = Vec::new();
            for c in def.all {
                all.push(compile(&def.id, c)?);
            }
            let mut none = Vec::new();
            for c in def.none {
                none.push(compile(&def.id, c)?);
            }
            rules.push(Rule {
                id: def.id,
                choice: def.choice,
                confidence,
                all,
                none,
            });
        }
        Ok(Rules { rules })
    }

    pub fn builtin() -> Rules {
        Rules::from_json(DEFAULT_RULES, "built-in rules").expect("built-in decide rules are valid")
    }

    /// The rules in `path`; a missing file is the built-in set.
    pub fn load(path: &Path) -> Result<Rules> {
        match std::fs::read_to_string(path) {
            Ok(text) => Rules::from_json(&text, &path.display().to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Rules::builtin()),
            Err(e) => Err(Error::Validation(format!(
                "cannot read decide rules {}: {e}",
                path.display()
            ))),
        }
    }
}

impl DecideBackend for Rules {
    fn decide(&self, req: &Request) -> Result<Decision> {
        let question = normalise(req.question);
        let input = normalise(req.input);
        let mut matched = self
            .rules
            .iter()
            .filter(|r| req.options.contains(&r.choice))
            .filter(|r| r.matches(&question, &input));
        let Some(winner) = matched.next() else {
            return Ok(Decision::none("rules"));
        };
        let total = 1 + matched.clone().count();
        let agreeing = 1 + matched.filter(|r| r.choice == winner.choice).count();
        Ok(Decision {
            choice: Some(winner.choice.clone()),
            confidence: winner.confidence,
            agreement: agreeing as f64 / total as f64,
            backend: "rules",
            rule: Some(winner.id.clone()),
        })
    }
}

/// The backend this machine's `decide` config section names.
pub fn backend_from_config() -> Result<Box<dyn DecideBackend>> {
    backend_from_config_in(&super::config::config_file())
}

fn backend_from_config_in(config: &Path) -> Result<Box<dyn DecideBackend>> {
    let section = super::config::decide_section_in(config).map_err(Error::Validation)?;
    match section.backend.as_deref().map(str::trim) {
        None | Some("") | Some("rules") => {
            let path = section.rules_file.unwrap_or_else(|| {
                config
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join("decide-rules.json")
            });
            Ok(Box::new(Rules::load(&path)?))
        }
        Some("off") => Ok(Box::new(Off)),
        Some(other) => Err(Error::Validation(format!(
            "unknown decide backend '{other}' in {} (expected \"rules\" or \"off\")",
            config.display()
        ))),
    }
}

/// Check a request's shape: a question, at least two distinct options.
pub fn validate(question: &str, options: &[String]) -> Result<()> {
    if question.trim().is_empty() {
        return Err(Error::Validation("question must not be empty".into()));
    }
    if options.iter().any(|o| o.trim().is_empty()) {
        return Err(Error::Validation("an option must not be empty".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for o in options {
        if !seen.insert(o.as_str()) {
            return Err(Error::Validation(format!("duplicate option '{o}'")));
        }
    }
    if options.len() < 2 {
        return Err(Error::Validation(
            "at least two distinct --option values are required".into(),
        ));
    }
    Ok(())
}

/// `naru decide`: validate, pick the backend from config, ask it.
pub fn decide(question: &str, input: &str, options: &[String]) -> Result<Decision> {
    validate(question, options)?;
    backend_from_config()?.decide(&Request {
        question,
        input,
        options,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn rules(json: &str) -> Rules {
        Rules::from_json(json, "test").unwrap()
    }

    fn ask(r: &Rules, q: &str, i: &str, o: &[&str]) -> Decision {
        r.decide(&Request {
            question: q,
            input: i,
            options: &opts(o),
        })
        .unwrap()
    }

    const TWO: &str = r#"{"rules":[
        {"id":"a","choice":"x","all":[{"field":"input","pattern":"foo"}]},
        {"id":"b","choice":"x","confidence":0.6,"all":[{"field":"input","pattern":"foo bar"}]},
        {"id":"c","choice":"y","all":[{"field":"input","pattern":"bar"}]}
    ]}"#;

    #[test]
    fn first_match_wins_and_agreement_counts_matching_rules() {
        let r = rules(TWO);
        let d = ask(&r, "q", "Foo   BAR", &["x", "y"]);
        assert_eq!(d.choice.as_deref(), Some("x"));
        assert_eq!(d.rule.as_deref(), Some("a"));
        assert_eq!(d.confidence, 0.8);
        assert!((d.agreement - 2.0 / 3.0).abs() < 1e-9);
        let d = ask(&r, "q", "only bar", &["x", "y"]);
        assert_eq!((d.choice.as_deref(), d.agreement), (Some("y"), 1.0));
    }

    #[test]
    fn rules_for_unoffered_choices_are_skipped_everywhere() {
        let r = rules(TWO);
        let d = ask(&r, "q", "foo bar", &["y", "z"]);
        assert_eq!(d.rule.as_deref(), Some("c"));
        assert_eq!(d.agreement, 1.0);
    }

    #[test]
    fn no_match_is_no_decision() {
        let d = ask(&rules(TWO), "q", "nothing", &["x", "y"]);
        assert_eq!(d, Decision::none("rules"));
    }

    #[test]
    fn max_chars_limits_the_normalised_field_and_none_vetoes() {
        let r = rules(
            r#"{"rules":[{"id":"r","choice":"x","all":[{"field":"input","pattern":"late","max_chars":10}],
                "none":[{"field":"question","pattern":"skip"}]}]}"#,
        );
        assert!(ask(&r, "q", "late", &["x", "y"]).choice.is_some());
        assert!(
            ask(&r, "q", "0123456789 late", &["x", "y"])
                .choice
                .is_none()
        );
        assert!(ask(&r, "please SKIP", "late", &["x", "y"]).choice.is_none());
        // Multi-byte text is cut on a char boundary, not a byte one.
        let r = rules(
            r#"{"rules":[{"id":"r","choice":"x","all":[{"field":"input","pattern":"^é+$","max_chars":3}]}]}"#,
        );
        assert!(ask(&r, "q", "éééé", &["x", "y"]).choice.is_some());
    }

    #[test]
    fn bad_documents_are_validation_naming_the_file_and_rule() {
        let e = Rules::from_json("not json", "f.json")
            .err()
            .unwrap()
            .to_string();
        assert!(e.contains("f.json"), "{e}");
        let e = Rules::from_json(
            r#"{"rules":[{"id":"broken","choice":"x","all":[{"field":"input","pattern":"("}]}]}"#,
            "f.json",
        )
        .err()
        .unwrap();
        assert!(matches!(e, Error::Validation(_)));
        let e = e.to_string();
        assert!(e.contains("f.json") && e.contains("broken"), "{e}");
        assert!(
            Rules::from_json(r#"{"rules":[{"id":"r","choice":"x","confidence":2}]}"#, "f").is_err()
        );
    }

    #[test]
    fn off_never_decides() {
        let d = Off
            .decide(&Request {
                question: "q",
                input: "i",
                options: &opts(&["a", "b"]),
            })
            .unwrap();
        assert_eq!(d, Decision::none("off"));
    }

    #[test]
    fn validate_wants_a_question_and_two_distinct_options() {
        assert!(validate("q", &opts(&["a", "b"])).is_ok());
        assert!(validate(" ", &opts(&["a", "b"])).is_err());
        assert!(validate("q", &opts(&["a"])).is_err());
        assert!(validate("q", &opts(&["a", "a"])).is_err());
        assert!(validate("q", &opts(&["a", " "])).is_err());
    }

    #[test]
    fn config_picks_the_backend_and_the_rules_file() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.json");
        let req = |b: &dyn DecideBackend| {
            b.decide(&Request {
                question: "q",
                input: "zzz",
                options: &opts(&["x", "y"]),
            })
            .unwrap()
        };
        // Absent config: built-in rules.
        let b = backend_from_config_in(&cfg).unwrap();
        assert_eq!(req(&*b).backend, "rules");
        // A rules file beside config.json is picked up by default.
        std::fs::write(
            dir.path().join("decide-rules.json"),
            r#"{"rules":[{"id":"mine","choice":"y"}]}"#,
        )
        .unwrap();
        let b = backend_from_config_in(&cfg).unwrap();
        assert_eq!(req(&*b).rule.as_deref(), Some("mine"));
        std::fs::write(&cfg, r#"{"decide":{"backend":"off"}}"#).unwrap();
        assert_eq!(req(&*backend_from_config_in(&cfg).unwrap()).backend, "off");
        std::fs::write(&cfg, r#"{"decide":{"backend":"gpt"}}"#).unwrap();
        let e = backend_from_config_in(&cfg).err().unwrap();
        assert!(matches!(e, Error::Validation(_)) && e.to_string().contains("gpt"));
    }

    // Fixture rows from the routing set, run through the built-in ruleset.
    fn route(q: &str, i: &str) -> String {
        let all = opts(&[
            "diff-reviewer",
            "implementer",
            "swift-implementer",
            "ui-verifier",
            "Explore",
            "general-purpose",
        ]);
        let d = Rules::builtin()
            .decide(&Request {
                question: q,
                input: i,
                options: &all,
            })
            .unwrap();
        d.choice.unwrap()
    }

    #[test]
    fn builtin_rules_route_fixture_rows() {
        assert_eq!(
            route(
                "Audit committed FINAL.md vs brief",
                "Audit the already-committed commit 955e112"
            ),
            "diff-reviewer"
        );
        assert_eq!(
            route(
                "Implement retry",
                "You are the implementer. Edit src/lib.rs."
            ),
            "implementer"
        );
        assert_eq!(
            route(
                "Implement tab bar",
                "You implement this in the iOS app. Xcode build."
            ),
            "swift-implementer"
        );
        assert_eq!(
            route("QA the board", "Use khora in the browser to check."),
            "ui-verifier"
        );
        assert_eq!(route("Session friction review", "look"), "Explore");
        assert_eq!(
            route("Recon", "Do not edit anything. recon: report line numbers."),
            "Explore"
        );
        assert_eq!(route("Write docs", "hello"), "general-purpose");
        // The no-edit veto turns an implement title into the fallback.
        assert_eq!(
            route("Implement x", "you implement x but this is read-only"),
            "general-purpose"
        );
    }
}
