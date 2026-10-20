//! Colour themes (naru task 1840): a theme is nine key colours, every other
//! CSS variable is derived here. Derivation and the WCAG contrast check live
//! only in this file; the frontend never re-derives. Pure: no store, no I/O.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use super::config::{self, SaveError};
use super::store::{CustomThemeRow, CustomThemeSlotsPatch, Error, Result, Store};
use super::types::{ConfigAppearance, ContrastWarning, Theme, ThemePreview, ThemeSlots};

/// A built-in theme: id, label and its nine slots.
pub struct BuiltinTheme {
    pub id: &'static str,
    pub label: &'static str,
    pub slots: [&'static str; 9],
}

/// Slot order: bg, panel, text, muted, accent, accent2, good, warn, bad.
pub const SLOT_NAMES: [&str; 9] = [
    "bg", "panel", "text", "muted", "accent", "accent2", "good", "warn", "bad",
];

pub const BUILTIN_THEMES: [BuiltinTheme; 4] = [
    BuiltinTheme {
        id: "dark",
        label: "Dark",
        slots: [
            "#060a10", "#0b1119", "#b8dde8", "#5d7f8f", "#00e5ff", "#b06bff", "#2bff9c", "#ffb444",
            "#ff3b5c",
        ],
    },
    BuiltinTheme {
        id: "light",
        label: "Light",
        slots: [
            "#f4f7fa", "#ffffff", "#162634", "#546a7a", "#00668a", "#6234c8", "#0e7440", "#965600",
            "#be1c38",
        ],
    },
    BuiltinTheme {
        id: "contrast",
        label: "High contrast",
        slots: [
            "#000000", "#000000", "#ffffff", "#becdd7", "#40f0ff", "#c896ff", "#50ffaa", "#ffc85a",
            "#ff6478",
        ],
    },
    BuiltinTheme {
        id: "crimson",
        label: "Crimson",
        slots: [
            "#0f0608", "#190c0f", "#f2d6d8", "#b8848a", "#ff5466", "#e88caa", "#60e896", "#ffb85c",
            "#ff966e",
        ],
    },
];

type Rgb = [u8; 3];

/// Parse `#rgb` / `#rrggbb` (any case) into channels; `slot` names the error.
fn parse_rgb(slot: &str, value: &str) -> Result<Rgb> {
    let bad = || Error::Validation(format!("{slot}: {value:?} is not a #rgb or #rrggbb colour"));
    let hex = value.strip_prefix('#').ok_or_else(bad)?;
    if !hex.is_ascii() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad());
    }
    let ch = |s: &str| u8::from_str_radix(s, 16).map_err(|_| bad());
    match hex.len() {
        3 => {
            let d = |i: usize| ch(&hex[i..i + 1].repeat(2));
            Ok([d(0)?, d(1)?, d(2)?])
        }
        6 => Ok([ch(&hex[0..2])?, ch(&hex[2..4])?, ch(&hex[4..6])?]),
        _ => Err(bad()),
    }
}

/// Normalise a colour to lowercase `#rrggbb`.
pub fn normalize_color(slot: &str, value: &str) -> Result<String> {
    Ok(hex(parse_rgb(slot, value)?))
}

fn hex(c: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn triplet(c: Rgb) -> String {
    format!("{}, {}, {}", c[0], c[1], c[2])
}

fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let m = |i: usize| (f64::from(a[i]) * (1.0 - t) + f64::from(b[i]) * t).round() as u8;
    [m(0), m(1), m(2)]
}

