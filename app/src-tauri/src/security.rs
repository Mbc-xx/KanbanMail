//! The bell in the top bar: known vulnerabilities in the components built into
//! this version of the app (see `kanbanmail_core::advisories`).

use kanbanmail_core::advisories::{self, Advisory, Report};
use serde::Serialize;

/// Written by build.rs: the crates.io packages built into the app for this target.
const COMPONENTS: &str = include_str!(concat!(env!("OUT_DIR"), "/components.json"));
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// One check at a time (the timer and the "Check now" button may meet).
static CHECKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
pub struct SecurityView {
    #[serde(flatten)]
    report: Report,
    /// Advisories not yet shown in the panel (the number on the bell).
    unseen: usize,
    /// Vulnerabilities this check found that the previous one did not.
    new: Vec<Advisory>,
    /// Version of the running app.
    running: String,
}

fn view(report: Report, new: Vec<Advisory>) -> SecurityView {
    SecurityView {
        unseen: report.unseen(),
        report,
        new,
        running: APP_VERSION.to_string(),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The last result, without going on the network.
#[tauri::command]
pub fn security_status() -> SecurityView {
    view(advisories::load(), Vec::new())
}

/// Checks the components on OSV.dev: always with `force`, otherwise only when the
/// daily check is due. A failed check keeps the previous advisories.
#[tauri::command]
pub async fn security_check(force: bool) -> SecurityView {
    let _one = CHECKING.lock().await;
    let mut report = advisories::load();
    if !force && !report.due(now(), APP_VERSION) {
        return view(report, Vec::new());
    }
    let components = advisories::parse_components(COMPONENTS);
    let mut new = Vec::new();
    match advisories::check(&components).await {
        Ok(found) => {
            let before: Vec<String> = report.advisories.iter().map(|a| a.key()).collect();
            new = found
                .iter()
                .filter(|a| a.is_vulnerability() && !before.contains(&a.key()))
                .cloned()
                .collect();
            report.advisories = found;
            report.components = components.len();
            report.app_version = APP_VERSION.to_string();
            report.checked_at = Some(now());
            report.error = None;
            // Keys of advisories that are gone are not needed any more.
            let current: Vec<String> = report.advisories.iter().map(|a| a.key()).collect();
            report.seen.retain(|k| current.contains(k));
        }
        Err(e) => report.error = Some(format!("{e:#}")),
    }
    if let Err(e) = advisories::save(&report) {
        eprintln!("security report not saved: {e:#}");
    }
    view(report, new)
}

/// The panel was opened: everything in it has been seen.
#[tauri::command]
pub fn security_seen() -> Result<SecurityView, String> {
    let mut report = advisories::load();
    report.seen = report.advisories.iter().map(|a| a.key()).collect();
    advisories::save(&report).map_err(|e| format!("{e:#}"))?;
    Ok(view(report, Vec::new()))
}

/// Turns the daily check on or off.
#[tauri::command]
pub fn security_auto(auto: bool) -> Result<SecurityView, String> {
    let mut report = advisories::load();
    report.auto = auto;
    advisories::save(&report).map_err(|e| format!("{e:#}"))?;
    Ok(view(report, Vec::new()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_build_lists_the_components() {
        let list = kanbanmail_core::advisories::parse_components(super::COMPONENTS);
        assert!(list.len() > 100, "only {} components listed", list.len());
        assert!(
            list.iter().any(|c| c.name == "tauri" && c.via.is_empty()),
            "tauri is a direct dependency"
        );
        assert!(list.iter().any(|c| c.name == "lettre" && c.via.is_empty()));
        // Linux-only crates are not built on macOS.
        #[cfg(target_os = "macos")]
        assert!(!list.iter().any(|c| c.name == "glib"));
    }

    /// Asks OSV.dev for real: `cargo test -p kanbanmail live_check -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_check() {
        let list = kanbanmail_core::advisories::parse_components(super::COMPONENTS);
        for a in kanbanmail_core::advisories::check(&list).await.unwrap() {
            println!(
                "{} {} {} [{}] via={} → {:?}: {}",
                a.id, a.package, a.version, a.kind, a.via, a.upgrade_to, a.summary
            );
        }
    }
}
