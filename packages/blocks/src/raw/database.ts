import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Cell } from "./table";

const SUPPORTED = new Set(["sqlite"]);

/** A single read-only SELECT (or WITH … SELECT); a trailing semicolon is fine, a second statement isn't. */
export function assertReadOnlyQuery(query: string): string {
  const q = query.trim().replace(/;\s*$/, "");
  if (!q) throw new Error("Enter a query, e.g. SELECT * FROM customer_feedback");
  if (!/^(select|with)\b/i.test(q)) throw new Error("Only SELECT queries are allowed");
  if (q.includes(";")) throw new Error("Only one statement is allowed");
  return q;
}

/**
 * Reads a table from a database. Only SQLite files work in the prototype; they are opened read-only.
 * Other databases fail with a clear message instead of pretending to connect.
 */
export function readDatabase(
  dbType: string,
  connection: string,
  query: string,
): { rows: Cell[][]; title: string; key: string } {
  if (!SUPPORTED.has(dbType)) {
    throw new Error(
      `${dbType} isn't supported yet. Use a SQLite file, or export the table as .xlsx / .csv and upload it.`,
    );
  }
  const path = connection.trim();
  if (!path) throw new Error("Enter the path of the SQLite database file");
  const sql = assertReadOnlyQuery(query);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new Error(`Couldn't open "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const statement = db.prepare(sql);
    const objects = statement.all() as Record<string, unknown>[];
    const header = statement.columns().map((c) => c.name);
    const rows: Cell[][] = [
      header,
      ...objects.map((o) =>
        header.map((h): Cell => {
          const v = o[h];
          if (v === null || v === undefined) return null;
          if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
          if (typeof v === "bigint") return Number(v);
          return "[binary]";
        }),
      ),
    ];
    return { rows, title: `${basename(path)} · query`, key: `sqlite:${path}|${sql}` };
  } catch (err) {
    throw new Error(`The query failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db.close();
  }
}
