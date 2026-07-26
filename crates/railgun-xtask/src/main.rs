use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::{Path, PathBuf},
    process::Command,
};

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command, mode] if command == "legal" && matches!(mode.as_str(), "--write" | "--check") => {
            legal(mode == "--write")
        }
        [command, operation, name] if command == "migration" && operation == "new" => {
            migration_new(name)
        }
        [command, operation] if command == "migration" && operation == "check" => migration_check(),
        [command] if command == "fixtures" => fixture_check(),
        [command] if command == "perf" => performance_harness().await,
        _ => bail!(
            "usage: cargo xtask <legal --write|--check|migration new NAME|migration check|fixtures|perf>"
        ),
    }
}

fn repository_root() -> Result<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    Ok(root)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct LegalComponent {
    record: Value,
    notice: String,
}

fn legal(write: bool) -> Result<()> {
    let root = repository_root()?;
    let legal = root.join("apps/macos/Resources/Legal");
    let manifest_path = legal.join("LegalNoticeManifest.json");
    let notices_path = legal.join("ThirdPartyNotices.md");
    let old: Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    let mut components = old["components"]
        .as_array()
        .context("legal manifest has no components")?
        .iter()
        .filter(|component| !matches!(component["kind"].as_str(), Some("rust-crate")))
        .map(|record| static_legal_component(&root, &legal, record.clone()))
        .collect::<Result<Vec<_>>>()?;
    components.extend(backend_crate_components(&root, &legal)?);
    let notices = render_notices(&components);
    let component_records = components
        .into_iter()
        .map(|component| component.record)
        .collect::<Vec<_>>();
    let lockfile = std::fs::read(root.join("Cargo.lock"))?;
    let manifest = json!({
        "schemaVersion": 3,
        "backendLockfileSHA256": hash(&lockfile),
        "components": component_records,
    });
    let manifest_text = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
    if write {
        std::fs::write(&manifest_path, manifest_text)?;
        std::fs::write(&notices_path, notices)?;
        println!("updated Rust and native legal notices");
        return Ok(());
    }
    if std::fs::read_to_string(&manifest_path)? != manifest_text
        || std::fs::read_to_string(&notices_path)? != notices
    {
        bail!("legal notices are stale; run `cargo xtask legal --write`");
    }
    Ok(())
}

fn normalize_notice(raw: &str) -> String {
    let normalized = raw
        .replace("\r\n", "\n")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    format!("{}\n", normalized.trim_end())
}

fn static_legal_component(root: &Path, legal: &Path, mut record: Value) -> Result<LegalComponent> {
    let identifier = record["identifier"]
        .as_str()
        .context("legal component has no identifier")?;
    let notice = match identifier {
        "swift-markdown" => read_notice(&legal.join("Sources/Apache-2.0.txt"))?,
        "swift-cmark" => read_notice(&legal.join("Sources/Swift-CMark-COPYING.txt"))?,
        "sparkle" => read_notice(&legal.join("Sources/Sparkle-LICENSE.txt"))?,
        "barlow" => read_notice(&legal.join("Sources/Barlow-OFL.txt"))?,
        "departure-mono-nerd-font" => {
            read_notice(&legal.join("Sources/DepartureMonoNerdFont-OFL.txt"))?
        }
        "railgun-icon-artwork" => normalize_notice(
            "© 2026 Dante Teo. Railgun icon artwork is first-party material and is distributed under the Railgun MIT License.",
        ),
        "railgun" => read_notice(&root.join("LICENSE"))?,
        other => bail!("no bundled notice source is configured for {other}"),
    };
    record["noticeContentSHA256"] = Value::String(hash(notice.as_bytes()));
    Ok(LegalComponent { record, notice })
}

