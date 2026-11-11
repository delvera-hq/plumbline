import { expect, test } from "@playwright/test";

const base = process.env.BASE_URL ?? "";

test("@smoke landing page renders and serves the expected version", async ({ page, request }) => {
  const response = await page.goto(base);
  expect(response?.status()).toBe(200);
  await expect(page.locator("h1").first()).toBeVisible();

  const version = await request.get(`${base}/__version.json`);
  expect(version.ok()).toBeTruthy();
  expect((await version.json()).version).toBe(process.env.EXPECT_VERSION);
});

test("@smoke docs and changelog respond", async ({ request }) => {
  for (const path of ["/docs/", "/changelog/"]) {
    expect((await request.get(`${base}${path}`)).status(), path).toBe(200);
  }
});
