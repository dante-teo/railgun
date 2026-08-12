//! Discovery, parsing, prompt projection, and managed persistence for Railgun skills.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub const MAX_NAME_LENGTH: usize = 64;
pub const MAX_DESCRIPTION_LENGTH: usize = 1_024;
pub const MAX_BODY_LENGTH: usize = 200_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub disabled: bool,
    pub body: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillInput {
    pub name: String,
    pub description: String,
    pub body: String,
    pub disabled: bool,
}

#[derive(Debug, Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(rename = "disable-model-invocation")]
    disable_model_invocation: Option<bool>,
}

pub fn discover(root: &Path) -> Result<Vec<Skill>> {
    let mut files = Vec::new();
    collect_skill_files(root, &mut files, false)?;
    files.sort_by_key(|path| relative_sort_key(root, path));

    let mut names = HashSet::new();
    let mut skills = files
        .into_iter()
        .filter_map(|path| match parse_skill_file(&path) {
            Ok(Some(skill)) if names.insert(skill.name.clone()) => Some(skill),
            Ok(Some(skill)) => {
                tracing::warn!(
                    path = %skill.path.display(),
                    name = %skill.name,
                    "skipping duplicate skill name"
                );
                None
            }
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(path = %path.display(), error = %error, "skipping invalid skill");
                None
            }
        })
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    Ok(skills)
}

pub async fn discover_async(root: &Path) -> Result<Vec<Skill>> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || discover(&root))
        .await
        .context("skill discovery task failed")?
}

pub async fn discover_skills(root: &Path) -> Result<Vec<Skill>> {
    discover_async(root).await
}

pub fn find(root: &Path, name: &str) -> Result<Skill> {
    discover(root)?
        .into_iter()
        .find(|skill| skill.name == name)
        .with_context(|| format!("Unknown skill {name:?}."))
}

pub fn available_skills_prompt(skills: &[Skill]) -> String {
    let mut visible = skills
        .iter()
        .filter(|skill| !skill.disabled)
        .collect::<Vec<_>>();
    visible.sort_by(|left, right| left.name.cmp(&right.name));

    let mut prompt = String::from("<available_skills>\n");
    for skill in visible {
        prompt.push_str("  <skill>\n    <name>");
        prompt.push_str(&escape_xml(&skill.name));
        prompt.push_str("</name>\n    <description>");
        prompt.push_str(&escape_xml(&skill.description));
        prompt.push_str("</description>\n  </skill>\n");
    }
    prompt.push_str("</available_skills>");
    prompt
}

pub fn expand_slash_invocation(prompt: &str, skills: &[Skill]) -> Result<Option<String>> {
    let Some(invocation) = prompt.strip_prefix("/skill:") else {
        return Ok(None);
    };
    let invocation = invocation.trim();
    let (name, arguments) = invocation
        .split_once(char::is_whitespace)
        .map_or((invocation, ""), |(name, arguments)| {
            (name, arguments.trim())
        });
    if name.is_empty() || !valid_name(name) {
        bail!("Unknown skill invocation.");
    }
    let skill = skills
        .iter()
        .find(|skill| skill.name == name)
        .with_context(|| format!("Unknown skill {name:?}."))?;
    let mut expanded = format!(
        "Use the following skill instructions for this turn.\n\n<skill name=\"{}\">\n{}\n</skill>",
        escape_xml(&skill.name),
        skill.body
    );
    if !arguments.is_empty() {
        expanded.push_str("\n\nUser arguments:\n");
        expanded.push_str(arguments);
    }
    Ok(Some(expanded))
}

pub async fn create(root: &Path, input: &SkillInput) -> Result<Skill> {
    validate_input(input)?;
    ensure_root(root).await?;
    if discover_async(root)
        .await?
        .iter()
        .any(|skill| skill.name == input.name)
    {
        bail!("skill already exists: {}", input.name);
    }
    let path = managed_path(root, &input.name);
    ensure_new_directory(path.parent().context("managed skill path has no parent")?).await?;
    if metadata_is_present(&path).await? {
        bail!("skill already exists: {}", input.name);
    }
    write_atomic(&path, &render(input)).await?;
    parse_skill_file(&path)?.context("created skill could not be parsed")
}

