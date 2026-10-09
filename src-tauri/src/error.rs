use serde::{Serialize, Serializer};

/// Every error that crosses the IPC boundary. Serialised as `{ kind, message }`
/// so the frontend can branch on `kind` and show `message`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Config(String),
    /// A VPN server's preflight probe failed.
    #[error("{0}")]
    VpnDown(String),
    #[error("terminal session {0} not found")]
    PtyNotFound(u32),
    #[error("terminal error: {0}")]
    Pty(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Invalid(_) => "invalid",
            AppError::NotFound(_) => "notFound",
            AppError::Config(_) => "config",
            AppError::VpnDown(_) => "vpnDown",
            AppError::PtyNotFound(_) => "ptyNotFound",
            AppError::Pty(_) => "pty",
            AppError::Io(_) => "io",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
