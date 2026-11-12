//! File-tree listing + file-content reads/writes rooted at a project's
//! `local_path` (see `.scratch/arch.md` under mesa task 277/278 for the
//! cross-area contract). Like `core::git`/`core::agents`, this module touches
//! EXTERNAL filesystem state only — `std::fs`, no `Store` dependency beyond
//! whatever `local_path` string its caller (279's API layer) already
//! resolved. Six writes live here, all narrow: `write_file` (task 327)
//! overwrites an existing text file's content in place, `create_dir`
//! (task 489) makes one empty directory for the folder picker, `create_file`
//! (task 672) makes one empty file inside a project's tree, and `rename_path`
//! / `delete_path` (task 877) rename or destroy ONE entry of that tree, and
//! `upload_file` (naru task 2732) writes one whole file's bytes into it.
//! Nothing in this module moves anything: a rename takes a new name, never a
//! new path.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::core::types::{
    DirEntry, DirListing, FileContentView, FileSearchFile, FileSearchMatch, FileTreeEntry,
    ProjectFileNames, ProjectFileSearch,
};

/// Mirrors `git.rs`'s `DIFF_CAP` precedent: one huge file can't balloon the
/// JSON response. It bounds everything that is only *looked at*: the
/// read-only view of a file too big to edit ([`read_file`]) and the bytes a
/// project search reads per file. The editor has its own, larger cap
/// ([`FILE_EDIT_CAP`]).
const FILE_CONTENT_CAP: usize = 256 * 1024;

/// The largest text file [`read_file`] sends whole, and so the largest the
/// Files tab opens in its editor and [`write_file`] accepts back (naru task
/// 2803). Separate from [`FILE_CONTENT_CAP`] because the two bound different
/// things: that one a read-only render, this one what the editor stays
/// responsive on (measured; see `docs/files-tab.md`). A file past it is
/// served as its first `FILE_CONTENT_CAP` bytes, `truncated`, and is never
/// writable.
pub const FILE_EDIT_CAP: usize = 5 * 1024 * 1024;

/// Entries returned for one directory level (`tree_level`) before it stops
/// adding more. Applies per call now, not to a whole recursive walk — a
/// directory listing is one level, so this is the only cap that remains.
const MAX_TREE_ENTRIES: usize = 2_000;

/// Directory names excluded at any depth — common VCS/dependency/build
/// output that would otherwise dominate a tree listing.
pub(crate) const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    "vendor",
    ".cache",
];

/// Extensions treated as binary without inspecting content.
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "pdf", "zip", "gz", "tar", "bz2", "xz",
    "7z", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "wasm", "so", "dylib",
    "dll", "exe", "bin", "class", "jar", "db", "sqlite", "sqlite3",
];

/// Extension -> frontend color-coding tag. Unrecognized extensions map to
/// `None` (see `FileContentView::language`'s doc); the frontend keeps its own
/// copy of this table for tree-row tinting (see arch.md #4 — deliberately not
/// duplicated per tree entry to avoid bloating a payload capped at
/// `MAX_TREE_ENTRIES`).
fn language_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "rs" => "rust",
        "ts" | "tsx" | "cts" | "mts" => "typescript",
        "js" | "jsx" | "cjs" | "mjs" => "javascript",
        "py" | "pyi" => "python",
        "json" | "jsonc" | "json5" | "webmanifest" => "json",
        "md" => "markdown",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        // .zsh and .fish are not bash, but bash's is the closest grammar the
        // frontend registers — shell colouring beats none.
        "sh" | "bash" | "zsh" | "fish" => "shell",
        // A single-file component is an HTML document with <script> and
        // <style> blocks in it, so markup colouring is the right fit.
        "html" | "vue" | "svelte" | "astro" => "html",
        "svg" => "svg",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "go" => "go",
        "rb" => "ruby",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        // .kts is Kotlin's script flavour, which is also what a
        // build.gradle.kts carries — so Gradle's Kotlin DSL lands here rather
        // than on the "gradle" arm below.
        "kt" | "kts" => "kotlin",
        "java" => "java",
        // .m is Objective-C; .mm is its C++ flavour.
        "m" | "mm" => "objectivec",
        "php" => "php",
        "dart" => "dart",
        "scala" => "scala",
        "lua" => "lua",
        // Perl scripts and the modules they use.
        "pl" | "pm" => "perl",
        "r" => "r",
        "hs" => "haskell",
        // Elixir source and its script flavour.
        "ex" | "exs" => "elixir",
        // The common Dockerfile has no extension at all and is tagged by name
        // (`language_of_name`); this arm is the `web.dockerfile` spelling.
        "dockerfile" => "docker",
        "mk" => "makefile",
        // A unified diff, under either name the patch tools write.
        "diff" | "patch" => "diff",
        // Key/value config files. "env" is here for a `local.env`; the dotfile
        // spelling (`.env`, `.env.production`) has no extension and is tagged
        // by name instead.
        "ini" | "cfg" | "conf" | "env" => "ini",
        // PowerShell scripts and the modules they import.
        "ps1" | "psm1" => "powershell",
        "proto" => "protobuf",
        "graphql" | "gql" => "graphql",
        // Gradle's other DSL is Groovy, so .gradle rides with it.
        "groovy" | "gradle" => "groovy",
        "sql" => "sql",
        // Tabular data files. Two tags rather than one, because the frontend's
        // table view derives its delimiter from the tag — see
        // `frontend/src/fileCsv.ts`.
        "csv" => "csv",
        "tsv" => "tsv",
        // Kusto queries ship under two extensions — .kql and Azure Data
        // Explorer's own .csl — and both are the same language.
        "kql" | "csl" => "kql",
        // .NET project and UI files are XML documents under a bespoke
        // extension — tagging them "xml" is what gets them markup colouring
        // (task 823). Apple's property lists and Interface Builder documents
        // are the same story. An Xcode .pbxproj deliberately is NOT: it is a
        // NeXT-style plist, not XML, so it stays untagged.
        "xml" | "csproj" | "xaml" | "plist" | "storyboard" | "xib" | "xcworkspacedata" => "xml",
        _ => return None,
    })
}

/// File name -> frontend color-coding tag, for the files an extension cannot
/// describe: those carrying none at all (`Dockerfile`, `Makefile`) and
/// dotfiles, whose leading dot `Path::extension` reads as the start of the
/// stem rather than as a separator (`.zshrc`, `.gitconfig`). Fed the
/// lowercased whole file name, and consulted only when [`language_of`]
/// answered nothing — see [`language_for_path`].
fn language_of_name(name: &str) -> Option<&'static str> {
    // The .env family is a prefix rather than a fixed set: `.env.production`
    // and `.env.local` are one file per environment, and what looks like their
    // extension is the environment's name rather than a format.
    if name == ".env" || name.starts_with(".env.") {
        return Some("ini");
    }
    Some(match name {
        "dockerfile" => "docker",
        // GNU make reads both spellings; its third, `*.mk`, has a real
        // extension and lives in `language_of`.
        "makefile" | "gnumakefile" => "makefile",
        ".gitconfig" | ".editorconfig" => "ini",
        ".zshrc" | ".zprofile" | ".bashrc" | ".bash_profile" | ".profile" => "shell",
        _ => return None,
    })
}

/// The colour tag for a whole path: its extension first, its file name only
/// when the extension answered nothing. Extension-first leaves every tag that
/// already existed exactly as it was, and nothing [`language_of_name`] knows
/// has an extension that maps — `.env.local`'s "local" does not — so neither
/// table can shadow the other.
fn language_for_path(path: &Path) -> Option<&'static str> {
    extension_of(path)
        .as_deref()
        .and_then(language_of)
        .or_else(|| file_name_of(path).as_deref().and_then(language_of_name))
}

/// Extension allowlist for the inline image route
/// (`GET /api/projects/{id}/files/raw`). An extension NOT on this list yields
/// `None`, which the route turns into a 422 — so the allowlist, not any
/// content sniffing, is what decides whether a file may come back with a
/// non-`octet-stream` type at all. Hand-rolled (no new crate), mirroring
/// `attachments::guess_content_type`; deliberately narrower than that one —
/// images only, never `text/html` and never a generic fallback. Only the
/// lowercased extension is consulted, so `foo.png.html` is `.html` and is
/// rejected.
pub fn image_mime(path: &str) -> Option<&'static str> {
    let ext = extension_of(Path::new(path))?;
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Extension allowlist for the playable-media side of the same route
/// (`/files/raw`, naru task 1751): video and audio a browser can play inline.
/// Same posture as [`image_mime`] — final lowercased extension only, no sniff,
/// no fallback, never `text/html`. `mov`/`m4a` play only when the codec is
/// one the browser has; the page falls back to a download link on `error`.
pub fn media_mime(path: &str) -> Option<&'static str> {
    let ext = extension_of(Path::new(path))?;
    Some(match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => return None,
    })
}

/// The audio a live board's clips may be (naru task 2645): wav, mp3 and m4a
/// only — the part of [`media_mime`] the live page plays everywhere. Same
/// posture: final lowercased extension, no sniff.
pub fn clip_mime(path: &str) -> Option<&'static str> {
    match extension_of(Path::new(path))?.as_str() {
        "wav" | "mp3" | "m4a" => media_mime(path),
        _ => None,
    }
}

/// Every type [`clip_mime`] answers — what `Store::add_live_clips_board`
/// checks a clip against.
pub const CLIP_MIMES: &[&str] = &["audio/wav", "audio/mpeg", "audio/mp4"];

/// Most bytes one `206` answers with, however much the range asked for: a
/// player asking `bytes=0-` of a multi-GB video gets the first chunk and a
/// truthful `Content-Range`, then asks again. Keeps a response's memory
/// bounded without a streaming-body dependency.
pub const MEDIA_RANGE_CHUNK: u64 = 8 * 1024 * 1024;

/// What a request's `Range` header asks of a file `total` bytes long.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteRange {
    /// No usable `Range` (absent, malformed, a unit other than `bytes`, or
    /// several ranges): answer 200 with the whole file, which RFC 9110
    /// permits for any range the server declines.
    Full,
    /// Inclusive `start..=end`, already clamped to the file and to
    /// [`MEDIA_RANGE_CHUNK`].
    Partial(u64, u64),
    /// Syntactically valid but outside the file: 416.
    Unsatisfiable,
}

/// Parses a single `bytes=a-b` / `a-` / `-n` range against `total`.
pub fn parse_byte_range(header: Option<&str>, total: u64) -> ByteRange {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return ByteRange::Full;
    };
    if spec.contains(',') {
        return ByteRange::Full;
    }
    let Some((a, b)) = spec.trim().split_once('-') else {
        return ByteRange::Full;
    };
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        // Suffix: the last `n` bytes.
        let Ok(n) = b.parse::<u64>() else {
            return ByteRange::Full;
        };
        if n == 0 || total == 0 {
            return ByteRange::Unsatisfiable;
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let Ok(start) = a.parse::<u64>() else {
            return ByteRange::Full;
        };
        let end = if b.is_empty() {
            u64::MAX
        } else {
            match b.parse::<u64>() {
                Ok(e) => e,
                Err(_) => return ByteRange::Full,
            }
        };
        if end < start {
            return ByteRange::Full;
        }
        if start >= total {
            return ByteRange::Unsatisfiable;
        }
        (start, end.min(total - 1))
    };
    ByteRange::Partial(start, end.min(start + MEDIA_RANGE_CHUNK - 1))
}

/// Reads bytes `start..=end` of the file at `rel`, returning
/// `(basename, total size, bytes)`. Resolved through [`safe_path`]; seeks
/// rather than reading the file, so no whole-file cap applies.
pub fn read_file_range(
    root: &str,
    rel: &str,
    start: u64,
    end: u64,
) -> Result<(String, u64, Vec<u8>), DownloadFileError> {
    use std::io::{Seek, SeekFrom};
    let path = safe_path(root, rel).ok_or(DownloadFileError::NotFound)?;
    let mut f = fs::File::open(&path).map_err(|_| DownloadFileError::NotFound)?;
    let meta = f.metadata().map_err(|_| DownloadFileError::NotFound)?;
    if meta.is_dir() {
        return Err(DownloadFileError::NotFound);
    }
    let total = meta.len();
    if total == 0 || start >= total {
        return Err(DownloadFileError::NotFound);
    }
    let end = end.min(total - 1);
    f.seek(SeekFrom::Start(start))
        .map_err(|_| DownloadFileError::NotFound)?;
    let mut bytes = Vec::with_capacity((end - start + 1) as usize);
    f.take(end - start + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DownloadFileError::NotFound)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel.to_string());
    Ok((name, total, bytes))
}

/// Every mime [`image_mime`] can answer with — the same allowlist read the
/// other way round, for a caller holding a stored content type rather than a
/// path (`Store::add_live_board`, mesa task 1071). One list rather than a
/// second table: a test below pins it against `image_mime`'s own arms in both
/// directions, so neither can gain an entry the other does not have.
pub const IMAGE_MIMES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/x-icon",
    "image/svg+xml",
];

/// Whether `content_type` is one of [`IMAGE_MIMES`] — the allowlist decision
/// made against a type mesa already stored, for the case where the file it
/// came from is long gone.
pub fn is_image_mime(content_type: &str) -> bool {
    IMAGE_MIMES.contains(&content_type)
}

/// Extracts a lowercased extension from a path's basename, or `None` when
/// there isn't one.
fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Extracts a lowercased file name from a path, or `None` when there isn't
/// one. `extension_of`'s sibling, for [`language_of_name`].
fn file_name_of(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase())
}

/// Resolves `rel` (a request-supplied relative path, forward or back
/// slashes) against `root` (the project's `local_path`) and verifies the
/// result is `root` itself or a descendant of it. Both `root` and the joined
/// candidate are run through [`fs::canonicalize`] (which resolves `.`/`..`
/// AND symlinks) before the descendant check, so:
///   - `../../etc/passwd`, absolute paths (`/etc/passwd`) -> the joined
///     candidate canonicalizes to something outside `root` -> `None`.
///   - a symlink inside the tree pointing outside `root` -> canonicalize
///     follows it to the real target -> fails the descendant check -> `None`.
///   - a nonexistent path -> canonicalize errors -> `None`.
///   - `root` itself failing to canonicalize (dead folder) -> `None`.
///
/// Returns the canonical absolute `PathBuf` on success. This is the ONLY
/// function that turns a request path into an fs path; [`read_file`] is its
/// sole caller. No fs read happens before this check succeeds.
pub fn safe_path(root: &str, rel: &str) -> Option<PathBuf> {
    let root_canon = fs::canonicalize(root).ok()?;
    // `Path::join` treats an absolute `rel` as replacing the base entirely
    // (rather than erroring), which is exactly the "absolute-path smuggling"
    // case the descendant check below must catch — so joining first and
    // verifying after is safe, not a bypass.
    let joined = root_canon.join(rel);
    let candidate = fs::canonicalize(&joined).ok()?;
    if candidate == root_canon || candidate.starts_with(&root_canon) {
        Some(candidate)
    } else {
        None
    }
}