fn backend_crate_components(root: &Path, legal: &Path) -> Result<Vec<LegalComponent>> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "metadata",
            "--locked",
            "--filter-platform",
            "aarch64-apple-darwin",
            "--format-version",
            "1",
        ])
        .current_dir(root)
        .output()
        .context("failed to run cargo metadata for legal notices")?;
    if !output.status.success() {
        bail!(
            "cargo metadata failed while generating legal notices: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let metadata: Value = serde_json::from_slice(&output.stdout)?;
    let packages = metadata["packages"]
        .as_array()
        .context("cargo metadata has no packages")?;
    let package_by_id = packages
        .iter()
        .filter_map(|package| Some((package["id"].as_str()?.to_owned(), package)))
        .collect::<BTreeMap<_, _>>();
    let backend_id = packages
        .iter()
        .find(|package| package["name"] == "railgun-backend" && package["source"].is_null())
        .and_then(|package| package["id"].as_str())
        .context("cargo metadata does not contain the railgun-backend workspace package")?;
    let nodes = metadata["resolve"]["nodes"]
        .as_array()
        .context("cargo metadata has no dependency resolution")?;
    let node_by_id = nodes
        .iter()
        .filter_map(|node| Some((node["id"].as_str()?.to_owned(), node)))
        .collect::<BTreeMap<_, _>>();

    let mut queue = VecDeque::from([backend_id.to_owned()]);
    let mut closure = BTreeSet::new();
    while let Some(id) = queue.pop_front() {
        if !closure.insert(id.clone()) {
            continue;
        }
        let node = node_by_id
            .get(&id)
            .with_context(|| format!("cargo metadata has no dependency node for {id}"))?;
        for dependency in node["deps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|dependency| dependency_is_distributable(dependency))
        {
            if let Some(package_id) = dependency["pkg"].as_str() {
                queue.push_back(package_id.to_owned());
            }
        }
    }

    let mut crates = BTreeMap::new();
    for id in closure {
        let package = package_by_id
            .get(&id)
            .with_context(|| format!("cargo metadata has no package for {id}"))?;
        if package["source"].is_null() {
            continue;
        }
        let component = crate_legal_component(package, legal)?;
        let key = (
            component.record["name"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            component.record["version"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        );
        crates.insert(key, component);
    }
    Ok(crates.into_values().collect())
}

fn dependency_is_distributable(dependency: &Value) -> bool {
    dependency["dep_kinds"]
        .as_array()
        .is_none_or(|kinds| kinds.iter().any(|kind| kind["kind"] != "dev"))
}

fn crate_legal_component(package: &Value, legal: &Path) -> Result<LegalComponent> {
    let name = package["name"].as_str().context("crate has no name")?;
    let version = package["version"]
        .as_str()
        .context("crate has no version")?;
    let license = package["license"]
        .as_str()
        .with_context(|| format!("{name} {version} has no declared license"))?;
    let manifest = PathBuf::from(
        package["manifest_path"]
            .as_str()
            .with_context(|| format!("{name} {version} has no manifest path"))?,
    );
    let directory = manifest
        .parent()
        .with_context(|| format!("{name} {version} has an invalid manifest path"))?;
    let declared_license_file = package["license_file"]
        .as_str()
        .map(|file| directory.join(file));
    let files = crate_notice_files(directory, declared_license_file.as_deref())?;
    let notice = if files.is_empty() {
        standard_license_notice(legal, license).with_context(|| {
            format!("{name} {version} contains no bundled license or notice file")
        })?
    } else {
        let mut sections = vec![format!(
            "Package metadata (Cargo.toml) declares the following license expression: {license}."
        )];
        for file in &files {
            let relative = file.strip_prefix(directory).unwrap_or(file);
            sections.push(format!(
                "===== {} =====\n{}",
                relative.display(),
                read_notice(file)?.trim_end()
            ));
        }
        normalize_notice(&sections.join("\n\n"))
    };
    let license_source = if files.is_empty() {
        format!("apps/macos/Resources/Legal/Sources; https://crates.io/crates/{name}/{version}")
    } else {
        let file_names = files
            .iter()
            .map(|file| {
                file.strip_prefix(directory)
                    .unwrap_or(file)
                    .to_string_lossy()
            })
            .collect::<Vec<_>>()
            .join("; ");
        format!("bundled crate files: {file_names}")
    };
    Ok(LegalComponent {
        record: json!({
            "identifier": format!("crate:{name}@{version}"),
            "kind": "rust-crate",
            "name": name,
            "version": version,
            "revision": null,
            "archive": null,
            "copyright": null,
            "license": license,
            "sourceLocation": "Cargo.lock",
            "licenseSource": license_source,
            "noticeContentSHA256": hash(notice.as_bytes()),
        }),
        notice,
    })
}

fn crate_notice_files(
    directory: &Path,
    declared_license_file: Option<&Path>,
) -> Result<Vec<PathBuf>> {
    fn collect(
        directory: &Path,
        inside_license_directory: bool,
        files: &mut Vec<PathBuf>,
    ) -> Result<()> {
        let mut entries = std::fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                collect(
                    &entry.path(),
                    inside_license_directory || matches!(name.as_str(), "license" | "licenses"),
                    files,
                )?;
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if inside_license_directory
                || ["license", "copying", "notice", "copyright", "unlicense"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            {
                files.push(entry.path());
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    collect(directory, false, &mut files)?;
    if let Some(path) = declared_license_file
        && path.is_file()
        && !files.contains(&path.to_path_buf())
    {
        files.push(path.to_path_buf());
    }
    files.sort();
    Ok(files)
}

fn standard_license_notice(legal: &Path, license: &str) -> Result<String> {
    match license {
        "Apache-2.0" => read_notice(&legal.join("Sources/Apache-2.0.txt")),
        _ => bail!("no standard bundled license text is configured for {license}"),
    }
}

fn read_notice(path: &Path) -> Result<String> {
    Ok(normalize_notice(
        &std::fs::read_to_string(path)
            .with_context(|| format!("failed to read legal notice {}", path.display()))?,
    ))
}

fn render_notices(components: &[LegalComponent]) -> String {
    let mut output = String::from(
        "# Railgun legal notices\n\nThis catalog is generated from Cargo.lock and the pinned Swift, font, and artwork inputs.\n\n",
    );
    for component in components {
        let record = &component.record;
        output.push_str(&format!(
            "## {} ({})\n\n- Identifier: {}\n- Kind: {}\n- License: {}\n- Source: {}\n- License source: {}\n- Notice SHA-256: {}\n\n### Notice\n\n```text\n{}\n```\n\n",
            record["name"].as_str().unwrap_or("Unknown"),
            record["version"].as_str().unwrap_or("unknown"),
            record["identifier"].as_str().unwrap_or("unknown"),
            record["kind"].as_str().unwrap_or("unknown"),
            record["license"].as_str().unwrap_or("UNKNOWN"),
            record["sourceLocation"].as_str().unwrap_or("unknown"),
            record["licenseSource"].as_str().unwrap_or("unknown"),
            record["noticeContentSHA256"].as_str().unwrap_or("unknown"),
            component.notice.trim_end(),
        ));
    }
    format!("{}\n", output.trim_end())
}

fn migration_new(name: &str) -> Result<()> {
    if name.is_empty()
        || !name.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
    {
        bail!("migration name must match [a-z0-9_]+");
    }
    let timestamp = chrono_timestamp()?;
    let path = repository_root()?
        .join("crates/railgun-backend/migrations")
        .join(format!("{timestamp}_{name}.sql"));
    if path.exists() {
        bail!("migration already exists: {}", path.display());
    }
    std::fs::write(
        &path,
        "-- Write one transactional, up-only migration here.\n",
    )?;
    println!("{}", path.display());
    Ok(())
}

fn chrono_timestamp() -> Result<String> {
    let output = Command::new("date").arg("+%Y%m%d%H%M%S").output()?;
    if !output.status.success() {
        bail!("date command failed");
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn migration_check() -> Result<()> {
    let root = repository_root()?.join("crates/railgun-backend/migrations");
    let entries = std::fs::read_dir(root)?
        .map(|entry| {
            let entry = entry?;
            Ok((
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            ))
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    validate_migrations(entries)
}

fn validate_migrations(mut entries: Vec<(String, PathBuf)>) -> Result<()> {
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut previous = String::new();
    for (name, path) in entries {
        if !name.ends_with(".sql")
            || name.len() < 20
            || !name[..14]
                .chars()
                .all(|character| character.is_ascii_digit())
        {
            bail!("invalid migration filename: {name}");
        }
        if name <= previous {
            bail!("migration directory is not monotonically ordered");
        }
        if std::fs::read_to_string(path)?.trim().is_empty() {
            bail!("empty migration: {name}");
        }
        previous = name;
    }
    Ok(())
}

fn fixture_check() -> Result<()> {
    let manifest = repository_root()?.join("fixtures/rpc/v1/manifest.json");
    let value: Value = serde_json::from_slice(&std::fs::read(&manifest)?)?;
    if !value.is_object() && !value.is_array() {
        bail!("RPC fixture manifest must be a JSON object or array");
    }
    println!("RPC v1 fixtures are readable");
    Ok(())
}

async fn performance_harness() -> Result<()> {
    let executable = repository_root()?.join("target/release/railgun-backend");
    if !executable.is_file() {
        bail!("build the locked release backend before running the performance harness");
    }
    println!(
        "backend_bytes={}",
        tokio::fs::metadata(executable).await?.len()
    );
    println!(
        "cold-start sampling requires a deterministic provider fixture; see docs/backend-test-traceability.md"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_validation_sorts_filesystem_entries_before_checking_order() {
        let migration = repository_root()
            .unwrap()
            .join("crates/railgun-backend/migrations/20260726150413_initial_session_schema.sql");
        validate_migrations(vec![
            ("20260727000002_second.sql".into(), migration.clone()),
            ("20260727000001_first.sql".into(), migration),
        ])
        .unwrap();
    }

    #[test]
    fn rendered_legal_catalog_contains_the_notice_text() {
        let notice = normalize_notice("Permission is hereby granted.");
        let component = LegalComponent {
            record: json!({
                "name": "Example",
                "version": "1.0.0",
                "identifier": "crate:example@1.0.0",
                "kind": "rust-crate",
                "license": "MIT",
                "sourceLocation": "Cargo.lock",
                "licenseSource": "LICENSE",
                "noticeContentSHA256": hash(notice.as_bytes()),
            }),
            notice,
        };
        let rendered = render_notices(&[component]);
        assert!(rendered.contains("### Notice"));
        assert!(rendered.contains("Permission is hereby granted."));
    }
}
