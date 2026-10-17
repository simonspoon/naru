//! Typed pins for workflow nodes (naru task 1981, `docs/workflows.md`
//! "Typed pins").
//!
//! A type is a string: `string`, `number`, `bool`, `any`, `list<T>`, or the
//! name of a user-defined struct ([`WorkflowType`]) of the same workflow. An
//! untyped pin is `any`, which matches everything, so a workflow written
//! before types existed keeps working. A struct travels between nodes as one
//! JSON object (the node's output text); `break` and `make` nodes split and
//! combine it. Pure functions only — `Store` and the engine call them.

use serde_json::Value;

use crate::core::types::{WorkflowNode, WorkflowNodeKind, WorkflowType};

/// Type names a struct may not take.
pub const RESERVED: [&str; 5] = ["string", "number", "bool", "any", "list"];
pub const TYPES_MAX: usize = 50;
pub const FIELDS_MAX: usize = 32;
pub const PINS_MAX: usize = 16;
/// The one pin a struct-valued side of a break (input) or make (output) has.
pub const VALUE_PIN: &str = "value";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    In,
    Out,
}

fn ident(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && s.len() <= 40
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `list<T>` -> `Some(T)`.
fn list_elem(ty: &str) -> Option<&str> {
    ty.strip_prefix("list<")?.strip_suffix('>')
}

/// The struct a type ultimately names (through any `list<>` wrappers).
fn base(ty: &str) -> &str {
    match list_elem(ty) {
        Some(e) => base(e),
        None => ty,
    }
}

fn is_primitive(ty: &str) -> bool {
    matches!(ty, "string" | "number" | "bool" | "any")
}

pub fn find<'a>(types: &'a [WorkflowType], name: &str) -> Option<&'a WorkflowType> {
    types.iter().find(|t| t.name == name)
}

/// Whether `ty` is syntactically a type (a struct name is not looked up).
pub fn well_formed(ty: &str) -> bool {
    let b = base(ty);
    is_primitive(b) || (ident(b) && !RESERVED.contains(&b))
}

/// Whether `ty` is well formed and every struct it names is defined.
pub fn is_known(ty: &str, types: &[WorkflowType]) -> bool {
    well_formed(ty) && (is_primitive(base(ty)) || find(types, base(ty)).is_some())
}

/// Validates a workflow's whole type list: names, uniqueness
/// (case-insensitive), field types, no struct containing itself.
pub fn validate_types(types: &[WorkflowType]) -> std::result::Result<(), String> {
    if types.len() > TYPES_MAX {
        return Err(format!("a workflow has at most {TYPES_MAX} types"));
    }
    for (i, t) in types.iter().enumerate() {
        if !ident(&t.name) || RESERVED.contains(&t.name.to_ascii_lowercase().as_str()) {
            return Err(format!(
                "type name {:?} must be letters, digits and _ (starting with a letter, at most 40) and not string, number, bool, any or list",
                t.name
            ));
        }
        if types[..i]
            .iter()
            .any(|o| o.name.eq_ignore_ascii_case(&t.name))
        {
            return Err(format!("type {:?} is defined twice", t.name));
        }
        if t.fields.len() > FIELDS_MAX {
            return Err(format!("type {} has more than {FIELDS_MAX} fields", t.name));
        }
        for (j, f) in t.fields.iter().enumerate() {
            if !ident(&f.name) {
                return Err(format!(
                    "type {}: field name {:?} must be letters, digits and _ (at most 40)",
                    t.name, f.name
                ));
            }
            if t.fields[..j].iter().any(|o| o.name == f.name) {
                return Err(format!(
                    "type {}: field {:?} is defined twice",
                    t.name, f.name
                ));
            }
            if !is_known(&f.ty, types) {
                return Err(format!(
                    "type {}: field {} has unknown type {:?}",
                    t.name, f.name, f.ty
                ));
            }
        }
    }
    for t in types {
        let mut stack = vec![t.name.as_str()];
        let mut seen: Vec<&str> = Vec::new();
        while let Some(n) = stack.pop() {
            let Some(def) = find(types, n) else { continue };
            for f in &def.fields {
                let b = base(&f.ty);
                if b == t.name {
                    return Err(format!(
                        "type {} contains itself (through field {}); a struct cannot be recursive",
                        t.name, f.name
                    ));
                }
                if !seen.contains(&b) {
                    seen.push(b);
                    stack.push(b);
                }
            }
        }
    }
    Ok(())
}

