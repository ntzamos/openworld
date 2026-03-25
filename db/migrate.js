import { readdir, readFile } from "fs/promises";
import { join } from "path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export async function runMigrations(sql) {
  // Create migrations tracking table if it doesn't exist
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Get already applied migrations
  const applied = await sql`SELECT name FROM _migrations ORDER BY name`;
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read migration files sorted by name
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const content = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`[migrate] Running ${file}...`);

    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });

    count++;
    console.log(`[migrate] Applied ${file}`);
  }

  if (count === 0) {
    console.log("[migrate] All migrations up to date");
  } else {
    console.log(`[migrate] Applied ${count} migration(s)`);
  }
}
