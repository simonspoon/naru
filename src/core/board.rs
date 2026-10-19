//! Rendering a workflow's graph as a **snapshot** SVG, for the live
//! conversation's whiteboard (mesa tasks 1071 and 1607).
//!
//! `naru live board push --workflow <id|name>` reads a workflow's nodes and
//! edges once and renders this static picture, which is then what the board
//! holds for the rest of the conversation. That is what "snapshot" means
//! here: the graph may be rearranged, relabelled or deleted afterwards and
//! the board the person was shown does not change under them. The board's
//! kind stays `diagram` — a stored SVG — so a board pushed from a diagram
//! before workflows existed still renders beside one pushed from a workflow.
//!
//! It is deliberately plain — a box per node with its title and kind,
//! straight lines between node centres — and does not try to match the
//! editor pixel for pixel; this is the picture a person glances at while
//! someone talks them through it.
//!
//! Every piece of text that reaches the output goes through [`escape`] first:
//! a node title is free text an untrusted source may have written, and the
//! result is served as `image/svg+xml`, which is markup.

use std::path::{Path, PathBuf};

use super::store::{Error, Result};
use super::types::WorkflowNodeKind;
use super::types::{LiveBoard, LiveBoardKind, WorkflowView};

/// What the live-memory archive indexes for a board (mesa task 1548): its
/// title plus the text it holds — markdown as written, HTML with its tags,
/// `<script>`/`<style>` bodies and comments stripped and the common entities
/// decoded. An `image` or `diagram` board holds bytes or generated markup, so
/// only its title (the caption) is searchable. `None` when nothing is left.
pub fn search_text(kind: LiveBoardKind, title: Option<&str>, body: &str) -> Option<String> {
    let content = match kind {
        LiveBoardKind::Markdown => body.to_string(),
        LiveBoardKind::Html => html_text(body),
        LiveBoardKind::Diagram | LiveBoardKind::Image => String::new(),
    };
    let text = format!("{}\n{}", title.unwrap_or(""), content);
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Visible text of an HTML document, by a plain scan — good enough to make a
/// mockup's words findable, not a parser.
fn html_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0;
    while i < html.len() {
        let rest = &html[i..];
        if rest.starts_with("<!--") {
            i += rest.find("-->").map_or(rest.len(), |e| e + 3);
        } else if rest.starts_with('<')
            && rest[1..]
                .starts_with(|c: char| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?'))
        {
            let skipped = ["script", "style"].iter().find_map(|t| {
                let open = &lower[i + 1..];
                (open.starts_with(t)
                    && open[t.len()..].starts_with(|c: char| c == '>' || c.is_whitespace()))
                .then(|| {
                    let close = format!("</{t}");
                    lower[i..].find(&close).map(|e| i + e)
                })
            });
            if let Some(end) = skipped {
                i = end.unwrap_or(html.len());
            }
            i += html[i..].find('>').map_or(html.len() - i, |e| e + 1);
            out.push(' ');
        } else {
            // Skip the first char: a bare `<` (not a tag) is text and would
            // otherwise match itself here.
            let first = rest.chars().next().map_or(0, char::len_utf8);
            let next = first + rest[first..].find('<').unwrap_or(rest.len() - first);
            out.push_str(&rest[..next]);
            i += next;
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// The file extension a board's bytes should carry — what the render route
/// names its `Content-Disposition` and what `mesa live board keep` defaults an
/// artifact's or an attachment's filename to, so the two can never disagree.
///
/// Three of the four kinds answer from the kind alone; an `image` answers from
/// the content type it recorded at push time, mapped back through the same allowlist
/// `files::image_mime` reads forward (`png` for anything unrecognised, which a
/// row `Store` accepted cannot be).
pub fn extension_for(kind: LiveBoardKind, content_type: Option<&str>) -> &'static str {
    match kind {
        LiveBoardKind::Markdown => "md",
        LiveBoardKind::Html => "html",
        LiveBoardKind::Diagram => "svg",
        LiveBoardKind::Image => match content_type.unwrap_or_default() {
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/x-icon" => "ico",
            "image/svg+xml" => "svg",
            _ => "png",
        },
    }
}

/// The blank dark canvas the page's "New board" button starts (mesa task
/// 1580): an `image/svg+xml` board, so it rides the ordinary image path — the
/// render route, the poll, the page's flatten and `live board keep` — with no
/// kind of its own. 16:10, the page's dark backdrop colour.
pub const BLANK_BOARD_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1600\" \
height=\"1000\" viewBox=\"0 0 1600 1000\"><rect width=\"1600\" height=\"1000\" fill=\"#0b0f16\"/></svg>";

/// What one board is called when it leaves the conversation — the filename
/// the render route puts in its `Content-Disposition`, and the default name
/// `mesa live board keep` gives the artifact or attachment it writes. One
/// function, so the two can never answer differently.
///
/// The caption when there is one, else `board-<id>`, plus the extension its
/// kind implies — and never twice, so a title someone already wrote as
/// `plan.md` stays `plan.md`.
pub fn filename(board: &LiveBoard) -> String {
    let stem = board
        .title
        .clone()
        .unwrap_or_else(|| format!("board-{}", board.id));
    let ext = extension_for(board.kind, board.content_type.as_deref());
    if stem.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
        stem
    } else {
        format!("{stem}.{ext}")
    }
}

/// Where the person's annotated boards live (mesa task 1353):
/// `NARU_LIVE_INK_DIR`/`MESA_LIVE_INK_DIR` if set and non-empty, else
/// `live-ink/` beside the resolved database — `attachments::attachments_dir`'s
/// rule, empty counting as unset for the same reason.
pub fn live_ink_dir() -> PathBuf {
    if let Some(p) = crate::core::env::var("LIVE_INK_DIR")
        && !p.is_empty()
    {
        return PathBuf::from(p);
    }
    let mut path = crate::core::default_db_path();
    path.set_file_name("live-ink");
    path
}

/// What a turn's `image_path` column holds (mesa task 1355):
/// `<session>/<turn>.png`, relative to [`live_ink_dir`], so the row follows
/// the ink folder wherever it moves. Both components are ids, so there is
/// nothing here a caller could traverse with.
pub fn live_ink_relative(session_id: i64, turn_id: i64) -> String {
    format!("{session_id}/{turn_id}.png")
}

/// Where the PNG one user turn carried is written: `<dir>/<session>/<turn>.png`.
pub fn live_ink_path(session_id: i64, turn_id: i64) -> PathBuf {
    live_ink_dir().join(live_ink_relative(session_id, turn_id))
}

/// The absolute path a stored `image_path` names (mesa task 1355) — the one
/// place a turn's column becomes the path `LiveTurn.image_path` hands the
/// agent. A relative value is joined to [`live_ink_dir`]. An absolute one is
/// a row written before 1355: kept as it is while that file exists, else
/// re-anchored to `<ink dir>/<its folder>/<its file>` if the ink moved there
/// with the data dir, else kept as it is, so whoever opens it gets an honest
/// "missing" rather than a guess. A relative value holding anything but plain
/// names (`..`, say) is never joined — it is returned as it is, which
/// `Store::purge_live_ink` then refuses to delete.
pub fn resolve_live_ink(stored: &str) -> String {
    let path = Path::new(stored);
    if path.is_relative() {
        if !path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return stored.to_string();
        }
        return live_ink_dir().join(path).to_string_lossy().into_owned();
    }
    if path.exists() {
        return stored.to_string();
    }
    if let (Some(session), Some(file)) =
        (path.parent().and_then(|p| p.file_name()), path.file_name())
    {
        let moved = live_ink_dir().join(session).join(file);
        if moved.exists() {
            return moved.to_string_lossy().into_owned();
        }
    }
    stored.to_string()
}

/// What `mesa live board keep --task` names the ink it attaches beside the
/// board: the board's own name without its extension, plus `-ink.png`, so
/// `plan.md` keeps as `plan.md` and `plan-ink.png` side by side.
pub fn ink_filename(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| name.to_string());
    format!("{stem}-ink.png")
}

