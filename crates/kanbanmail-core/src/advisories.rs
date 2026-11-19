//! Known vulnerabilities in the components built into the app. The list of
//! components (crates.io packages and versions) is written at build time; it is
//! checked against OSV.dev (RustSec, GitHub advisories, CVE), which receives only
//! package names and versions. The last result is kept in `security.json`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

const OSV: &str = "https://api.osv.dev/v1";
const FILE: &str = "security.json";
/// An automatic check runs at most this often.
pub const AUTO_EVERY_SECS: i64 = 24 * 3600;

/// A package built into the app.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    pub name: String,
    pub version: String,
    /// The direct dependency it comes through; empty when it is one.
    #[serde(default)]
    pub via: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Advisory {
    /// RUSTSEC-…, GHSA-… or CVE-…
    pub id: String,
    /// Other names of the same advisory (CVE and GHSA ids among them).
    #[serde(default)]
    pub aliases: Vec<String>,
    pub package: String,
    pub version: String,
    #[serde(default)]
    pub via: String,
    pub summary: String,
    /// "vulnerability", or a notice: "unmaintained", "unsound", "notice".
    pub kind: String,
    /// Versions that fix it (empty: none yet).
    #[serde(default)]
    pub fixed: Vec<String>,
    /// The fixed version to move to: the lowest one above the version in use.
    #[serde(default)]
    pub upgrade_to: Option<String>,
    pub url: String,
    #[serde(default)]
    pub published: String,
}

/// What the security panel shows, as saved after the last check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    /// Unix seconds of the last completed check.
    #[serde(default)]
    pub checked_at: Option<i64>,
    /// The app version that was checked.
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub components: usize,
    #[serde(default)]
    pub advisories: Vec<Advisory>,
    /// Advisory keys (id + package + version) already shown in the panel.
    #[serde(default)]
    pub seen: Vec<String>,
    /// Check by itself once a day.
    #[serde(default = "yes")]
    pub auto: bool,
    /// Why the last check failed, if it did.
    #[serde(default)]
    pub error: Option<String>,
}

fn yes() -> bool {
    true
}

impl Default for Report {
    fn default() -> Self {
        Report { checked_at: None, app_version: String::new(), components: 0, advisories: Vec::new(), seen: Vec::new(), auto: true, error: None }
    }
}

impl Advisory {
    /// The same advisory on the same package version.
    pub fn key(&self) -> String {
        format!("{} {} {}", self.id, self.package, self.version)
    }
    pub fn is_vulnerability(&self) -> bool {
        self.kind == "vulnerability"
    }
}

impl Report {
    /// Advisories not yet shown in the panel.
    pub fn unseen(&self) -> usize {
        self.advisories.iter().filter(|a| !self.seen.contains(&a.key())).count()
    }
    /// An automatic check is due.
    pub fn due(&self, now: i64, app_version: &str) -> bool {
        self.auto && (self.app_version != app_version || self.checked_at.is_none_or(|t| now - t >= AUTO_EVERY_SECS))
    }
}

fn path() -> Result<PathBuf> {
    Ok(crate::account::root_dir()?.join(FILE))
}

pub fn load() -> Report {
    path().ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(report: &Report) -> Result<()> {
    let path = path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(report)?).with_context(|| format!("cannot write {}", path.display()))
}

/// Parses the list written by the build: `[[name, version, via], …]`.
pub fn parse_components(json: &str) -> Vec<Component> {
    serde_json::from_str::<Vec<(String, String, String)>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, version, via)| Component { name, version, via })
        .collect()
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(crate::imap::tls_config())
        .timeout(Duration::from_secs(30))
        .user_agent("Pigeonhole")
        .build()
        .context("cannot set up HTTPS")
}

async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> Result<Value> {
    let reply = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("OSV.dev could not be reached")?;
    anyhow::ensure!(reply.status().is_success(), "OSV.dev answered {}", reply.status());
    Ok(serde_json::from_slice(&reply.bytes().await?)?)
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let reply = client.get(url).send().await.context("OSV.dev could not be reached")?;
    anyhow::ensure!(reply.status().is_success(), "OSV.dev answered {}", reply.status());
    Ok(serde_json::from_slice(&reply.bytes().await?)?)
}

/// Asks OSV.dev which advisories touch these components.
pub async fn check(components: &[Component]) -> Result<Vec<Advisory>> {
    anyhow::ensure!(!components.is_empty(), "this build has no list of its components");
    let client = http()?;
    // Which advisory ids touch which component.
    let mut hits: Vec<(usize, String)> = Vec::new();
    for (start, chunk) in components.chunks(500).enumerate().map(|(i, c)| (i * 500, c)) {
        let queries: Vec<Value> =
            chunk.iter().map(|c| json!({ "package": { "name": c.name, "ecosystem": "crates.io" }, "version": c.version })).collect();
        let answer = post_json(&client, &format!("{OSV}/querybatch"), &json!({ "queries": queries })).await?;
        let results = answer["results"].as_array().context("unexpected answer from OSV.dev")?;
        for (i, result) in results.iter().enumerate() {
            for v in result["vulns"].as_array().into_iter().flatten() {
                if let Some(id) = v["id"].as_str() {
                    hits.push((start + i, id.to_string()));
                }
            }
        }
    }
    // The details of each advisory, once.
    let mut details: std::collections::HashMap<String, Value> = Default::default();
    for (_, id) in &hits {
        if !details.contains_key(id) {
            details.insert(id.clone(), get_json(&client, &format!("{OSV}/vulns/{id}")).await?);
        }
    }
    let mut out: Vec<Advisory> = hits.iter().map(|(i, id)| advisory(&components[*i], id, &details[id])).collect();
    // A GHSA that repeats a RustSec advisory on the same package says nothing new.
    let same = |a: &Advisory, b: &Advisory| a.package == b.package && a.version == b.version && b.aliases.contains(&a.id);
    let copy: Vec<Advisory> = out.clone();
    out.retain(|a| !(a.id.starts_with("GHSA-") && copy.iter().any(|b| b.id.starts_with("RUSTSEC-") && same(a, b))));
    out.sort_by(|a, b| (!a.is_vulnerability(), &a.package, &a.id).cmp(&(!b.is_vulnerability(), &b.package, &b.id)));
    Ok(out)
}