fn luminance(c: Rgb) -> f64 {
    let lin = |v: u8| {
        let s = f64::from(v) / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

fn ratio(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// Parsed form of every slot.
struct Parsed {
    bg: Rgb,
    panel: Rgb,
    text: Rgb,
    muted: Rgb,
    accent: Rgb,
    accent2: Rgb,
    good: Rgb,
    warn: Rgb,
    bad: Rgb,
}

fn parse_slots(s: &ThemeSlots) -> Result<Parsed> {
    Ok(Parsed {
        bg: parse_rgb("bg", &s.bg)?,
        panel: parse_rgb("panel", &s.panel)?,
        text: parse_rgb("text", &s.text)?,
        muted: parse_rgb("muted", &s.muted)?,
        accent: parse_rgb("accent", &s.accent)?,
        accent2: parse_rgb("accent2", &s.accent2)?,
        good: parse_rgb("good", &s.good)?,
        warn: parse_rgb("warn", &s.warn)?,
        bad: parse_rgb("bad", &s.bad)?,
    })
}

impl ThemeSlots {
    /// Validate every slot and return them normalised to `#rrggbb`.
    pub fn normalized(&self) -> Result<ThemeSlots> {
        let n = |slot: &str, v: &String| normalize_color(slot, v);
        Ok(ThemeSlots {
            bg: n("bg", &self.bg)?,
            panel: n("panel", &self.panel)?,
            text: n("text", &self.text)?,
            muted: n("muted", &self.muted)?,
            accent: n("accent", &self.accent)?,
            accent2: n("accent2", &self.accent2)?,
            good: n("good", &self.good)?,
            warn: n("warn", &self.warn)?,
            bad: n("bad", &self.bad)?,
        })
    }
}

fn slots_of(v: &[&str; 9]) -> ThemeSlots {
    let s = |i: usize| v[i].to_string();
    ThemeSlots {
        bg: s(0),
        panel: s(1),
        text: s(2),
        muted: s(3),
        accent: s(4),
        accent2: s(5),
        good: s(6),
        warn: s(7),
        bad: s(8),
    }
}

/// `"light"` iff the background's relative luminance is at least 0.5.
pub fn scheme(slots: &ThemeSlots) -> Result<&'static str> {
    let bg = parse_rgb("bg", &slots.bg)?;
    Ok(if luminance(bg) >= 0.5 {
        "light"
    } else {
        "dark"
    })
}

/// Every CSS variable a theme sets, derived from its nine slots.
pub fn derive(slots: &ThemeSlots) -> Result<BTreeMap<String, String>> {
    let p = parse_slots(slots)?;
    let dark = luminance(p.bg) < 0.5;
    let white: Rgb = [255, 255, 255];
    let black: Rgb = [0, 0, 0];
    let mut v = BTreeMap::new();
    let mut put = |k: &str, val: String| {
        v.insert(k.to_string(), val);
    };
    put("color-scheme", if dark { "dark" } else { "light" }.into());
    put("--bg-rgb", triplet(p.bg));
    put("--text-rgb", triplet(p.text));
    put("--muted-rgb", triplet(p.muted));
    put("--cyan-rgb", triplet(p.accent));
    put("--violet-rgb", triplet(p.accent2));
    put("--green-rgb", triplet(p.good));
    put("--amber-rgb", triplet(p.warn));
    put("--red-rgb", triplet(p.bad));
    let magenta = mix(p.accent2, p.bad, 0.5);
    put("--magenta-rgb", triplet(magenta));
    put("--violet-deep-rgb", triplet(mix(p.accent2, black, 0.25)));
    put("--edge-rgb", triplet(mix(p.accent, p.bg, 0.45)));
    put("--shadow-rgb", triplet(if dark { black } else { p.text }));
    put("--white-rgb", triplet(if dark { white } else { p.text }));
    put("--panel", hex(p.panel));
    put("--panel-raised", hex(mix(p.panel, p.text, 0.05)));
    put(
        "--text-h",
        hex(mix(p.text, if dark { white } else { black }, 0.5)),
    );
    put(
        "--surface-field",
        if dark {
            "rgba(var(--bg-rgb), 0.85)".to_string()
        } else {
            format!("rgba({}, 0.92)", triplet(p.panel))
        },
    );
    put(
        "--wf-trigger",
        hex(mix(p.panel, mix(p.accent, p.accent2, 0.5), 0.25)),
    );
    put(
        "--wf-schedule",
        hex(mix(p.panel, mix(p.bad, p.accent, 0.5), 0.25)),
    );
    put("--wf-prompt", hex(mix(p.panel, p.accent2, 0.25)));
    put(
        "--wf-agent",
        hex(mix(p.panel, mix(p.good, p.accent, 0.5), 0.22)),
    );
    put("--wf-comment", hex(mix(p.panel, p.muted, 0.2)));
    put("--wf-cli", hex(mix(p.panel, p.accent, 0.22)));
    put("--wf-script", hex(mix(p.panel, p.warn, 0.2)));
    put("--wf-branch", hex(mix(p.panel, p.bad, 0.22)));
    put("--wf-decide", hex(mix(p.panel, magenta, 0.22)));
    put(
        "--wf-switch",
        hex(mix(p.panel, mix(p.good, p.warn, 0.5), 0.22)),
    );
    put(
        "--wf-task",
        hex(mix(p.panel, mix(p.good, p.accent2, 0.5), 0.24)),
    );
    put(
        "--wf-http",
        hex(mix(p.panel, mix(p.good, p.accent, 0.5), 0.24)),
    );
    put("--wf-flow", hex(mix(p.panel, p.warn, 0.28)));
    put("--wf-output", hex(mix(p.panel, p.good, 0.18)));
    put("--wf-run", hex(p.accent2));
    let near_black: Rgb = [0x0a, 0x0a, 0x0a];
    let on = |bg: Rgb| {
        if ratio(white, bg) >= ratio(near_black, bg) {
            "#ffffff"
        } else {
            "#0a0a0a"
        }
    };
    put("--on-accent", on(p.accent).into());
    put("--on-accent-alt", on(p.accent2).into());
    put(
        "--magenta-soft",
        hex(if dark {
            mix(magenta, white, 0.5)
        } else {
            mix(magenta, black, 0.1)
        }),
    );
    let err = mix(p.bad, p.warn, 0.5);
    put(
        "--stderr-text",
        hex(if dark {
            mix(err, white, 0.3)
        } else {
            mix(err, black, 0.1)
        }),
    );
    if !dark {
        for k in [
            "--text-glow",
            "--text-glow-wide",
            "--text-glow-dim",
            "--text-glow-red",
            "--text-glow-magenta",
        ] {
            put(k, "none".into());
        }
    }
    Ok(v)
}

/// WCAG 2.x contrast of the text and muted slots against bg and panel; only
/// the pairs under 4.5:1 are listed. Advisory: nothing is refused.
pub fn contrast_warnings(slots: &ThemeSlots) -> Result<Vec<ContrastWarning>> {
    let p = parse_slots(slots)?;
    let pairs = [
        ("text/bg", p.text, p.bg),
        ("text/panel", p.text, p.panel),
        ("muted/bg", p.muted, p.bg),
        ("muted/panel", p.muted, p.panel),
    ];
    Ok(pairs
        .into_iter()
        .filter_map(|(pair, a, b)| {
            let r = (ratio(a, b) * 100.0).round() / 100.0;
            (r < 4.5).then(|| ContrastWarning {
                pair: pair.to_string(),
                ratio: r,
                min: 4.5,
            })
        })
        .collect())
}

/// Scheme, variables and warnings for a set of slots, nothing stored.
pub fn preview(slots: &ThemeSlots) -> Result<ThemePreview> {
    Ok(ThemePreview {
        scheme: scheme(slots)?.to_string(),
        vars: derive(slots)?,
        warnings: contrast_warnings(slots)?,
    })
}

impl Theme {
    /// Assemble a theme from slots, deriving `scheme`, `vars` and `warnings`.
    pub fn from_slots(
        id: &str,
        name: &str,
        builtin: bool,
        slots: &ThemeSlots,
        created_at: Option<String>,
        updated_at: Option<String>,
    ) -> Result<Theme> {
        let slots = slots.normalized()?;
        let ThemePreview {
            scheme,
            vars,
            warnings,
        } = preview(&slots)?;
        Ok(Theme {
            id: id.to_string(),
            name: name.to_string(),
            builtin,
            scheme,
            slots,
            vars,
            warnings,
            created_at,
            updated_at,
        })
    }

    /// One of the four built-ins by id (`dark`, `light`, `contrast`, `crimson`).
    pub fn builtin(id: &str) -> Option<Theme> {
        let b = BUILTIN_THEMES.iter().find(|b| b.id == id)?;
        Theme::from_slots(b.id, b.label, true, &slots_of(&b.slots), None, None).ok()
    }
}

// ---------------------------------------------------------------------------
// Service (naru task 1842): themes by id or name over the store and config
// ---------------------------------------------------------------------------

fn custom_id(arg: &str) -> Option<i64> {
    let d = arg.strip_prefix("custom-")?;
    if d.is_empty() || !d.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    d.parse().ok()
}

fn custom_theme(row: CustomThemeRow) -> Result<Theme> {
    Theme::from_slots(
        &format!("custom-{}", row.id),
        &row.name,
        false,
        &row.slots,
        Some(row.created_at),
        Some(row.updated_at),
    )
}

fn not_found(arg: &str) -> Error {
    Error::NotFound(format!(
        "no theme {arg:?}; run `naru theme list` to see the ids and names"
    ))
}

fn read_only(id: &str) -> Error {
    Error::Validation(format!(
        "{id} is a built-in theme and read-only; copy it with `naru theme create --from {id}`"
    ))
}

fn save_err(e: SaveError) -> Error {
    match e {
        SaveError::Validation(m) => Error::Validation(m),
        SaveError::Unavailable(m) => Error::Unavailable(m),
    }
}

/// Every theme: built-ins in table order, then custom ones by id.
pub fn list(store: &Store) -> Result<Vec<Theme>> {
    let mut out: Vec<Theme> = BUILTIN_THEMES
        .iter()
        .filter_map(|b| Theme::builtin(b.id))
        .collect();
    for row in store.list_custom_themes()? {
        out.push(custom_theme(row)?);
    }
    Ok(out)
}

/// Resolve a built-in id, a `custom-<n>` id, else a name (case-insensitive
/// exact, built-in labels included).
pub fn show(store: &Store, arg: &str) -> Result<Theme> {
    let arg = arg.trim();
    if let Some(t) = Theme::builtin(arg) {
        return Ok(t);
    }
    if let Some(n) = custom_id(arg) {
        return match store.get_custom_theme(n) {
            Ok(row) => custom_theme(row),
            Err(Error::NotFound(_)) => Err(not_found(arg)),
            Err(e) => Err(e),
        };
    }
    let lower = arg.to_lowercase();
    if let Some(b) = BUILTIN_THEMES
        .iter()
        .find(|b| b.label.to_lowercase() == lower)
    {
        return Theme::builtin(b.id).ok_or_else(|| not_found(arg));
    }
    match store.find_custom_theme_by_name(arg)? {
        Some(row) => custom_theme(row),
        None => Err(not_found(arg)),
    }
}

/// Copy a theme's slots into a new custom theme. The default name is
/// `<source name> copy`, then `copy 2`, `copy 3`...
pub fn create_from(store: &mut Store, from_arg: &str, name: Option<&str>) -> Result<Theme> {
    let src = show(store, from_arg)?;
    let name = match name {
        Some(n) => n.to_string(),
        None => {
            let base = format!("{} copy", src.name);
            let mut candidate = base.clone();
            let mut n = 2;
            while store.find_custom_theme_by_name(&candidate)?.is_some() {
                candidate = format!("{base} {n}");
                n += 1;
            }
            candidate
        }
    };
    custom_theme(store.create_custom_theme(&name, &src.slots)?)
}

/// The custom theme `arg` names, or the read-only error for a built-in.
fn editable(store: &Store, arg: &str) -> Result<(i64, Theme)> {
    let t = show(store, arg)?;
    if t.builtin {
        return Err(read_only(&t.id));
    }
    let id = custom_id(&t.id).ok_or_else(|| not_found(arg))?;
    Ok((id, t))
}

pub fn set_slot(store: &mut Store, arg: &str, slot: &str, colour: &str) -> Result<Theme> {
    let (id, _) = editable(store, arg)?;
    let c = Some(colour.to_string());
    let mut patch = CustomThemeSlotsPatch::default();
    match slot {
        "bg" => patch.bg = c,
        "panel" => patch.panel = c,
        "text" => patch.text = c,
        "muted" => patch.muted = c,
        "accent" => patch.accent = c,
        "accent2" => patch.accent2 = c,
        "good" => patch.good = c,
        "warn" => patch.warn = c,
        "bad" => patch.bad = c,
        _ => {
            return Err(Error::Validation(format!(
                "unknown slot {slot:?}; the slots are {}",
                SLOT_NAMES.join(", ")
            )));
        }
    }
    custom_theme(store.update_custom_theme(id, None, &patch)?)
}

/// Rename and/or recolour a custom theme as one update: the name and every
/// slot are validated before anything is written.
pub fn update(
    store: &mut Store,
    arg: &str,
    name: Option<&str>,
    patch: &CustomThemeSlotsPatch,
) -> Result<Theme> {
    let (id, _) = editable(store, arg)?;
    custom_theme(store.update_custom_theme(id, name, patch)?)
}

pub fn rename(store: &mut Store, arg: &str, name: &str) -> Result<Theme> {
    let (id, _) = editable(store, arg)?;
    custom_theme(store.update_custom_theme(id, Some(name), &CustomThemeSlotsPatch::default())?)
}

/// Delete a custom theme; if it is the saved appearance, the setting falls
/// back to `system`.
pub fn delete(store: &mut Store, arg: &str) -> Result<Theme> {
    delete_in(store, &config::config_file(), arg)
}

pub fn delete_in(store: &mut Store, path: &Path, arg: &str) -> Result<Theme> {
    let (id, theme) = editable(store, arg)?;
    store.delete_custom_theme(id)?;
    let saved = config::appearance_in(path).map_err(Error::Unavailable)?;
    if saved.theme.as_deref() == Some(theme.id.as_str()) {
        let clear = HashMap::from([(config::THEME.to_string(), None)]);
        config::save_appearance_in(path, &clear).map_err(save_err)?;
    }
    Ok(theme)
}

/// Make `arg` (`system`, a built-in or a custom theme) the saved appearance;
/// returns the setting written.
pub fn use_theme(store: &Store, arg: &str) -> Result<String> {
    use_theme_in(store, &config::config_file(), arg)
}

pub fn use_theme_in(store: &Store, path: &Path, arg: &str) -> Result<String> {
    let arg = arg.trim();
    let setting = if arg.eq_ignore_ascii_case("system") {
        "system".to_string()
    } else {
        // An unknown theme here is a bad setting, not a missing record.
        match show(store, arg) {
            Ok(t) => t.id,
            Err(Error::NotFound(m)) => return Err(Error::Validation(m)),
            Err(e) => return Err(e),
        }
    };
    let updates = HashMap::from([(config::THEME.to_string(), Some(setting.clone()))]);
    save_appearance_in(store, path, &updates).map_err(save_err)?;
    Ok(setting)
}

/// `config::save_appearance` plus the existence check for a `custom-<n>` id.
pub fn save_appearance(
    store: &Store,
    updates: &HashMap<String, Option<String>>,
) -> std::result::Result<(), SaveError> {
    save_appearance_in(store, &config::config_file(), updates)
}

pub fn save_appearance_in(
    store: &Store,
    path: &Path,
    updates: &HashMap<String, Option<String>>,
) -> std::result::Result<(), SaveError> {
    if let Some(Some(v)) = updates.get(config::THEME) {
        let v = v.trim();
        // `custom-<digits>` whose number overflows an id can name no theme.
        if custom_id(v).is_none()
            && v.strip_prefix("custom-")
                .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(SaveError::Validation(format!(
                "theme {v:?} does not exist; run `naru theme list`"
            )));
        }
        if let Some(n) = custom_id(v) {
            match store.get_custom_theme(n) {
                Ok(_) => {}
                Err(Error::NotFound(_)) => {
                    return Err(SaveError::Validation(format!(
                        "theme {v:?} does not exist; run `naru theme list`"
                    )));
                }
                Err(e) => return Err(SaveError::Unavailable(e.to_string())),
            }
        }
    }
    // A custom mark skin (naru task 2122) must exist; an overflowing number
    // names none.
    if let Some(Some(v)) = updates.get(config::MARK_SKIN) {
        let v = v.trim();
        if v.starts_with("custom-") {
            let missing = || SaveError::Validation(format!("mark skin {v:?} does not exist"));
            let n = crate::core::store::mark_skin_number(v).ok_or_else(missing)?;
            match store.get_mark_skin(n) {
                Ok(_) => {}
                Err(Error::NotFound(_)) => return Err(missing()),
                Err(e) => return Err(SaveError::Unavailable(e.to_string())),
            }
        }
    }
    config::save_appearance_in(path, updates)
}

/// Deletes a custom mark skin (naru task 2122) by its `custom-<n>` id and
/// echoes it; clears the saved `mark-skin` if it was the chosen one, so every
/// page falls back to the default.
pub fn delete_mark_skin(store: &mut Store, id: &str) -> Result<super::types::MarkSkinRecord> {
    delete_mark_skin_in(store, &config::config_file(), id)
}

pub fn delete_mark_skin_in(
    store: &mut Store,
    path: &Path,
    id: &str,
) -> Result<super::types::MarkSkinRecord> {
    let n = crate::core::store::mark_skin_number(id)
        .ok_or_else(|| Error::NotFound(format!("mark skin {id} not found")))?;
    let skin = store.delete_mark_skin(n)?;
    let saved = config::appearance_in(path).map_err(Error::Unavailable)?;
    if saved.mark_skin.as_deref() == Some(skin.id.as_str()) {
        let clear = HashMap::from([(config::MARK_SKIN.to_string(), None)]);
        config::save_appearance_in(path, &clear).map_err(save_err)?;
    }
    Ok(skin)
}

/// A custom mark skin by its `custom-<n>` id or its name (case-insensitive),
/// with its body (`naru mark`, naru task 2123). A built-in skin id has no
/// document and is `validation`; anything else unknown is `not_found`.
pub fn find_mark_skin(store: &Store, arg: &str) -> Result<super::types::MarkSkinRecord> {
    let arg = arg.trim();
    if let Some(n) = crate::core::store::mark_skin_number(arg) {
        return store.get_mark_skin(n);
    }
    if config::MARK_SKINS.contains(&arg.to_lowercase().as_str()) {
        return Err(Error::Validation(format!(
            "\"{arg}\" is a built-in skin; it has no document"
        )));
    }
    let lower = arg.to_lowercase();
    match store
        .list_mark_skins()?
        .into_iter()
        .find(|s| s.name.to_lowercase() == lower)
    {
        Some(s) => store
            .get_mark_skin(crate::core::store::mark_skin_number(&s.id).expect("stored skin id")),
        None => Err(Error::NotFound(format!(
            "mark skin \"{arg}\" not found; run `naru mark list`"
        ))),
    }
}

/// Makes a skin the mark's skin: a built-in id, or a custom skin by id or
/// name. Returns the saved id.
pub fn use_mark_skin(store: &Store, arg: &str) -> Result<String> {
    use_mark_skin_in(store, &config::config_file(), arg)
}

pub fn use_mark_skin_in(store: &Store, path: &Path, arg: &str) -> Result<String> {
    let arg = arg.trim();
    let lower = arg.to_lowercase();
    let id = if config::MARK_SKINS.contains(&lower.as_str()) {
        lower
    } else {
        // An unknown skin here is a bad setting, not a missing record.
        match find_mark_skin(store, arg) {
            Ok(s) => s.id,
            Err(Error::NotFound(m)) => return Err(Error::Validation(m)),
            Err(e) => return Err(e),
        }
    };
    let updates = HashMap::from([(config::MARK_SKIN.to_string(), Some(id.clone()))]);
    save_appearance_in(store, path, &updates).map_err(save_err)?;
    Ok(id)
}

/// `insert` right after a leading `<!doctype …>` (so the page stays in
/// standards mode), else in front of everything. Shared by the mark skin
/// render route and [`mark_skin_preview_body`].
pub fn after_doctype(body: &str, insert: &str) -> String {
    let lead = body.len() - body.trim_start().len();
    let rest = &body[lead..];
    if rest
        .get(..9)
        .is_some_and(|h| h.eq_ignore_ascii_case("<!doctype"))
        && let Some(end) = rest.find('>')
    {
        let at = lead + end + 1;
        return format!("{}{insert}{}", &body[..at], &body[at..]);
    }
    format!("{insert}{body}")
}

/// The preview driver put first in a skin pushed as an `html` live board
/// (`naru mark preview`, naru task 2123). A board has no host posting
/// frames, so this defines the same `window.naruMark` API the render route's
/// bootstrap does and drives it itself: every animation frame, cycling idle,
/// hear, speak, think, paused and offer two seconds each, with the host's
/// level rules (`NaruMark.tsx::runMarkLoop`: a made-up mic RMS while hearing,
/// the simulated envelope while speaking, `smoothLevel`) and its palettes
/// (`liveMark.ts::PALETTES`, paused wearing idle's). The board's own theme
/// relay posts `board-ready`; this only listens for the `board-theme` answer
/// and hands its vars to the skin's `onTheme`. It posts nothing. A chip names
/// the mode; an error, or no `onFrame` call within 2 s, shows a banner and
/// stops the skin for good. The stage is the nav's dark canvas, not the board
/// frame's white.
const MARK_PREVIEW_BOOTSTRAP: &str = r#"<style>html{background:var(--naru-bg,#060a10)!important;color-scheme:var(--naru-color-scheme,dark)}
#naru-preview-chip{position:fixed;top:.75rem;left:.75rem;z-index:2147483647;pointer-events:none;display:inline-flex;align-items:center;gap:.4em;white-space:nowrap;padding:0 .5em;border-radius:999px;background:var(--naru-surface,#0b1119);border:1px solid var(--naru-ring,rgba(184,221,232,.25));color:var(--naru-fg,#b8dde8);font:11px/1.8 ui-monospace,"Share Tech Mono",monospace}
#naru-preview-chip i{display:inline-block;width:.5rem;height:.5rem;border-radius:50%}
#naru-preview-error{position:fixed;left:.75rem;right:.75rem;bottom:.75rem;z-index:2147483647;pointer-events:none;padding:.5em .75em;border-radius:.5rem;border:1px solid var(--naru-bad,#ff3b5c);background:color-mix(in srgb,var(--naru-bad,#ff3b5c) 18%,var(--naru-surface,#0b1119));color:var(--naru-fg,#b8dde8);font:.85rem/1.4 Inter,system-ui,sans-serif;overflow-wrap:anywhere}</style>
<script>(function(){
var P={idle:{bars:['#3b3550','#4a4366','#5b537c','#6d6592'],glow:'#6d6592'},
hear:{bars:['#1f7fff','#1fb6ff','#29e6ff','#b8f6ff'],glow:'#29e6ff'},
speak:{bars:['#ff5a3c','#ff8a2b','#ffb02b','#ffe2a8'],glow:'#ffa02b'},
think:{bars:['#6a2bff','#8a4bff','#b06bff','#e6d1ff'],glow:'#b06bff'},
offer:{bars:['#d98a14','#f0a820','#ffc23d','#fff0c2'],glow:'#ffc23d'}};
var MODES=['idle','hear','speak','think','paused','offer'];
var F=null,T=null,E=0,msg='',shown='',chip=null,dot=null,label=null,banner=null;
var mq=matchMedia('(prefers-reduced-motion: reduce)'),start=null,last=0,lv=0;
function ui(){if(chip||!document.body)return;var d=document;
chip=d.createElement('div');chip.id='naru-preview-chip';chip.setAttribute('role','status');chip.setAttribute('aria-live','polite');
dot=d.createElement('i');label=d.createElement('span');chip.appendChild(dot);chip.appendChild(label);
banner=d.createElement('div');banner.id='naru-preview-error';banner.setAttribute('role','alert');banner.hidden=true;
d.body.appendChild(chip);d.body.appendChild(banner)}
function paint(){ui();if(!chip)return;var p=P[shown==='paused'?'idle':shown]||P.idle;
label.textContent='preview · '+(shown||'idle');dot.style.background=p.glow;
if(E){banner.textContent='skin error · '+msg;banner.hidden=false}}
function err(m){if(E)return;E=1;msg=String(m).slice(0,200);paint()}
addEventListener('error',function(e){err(e.message||'error')});
addEventListener('unhandledrejection',function(e){err(e.reason)});
addEventListener('DOMContentLoaded',paint);
window.naruMark={onFrame:function(cb){if(typeof cb==='function')F=cb},
onTheme:function(cb){if(typeof cb==='function')T=cb}};
addEventListener('message',function(e){var d=e.data;
if(E||e.source!==parent||!d||d.naru!=='board-theme'||!d.vars||typeof d.vars!=='object')return;
var s=document.documentElement.style;Object.keys(d.vars).forEach(function(k){var v=d.vars[k];
if(/^--naru-[a-z0-9-]+$/.test(k)&&typeof v==='string')s.setProperty(k,v)});
try{if(T)T(d.vars)}catch(x){err(x&&x.message||x)}});
setTimeout(function(){if(!F)err('no onFrame call within 2 s')},2000);
function env(t){var ph=Math.max(0,Math.sin(t*0.34)*0.5+0.42),a=0.5+0.5*Math.sin(t*11.3),b=0.5+0.5*Math.sin(t*7.1+1.4);
return Math.min(1,ph*(0.35+0.5*a*b+0.15*Math.sin(t*23)))}
function tick(now){if(E)return;if(start===null){start=now;last=now}
var dt=Math.min(0.05,(now-last)/1000);last=now;var t=(now-start)/1000,red=mq.matches;
var mode=MODES[Math.floor(t/2)%MODES.length],raw=0;
if(mode==='hear'){var rms=0.01+0.11*(0.5+0.5*Math.sin(t*6.3)*Math.sin(t*1.7+0.6));raw=Math.min(1,Math.sqrt(rms)*2)}
else if(mode==='speak')raw=0.35+0.65*env(t*(red?0.5:1)*1.7);
lv=lv+(raw-lv)*(raw>lv?0.55:0.14);
if(mode!==shown){shown=mode;paint()}
var p=P[mode==='paused'?'idle':mode];
if(F){try{F({naru:'mark-frame',mode:mode,level:lv,palette:{bars:p.bars.slice(),glow:p.glow},reduced:red,t:t,dt:dt})}
catch(x){err(x&&x.message||x);return}}
requestAnimationFrame(tick)}
requestAnimationFrame(tick)})();</script>
"#;

/// A skin's document as `naru mark preview` pushes it to the live
/// whiteboard: [`MARK_PREVIEW_BOOTSTRAP`] put first. The body must be what
/// `Store::create_mark_skin` would accept (non-blank, at most 64 KiB), so a
/// previewed skin can be installed as is.
pub fn mark_skin_preview_body(body: &str) -> Result<String> {
    use crate::core::store::MARK_SKIN_BODY_MAX;
    if body.trim().is_empty() {
        return Err(Error::Validation("mark skin body must not be empty".into()));
    }
    if body.len() > MARK_SKIN_BODY_MAX {
        return Err(Error::Validation(format!(
            "mark skin body is {} bytes; the limit is {MARK_SKIN_BODY_MAX} bytes (64 KiB)",
            body.len()
        )));
    }
    Ok(after_doctype(body, MARK_PREVIEW_BOOTSTRAP))
}

/// The appearance settings with the active custom theme filled in.
pub fn appearance(store: &Store) -> std::result::Result<ConfigAppearance, String> {
    appearance_in(store, &config::config_file())
}

pub fn appearance_in(store: &Store, path: &Path) -> std::result::Result<ConfigAppearance, String> {
    let mut a = config::appearance_in(path)?;
    if let Some(n) = a.theme.as_deref().and_then(custom_id)
        && let Ok(row) = store.get_custom_theme(n)
    {
        a.custom = custom_theme(row).ok();
    }
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    const THEMES_CSS: &str = include_str!("../../frontend/src/themes.css");
    const INDEX_CSS: &str = include_str!("../../frontend/src/index.css");

    fn slots(id: &str) -> ThemeSlots {
        let b = BUILTIN_THEMES.iter().find(|b| b.id == id).unwrap();
        slots_of(&b.slots)
    }

    /// The `--name: value;` declarations of the first block opened by `head`.
    fn block(css: &str, head: &str) -> BTreeMap<String, String> {
        let start = css.find(head).unwrap_or_else(|| panic!("no {head}"));
        let body = &css[start + head.len()..];
        let body = &body[..body.find('}').unwrap()];
        body.lines()
            .filter_map(|l| {
                let l = l.trim().strip_suffix(';')?;
                let (k, val) = l.split_once(':')?;
                Some((k.trim().to_string(), val.trim().to_string()))
            })
            .collect()
    }

    fn rgb_of(c: &str) -> String {
        triplet(parse_rgb("t", c).unwrap())
    }

    #[test]
    fn parse_normalises_and_rejects() {
        assert_eq!(normalize_color("bg", "#ABC").unwrap(), "#aabbcc");
        assert_eq!(normalize_color("bg", "#AbCdEf").unwrap(), "#abcdef");
        for bad in ["red", "#12345", "", "#12", "#ggg", "123456", "#1234567"] {
            let e = normalize_color("accent", bad).unwrap_err().to_string();
            assert!(e.contains("accent"), "{e}");
        }
    }

    #[test]
    fn derive_crimson_values_and_keys() {
        let v = derive(&slots("crimson")).unwrap();
        assert_eq!(v["--cyan-rgb"], "255, 84, 102");
        assert_eq!(v["--edge-rgb"], "147, 49, 60");
        let light = block(THEMES_CSS, ":root[data-theme='light'] {");
        let mut want: Vec<_> = light.keys().cloned().collect();
        want.push("color-scheme".into());
        // The light block sets color-scheme as a declaration too.
        want.sort();
        want.dedup();
        let dark_keys: Vec<_> = v.keys().cloned().collect();
        let light_keys: Vec<_> = derive(&slots("light")).unwrap().keys().cloned().collect();
        assert_eq!(light_keys, want);
        // Dark derives the same set minus the five glow overrides.
        let mut expect_dark = want.clone();
        expect_dark.retain(|k| !k.starts_with("--text-glow"));
        assert_eq!(dark_keys, expect_dark);
    }

    #[test]
    fn glow_keys_only_in_light_scheme() {
        let light = derive(&slots("light")).unwrap();
        for k in [
            "--text-glow",
            "--text-glow-wide",
            "--text-glow-dim",
            "--text-glow-red",
            "--text-glow-magenta",
        ] {
            assert_eq!(light[k], "none");
        }
        for id in ["dark", "contrast", "crimson"] {
            let d = derive(&slots(id)).unwrap();
            assert!(!d.keys().any(|k| k.starts_with("--text-glow")), "{id}");
        }
        assert_eq!(scheme(&slots("light")).unwrap(), "light");
        assert_eq!(scheme(&slots("crimson")).unwrap(), "dark");
    }

    #[test]
    fn builtins_match_the_stylesheets() {
        let heads = [
            ("light", ":root[data-theme='light'] {"),
            ("contrast", ":root[data-theme='contrast'] {"),
            ("crimson", ":root[data-theme='crimson'] {"),
        ];
        let check = |id: &str, css: &BTreeMap<String, String>| {
            let s = slots(id);
            let pairs = [
                ("--bg-rgb", &s.bg),
                ("--text-rgb", &s.text),
                ("--muted-rgb", &s.muted),
                ("--cyan-rgb", &s.accent),
                ("--violet-rgb", &s.accent2),
                ("--green-rgb", &s.good),
                ("--amber-rgb", &s.warn),
                ("--red-rgb", &s.bad),
            ];
            for (k, c) in pairs {
                assert_eq!(css[k], rgb_of(c), "{id} {k}");
            }
            assert_eq!(css["--panel"], s.panel, "{id} --panel");
        };
        check("dark", &block(INDEX_CSS, ":root {"));
        for (id, head) in heads {
            check(id, &block(THEMES_CSS, head));
        }
        let keys = derive(&slots("light")).unwrap();
        for k in block(THEMES_CSS, heads[0].1).keys() {
            assert!(keys.contains_key(k), "light block var {k} is not derived");
        }
    }

    #[test]
    fn light_contrast_crimson_have_no_warnings() {
        for id in ["light", "contrast", "crimson"] {
            assert!(contrast_warnings(&slots(id)).unwrap().is_empty(), "{id}");
        }
    }

    #[test]
    fn identical_text_and_bg_warns() {
        let mut s = slots("light");
        s.text = s.bg.clone();
        let w = contrast_warnings(&s).unwrap();
        let tb = w.iter().find(|w| w.pair == "text/bg").unwrap();
        assert_eq!(tb.ratio, 1.0);
        assert_eq!(tb.min, 4.5);
    }

    #[test]
    fn builtin_constructor() {
        let t = Theme::builtin("crimson").unwrap();
        assert!(t.builtin && t.scheme == "dark" && t.name == "Crimson");
        assert!(Theme::builtin("custom-1").is_none());
    }

    // ---- service (naru task 1842) ----

    fn temp() -> (Store, std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        let cfg = dir.path().join("config.json");
        (store, cfg, dir)
    }

    #[test]
    fn save_appearance_rejects_overflowing_custom_id() {
        let (store, cfg, _d) = temp();
        let updates = HashMap::from([(
            config::THEME.to_string(),
            Some("custom-99999999999999999999".to_string()),
        )]);
        assert!(matches!(
            save_appearance_in(&store, &cfg, &updates),
            Err(SaveError::Validation(_))
        ));
        assert!(!cfg.exists());
    }

    #[test]
    fn mark_skin_custom_id_must_exist_and_delete_clears_it() {
        let (mut store, cfg, _d) = temp();
        let set = |v: &str| HashMap::from([(config::MARK_SKIN.to_string(), Some(v.to_string()))]);
        for missing in ["custom-1", "custom-99999999999999999999"] {
            assert!(matches!(
                save_appearance_in(&store, &cfg, &set(missing)),
                Err(SaveError::Validation(_))
            ));
        }
        assert!(!cfg.exists());
        let a = store.create_mark_skin("A", "<p>a</p>").unwrap();
        let b = store.create_mark_skin("B", "<p>b</p>").unwrap();
        save_appearance_in(&store, &cfg, &set(&a.id)).unwrap();
        // Deleting a skin that is not the chosen one leaves the choice alone.
        assert_eq!(delete_mark_skin_in(&mut store, &cfg, &b.id).unwrap(), b);
        assert_eq!(
            config::appearance_in(&cfg).unwrap().mark_skin.as_deref(),
            Some(a.id.as_str())
        );
        // Deleting the chosen one clears it.
        assert_eq!(delete_mark_skin_in(&mut store, &cfg, &a.id).unwrap(), a);
        assert_eq!(config::appearance_in(&cfg).unwrap().mark_skin, None);
        assert!(matches!(
            delete_mark_skin_in(&mut store, &cfg, &a.id),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            delete_mark_skin_in(&mut store, &cfg, "waveform"),
            Err(Error::NotFound(_))
        ));
    }

    fn is_validation<T: std::fmt::Debug>(r: Result<T>) -> String {
        match r {
            Err(Error::Validation(m)) => m,
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn create_from_names_and_copies_slots() {
        let (mut store, _cfg, _d) = temp();
        let a = create_from(&mut store, "crimson", None).unwrap();
        assert_eq!(a.name, "Crimson copy");
        assert_eq!(a.slots, Theme::builtin("crimson").unwrap().slots);
        assert!(!a.builtin && a.id.starts_with("custom-"));
        let b = create_from(&mut store, "crimson", None).unwrap();
        assert_eq!(b.name, "Crimson copy 2");
        let c = create_from(&mut store, "crimson copy", Some("Third")).unwrap();
        assert_eq!(c.name, "Third");
        assert_eq!(c.slots, a.slots);
        assert_eq!(show(&store, &a.id).unwrap().id, a.id);
        assert_eq!(list(&store).unwrap().len(), 4 + 3);
        assert!(matches!(show(&store, "nope"), Err(Error::NotFound(_))));
        assert!(matches!(
            show(&store, "custom-999"),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn builtins_are_read_only_and_slots_validated() {
        let (mut store, _cfg, _d) = temp();
        for e in [
            is_validation(set_slot(&mut store, "crimson", "bg", "#000000")),
            is_validation(rename(&mut store, "crimson", "x")),
            is_validation(delete(&mut store, "crimson")),
        ] {
            assert!(e.contains("naru theme create --from crimson"), "{e}");
        }
        let t = create_from(&mut store, "dark", None).unwrap();
        let e = is_validation(set_slot(&mut store, &t.id, "nope", "#000000"));
        assert!(e.contains("accent2"), "{e}");
        is_validation(set_slot(&mut store, &t.id, "bg", "red"));
        let u = set_slot(&mut store, &t.id, "bg", "#ABC").unwrap();
        assert_eq!(u.slots.bg, "#aabbcc");
        assert_eq!(
            rename(&mut store, &t.id, "Renamed").unwrap().name,
            "Renamed"
        );
    }

    #[test]
    fn use_and_delete_drive_the_saved_appearance() {
        let (mut store, cfg, _d) = temp();
        let t = create_from(&mut store, "light", None).unwrap();
        assert_eq!(use_theme_in(&store, &cfg, &t.id).unwrap(), t.id);
        let a = appearance_in(&store, &cfg).unwrap();
        assert_eq!(a.theme.as_deref(), Some(t.id.as_str()));
        assert_eq!(a.custom.unwrap().id, t.id);

        let before = std::fs::read(&cfg).unwrap();
        is_validation(use_theme_in(&store, &cfg, "custom-999"));
        assert_eq!(std::fs::read(&cfg).unwrap(), before);

        assert_eq!(delete_in(&mut store, &cfg, &t.id).unwrap().id, t.id);
        let a = appearance_in(&store, &cfg).unwrap();
        assert_eq!(a.theme, None);
        assert!(a.custom.is_none());

        assert_eq!(use_theme_in(&store, &cfg, "system").unwrap(), "system");
        assert_eq!(use_theme_in(&store, &cfg, "Crimson").unwrap(), "crimson");
        // A dangling id reads back verbatim with no custom theme.
        std::fs::write(&cfg, r#"{"appearance": {"theme": "custom-7"}}"#).unwrap();
        let a = appearance_in(&store, &cfg).unwrap();
        assert_eq!(a.theme.as_deref(), Some("custom-7"));
        assert!(a.custom.is_none());
    }

    // ---- naru mark (naru task 2123) ----

    #[test]
    fn mark_skin_found_by_id_or_name_and_used() {
        let (mut store, cfg, _d) = temp();
        let a = store.create_mark_skin("Ocean Orb", "<p>a</p>").unwrap();
        assert_eq!(find_mark_skin(&store, &a.id).unwrap(), a);
        assert_eq!(find_mark_skin(&store, " ocean orb ").unwrap(), a);
        assert!(matches!(
            find_mark_skin(&store, "nope"),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            find_mark_skin(&store, "Face"),
            Err(Error::Validation(_))
        ));
        assert_eq!(use_mark_skin_in(&store, &cfg, "OCEAN ORB").unwrap(), a.id);
        assert_eq!(
            config::appearance_in(&cfg).unwrap().mark_skin.as_deref(),
            Some(a.id.as_str())
        );
        assert_eq!(use_mark_skin_in(&store, &cfg, "Blob").unwrap(), "blob");
        assert!(matches!(
            use_mark_skin_in(&store, &cfg, "nope"),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            use_mark_skin_in(&store, &cfg, "custom-99"),
            Err(Error::Validation(_))
        ));
    }

    #[test]
    fn preview_body_puts_the_driver_first_and_keeps_the_skin() {
        let skin = "<!DOCTYPE html><svg/><script>naruMark.onFrame(function(){})</script>";
        let html = mark_skin_preview_body(skin).unwrap();
        assert!(html.starts_with(&format!("<!DOCTYPE html>{MARK_PREVIEW_BOOTSTRAP}")));
        assert!(html.ends_with("<svg/><script>naruMark.onFrame(function(){})</script>"));
        assert_eq!(
            mark_skin_preview_body("<svg/>").unwrap(),
            format!("{MARK_PREVIEW_BOOTSTRAP}<svg/>")
        );
        assert!(matches!(
            mark_skin_preview_body("  "),
            Err(Error::Validation(_))
        ));
        let big = "x".repeat(crate::core::store::MARK_SKIN_BODY_MAX + 1);
        assert!(matches!(
            mark_skin_preview_body(&big),
            Err(Error::Validation(_))
        ));
    }

    /// The driver posts nothing to the page and loads nothing.
    #[test]
    fn preview_driver_posts_nothing() {
        assert!(!MARK_PREVIEW_BOOTSTRAP.contains("postMessage"));
        assert!(!MARK_PREVIEW_BOOTSTRAP.contains("fetch"));
        assert!(!MARK_PREVIEW_BOOTSTRAP.contains("src="));
    }

    /// The driver's palettes are copied from `liveMark.ts::PALETTES`; every
    /// line of that table must appear in the driver, so the copy cannot drift.
    #[test]
    fn preview_palettes_match_live_mark() {
        const LIVE_MARK: &str = include_str!("../../frontend/src/liveMark.ts");
        let start = LIVE_MARK.find("export const PALETTES").unwrap();
        let table = &LIVE_MARK[start..start + LIVE_MARK[start..].find("\n}").unwrap()];
        let mut seen = 0;
        for line in table.lines().skip(1) {
            let line = line.trim().trim_end_matches(',');
            let (name, rest) = line.split_once(": ").unwrap();
            let expected = format!("{name}:{}", rest.replace(", ", ",").replace(' ', ""));
            assert!(
                MARK_PREVIEW_BOOTSTRAP.contains(&expected),
                "preview palette drifted from liveMark.ts: {expected}"
            );
            seen += 1;
        }
        assert_eq!(seen, 5);
    }
}