/// Padding around the content's bounding box, in canvas units.
const PAD: f64 = 24.0;
/// A node's box. The engine has no notion of size (a node is a point on the
/// canvas), so the snapshot draws every node the same.
const NODE_W: f64 = 200.0;
const NODE_H: f64 = 64.0;

/// The stroke colour of a node box, by kind.
fn kind_colour(kind: WorkflowNodeKind) -> &'static str {
    match kind {
        WorkflowNodeKind::Trigger => "#f5a524",
        WorkflowNodeKind::Schedule => "#f5a524", // trigger family
        WorkflowNodeKind::Webhook => "#f5a524",  // trigger family
        WorkflowNodeKind::TaskEvent => "#f5a524", // trigger family
        WorkflowNodeKind::FileWatch => "#f5a524", // trigger family
        WorkflowNodeKind::Prompt => "#a78bfa",
        WorkflowNodeKind::Agent => "#2dd4bf",
        WorkflowNodeKind::Cli => "#00e5ff",
        WorkflowNodeKind::Script => "#4ade80",
        WorkflowNodeKind::Branch => "#fb7185",
        WorkflowNodeKind::Decide => "#f472b6",
        WorkflowNodeKind::Switch => "#a3b84a", // `--wf-switch` family, olive
        WorkflowNodeKind::Output => "#94a3b8",
        WorkflowNodeKind::Break | WorkflowNodeKind::Make => "#38bdf8",
        WorkflowNodeKind::Variable => "#ffb444", // data node, same amber as parse-json
        WorkflowNodeKind::MapFilter => "#ffb444", // data node, same amber
        WorkflowNodeKind::Parallel
        | WorkflowNodeKind::Join
        | WorkflowNodeKind::Retry
        | WorkflowNodeKind::Delay
        | WorkflowNodeKind::Gate
        | WorkflowNodeKind::Trycatch
        | WorkflowNodeKind::Subworkflow => "#fb923c", // flow group, `--wf-flow`
        WorkflowNodeKind::Task => "#34d399",     // action group, `--wf-task`
        WorkflowNodeKind::Http => "#34d399",     // action group, `--wf-http`
        WorkflowNodeKind::Notify => "#34d399",   // action group, `--wf-http`
        WorkflowNodeKind::Board => "#34d399",    // action group, `--wf-http`
        WorkflowNodeKind::Git => "#34d399",      // action group, `--wf-http`
        WorkflowNodeKind::File => "#34d399",     // action group, `--wf-http`
        WorkflowNodeKind::Comment => "#94a3b8",  // editor-only box
        WorkflowNodeKind::Verify => "#34d399",   // action group, `--wf-http`
        WorkflowNodeKind::Memory => "#34d399",   // action group, `--wf-http`
        WorkflowNodeKind::ForEach => "#ffb444",  // data node, same amber
        WorkflowNodeKind::ParseJson => "#ffb444", // the canvas `--amber` (index.css); keep in step
    }
}

/// Renders one workflow's graph as a static SVG document: a box per node
/// (its title and, beneath it, its kind) and a line per edge, labelled with
/// its branch verdict when it has one.
///
/// The `viewBox` is the content's own bounding box plus [`PAD`], so a graph
/// laid out anywhere in the canvas' coordinate space fills the picture; an
/// empty workflow still renders (a titled, empty sheet) rather than answering
/// with nothing a person could look at.
pub fn workflow_svg(view: &WorkflowView) -> String {
    let (min_x, min_y, max_x, max_y) = bounds(view);
    let width = (max_x - min_x + PAD * 2.0).max(1.0);
    let height = (max_y - min_y + PAD * 2.0).max(1.0);
    let mut out = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{:.0} {:.0} {:.0} {:.0}\" \
         width=\"{:.0}\" height=\"{:.0}\">\n\
         <title>{}</title>\n\
         <rect x=\"{:.0}\" y=\"{:.0}\" width=\"{:.0}\" height=\"{:.0}\" fill=\"#0b0f14\"/>\n",
        min_x - PAD,
        min_y - PAD,
        width,
        height,
        width,
        height,
        escape(&view.workflow.name),
        min_x - PAD,
        min_y - PAD,
        width,
        height,
    );
    // Edges first, so a connector runs behind the boxes it joins rather than
    // across their titles.
    for edge in &view.edges {
        let Some(from) = view.nodes.iter().find(|n| n.id == edge.from_node) else {
            continue;
        };
        let Some(to) = view.nodes.iter().find(|n| n.id == edge.to_node) else {
            continue;
        };
        let (x1, y1) = (from.x + NODE_W / 2.0, from.y + NODE_H / 2.0);
        let (x2, y2) = (to.x + NODE_W / 2.0, to.y + NODE_H / 2.0);
        out.push_str(&format!(
            "<line x1=\"{x1:.0}\" y1=\"{y1:.0}\" x2=\"{x2:.0}\" y2=\"{y2:.0}\" \
             stroke=\"#5b6b7f\" stroke-width=\"2\"/>\n"
        ));
        if let Some(branch) = &edge.branch {
            out.push_str(&format!(
                "<text x=\"{:.0}\" y=\"{:.0}\" fill=\"#9fb0c3\" font-family=\"sans-serif\" \
                 font-size=\"12\" text-anchor=\"middle\">{}</text>\n",
                (x1 + x2) / 2.0,
                (y1 + y2) / 2.0 - 4.0,
                escape(branch),
            ));
        }
    }
    for node in &view.nodes {
        out.push_str(&format!(
            "<rect x=\"{:.0}\" y=\"{:.0}\" width=\"{NODE_W:.0}\" height=\"{NODE_H:.0}\" rx=\"8\" \
             fill=\"#131a22\" stroke=\"{}\" stroke-width=\"2\"/>\n\
             <text x=\"{:.0}\" y=\"{:.0}\" fill=\"#e6edf3\" font-family=\"sans-serif\" \
             font-size=\"14\">{}</text>\n\
             <text x=\"{:.0}\" y=\"{:.0}\" fill=\"#9fb0c3\" font-family=\"sans-serif\" \
             font-size=\"11\">{}</text>\n",
            node.x,
            node.y,
            kind_colour(node.kind),
            node.x + 10.0,
            node.y + 26.0,
            escape(&node.title),
            node.x + 10.0,
            node.y + 46.0,
            escape(node.kind.as_str()),
        ));
    }
    out.push_str("</svg>\n");
    out
}

