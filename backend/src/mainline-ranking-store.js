import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAINLINE_RANKING_DB_PATH = resolve(
  MODULE_DIR,
  "..",
  "..",
  "storage",
  "mainline-rankings.sqlite",
);

function rankRows(results) {
  return [...(Array.isArray(results) ? results : [])]
    .filter((row) => String(row?.sectorCode ?? "").trim())
    .sort((left, right) => {
      const scoreDelta = Number(right?.mainlineScore ?? -Infinity) - Number(left?.mainlineScore ?? -Infinity);
      if (scoreDelta !== 0) return scoreDelta;
      return String(left?.sectorCode ?? "").localeCompare(String(right?.sectorCode ?? ""), "zh-CN");
    });
}

export function createMainlineRankingStore(dbPath = DEFAULT_MAINLINE_RANKING_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  let closed = false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mainline_rankings (
      source_key TEXT NOT NULL,
      analysis_date TEXT NOT NULL,
      sector_code TEXT NOT NULL,
      sector_name TEXT,
      mainline_score REAL NOT NULL,
      rank INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (source_key, analysis_date, sector_code)
    );
    CREATE INDEX IF NOT EXISTS idx_mainline_rankings_history
      ON mainline_rankings (source_key, analysis_date DESC);
  `);

  return {
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },

    replaceSnapshot({ sourceKey, analysisDate, capturedAt, results }) {
      const source = String(sourceKey ?? "").trim();
      const date = String(analysisDate ?? "").trim();
      if (!source || !date) return;
      const ranked = rankRows(results);
      db.prepare("DELETE FROM mainline_rankings WHERE source_key = ? AND analysis_date = ?").run(source, date);
      const insert = db.prepare(`
        INSERT INTO mainline_rankings (
          source_key, analysis_date, sector_code, sector_name, mainline_score, rank, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, row] of ranked.entries()) {
        insert.run(
          source,
          date,
          String(row.sectorCode).trim(),
          String(row.sectorName ?? "").trim() || null,
          Number(row.mainlineScore),
          index + 1,
          String(capturedAt ?? new Date().toISOString()),
        );
      }
    },

    listHistory({ sourceKey, sectorCodes, days = 5 }) {
      const source = String(sourceKey ?? "").trim();
      const codes = [...new Set((sectorCodes ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
      const output = Object.fromEntries(codes.map((code) => [code, []]));
      if (!source || !codes.length) return output;
      const dateRows = db.prepare(`
        SELECT analysis_date
        FROM mainline_rankings
        WHERE source_key = ?
        GROUP BY analysis_date
        ORDER BY analysis_date DESC
        LIMIT ?
      `).all(source, Math.max(1, Math.min(365, Number(days) || 5)));
      const dates = dateRows.map((row) => row.analysis_date);
      if (!dates.length) return output;
      const codePlaceholders = codes.map(() => "?").join(", ");
      const datePlaceholders = dates.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT sector_code, analysis_date, rank, mainline_score
        FROM mainline_rankings
        WHERE source_key = ?
          AND sector_code IN (${codePlaceholders})
          AND analysis_date IN (${datePlaceholders})
        ORDER BY analysis_date DESC, rank ASC
      `).all(source, ...codes, ...dates);
      for (const row of rows) {
        output[row.sector_code]?.push({
          analysisDate: row.analysis_date,
          rank: Number(row.rank),
          mainlineScore: Number(row.mainline_score),
        });
      }
      return output;
    },
  };
}
