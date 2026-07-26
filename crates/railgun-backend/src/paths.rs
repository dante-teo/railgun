use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct RailgunPaths {
    pub home: PathBuf,
    pub config: PathBuf,
    pub token: PathBuf,
    pub state: PathBuf,
    pub soul: PathBuf,
    pub extensions: PathBuf,
    pub cron: PathBuf,
    pub skills: PathBuf,
}

impl RailgunPaths {
    pub fn discover() -> anyhow::Result<Self> {
        let user_home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("HOME is not set"))?;
        Ok(Self::for_user_home(user_home))
    }

    pub fn for_user_home(user_home: impl Into<PathBuf>) -> Self {
        let home = user_home.into().join(".railgun");
        Self {
            config: home.join("config.json"),
            token: home.join("devin-token"),
            state: home.join("state.db"),
            soul: home.join("SOUL.md"),
            extensions: home.join("extensions"),
            cron: home.join("cron/jobs.json"),
            skills: home.join("skills"),
            home,
        }
    }
}
