import { expect, test } from "vitest";
import { health } from "../src/health";

test("health reports the version", () => {
  expect(health("1.2.3")).toEqual({ ok: true, version: "1.2.3" });
});
