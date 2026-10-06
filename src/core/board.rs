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
        WorkflowNodeKind::Prompt => "#a78bfa",
        WorkflowNodeKind::Cli => "#00e5ff",
        WorkflowNodeKind::Script => "#4ade80",
        WorkflowNodeKind::Branch => "#fb7185",
        WorkflowNodeKind::Decide => "#f472b6",
        WorkflowNodeKind::Output => "#94a3b8",
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
}