/// Lists one directory level — `root` itself when `rel` is `""`, else the
/// subdirectory `rel` resolves to underneath `root`. `rel` is resolved via
/// [`safe_path`] exactly like [`read_file`]/[`write_file`] (traversal,
/// absolute-path smuggling, and symlink escape all collapse to `None` the
/// same way); a `rel` that resolves to a file rather than a directory is
/// also `None`. Excludes [`EXCLUDED_DIRS`] by name, sorts directories before
/// files alphabetically within each group, and caps at [`MAX_TREE_ENTRIES`]
/// entries (returning `truncated: true` when the cap is hit) — this is now a
/// per-directory cap, not a whole-tree one, since each call only ever lists
/// one level; the caller re-calls this per directory on expand to go
/// deeper. Symlinks are listed but never followed (`is_dir: false` for a
/// symlinked dir — avoids both escape and cycle risk with one rule). A
/// `read_dir` failure on an otherwise-valid, already-`safe_path`-verified
/// directory (permissions changing after the check) is swallowed as "no
/// entries", not a failure of the whole call — same "unreadable subdir does
/// not fail the walk" precedent the old recursive `walk_dir` used.
pub fn tree_level(root: &str, rel: &str) -> Option<(Vec<FileTreeEntry>, bool)> {
    let anchor = if rel.is_empty() { "." } else { rel };
    let dir = safe_path(root, anchor)?;
    if !dir.is_dir() {
        return None;
    }
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return Some((Vec::new(), false));
    };
    let mut raw: Vec<(String, bool)> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        // symlink_metadata (not `metadata`) so a symlink is never followed —
        // it is classified as a file leaf regardless of what it points to.
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        raw.push((name, meta.is_dir()));
    }
    // Directories before files, alphabetical within each group.
    raw.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });

    let mut out = Vec::new();
    let mut truncated = false;
    for (name, is_dir) in raw {
        if out.len() >= MAX_TREE_ENTRIES {
            truncated = true;
            break;
        }
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        out.push(FileTreeEntry { name, path, is_dir });
    }
    Some((out, truncated))
}

/// Backs `GET /api/fs/dirs` (the new-project folder picker; see
/// `.scratch/arch.md` under mesa task 405). UNLIKE every other function in
/// this module, this is deliberately NOT bound to any root — there is no
/// `local_path`/project to be contained within, so it does not call or
/// extend [`safe_path`]. The security boundary is the OS's own permission
/// model (the caller's OS user, enforced by `fs::read_dir` itself failing on
/// paths that user can't read) plus the loopback-only access gate at the API
/// layer — not a path prefix this function checks.
///
/// 1. `fs::canonicalize(path)` resolves `.`/`..`/symlinks to one
///    deterministic absolute path; a nonexistent path errors out to `None`
///    here rather than round-tripping to `read_dir` first.
/// 2. Reject if the canonical path is not a directory -> `None`.
/// 3. `fs::read_dir` the canonical path; any error (permission denied — the
///    OS boundary above firing) collapses to `None`, same "swallow as not
///    found" precedent `tree_level`'s own unreadable-directory case uses.
/// 4. List only entries that are themselves directories, using
///    `entry.path().metadata()` (follows symlinks) rather than
///    `symlink_metadata()` — the opposite of `walk_dir`'s choice. `walk_dir`
///    avoids following symlinks because it is a recursive, bound-checked
///    walk where following could escape the root or cycle; this is a single-
///    level listing with no root to escape and no recursion to cycle, so a
///    symlinked directory is just a real, reachable folder the user may
///    legitimately want to pick. An entry whose `metadata()` fails
///    (permission denied, dangling symlink) is skipped rather than failing
///    the whole listing. `EXCLUDED_DIRS` is deliberately not applied either —
///    `node_modules`/dotfiles must remain pickable as a project root, unlike
///    in a de-noised recursive tree view.
///
/// Each entry's `path` is `entry.path()` — the directory's own location
/// (`canon.join(name)`), NOT a further-resolved symlink target: a symlinked
/// entry's `path` still points at the symlink itself (basename always
/// matches `name`), it is only its directory-ness that follows the link.
///
/// `entries` is sorted alphabetically by name; `parent` is the canonical
/// path's own parent directory, or `None` at the filesystem root.
pub fn list_dir(path: &str) -> Option<DirListing> {
    let canon = fs::canonicalize(path).ok()?;
    if !canon.is_dir() {
        return None;
    }
    let read_dir = fs::read_dir(&canon).ok()?;
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in read_dir.flatten() {
        let Ok(meta) = entry.path().metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let parent = canon.parent().map(|p| p.to_string_lossy().into_owned());
    Some(DirListing {
        path: canon.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

/// Why [`create_dir`] rejected the request:
///   - `NotFound`: `parent` doesn't resolve or isn't a directory — the same
///     collapse [`list_dir`]'s `None` performs, so browsing a folder and
///     creating inside it fail identically once it vanishes.
///   - `Validation(reason)`: `name` isn't a usable single directory name.
///   - `Conflict`: something already occupies `parent/name`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateDirError {
    NotFound,
    Validation(&'static str),
    Conflict,
}

/// Creates one directory named `name` directly inside `parent`, returning it
/// as a [`DirEntry`] shaped exactly like the ones [`list_dir`] returns (so a
/// caller can navigate into it without a second listing).
///
/// `name` must be a single path component — separators, NUL, `.` and `..` are
/// rejected outright, which is what keeps `canon.join(name)` inside `parent`.
/// That is the whole containment story, deliberately NOT `safe_path`'s
/// root-plus-relative model, for the same reason [`list_dir`] doesn't use it
/// (docs/fs-browse.md): there is no root here to be contained within, and the
/// bound on *where* a directory may be created is the OS's own permission
/// model plus the endpoint's caller gate, never a mesa-imposed path prefix.
///
/// `fs::create_dir`, never `create_dir_all`: one level only, and an existing
/// path is a `Conflict` the caller is told about rather than a silent success.
pub fn create_dir(parent: &str, name: &str) -> Result<DirEntry, CreateDirError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CreateDirError::Validation("folder name cannot be empty"));
    }
    if name == "." || name == ".." {
        return Err(CreateDirError::Validation("folder name cannot be . or .."));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(CreateDirError::Validation(
            "folder name must be a single name, not a path",
        ));
    }
    let canon = fs::canonicalize(parent).map_err(|_| CreateDirError::NotFound)?;
    if !canon.is_dir() {
        return Err(CreateDirError::NotFound);
    }
    let target = canon.join(name);
    // `symlink_metadata`, not `exists()`: a dangling symlink is still a name
    // taken, which `fs::create_dir` would refuse anyway.
    if target.symlink_metadata().is_ok() {
        return Err(CreateDirError::Conflict);
    }
    fs::create_dir(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => CreateDirError::Conflict,
        _ => CreateDirError::NotFound,
    })?;
    Ok(DirEntry {
        name: name.to_string(),
        path: target.to_string_lossy().into_owned(),
    })
}

/// Resolves `rel` via [`safe_path`], then:
///   - `None` from `safe_path`, OR the resolved path is a directory ->
///     `None`.
///   - extension in a known-binary set, OR a NUL byte in the first 8 KiB ->
///     `Some(FileContentView{is_binary: true, content: "", truncated: false,
///     language})`.
///   - else, a file of at most [`FILE_EDIT_CAP`] bytes: all of it (lossy
///     UTF-8), `truncated: false` — the only shape [`write_file`] accepts
///     back.
///   - else: its first [`FILE_CONTENT_CAP`] bytes (lossy UTF-8, same
///     `capped` char-boundary truncation as `git.rs`), `truncated: true`.
///     Not the first `FILE_EDIT_CAP`: nothing can be done with a cut file
///     but look at it, and megabytes of read-only text is what that smaller
///     cap exists to keep out of the browser.
///
/// `language` is derived from the path in both branches — it describes the
/// FILE, not the content, so it's set even for binaries.
pub fn read_file(root: &str, rel: &str) -> Option<FileContentView> {
    let path = safe_path(root, rel)?;
    if path.is_dir() {
        return None;
    }
    let ext = extension_of(&path);
    let language = language_for_path(&path);
    let ext_is_binary = ext
        .as_deref()
        .is_some_and(|e| BINARY_EXTENSIONS.contains(&e));

    // Read at most FILE_EDIT_CAP+1 bytes — enough to sniff, and to tell a
    // file that fits the editor from one that does not, without pulling an
    // arbitrarily large file fully into memory.
    let mut file = fs::File::open(&path).ok()?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(FILE_EDIT_CAP as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let is_binary = ext_is_binary || sniff_binary(&bytes);
    if is_binary {
        return Some(FileContentView {
            path: rel.to_string(),
            is_binary: true,
            content: String::new(),
            truncated: false,
            language: language.map(str::to_string),
            edit_limit: FILE_EDIT_CAP as u32,
        });
    }

    let (content, truncated) = if bytes.len() > FILE_EDIT_CAP {
        // A few bytes past the view cap, so `capped` sees that there is more
        // and cuts on a char boundary rather than mid-sequence.
        let (content, _) = capped(&bytes[..FILE_CONTENT_CAP + 4]);
        (content, true)
    } else {
        (String::from_utf8_lossy(&bytes).into_owned(), false)
    };
    Some(FileContentView {
        path: rel.to_string(),
        is_binary: false,
        content,
        truncated,
        language: language.map(str::to_string),
        edit_limit: FILE_EDIT_CAP as u32,
    })
}

/// Whole-file byte cap for [`read_file_download`] — deliberately three orders
/// of magnitude above [`FILE_CONTENT_CAP`], because the two caps answer
/// different questions: `FILE_CONTENT_CAP` bounds a JSON *view* a browser has
/// to render, this one bounds only how much memory one response may occupy.
/// It exists at all because the crate has no streaming-body dependency (no
/// `tokio-util`), so the API layer builds the response from a `Vec<u8>` held
/// whole in memory; a file past this size is refused rather than read. Adding
/// a dependency to stream instead is a separate decision, not this cap's job.
const FILE_DOWNLOAD_CAP: u64 = 100 * 1024 * 1024;

/// Why [`read_file_download`] rejected the request, collapsing causes the same
/// way [`WriteFileError`] does:
///   - `NotFound`: [`safe_path`] rejected `rel` (traversal, absolute-path
///     smuggling, symlink escape, nonexistent path), the target is a
///     directory, or an `fs` call (metadata/open/read) failed — the same
///     "io failure collapses to NotFound" precedent [`write_file`] sets.
///   - `TooLarge`: the file is bigger than [`FILE_DOWNLOAD_CAP`]. Detected by
///     stat, so an over-cap file is never read into memory at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadFileError {
    NotFound,
    TooLarge,
}

/// Returns `(basename, full bytes)` for the file at `rel` under `root` — the
/// raw file, for saving to disk, NOT the capped/sniffed view [`read_file`]
/// builds for display. So: no [`FILE_CONTENT_CAP`], no binary sniff, no lossy
/// UTF-8, and every file qualifies — including the two the viewer can show
/// nothing useful for (binary, and text past the display cap), which is
/// exactly where a download earns its place. [`read_file`] and
/// `FILE_CONTENT_CAP` are untouched by this path.
///
/// `rel` is resolved through [`safe_path`] like every other reader here — no
/// second path-resolution rule. The basename is the RESOLVED path's final
/// component (so it can never carry a directory prefix out of `rel`), falling
/// back to `rel` only if there is none.
pub fn read_file_download(root: &str, rel: &str) -> Result<(String, Vec<u8>), DownloadFileError> {
    let path = safe_path(root, rel).ok_or(DownloadFileError::NotFound)?;
    // Stat before reading: an over-cap file must be refused, not slurped.
    let meta = fs::metadata(&path).map_err(|_| DownloadFileError::NotFound)?;
    if meta.is_dir() {
        return Err(DownloadFileError::NotFound);
    }
    if meta.len() > FILE_DOWNLOAD_CAP {
        return Err(DownloadFileError::TooLarge);
    }
    let bytes = fs::read(&path).map_err(|_| DownloadFileError::NotFound)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel.to_string());
    Ok((name, bytes))
}

/// Why [`write_file`] rejected the request. Both variants collapse many
/// distinct causes into one, mirroring `read_file`'s own "one `None` for
/// traversal/absolute/unlisted/directory" precedent:
///   - `NotFound`: `safe_path` rejected `rel` (traversal, absolute-path
///     smuggling, symlink escape, nonexistent path), the target is a
///     directory, or the actual `fs::write` failed (permissions, disk full,
///     the path vanished between the check and the write).
///   - `Validation(reason)`: the target resolves to a real file but can't be
///     safely edited from the capped, possibly-lossy view the editor showed
///     — binary content, a truncated read (the true file is bigger than
///     [`FILE_EDIT_CAP`], so what was displayed wasn't the whole file),
///     or new content that itself exceeds the cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteFileError {
    NotFound,
    Validation(&'static str),
}

/// Overwrites the file at `rel` (resolved the same way [`read_file`] resolves
/// it — reused directly, not re-implemented) with `content`, replacing its
/// entire byte content. Only ever writes to a path that already resolves to
/// an existing, non-directory, non-binary, non-truncated file — this is an
/// edit of a file the caller was shown, never a create, delete, or rename.
pub fn write_file(root: &str, rel: &str, content: &str) -> Result<(), WriteFileError> {
    let view = read_file(root, rel).ok_or(WriteFileError::NotFound)?;
    if view.is_binary {
        return Err(WriteFileError::Validation("cannot edit a binary file"));
    }
    if view.truncated {
        return Err(WriteFileError::Validation(
            "file is larger than mesa can safely edit",
        ));
    }
    if content.len() > FILE_EDIT_CAP {
        return Err(WriteFileError::Validation(
            "content is larger than mesa can safely write",
        ));
    }
    // Re-resolve rather than reuse a path out of `view` (which carries none)
    // — `safe_path` is the module's sole request-path-to-fs-path chokepoint,
    // used identically by every reader/writer.
    let path = safe_path(root, rel).ok_or(WriteFileError::NotFound)?;
    fs::write(&path, content).map_err(|_| WriteFileError::NotFound)
}

/// Why [`create_file`] rejected the request, the same three-way split
/// [`CreateDirError`] uses (and mapped to the same 404/422/409 at the API
/// layer):
///   - `NotFound`: the PARENT directory doesn't resolve through [`safe_path`]
///     (traversal, absolute-path smuggling, symlink escape, nonexistent), is
///     not a directory, or the `fs::write` itself failed.
///   - `Validation(reason)`: the final component isn't a usable single file
///     name.
///   - `Conflict`: something already occupies the target path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateFileError {
    NotFound,
    Validation(&'static str),
    Conflict,
}

/// Creates ONE empty file at `rel` underneath `root` (task 672) — the Files
/// tab's only create, and the only write in this module that brings a new
/// path into existence.
///
/// The load-bearing detail is *what* is resolved: [`safe_path`] canonicalizes
/// its candidate, so a not-yet-existing path always collapses to `None` — the
/// new file itself can never be resolved through it. So the PARENT is
/// resolved instead, exactly as [`create_dir`] splits parent from name, and
/// the final component is then held inside that parent by the same
/// single-component rules `create_dir` applies (no separator, no NUL, not
/// `.`/`..`), which is what makes `parent.join(name)` provably stay put. That
/// keeps `safe_path` the module's sole request-path-to-fs-path chokepoint —
/// no second containment rule here, and no relaxation of `safe_path` itself
/// (whose rejection of nonexistent paths is exactly what
/// `read_file`/`write_file`/`tree_level` rely on).
///
/// The file is created EMPTY, never from a caller-supplied body: content
/// arrives afterwards through the existing [`write_file`] edit path, so there
/// is no second content cap, binary sniff or truncation rule to keep in sync.
pub fn create_file(root: &str, rel: &str) -> Result<(), CreateFileError> {
    let (parent_rel, name) = match rel.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => ("", rel),
    };
    let name = name.trim();
    if name.is_empty() {
        return Err(CreateFileError::Validation("file name cannot be empty"));
    }
    if name == "." || name == ".." {
        return Err(CreateFileError::Validation("file name cannot be . or .."));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(CreateFileError::Validation(
            "file name must be a single name, not a path",
        ));
    }
    let anchor = if parent_rel.is_empty() {
        "."
    } else {
        parent_rel
    };
    let parent = safe_path(root, anchor).ok_or(CreateFileError::NotFound)?;
    if !parent.is_dir() {
        return Err(CreateFileError::NotFound);
    }
    let target = parent.join(name);
    // `symlink_metadata`, not `exists()`: a dangling symlink is still a name
    // taken — `create_dir`'s rule, for the same reason.
    if target.symlink_metadata().is_ok() {
        return Err(CreateFileError::Conflict);
    }
    fs::write(&target, "").map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => CreateFileError::Conflict,
        _ => CreateFileError::NotFound,
    })
}

