# data/

| Folder     | Git         | Contents                                                                                                                                                                                                         |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw/`     | **ignored** | BMW-provided datasets per vehicle: customer feedback, equipment data, sales volumes, customer study. Confidential. Never commit them and never paste them into prompts for external tools.                       |
| `samples/` | committed   | Small **synthetic** files in the same formats as `raw/`, for development and tests (WS5)                                                                                                                         |

The app itself does **not** read from this folder. Users import datasets through the native file dialog
(`api.files.import()`), and the app copies them into its own data directory next to the database
(macOS `~/Library/Application Support/ReqFlow/data`, Windows `%APPDATA%\ReqFlow\data`, Linux
`~/.config/ReqFlow/data`; override with `REQFLOW_DATA_DIR`).

When the real BMW data arrives, drop it into `raw/` and record each file's format (columns, language,
volume, market and vehicle coverage) in `data/raw/FORMATS.md`. That file is also ignored, so share it
through the team chat if needed. WS5 then aligns the parsers and samples.
