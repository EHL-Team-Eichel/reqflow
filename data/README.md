# data/

| Folder | Git | Contents |
|---|---|---|
| `raw/` | **ignored** | BMW-provided datasets per vehicle: customer feedback, equipment data, sales volumes, customer study. Confidential. Never commit them and never paste them into prompts for external tools. |
| `uploads/` | ignored | Files uploaded through the Workflow page (`FileStore`) |
| `samples/` | committed | Small **synthetic** files in the same formats as `raw/`, for development and tests (WS5) |
| `app.db` | ignored | SQLite database (created by `@reqflow/db`) |

When the real BMW data arrives, drop it into `raw/` and record each file's format (columns, language,
volume, market and vehicle coverage) in `data/raw/FORMATS.md`. That file is also ignored, so share it
through the team chat if needed. WS5 then aligns the parsers and samples.