/// The single-component rules [`create_file`] applies to the final component
/// of a new path, lifted out because the two entry writes below need them more
/// than once between them ([`rename_path`] holds BOTH the existing name and the
/// new one to them). Returns the trimmed name, or the reason it is not usable
/// as one component. The wording is name-not-file-name because the entry on the
/// other side may be a directory.
fn single_component(name: &str) -> Result<&str, &'static str> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name cannot be empty");
    }
    if name == "." || name == ".." {
        return Err("name cannot be . or ..");
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("name must be a single name, not a path");
    }
    Ok(name)
}

/// What [`resolve_entry`] answers when it will not hand back an entry — mapped
/// onto each caller's own public error enum, which is why this one is private
/// and carries only the two variants both writes share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryError {
    NotFound,
    Validation(&'static str),
}

/// One resolved tree entry, as [`resolve_entry`] hands it to the two writes
/// below: the directory holding it, its absolute path, the two halves of `rel`
/// the echoed [`FileTreeEntry`] is rebuilt from, and how [`tree_level`] would
/// classify it. Borrowed from `rel` rather than owned — nothing here outlives
/// the call.
struct ResolvedEntry<'a> {
    parent: PathBuf,
    target: PathBuf,
    parent_rel: &'a str,
    name: &'a str,
    is_dir: bool,
}

/// The shared front half of [`rename_path`] and [`delete_path`]: turns `rel`
/// into the entry it names.
///
/// It resolves the **PARENT** through [`safe_path`] and never the target
/// itself — [`create_file`]'s rule, and load-bearing for a second reason here.
/// `safe_path` canonicalizes, which *follows symlinks*: resolving the target
/// through it would turn "rename/delete this symlink" into "rename/delete
/// whatever it points at", and would answer `None` for the very symlinks
/// [`tree_level`] happily lists (any pointing outside `root`) — so the entry a
/// user can see would be the one entry they could not act on. Holding the final
/// component to the same single-component rules [`create_file`] applies is what
/// keeps `parent.join(name)` provably inside `parent`, so `safe_path` stays the
/// module's sole request-path-to-fs-path chokepoint with no second containment
/// model.
///
/// `rel` naming the root itself (empty, whitespace-only, or `.`) is
/// `Validation`: the project folder is not an entry of its own tree, and
/// neither write may rename or destroy it.
///
/// `is_dir` comes from `symlink_metadata().file_type()`, so a symlinked
/// directory is a file leaf — [`tree_level`]'s classification, so the echoed
/// entry matches the row it came from.
fn resolve_entry<'a>(root: &str, rel: &'a str) -> Result<ResolvedEntry<'a>, EntryError> {
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Err(EntryError::Validation(
            "the project folder itself is not a tree entry",
        ));
    }
    let (parent_rel, name) = match rel.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => ("", rel),
    };
    let name = single_component(name).map_err(EntryError::Validation)?;
    let anchor = if parent_rel.is_empty() {
        "."
    } else {
        parent_rel
    };
    let parent = safe_path(root, anchor).ok_or(EntryError::NotFound)?;
    if !parent.is_dir() {
        return Err(EntryError::NotFound);
    }
    let target = parent.join(name);
    // `symlink_metadata`, never `exists()`: a dangling symlink is a real row in
    // the tree, so it has to be an entry these writes can act on rather than a
    // name that reads as missing.
    let meta = target
        .symlink_metadata()
        .map_err(|_| EntryError::NotFound)?;
    Ok(ResolvedEntry {
        parent,
        target,
        parent_rel,
        name,
        is_dir: meta.file_type().is_dir(),
    })
}

/// The relative path an entry named `name` inside `parent_rel` carries — the
/// same `{rel}/{name}` shape [`tree_level`] gives the rows the caller clicked.
fn entry_path(parent_rel: &str, name: &str) -> String {
    if parent_rel.is_empty() {
        name.to_string()
    } else {
        format!("{parent_rel}/{name}")
    }
}

/// Why [`rename_path`] rejected the request, the same three-way split
/// [`CreateFileError`] uses (and mapped to the same 404/422/409 at the API
/// layer):
///   - `NotFound`: the PARENT directory doesn't resolve through [`safe_path`]
///     (traversal, absolute-path smuggling, symlink escape, nonexistent), is
///     not a directory, the source entry doesn't exist, or the `fs::rename`
///     itself failed.
///   - `Validation(reason)`: `rel` names the root itself, or either name isn't
///     a usable single component.
///   - `Conflict`: something already occupies the new name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenamePathError {
    NotFound,
    Validation(&'static str),
    Conflict,
}

impl From<EntryError> for RenamePathError {
    fn from(err: EntryError) -> Self {
        match err {
            EntryError::NotFound => RenamePathError::NotFound,
            EntryError::Validation(reason) => RenamePathError::Validation(reason),
        }
    }
}

/// Renames the entry at `rel` — a file, a directory or a symlink — to
/// `new_name` (task 877), returning the entry it became: the NEW name, its new
/// relative path, and the `is_dir` [`tree_level`] would list it with.
///
/// **Within the same directory only.** `new_name` is one name, never a path, so
/// this is a rename and not a move — moving an entry is [`move_path`], a
/// separate write with its own containment argument, and the single-component
/// check is what makes the narrower promise here enforceable rather than merely
/// intended. Both names go through
/// [`single_component`]; the containment story is [`resolve_entry`]'s, i.e.
/// [`create_file`]'s.
///
/// An existing destination is `Conflict`, tested with `symlink_metadata()`
/// rather than `exists()` — `create_file`'s rule, for its reason (a dangling
/// symlink is a name taken). Renaming an entry onto its own name therefore
/// conflicts too, which is the honest answer: nothing to do, and the caller
/// asked for a rename.
pub fn rename_path(
    root: &str,
    rel: &str,
    new_name: &str,
) -> Result<FileTreeEntry, RenamePathError> {
    let entry = resolve_entry(root, rel)?;
    let new_name = single_component(new_name).map_err(RenamePathError::Validation)?;
    let dest = entry.parent.join(new_name);
    if dest.symlink_metadata().is_ok() {
        return Err(RenamePathError::Conflict);
    }
    fs::rename(&entry.target, &dest).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => RenamePathError::Conflict,
        _ => RenamePathError::NotFound,
    })?;
    Ok(FileTreeEntry {
        name: new_name.to_string(),
        path: entry_path(entry.parent_rel, new_name),
        // A rename does not change what the entry IS, so this is the
        // classification `resolve_entry` already read off it — not a second
        // `symlink_metadata` on the new name.
        is_dir: entry.is_dir,
    })
}

/// Why [`delete_path`] rejected the request — the two-way split
/// [`WriteFileError`] uses, since a delete has no destination to collide with:
///   - `NotFound`: the PARENT directory doesn't resolve through [`safe_path`]
///     (traversal, absolute-path smuggling, symlink escape, nonexistent), is
///     not a directory, the entry doesn't exist, or the removal itself failed.
///   - `Validation(reason)`: `rel` names the root itself, or its final
///     component isn't a usable single name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletePathError {
    NotFound,
    Validation(&'static str),
}

impl From<EntryError> for DeletePathError {
    fn from(err: EntryError) -> Self {
        match err {
            EntryError::NotFound => DeletePathError::NotFound,
            EntryError::Validation(reason) => DeletePathError::Validation(reason),
        }
    }
}

/// Destroys the entry at `rel` (task 877), returning the [`FileTreeEntry`] it
/// was — captured BEFORE the removal, which is the delete-echo precedent the
/// rest of mesa runs on (CLAUDE.md: the echoed record is the recovery
/// transcript that substitutes for a confirmation prompt this app deliberately
/// does not have).
///
/// **A directory is removed recursively** (`fs::remove_dir_all`), and that is
/// the intent rather than a convenience: the affordance is "delete this folder"
/// on a tree row, and refusing a non-empty one would leave the only way to
/// empty it being to delete every descendant one row at a time. Everything else
/// — a file, or a symlink of any kind — goes through `fs::remove_file`, so a
/// symlink is unlinked as the NAME it is and whatever it points at is never
/// touched (see [`resolve_entry`] for why the target is never canonicalized).
pub fn delete_path(root: &str, rel: &str) -> Result<FileTreeEntry, DeletePathError> {
    let entry = resolve_entry(root, rel)?;
    let destroyed = FileTreeEntry {
        name: entry.name.to_string(),
        path: entry_path(entry.parent_rel, entry.name),
        is_dir: entry.is_dir,
    };
    let removed = if entry.is_dir {
        fs::remove_dir_all(&entry.target)
    } else {
        fs::remove_file(&entry.target)
    };
    removed.map_err(|_| DeletePathError::NotFound)?;
    Ok(destroyed)
}

/// Resolves `rel` (`""` or `.` for the root) to a directory the tree itself
/// could have listed, for the two ends of [`move_path`]. It goes through
/// [`safe_path`] like every other request path, and then holds the answer to
/// one more rule: the resolved path must be exactly `root` + `rel`'s own
/// components, each a plain name that is not in [`EXCLUDED_DIRS`].
/// Canonicalizing changes a path only by resolving `.`/`..` or following a
/// symlink, so that equality is what refuses a symlinked directory — which
/// [`tree_level`] lists as a file leaf, never as somewhere to put things — and
/// any spelling of a real directory other than the one its rows carry.
fn listed_dir(root: &str, rel: &str) -> Option<PathBuf> {
    let mut expected = safe_path(root, ".")?;
    if rel.is_empty() || rel == "." {
        return expected.is_dir().then_some(expected);
    }
    let resolved = safe_path(root, rel)?;
    for part in rel.split('/') {
        if single_component(part) != Ok(part) || EXCLUDED_DIRS.contains(&part) {
            return None;
        }
        expected.push(part);
    }
    (resolved == expected && resolved.is_dir()).then_some(resolved)
}

/// Why [`move_path`] rejected the request — [`RenamePathError`]'s three-way
/// split plus one refusal of its own:
///   - `NotFound`: the source's parent or the destination doesn't resolve
///     through [`safe_path`], is not a directory the tree lists (a symlinked or
///     excluded one), the source entry doesn't exist or is itself an excluded
///     name, or the `fs::rename` failed.
///   - `Validation(reason)`: the source is the root itself or not a usable
///     path, it is already in the destination, or the destination is the
///     source or inside it.
///   - `Conflict`: something already holds the entry's name in the destination.
///   - `CrossDevice`: the two directories are on different filesystems.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovePathError {
    NotFound,
    Validation(&'static str),
    Conflict,
    CrossDevice,
}

impl From<EntryError> for MovePathError {
    fn from(err: EntryError) -> Self {
        match err {
            EntryError::NotFound => MovePathError::NotFound,
            EntryError::Validation(reason) => MovePathError::Validation(reason),
        }
    }
}

/// Moves the entry at `rel` — a file, a directory or a symlink — into the
/// directory `dest_dir` (`""` or `.` for the root), keeping its name (naru
/// task 2745), and returns the entry it became.
///
/// A move has two request paths, and **both go through [`safe_path`]**: the
/// source's parent by [`resolve_entry`] (so a symlink is still moved as the
/// name it is, never as its target), and the destination by [`listed_dir`].
/// The caller names a destination DIRECTORY and never a destination path, so
/// the new location is `dest.join(name)` with `name` the single component
/// `resolve_entry` already checked — [`create_file`]'s containment rule, with
/// no path the caller wrote ever joined unchecked. [`rename_path`] is untouched
/// and still cannot move anything.
///
/// Both directories must also be ones the tree lists (see [`listed_dir`]), and
/// the entry itself may not be an [`EXCLUDED_DIRS`] name: a move never reaches
/// into, or drops something into, a place the tree does not show.
///
/// A directory may not be moved into itself or anything under it. That is
/// tested on canonical paths — the destination is one already, and a real
/// directory can be canonicalized without changing what it names — so a
/// different spelling of the same folder on a case-insensitive filesystem is
/// still caught.
///
/// A taken name is `Conflict` and nothing is replaced or merged, tested with
/// `symlink_metadata()` like every other destination check here; on a
/// case-insensitive or normalization-insensitive filesystem that lookup finds
/// the differently spelled entry, so those conflict too. The move is one
/// `fs::rename`, so it is atomic, and a destination on another filesystem is
/// `CrossDevice` — reported, never papered over with a copy and a delete.
pub fn move_path(root: &str, rel: &str, dest_dir: &str) -> Result<FileTreeEntry, MovePathError> {
    let entry = resolve_entry(root, rel)?;
    if EXCLUDED_DIRS.contains(&entry.name) {
        return Err(MovePathError::NotFound);
    }
    let parent = listed_dir(root, entry.parent_rel).ok_or(MovePathError::NotFound)?;
    let dest_rel = if dest_dir == "." { "" } else { dest_dir };
    let dest = listed_dir(root, dest_rel).ok_or(MovePathError::NotFound)?;
    if dest == parent {
        return Err(MovePathError::Validation("already in that folder"));
    }
    if entry.is_dir {
        let source = fs::canonicalize(&entry.target).map_err(|_| MovePathError::NotFound)?;
        if dest.starts_with(&source) {
            return Err(MovePathError::Validation(
                "cannot move a folder into itself",
            ));
        }
    }
    let target = dest.join(entry.name);
    if target.symlink_metadata().is_ok() {
        return Err(MovePathError::Conflict);
    }
    fs::rename(&entry.target, &target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => MovePathError::Conflict,
        std::io::ErrorKind::CrossesDevices => MovePathError::CrossDevice,
        _ => MovePathError::NotFound,
    })?;
    Ok(FileTreeEntry {
        name: entry.name.to_string(),
        path: entry_path(dest_rel, entry.name),
        is_dir: entry.is_dir,
    })
}

/// Creates ONE empty directory at `rel` underneath `root` (naru task 2745) —
/// [`create_file`] for a folder, with its containment rule unchanged: the
/// PARENT is resolved through [`safe_path`] and must be a directory, and the
/// final component is held to [`single_component`]. `fs::create_dir`, never
/// `create_dir_all`: one level only, and a taken name is `Conflict`.
///
/// Not [`create_dir`], which serves the unscoped new-project folder picker and
/// has no root to be contained within.
///
/// An [`EXCLUDED_DIRS`] name is `Validation`: the folder would be created and
/// then never listed, so the row the caller asked for could not appear.
pub fn create_tree_dir(root: &str, rel: &str) -> Result<FileTreeEntry, CreateFileError> {
    let (parent_rel, name) = match rel.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => ("", rel),
    };
    let name = single_component(name).map_err(CreateFileError::Validation)?;
    if EXCLUDED_DIRS.contains(&name) {
        return Err(CreateFileError::Validation(
            "the file tree hides folders with that name",
        ));
    }
    let anchor = if parent_rel.is_empty() {
        "."
    } else {
        parent_rel
    };
    let parent = safe_path(root, anchor).ok_or(CreateFileError::NotFound)?;
    if !parent.is_dir() {
        return Err(CreateFileError::NotFound);
    }
    let target = parent.join(name);
    if target.symlink_metadata().is_ok() {
        return Err(CreateFileError::Conflict);
    }
    fs::create_dir(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => CreateFileError::Conflict,
        _ => CreateFileError::NotFound,
    })?;
    Ok(FileTreeEntry {
        name: name.to_string(),
        path: entry_path(parent_rel, name),
        is_dir: true,
    })
}

/// Largest file [`upload_file`] will write, in decoded bytes: the attachments
/// figure (25 MiB), since both are "one whole file in one JSON body" and the
/// API layer sizes its body limit from this the same way.
pub const MAX_UPLOAD_BYTES: usize = crate::core::attachments::MAX_ATTACHMENT_BYTES as usize;

/// Why [`upload_file`] rejected the request — [`CreateFileError`]'s three-way
/// split, mapped to the same 404/422/409 at the API layer:
///   - `NotFound`: `dir` doesn't resolve through [`safe_path`] (traversal,
///     absolute-path smuggling, symlink escape, nonexistent), is not a
///     directory, or an `fs` call failed.
///   - `Validation(reason)`: `name` isn't a usable single component, the bytes
///     are over [`MAX_UPLOAD_BYTES`], or a *directory* already holds the name
///     (which no flag replaces).
///   - `Conflict`: a file or symlink already holds the name and `overwrite`
///     was not set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadFileError {
    NotFound,
    Validation(&'static str),
    Conflict,
}