/// The content's bounding box, or a modest empty sheet when there are no
/// nodes to bound.
fn bounds(view: &WorkflowView) -> (f64, f64, f64, f64) {
    if view.nodes.is_empty() {
        return (0.0, 0.0, 320.0, 180.0);
    }
    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    for node in &view.nodes {
        min_x = min_x.min(node.x);
        min_y = min_y.min(node.y);
        max_x = max_x.max(node.x + NODE_W);
        max_y = max_y.max(node.y + NODE_H);
    }
    (min_x, min_y, max_x, max_y)
}

/// XML-escapes one piece of text on its way into the picture. Titles, labels
/// and colour hints are free text from an untrusted source (CLAUDE.md), and
/// the output is markup a browser parses, so this is the one place that
/// decides they are data.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// Board templates (naru task 1728, more in task 1792): `naru live board push
/// --template table|cards|flow|checklist|compare|timeline|stats|callout|tree`
/// turns a small JSON document into a self-contained `html`
/// board, so the live agent gets a consistent, styled picture without
/// hand-writing markup. The result is stored like any html board — inline
/// `<style>` only (what `RENDER_CSP` allows), no script, nothing fetched.
/// Every piece of the JSON's text goes through [`escape`].
pub const TEMPLATES: [&str; 9] = [
    "table",
    "cards",
    "flow",
    "checklist",
    "compare",
    "timeline",
    "stats",
    "callout",
    "tree",
];

pub fn template_html(template: &str, input: &str) -> Result<String> {
    if !TEMPLATES.contains(&template) {
        return Err(Error::Validation(format!(
            "unknown template {template:?}: expected {}",
            TEMPLATES.join(", ")
        )));
    }
    let value: serde_json::Value = serde_json::from_str(input).map_err(|e| {
        Error::Validation(format!(
            "--template {template} takes JSON like {}, but this is not valid JSON: {e}",
            template_shape(template)
        ))
    })?;
    let body = match template {
        "table" => table_body(&value)?,
        "cards" => cards_body(&value)?,
        "flow" => flow_body(&value)?,
        "checklist" => checklist_body(&value)?,
        "compare" => compare_body(&value)?,
        "timeline" => timeline_body(&value)?,
        "stats" => stats_body(&value)?,
        "callout" => callout_body(&value)?,
        _ => tree_body(&value)?,
    };
    Ok(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>{TEMPLATE_CSS}</style></head>\
         <body>{body}</body></html>"
    ))
}

fn template_shape(template: &str) -> &'static str {
    match template {
        "table" => r#"{"columns": ["A","B"], "rows": [["1","2"]]}"#,
        "cards" => r#"{"cards": [{"title": "...", "body": "...", "tag": "..."}]}"#,
        "flow" => r#"{"steps": [{"title": "...", "detail": "..."}]}"#,
        "checklist" => r#"{"items": [{"text": "...", "done": true, "note": "..."}]}"#,
        "compare" => r#"{"columns": [{"title": "...", "points": ["..."]}]}"#,
        "timeline" => r#"{"events": [{"when": "...", "title": "...", "detail": "..."}]}"#,
        "stats" => r#"{"stats": [{"label": "...", "value": "...", "note": "..."}]}"#,
        "callout" => r#"{"text": "...", "by": "...", "tone": "info|good|warn|bad"}"#,
        _ => r#"{"root": {"title": "...", "children": [{"title": "..."}]}}"#,
    }
}

fn bad(template: &str, what: &str) -> Error {
    Error::Validation(format!(
        "--template {template}: {what}; expected {}",
        template_shape(template)
    ))
}

/// A string or number as text; anything else is not text.
fn text_of(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// An optional text field: absent, `null` and `""` are none; a string or
/// number is text; anything else is refused rather than silently dropped.
fn opt_text(
    template: &str,
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>> {
    match obj.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => match text_of(v) {
            Some(s) => Ok(Some(s).filter(|s| !s.is_empty())),
            None => Err(bad(
                template,
                &format!("\"{key}\" must be a string or number"),
            )),
        },
    }
}

fn table_body(v: &serde_json::Value) -> Result<String> {
    let obj = v
        .as_object()
        .ok_or_else(|| bad("table", "the JSON is not an object"))?;
    let cols = obj
        .get("columns")
        .and_then(|c| c.as_array())
        .ok_or_else(|| bad("table", "\"columns\" must be an array"))?;
    let cols: Vec<String> = cols
        .iter()
        .map(text_of)
        .collect::<Option<_>>()
        .ok_or_else(|| bad("table", "every column must be a string or number"))?;
    if cols.is_empty() {
        return Err(bad("table", "\"columns\" is empty"));
    }
    let rows = obj
        .get("rows")
        .and_then(|r| r.as_array())
        .ok_or_else(|| bad("table", "\"rows\" must be an array"))?;
    if rows.is_empty() {
        return Err(bad("table", "\"rows\" is empty"));
    }
    let mut out = String::from("<div class=\"wrap\"><table><thead><tr>");
    for c in &cols {
        out.push_str(&format!("<th>{}</th>", escape(c)));
    }
    out.push_str("</tr></thead><tbody>");
    for (i, row) in rows.iter().enumerate() {
        let cells = row
            .as_array()
            .ok_or_else(|| bad("table", &format!("row {} is not an array", i + 1)))?;
        if cells.len() != cols.len() {
            return Err(bad(
                "table",
                &format!(
                    "row {} has {} cells but there are {} columns",
                    i + 1,
                    cells.len(),
                    cols.len()
                ),
            ));
        }
        out.push_str("<tr>");
        for c in cells {
            let t = text_of(c).ok_or_else(|| {
                bad(
                    "table",
                    &format!("row {} has a cell that is not a string or number", i + 1),
                )
            })?;
            out.push_str(&format!("<td>{}</td>", escape(&t)));
        }
        out.push_str("</tr>");
    }
    out.push_str("</tbody></table></div>");
    Ok(out)
}

/// The array a template reads: the value itself, or the one under `key`.
fn items<'a>(
    template: &str,
    v: &'a serde_json::Value,
    key: &str,
) -> Result<&'a Vec<serde_json::Value>> {
    let arr = match v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => o
            .get(key)
            .and_then(|a| a.as_array())
            .ok_or_else(|| bad(template, &format!("\"{key}\" must be an array")))?,
        _ => return Err(bad(template, "the JSON is neither an object nor an array")),
    };
    if arr.is_empty() {
        return Err(bad(template, &format!("\"{key}\" is empty")));
    }
    Ok(arr)
}

