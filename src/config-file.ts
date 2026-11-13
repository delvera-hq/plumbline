/**
 * Parses a `--config` file: one `KEY=value` setting per line. Blank lines and lines starting with `#` are skipped.
 * Only the first `=` separates the key from the value, so a value may contain `=`, as MONDAY_STATUS_CLASSES does.
 * A later line for the same key replaces an earlier one. The error names the line number, never its text,
 * because a malformed line may hold a token.
 */
export function parseConfigFile(text: string): Record<string, string> {
  const settings: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    const key = separator === -1 ? "" : line.slice(0, separator).trim();
    if (key === "") throw new Error(`config file line ${index + 1} is not KEY=value`);
    settings[key] = line.slice(separator + 1).trim();
  }
  return settings;
}
