//! The bytes of a placement's config: the canonical form of RFC 8785 (the document's "Config").

use serde_json::{Map, Value};

/// The config in the canonical form of RFC 8785: no whitespace, the members of every object in
/// ascending order of their names as UTF-16 code units, strings with only `"`, `\` and the
/// controls escaped, and numbers as ECMAScript writes the nearest double.
///
/// # Errors
/// A message when a number is not finite as a double.
pub fn canonical(config: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let mut out = String::new();
    object(config, &mut out)?;
    Ok(out.into_bytes())
}

fn value(v: &Value, out: &mut String) -> Result<(), String> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = n.as_f64().filter(|f| f.is_finite());
            out.push_str(&number(
                f.ok_or_else(|| format!("the number {n} is not a double"))?,
            ));
        }
        Value::String(s) => string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                value(e, out)?;
            }
            out.push(']');
        }
        Value::Object(m) => object(m, out)?,
    }
    Ok(())
}

fn object(m: &Map<String, Value>, out: &mut String) -> Result<(), String> {
    let mut members: Vec<(&String, &Value)> = m.iter().collect();
    members.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    out.push('{');
    for (i, (k, v)) in members.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        string(k, out);
        out.push(':');
        value(v, out)?;
    }
    out.push('}');
    Ok(())
}

fn string(s: &str, out: &mut String) {
    use std::fmt::Write;
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript's `Number::toString` of a finite double, radix 10.
fn number(f: f64) -> String {
    ryu_js::Buffer::new().format_finite(f).to_string()
}