fn cards_body(v: &serde_json::Value) -> Result<String> {
    let mut out = String::from("<div class=\"cards\">");
    for (i, c) in items("cards", v, "cards")?.iter().enumerate() {
        let obj = c
            .as_object()
            .ok_or_else(|| bad("cards", &format!("card {} is not an object", i + 1)))?;
        let title = opt_text("cards", obj, "title")?
            .ok_or_else(|| bad("cards", &format!("card {} has no \"title\"", i + 1)))?;
        out.push_str("<div class=\"card\">");
        if let Some(tag) = opt_text("cards", obj, "tag")? {
            out.push_str(&format!("<span class=\"tag\">{}</span>", escape(&tag)));
        }
        out.push_str(&format!("<h2>{}</h2>", escape(&title)));
        if let Some(body) = opt_text("cards", obj, "body")? {
            out.push_str(&format!("<p>{}</p>", escape(&body)));
        }
        out.push_str("</div>");
    }
    out.push_str("</div>");
    Ok(out)
}

fn flow_body(v: &serde_json::Value) -> Result<String> {
    let mut out = String::from("<div class=\"flow\">");
    for (i, s) in items("flow", v, "steps")?.iter().enumerate() {
        let (title, detail) = match s {
            serde_json::Value::String(t) if t.is_empty() => {
                return Err(bad("flow", &format!("step {} is empty", i + 1)));
            }
            serde_json::Value::String(t) => (t.clone(), None),
            serde_json::Value::Object(o) => (
                opt_text("flow", o, "title")?
                    .ok_or_else(|| bad("flow", &format!("step {} has no \"title\"", i + 1)))?,
                opt_text("flow", o, "detail")?,
            ),
            _ => {
                return Err(bad(
                    "flow",
                    &format!("step {} is neither a string nor an object", i + 1),
                ));
            }
        };
        if i > 0 {
            out.push_str("<span class=\"arrow\">\u{2192}</span>");
        }
        out.push_str(&format!(
            "<div class=\"step\"><span class=\"num\">{}</span><h2>{}</h2>",
            i + 1,
            escape(&title)
        ));
        if let Some(d) = detail {
            out.push_str(&format!("<p>{}</p>", escape(&d)));
        }
        out.push_str("</div>");
    }
    out.push_str("</div>");
    Ok(out)
}

/// A required text field.
fn req_text(
    template: &str,
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    what: &str,
) -> Result<String> {
    opt_text(template, obj, key)?.ok_or_else(|| bad(template, &format!("{what} has no \"{key}\"")))
}

fn checklist_body(v: &serde_json::Value) -> Result<String> {
    let mut out = String::from("<ul class=\"checks\">");
    for (i, it) in items("checklist", v, "items")?.iter().enumerate() {
        let what = format!("item {}", i + 1);
        let (text, done, note) = match it {
            serde_json::Value::String(t) if t.is_empty() => {
                return Err(bad("checklist", &format!("{what} is empty")));
            }
            serde_json::Value::String(t) => (t.clone(), false, None),
            serde_json::Value::Object(o) => {
                let done = match o.get("done") {
                    None | Some(serde_json::Value::Null) => false,
                    Some(serde_json::Value::Bool(b)) => *b,
                    Some(_) => {
                        return Err(bad(
                            "checklist",
                            &format!("{what}: \"done\" must be true or false"),
                        ));
                    }
                };
                (
                    req_text("checklist", o, "text", &what)?,
                    done,
                    opt_text("checklist", o, "note")?,
                )
            }
            _ => {
                return Err(bad(
                    "checklist",
                    &format!("{what} is neither a string nor an object"),
                ));
            }
        };
        out.push_str(&format!(
            "<li class=\"{}\"><span class=\"box\">{}</span><div><span class=\"t\">{}</span>",
            if done { "done" } else { "open" },
            if done { "\u{2713}" } else { "" },
            escape(&text)
        ));
        if let Some(n) = note {
            out.push_str(&format!("<p>{}</p>", escape(&n)));
        }
        out.push_str("</div></li>");
    }
    out.push_str("</ul>");
    Ok(out)
}

fn compare_body(v: &serde_json::Value) -> Result<String> {
    let mut out = String::from("<div class=\"compare\">");
    for (i, c) in items("compare", v, "columns")?.iter().enumerate() {
        let what = format!("column {}", i + 1);
        let obj = c
            .as_object()
            .ok_or_else(|| bad("compare", &format!("{what} is not an object")))?;
        let title = req_text("compare", obj, "title", &what)?;
        out.push_str(&format!("<div class=\"col\"><h2>{}</h2>", escape(&title)));
        match obj.get("points") {
            None | Some(serde_json::Value::Null) => {}
            Some(serde_json::Value::Array(points)) => {
                out.push_str("<ul>");
                for p in points {
                    let t = text_of(p).ok_or_else(|| {
                        bad(
                            "compare",
                            &format!("{what} has a point that is not a string or number"),
                        )
                    })?;
                    out.push_str(&format!("<li>{}</li>", escape(&t)));
                }
                out.push_str("</ul>");
            }
            Some(_) => {
                return Err(bad(
                    "compare",
                    &format!("{what}: \"points\" must be an array"),
                ));
            }
        }
        out.push_str("</div>");
    }
    out.push_str("</div>");
    Ok(out)
}

fn timeline_body(v: &serde_json::Value) -> Result<String> {
    let mut out = String::from("<ol class=\"timeline\">");
    for (i, e) in items("timeline", v, "events")?.iter().enumerate() {
        let what = format!("event {}", i + 1);
        let obj = e
            .as_object()
            .ok_or_else(|| bad("timeline", &format!("{what} is not an object")))?;
        let when = req_text("timeline", obj, "when", &what)?;
        let title = req_text("timeline", obj, "title", &what)?;
        out.push_str(&format!(
            "<li><span class=\"when\">{}</span><h2>{}</h2>",
            escape(&when),
            escape(&title)
        ));
        if let Some(d) = opt_text("timeline", obj, "detail")? {
            out.push_str(&format!("<p>{}</p>", escape(&d)));
        }
        out.push_str("</li>");
    }
    out.push_str("</ol>");
    Ok(out)
}

