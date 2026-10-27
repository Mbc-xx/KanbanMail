//! Board columns, read from `board.toml` in the configuration folder.
//! If the file does not exist it is created with the default columns.

use crate::account::config_dir;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    /// Title shown at the top of the column.
    pub name: String,
    /// IMAP folder. On servers that keep everything under `INBOX.`,
    /// writing `Todo` is enough: the app finds (or creates) `INBOX.Todo`.
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    /// How many emails (the most recent) to load per column.
    #[serde(default = "default_limit")]
    pub max_cards_per_column: u32,
    #[serde(rename = "column")]
    pub columns: Vec<Column>,
}

fn default_limit() -> u32 {
    200
}

const DEFAULT_BOARD: &str = r#"# KanbanMail board columns.
# Each [[column]] block is a column: "name" is the title shown,
# "folder" is the IMAP folder. If the folder does not exist, the app creates it.
# Restart the app after editing this file.

# Maximum number of emails (the most recent) shown per column.
max_cards_per_column = 200

[[column]]
name = "Inbox"
folder = "INBOX"

[[column]]
name = "Todo"
folder = "Todo"

[[column]]
name = "Waiting"
folder = "Waiting"

[[column]]
name = "Done"
folder = "Done"
"#;

pub fn board_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("board.toml"))
}

impl Board {
    pub fn load_or_create() -> Result<Board> {
        let path = board_path()?;
        if !path.exists() {
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(&path, DEFAULT_BOARD)
                .with_context(|| format!("writing {}", path.display()))?;
        }
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let board: Board = toml::from_str(&text)
            .with_context(|| format!("invalid {}", path.display()))?;
        anyhow::ensure!(!board.columns.is_empty(), "board.toml defines no columns");
        Ok(board)
    }
}

impl Board {
    /// Writes the columns back to `board.toml`, keeping the explanatory header.
    pub fn save(&self) -> Result<()> {
        anyhow::ensure!(!self.columns.is_empty(), "the board needs at least one column");
        let header: String = DEFAULT_BOARD.lines().take_while(|l| l.starts_with('#')).map(|l| format!("{l}\n")).collect();
        let body = toml::to_string_pretty(self)?;
        let path = board_path()?;
        std::fs::write(&path, format!("{header}\n{body}")).with_context(|| format!("writing {}", path.display()))
    }
}