pub async fn update(root: &Path, input: &SkillInput) -> Result<Skill> {
    validate_input(input)?;
    ensure_root(root).await?;
    let existing = discover_async(root)
        .await?
        .into_iter()
        .find(|skill| skill.name == input.name)
        .with_context(|| format!("Unknown skill {:?}.", input.name))?;
    let path = managed_path(root, &input.name);
    ensure_new_directory(path.parent().context("managed skill path has no parent")?).await?;
    if path != existing.path && metadata_is_present(&path).await? {
        bail!("skill already exists at the managed path: {}", input.name);
    }
    reject_symlink_or_nonfile_if_present(&existing.path).await?;
    write_atomic(&path, &render(input)).await?;
    if path != existing.path {
        remove_source_after_migration(&existing.path).await?;
    }
    parse_skill_file(&path)?.context("updated skill could not be parsed")
}

pub async fn delete(root: &Path, name: &str) -> Result<()> {
    ensure_valid_name(name)?;
    ensure_root(root).await?;
    let skill = discover_async(root)
        .await?
        .into_iter()
        .find(|skill| skill.name == name)
        .with_context(|| format!("Unknown skill {name:?}."))?;
    reject_symlink_or_nonfile_if_present(&skill.path).await?;
    tokio::fs::remove_file(&skill.path).await?;
    if skill.path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
        if let Some(parent) = skill.path.parent() {
            match tokio::fs::remove_dir(parent).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

fn collect_skill_files(
    root: &Path,
    files: &mut Vec<PathBuf>,
    is_skill_directory: bool,
) -> Result<()> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        bail!("skill path is a symbolic link: {}", root.display());
    }
    if !metadata.is_dir() {
        bail!("skill root is not a directory: {}", root.display());
    }

    let mut entries = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.path());
    if is_skill_directory
        && entries.iter().any(|entry| {
            entry.file_name() == "SKILL.md"
                && entry.file_type().is_ok_and(|file_type| file_type.is_file())
        })
    {
        files.push(root.join("SKILL.md"));
        return Ok(());
    }

    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_skill_files(&path, files, true)?;
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("md")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn relative_sort_key(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn parse_skill_file(path: &Path) -> Result<Option<Skill>> {
    let raw = fs::read_to_string(path)?;
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let Some((frontmatter, body)) = split_frontmatter(&normalized) else {
        return Ok(None);
    };
    let metadata = parse_frontmatter(frontmatter)?;
    let inferred_name = if path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
        path.parent().and_then(|value| value.file_name())
    } else {
        path.file_stem()
    }
    .and_then(|value| value.to_str())
    .unwrap_or_default();
    let name = metadata.name.as_deref().unwrap_or(inferred_name);
    if !valid_name(name) {
        return Ok(None);
    }
    let Some(description) = metadata.description else {
        return Ok(None);
    };
    if description.trim().is_empty() || description.len() > MAX_DESCRIPTION_LENGTH {
        return Ok(None);
    }
    if body.len() > MAX_BODY_LENGTH {
        return Ok(None);
    }
    Ok(Some(Skill {
        name: name.to_owned(),
        description: description.trim().to_owned(),
        disabled: metadata.disable_model_invocation.unwrap_or(false),
        body: body.to_owned(),
        path: path.to_owned(),
    }))
}

fn parse_frontmatter(frontmatter: &str) -> Result<Frontmatter> {
    match serde_yaml::from_str(frontmatter) {
        Ok(metadata) => Ok(metadata),
        Err(original_error) => {
            let Some(normalized) = quote_plain_description(frontmatter) else {
                return Err(original_error.into());
            };
            serde_yaml::from_str(&normalized).map_err(|_| original_error.into())
        }
    }
}