fn stats_body(v: &serde_json::Value) -> Result<String> {
    let mut out = String::from("<div class=\"stats\">");
    for (i, s) in items("stats", v, "stats")?.iter().enumerate() {
        let what = format!("stat {}", i + 1);
        let obj = s
            .as_object()
            .ok_or_else(|| bad("stats", &format!("{what} is not an object")))?;
        let label = req_text("stats", obj, "label", &what)?;
        let value = req_text("stats", obj, "value", &what)?;
        out.push_str(&format!(
            "<div class=\"stat\"><span class=\"label\">{}</span><span class=\"value\">{}</span>",
            escape(&label),
            escape(&value)
        ));
        if let Some(n) = opt_text("stats", obj, "note")? {
            out.push_str(&format!("<p>{}</p>", escape(&n)));
        }
        out.push_str("</div>");
    }
    out.push_str("</div>");
    Ok(out)
}

fn callout_body(v: &serde_json::Value) -> Result<String> {
    let obj = v
        .as_object()
        .ok_or_else(|| bad("callout", "the JSON is not an object"))?;
    let text = req_text("callout", obj, "text", "the callout")?;
    let by = opt_text("callout", obj, "by")?;
    let tone = opt_text("callout", obj, "tone")?.unwrap_or_else(|| "info".into());
    if !matches!(tone.as_str(), "info" | "good" | "warn" | "bad") {
        return Err(bad("callout", "\"tone\" must be info, good, warn or bad"));
    }
    let mut out = format!("<div class=\"callout {tone}\">");
    match by {
        Some(by) => out.push_str(&format!(
            "<blockquote>{}</blockquote><cite>{}</cite>",
            escape(&text),
            escape(&by)
        )),
        None => out.push_str(&format!("<p class=\"msg\">{}</p>", escape(&text))),
    }
    out.push_str("</div>");
    Ok(out)
}

/// Nested tree nodes: an object `{title, children?}` or a bare string leaf.
fn tree_node(v: &serde_json::Value, path: &str) -> Result<String> {
    let (title, children) = match v {
        serde_json::Value::String(t) if t.is_empty() => {
            return Err(bad("tree", &format!("{path} is empty")));
        }
        serde_json::Value::String(t) => (t.clone(), None),
        serde_json::Value::Object(o) => (
            req_text("tree", o, "title", path)?,
            match o.get("children") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::Array(a)) => Some(a),
                Some(_) => {
                    return Err(bad(
                        "tree",
                        &format!("{path}: \"children\" must be an array"),
                    ));
                }
            },
        ),
        _ => {
            return Err(bad(
                "tree",
                &format!("{path} is neither a string nor an object"),
            ));
        }
    };
    let mut out = format!("<li><div class=\"node\">{}</div>", escape(&title));
    if let Some(kids) = children.filter(|k| !k.is_empty()) {
        out.push_str("<ul>");
        for (i, k) in kids.iter().enumerate() {
            out.push_str(&tree_node(k, &format!("{path}.{}", i + 1))?);
        }
        out.push_str("</ul>");
    }
    out.push_str("</li>");
    Ok(out)
}

fn tree_body(v: &serde_json::Value) -> Result<String> {
    let root = match v {
        serde_json::Value::Object(o) => o
            .get("root")
            .ok_or_else(|| bad("tree", "\"root\" is missing"))?,
        _ => return Err(bad("tree", "the JSON is not an object")),
    };
    Ok(format!(
        "<ul class=\"tree\">{}</ul>",
        tree_node(root, "root")?
    ))
}

