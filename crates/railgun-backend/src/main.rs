use railgun_backend::{BackendMode, run_backend};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .json()
        .init();
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let mode = match BackendMode::parse(&arguments) {
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = run_backend(mode).await {
        if mode == BackendMode::Desktop && error.to_string().contains("authentication is required")
        {
            std::process::exit(1);
        }
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