/// Two pins may be wired iff either is `any` or they are the same type.
pub fn matches(from: &str, to: &str) -> bool {
    from == "any" || to == "any" || from == to
}

/// Checks the shape of a node's `config.pins` and answers it normalized:
/// `{"in":[{"name","ty"}], "out":[…]}`; either side may be absent.
pub fn validate_pins(pins: &Value) -> std::result::Result<Value, String> {
    let obj = pins
        .as_object()
        .ok_or("config \"pins\" must be an object with \"in\" and/or \"out\" lists")?;
    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        if k != "in" && k != "out" {
            return Err(format!(
                "config \"pins\": unknown key {k:?}; it takes in, out"
            ));
        }
        let list = v
            .as_array()
            .ok_or_else(|| format!("config \"pins\".{k} must be a list"))?;
        if list.len() > PINS_MAX {
            return Err(format!("config \"pins\".{k} has more than {PINS_MAX} pins"));
        }
        let mut norm: Vec<Value> = Vec::new();
        for p in list {
            let name = p.get("name").and_then(Value::as_str).unwrap_or_default();
            let ty = p.get("ty").and_then(Value::as_str).unwrap_or("any");
            if !ident(name) {
                return Err(format!(
                    "config \"pins\".{k}: pin name {name:?} must be letters, digits and _ (at most 40)"
                ));
            }
            if norm.iter().any(|n| n["name"] == name) {
                return Err(format!("config \"pins\".{k}: pin {name:?} is listed twice"));
            }
            if !well_formed(ty) {
                return Err(format!(
                    "config \"pins\".{k}: pin {name} has a bad type {ty:?}"
                ));
            }
            norm.push(serde_json::json!({"name": name, "ty": ty}));
        }
        out.insert(k.clone(), Value::Array(norm));
    }
    Ok(Value::Object(out))
}

