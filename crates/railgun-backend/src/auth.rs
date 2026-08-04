use crate::paths::RailgunPaths;
use anyhow::{Context, Result, bail};
use std::{error::Error, fmt, sync::Arc};
use widevin::{
    DevinClientMetadata, DevinError, DevinProvider, DevinProviderOptions, OpenBrowser,
    TokenStoreRef, create_devin_provider, create_file_token_store, create_memory_token_store,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialSource {
    Environment,
    File,
}

impl CredentialSource {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Environment => "environment",
            Self::File => "file",
        }
    }
}

#[derive(Debug)]
struct AuthenticationRequired {
    source: CredentialSource,
}

impl fmt::Display for AuthenticationRequired {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Devin rejected or could not find the {} credential",
            self.source.wire_name()
        )
    }
}

impl Error for AuthenticationRequired {}

pub fn authentication_required_source(error: &anyhow::Error) -> Option<CredentialSource> {
    error
        .downcast_ref::<AuthenticationRequired>()
        .map(|error| error.source)
}

fn authentication_required(source: CredentialSource) -> anyhow::Error {
    AuthenticationRequired { source }.into()
}

#[derive(Clone)]
pub struct Authenticated {
    pub provider: DevinProvider,
    model_catalog_provider: DevinProvider,
    pub source: CredentialSource,
}

fn devin_client_metadata() -> DevinClientMetadata {
    DevinClientMetadata {
        ide_name: Some("devin".into()),
        ide_type: Some("local".into()),
        ..Default::default()
    }
}

fn model_catalog_client_metadata() -> DevinClientMetadata {
    DevinClientMetadata::default()
}

fn create_provider(
    token_store: TokenStoreRef,
    client_metadata: DevinClientMetadata,
) -> DevinProvider {
    create_devin_provider(DevinProviderOptions {
        token_store: Some(token_store),
        open_browser: Some(browser_opener()),
        client_metadata: Some(client_metadata),
        ..Default::default()
    })
}

pub async fn provider(paths: &RailgunPaths, desktop: bool) -> Result<Authenticated> {
    let file_store = create_file_token_store(&paths.token);
    let environment = std::env::var("DEVIN_TOKEN")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let (store, source) = if let Some(token) = environment {
        (
            create_memory_token_store(Some(token)),
            CredentialSource::Environment,
        )
    } else {
        (file_store.clone(), CredentialSource::File)
    };
    let provider = create_provider(store.clone(), devin_client_metadata());
    let model_catalog_provider = create_provider(store.clone(), model_catalog_client_metadata());
    if file_store.get().await?.is_none() && matches!(source, CredentialSource::File) {
        if desktop {
            return Err(authentication_required(CredentialSource::File));
        }
        provider.login().await?;
    }
    Ok(Authenticated {
        provider,
        model_catalog_provider,
        source,
    })
}

pub async fn background_provider(paths: &RailgunPaths) -> Result<Authenticated> {
    provider(paths, true).await
}

pub async fn login(paths: &RailgunPaths) -> Result<()> {
    let store = create_file_token_store(&paths.token);
    let provider = create_provider(store.clone(), devin_client_metadata());
    provider.login().await?;
    let model_catalog_provider = create_provider(store.clone(), model_catalog_client_metadata());
    match model_catalog_provider.list_models().await {
        Ok(_) => {}
        Err(error) if unauthorized(&error) => {
            store.clear().await?;
            bail!("Devin rejected the file credential with HTTP 401.");
        }
        Err(error) => {
            bail!("Devin credentials were saved, but verification failed: {error}");
        }
    }
    println!("Devin credentials saved and verified.");
    if std::env::var("DEVIN_TOKEN")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
    {
        eprintln!("Warning: DEVIN_TOKEN is set and will override the newly cached credential.");
    }
    Ok(())
}

pub async fn logout(paths: &RailgunPaths) -> Result<()> {
    create_file_token_store(&paths.token).clear().await?;
    println!("Cached Devin credentials removed.");
    if std::env::var("DEVIN_TOKEN")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
    {
        eprintln!("Warning: DEVIN_TOKEN is set, so Devin authentication remains active.");
    }
    Ok(())
}

pub async fn models(
    authenticated: &Authenticated,
    paths: &RailgunPaths,
) -> Result<Vec<widevin::DevinModel>> {
    match authenticated.model_catalog_provider.list_models().await {
        Ok(models) => Ok(models),
        Err(error) if unauthorized(&error) => {
            if matches!(authenticated.source, CredentialSource::File) {
                create_file_token_store(&paths.token)
                    .clear()
                    .await
                    .context(
                        "Devin rejected the credential and its cached token could not be removed",
                    )?;
            }
            Err(authentication_required(authenticated.source))
        }
        Err(error) => Err(error.into()),
    }
}

fn unauthorized(error: &DevinError) -> bool {
    matches!(error, DevinError::Api { status: 401, .. })
}

fn browser_opener() -> OpenBrowser {
    Arc::new(|url| {
        Box::pin(async move {
            #[cfg(target_os = "macos")]
            let mut command = tokio::process::Command::new("/usr/bin/open");
            #[cfg(not(target_os = "macos"))]
            let mut command = tokio::process::Command::new("xdg-open");
            let status =
                command.arg(url).status().await.map_err(|error| {
                    DevinError::auth(format!("Failed to open browser: {error}"))
                })?;
            if !status.success() {
                return Err(DevinError::auth("Browser opener exited unsuccessfully"));
            }
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use widevin::{FetchLike, fetch_response_from_bytes};

    #[test]
    fn authentication_required_errors_preserve_the_credential_source() {
        for source in [CredentialSource::Environment, CredentialSource::File] {
            let error = authentication_required(source);
            assert_eq!(authentication_required_source(&error), Some(source));
        }
    }

    #[test]
    fn chat_client_metadata_identifies_railgun_as_devin_local() {
        let metadata = devin_client_metadata();

        assert_eq!(metadata.ide_name.as_deref(), Some("devin"));
        assert_eq!(metadata.ide_type.as_deref(), Some("local"));
    }

    #[test]
    fn model_catalog_client_metadata_uses_provider_compatible_defaults() {
        assert_eq!(
            model_catalog_client_metadata(),
            DevinClientMetadata::default()
        );
    }

    #[tokio::test]
    async fn rejected_file_credentials_are_cleared_and_request_authentication() {
        let directory = tempfile::tempdir().unwrap();
        let paths = RailgunPaths::for_user_home(directory.path());
        let store = create_file_token_store(&paths.token);
        store.set("expired".into()).await.unwrap();
        let fetch: FetchLike = Arc::new(|_| {
            Box::pin(async { Ok(fetch_response_from_bytes(401, "Unauthorized", Vec::new())) })
        });
        let authenticated = Authenticated {
            provider: create_devin_provider(DevinProviderOptions {
                token_store: Some(store.clone()),
                ..Default::default()
            }),
            model_catalog_provider: create_devin_provider(DevinProviderOptions {
                token_store: Some(store.clone()),
                fetch: Some(fetch),
                ..Default::default()
            }),
            source: CredentialSource::File,
        };

        let error = models(&authenticated, &paths).await.unwrap_err();
        assert_eq!(
            authentication_required_source(&error),
            Some(CredentialSource::File)
        );
        assert_eq!(store.get().await.unwrap(), None);
    }
}
