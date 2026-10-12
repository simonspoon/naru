//! Filesystem watcher hub behind the Files tab's live refresh (naru task 1874).
//!
//! One [`Hub`] per project root, shared by every open client stream through a
//! [`WatchRegistry`] of `Weak` pointers: the OS watch exists only while at
//! least one [`Subscription`] is alive. Raw `notify` events are reduced to the
//! parent directory that changed, debounced by hand, and broadcast as one
//! [`WatchEvent`] per burst.

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use ::notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

use super::files::EXCLUDED_DIRS;

/// How long a burst is collected after its first event before one
/// [`WatchEvent`] goes out.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// More distinct directories than this collapse to "refetch everything".
const MAX_DIRS: usize = 100;

/// One debounced burst. `dirs` are root-relative, forward-slash, `""` = the
/// root level; `None` means "refetch every loaded level".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "change")]
pub struct WatchEvent {
    pub dirs: Option<Vec<String>>,
}

/// What the notify callback hands the debounce task.
enum Msg {
    Dir(String),
    Everything,
}

/// The parent directory (relative to the canonical root) a changed `path`
/// affects, or `None` when it is outside the root or under an excluded dir.
pub fn changed_dir(canon_root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(canon_root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for c in rel.components() {
        let s = c.as_os_str().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&s.as_str()) {
            return None;
        }
        parts.push(s);
    }
    parts.pop();
    Some(parts.join("/"))
}

pub struct Hub {
    // Dropping the watcher ends the OS watch and the callback's sender,
    // which ends the debounce task.
    _watcher: RecommendedWatcher,
    tx: broadcast::Sender<WatchEvent>,
}

impl Hub {
    fn new(root: &str) -> io::Result<Arc<Hub>> {
        let canon = std::fs::canonicalize(root)?;
        let (msg_tx, msg_rx) = mpsc::unbounded_channel::<Msg>();
        let (tx, _) = broadcast::channel(16);
        let cb_root = canon.clone();
        let mut watcher = ::notify::recommended_watcher(
            move |res: ::notify::Result<::notify::Event>| match res {
                Ok(ev) => {
                    if ev.need_rescan() {
                        let _ = msg_tx.send(Msg::Everything);
                    }
                    for p in &ev.paths {
                        if let Some(d) = changed_dir(&cb_root, p) {
                            let _ = msg_tx.send(Msg::Dir(d));
                        }
                    }
                }
                Err(_) => {
                    let _ = msg_tx.send(Msg::Everything);
                }
            },
        )
        .map_err(io::Error::other)?;
        watcher
            .watch(&canon, RecursiveMode::Recursive)
            .map_err(io::Error::other)?;
        tokio::spawn(debounce(msg_rx, tx.clone()));
        Ok(Arc::new(Hub {
            _watcher: watcher,
            tx,
        }))
    }
}

async fn debounce(mut rx: mpsc::UnboundedReceiver<Msg>, tx: broadcast::Sender<WatchEvent>) {
    while let Some(first) = rx.recv().await {
        let mut dirs: BTreeSet<String> = BTreeSet::new();
        let mut everything = false;
        let mut take = |m: Msg| match m {
            Msg::Dir(d) => {
                dirs.insert(d);
            }
            Msg::Everything => everything = true,
        };
        take(first);
        let deadline = tokio::time::Instant::now() + DEBOUNCE;
        while let Ok(Some(m)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            take(m);
        }
        let dirs = if everything || dirs.len() > MAX_DIRS {
            None
        } else {
            Some(dirs.into_iter().collect())
        };
        let _ = tx.send(WatchEvent { dirs });
    }
}

/// A live client stream's handle: keeps the shared hub (and OS watch) alive.
pub struct Subscription {
    _hub: Arc<Hub>,
    pub rx: broadcast::Receiver<WatchEvent>,
}

#[derive(Clone, Default)]
pub struct WatchRegistry {
    hubs: Arc<Mutex<HashMap<String, Weak<Hub>>>>,
}

