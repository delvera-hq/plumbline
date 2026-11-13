import { describe, expect, test } from "vitest";
import { parseConfigFile } from "../src/config-file";

describe("parseConfigFile", () => {
  test("reads KEY=value lines", () => {
    expect(parseConfigFile("MONDAY_BOARD_ID=1234\nJIRA_BASE_URL=https://example.atlassian.net\n")).toEqual({
      MONDAY_BOARD_ID: "1234",
      JIRA_BASE_URL: "https://example.atlassian.net",
    });
  });

  test("skips blank lines and lines starting with #", () => {
    const text = [
      "# Plumbline settings",
      "",
      "MONDAY_BOARD_ID=1234",
      "   ",
      "  # indented comment",
      "JIRA_EMAIL=dev@example.com",
    ].join("\n");

    expect(parseConfigFile(text)).toEqual({ MONDAY_BOARD_ID: "1234", JIRA_EMAIL: "dev@example.com" });
  });

  test("keeps every = after the first as part of the value", () => {
    const classes = JSON.stringify({ "Working on it": "active", "Done = shipped": "done" });

    expect(parseConfigFile(`MONDAY_STATUS_CLASSES=${classes}\n`)).toEqual({ MONDAY_STATUS_CLASSES: classes });
    expect(parseConfigFile("JIRA_TOKEN=a=b==c\n")).toEqual({ JIRA_TOKEN: "a=b==c" });
  });

  test("accepts CRLF line endings and trims spaces around the key and value", () => {
    expect(parseConfigFile("MONDAY_BOARD_ID = 1234 \r\nJIRA_EMAIL=dev@example.com\r\n")).toEqual({
      MONDAY_BOARD_ID: "1234",
      JIRA_EMAIL: "dev@example.com",
    });
  });

  test("keeps an empty value as an empty string", () => {
    expect(parseConfigFile("MONDAY_TOKEN=\n")).toEqual({ MONDAY_TOKEN: "" });
  });

  test("lets a later line replace an earlier one for the same key", () => {
    expect(parseConfigFile("MONDAY_BOARD_ID=1\nMONDAY_BOARD_ID=2\n")).toEqual({ MONDAY_BOARD_ID: "2" });
  });

  test("returns no settings for an empty file", () => {
    expect(parseConfigFile("")).toEqual({});
    expect(parseConfigFile("# only a comment\n\n")).toEqual({});
  });

  test("throws on a line with no = and names its line number, not its text", () => {
    const text = "MONDAY_BOARD_ID=1234\nmon-secret-token-111\n";

    expect(() => parseConfigFile(text)).toThrow("config file line 2 is not KEY=value");
    try {
      parseConfigFile(text);
    } catch (error) {
      expect(String(error)).not.toContain("mon-secret-token-111");
    }
  });

  test("throws on a line with no key before the =", () => {
    expect(() => parseConfigFile("MONDAY_BOARD_ID=1\n=orphan-value\n")).toThrow("config file line 2 is not KEY=value");
  });
});
