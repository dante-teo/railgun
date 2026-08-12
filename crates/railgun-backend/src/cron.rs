use crate::paths::RailgunPaths;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Mutex, MutexGuard},
};

pub(crate) const INTERNAL_DREAM_JOB_ID: &str = "railgun.internal.dream";
const INTERNAL_DREAM_SCHEDULE: &str = "0 0 * * *";
const FIELD_BOUNDS: [(u16, u16); 5] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
static PROCESS_TRANSACTION_LOCK: Mutex<()> = Mutex::new(());

struct ExclusiveLock(File);

impl ExclusiveLock {
    fn acquire(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        // SAFETY: flock only reads the valid descriptor owned by `file`; the
        // descriptor remains alive in this guard until it is unlocked on drop.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == -1 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Self(file))
    }
}

impl Drop for ExclusiveLock {
    fn drop(&mut self) {
        // SAFETY: the descriptor is still valid because the guard owns `File`.
        let _ = unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

fn lock_path(cron_path: &Path) -> PathBuf {
    cron_path.with_file_name("jobs.lock")
}

fn process_transaction_lock() -> Result<MutexGuard<'static, ()>> {
    PROCESS_TRANSACTION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("cron transaction lock is poisoned"))
}

fn load_jobs_from_path(path: &Path) -> Result<Vec<Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let jobs: Vec<Value> = serde_json::from_str(&text)
        .with_context(|| format!("Invalid Railgun cron jobs at {}", path.display()))?;
    for job in &jobs {
        validate_stored_schedule(job["schedule"].as_str().unwrap_or_default())?;
    }
    Ok(jobs)
}

fn write_jobs_to_path(path: &Path, jobs: &[Value]) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        std::fs::write(
            &temporary,
            format!("{}\n", serde_json::to_string_pretty(jobs)?),
        )?;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub(crate) async fn load_jobs(paths: &RailgunPaths) -> Result<Vec<Value>> {
    let path = paths.cron.clone();
    tokio::task::spawn_blocking(move || load_jobs_from_path(&path))
        .await
        .context("cron read task failed")?
}

#[cfg(test)]
pub(crate) async fn save_jobs(paths: &RailgunPaths, jobs: &[Value]) -> Result<()> {
    let path = paths.cron.clone();
    let jobs = jobs.to_vec();
    tokio::task::spawn_blocking(move || {
        let _process_lock = process_transaction_lock()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let _lock = ExclusiveLock::acquire(&lock_path(&path))?;
        write_jobs_to_path(&path, &jobs)
    })
    .await
    .context("cron write task failed")?
}

pub(crate) async fn transact_jobs<T, F>(paths: &RailgunPaths, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Vec<Value>) -> Result<(T, bool)> + Send + 'static,
{
    let path = paths.cron.clone();
    tokio::task::spawn_blocking(move || {
        let _process_lock = process_transaction_lock()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let _lock = ExclusiveLock::acquire(&lock_path(&path))?;
        let stored = load_jobs_from_path(&path)?;
        let mut jobs = with_internal_cron_jobs(stored.clone());
        let normalized = jobs != stored;
        let (result, changed) = operation(&mut jobs)?;
        if normalized || changed {
            write_jobs_to_path(&path, &jobs)?;
        }
        Ok(result)
    })
    .await
    .context("cron transaction task failed")?
}

pub(crate) async fn merge_run_result(
    paths: &RailgunPaths,
    job_id: &str,
    timestamp: i64,
    status: &str,
    error: Option<String>,
) -> Result<bool> {
    let job_id = job_id.to_owned();
    let status = status.to_owned();
    transact_jobs(paths, move |jobs| {
        let Some(job) = jobs.iter_mut().find(|job| job["id"] == job_id) else {
            return Ok((false, false));
        };
        job["lastRun"] = json!(timestamp);
        job["lastStatus"] = json!(status);
        job["lastError"] = error.map(Value::String).unwrap_or(Value::Null);
        if job["lastStatus"] == "completed" {
            job["lastSuccess"] = json!(timestamp);
        }
        Ok((true, true))
    })
    .await
}

fn parse_integer(value: &str, minimum: u16, maximum: u16) -> Result<u16> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("cron schedule contains an invalid value");
    }
    let parsed = value.parse::<u16>()?;
    if !(minimum..=maximum).contains(&parsed) {
        bail!("cron schedule value is out of bounds");
    }
    Ok(parsed)
}

fn validate_atom(atom: &str, minimum: u16, maximum: u16) -> Result<()> {
    let mut step_parts = atom.split('/');
    let base = step_parts.next().unwrap_or_default();
    if let Some(step) = step_parts.next() {
        parse_integer(step, 1, maximum - minimum + 1)?;
    }
    if step_parts.next().is_some() {
        bail!("cron schedule contains an invalid step");
    }
    if base == "*" {
        return Ok(());
    }

    let mut range = base.split('-');
    let start = parse_integer(range.next().unwrap_or_default(), minimum, maximum)?;
    let Some(end) = range.next() else {
        return Ok(());
    };
    if range.next().is_some() || start > parse_integer(end, minimum, maximum)? {
        bail!("cron schedule contains an invalid range");
    }
    Ok(())
}