fn quote_plain_description(frontmatter: &str) -> Option<String> {
    let candidates = frontmatter
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let value = line.strip_prefix("description:")?.trim();
            (!value.is_empty()
                && !matches!(
                    value.as_bytes().first(),
                    Some(b'\"' | b'\'' | b'|' | b'>' | b'[' | b'{')
                ))
            .then_some((index, value))
        })
        .collect::<Vec<_>>();
    let [(description_index, description)] = candidates.as_slice() else {
        return None;
    };
    let quoted = serde_json::to_string(description).ok()?;
    Some(
        frontmatter
            .lines()
            .enumerate()
            .map(|(index, line)| {
                if index == *description_index {
                    format!("description: {quoted}")
                } else {
                    line.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let mut lines = raw.split_inclusive('\n');
    let opening = lines.next()?;
    if opening != "---\n" {
        return None;
    }
    let mut frontmatter_end = opening.len();
    for line in lines {
        let trimmed = line.strip_suffix('\n').unwrap_or(line);
        if trimmed == "---" {
            let body_start = frontmatter_end + line.len();
            return Some((&raw[opening.len()..frontmatter_end], &raw[body_start..]));
        }
        frontmatter_end += line.len();
    }
    None
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LENGTH
        && name.bytes().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == b'-'
        })
}

fn ensure_valid_name(name: &str) -> Result<()> {
    if valid_name(name) {
        Ok(())
    } else {
        bail!("skill name must match [a-z0-9-]{{1,64}}")
    }
}

fn validate_input(input: &SkillInput) -> Result<()> {
    ensure_valid_name(&input.name)?;
    if input.description.trim().is_empty() || input.description.len() > MAX_DESCRIPTION_LENGTH {
        bail!("skill description must be non-empty and at most {MAX_DESCRIPTION_LENGTH} bytes")
    }
    if input.body.len() > MAX_BODY_LENGTH {
        bail!("skill body exceeds the {MAX_BODY_LENGTH}-byte limit")
    }
    Ok(())
}

fn managed_path(root: &Path, name: &str) -> PathBuf {
    root.join(name).join("SKILL.md")
}

async fn ensure_root(root: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(root).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("skill root is a symbolic link: {}", root.display())
        }
        Ok(metadata) if !metadata.is_dir() => {
            bail!("skill root is not a directory: {}", root.display())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(root).await?;
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    tokio::fs::set_permissions(root, std::os::unix::fs::PermissionsExt::from_mode(0o700)).await?;
    Ok(())
}

async fn ensure_new_directory(path: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("skill directory is a symbolic link: {}", path.display())
        }
        Ok(metadata) if !metadata.is_dir() => {
            bail!("skill directory is not a directory: {}", path.display())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir(path).await?;
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    tokio::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700)).await?;
    Ok(())
}

async fn metadata_is_present(path: &Path) -> Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn reject_symlink_or_nonfile_if_present(path: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("skill file is a symbolic link: {}", path.display())
        }
        Ok(metadata) if !metadata.is_file() => {
            bail!("skill path is not a regular file: {}", path.display())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn write_atomic(path: &Path, content: &str) -> Result<()> {
    reject_symlink_or_nonfile_if_present(path).await?;
    let parent = path.parent().context("skill file has no parent")?;
    let temporary = parent.join(format!(".SKILL.md.{}.tmp", Uuid::new_v4()));
    let write_result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        #[cfg(unix)]
        tokio::fs::set_permissions(
            &temporary,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .await?;
        file.write_all(content.as_bytes()).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temporary, path).await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    write_result
}

async fn remove_source_after_migration(path: &Path) -> Result<()> {
    tokio::fs::remove_file(path).await?;
    if path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::remove_dir(parent).await;
        }
    }
    Ok(())
}