/// Writes `bytes` verbatim as the file `name` inside the directory `dir`
/// (naru task 2732) — the one write in this module that carries arbitrary
/// content into the tree, so it is binary safe and has its own cap rather than
/// [`write_file`]'s text-editor one.
///
/// Containment is [`create_file`]'s rule unchanged: `dir` (`""` or `.` for the
/// root) is resolved through [`safe_path`] and must be a directory, and `name`
/// is held to [`single_component`], which is what keeps `parent.join(name)`
/// inside `parent`.
///
/// A taken name is never replaced silently: without `overwrite` it is
/// `Conflict`, and the new file is opened with `create_new`, so a name that
/// appears between the check and the write still conflicts instead of being
/// clobbered. With `overwrite` the bytes go to a temporary file in the same
/// directory which is then renamed over the name — a rename replaces the NAME,
/// so a symlink sitting there is replaced as a link and whatever it points at
/// (possibly outside `root`) is never written through, and a reader never sees
/// a half-written file. A regular file being replaced keeps its permission
/// bits. A directory holding the name is `Validation` either way.
pub fn upload_file(
    root: &str,
    dir: &str,
    name: &str,
    bytes: &[u8],
    overwrite: bool,
) -> Result<FileTreeEntry, UploadFileError> {
    use std::io::Write;

    let name = single_component(name).map_err(UploadFileError::Validation)?;
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(UploadFileError::Validation(
            "file is larger than the 25 MiB upload limit",
        ));
    }
    let (anchor, parent_rel) = if dir.is_empty() || dir == "." {
        (".", "")
    } else {
        (dir, dir)
    };
    let parent = safe_path(root, anchor).ok_or(UploadFileError::NotFound)?;
    if !parent.is_dir() {
        return Err(UploadFileError::NotFound);
    }
    let target = parent.join(name);
    // `symlink_metadata`, not `exists()`: a dangling symlink is still a name
    // taken — `create_file`'s rule.
    let existing = target.symlink_metadata().ok();
    if existing.as_ref().is_some_and(|m| m.file_type().is_dir()) {
        return Err(UploadFileError::Validation(
            "a folder with that name already exists",
        ));
    }
    if !overwrite {
        if existing.is_some() {
            return Err(UploadFileError::Conflict);
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => UploadFileError::Conflict,
                _ => UploadFileError::NotFound,
            })?;
        if file.write_all(bytes).is_err() {
            let _ = fs::remove_file(&target);
            return Err(UploadFileError::NotFound);
        }
    } else {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let temp = parent.join(format!(".naru-upload-{}-{nanos}", std::process::id()));
        let written = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .and_then(|mut file| file.write_all(bytes))
            .and_then(|()| match &existing {
                Some(meta) if meta.file_type().is_file() => {
                    fs::set_permissions(&temp, meta.permissions())
                }
                _ => Ok(()),
            })
            .and_then(|()| fs::rename(&temp, &target));
        if written.is_err() {
            let _ = fs::remove_file(&temp);
            return Err(UploadFileError::NotFound);
        }
    }
    Ok(FileTreeEntry {
        name: name.to_string(),
        path: entry_path(parent_rel, name),
        is_dir: false,
    })
}

/// The two toggles a search carries, mirroring the in-file find bar's
/// (`frontend/src/fileFind.ts`) — the same two questions, asked of the whole
/// tree instead of one open file.
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
}

/// The most matches [`search_files`] returns from one file. A file that
/// mentions the query on every line is one row per line in a panel that has
/// to stay scannable; the file's own `truncated` flag is how it says there
/// are more, and the in-file find bar (`Cmd/Ctrl+F`, which has its own,
/// larger cap) is where an exhaustive answer for one file lives.
const MAX_SEARCH_MATCHES_PER_FILE: usize = 50;

/// The most files one search reports hits for.
const MAX_SEARCH_FILES: usize = 200;

/// The most matches one search returns in total, across every file — the
/// ceiling on the response, and on the DOM the panel builds from it.
const MAX_SEARCH_TOTAL_MATCHES: usize = 1_000;

/// The most files one search will *open*, hit or not. The other three caps
/// bound the answer; this one bounds the work, so a query that matches
/// nothing in a huge tree still terminates promptly instead of reading every
/// byte under `local_path`.
const MAX_SEARCH_SCANNED_FILES: usize = 20_000;

/// The longest query [`search_files`] accepts. A literal scan is linear in
/// it, and nothing a person types at a search box comes near this — the API
/// layer turns a longer one into a 422 rather than scanning a megabyte of
/// pasted text against every file.
pub const MAX_SEARCH_QUERY: usize = 200;

/// Characters of context kept *before* a match in a result snippet.
const SNIPPET_LEAD: usize = 40;

/// The longest snippet a result row carries. A minified bundle is one line
/// of half a megabyte; windowing around the match is what keeps the row a
/// row.
const SNIPPET_MAX: usize = 240;

/// True when `ch` is a word character for the whole-word toggle — ASCII
/// letters, digits and `_`, the *same* set `fileFind.ts::isWordChar` uses.
/// Deliberately not a unicode-aware class: the two implementations answer the
/// same question about the same query, and widening one of them silently
/// would make the panel and the find bar disagree about what a word is.
fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// True when `a` and `b` are the same character under the chosen case rule.
/// Folded per character, `fileFind.ts::sameChar`'s rule and for its reason:
/// a lowercased *copy* of a line is not character-for-character the line the
/// snippet is cut out of.
fn same_char(a: char, b: char, case_sensitive: bool) -> bool {
    if a == b {
        return true;
    }
    if case_sensitive {
        return false;
    }
    a.to_lowercase().eq(b.to_lowercase())
}

/// Every match of `query` in `line`, as start indices into `line`, in order
/// and never overlapping — the char-slice twin of `fileFind.ts::findMatches`,
/// with the same whole-word rule (a boundary is demanded only on the sides
/// where the *query itself* ends in a word character, so `(x` still finds
/// `f(x)`).
///
/// Both sides are `&[char]` rather than `&str` because a snippet is cut by
/// character position: indexing a `&str` by byte offset is the one way this
/// could panic, and there is no reason to go near it.
fn line_matches(line: &[char], query: &[char], opts: SearchOptions) -> Vec<usize> {
    let mut out = Vec::new();
    if query.is_empty() || line.len() < query.len() {
        return out;
    }
    let head_is_word = is_word_char(query[0]);
    let tail_is_word = is_word_char(query[query.len() - 1]);
    let mut i = 0;
    while i + query.len() <= line.len() {
        let hit = (0..query.len()).all(|k| same_char(line[i + k], query[k], opts.case_sensitive));
        if !hit {
            i += 1;
            continue;
        }
        let end = i + query.len();
        if opts.whole_word
            && ((head_is_word && i > 0 && is_word_char(line[i - 1]))
                || (tail_is_word && line.get(end).copied().is_some_and(is_word_char)))
        {
            i += 1;
            continue;
        }
        out.push(i);
        // The scan index only ever moves forward — by one on a miss, by the
        // whole (non-empty) query on a hit — so no input can loop.
        i = end;
    }
    out
}

/// The snippet a result row paints: the line with its leading indentation
/// dropped, windowed around the match, `…` marking either cut.
///
/// Shaped here rather than in the client for the reason the offsets are not
/// on the wire at all ([`crate::core::types::FileSearchMatch`]): one
/// implementation, tested with `cargo test`, and a payload whose size is
/// bounded before it is serialized rather than after it is rendered.
fn snippet(line: &[char], at: usize) -> String {
    let indent = line.iter().take_while(|c| c.is_whitespace()).count();
    // A match *inside* the indentation (searching for a tab, say) must not
    // put the window before the text it is in.
    let body_start = indent.min(at);
    let start = at.saturating_sub(SNIPPET_LEAD).max(body_start);
    let end = (start + SNIPPET_MAX).min(line.len());
    let mut out = String::new();
    if start > body_start {
        out.push('…');
    }
    out.extend(&line[start..end]);
    if end < line.len() {
        out.push('…');
    }
    out
}

/// Every match of `query` under `root`, grouped by file — the project-wide
/// search behind `GET /api/projects/{id}/files/search` (mesa task 813) and
/// the Files tab's `Cmd/Ctrl+Shift+F` panel.
///
/// A **literal** scan, never a regular expression, for `fileFind.ts`'s reason:
/// a query is a user's typing, not a pattern language. `query` must be
/// non-empty and no longer than [`MAX_SEARCH_QUERY`]; the API layer rejects
/// both before calling, and an empty one here answers "no results" rather
/// than "every position".
///
/// What it reads is exactly what the Files tab can show, which is the whole
/// point of not reusing a `grep`:
///   - The walk is [`tree_level`]'s, applied recursively — [`EXCLUDED_DIRS`]
///     skipped by name, directories before files alphabetically, and symlinks
///     never followed (one rule covering escape and cycle at once), so no
///     result can name a path the tree would not list.
///   - A file is read through the same [`FILE_CONTENT_CAP`]-bounded read and
///     the same extension/NUL binary rules [`read_file`] applies, so a hit's
///     line number always exists in the viewer that opens next, and binary
///     bytes are never scanned or quoted.
///   - `root` itself is resolved once through [`safe_path`] and every
///     descendant is reached by walking real directory entries from there, so
///     nothing outside the project's `local_path` is ever opened.
///
/// Four caps bound the answer and the work
/// ([`MAX_SEARCH_MATCHES_PER_FILE`], [`MAX_SEARCH_FILES`],
/// [`MAX_SEARCH_TOTAL_MATCHES`], [`MAX_SEARCH_SCANNED_FILES`]); hitting any
/// of them sets `truncated` on the result, and the per-file one sets it on
/// that file as well. `None` only for a `root` that does not resolve to a
/// directory — the caller's 404, exactly as for [`tree_level`].
pub fn search_files(root: &str, query: &str, opts: SearchOptions) -> Option<ProjectFileSearch> {
    let root_canon = safe_path(root, ".")?;
    if !root_canon.is_dir() {
        return None;
    }
    let needle: Vec<char> = query.chars().collect();
    let mut out = ProjectFileSearch {
        files: Vec::new(),
        total_matches: 0,
        truncated: false,
    };
    if needle.is_empty() || needle.len() > MAX_SEARCH_QUERY {
        return Some(out);
    }
    let mut scanned = 0usize;
    walk_files(&root_canon, "", &mut |path, rel| {
        search_one_file(path, rel, &needle, opts, &mut out, &mut scanned);
        !out.truncated
    });
    Some(out)
}

/// The walk behind [`search_files`] and [`list_file_names`]: one directory
/// level at a time, in the order [`tree_level`] lists them — this level's
/// files first, then its subdirectories, recursively. [`EXCLUDED_DIRS`] are
/// skipped by name and symlinks are skipped outright (never opened, never
/// recursed into), so `visit` is only ever handed a regular file the tree
/// could list. `visit` gets the file's path on disk and its root-relative
/// path, and returns `false` to stop the whole walk; so does this, which is
/// how a stop at any depth unwinds every level above it.
fn walk_files(dir: &Path, rel: &str, visit: &mut dyn FnMut(&Path, &str) -> bool) -> bool {
    // An unreadable directory is "no entries", not a failed walk — the same
    // precedent `tree_level` takes for a permission change under it.
    let Ok(read_dir) = fs::read_dir(dir) else {
        return true;
    };
    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        // symlink_metadata, so a symlink is a file leaf whatever it points at
        // — never recursed into, never opened as a directory.
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        if meta.is_symlink() {
            continue;
        }
        entries.push((name, meta.is_dir()));
    }
    entries.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });

    let child_rel = |name: &str| {
        if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        }
    };
    for (name, _) in entries.iter().filter(|(_, is_dir)| !is_dir) {
        if !visit(&dir.join(name), &child_rel(name)) {
            return false;
        }
    }
    for (name, _) in entries.iter().filter(|(_, is_dir)| *is_dir) {
        if !walk_files(&dir.join(name), &child_rel(name), visit) {
            return false;
        }
    }
    true
}

/// Scan one file and append its group, if it has one.
fn search_one_file(
    path: &Path,
    rel: &str,
    needle: &[char],
    opts: SearchOptions,
    out: &mut ProjectFileSearch,
    scanned: &mut usize,
) {
    if *scanned >= MAX_SEARCH_SCANNED_FILES {
        out.truncated = true;
        return;
    }
    *scanned += 1;
    let ext = extension_of(path);
    if ext
        .as_deref()
        .is_some_and(|e| BINARY_EXTENSIONS.contains(&e))
    {
        return;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let mut bytes = Vec::new();
    if (&mut file)
        .take(FILE_CONTENT_CAP as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return;
    }
    if sniff_binary(&bytes) {
        return;
    }
    let (content, _) = capped(&bytes);

    let mut matches: Vec<FileSearchMatch> = Vec::new();
    let mut file_truncated = false;
    'lines: for (i, line) in content.lines().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        for at in line_matches(&chars, needle, opts) {
            if matches.len() >= MAX_SEARCH_MATCHES_PER_FILE {
                file_truncated = true;
                break 'lines;
            }
            matches.push(FileSearchMatch {
                line: (i + 1) as u32,
                text: snippet(&chars, at),
            });
            if out.total_matches as usize + matches.len() >= MAX_SEARCH_TOTAL_MATCHES {
                out.truncated = true;
                break 'lines;
            }
        }
    }
    if matches.is_empty() {
        return;
    }
    out.total_matches += matches.len() as u32;
    out.files.push(FileSearchFile {
        path: rel.to_string(),
        language: language_for_path(path).map(str::to_string),
        matches,
        truncated: file_truncated,
    });
    if out.files.len() >= MAX_SEARCH_FILES {
        out.truncated = true;
    }
}

/// The most files [`list_file_names`] lists — and, since it opens nothing and
/// counts only files, the most it visits: the walk stops at the first file
/// past this, so the cap bounds the work and the response together. Well
/// above any source tree the Files tab is for (this repo, `target/` and
/// `node_modules/` excluded, is under 2,000), and at roughly 40 bytes a path
/// still a response of a couple of megabytes at worst.
pub const MAX_NAME_FILES: usize = 50_000;

/// Every file under `root` by root-relative path, for the Files tab's
/// Cmd/Ctrl+P "Go to file" box (naru task 2744) — `GET
/// /api/projects/{id}/files/names`.
///
/// Exactly the tree the browser can list, because it is [`search_files`]'s
/// own walk ([`walk_files`]): [`EXCLUDED_DIRS`] skipped at any depth,
/// symlinks never followed, `root` resolved once through [`safe_path`] and
/// everything else reached by walking real entries from there. Nothing is
/// opened — this is names only — and binary files are listed like any other,
/// since the box opens them in their own viewers.
///
/// No query: the client ranks the whole list itself (`quickOpen.ts`), because
/// the cost here is the walk, which is the same whatever is typed, so a
/// request per keystroke would repeat it per keystroke. Capped at
/// [`MAX_NAME_FILES`] with `truncated` set when there were more. `None` only
/// for a `root` that does not resolve to a directory, as for [`tree_level`].
pub fn list_file_names(root: &str) -> Option<ProjectFileNames> {
    list_file_names_capped(root, MAX_NAME_FILES)
}

/// [`list_file_names`] with the cap as an argument, so a test can hit it
/// without writing fifty thousand files.
fn list_file_names_capped(root: &str, cap: usize) -> Option<ProjectFileNames> {
    let root_canon = safe_path(root, ".")?;
    if !root_canon.is_dir() {
        return None;
    }
    let mut out = ProjectFileNames {
        paths: Vec::new(),
        truncated: false,
    };
    walk_files(&root_canon, "", &mut |_, rel| {
        if out.paths.len() >= cap {
            out.truncated = true;
            return false;
        }
        out.paths.push(rel.to_string());
        true
    });
    Some(out)
}