/// The look follows docs/style-guide.md: Inter first, tinted rounded
/// surfaces, a hairline ring rather than an outline. Every colour is a
/// `--naru-*` theme variable (naru task 1792, `frontend/src/boardTheme.ts`)
/// with the old palette as its fallback: a frame the page never themed (opened
/// directly) still follows the viewer's colour scheme.
const TEMPLATE_CSS: &str = "\
:root{color-scheme:var(--naru-color-scheme,light dark);--bg:var(--naru-bg,#f6f8fb);--fg:var(--naru-fg,#14202e);\
--muted:var(--naru-muted,#5b6b7e);--surface:var(--naru-surface,#e9f2f8);\
--raised:var(--naru-raised,#fff);--ring:var(--naru-ring,rgba(20,60,100,.14));\
--accent:var(--naru-accent,#0a8fb0);--accent2:var(--naru-accent-2,#6234c8);\
--good:var(--naru-good,#0e7440);--warn:var(--naru-warn,#965600);--bad:var(--naru-bad,#be1c38)}\
@media(prefers-color-scheme:dark){:root{--bg:var(--naru-bg,#0b1220);--fg:var(--naru-fg,#e6edf5);\
--muted:var(--naru-muted,#93a3b8);--surface:var(--naru-surface,#111d2f);\
--raised:var(--naru-raised,#16253b);--ring:var(--naru-ring,rgba(120,190,230,.2));\
--accent:var(--naru-accent,#4cc9f0);--accent2:var(--naru-accent-2,#b06bff);\
--good:var(--naru-good,#2bff9c);--warn:var(--naru-warn,#ffb444);--bad:var(--naru-bad,#ff3b5c)}}\
*{box-sizing:border-box}\
body{margin:0;padding:20px;background:var(--bg);color:var(--fg);\
font:15px/1.45 Inter,system-ui,-apple-system,'Segoe UI',sans-serif}\
h2{margin:0 0 6px;font-size:16px;font-weight:600}p{margin:0;color:var(--muted)}\
.wrap{overflow-x:auto;border-radius:12px;background:var(--surface);box-shadow:0 0 0 1px var(--ring)}\
table{border-collapse:collapse;width:100%}\
th,td{padding:10px 14px;text-align:left;vertical-align:top}\
th{font-weight:600;color:var(--accent);border-bottom:1px solid var(--ring)}\
tbody tr:nth-child(even){background:var(--raised)}\
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}\
.card,.step,.col,.stat{background:var(--surface);border-radius:12px;padding:14px 16px;\
box-shadow:0 0 0 1px var(--ring)}\
.tag{display:inline-block;margin-bottom:8px;padding:2px 9px;border-radius:999px;\
background:var(--raised);color:var(--accent);font-size:12px;font-weight:600;\
box-shadow:0 0 0 1px var(--ring)}\
.flow{display:flex;flex-wrap:wrap;align-items:stretch;gap:10px}\
.step{flex:0 1 220px}\
.num{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;\
margin-bottom:8px;border-radius:50%;background:var(--accent);color:var(--bg);\
font-size:13px;font-weight:700}\
.arrow{align-self:center;color:var(--accent);font-size:22px}\
.checks{list-style:none;margin:0;padding:0;display:grid;gap:8px}\
.checks li{display:flex;gap:12px;align-items:flex-start;background:var(--surface);\
border-radius:12px;padding:12px 16px;box-shadow:0 0 0 1px var(--ring)}\
.box{flex:none;width:22px;height:22px;border-radius:6px;display:inline-flex;\
align-items:center;justify-content:center;font-size:14px;font-weight:700;\
box-shadow:0 0 0 2px var(--ring) inset}\
.done .box{background:var(--good);color:var(--bg);box-shadow:none}\
.done .t{color:var(--muted);text-decoration:line-through}\
.compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}\
.col h2{padding-bottom:8px;margin-bottom:8px;color:var(--accent);border-bottom:1px solid var(--ring)}\
.col ul{margin:0;padding-left:18px}.col li{margin:4px 0}\
.timeline{list-style:none;margin:0;padding:0 0 0 18px;border-left:2px solid var(--ring)}\
.timeline li{position:relative;padding:0 0 18px 18px}\
.timeline li::before{content:'';position:absolute;left:-26px;top:5px;width:12px;height:12px;\
border-radius:50%;background:var(--accent2);box-shadow:0 0 0 3px var(--bg)}\
.when{display:block;margin-bottom:2px;color:var(--accent);font-size:12px;font-weight:600}\
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}\
.label{display:block;color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;\
letter-spacing:.04em}\
.value{display:block;margin:4px 0;color:var(--accent);font-size:30px;font-weight:700;line-height:1.1}\
.callout{border-radius:12px;padding:18px 22px;background:var(--surface);\
box-shadow:0 0 0 1px var(--ring),inset 4px 0 0 var(--accent)}\
.callout.good{box-shadow:0 0 0 1px var(--ring),inset 4px 0 0 var(--good)}\
.callout.warn{box-shadow:0 0 0 1px var(--ring),inset 4px 0 0 var(--warn)}\
.callout.bad{box-shadow:0 0 0 1px var(--ring),inset 4px 0 0 var(--bad)}\
.callout .msg,blockquote{margin:0;color:var(--fg);font-size:18px}\
cite{display:block;margin-top:8px;color:var(--muted);font-size:13px;font-style:normal}\
cite::before{content:'\\2014 '}\
.tree,.tree ul{list-style:none;margin:0;padding:0}\
.tree ul{margin-left:14px;padding-left:18px;border-left:2px solid var(--ring)}\
.tree li{margin:8px 0}\
.node{display:inline-block;padding:6px 12px;border-radius:10px;background:var(--surface);\
box-shadow:0 0 0 1px var(--ring)}\
.tree>li>.node{background:var(--accent);color:var(--bg);font-weight:600}";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::{Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeKind};

    /// The ink rides beside the board under the board's own stem, so a
    /// titled board and an untitled one both keep a recognisable pair.
    #[test]
    fn html_text_keeps_a_bare_less_than_as_text() {
        assert_eq!(html_text("a 1 < 2 <b>b</b> c<3"), "a 1 < 2  b  c<3");
        assert_eq!(html_text("x <"), "x <");
    }

    #[test]
    fn ink_filename_is_the_board_stem_plus_ink_png() {
        assert_eq!(ink_filename("plan.md"), "plan-ink.png");
        assert_eq!(ink_filename("board-7.svg"), "board-7-ink.png");
        assert_eq!(ink_filename("notes"), "notes-ink.png");
    }

    #[test]
    fn every_template_shape_is_json_and_named_in_its_error() {
        for t in TEMPLATES {
            let shape = template_shape(t);
            serde_json::from_str::<serde_json::Value>(shape)
                .unwrap_or_else(|e| panic!("{t} shape is not JSON: {e}"));
            let Err(Error::Validation(m)) = template_html(t, "{}") else {
                panic!("{t}: an empty object should be a validation error");
            };
            assert!(m.contains(shape), "{t}: {m}");
        }
        let Err(Error::Validation(m)) = template_html("compare", "{}") else {
            panic!("compare accepted {{}}");
        };
        assert!(m.contains("columns") && m.contains("points"), "{m}");
    }

    fn workflow() -> Workflow {
        Workflow {
            id: 1,
            project_id: None,
            name: "Flow & <plan>".into(),
            description: None,
            trigger: None,
            trigger_phrase: None,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
            last_run_at: None,
            last_run_status: None,
            last_failure_at: None,
            next_run_at: None,
            trigger_events: vec![],
            enabled: true,
            types: vec![],
        }
    }

    fn node(id: i64, title: &str, x: f64, y: f64) -> WorkflowNode {
        WorkflowNode {
            id,
            workflow_id: 1,
            kind: WorkflowNodeKind::Cli,
            title: title.into(),
            config: serde_json::json!({}),
            x,
            y,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        }
    }

    fn edge(from: i64, to: i64, branch: Option<&str>) -> WorkflowEdge {
        WorkflowEdge {
            id: 1,
            workflow_id: 1,
            from_node: from,
            to_node: to,
            branch: branch.map(String::from),
            from_pin: None,
            to_pin: None,
        }
    }

    fn board(kind: LiveBoardKind, title: Option<&str>, content_type: Option<&str>) -> LiveBoard {
        LiveBoard {
            id: 4,
            session_id: 1,
            kind,
            title: title.map(str::to_string),
            body: "x".into(),
            content_type: content_type.map(str::to_string),
            created_at: "2026-01-01 00:00:00".into(),
            pinned_at: None,
        }
    }

    /// The extension is **always** the one the kind (or an image's recorded
    /// `content_type`) implies — never one read off the caption, which is free
    /// text a caller writes. The only thing the title decides is the stem, and
    /// the one skip is a title that already ends in the very extension that
    /// would have been appended.
    #[test]
    fn filename_takes_its_extension_from_the_kind_never_from_the_title() {
        use LiveBoardKind::*;
        assert_eq!(
            filename(&board(Markdown, Some("The plan"), None)),
            "The plan.md"
        );
        assert_eq!(filename(&board(Markdown, Some("plan.md"), None)), "plan.md");
        assert_eq!(filename(&board(Html, None, None)), "board-4.html");
        assert_eq!(
            filename(&board(Diagram, Some("The flow"), None)),
            "The flow.svg"
        );
        assert_eq!(
            filename(&board(Image, Some("shot"), Some("image/webp"))),
            "shot.webp"
        );
        // A caption claiming another format does not get to name the file: the
        // recorded content type is what the bytes are.
        assert_eq!(
            filename(&board(Image, Some("shot.jpg"), Some("image/png"))),
            "shot.jpg.png"
        );
        // An image with no recorded type cannot happen (`Store` refuses one),
        // and if it somehow did the fallback is still a derived extension.
        assert_eq!(filename(&board(Image, None, None)), "board-4.png");
    }

    #[test]
    fn renders_nodes_and_edges_inside_a_content_sized_viewbox() {
        let view = WorkflowView {
            workflow: workflow(),
            nodes: vec![node(1, "Start", 100.0, 100.0), node(2, "End", 400.0, 300.0)],
            edges: vec![edge(1, 2, Some("true"))],
        };
        let svg = workflow_svg(&view);
        assert!(
            svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""),
            "{svg}"
        );
        assert!(svg.ends_with("</svg>\n"), "{svg}");
        // The box is the content plus PAD on every side, not the origin.
        assert!(svg.contains("viewBox=\"76 76 548 312\""), "{svg}");
        assert!(svg.contains(">Start</text>"), "{svg}");
        assert!(svg.contains(">End</text>"), "{svg}");
        assert!(svg.contains(">cli</text>"), "{svg}");
        // Centre to centre: (200,132) -> (500,332).
        assert!(
            svg.contains("<line x1=\"200\" y1=\"132\" x2=\"500\" y2=\"332\""),
            "{svg}"
        );
        assert!(svg.contains(">true</text>"), "{svg}");
    }

    /// Every string that reaches the picture is data: the output is markup a
    /// browser parses, and a node title may come from an untrusted source.
    #[test]
    fn escapes_every_piece_of_text_it_writes() {
        let view = WorkflowView {
            workflow: workflow(),
            nodes: vec![node(1, "<script>alert('x')</script>", 0.0, 0.0)],
            edges: vec![],
        };
        let svg = workflow_svg(&view);
        assert!(!svg.contains("<script>"), "{svg}");
        assert!(
            svg.contains("&lt;script&gt;alert(&apos;x&apos;)&lt;/script&gt;"),
            "{svg}"
        );
        // The workflow's own name too.
        assert!(
            svg.contains("<title>Flow &amp; &lt;plan&gt;</title>"),
            "{svg}"
        );
    }

    /// An edge whose endpoint is missing (a node deleted between the two
    /// reads) is skipped rather than panicking or drawing a line to nowhere.
    #[test]
    fn skips_an_edge_whose_node_is_gone_and_still_renders_an_empty_workflow() {
        let view = WorkflowView {
            workflow: workflow(),
            nodes: vec![node(1, "Alone", 0.0, 0.0)],
            edges: vec![edge(1, 99, None)],
        };
        let svg = workflow_svg(&view);
        assert!(!svg.contains("<line"), "{svg}");

        let empty = WorkflowView {
            workflow: workflow(),
            nodes: vec![],
            edges: vec![],
        };
        let svg = workflow_svg(&empty);
        assert!(svg.contains("<svg"), "{svg}");
        assert!(svg.contains("viewBox=\"-24 -24 368 228\""), "{svg}");
    }

    #[test]
    fn table_template_renders_strings_and_numbers() {
        let html = template_html(
            "table",
            r#"{"columns":["Name","Qty"],"rows":[["a",1],["b",2.5]]}"#,
        )
        .unwrap();
        assert!(html.contains("<th>Name</th><th>Qty</th>"), "{html}");
        assert!(html.contains("<td>a</td><td>1</td>"), "{html}");
        assert!(html.contains("<td>2.5</td>"), "{html}");
        assert!(!html.contains("<script"), "{html}");
    }

    #[test]
    fn cards_template_renders_both_shapes() {
        let obj = template_html(
            "cards",
            r#"{"cards":[{"title":"One","body":"b","tag":"new"},{"title":"Two"}]}"#,
        )
        .unwrap();
        assert!(obj.contains("<span class=\"tag\">new</span>"), "{obj}");
        assert!(obj.contains("<h2>Two</h2></div>"), "{obj}");
        let bare = template_html("cards", r#"[{"title":"Solo"}]"#).unwrap();
        assert!(bare.contains("<h2>Solo</h2>"), "{bare}");
    }

    #[test]
    fn flow_template_numbers_steps_and_joins_them_with_arrows() {
        for input in [
            r#"{"steps":[{"title":"A","detail":"d"},{"title":"B"}]}"#,
            r#"[{"title":"A","detail":"d"},{"title":"B"}]"#,
            r#"["A","B"]"#,
        ] {
            let html = template_html("flow", input).unwrap();
            assert!(
                html.contains("<span class=\"num\">1</span><h2>A</h2>"),
                "{html}"
            );
            assert!(
                html.contains("<span class=\"num\">2</span><h2>B</h2>"),
                "{html}"
            );
            assert_eq!(html.matches("class=\"arrow\"").count(), 1, "{html}");
        }
    }

    #[test]
    fn templates_escape_every_piece_of_text() {
        let evil = "<script>alert(\"x\")</script> & 'y'";
        let cases = [
            (
                "table",
                format!(
                    r#"{{"columns":["{0}"],"rows":[["{0}"]]}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
            (
                "cards",
                format!(
                    r#"{{"cards":[{{"title":"{0}","body":"{0}","tag":"{0}"}}]}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
            (
                "flow",
                format!(
                    r#"{{"steps":[{{"title":"{0}","detail":"{0}"}}]}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
            (
                "checklist",
                format!(
                    r#"{{"items":[{{"text":"{0}","note":"{0}"}}]}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
            (
                "compare",
                format!(
                    r#"{{"columns":[{{"title":"{0}","points":["{0}"]}}]}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
            (
                "timeline",
                format!(
                    r#"{{"events":[{{"when":"{0}","title":"{0}","detail":"{0}"}}]}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
            (
                "stats",
                format!(
                    r#"{{"stats":[{{"label":"{0}","value":"{0}","note":"{0}"}}]}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
            (
                "callout",
                format!(r#"{{"text":"{0}","by":"{0}"}}"#, evil.replace('"', "\\\"")),
            ),
            (
                "tree",
                format!(
                    r#"{{"root":{{"title":"{0}","children":[{{"title":"{0}"}},"{0}"]}}}}"#,
                    evil.replace('"', "\\\"")
                ),
            ),
        ];
        for (t, input) in cases {
            let html = template_html(t, &input).unwrap();
            assert!(!html.contains("<script"), "{t}: {html}");
            assert!(
                html.contains(
                    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;y&apos;"
                ),
                "{t}: {html}"
            );
        }
    }

    #[test]
    fn checklist_template_marks_done_items() {
        for input in [
            r#"{"items":[{"text":"A","done":true,"note":"n"},{"text":"B"}]}"#,
            r#"[{"text":"A","done":true,"note":"n"},"B"]"#,
        ] {
            let html = template_html("checklist", input).unwrap();
            assert!(
                html.contains("<li class=\"done\"><span class=\"box\">\u{2713}</span>"),
                "{html}"
            );
            assert!(html.contains("<p>n</p>"), "{html}");
            assert!(
                html.contains("<li class=\"open\"><span class=\"box\"></span>"),
                "{html}"
            );
        }
    }

    #[test]
    fn compare_template_lists_points_per_column() {
        let html = template_html(
            "compare",
            r#"{"columns":[{"title":"A","points":["x",2]},{"title":"B"}]}"#,
        )
        .unwrap();
        assert!(
            html.contains("<h2>A</h2><ul><li>x</li><li>2</li></ul>"),
            "{html}"
        );
        assert!(html.contains("<h2>B</h2></div>"), "{html}");
    }

    #[test]
    fn timeline_template_orders_events() {
        let html = template_html(
            "timeline",
            r#"[{"when":"Mon","title":"A","detail":"d"},{"when":2,"title":"B"}]"#,
        )
        .unwrap();
        assert!(
            html.contains("<span class=\"when\">Mon</span><h2>A</h2><p>d</p>"),
            "{html}"
        );
        assert!(
            html.contains("<span class=\"when\">2</span><h2>B</h2></li>"),
            "{html}"
        );
    }

    #[test]
    fn stats_template_renders_tiles() {
        let html = template_html(
            "stats",
            r#"{"stats":[{"label":"Users","value":1200,"note":"+4%"}]}"#,
        )
        .unwrap();
        assert!(
            html.contains(
                "<span class=\"label\">Users</span><span class=\"value\">1200</span><p>+4%</p>"
            ),
            "{html}"
        );
    }

    #[test]
    fn callout_template_quotes_when_attributed() {
        let plain = template_html("callout", r#"{"text":"Heads up"}"#).unwrap();
        assert!(
            plain.contains("<div class=\"callout info\"><p class=\"msg\">Heads up</p></div>"),
            "{plain}"
        );
        let quote =
            template_html("callout", r#"{"text":"Ship it","by":"Ada","tone":"good"}"#).unwrap();
        assert!(
            quote.contains(
                "<div class=\"callout good\"><blockquote>Ship it</blockquote><cite>Ada</cite></div>"
            ),
            "{quote}"
        );
    }

    #[test]
    fn tree_template_nests_children() {
        let html = template_html(
            "tree",
            r#"{"root":{"title":"R","children":[{"title":"A","children":["A1"]},"B"]}}"#,
        )
        .unwrap();
        assert!(
            html.contains(
                "<ul class=\"tree\"><li><div class=\"node\">R</div><ul><li><div class=\"node\">A</div><ul><li><div class=\"node\">A1</div></li></ul></li><li><div class=\"node\">B</div></li></ul></li></ul>"
            ),
            "{html}"
        );
    }

    #[test]
    fn template_css_colours_come_from_the_naru_theme_variables() {
        assert!(TEMPLATE_CSS.contains("--bg:var(--naru-bg,#f6f8fb)"));
        assert!(TEMPLATE_CSS.contains("--accent2:var(--naru-accent-2,"));
        assert!(TEMPLATE_CSS.contains("prefers-color-scheme:dark"));
    }

    #[test]
    fn optional_fields_refuse_non_text_but_allow_null() {
        let Err(Error::Validation(m)) = template_html("cards", r#"[{"title":"x","body":["a"]}]"#)
        else {
            panic!("expected validation");
        };
        assert!(
            m.contains("--template cards") && m.contains("\"body\""),
            "{m}"
        );
        let Err(Error::Validation(m)) = template_html("flow", r#"["A",""]"#) else {
            panic!("expected validation");
        };
        assert!(m.contains("step 2 is empty"), "{m}");
        assert!(template_html("cards", r#"[{"title":"x","body":null,"tag":null}]"#).is_ok());
    }

    #[test]
    fn templates_refuse_bad_input_naming_the_template() {
        let cases = [
            ("table", "not json"),
            ("table", r#"{"columns":["a","b"],"rows":[["1"]]}"#),
            ("table", r#"{"columns":["a"],"rows":[]}"#),
            ("table", r#"{"columns":["a"],"rows":[[{"x":1}]]}"#),
            ("table", r#"[1,2]"#),
            ("cards", r#"{"cards":[]}"#),
            ("cards", r#"{"cards":[{"body":"no title"}]}"#),
            ("cards", r#"{"cards":["x"]}"#),
            ("flow", r#"{"steps":[]}"#),
            ("flow", r#"{"steps":[{"detail":"no title"}]}"#),
            ("flow", r#"{"steps":[3]}"#),
            ("flow", r#"["A",""]"#),
            ("flow", r#"[{"title":"x","detail":["a"]}]"#),
            ("cards", r#"[{"title":"x","body":["a"]}]"#),
            ("cards", r#"[{"title":"x","tag":{"a":1}}]"#),
            ("flow", r#"{"nope":1}"#),
            ("checklist", r#"{"items":[]}"#),
            ("checklist", r#"[""]"#),
            ("checklist", r#"[{"note":"no text"}]"#),
            ("checklist", r#"[{"text":"x","done":"yes"}]"#),
            ("checklist", r#"[3]"#),
            ("compare", r#"{"columns":[{"points":["a"]}]}"#),
            ("compare", r#"{"columns":[{"title":"x","points":"a"}]}"#),
            ("compare", r#"{"columns":[{"title":"x","points":[[1]]}]}"#),
            ("timeline", r#"{"events":[{"title":"no when"}]}"#),
            ("timeline", r#"{"events":[{"when":"now"}]}"#),
            ("timeline", r#"{"events":["x"]}"#),
            ("stats", r#"{"stats":[{"label":"x"}]}"#),
            ("stats", r#"{"stats":[{"label":"x","value":[1]}]}"#),
            ("callout", r#"[1]"#),
            ("callout", r#"{"by":"no text"}"#),
            ("callout", r#"{"text":"x","tone":"loud"}"#),
            ("tree", r#"{"nope":1}"#),
            ("tree", r#"{"root":{"children":[]}}"#),
            (
                "tree",
                r#"{"root":{"title":"x","children":["a",{"title":"b","children":"c"}]}}"#,
            ),
            ("tree", r#"{"root":5}"#),
        ];
        for (t, input) in cases {
            match template_html(t, input) {
                Err(Error::Validation(m)) => {
                    assert!(m.contains(&format!("--template {t}")), "{m}");
                }
                other => panic!("{t} {input}: {other:?}"),
            }
        }
        assert!(matches!(
            template_html("grid", "{}"),
            Err(Error::Validation(_))
        ));
    }
}
