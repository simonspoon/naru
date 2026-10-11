//! Colour themes (naru task 1840): a theme is nine key colours, every other
//! CSS variable is derived here. Derivation and the WCAG contrast check live
//! only in this file; the frontend never re-derives. Pure: no store, no I/O.

use std::collections::BTreeMap;

use super::store::{Error, Result};
use super::types::{ContrastWarning, Theme, ThemePreview, ThemeSlots};

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
    put("--wf-prompt", hex(mix(p.panel, p.accent2, 0.25)));
    put("--wf-cli", hex(mix(p.panel, p.accent, 0.22)));
    put("--wf-script", hex(mix(p.panel, p.warn, 0.2)));
    put("--wf-branch", hex(mix(p.panel, p.bad, 0.22)));
    put("--wf-decide", hex(mix(p.panel, magenta, 0.22)));
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
}
