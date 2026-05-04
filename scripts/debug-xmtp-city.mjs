import { chromium } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const appUrl = process.env.CITY_URL ?? "http://127.0.0.1:5173/";
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function makePetFiles(name) {
  const dir = await mkdtemp(path.join(tmpdir(), `openagent-city-${name}-`));
  const petJsonPath = path.join(dir, "pet.json");
  const spritePath = path.resolve("public/assets/pixel-agents/characters/char_0.png");

  await writeFile(
    petJsonPath,
    `${JSON.stringify(
      {
        id: name,
        displayName: name,
        description: `Debug pet ${name}`,
        spritesheetPath: "char_0.png",
      },
      null,
      2,
    )}\n`,
  );

  return { dir, files: [petJsonPath, spritePath] };
}

async function debugText(page) {
  const details = page.locator("details.city-chat-debug");
  await details.evaluate((node) => {
    node.open = true;
  });
  return details.innerText();
}

function parseDebug(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const pairs = {};

  for (let index = 1; index < lines.length - 1; index += 2) {
    pairs[lines[index]] = lines[index + 1];
  }

  return pairs;
}

async function waitForDebug(page, predicate, label, timeout = 90000) {
  const start = Date.now();
  let last = "";

  while (Date.now() - start < timeout) {
    try {
      last = await debugText(page);
      const parsed = parseDebug(last);

      if (predicate(parsed, last)) {
        return parsed;
      }
    } catch {
      // Page is still booting.
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(`Timed out waiting for ${label}. Last debug:\n${last}`);
}

async function enterCity(page, name) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  if (await page.getByText("Bring your pet into the city").isVisible().catch(() => false)) {
    await page
      .getByRole("button", { name: /Upload pet folder/i })
      .waitFor({ state: "visible", timeout: 90000 });
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll("button")];
      const upload = buttons.find((button) => /Upload pet folder/i.test(button.textContent ?? ""));
      return Boolean(upload && !upload.disabled);
    });

    const pet = await makePetFiles(name);
    await page.locator("input[type=file]").setInputFiles(pet.files);
    await page.getByRole("button", { name: /Enter Codex City/i }).waitFor({ timeout: 120000 });
    await page.getByRole("button", { name: /Enter Codex City/i }).click();
    await rm(pet.dir, { recursive: true, force: true });
  } else if (await page.getByRole("button", { name: /Enter Codex City/i }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /Enter Codex City/i }).click();
  }

  await page.locator(".city-chat").waitFor({ timeout: 120000 });
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "openagent-city-xmtp-"));
  const aDir = path.join(root, "profile-a");
  const bDir = path.join(root, "profile-b");
  const contextOptions = {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ["--use-fake-ui-for-media-stream"],
  };

  const contextA = await chromium.launchPersistentContext(aDir, contextOptions);
  const contextB = await chromium.launchPersistentContext(bDir, contextOptions);
  const pageA = contextA.pages()[0] ?? (await contextA.newPage());
  const pageB = contextB.pages()[0] ?? (await contextB.newPage());

  pageA.on("console", (message) => console.log("[A console]", message.type(), message.text()));
  pageB.on("console", (message) => console.log("[B console]", message.type(), message.text()));
  pageA.on("pageerror", (error) => console.log("[A pageerror]", error.message));
  pageB.on("pageerror", (error) => console.log("[B pageerror]", error.message));

  try {
    console.log("Entering city in browser A");
    await enterCity(pageA, "Debug A");
    console.log("Entering city in browser B");
    await enterCity(pageB, "Debug B");

    console.log("Resetting city chat from browser A");
    await pageA.locator(".city-chat-header button", { hasText: "Reset" }).click();

    const liveA = await waitForDebug(pageA, (debug) => debug.Status === "ready", "A ready");
    console.log("A ready", liveA);

    const liveB = await waitForDebug(pageB, (debug) => debug.Status === "ready", "B ready");
    console.log("B ready", liveB);

    const message = `hello from playwright ${Date.now()}`;
    await pageA.getByPlaceholder("Message Codex City").fill(message);
    await pageA.getByRole("button", { name: "Send" }).click();

    const receivedB = await waitForDebug(
      pageB,
      (debug) => {
        const messages = debug.Messages ?? "";
        return /[1-9]\d*\s+text/.test(messages) || (debug["Last stream message"] ?? "none") !== "none";
      },
      "B receive message",
      60000,
    );
    console.log("B received", receivedB);

    await pageB.reload({ waitUntil: "domcontentloaded" });
    await pageB.locator(".city-chat").waitFor({ timeout: 90000 });
    const afterReloadB = await waitForDebug(
      pageB,
      (debug) => {
        const messages = debug.Messages ?? "";
        return /[1-9]\d*\s+text/.test(messages) || /[1-9]\d*\s+raw/.test(messages);
      },
      "B history after reload",
      90000,
    );
    console.log("B after reload", afterReloadB);
  } finally {
    console.log("Final A debug:\n", await debugText(pageA).catch(async (error) => {
      return `${error.message}\n${await pageA.locator("body").innerText().catch(() => "")}`;
    }));
    console.log("Final B debug:\n", await debugText(pageB).catch(async (error) => {
      return `${error.message}\n${await pageB.locator("body").innerText().catch(() => "")}`;
    }));
    await contextA.close();
    await contextB.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