impl WatchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe to `root` (a project's `local_path` exactly as stored),
    /// sharing the live hub for it or creating one. Needs a tokio runtime.
    pub fn subscribe(&self, root: &str) -> io::Result<Subscription> {
        let mut hubs = self.hubs.lock().unwrap_or_else(|e| e.into_inner());
        hubs.retain(|_, w| w.strong_count() > 0);
        let hub = match hubs.get(root).and_then(Weak::upgrade) {
            Some(h) => h,
            None => {
                let h = Hub::new(root)?;
                hubs.insert(root.to_string(), Arc::downgrade(&h));
                h
            }
        };
        let rx = hub.tx.subscribe();
        Ok(Subscription { _hub: hub, rx })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn changed_dir_maps_paths() {
        let root = PathBuf::from("/r");
        assert_eq!(changed_dir(&root, Path::new("/r/a.txt")), Some("".into()));
        assert_eq!(
            changed_dir(&root, Path::new("/r/src/core/a.rs")),
            Some("src/core".into())
        );
        for p in [
            "/r/target/x.o",
            "/r/a/node_modules/b/c.js",
            "/r/.git/HEAD",
            "/r/a/b/.git/index",
            "/r/target",
        ] {
            assert_eq!(changed_dir(&root, Path::new(p)), None, "{p}");
        }
        assert_eq!(changed_dir(&root, Path::new("/other/a.txt")), None);
    }

    #[tokio::test]
    async fn burst_yields_one_event_and_excluded_is_silent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_str().unwrap().to_string();
        std::fs::create_dir(tmp.path().join("target")).unwrap();
        let reg = WatchRegistry::new();
        let mut sub = reg.subscribe(&root).unwrap();
        // Let the stream start before the burst.
        tokio::time::sleep(Duration::from_millis(300)).await;

        // Excluded-only writes: nothing within 1.5s.
        std::fs::write(tmp.path().join("target/x.o"), b"x").unwrap();
        let quiet = tokio::time::timeout(Duration::from_millis(1500), sub.rx.recv()).await;
        assert!(quiet.is_err(), "event for excluded dir: {quiet:?}");

        let p = tmp.path();
        std::fs::write(p.join("a.txt"), b"a").unwrap();
        std::fs::rename(p.join("a.txt"), p.join("b.txt")).unwrap();
        std::fs::write(p.join("c.txt"), b"c").unwrap();
        std::fs::remove_file(p.join("c.txt")).unwrap();
        std::fs::write(p.join("target/y.o"), b"y").unwrap();

        let ev = tokio::time::timeout(Duration::from_secs(2), sub.rx.recv())
            .await
            .expect("no event within 2s")
            .unwrap();
        let dirs = ev.dirs.expect("expected a dir list");
        assert!(dirs.contains(&String::new()), "{dirs:?}");
        assert!(dirs.iter().all(|d| !d.starts_with("target")), "{dirs:?}");
        // No second burst follows.
        let more = tokio::time::timeout(Duration::from_millis(900), sub.rx.recv()).await;
        assert!(more.is_err(), "burst split across windows: {more:?}");
    }

    #[test]
    fn watch_event_serialises() {
        let a = serde_json::to_string(&WatchEvent {
            dirs: Some(vec!["".into(), "a".into()]),
        })
        .unwrap();
        assert_eq!(a, r#"{"type":"change","dirs":["","a"]}"#);
        let b = serde_json::to_string(&WatchEvent { dirs: None }).unwrap();
        assert_eq!(b, r#"{"type":"change","dirs":null}"#);
    }

    #[tokio::test]
    async fn subscribers_share_one_hub_and_it_drops() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_str().unwrap().to_string();
        let reg = WatchRegistry::new();
        let a = reg.subscribe(&root).unwrap();
        let b = reg.subscribe(&root).unwrap();
        assert!(Arc::ptr_eq(&a._hub, &b._hub));
        assert_eq!(reg.hubs.lock().unwrap().len(), 1);
        let weak = reg.hubs.lock().unwrap().get(&root).unwrap().clone();
        drop(a);
        assert!(weak.upgrade().is_some());
        drop(b);
        assert!(weak.upgrade().is_none());
    }
}
