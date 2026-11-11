// scripts/release-manifest.mjs: classifies the migrations added since the previous tag.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const meta = JSON.parse(readFileSync("migrations/schema.json", "utf8"));
// migrations/schema.json: { "schema_version": 7, "compatible_schema": [6, 7] }
const tags = git("tag", "--merged", "HEAD", "--sort=-version:refname").split("\n").filter(Boolean);
const previous = tags[1];
const added = previous
  ? git("diff", "--name-only", "--diff-filter=AM", previous, "HEAD", "--", "migrations/*.sql")
      .split("\n")
      .filter(Boolean)
  : [];

const CONTRACT =
  /\b(drop\s+(table|column)|rename\s+(to|column)|alter\s+column\s+\S+\s+(type|set\s+not\s+null)|truncate)\b/i;
const DATA = /\b(update|delete\s+from)\b/i;
let migrationClass = added.length ? "expand" : "none";
for (const file of added) {
  const sql = readFileSync(file, "utf8");
  const risky = CONTRACT.test(sql) || DATA.test(sql);
  // /migrations/gated/ is under code owners, so a risky migration cannot reach main unapproved.
  if (risky && !file.startsWith("migrations/gated/")) {
    console.error(`::error::${file} is data or contract class and must live in migrations/gated/`);
    process.exit(1);
  }
  if (CONTRACT.test(sql)) migrationClass = "contract";
  else if (DATA.test(sql) && migrationClass !== "contract") migrationClass = "data";
}
console.log(`migration_class=${migrationClass}`);
console.log(`schema_version=${meta.schema_version}`);
console.log(`compatible_schema=${JSON.stringify(meta.compatible_schema)}`);