fn advisory(component: &Component, id: &str, v: &Value) -> Advisory {
    let strings = |x: &Value| x.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect::<Vec<_>>();
    let affected: Vec<&Value> = v["affected"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["package"]["name"].as_str() == Some(component.name.as_str()))
        .collect();
    let informational = affected.iter().find_map(|a| a["database_specific"]["informational"].as_str()).map(String::from);
    let mut fixed: Vec<String> = Vec::new();
    for a in &affected {
        for r in a["ranges"].as_array().into_iter().flatten() {
            for e in r["events"].as_array().into_iter().flatten() {
                if let Some(f) = e["fixed"].as_str() {
                    if !fixed.iter().any(|x| x == f) {
                        fixed.push(f.to_string());
                    }
                }
            }
        }
    }
    let upgrade_to = fixed.iter().filter(|f| newer(f, &component.version)).min_by(|a, b| cmp_versions(a, b)).cloned();
    let summary = v["summary"].as_str().or(v["details"].as_str()).unwrap_or("").lines().next().unwrap_or("").trim().to_string();
    let url = if id.starts_with("RUSTSEC-") {
        format!("https://rustsec.org/advisories/{id}.html")
    } else {
        format!("https://osv.dev/vulnerability/{id}")
    };
    Advisory {
        id: id.to_string(),
        aliases: strings(&v["aliases"]),
        package: component.name.clone(),
        version: component.version.clone(),
        via: component.via.clone(),
        summary,
        kind: informational.unwrap_or_else(|| "vulnerability".into()),
        fixed,
        upgrade_to,
        url,
        published: v["published"].as_str().unwrap_or("").chars().take(10).collect(),
    }
}

fn numbers(v: &str) -> Vec<u64> {
    v.split(['-', '+']).next().unwrap_or("").split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    numbers(a).cmp(&numbers(b))
}

fn newer(a: &str, b: &str) -> bool {
    cmp_versions(a, b) == std::cmp::Ordering::Greater
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_osv_record() {
        let record = json!({
            "id": "RUSTSEC-2026-0533",
            "summary": "Incorrect handling of embedded SVG and MathML leads to mutation XSS",
            "aliases": ["GHSA-934p-vp7m-gx3c"],
            "published": "2026-10-02T12:00:00Z",
            "affected": [{
                "package": { "name": "ammonia", "ecosystem": "crates.io" },
                "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "0" }, { "fixed": "3.3.5" }, { "introduced": "4.0.0" }, { "fixed": "4.1.9" }, { "introduced": "4.2.0" }, { "fixed": "4.2.5" }] }],
                "database_specific": { "informational": null }
            }]
        });
        let c = Component { name: "ammonia".into(), version: "4.2.4".into(), via: String::new() };
        let a = advisory(&c, "RUSTSEC-2026-0533", &record);
        assert_eq!(a.kind, "vulnerability");
        assert_eq!(a.upgrade_to.as_deref(), Some("4.2.5"));
        assert_eq!(a.published, "2026-10-02");
        assert_eq!(a.url, "https://rustsec.org/advisories/RUSTSEC-2026-0533.html");
    }

    #[test]
    fn unmaintained_is_a_notice() {
        let record = json!({ "id": "RUSTSEC-2026-0543", "summary": "chrono is unmaintained", "affected": [{ "package": { "name": "chrono" }, "database_specific": { "informational": "unmaintained" } }] });
        let c = Component { name: "chrono".into(), version: "0.4.45".into(), via: "async-imap".into() };
        let a = advisory(&c, "RUSTSEC-2026-0543", &record);
        assert_eq!(a.kind, "unmaintained");
        assert!(a.upgrade_to.is_none());
    }

    #[test]
    fn due_once_a_day_or_after_an_update() {
        let mut r = Report { checked_at: Some(1_000_000), app_version: "2.14.0".into(), ..Default::default() };
        assert!(!r.due(1_000_000 + 3600, "2.14.0"));
        assert!(r.due(1_000_000 + AUTO_EVERY_SECS, "2.14.0"));
        assert!(r.due(1_000_000 + 60, "2.15.0"));
        r.auto = false;
        assert!(!r.due(1_000_000 + AUTO_EVERY_SECS, "2.15.0"));
    }

    #[test]
    fn parses_the_build_list() {
        let list = parse_components(r#"[["ammonia","4.2.5",""],["chrono","0.4.45","async-imap"]]"#);
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].via, "async-imap");
    }
}
