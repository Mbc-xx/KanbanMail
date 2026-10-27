//! Colonne della board, lette da `board.toml` nella cartella di configurazione.
//! Se il file non esiste viene creato con le colonne predefinite.

use crate::account::config_dir;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    /// Nome mostrato in cima alla colonna.
    pub name: String,
    /// Cartella IMAP. Su server che mettono tutto sotto `INBOX.`
    /// basta scrivere `Todo`: l'app trova (o crea) `INBOX.Todo`.
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    /// Quante mail (le più recenti) caricare per colonna.
    #[serde(default = "default_limit")]
    pub max_cards_per_column: u32,
    #[serde(rename = "column")]
    pub columns: Vec<Column>,
}

fn default_limit() -> u32 {
    200
}

const DEFAULT_BOARD: &str = r#"# Colonne della board KanbanMail.
# Ogni blocco [[column]] è una colonna: "name" è il titolo mostrato,
# "folder" è la cartella IMAP. Se la cartella non esiste, l'app la crea.
# Dopo aver modificato questo file, riavvia l'app.

# Quante mail (le più recenti) mostrare al massimo per colonna.
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
                .with_context(|| format!("scrittura di {}", path.display()))?;
        }
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("lettura di {}", path.display()))?;
        let board: Board = toml::from_str(&text)
            .with_context(|| format!("{} non valido", path.display()))?;
        anyhow::ensure!(!board.columns.is_empty(), "board.toml non definisce colonne");
        Ok(board)
    }
}