fn render(input: &SkillInput) -> String {
    #[derive(Serialize)]
    struct ManagedFrontmatter<'a> {
        name: &'a str,
        description: &'a str,
        #[serde(rename = "disable-model-invocation")]
        disable_model_invocation: bool,
    }

    let frontmatter = serde_yaml::to_string(&ManagedFrontmatter {
        name: &input.name,
        description: &input.description,
        disable_model_invocation: input.disabled,
    })
    .expect("managed skill frontmatter is serializable");
    format!("---\n{frontmatter}---\n{}", input.body,)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write(path: &std::path::Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn discovery_accepts_bare_files_and_skill_directories_in_stable_order() {
        let directory = tempdir().unwrap();
        write(
            &directory.path().join("zeta.md"),
            "---\nname: zeta\ndescription: Zeta\n---\nZ body\n",
        );
        write(
            &directory.path().join("alpha/SKILL.md"),
            "---\r\nname: alpha\r\ndescription: Alpha\r\ndisable-model-invocation: true\r\n---\r\nA body\r\n",
        );
        write(
            &directory.path().join("ignored.md"),
            "---\nname: ignored\n---\nNo description\n",
        );
        write(
            &directory.path().join("SKILL.md"),
            "---\nname: malformed-root\n---\nThe root file must not hide siblings.\n",
        );
        write(
            &directory.path().join("assets/SKILL.md/never.md"),
            "not possible",
        );

        let skills = discover(directory.path()).unwrap();
        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "zeta"]
        );
        assert!(skills[0].disabled);
        assert_eq!(skills[0].body, "A body\n");
    }

    #[test]
    fn parsed_frontmatter_name_resolves_aliases_and_duplicates_choose_first_path() {
        let directory = tempdir().unwrap();
        write(
            &directory.path().join("a.md"),
            "---\nname: alias-name\ndescription: First\n---\nfirst\n",
        );
        write(
            &directory.path().join("b/SKILL.md"),
            "---\nname: alias-name\ndescription: Second\n---\nsecond\n",
        );

        let skills = discover(directory.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(
            find(directory.path(), "alias-name").unwrap().body,
            "first\n"
        );
    }

    #[test]
    fn discovery_accepts_plain_text_descriptions_containing_colons() {
        let directory = tempdir().unwrap();
        write(
            &directory.path().join("pavo/SKILL.md"),
            "---\nname: pavo\ndescription: Manage a note vault: discover, search, read, and edit notes safely.\n---\nBody\n",
        );

        let skills = discover(directory.path()).unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(
            skills[0].description,
            "Manage a note vault: discover, search, read, and edit notes safely."
        );
    }

    #[tokio::test]
    async fn managed_frontmatter_round_trips_yaml_special_characters() {
        let directory = tempdir().unwrap();
        let input = SkillInput {
            name: "yaml-safe".into(),
            description: "Review: #1\nUse \"care\" & keep it safe".into(),
            body: "Body".into(),
            disabled: true,
        };

        let created = create(directory.path(), &input).await.unwrap();

        assert_eq!(created.description, input.description);
        assert!(created.disabled);
    }

    #[test]
    fn prompt_contains_only_enabled_metadata_and_escapes_xml() {
        let skills = vec![
            Skill {
                name: "visible".into(),
                description: "Use <safe> & \"clear\" guidance".into(),
                disabled: false,
                body: "body".into(),
                path: "visible.md".into(),
            },
            Skill {
                name: "hidden".into(),
                description: "Do not advertise".into(),
                disabled: true,
                body: "secret".into(),
                path: "hidden.md".into(),
            },
        ];

        let prompt = available_skills_prompt(&skills);
        assert!(prompt.contains("<available_skills>"));
        assert!(prompt.contains("<name>visible</name>"));
        assert!(prompt.contains("Use &lt;safe&gt; &amp; &quot;clear&quot; guidance"));
        assert!(!prompt.contains("hidden"));
        assert!(!prompt.contains("secret"));
    }

    #[test]
    fn slash_invocation_loads_disabled_skill_and_preserves_arguments() {
        let skills = vec![Skill {
            name: "release-checklist".into(),
            description: "Release checks".into(),
            disabled: true,
            body: "Check the signed artifact.".into(),
            path: "release-checklist/SKILL.md".into(),
        }];

        let expanded = expand_slash_invocation("/skill:release-checklist verify v1.2", &skills)
            .unwrap()
            .unwrap();
        assert!(expanded.contains("Check the signed artifact."));
        assert!(expanded.contains("verify v1.2"));
        assert!(
            expand_slash_invocation("ordinary prompt", &skills)
                .unwrap()
                .is_none()
        );
        assert!(
            expand_slash_invocation("/skill:missing", &skills)
                .unwrap_err()
                .to_string()
                .contains("Unknown skill")
        );
    }

    #[tokio::test]
    async fn managed_crud_writes_canonical_files_with_restrictive_permissions() {
        let directory = tempdir().unwrap();
        let input = SkillInput {
            name: "new-skill".into(),
            description: "A managed skill".into(),
            body: "Do the thing.".into(),
            disabled: false,
        };
        let created = create(directory.path(), &input).await.unwrap();
        assert_eq!(created.path, directory.path().join("new-skill/SKILL.md"));
        assert_eq!(
            fs::read_to_string(&created.path).unwrap(),
            "---\nname: new-skill\ndescription: A managed skill\ndisable-model-invocation: false\n---\nDo the thing."
        );
        let updated = update(
            directory.path(),
            &SkillInput {
                body: "Updated.".into(),
                ..input.clone()
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.body, "Updated.");
        delete(directory.path(), "new-skill").await.unwrap();
        assert!(!directory.path().join("new-skill/SKILL.md").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = create(directory.path(), &input).await.unwrap();
            let mode = fs::metadata(directory.path().join("new-skill/SKILL.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn managed_crud_rejects_symlinks_and_does_not_delete_assets_recursively() {
        let directory = tempdir().unwrap();
        let input = SkillInput {
            name: "safe-skill".into(),
            description: "Safe".into(),
            body: "Body".into(),
            disabled: false,
        };
        create(directory.path(), &input).await.unwrap();
        write(&directory.path().join("safe-skill/assets/keep.txt"), "keep");
        delete(directory.path(), "safe-skill").await.unwrap();
        assert!(directory.path().join("safe-skill/assets/keep.txt").exists());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                directory.path().join("safe-skill/assets"),
                directory.path().join("linked-skill"),
            )
            .unwrap();
            let result = create(
                directory.path(),
                &SkillInput {
                    name: "linked-skill".into(),
                    ..input
                },
            )
            .await;
            assert!(result.is_err());
        }
    }
}