fn declared(node: &WorkflowNode, side: Side) -> Vec<(String, String)> {
    let key = if side == Side::In { "in" } else { "out" };
    node.config
        .get("pins")
        .and_then(|p| p.get(key))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    Some((
                        p.get("name")?.as_str()?.to_string(),
                        p.get("ty")
                            .and_then(Value::as_str)
                            .unwrap_or("any")
                            .to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The struct a `break`/`make` node is for.
pub fn struct_of(node: &WorkflowNode) -> &str {
    node.config
        .get("struct")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// The type of one pin of `node`. `pin` `None` is the default (first
/// declared, else `any` for an untyped node). Err = no such pin.
pub fn pin_type(
    node: &WorkflowNode,
    side: Side,
    pin: Option<&str>,
    types: &[WorkflowType],
) -> std::result::Result<String, String> {
    let title = &node.title;
    match (node.kind, side) {
        (WorkflowNodeKind::Break, Side::In) | (WorkflowNodeKind::Make, Side::Out) => match pin {
            None => Ok(struct_of(node).to_string()),
            Some(p) if p == VALUE_PIN => Ok(struct_of(node).to_string()),
            Some(p) => Err(format!(
                "node {title:?} has no {side:?} pin {p:?} (only \"value\")"
            )),
        },
        (WorkflowNodeKind::Break, Side::Out) | (WorkflowNodeKind::Make, Side::In) => {
            let fields = find(types, struct_of(node)).map(|t| t.fields.as_slice());
            let Some(p) = pin else {
                return Err(format!(
                    "node {title:?} is a {}; name the field pin",
                    node.kind.as_str()
                ));
            };
            fields
                .and_then(|fs| fs.iter().find(|f| f.name == p))
                .map(|f| f.ty.clone())
                .ok_or_else(|| {
                    format!(
                        "node {title:?} ({}) has no field pin {p:?}",
                        struct_of(node)
                    )
                })
        }
        _ => {
            let pins = declared(node, side);
            match pin {
                None => Ok(pins
                    .first()
                    .map(|p| p.1.clone())
                    .unwrap_or_else(|| "any".into())),
                Some(p) => pins
                    .iter()
                    .find(|(n, _)| n == p)
                    .map(|(_, t)| t.clone())
                    .ok_or_else(|| format!("node {title:?} has no {side:?} pin {p:?}")),
            }
        }
    }
}

/// Everything a node's config names must exist in `types`: a break/make's
/// struct, every declared pin type.
pub fn check_node(node: &WorkflowNode, types: &[WorkflowType]) -> std::result::Result<(), String> {
    if matches!(node.kind, WorkflowNodeKind::Break | WorkflowNodeKind::Make)
        && find(types, struct_of(node)).is_none()
    {
        return Err(format!(
            "node {:?} is a {} of struct {:?}, which this workflow does not define",
            node.title,
            node.kind.as_str(),
            struct_of(node)
        ));
    }
    for side in [Side::In, Side::Out] {
        for (name, ty) in declared(node, side) {
            if !is_known(&ty, types) {
                return Err(format!(
                    "node {:?}: pin {name} uses type {ty:?}, which this workflow does not define",
                    node.title
                ));
            }
        }
    }
    Ok(())
}

/// Whether an edge `from.from_pin -> to.to_pin` type-checks; the Err names
/// both types.
pub fn check_edge(
    from: &WorkflowNode,
    to: &WorkflowNode,
    from_pin: Option<&str>,
    to_pin: Option<&str>,
    types: &[WorkflowType],
) -> std::result::Result<(), String> {
    let a = pin_type(from, Side::Out, from_pin, types)?;
    let b = pin_type(to, Side::In, to_pin, types)?;
    if matches(&a, &b) {
        Ok(())
    } else {
        Err(format!(
            "can't connect {a} to {b}: the pin types do not match"
        ))
    }
}

// ---- runtime values ----------------------------------------------------

/// Plain text a pin carries for a JSON value: a string raw, anything else
/// compact JSON.
pub fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `v` as compact JSON of type `ty`, struct fields in their declared order.
pub fn render(v: &Value, ty: &str, types: &[WorkflowType]) -> std::result::Result<String, String> {
    if let Some(elem) = list_elem(ty) {
        let items = v
            .as_array()
            .ok_or_else(|| format!("expected a list for {ty}, got {v}"))?;
        let parts: std::result::Result<Vec<String>, String> =
            items.iter().map(|i| render(i, elem, types)).collect();
        return Ok(format!("[{}]", parts?.join(",")));
    }
    if let Some(def) = find(types, ty) {
        let obj = v
            .as_object()
            .ok_or_else(|| format!("expected an object for {ty}, got {v}"))?;
        let mut parts = Vec::new();
        for f in &def.fields {
            let fv = obj
                .get(&f.name)
                .ok_or_else(|| format!("{ty} value is missing field {:?}", f.name))?;
            parts.push(format!(
                "{}:{}",
                Value::String(f.name.clone()),
                render(fv, &f.ty, types)?
            ));
        }
        return Ok(format!("{{{}}}", parts.join(",")));
    }
    let ok = match ty {
        "string" => v.is_string(),
        "number" => v.is_number(),
        "bool" => v.is_boolean(),
        _ => true,
    };
    if ok {
        Ok(v.to_string())
    } else {
        Err(format!("expected {ty}, got {v}"))
    }
}

/// Break: the value of `field` in the struct JSON `input`, as pin text.
pub fn break_field(
    input: &str,
    strukt: &str,
    field: &str,
    types: &[WorkflowType],
) -> std::result::Result<String, String> {
    let v: Value = serde_json::from_str(input.trim())
        .map_err(|e| format!("input is not JSON for {strukt}: {e}"))?;
    let def = find(types, strukt).ok_or_else(|| format!("unknown struct {strukt:?}"))?;
    let f = def
        .fields
        .iter()
        .find(|f| f.name == field)
        .ok_or_else(|| format!("{strukt} has no field {field:?}"))?;
    let fv = v
        .get(field)
        .ok_or_else(|| format!("{strukt} value is missing field {field:?}"))?;
    render(fv, &f.ty, types)?;
    Ok(match &f.ty[..] {
        "string" => value_text(fv),
        _ => render(fv, &f.ty, types)?,
    })
}

/// Make: assembles the struct JSON from `(field, pin text)` pairs.
pub fn make_struct(
    strukt: &str,
    values: &[(String, String)],
    types: &[WorkflowType],
) -> std::result::Result<String, String> {
    let def = find(types, strukt).ok_or_else(|| format!("unknown struct {strukt:?}"))?;
    let mut obj = serde_json::Map::new();
    for f in &def.fields {
        let text = values
            .iter()
            .find(|(n, _)| n == &f.name)
            .map(|(_, t)| t.as_str())
            .ok_or_else(|| format!("field {:?} of {strukt} has no input", f.name))?;
        let v = if f.ty == "string" {
            Value::String(text.to_string())
        } else {
            serde_json::from_str(text.trim())
                .map_err(|e| format!("field {:?} ({}): not JSON: {e}", f.name, f.ty))?
        };
        obj.insert(f.name.clone(), v);
    }
    render(&Value::Object(obj), strukt, types)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::WorkflowTypeField;

    fn review() -> Vec<WorkflowType> {
        vec![WorkflowType {
            name: "Review".into(),
            fields: vec![
                WorkflowTypeField {
                    name: "score".into(),
                    ty: "number".into(),
                },
                WorkflowTypeField {
                    name: "ok".into(),
                    ty: "bool".into(),
                },
                WorkflowTypeField {
                    name: "tags".into(),
                    ty: "list<string>".into(),
                },
            ],
        }]
    }

    #[test]
    fn types_validate_and_reject_cycles_and_dupes() {
        let t = review();
        assert!(validate_types(&t).is_ok());
        let mut bad = review();
        bad[0].fields[0].ty = "Review".into();
        assert!(validate_types(&bad).unwrap_err().contains("itself"));
        let mut bad = review();
        bad.push(WorkflowType {
            name: "review".into(),
            fields: vec![],
        });
        assert!(validate_types(&bad).unwrap_err().contains("twice"));
        let mut bad = review();
        bad[0].fields[0].ty = "Nope".into();
        assert!(validate_types(&bad).unwrap_err().contains("unknown type"));
        let mut bad = review();
        bad[0].name = "string".into();
        assert!(validate_types(&bad).is_err());
    }

    #[test]
    fn matching_is_any_or_equal() {
        assert!(matches("any", "number") && matches("Review", "any"));
        assert!(matches("Review", "Review") && !matches("number", "Review"));
        assert!(!matches("list<string>", "string"));
    }

    #[test]
    fn a_struct_round_trips_through_break_and_make_in_declared_order() {
        let t = review();
        let json = r#"{"score":4.5,"ok":true,"tags":["a","b"]}"#;
        let score = break_field(json, "Review", "score", &t).unwrap();
        let ok = break_field(json, "Review", "ok", &t).unwrap();
        let tags = break_field(json, "Review", "tags", &t).unwrap();
        assert_eq!((score.as_str(), ok.as_str()), ("4.5", "true"));
        let back = make_struct(
            "Review",
            &[
                ("ok".into(), ok),
                ("tags".into(), tags),
                ("score".into(), score),
            ],
            &t,
        )
        .unwrap();
        assert_eq!(back, json);
        assert!(
            break_field(
                r#"{"score":"x","ok":true,"tags":[]}"#,
                "Review",
                "score",
                &t
            )
            .is_err()
        );
    }
}
