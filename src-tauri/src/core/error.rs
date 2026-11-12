use serde::Serialize;

/// Unified error type crossing the IPC boundary. Serialized as a plain
/// message string so the frontend can surface it without knowing variants.
#[derive(Debug, thiserror::Error)]
pub enum AeroError {
    #[error("文件读写错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("数据格式错误：{0}")]
    Serde(#[from] serde_json::Error),

    #[error("应用运行错误：{0}")]
    Tauri(#[from] tauri::Error),

    #[cfg(windows)]
    #[error("Windows API 错误：{0}")]
    Windows(#[from] windows::core::Error),

    #[error("图像处理错误：{0}")]
    Image(#[from] image::ImageError),

    #[error("{0}")]
    Other(String),
}

impl AeroError {
    pub fn other(msg: impl Into<String>) -> Self {
        Self::Other(msg.into())
    }
}

impl Serialize for AeroError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AeroResult<T> = Result<T, AeroError>;
