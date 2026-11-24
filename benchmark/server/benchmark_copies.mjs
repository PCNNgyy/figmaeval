import fs from "node:fs";
import { nativeTransfer, exportNativeTemplate } from "./benchmark_native_transfer.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { figmaKey, verifySeal } from "./benchmark_protocol.mjs";

export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

export async function provisionCopies(dataset, plan, journalFile, provider, { limit = Infinity, log = () => {} } = {}) {
  verifySeal(dataset); verifySeal(plan);
  if (dataset.content_hash !== plan.dataset_hash) throw new Error("Copy plan does not match the immutable dataset");
  const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile))
    : { plan_hash: plan.content_hash, dataset_hash: dataset.content_hash, copies: [] };
  if (journal.plan_hash !== plan.content_hash || journal.dataset_hash !== dataset.content_hash) throw new Error("Cannot reuse another plan's copy journal");
  const protectedKeys = new Set(dataset.cases.map((item) => item.source_file_key));
  const used = new Set(); const assignments = new Set();
  for (const row of journal.copies) {
    const assignment = plan.assignments.find((a) => a.assignment_id === row.assignment_id);
    const item = dataset.cases.find((c) => c.case_id === assignment?.case_id);
    if (!assignment || assignments.has(row.assignment_id) || row.source_figma_url !== item?.source_figma_url
        || row.model_id !== assignment.model_id || row.case_id !== assignment.case_id) throw new Error("Copy journal changed the original URL or assignment identity");
    assignments.add(row.assignment_id);
    if (row.target_figma_url) {
      const key = figmaKey(row.target_figma_url);
      if (protectedKeys.has(key) || used.has(key)) throw new Error("Copy journal contains an original or reused file");
      used.add(key);
    }
  }
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new Error("Copy limit must be a nonnegative integer");
  const pending = plan.assignments.filter((a) => journal.copies.find((r) => r.assignment_id === a.assignment_id)?.status !== "ready").slice(0, limit);
  for (const assignment of pending) {
    const record = journal.copies.find((r) => r.assignment_id === assignment.assignment_id);
    if (record && ["duplicate_requested", "ambiguous"].includes(record.status)) throw new Error(`Copy ${record.assignment_id} requires reconciliation; never duplicate again after an ambiguous response`);
  }
  const providers = Array.isArray(provider) ? provider : [provider];
  if (!providers.length) throw new Error("A copy provider is required");
  let nextIndex = 0; let stopped = false;
  const worker = async (workerProvider) => {
   while (!stopped && nextIndex < pending.length) {
    const assignment = pending[nextIndex++];
    const item = dataset.cases.find((c) => c.case_id === assignment.case_id);
    let record = journal.copies.find((row) => row.assignment_id === assignment.assignment_id);
    if (!record) {
      record = { ...assignment, source_figma_url: item.source_figma_url, name: `${plan.id} · ${assignment.assignment_id}`, status: "pending" };
      journal.copies.push(record); saveJson(journalFile, journal);
    }
    if (record.status === "ready") continue;
    if (["duplicate_requested", "ambiguous"].includes(record.status)) throw new Error(`Copy ${record.assignment_id} requires reconciliation; never duplicate again after an ambiguous response`);
    record.preparation_started_at ||= new Date().toISOString();
    try {
      if (!record.target_figma_url) {
        const discovered = (url) => {
          const key = figmaKey(url);
          if (record.target_figma_url && figmaKey(record.target_figma_url) === key) return;
          if (record.target_figma_url || protectedKeys.has(key) || used.has(key)) throw new Error("Duplication returned an original or another model's copy");
          used.add(key); record.target_figma_url = url; record.status = "copied"; record.copied_at = new Date().toISOString(); saveJson(journalFile, journal);
        };
        const url = await workerProvider.duplicate(record, () => {
          record.status = "duplicate_requested"; record.requested_at = new Date().toISOString(); saveJson(journalFile, journal);
        }, discovered);
        discovered(url);
      }
      await workerProvider.verifyCopy(record);
      record.status = "ready"; record.verified_at = new Date().toISOString(); delete record.error;
      record.preparation_duration_ms = Date.parse(record.verified_at) - Date.parse(record.preparation_started_at);
      saveJson(journalFile, journal); log({ assignment_id: record.assignment_id, status: "ready", target_figma_url: record.target_figma_url });
    } catch (error) {
      if (record.status === "duplicate_requested") record.status = "ambiguous";
      record.error = error.message; record.last_location = workerProvider.location?.() || "";
      stopped = true; saveJson(journalFile, journal); throw error;
    }
   }
  };
  const results = await Promise.allSettled(providers.map(worker));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return journal;
}