/// NUL-byte sniff over the first 8 KiB — the standard cheap binary-file
/// heuristic (git and most editors use the same signal).
fn sniff_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(8192)];
    probe.contains(&0)
}

/// Lossy UTF-8, truncated to [`FILE_CONTENT_CAP`] on a char boundary (same
/// shape as `git.rs::capped`). Returns `(content, truncated)`.
fn capped(bytes: &[u8]) -> (String, bool) {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    if s.len() <= FILE_CONTENT_CAP {
        return (s, false);
    }
    let cut = (0..=FILE_CONTENT_CAP)
        .rev()
        .find(|i| s.is_char_boundary(*i));
    s.truncate(cut.unwrap_or(0));
    (s, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    // --- safe_path -----------------------------------------------------

    #[test]
    fn safe_path_accepts_root_itself_and_nested_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/f.txt"), "hi").unwrap();

        assert!(safe_path(root, ".").is_some());
        let p = safe_path(root, "sub/f.txt").unwrap();
        assert!(p.ends_with("sub/f.txt"));
    }

    #[test]
    fn safe_path_rejects_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let root = root.to_str().unwrap();
        assert_eq!(safe_path(root, "../secret.txt"), None);
        assert_eq!(safe_path(root, "../../../../../../etc/passwd"), None);
    }

    #[test]
    fn safe_path_rejects_absolute_path_smuggling() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(safe_path(root, "/etc/passwd"), None);
    }

    #[test]
    fn safe_path_rejects_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(safe_path(root, "nope.txt"), None);
    }

    #[test]
    fn safe_path_rejects_dead_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("gone");
        assert_eq!(safe_path(root.to_str().unwrap(), "f.txt"), None);
    }

    #[test]
    #[cfg(unix)]
    fn safe_path_rejects_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();

        assert_eq!(safe_path(root.to_str().unwrap(), "link.txt"), None);
    }

    #[test]
    #[cfg(unix)]
    fn safe_path_rejects_symlinked_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("f.txt"), "x").unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();

        assert_eq!(safe_path(root.to_str().unwrap(), "linkdir/f.txt"), None);
    }

    // --- list_dir --------------------------------------------------------

    #[test]
    fn list_dir_lists_subdirectories_only_sorted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("zzz")).unwrap();
        fs::create_dir_all(root.join("aaa")).unwrap();
        fs::write(root.join("a_file.txt"), "x").unwrap();

        let listing = list_dir(root.to_str().unwrap()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["aaa", "zzz"]);
    }

    #[test]
    fn list_dir_does_not_exclude_dotfiles_or_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();

        let listing = list_dir(root.to_str().unwrap()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&".git"));
        assert!(names.contains(&"node_modules"));
    }

    #[test]
    fn list_dir_resolves_canonical_path_and_reports_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();

        let listing = list_dir(root.join("sub").join("..").to_str().unwrap()).unwrap();
        let canon_root = fs::canonicalize(root).unwrap();
        assert_eq!(listing.path, canon_root.to_string_lossy());
        let parent = canon_root.parent().unwrap().to_string_lossy().into_owned();
        assert_eq!(listing.parent.as_deref(), Some(parent.as_str()));
    }

    #[test]
    fn list_dir_none_for_root_relative_traversal_that_does_not_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(
            list_dir(root.join("does/not/exist/../../nope").to_str().unwrap()),
            None
        );
    }

    #[test]
    fn list_dir_none_for_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(list_dir(dir.path().join("gone").to_str().unwrap()), None);
    }

    #[test]
    fn list_dir_none_for_file_given_as_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), "hi").unwrap();
        assert_eq!(list_dir(dir.path().join("f.txt").to_str().unwrap()), None);
    }

    // --- create_dir ------------------------------------------------------

    #[test]
    fn create_dir_makes_the_folder_and_returns_it_as_a_listable_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let entry = create_dir(root.to_str().unwrap(), "new proj").unwrap();
        assert_eq!(entry.name, "new proj");
        assert!(fs::metadata(&entry.path).unwrap().is_dir());
        // The returned path is exactly what `list_dir` would report for it,
        // so the caller can navigate straight into it.
        let listing = list_dir(&entry.path).unwrap();
        assert_eq!(listing.path, entry.path);
        assert!(
            list_dir(root.to_str().unwrap())
                .unwrap()
                .entries
                .iter()
                .any(|e| e.path == entry.path)
        );
    }

    #[test]
    fn create_dir_trims_the_name() {
        let dir = tempfile::tempdir().unwrap();
        let entry = create_dir(dir.path().to_str().unwrap(), "  spaced  ").unwrap();
        assert_eq!(entry.name, "spaced");
    }

    #[test]
    fn create_dir_rejects_empty_dot_and_path_shaped_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        for bad in ["", "   ", ".", "..", "a/b", "../escape", "a\\b", "a\0b"] {
            assert!(
                matches!(create_dir(root, bad), Err(CreateDirError::Validation(_))),
                "expected validation error for {bad:?}"
            );
        }
    }

    #[test]
    fn create_dir_conflicts_on_an_existing_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir(dir.path().join("taken")).unwrap();
        fs::write(dir.path().join("afile"), "x").unwrap();

        assert_eq!(create_dir(root, "taken"), Err(CreateDirError::Conflict));
        assert_eq!(create_dir(root, "afile"), Err(CreateDirError::Conflict));
    }

    #[test]
    fn create_dir_not_found_for_missing_or_non_directory_parent() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), "x").unwrap();

        assert_eq!(
            create_dir(dir.path().join("gone").to_str().unwrap(), "x"),
            Err(CreateDirError::NotFound)
        );
        assert_eq!(
            create_dir(dir.path().join("f.txt").to_str().unwrap(), "x"),
            Err(CreateDirError::NotFound)
        );
    }

    #[test]
    #[cfg(unix)]
    fn list_dir_follows_symlinked_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();

        let listing = list_dir(root.to_str().unwrap()).unwrap();
        let entry = listing
            .entries
            .iter()
            .find(|e| e.name == "linkdir")
            .unwrap();
        // Listed as a directory (the symlink is followed to classify it),
        // but its `path` stays the symlink's own location, not the resolved
        // target — basename(path) == name always holds.
        let canon_root = fs::canonicalize(&root).unwrap();
        assert_eq!(entry.path, canon_root.join("linkdir").to_string_lossy());
    }

    // --- tree_level --------------------------------------------------------

    #[test]
    fn tree_level_excludes_vcs_and_dependency_dirs_and_sorts_dirs_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("zzz_dir")).unwrap();
        fs::write(root.join("a_file.txt"), "a").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();

        let (level, truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        assert!(!truncated);
        let names: Vec<&str> = level.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&".git"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&"target"));
        // Directories sort before files.
        assert_eq!(names[0], "zzz_dir");
        assert_eq!(names[1], "a_file.txt");

        let zzz = level.iter().find(|e| e.name == "zzz_dir").unwrap();
        assert!(zzz.is_dir);
        let file = level.iter().find(|e| e.name == "a_file.txt").unwrap();
        assert!(!file.is_dir);
    }

    #[test]
    fn tree_level_reports_truncated_when_entry_cap_hit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..(MAX_TREE_ENTRIES + 5) {
            fs::write(root.join(format!("f{i:05}.txt")), "x").unwrap();
        }
        let (level, truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        assert!(truncated);
        assert!(level.len() <= MAX_TREE_ENTRIES);
    }

    #[test]
    fn tree_level_only_lists_one_level_deep() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::write(root.join("a/b/c/deep.txt"), "x").unwrap();

        let (level, _truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        assert_eq!(level.len(), 1);
        assert_eq!(level[0].name, "a");
        assert!(level[0].is_dir);
    }

    #[test]
    fn tree_level_relative_paths_use_forward_slashes_and_nest_via_rel() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/f.txt"), "x").unwrap();

        let (top, _truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        let sub = top.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(sub.path, "sub");

        let (children, _truncated) = tree_level(root.to_str().unwrap(), "sub").unwrap();
        assert_eq!(children[0].path, "sub/f.txt");
    }

    #[test]
    #[cfg(unix)]
    fn tree_level_lists_symlinked_dir_as_file_leaf_without_following() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();

        let (level, _truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        let link = level.iter().find(|e| e.name == "linkdir").unwrap();
        assert!(!link.is_dir);
    }

    #[test]
    fn tree_level_none_for_traversal_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        assert_eq!(tree_level(root.to_str().unwrap(), "../"), None);
    }

    #[test]
    fn tree_level_none_for_file_given_as_rel() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("f.txt"), "hi").unwrap();
        assert_eq!(tree_level(root, "f.txt"), None);
    }

    #[test]
    fn tree_level_none_for_nonexistent_rel() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(tree_level(root, "nope"), None);
    }

    // --- read_file --------------------------------------------------------

    #[test]
    fn read_file_returns_content_with_language() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}\n").unwrap();

        let v = read_file(root, "main.rs").unwrap();
        assert_eq!(v.path, "main.rs");
        assert!(!v.is_binary);
        assert_eq!(v.content, "fn main() {}\n");
        assert!(!v.truncated);
        assert_eq!(v.language.as_deref(), Some("rust"));
    }

    #[test]
    fn read_file_tags_cs_as_csharp() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("Program.cs"), "class P {}\n").unwrap();

        let v = read_file(root, "Program.cs").unwrap();
        assert!(!v.is_binary);
        assert_eq!(v.language.as_deref(), Some("csharp"));
    }

    #[test]
    fn read_file_caps_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "a".repeat(FILE_EDIT_CAP + 1000);
        fs::write(dir.path().join("big.txt"), &big).unwrap();

        let v = read_file(root, "big.txt").unwrap();
        assert!(!v.is_binary);
        assert!(v.truncated);
        // Only the view cap's worth of a file too big to edit, not megabytes.
        assert_eq!(v.content.len(), FILE_CONTENT_CAP);
        assert_eq!(v.edit_limit as usize, FILE_EDIT_CAP);
    }

    #[test]
    fn read_file_sends_a_file_up_to_the_edit_cap_whole() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        // Past the old 256 KiB view cap, and exactly at the edit cap.
        for len in [FILE_CONTENT_CAP + 1000, FILE_EDIT_CAP] {
            let big = "é\n".repeat(len / 3) + &"a".repeat(len % 3);
            assert_eq!(big.len(), len);
            fs::write(dir.path().join("big.txt"), &big).unwrap();

            let v = read_file(root, "big.txt").unwrap();
            assert!(!v.truncated, "{len} bytes must not be truncated");
            assert!(v.content == big, "{len} bytes must arrive whole");
        }
    }

    #[test]
    fn read_file_cuts_an_over_cap_file_on_a_char_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        // One ASCII byte, then 2-byte chars: the view cap lands mid-char.
        let big = format!("a{}", "é".repeat(FILE_EDIT_CAP / 2 + 1));
        fs::write(dir.path().join("big.txt"), &big).unwrap();

        let v = read_file(root, "big.txt").unwrap();
        assert!(v.truncated);
        assert_eq!(v.content.len(), FILE_CONTENT_CAP - 1);
        assert!(big.starts_with(&v.content));
    }

    #[test]
    fn read_file_detects_binary_by_extension() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("img.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();

        let v = read_file(root, "img.png").unwrap();
        assert!(v.is_binary);
        assert_eq!(v.content, "");
        assert!(!v.truncated);
    }

    #[test]
    fn read_file_detects_binary_by_nul_byte_sniff() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let mut bytes = b"some header".to_vec();
        bytes.push(0);
        bytes.extend_from_slice(b"more data");
        fs::write(dir.path().join("weird.dat"), &bytes).unwrap();

        let v = read_file(root, "weird.dat").unwrap();
        assert!(v.is_binary);
        assert_eq!(v.content, "");
    }

    #[test]
    fn read_file_none_for_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(read_file(root, "nope.txt"), None);
    }

    #[test]
    fn read_file_none_for_directory_given_as_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        assert_eq!(read_file(root, "sub"), None);
    }

    #[test]
    fn read_file_none_for_traversal_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        assert_eq!(read_file(root.to_str().unwrap(), "../secret.txt"), None);
    }

    #[test]
    fn read_file_unrecognized_extension_has_no_language() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("notes.xyz"), "plain text").unwrap();
        let v = read_file(root, "notes.xyz").unwrap();
        assert_eq!(v.language, None);
    }

    // --- image_mime (mesa task 801) ------------------------------------------

    #[test]
    fn image_mime_accepts_every_allowlisted_extension_case_insensitively() {
        for (name, mime) in [
            ("a.png", "image/png"),
            ("A.PNG", "image/png"),
            ("a.jpg", "image/jpeg"),
            ("x.JPEG", "image/jpeg"),
            ("a.jpeg", "image/jpeg"),
            ("a.gif", "image/gif"),
            ("a.GIF", "image/gif"),
            ("a.webp", "image/webp"),
            ("a.WebP", "image/webp"),
            ("a.bmp", "image/bmp"),
            ("a.ico", "image/x-icon"),
            ("a.svg", "image/svg+xml"),
            ("a.SVG", "image/svg+xml"),
            ("deep/nested/dir/photo.PnG", "image/png"),
        ] {
            assert_eq!(image_mime(name), Some(mime), "{name}");
        }
    }

    /// The two directions of one allowlist: everything `image_mime` answers
    /// with is an [`IMAGE_MIMES`] entry, and every entry is something it can
    /// actually answer with. Either half failing means the pair has drifted,
    /// which is exactly what having one list is meant to prevent.
    #[test]
    fn image_mimes_and_image_mime_are_the_same_allowlist() {
        let extensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];
        for ext in extensions {
            let mime = image_mime(&format!("a.{ext}")).expect(ext);
            assert!(is_image_mime(mime), "{mime} is not in IMAGE_MIMES");
        }
        for mime in IMAGE_MIMES {
            assert!(
                extensions
                    .iter()
                    .any(|ext| image_mime(&format!("a.{ext}")) == Some(mime)),
                "{mime} is in IMAGE_MIMES but no extension produces it"
            );
        }
        assert!(!is_image_mime("text/html"), "markup is never an image type");
        assert!(!is_image_mime(""), "an empty type is not an image type");
    }

    #[test]
    fn image_mime_rejects_markup_source_and_extensionless_names() {
        // `.html`/`.htm` above all: the route must never be able to return
        // same-origin markup. A double extension is judged by its LAST one.
        for name in [
            "a.html",
            "a.htm",
            "a.md",
            "a.rs",
            "a.json",
            "noext",
            "foo.png.html",
            ".gitignore",
            "a.pdf",
            "a.txt",
        ] {
            assert_eq!(image_mime(name), None, "{name}");
        }
    }

    #[test]
    fn media_mime_maps_the_allowlist_and_nothing_else() {
        for (name, mime) in [
            ("a.mp4", "video/mp4"),
            ("a.M4V", "video/mp4"),
            ("a.mov", "video/quicktime"),
            ("a.webm", "video/webm"),
            ("a.m4a", "audio/mp4"),
            ("a.mp3", "audio/mpeg"),
            ("a.wav", "audio/wav"),
            ("a.ogg", "audio/ogg"),
            ("a.oga", "audio/ogg"),
            ("a.aac", "audio/aac"),
            ("a.flac", "audio/flac"),
        ] {
            assert_eq!(media_mime(name), Some(mime), "{name}");
        }
        for name in ["a.html", "a.png", "noext", "foo.mp4.html", ".mp4", "a.mkv"] {
            assert_eq!(media_mime(name), None, "{name}");
        }
    }

    #[test]
    fn parse_byte_range_handles_each_form() {
        use ByteRange::*;
        let p = |h: &str, t| parse_byte_range(Some(h), t);
        assert_eq!(parse_byte_range(None, 100), Full);
        assert_eq!(p("bytes=0-9", 100), Partial(0, 9));
        assert_eq!(p("bytes=90-", 100), Partial(90, 99));
        assert_eq!(p("bytes=-10", 100), Partial(90, 99));
        assert_eq!(p("bytes=-500", 100), Partial(0, 99));
        assert_eq!(p("bytes=50-500", 100), Partial(50, 99));
        assert_eq!(p("bytes=100-", 100), Unsatisfiable);
        assert_eq!(p("bytes=-0", 100), Unsatisfiable);
        assert_eq!(p("bytes=0-", 0), Unsatisfiable);
        assert_eq!(p("bytes=0-1,5-6", 100), Full);
        assert_eq!(p("bytes=9-3", 100), Full);
        assert_eq!(p("items=0-3", 100), Full);
        assert_eq!(p("bytes=x-3", 100), Full);
        let big = 10 * MEDIA_RANGE_CHUNK;
        assert_eq!(p("bytes=0-", big), Partial(0, MEDIA_RANGE_CHUNK - 1));
    }

    #[test]
    fn language_of_tags_svg() {
        assert_eq!(language_of("svg"), Some("svg"));
    }

    #[test]
    fn language_of_tags_query_languages() {
        assert_eq!(language_of("sql"), Some("sql"));
        assert_eq!(language_of("kql"), Some("kql"));
        assert_eq!(language_of("csl"), Some("kql"));
    }

    #[test]
    fn language_of_tags_tabular_data() {
        assert_eq!(language_of("csv"), Some("csv"));
        assert_eq!(language_of("tsv"), Some("tsv"));
    }

    #[test]
    fn read_file_tags_uppercase_csv_as_csv() {
        // `language_of` is only ever fed the lowercased extension
        // (`extension_of`), which is what makes the tag case-insensitive from a
        // caller's point of view.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("Rows.CSV"), "a,b\n1,2\n").unwrap();

        let v = read_file(root, "Rows.CSV").unwrap();
        assert_eq!(v.language.as_deref(), Some("csv"));
    }

    #[test]
    fn language_of_tags_the_compiled_languages() {
        for (ext, tag) in [
            ("swift", "swift"),
            ("kt", "kotlin"),
            ("kts", "kotlin"),
            ("java", "java"),
            ("m", "objectivec"),
            ("mm", "objectivec"),
            ("dart", "dart"),
            ("scala", "scala"),
            ("hs", "haskell"),
            ("ex", "elixir"),
            ("exs", "elixir"),
            ("groovy", "groovy"),
            ("gradle", "groovy"),
        ] {
            assert_eq!(language_of(ext), Some(tag), "{ext}");
        }
    }

    #[test]
    fn language_of_tags_the_scripting_languages() {
        for (ext, tag) in [
            ("php", "php"),
            ("lua", "lua"),
            ("pl", "perl"),
            ("pm", "perl"),
            ("r", "r"),
            ("ps1", "powershell"),
            ("psm1", "powershell"),
            ("zsh", "shell"),
            ("fish", "shell"),
        ] {
            assert_eq!(language_of(ext), Some(tag), "{ext}");
        }
    }

    #[test]
    fn language_of_tags_the_build_and_config_extensions() {
        for (ext, tag) in [
            ("dockerfile", "docker"),
            ("mk", "makefile"),
            ("diff", "diff"),
            ("patch", "diff"),
            ("ini", "ini"),
            ("cfg", "ini"),
            ("conf", "ini"),
            ("env", "ini"),
            ("proto", "protobuf"),
            ("graphql", "graphql"),
            ("gql", "graphql"),
        ] {
            assert_eq!(language_of(ext), Some(tag), "{ext}");
        }
    }

    #[test]
    fn language_of_tags_the_new_aliases_onto_existing_grammars() {
        for (ext, tag) in [
            ("scss", "scss"),
            ("less", "less"),
            ("vue", "html"),
            ("svelte", "html"),
            ("astro", "html"),
            ("cjs", "javascript"),
            ("mjs", "javascript"),
            ("cts", "typescript"),
            ("mts", "typescript"),
            ("pyi", "python"),
            ("hh", "cpp"),
            ("cxx", "cpp"),
            ("hxx", "cpp"),
            ("jsonc", "json"),
            ("json5", "json"),
            ("webmanifest", "json"),
            ("plist", "xml"),
            ("storyboard", "xml"),
            ("xib", "xml"),
            ("xcworkspacedata", "xml"),
        ] {
            assert_eq!(language_of(ext), Some(tag), "{ext}");
        }
    }

    #[test]
    fn language_of_leaves_an_xcode_project_file_untagged() {
        // A .pbxproj is a NeXT-style property list, not XML — markup colouring
        // would be wrong, so it renders plain.
        assert_eq!(language_of("pbxproj"), None);
    }

    #[test]
    fn language_of_name_tags_the_extensionless_build_files() {
        for (name, tag) in [
            ("dockerfile", "docker"),
            ("makefile", "makefile"),
            ("gnumakefile", "makefile"),
        ] {
            assert_eq!(language_of_name(name), Some(tag), "{name}");
        }
    }

    #[test]
    fn language_of_name_tags_the_dotfiles() {
        for (name, tag) in [
            (".gitconfig", "ini"),
            (".editorconfig", "ini"),
            (".zshrc", "shell"),
            (".zprofile", "shell"),
            (".bashrc", "shell"),
            (".bash_profile", "shell"),
            (".profile", "shell"),
        ] {
            assert_eq!(language_of_name(name), Some(tag), "{name}");
        }
    }

    #[test]
    fn language_of_name_tags_the_whole_env_family() {
        // `.env.local`'s apparent extension is "local", which means nothing —
        // the family is matched on its prefix instead.
        for name in [".env", ".env.local", ".env.production", ".env.test.ci"] {
            assert_eq!(language_of_name(name), Some("ini"), "{name}");
        }
        assert_eq!(language_of_name(".envrc"), None);
    }

    #[test]
    fn language_for_path_reads_the_extension_first_then_the_name() {
        // An extension wins where there is one...
        assert_eq!(language_for_path(Path::new("a/b.swift")), Some("swift"));
        // ...including a Gradle Kotlin DSL script, whose extension is `kts`
        // and which therefore needs no rule of its own.
        assert_eq!(
            language_for_path(Path::new("build.gradle.kts")),
            Some("kotlin")
        );
        // ...and the file name answers only where it does not.
        assert_eq!(language_for_path(Path::new("a/Dockerfile")), Some("docker"));
        assert_eq!(language_for_path(Path::new("a/Makefile")), Some("makefile"));
        assert_eq!(
            language_for_path(Path::new("a/GNUmakefile")),
            Some("makefile")
        );
        assert_eq!(
            language_for_path(Path::new("a/web.dockerfile")),
            Some("docker")
        );
        assert_eq!(
            language_for_path(Path::new("a/.env.production")),
            Some("ini")
        );
        assert_eq!(language_for_path(Path::new("a/.zshrc")), Some("shell"));
        assert_eq!(language_for_path(Path::new("a/App.pbxproj")), None);
        assert_eq!(language_for_path(Path::new("a/notes")), None);
    }

    #[test]
    fn read_file_tags_an_extensionless_dockerfile() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("Dockerfile"), "FROM alpine\n").unwrap();

        let v = read_file(root, "Dockerfile").unwrap();
        assert_eq!(v.language.as_deref(), Some("docker"));
    }

    #[test]
    fn language_of_tags_dotnet_markup_as_xml() {
        assert_eq!(language_of("csproj"), Some("xml"));
        assert_eq!(language_of("xaml"), Some("xml"));
        assert_eq!(language_of("xml"), Some("xml"));
    }

    #[test]
    fn read_file_tags_csproj_as_xml() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(
            dir.path().join("App.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\" />\n",
        )
        .unwrap();

        let v = read_file(root, "App.csproj").unwrap();
        assert!(!v.is_binary);
        assert_eq!(v.language.as_deref(), Some("xml"));
    }

    // --- read_file_download -------------------------------------------------

    #[test]
    fn read_file_download_returns_basename_and_full_text_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("src/core")).unwrap();
        fs::write(dir.path().join("src/core/main.rs"), "fn main() {}\n").unwrap();

        let (name, bytes) = read_file_download(root, "src/core/main.rs").unwrap();
        // The final component, never the `rel` that was asked for.
        assert_eq!(name, "main.rs");
        assert_eq!(bytes, b"fn main() {}\n");
    }

    #[test]
    fn read_file_download_returns_binary_bytes_verbatim_including_nuls() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let raw: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x0d, 0x0a];
        fs::write(dir.path().join("img.png"), &raw).unwrap();
        // The display path shows nothing for this file — the download must
        // still hand back every byte, unchanged and not lossy-UTF-8'd.
        assert!(read_file(root, "img.png").unwrap().is_binary);

        let (name, bytes) = read_file_download(root, "img.png").unwrap();
        assert_eq!(name, "img.png");
        assert_eq!(bytes, raw);
    }

    #[test]
    fn read_file_download_returns_an_over_display_cap_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "a".repeat(FILE_EDIT_CAP + 1000);
        fs::write(dir.path().join("big.txt"), &big).unwrap();
        // The viewer shows this one `truncated`; the download is the whole file.
        assert!(read_file(root, "big.txt").unwrap().truncated);

        let (_, bytes) = read_file_download(root, "big.txt").unwrap();
        assert_eq!(bytes.len(), big.len());
        assert_eq!(bytes, big.as_bytes());
    }

    #[test]
    fn read_file_download_not_found_for_traversal_absolute_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        let root = root.to_str().unwrap();

        for bad in ["../secret.txt", "/etc/passwd", "nope.txt"] {
            assert_eq!(
                read_file_download(root, bad),
                Err(DownloadFileError::NotFound),
                "path {bad:?}"
            );
        }
    }

    #[test]
    fn read_file_download_not_found_for_directory_given_as_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        assert_eq!(
            read_file_download(root, "sub"),
            Err(DownloadFileError::NotFound)
        );
    }

    #[test]
    #[cfg(unix)]
    fn read_file_download_not_found_for_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();

        assert_eq!(
            read_file_download(root.to_str().unwrap(), "link.txt"),
            Err(DownloadFileError::NotFound)
        );
    }

    #[test]
    fn read_file_download_cap_sits_far_above_the_display_cap() {
        // No 100 MiB fixture: the length check is asserted by the one property
        // that matters for the cases above — every file the viewer can open,
        // truncated ones included, is comfortably under the download cap.
        assert!(FILE_DOWNLOAD_CAP > FILE_CONTENT_CAP as u64);
    }

    // --- write_file ---------------------------------------------------------

    #[test]
    fn write_file_overwrites_existing_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}\n").unwrap();

        assert_eq!(
            write_file(root, "main.rs", "fn main() { edited(); }\n"),
            Ok(())
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("main.rs")).unwrap(),
            "fn main() { edited(); }\n"
        );
    }

    #[test]
    fn write_file_none_for_traversal_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();

        assert_eq!(
            write_file(root.to_str().unwrap(), "../secret.txt", "pwned"),
            Err(WriteFileError::NotFound)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("secret.txt")).unwrap(),
            "top secret"
        );
    }

    #[test]
    fn write_file_not_found_for_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(
            write_file(root, "nope.txt", "hi"),
            Err(WriteFileError::NotFound)
        );
    }

    #[test]
    fn write_file_not_found_for_directory_given_as_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        assert_eq!(write_file(root, "sub", "hi"), Err(WriteFileError::NotFound));
    }

    #[test]
    fn write_file_rejects_binary_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("img.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();

        assert_eq!(
            write_file(root, "img.png", "not a real png"),
            Err(WriteFileError::Validation("cannot edit a binary file"))
        );
    }

    #[test]
    fn write_file_rejects_truncated_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "a".repeat(FILE_EDIT_CAP + 1000);
        fs::write(dir.path().join("big.txt"), &big).unwrap();

        let err = write_file(root, "big.txt", "short replacement").unwrap_err();
        assert_eq!(
            err,
            WriteFileError::Validation("file is larger than mesa can safely edit")
        );
        // The write must never have happened — the file is untouched.
        assert!(fs::read_to_string(dir.path().join("big.txt")).unwrap() == big);
    }

    /// The save that would cut a file on disk (naru task 2803): the client
    /// sends back exactly the truncated content it was shown. Under every
    /// size cap, so only the `truncated` guard stands between it and the file.
    #[test]
    fn write_file_never_writes_back_a_truncated_view() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "line\n".repeat(FILE_EDIT_CAP / 5 + 1);
        fs::write(dir.path().join("big.txt"), &big).unwrap();

        let view = read_file(root, "big.txt").unwrap();
        assert!(view.truncated);
        assert!(view.content.len() < big.len());

        let err = write_file(root, "big.txt", &view.content).unwrap_err();
        assert_eq!(
            err,
            WriteFileError::Validation("file is larger than mesa can safely edit")
        );
        assert!(fs::read(dir.path().join("big.txt")).unwrap() == big.as_bytes());
    }

    #[test]
    fn write_file_saves_a_file_past_the_view_cap_byte_exact() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "fn f() { /* é */ }\n".repeat(2 * FILE_CONTENT_CAP / 20);
        assert!(big.len() > FILE_CONTENT_CAP);
        fs::write(dir.path().join("big.rs"), &big).unwrap();

        let edited = read_file(root, "big.rs").unwrap().content + "// tail\n";
        assert_eq!(write_file(root, "big.rs", &edited), Ok(()));
        let on_disk = fs::read(dir.path().join("big.rs")).unwrap();
        assert!(on_disk == format!("{big}// tail\n").as_bytes());
    }

    #[test]
    fn write_file_rejects_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("small.txt"), "hi").unwrap();
        let big_content = "a".repeat(FILE_EDIT_CAP + 1);

        let err = write_file(root, "small.txt", &big_content).unwrap_err();
        assert_eq!(
            err,
            WriteFileError::Validation("content is larger than mesa can safely write")
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("small.txt")).unwrap(),
            "hi"
        );
    }

    // --- create_file --------------------------------------------------------

    #[test]
    fn create_file_makes_an_empty_file_at_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();

        assert_eq!(create_file(root, "notes.md"), Ok(()));
        assert_eq!(fs::read_to_string(dir.path().join("notes.md")).unwrap(), "");
    }

    #[test]
    fn create_file_makes_an_empty_file_inside_a_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("src/core")).unwrap();

        assert_eq!(create_file(root, "src/core/new.rs"), Ok(()));
        assert!(dir.path().join("src/core/new.rs").is_file());
    }

    #[test]
    fn create_file_reads_back_through_read_file_as_empty_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();

        create_file(root, "fresh.rs").unwrap();
        let view = read_file(root, "fresh.rs").unwrap();
        assert_eq!(view.content, "");
        assert!(!view.is_binary);
        assert!(!view.truncated);
        assert_eq!(view.language.as_deref(), Some("rust"));
    }

    #[test]
    fn create_file_not_found_for_traversal_and_absolute_parents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let root = root.to_str().unwrap();

        assert_eq!(
            create_file(root, "../escape.txt"),
            Err(CreateFileError::NotFound)
        );
        assert_eq!(
            create_file(root, "/tmp/mesa-create-file-escape.txt"),
            Err(CreateFileError::NotFound)
        );
        assert_eq!(
            create_file(root, "a/../../x"),
            Err(CreateFileError::NotFound)
        );
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn create_file_not_found_when_the_parent_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("README.md"), "hi").unwrap();

        assert_eq!(
            create_file(root, "README.md/x.txt"),
            Err(CreateFileError::NotFound)
        );
    }

    #[test]
    fn create_file_rejects_empty_dot_and_path_shaped_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();

        assert_eq!(
            create_file(root, ""),
            Err(CreateFileError::Validation("file name cannot be empty"))
        );
        assert_eq!(
            create_file(root, "   "),
            Err(CreateFileError::Validation("file name cannot be empty"))
        );
        // A trailing slash leaves nothing for the final component.
        assert_eq!(
            create_file(root, "sub/"),
            Err(CreateFileError::Validation("file name cannot be empty"))
        );
        assert_eq!(
            create_file(root, "."),
            Err(CreateFileError::Validation("file name cannot be . or .."))
        );
        assert_eq!(
            create_file(root, ".."),
            Err(CreateFileError::Validation("file name cannot be . or .."))
        );
        // A separator surviving into the final component — `/` is consumed by
        // the parent split, so this is the backslash half of the same rule.
        assert_eq!(
            create_file(root, "a\\b"),
            Err(CreateFileError::Validation(
                "file name must be a single name, not a path"
            ))
        );
        assert_eq!(
            create_file(root, "x\0y"),
            Err(CreateFileError::Validation(
                "file name must be a single name, not a path"
            ))
        );
    }

    #[test]
    fn create_file_conflicts_on_an_existing_file_or_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("taken.txt"), "keep me").unwrap();
        fs::create_dir_all(dir.path().join("adir")).unwrap();

        assert_eq!(
            create_file(root, "taken.txt"),
            Err(CreateFileError::Conflict)
        );
        assert_eq!(create_file(root, "adir"), Err(CreateFileError::Conflict));
        // The existing file's content is untouched — a create is never a write.
        assert_eq!(
            fs::read_to_string(dir.path().join("taken.txt")).unwrap(),
            "keep me"
        );
    }

    // --- rename_path (mesa task 877) -----------------------------------------

    #[test]
    fn rename_path_renames_a_file_and_echoes_its_new_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/old.rs"), "fn main() {}\n").unwrap();

        let entry = rename_path(root, "src/old.rs", "new.rs").unwrap();
        assert_eq!(entry.name, "new.rs");
        assert_eq!(entry.path, "src/new.rs");
        assert!(!entry.is_dir);
        assert!(!dir.path().join("src/old.rs").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("src/new.rs")).unwrap(),
            "fn main() {}\n"
        );
    }

    #[test]
    fn rename_path_renames_a_root_level_entry_without_a_path_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("notes.md"), "hi").unwrap();

        let entry = rename_path(root, "notes.md", "  README.md  ").unwrap();
        // The name is trimmed, `create_file`'s rule.
        assert_eq!(entry.name, "README.md");
        assert_eq!(entry.path, "README.md");
        assert!(dir.path().join("README.md").exists());
    }

    #[test]
    fn rename_path_renames_a_directory_and_its_contents_survive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("old/nested")).unwrap();
        fs::write(dir.path().join("old/nested/deep.txt"), "still here").unwrap();

        let entry = rename_path(root, "old", "new").unwrap();
        assert_eq!(entry.name, "new");
        assert_eq!(entry.path, "new");
        assert!(entry.is_dir);
        // The whole subtree moved with the name, readable through the module's
        // own readers under the new path.
        assert_eq!(
            read_file(root, "new/nested/deep.txt").unwrap().content,
            "still here"
        );
        let (level, _) = tree_level(root, "new/nested").unwrap();
        assert_eq!(level.len(), 1);
        assert_eq!(level[0].path, "new/nested/deep.txt");
    }

    #[test]
    fn rename_path_conflicts_on_an_existing_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        fs::write(dir.path().join("b.txt"), "b").unwrap();
        fs::create_dir_all(dir.path().join("adir")).unwrap();

        assert_eq!(
            rename_path(root, "a.txt", "b.txt"),
            Err(RenamePathError::Conflict)
        );
        assert_eq!(
            rename_path(root, "a.txt", "adir"),
            Err(RenamePathError::Conflict)
        );
        // Renaming onto its own name is a conflict too, and nothing moved.
        assert_eq!(
            rename_path(root, "a.txt", "a.txt"),
            Err(RenamePathError::Conflict)
        );
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(dir.path().join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn rename_path_rejects_a_new_name_that_is_not_a_single_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();

        // `..`, a separator and an empty name are the three shapes that would
        // turn a rename into a move or an escape — the reason `new_name` is one
        // name and never a path.
        for bad in [
            "",
            "   ",
            ".",
            "..",
            "sub/a.txt",
            "../a.txt",
            "a\\b",
            "a\0b",
        ] {
            assert!(
                matches!(
                    rename_path(root, "a.txt", bad),
                    Err(RenamePathError::Validation(_))
                ),
                "expected validation error for {bad:?}"
            );
        }
        assert!(dir.path().join("a.txt").exists());
        assert!(!dir.path().join("sub/a.txt").exists());
    }

    #[test]
    fn rename_path_not_found_for_traversal_absolute_and_missing_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        let root = root.to_str().unwrap();

        for bad in [
            "../secret.txt",
            "../../secret.txt",
            "a/../../secret.txt",
            "nope.txt",
            "gone/x.txt",
        ] {
            assert_eq!(
                rename_path(root, bad, "owned.txt"),
                Err(RenamePathError::NotFound),
                "path {bad:?}"
            );
        }
        assert_eq!(
            fs::read_to_string(dir.path().join("secret.txt")).unwrap(),
            "top secret"
        );
    }

    #[test]
    fn rename_path_not_found_for_an_absolute_source_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, "top secret").unwrap();

        assert_eq!(
            rename_path(root.to_str().unwrap(), outside.to_str().unwrap(), "x.txt"),
            Err(RenamePathError::NotFound)
        );
        assert!(outside.exists());
    }

    #[test]
    fn rename_path_rejects_the_project_root_itself() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let root = root.to_str().unwrap();

        for bad in ["", "   ", "."] {
            assert!(
                matches!(
                    rename_path(root, bad, "renamed"),
                    Err(RenamePathError::Validation(_))
                ),
                "expected validation error for {bad:?}"
            );
        }
        assert!(fs::metadata(root).unwrap().is_dir());
    }

    // --- delete_path (mesa task 877) -----------------------------------------

    #[test]
    fn delete_path_removes_a_file_and_echoes_the_destroyed_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/gone.rs"), "bye").unwrap();

        let entry = delete_path(root, "src/gone.rs").unwrap();
        assert_eq!(entry.name, "gone.rs");
        assert_eq!(entry.path, "src/gone.rs");
        assert!(!entry.is_dir);
        assert!(!dir.path().join("src/gone.rs").exists());
        // Only the entry named went — its directory is untouched.
        assert!(dir.path().join("src").is_dir());
    }

    #[test]
    fn delete_path_removes_a_non_empty_directory_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("doomed/nested")).unwrap();
        fs::write(dir.path().join("doomed/a.txt"), "a").unwrap();
        fs::write(dir.path().join("doomed/nested/b.txt"), "b").unwrap();
        fs::write(dir.path().join("keep.txt"), "keep").unwrap();

        let entry = delete_path(root, "doomed").unwrap();
        assert_eq!(entry.name, "doomed");
        assert_eq!(entry.path, "doomed");
        assert!(entry.is_dir);
        assert!(!dir.path().join("doomed").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn delete_path_not_found_for_traversal_absolute_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, "top secret").unwrap();
        let root_str = root.to_str().unwrap();

        for bad in [
            "../secret.txt",
            "../../secret.txt",
            "a/../../secret.txt",
            "nope.txt",
            "gone/x.txt",
        ] {
            assert_eq!(
                delete_path(root_str, bad),
                Err(DeletePathError::NotFound),
                "path {bad:?}"
            );
        }
        assert_eq!(
            delete_path(root_str, outside.to_str().unwrap()),
            Err(DeletePathError::NotFound)
        );
        assert!(outside.exists());
    }

    #[test]
    fn delete_path_rejects_the_project_root_and_unusable_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(root.join("sub")).unwrap();
        let root_str = root.to_str().unwrap();

        for bad in ["", "   ", ".", "..", "sub/", "sub/.", "a\\b", "x\0y"] {
            assert!(
                matches!(
                    delete_path(root_str, bad),
                    Err(DeletePathError::Validation(_))
                ),
                "expected validation error for {bad:?}"
            );
        }
        // Neither the project folder nor its parent was touched.
        assert!(root.is_dir());
        assert!(root.join("sub").is_dir());
        assert!(dir.path().is_dir());
    }

    #[test]
    #[cfg(unix)]
    fn delete_path_unlinks_a_symlink_without_touching_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "top secret").unwrap();
        symlink(&target, root.join("link.txt")).unwrap();
        // `safe_path` refuses this path outright (it canonicalizes, and the
        // target is outside the root) — which is exactly why `delete_path`
        // resolves the PARENT instead: the row the tree lists has to be
        // deletable as the name it is.
        assert_eq!(safe_path(root.to_str().unwrap(), "link.txt"), None);

        let entry = delete_path(root.to_str().unwrap(), "link.txt").unwrap();
        assert_eq!(entry.name, "link.txt");
        // `tree_level`'s classification: a symlink is a file leaf, whatever it
        // points at.
        assert!(!entry.is_dir);
        assert!(root.join("link.txt").symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "top secret");
    }

    #[test]
    #[cfg(unix)]
    fn rename_path_renames_a_symlink_as_a_name_not_as_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "top secret").unwrap();
        symlink(&target, root.join("link.txt")).unwrap();

        let entry = rename_path(root.to_str().unwrap(), "link.txt", "renamed.txt").unwrap();
        assert_eq!(entry.name, "renamed.txt");
        assert!(!entry.is_dir);
        assert!(
            root.join("renamed.txt")
                .symlink_metadata()
                .unwrap()
                .is_symlink()
        );
        // The link still points at the untouched original.
        assert_eq!(fs::read_to_string(&target).unwrap(), "top secret");
        assert!(outside.join("secret.txt").exists());
    }

    // --- move_path + create_tree_dir (naru task 2745) --------------------

    /// `proj/{a.txt, src/{lib.rs, deep/x.txt}, docs/}` under a temp dir, with
    /// room beside `proj` for things that must stay outside it.
    fn seed_move_tree() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("src/lib.rs"), "lib").unwrap();
        fs::write(root.join("src/deep/x.txt"), "x").unwrap();
        (dir, root)
    }

    #[test]
    fn move_path_moves_a_file_between_directories_and_echoes_its_new_entry() {
        let (_dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();

        let entry = move_path(r, "a.txt", "src/deep").unwrap();
        assert_eq!(entry.name, "a.txt");
        assert_eq!(entry.path, "src/deep/a.txt");
        assert!(!entry.is_dir);
        assert!(!root.join("a.txt").exists());
        assert_eq!(
            fs::read_to_string(root.join("src/deep/a.txt")).unwrap(),
            "a"
        );

        // Back out to the root, spelled both ways.
        let entry = move_path(r, "src/deep/a.txt", "").unwrap();
        assert_eq!(entry.path, "a.txt");
        let entry = move_path(r, "src/lib.rs", ".").unwrap();
        assert_eq!(entry.path, "lib.rs");
        assert!(root.join("lib.rs").exists());
    }

    #[test]
    fn move_path_moves_a_directory_with_its_contents() {
        let (_dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();

        let entry = move_path(r, "src", "docs").unwrap();
        assert_eq!(entry.path, "docs/src");
        assert!(entry.is_dir);
        assert!(!root.join("src").exists());
        assert_eq!(read_file(r, "docs/src/deep/x.txt").unwrap().content, "x");
    }

    #[test]
    fn move_path_rejects_the_root_a_noop_and_a_folder_into_itself() {
        let (_dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();

        for source in ["", "  ", "."] {
            assert!(matches!(
                move_path(r, source, "docs"),
                Err(MovePathError::Validation(_))
            ));
        }
        // Already there.
        assert_eq!(
            move_path(r, "a.txt", ""),
            Err(MovePathError::Validation("already in that folder"))
        );
        assert_eq!(
            move_path(r, "src/lib.rs", "src"),
            Err(MovePathError::Validation("already in that folder"))
        );
        // Onto itself, and into its own subtree.
        for dest in ["src", "src/deep"] {
            assert_eq!(
                move_path(r, "src", dest),
                Err(MovePathError::Validation(
                    "cannot move a folder into itself"
                ))
            );
        }
        // A sibling that merely shares the prefix is a different folder.
        fs::create_dir_all(root.join("src2")).unwrap();
        assert_eq!(move_path(r, "src", "src2").unwrap().path, "src2/src");
        assert!(root.join("src2/src/deep/x.txt").exists());
    }

    #[test]
    fn move_path_conflicts_on_a_taken_name_and_never_overwrites_or_merges() {
        let (_dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();
        fs::write(root.join("docs/a.txt"), "the other a").unwrap();
        fs::create_dir_all(root.join("docs/src")).unwrap();
        fs::write(root.join("docs/src/keep.txt"), "keep").unwrap();

        assert_eq!(move_path(r, "a.txt", "docs"), Err(MovePathError::Conflict));
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "a");
        assert_eq!(
            fs::read_to_string(root.join("docs/a.txt")).unwrap(),
            "the other a"
        );
        // A directory landing on a directory is a conflict, not a merge.
        assert_eq!(move_path(r, "src", "docs"), Err(MovePathError::Conflict));
        assert!(root.join("src/lib.rs").exists());
        assert!(root.join("docs/src/keep.txt").exists());
        assert!(!root.join("docs/src/lib.rs").exists());
    }

    /// On a filesystem that folds case or unicode normalisation (macOS), a
    /// differently spelled name in the destination is the same name: the move
    /// conflicts instead of clobbering it. Where the filesystem keeps them
    /// apart they are two files and the move is an ordinary one.
    #[test]
    fn move_path_conflicts_on_a_name_the_filesystem_treats_as_taken() {
        // (source name, name already in the destination)
        for (name, taken) in [
            ("Readme.md", "README.md"),
            ("caf\u{e9}.txt", "cafe\u{301}.txt"),
        ] {
            let (_dir, root) = seed_move_tree();
            let r = root.to_str().unwrap();
            fs::write(root.join("docs").join(taken), "original").unwrap();
            let folds = root.join("docs").join(name).symlink_metadata().is_ok();
            fs::write(root.join(name), "incoming").unwrap();

            let moved = move_path(r, name, "docs");
            if folds {
                assert_eq!(moved, Err(MovePathError::Conflict));
                assert_eq!(fs::read_to_string(root.join(name)).unwrap(), "incoming");
            } else {
                assert_eq!(moved.unwrap().path, format!("docs/{name}"));
            }
            assert_eq!(
                fs::read_to_string(root.join("docs").join(taken)).unwrap(),
                "original"
            );
        }
    }

    #[test]
    fn move_path_not_found_for_traversal_absolute_and_missing_on_either_end() {
        let (dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        let outside_abs = outside.to_str().unwrap().to_string();

        // Source.
        for source in [
            "../outside/secret.txt".to_string(),
            "src/../../outside/secret.txt".to_string(),
            format!("{outside_abs}/secret.txt"),
            "missing.txt".to_string(),
            "nope/a.txt".to_string(),
        ] {
            assert_eq!(
                move_path(r, &source, "docs"),
                Err(MovePathError::NotFound),
                "source {source:?}"
            );
        }
        // Destination: outside, a spelling the tree would never hand out, a
        // file, and a folder that is not there.
        for dest in [
            "../outside",
            "..",
            outside_abs.as_str(),
            "src/..",
            "src/../docs",
            "./docs",
            "docs/",
            "/docs",
            "src//deep",
            "a.txt",
            "missing",
        ] {
            assert_eq!(
                move_path(r, "src/lib.rs", dest),
                Err(MovePathError::NotFound),
                "dest {dest:?}"
            );
        }
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "top secret"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        assert!(root.join("src/lib.rs").exists());
    }

    #[test]
    fn move_path_not_found_for_excluded_directories_on_either_end() {
        let (_dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "js").unwrap();
        fs::create_dir_all(root.join("src/target")).unwrap();

        for dest in ["node_modules", "node_modules/pkg", "src/target"] {
            assert_eq!(
                move_path(r, "a.txt", dest),
                Err(MovePathError::NotFound),
                "dest {dest:?}"
            );
        }
        for source in [
            "node_modules",
            "node_modules/pkg",
            "node_modules/pkg/index.js",
        ] {
            assert_eq!(
                move_path(r, source, "docs"),
                Err(MovePathError::NotFound),
                "source {source:?}"
            );
        }
        assert!(root.join("a.txt").exists());
        assert!(root.join("node_modules/pkg/index.js").exists());
    }

    #[test]
    #[cfg(unix)]
    fn move_path_moves_a_symlink_as_a_name_and_refuses_symlinked_directories() {
        let (dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        symlink(root.join("docs"), root.join("inner")).unwrap();

        // A symlink is a row, and is moved as the link it is.
        let entry = move_path(r, "link.txt", "docs").unwrap();
        assert_eq!(entry.path, "docs/link.txt");
        assert!(!entry.is_dir);
        assert!(
            root.join("docs/link.txt")
                .symlink_metadata()
                .unwrap()
                .is_symlink()
        );
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "top secret"
        );

        // A symlinked directory is a file leaf in the tree, never a
        // destination — whether it points outside the root or inside it —
        // and never a place to move something out of.
        for dest in ["escape", "inner"] {
            assert_eq!(
                move_path(r, "a.txt", dest),
                Err(MovePathError::NotFound),
                "dest {dest:?}"
            );
        }
        assert_eq!(
            move_path(r, "escape/secret.txt", "docs"),
            Err(MovePathError::NotFound)
        );
        assert_eq!(
            move_path(r, "inner/link.txt", "src"),
            Err(MovePathError::NotFound)
        );
        assert!(root.join("a.txt").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);

        // The link to a directory itself moves like any other leaf, even into
        // the directory it points at.
        let entry = move_path(r, "inner", "docs").unwrap();
        assert_eq!(entry.path, "docs/inner");
        assert!(!entry.is_dir);
    }

    #[test]
    fn create_tree_dir_makes_one_empty_directory_and_echoes_its_entry() {
        let (_dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();

        let entry = create_tree_dir(r, "  assets  ").unwrap();
        assert_eq!(entry.name, "assets");
        assert_eq!(entry.path, "assets");
        assert!(entry.is_dir);
        assert!(root.join("assets").is_dir());

        let entry = create_tree_dir(r, "src/deep/new").unwrap();
        assert_eq!(entry.path, "src/deep/new");
        assert!(root.join("src/deep/new").is_dir());
        assert_eq!(tree_level(r, "src/deep/new").unwrap().0.len(), 0);
    }

    #[test]
    fn create_tree_dir_rejects_bad_names_taken_names_and_bad_parents() {
        let (dir, root) = seed_move_tree();
        let r = root.to_str().unwrap();

        for rel in ["", "  ", ".", "..", "src/", "src/..", "a\\b", "nul\0"] {
            assert!(
                matches!(create_tree_dir(r, rel), Err(CreateFileError::Validation(_))),
                "rel {rel:?}"
            );
        }
        for rel in ["node_modules", "src/target", ".git"] {
            assert_eq!(
                create_tree_dir(r, rel),
                Err(CreateFileError::Validation(
                    "the file tree hides folders with that name"
                )),
                "rel {rel:?}"
            );
        }
        for rel in ["src", "a.txt", "src/lib.rs"] {
            assert_eq!(create_tree_dir(r, rel), Err(CreateFileError::Conflict));
        }
        // One level only, inside the root only, and only inside a directory.
        let outside = format!("{}/outside", dir.path().to_str().unwrap());
        for rel in ["missing/new", "../new", "a.txt/new", outside.as_str()] {
            assert_eq!(
                create_tree_dir(r, rel),
                Err(CreateFileError::NotFound),
                "rel {rel:?}"
            );
        }
        assert!(!dir.path().join("new").exists());
        assert!(!dir.path().join("outside").exists());
    }

    // --- upload_file (naru task 2732) -----------------------------------

    #[test]
    fn upload_file_writes_binary_bytes_verbatim_and_echoes_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        let root = dir.path().to_str().unwrap();
        let bytes: Vec<u8> = (0..=255u8).chain([0, 255, 0]).collect();

        let entry = upload_file(root, "sub", "blob.bin", &bytes, false).unwrap();
        assert_eq!(entry.name, "blob.bin");
        assert_eq!(entry.path, "sub/blob.bin");
        assert!(!entry.is_dir);
        assert_eq!(fs::read(dir.path().join("sub/blob.bin")).unwrap(), bytes);

        // The root is "" or "."; a zero-byte file is a file.
        let entry = upload_file(root, "", "a.txt", b"", false).unwrap();
        assert_eq!(entry.path, "a.txt");
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"");
        let entry = upload_file(root, ".", "b.txt", b"b", false).unwrap();
        assert_eq!(entry.path, "b.txt");
    }

    #[test]
    fn upload_file_not_found_for_traversal_absolute_missing_and_file_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("file.txt"), "x").unwrap();
        let root_str = root.to_str().unwrap();

        for bad in [
            "..",
            "../outside",
            outside.to_str().unwrap(),
            "missing",
            "file.txt",
        ] {
            assert_eq!(
                upload_file(root_str, bad, "x.txt", b"x", true),
                Err(UploadFileError::NotFound),
                "{bad}"
            );
        }
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        assert!(!dir.path().join("x.txt").exists());
    }

    #[test]
    #[cfg(unix)]
    fn upload_file_not_found_through_a_directory_symlink_that_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("way-out")).unwrap();

        assert_eq!(
            upload_file(root.to_str().unwrap(), "way-out", "x.txt", b"x", true),
            Err(UploadFileError::NotFound)
        );
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn upload_file_rejects_names_that_are_not_a_single_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        for bad in ["", "  ", ".", "..", "a/b.txt", "../b.txt", "a\\b", "a\0b"] {
            assert!(
                matches!(
                    upload_file(root, "", bad, b"x", true),
                    Err(UploadFileError::Validation(_))
                ),
                "{bad:?}"
            );
        }
        assert!(fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn upload_file_enforces_the_cap_and_accepts_exactly_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let mut bytes = vec![7u8; MAX_UPLOAD_BYTES];
        upload_file(root, "", "at-cap.bin", &bytes, false).unwrap();
        assert_eq!(
            fs::metadata(dir.path().join("at-cap.bin")).unwrap().len(),
            MAX_UPLOAD_BYTES as u64
        );
        bytes.push(7);
        assert!(matches!(
            upload_file(root, "", "over.bin", &bytes, true),
            Err(UploadFileError::Validation(_))
        ));
        assert!(!dir.path().join("over.bin").exists());
    }

    #[test]
    fn upload_file_conflicts_on_a_taken_name_and_replaces_only_with_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("a.txt"), "old").unwrap();

        assert_eq!(
            upload_file(root, "", "a.txt", b"new", false),
            Err(UploadFileError::Conflict)
        );
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "old");

        upload_file(root, "", "a.txt", b"new", true).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "new");
        // Overwrite on a free name is a plain create, and no temporary file
        // is left behind by either.
        upload_file(root, "", "fresh.txt", b"f", true).unwrap();
        let mut names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "fresh.txt"]);
    }

    #[test]
    fn upload_file_never_replaces_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/keep.txt"), "keep").unwrap();
        let root = dir.path().to_str().unwrap();
        for overwrite in [false, true] {
            assert!(matches!(
                upload_file(root, "", "src", b"x", overwrite),
                Err(UploadFileError::Validation(_))
            ));
        }
        assert_eq!(
            fs::read_to_string(dir.path().join("src/keep.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    #[cfg(unix)]
    fn upload_file_overwrite_keeps_the_replaced_files_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("run.sh");
        fs::write(&script, "old").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        upload_file(dir.path().to_str().unwrap(), "", "run.sh", b"new", true).unwrap();
        assert_eq!(fs::read_to_string(&script).unwrap(), "new");
        assert_eq!(
            fs::metadata(&script).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    /// The containment case an in-place overwrite would lose: a symlink in the
    /// tree pointing outside it. It conflicts as a name taken, and overwriting
    /// replaces the LINK — the file at the other end is never written through.
    #[test]
    #[cfg(unix)]
    fn upload_file_replaces_a_symlink_as_a_name_and_never_writes_through_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "top secret").unwrap();
        symlink(&target, root.join("link.txt")).unwrap();
        symlink(outside.join("nowhere"), root.join("dangling.txt")).unwrap();
        let root_str = root.to_str().unwrap();

        for name in ["link.txt", "dangling.txt"] {
            assert_eq!(
                upload_file(root_str, "", name, b"uploaded", false),
                Err(UploadFileError::Conflict)
            );
        }
        assert_eq!(fs::read_to_string(&target).unwrap(), "top secret");

        for name in ["link.txt", "dangling.txt"] {
            upload_file(root_str, "", name, b"uploaded", true).unwrap();
            assert!(root.join(name).symlink_metadata().unwrap().is_file());
            assert_eq!(fs::read_to_string(root.join(name)).unwrap(), "uploaded");
        }
        assert_eq!(fs::read_to_string(&target).unwrap(), "top secret");
        assert!(!outside.join("nowhere").exists());
    }

    // --- search_files (mesa task 813) ----------------------------------

    fn seed_search_tree(dir: &std::path::Path) {
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(
            dir.join("README.md"),
            "the needle is here\nand nowhere else\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/main.rs"),
            "fn main() {\n    let needle = 1; // needle again\n    let Needle = 2;\n}\n",
        )
        .unwrap();
        fs::write(dir.join("node_modules/dep.js"), "needle needle needle\n").unwrap();
        fs::write(dir.join("logo.png"), "needle").unwrap();
        fs::write(dir.join("blob.dat"), b"nee\0dle needle").unwrap();
    }

    #[test]
    fn search_files_groups_hits_by_file_and_skips_excluded_and_binary() {
        let dir = tempfile::tempdir().unwrap();
        seed_search_tree(dir.path());
        let root = dir.path().to_str().unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();

        // Files before directories is `tree_level`'s order: README.md then
        // src/main.rs. `node_modules` (excluded), the `.png` (binary
        // extension) and the NUL-carrying `.dat` are all absent.
        let paths: Vec<&str> = res.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["README.md", "src/main.rs"]);
        assert!(!res.truncated);
        // Case-insensitive by default, so `Needle` on line 3 counts, and the
        // two on line 2 are two rows.
        assert_eq!(res.total_matches, 4);
        assert_eq!(res.files[0].matches[0].line, 1);
        assert_eq!(res.files[0].language.as_deref(), Some("markdown"));
        let rs = &res.files[1];
        assert_eq!(rs.language.as_deref(), Some("rust"));
        assert_eq!(
            rs.matches.iter().map(|m| m.line).collect::<Vec<_>>(),
            vec![2, 2, 3]
        );
        // Leading indentation is dropped from the snippet, and the whole
        // (short) line survives otherwise.
        assert_eq!(rs.matches[0].text, "let needle = 1; // needle again");
    }

    #[test]
    fn search_files_honours_case_and_whole_word() {
        let dir = tempfile::tempdir().unwrap();
        seed_search_tree(dir.path());
        let root = dir.path().to_str().unwrap();

        let sensitive = search_files(
            root,
            "Needle",
            SearchOptions {
                case_sensitive: true,
                whole_word: false,
            },
        )
        .unwrap();
        assert_eq!(sensitive.total_matches, 1);
        assert_eq!(sensitive.files[0].path, "src/main.rs");
        assert_eq!(sensitive.files[0].matches[0].line, 3);

        fs::write(dir.path().join("words.txt"), "needle needles needle_x\n").unwrap();
        let whole = search_files(
            root,
            "needle",
            SearchOptions {
                case_sensitive: false,
                whole_word: true,
            },
        )
        .unwrap();
        let words = whole
            .files
            .iter()
            .find(|f| f.path == "words.txt")
            .expect("words.txt has a whole-word hit");
        assert_eq!(words.matches.len(), 1);
    }

    #[test]
    fn search_files_caps_matches_per_file_and_flags_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let body = "needle\n".repeat(MAX_SEARCH_MATCHES_PER_FILE + 10);
        fs::write(dir.path().join("many.txt"), body).unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].matches.len(), MAX_SEARCH_MATCHES_PER_FILE);
        assert!(res.files[0].truncated);
        assert_eq!(res.total_matches as usize, MAX_SEARCH_MATCHES_PER_FILE);
    }

    /// The search keeps its own, smaller read cap (naru task 2803 raised only
    /// the editor's): a hit past the first 256 KiB of a file is not found.
    #[test]
    fn search_files_still_reads_only_the_view_cap_of_each_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let body = format!(
            "needle early\n{}\nneedle late\n",
            "x".repeat(FILE_CONTENT_CAP)
        );
        fs::write(dir.path().join("big.txt"), body).unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();
        assert_eq!(res.total_matches, 1);
        assert_eq!(res.files[0].matches[0].line, 1);
    }

    #[test]
    fn search_files_windows_a_long_line_around_the_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let line = format!("{}needle{}", "x".repeat(500), "y".repeat(500));
        fs::write(dir.path().join("min.js"), line).unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();
        let text = &res.files[0].matches[0].text;
        // Cut on both sides, marked on both sides, and bounded — never the
        // whole 1,006-character line.
        assert!(text.starts_with('…'), "{text}");
        assert!(text.ends_with('…'), "{text}");
        assert!(text.contains("needle"), "{text}");
        assert_eq!(text.chars().count(), SNIPPET_MAX + 2);
    }

    #[test]
    fn search_files_rejects_nothing_and_finds_nothing_for_an_empty_query() {
        let dir = tempfile::tempdir().unwrap();
        seed_search_tree(dir.path());
        let root = dir.path().to_str().unwrap();

        let res = search_files(root, "", SearchOptions::default()).unwrap();
        assert!(res.files.is_empty());
        assert_eq!(res.total_matches, 0);
        assert!(!res.truncated);

        let long = "n".repeat(MAX_SEARCH_QUERY + 1);
        assert!(
            search_files(root, &long, SearchOptions::default())
                .unwrap()
                .files
                .is_empty()
        );
    }

    #[test]
    fn search_files_is_none_for_a_dead_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        assert!(search_files(missing.to_str().unwrap(), "x", SearchOptions::default()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn search_files_never_follows_a_symlink_out_of_the_root() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "needle outside\n").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("inside.txt"), "needle inside\n").unwrap();
        symlink(outside.path(), dir.path().join("link")).unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();
        let paths: Vec<&str> = res.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["inside.txt"]);
    }

    // --- list_file_names (naru task 2744) ------------------------------

    #[test]
    fn list_file_names_walks_the_search_tree_and_skips_excluded_dirs() {
        let dir = tempfile::tempdir().unwrap();
        seed_search_tree(dir.path());
        fs::create_dir_all(dir.path().join("target/release")).unwrap();
        fs::write(dir.path().join("target/release/naru"), "bin").unwrap();
        fs::create_dir_all(dir.path().join("src/deep/er")).unwrap();
        fs::write(dir.path().join("src/deep/er/x.ts"), "").unwrap();
        let res = list_file_names(dir.path().to_str().unwrap()).unwrap();
        // Walk order: a level's files before its directories, alphabetical;
        // binary files are names like any other.
        assert_eq!(
            res.paths,
            vec![
                "README.md",
                "blob.dat",
                "logo.png",
                "src/main.rs",
                "src/deep/er/x.ts"
            ]
        );
        assert!(!res.truncated);
    }

    #[test]
    fn list_file_names_caps_and_flags_truncated() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(dir.path().join(format!("f{i}.txt")), "").unwrap();
        }
        let root = dir.path().to_str().unwrap();
        let capped = list_file_names_capped(root, 3).unwrap();
        assert_eq!(capped.paths, vec!["f0.txt", "f1.txt", "f2.txt"]);
        assert!(capped.truncated);
        // Exactly at the cap is not truncated: nothing was left out.
        let exact = list_file_names_capped(root, 5).unwrap();
        assert_eq!(exact.paths.len(), 5);
        assert!(!exact.truncated);
    }

    #[test]
    fn list_file_names_is_none_for_a_dead_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        assert!(list_file_names(missing.to_str().unwrap()).is_none());
        fs::write(dir.path().join("file"), "").unwrap();
        assert!(list_file_names(dir.path().join("file").to_str().unwrap()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn list_file_names_never_follows_a_symlink_out_of_the_root() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "").unwrap();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("inside.txt"), "").unwrap();
        symlink(outside.path(), dir.path().join("link")).unwrap();
        symlink(
            outside.path().join("secret.txt"),
            dir.path().join("alias.txt"),
        )
        .unwrap();
        let res = list_file_names(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(res.paths, vec!["inside.txt"]);
    }
}
