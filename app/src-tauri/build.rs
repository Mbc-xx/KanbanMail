fn main() {
    write_components();
    tauri_build::build()
}

/// Writes `components.json` in OUT_DIR: the crates.io packages built into the app
/// for this target, as `[name, version, via]` (`via` = the direct dependency they
/// come through, empty when they are one). The app checks them for advisories.
fn write_components() {
    use std::process::Command;
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("Cargo.toml");
    let target = std::env::var("TARGET").unwrap();
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    println!("cargo:rerun-if-changed=../../Cargo.lock");
    println!("cargo:rerun-if-changed=build.rs");
    let output = Command::new(cargo)
        .args(["tree", "--offline", "--locked", "-e", "normal", "--prefix", "depth", "-f", "{p}", "--target", &target, "--manifest-path"])
        .arg(&manifest)
        .output();
    let mut list: Vec<(String, String, String)> = Vec::new();
    match output {
        Ok(out) if out.status.success() => {
            // stack[d] = (name, is_local) of the package last seen at depth d
            let mut stack: Vec<(String, bool)> = Vec::new();
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
                let Ok(depth) = line[..digits].parse::<usize>() else { continue };
                let mut parts = line[digits..].split_whitespace();
                let (Some(name), Some(version)) = (parts.next(), parts.next()) else { continue };
                let local = line.contains(" (/") || line.contains(" (\\") || line.contains(":\\");
                stack.truncate(depth);
                stack.push((name.to_string(), local));
                if local {
                    continue;
                }
                // The first package below the local crates is the direct dependency.
                let via = stack.iter().find(|(_, l)| !l).map(|(n, _)| n.clone()).unwrap_or_default();
                let via = if via == name { String::new() } else { via };
                let version = version.trim_start_matches('v').to_string();
                if !list.iter().any(|(n, v, _)| n == name && *v == version) {
                    list.push((name.to_string(), version, via));
                }
            }
        }
        Ok(out) => println!("cargo:warning=component list not written: {}", String::from_utf8_lossy(&out.stderr).trim()),
        Err(e) => println!("cargo:warning=component list not written: {e}"),
    }
    list.sort();
    let json = format!(
        "[{}]",
        list.iter().map(|(n, v, via)| format!("[\"{n}\",\"{v}\",\"{via}\"]")).collect::<Vec<_>>().join(",")
    );
    std::fs::write(std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("components.json"), json).unwrap();
}