export async function openFigmaCopyProvider(config) {
  for (const field of ["playwright_module", "browser_executable", "storage_state", "browser_lease_module", "identity_email", "identity_name", "user_id", "destination"]) {
    if (!config[field]) throw new Error(`Browser configuration requires ${field}`);
  }
  const { chromium } = await import(pathToFileURL(path.resolve(config.playwright_module)));
  const { acquireBrowserLease } = await import(pathToFileURL(path.resolve(config.browser_lease_module)));
  const release = await acquireBrowserLease();
  let browser;
  try { browser = await chromium.launch({ executablePath: config.browser_executable, headless: true,
    env: { ...process.env, ...(config.library_path ? { LD_LIBRARY_PATH: [config.library_path, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) } : {}) },
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...(config.browser_args || [])] }); }
  catch (error) { release(); throw error; }
  let context; let page;
  try {
    context = await browser.newContext({ storageState: config.storage_state, locale: "en-US", viewport: { width: 1440, height: 1100 },
      userAgent: config.user_agent || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36" });
    page = await context.newPage();
  } catch (error) { try { await browser.close(); } finally { release(); } throw error; }
  const identity = async () => {
    const current = await page.evaluate(() => localStorage.getItem("figment:userId")?.replaceAll('"', ""));
    if (current !== config.user_id) throw new Error("Figma browser identity changed; no copy or design write permitted");
  };
  const persistSession = async () => {
    await identity();
    const temp = `${config.storage_state}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(await context.storageState()), { mode: 0o600 });
    fs.renameSync(temp, config.storage_state);
  };
  try {
    await page.goto(config.destination, { waitUntil: "domcontentloaded", timeout: config.navigation_timeout_ms || 60000 });
    const profile = page.getByTestId("ProfileButton").or(page.getByRole("button", { name: `Account dropdown for ${config.identity_name}`, exact: true })).first();
    await Promise.race([
      profile.waitFor({ state: "visible", timeout: config.navigation_timeout_ms || 45000 }),
      page.waitForURL((url) => /^\/(login|verify)(?:\/|$)/.test(url.pathname), { timeout: config.navigation_timeout_ms || 45000 }).then(() => {
        throw Object.assign(new Error("Figma browser login expired; refresh the assigned account's saved browser state"), { code: "FIGMA_BROWSER_LOGIN_REQUIRED" });
      }),
    ]);
    await profile.click({ timeout: 45000 });
    await page.getByText(config.identity_email, { exact: true }).first().waitFor();
    await identity(); await page.keyboard.press("Escape");
  } catch (error) { try { await browser.close(); } finally { release(); } throw error; }
  return {
    location: () => page.url(),
    async diagnostics() {
      const url=new URL(page.url());
      return {location:url.origin+url.pathname,text:(await page.locator('body').innerText({timeout:5000})).slice(0,12000)};
    },
    async inspectDrafts() {
      await page.goto(config.destination,{waitUntil:'domcontentloaded',timeout:config.navigation_timeout_ms||60000});
      await page.getByTestId('ProfileButton').waitFor({timeout:45000});await identity();
      await page.waitForTimeout(5000);
      return {location:page.url(),text:await page.locator('body').innerText(),links:await page.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>({text:n.innerText,url:n.href})))};
    },
    async exportTemplate(record) {
      return exportNativeTemplate({page, config, record, identity});
    },
    async duplicate(record, beforeDuplicate, onDiscovered = () => {}) {
      if (config.copy_method === "native-transfer") {
        const next = await nativeTransfer({ page, context, config, record, beforeDuplicate, onDiscovered, identity });
        if (next !== page) { await page.close(); page = next; }
        return `https://www.figma.com/design/${figmaKey(page.url())}/`;
      }
      await page.goto(record.source_figma_url, { waitUntil: "domcontentloaded", timeout: config.navigation_timeout_ms || 60000 });
      await page.getByTestId("filename").waitFor({ timeout: config.navigation_timeout_ms || 60000 }); await identity();
      const sourceKey = figmaKey(record.source_figma_url);
      if (figmaKey(page.url()) !== sourceKey) throw new Error("Opened source does not match the immutable URL");
      await page.getByRole("button", { name: "Edit file menu", exact: true }).click();
      const isCopy = (url) => /^\/(design|file)\//.test(url.pathname) && url.pathname.split("/")[2] !== sourceKey;
      const newTab = context.waitForEvent("page", { timeout: 60000 }).then(async (tab) => { await tab.waitForURL(isCopy, { waitUntil: "commit", timeout: 60000 }); return tab; });
      const sameTab = page.waitForURL(isCopy, { waitUntil: "commit", timeout: 60000 }).then(() => page);
      const copiedPage = Promise.any([newTab, sameTab]);
      copiedPage.catch(() => {});
      beforeDuplicate();
      await page.getByRole("menuitem", { name: "Duplicate to your drafts", exact: true })
        .or(page.getByRole("menuitem", { name: "Duplicate", exact: true })).first().click();
      const next = await copiedPage;
      onDiscovered(`https://www.figma.com/design/${figmaKey(next.url())}/`);
      if (next !== page) { await page.close(); page = next; }
      return `https://www.figma.com/design/${figmaKey(page.url())}/`;
    },
    async verifyCopy(record) {
      if (figmaKey(record.target_figma_url) === figmaKey(record.source_figma_url)) throw new Error("Cannot rename or modify an original template");
      await page.goto(record.target_figma_url, { waitUntil: "domcontentloaded", timeout: config.navigation_timeout_ms || 60000 });
      await page.getByTestId("filename").waitFor({ timeout: config.navigation_timeout_ms || 60000 }); await identity();
      if (figmaKey(page.url()) !== figmaKey(record.target_figma_url)) throw new Error("Copy URL mismatch");
      const previous = await page.getByTestId("filename").innerText();
      if (previous !== record.name) {
        await page.getByRole("button", { name: "Edit file menu", exact: true }).click();
        await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
        let field;
        for (const input of await page.locator("input").all()) if (await input.inputValue() === previous) { field = input; break; }
        if (!field) throw new Error("Copy rename field missing");
        await field.fill(record.name); await field.press("Enter");
      }
      await page.getByRole("button", { name: "Share", exact: true }).click();
      await page.getByText("owner", { exact: true }).waitFor();
      if (!/\(you\)\s*owner/.test(await page.locator("body").innerText())) throw new Error("Configured account does not own the copy");
      await page.keyboard.press("Escape");
    },
    async close() {
      try { if (!new URL(page.url()).pathname.startsWith("/login")) await persistSession(); }
      catch (error) { console.error(`Browser session persistence failed: ${error.message}`); }
      finally { try { await browser.close(); } finally { release(); } }
    },
  };
}