fn validate_stored_schedule(schedule: &str) -> Result<()> {
    if schedule.split_ascii_whitespace().count() != 5 {
        bail!("cron schedule must use five-minute fields");
    }
    croner::Cron::from_str(schedule)?;
    Ok(())
}

pub fn validate_schedule(schedule: &str) -> Result<()> {
    let fields = schedule.split_ascii_whitespace().collect::<Vec<_>>();
    if fields.len() != FIELD_BOUNDS.len() || fields.join(" ").len() > 512 {
        bail!("cron schedule must use five-minute fields");
    }
    for (field, (minimum, maximum)) in fields.iter().zip(FIELD_BOUNDS) {
        if field.split(',').any(str::is_empty) {
            bail!("cron schedule contains an empty value");
        }
        for atom in field.split(',') {
            validate_atom(atom, minimum, maximum)?;
        }
    }
    if fields[2] != "*" && fields[4] != "*" {
        bail!("cron schedule must not constrain both day fields");
    }
    croner::Cron::from_str(schedule)?;
    Ok(())
}

fn internal_dream_job() -> Value {
    json!({
        "id": INTERNAL_DREAM_JOB_ID,
        "kind": "dream",
        "internal": true,
        "schedule": INTERNAL_DREAM_SCHEDULE,
        "prompt": "",
        "lastRun": null,
        "requiredOutputs": [],
        "lastSuccess": null,
        "lastStatus": null,
        "lastError": null,
    })
}

fn normalized_internal_dream_job(mut job: Value) -> Value {
    job["id"] = json!(INTERNAL_DREAM_JOB_ID);
    job["kind"] = json!("dream");
    job["internal"] = json!(true);
    job["schedule"] = json!(INTERNAL_DREAM_SCHEDULE);
    job["prompt"] = json!("");
    job
}

pub(crate) fn with_internal_cron_jobs(jobs: Vec<Value>) -> Vec<Value> {
    let dream = jobs
        .iter()
        .find(|job| job["id"] == INTERNAL_DREAM_JOB_ID)
        .cloned()
        .map(normalized_internal_dream_job)
        .unwrap_or_else(internal_dream_job);
    jobs.into_iter()
        .filter(|job| job["id"] != INTERNAL_DREAM_JOB_ID)
        .chain([dream])
        .collect()
}

pub(crate) fn visible_cron_jobs(jobs: &[Value]) -> Vec<Value> {
    jobs.iter()
        .filter(|job| job["id"] != INTERNAL_DREAM_JOB_ID)
        .cloned()
        .collect()
}

pub(crate) fn is_protected_cron_job(job_id: &str) -> bool {
    job_id == INTERNAL_DREAM_JOB_ID
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_grammar_is_the_numeric_five_field_subset() {
        for valid in ["0 9 * * *", "*/15 9 * * *", "0 9 1/2 * *", "0 9 * * 1-5"] {
            assert!(validate_schedule(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "? 9 * * *",
            "0 9 * JAN *",
            "0 9 1 * 1",
            "0 9 L * *",
            "0 9 * * MON",
        ] {
            assert!(validate_schedule(invalid).is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn run_results_merge_into_the_latest_locked_store() {
        let home = tempfile::tempdir().unwrap();
        let paths = RailgunPaths::for_user_home(home.path());
        save_jobs(
            &paths,
            &[json!({"id":"job","schedule":"0 9 * * *","prompt":"old","lastRun":null})],
        )
        .await
        .unwrap();

        transact_jobs(&paths, |jobs| {
            jobs.iter_mut().find(|job| job["id"] == "job").unwrap()["prompt"] = json!("updated");
            Ok(((), true))
        })
        .await
        .unwrap();
        assert!(
            merge_run_result(&paths, "job", 42, "completed", None)
                .await
                .unwrap()
        );
        let jobs = load_jobs(&paths).await.unwrap();
        let job = jobs.iter().find(|job| job["id"] == "job").unwrap();
        assert_eq!(job["prompt"], "updated");
        assert_eq!(job["lastRun"], 42);

        transact_jobs(&paths, |jobs| {
            jobs.retain(|job| job["id"] != "job");
            Ok(((), true))
        })
        .await
        .unwrap();
        assert!(
            !merge_run_result(&paths, "job", 43, "failed", Some("late".into()))
                .await
                .unwrap()
        );
        assert!(
            visible_cron_jobs(&load_jobs(&paths).await.unwrap())
                .iter()
                .all(|job| job["id"] != "job")
        );
    }

    #[tokio::test]
    async fn concurrent_transactions_preserve_every_write() {
        let home = tempfile::tempdir().unwrap();
        let paths = RailgunPaths::for_user_home(home.path());
        let writes = (0..20)
            .map(|index| {
                let paths = paths.clone();
                tokio::spawn(async move {
                    transact_jobs(&paths, move |jobs| {
                        jobs.push(json!({
                            "id":format!("job-{index}"),
                            "schedule":"0 9 * * *",
                            "prompt":"Prompt",
                            "lastRun":null
                        }));
                        Ok(((), true))
                    })
                    .await
                })
            })
            .collect::<Vec<_>>();
        for write in writes {
            write.await.unwrap().unwrap();
        }

        assert_eq!(
            visible_cron_jobs(&load_jobs(&paths).await.unwrap()).len(),
            20
        );
    }
}
