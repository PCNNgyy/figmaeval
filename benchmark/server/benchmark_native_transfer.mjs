import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { figmaKey } from "./benchmark_protocol.mjs";

const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); };
export function nativeDraftsDestination(value) {
  const url = new URL(value);
  return url.origin === 'https://www.figma.com' ? url.pathname.match(/^\/files\/(?:team\/)?(\d+)\/drafts\/?$/)?.[1] || null : null;
}

export function browserVerificationError() {
  return Object.assign(new Error('Figma browser verification (CAPTCHA) blocks native export; refresh this browser session or use another authorized account with access'),
    { code: 'FIGMA_BROWSER_VERIFICATION_REQUIRED' });
}

async function nativeDownload(page, click, timeout) {
  const verification = page.getByText('Figma needs to verify you are not a bot.', { exact: true });
  if (await verification.isVisible()) throw browserVerificationError();
  const downloaded = page.waitForEvent('download', { timeout });
  const blocked = verification.waitFor({ state: 'visible', timeout }).then(() => { throw browserVerificationError(); });
  const result = Promise.race([downloaded, blocked]); result.catch(() => {});
  await click();
  return result;
}

export async function exportNativeTemplate({ page, config, record, identity }) {
  const sourceKey = figmaKey(record.source_figma_url);
  if (!path.isAbsolute(config.native_export_cache || "")) throw new Error("Native transfer requires a private export cache");
  const cache = path.join(config.native_export_cache, `${sourceKey}.fig`), receiptFile = `${cache}.json`;
  let cached = false;
  if (fs.existsSync(cache) && fs.existsSync(receiptFile)) {
    const receipt = JSON.parse(fs.readFileSync(receiptFile));
    if (receipt.source_file_key !== sourceKey || receipt.sha256 !== digest(cache)) throw new Error("Native template export cache checksum mismatch");
    cached = true;
  }
  if (!cached) {
    await page.goto(record.source_figma_url, { waitUntil: "domcontentloaded", timeout: config.navigation_timeout_ms || 60000 });
    await page.getByTestId("filename").waitFor({ timeout: config.navigation_timeout_ms || 60000 }); await identity();
    if (figmaKey(page.url()) !== sourceKey) throw new Error("Export source URL changed");
    await page.getByRole("button", { name: "Main menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "File", exact: true }).click();
    const download = await nativeDownload(page,
      () => page.getByText("Save local copy…", { exact: true }).click(), config.native_download_timeout_ms || 180000);
    if (!download.suggestedFilename().toLowerCase().endsWith(".fig")) throw new Error("Figma did not export a native .fig file");
    fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
    const temp = `${cache}.${process.pid}.tmp`; await download.saveAs(temp); fs.chmodSync(temp, 0o600); fs.renameSync(temp, cache);
    save(receiptFile, { source_file_key: sourceKey, source_url: record.source_figma_url, sha256: digest(cache), bytes: fs.statSync(cache).size,
      exporter: config.identity_email, exported_at: new Date().toISOString(), method: "native-browser-local-copy" });
  }
  return cache;
}

export async function nativeTransfer({ page, context, config, record, beforeDuplicate, onDiscovered, identity }) {
  const sourceKey = figmaKey(record.source_figma_url);
  const cache = await exportNativeTemplate({ page, config, record, identity });
  const generation = (record.abandoned_preparation_copies || []).length + 1;
  const operationId = (record.retry_id || record.assignment_id) + (generation > 1 ? `-copy-${generation}` : "");
  const operationDir = path.join(config.native_export_cache, "imports", operationId);
  fs.mkdirSync(operationDir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(operationDir, "receipt.json");
  if (fs.existsSync(receiptPath) && JSON.parse(fs.readFileSync(receiptPath)).upload_attempted) {
    throw Object.assign(new Error("Native import was already attempted; reconcile its result before any new upload"), { code: "FIGMA_COPY_RECONCILIATION" });
  }
  const title = `${record.assignment_id}--${record.retry_id || "first"}` + (generation > 1 ? `--copy-${generation}` : "");
  const upload = path.join(operationDir, `${title}.fig`); fs.copyFileSync(cache, upload); fs.chmodSync(upload, 0o600);
  const receipt = { source_url: record.source_figma_url, source_sha256: digest(cache), identity: config.identity_email,
    destination: config.destination, title, upload_attempted: false, events: [] };
  const persist = () => save(receiptPath, receipt);
  persist();
  let chooser = null;
  const chooserListener = (value) => { chooser = value; };
  const responseListener = async (response) => {
    const pathname = new URL(response.url()).pathname;
    if (!/import|upload/.test(pathname) || !response.headers()["content-type"]?.includes("json")) return;
    try {
      const data = await response.json(), fields = [];
      const collect = (node, at = "") => { if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === "string" && (/^(file_?key|file_?id|key)$/i.test(key) && /^[A-Za-z0-9]{20,30}$/.test(value)
              || /^(name|title|filename|file_name)$/i.test(key))) fields.push({ at: `${at}.${key}`, value: value.slice(0, 200) });
          else if (typeof value === "object") collect(value, `${at}.${key}`);
        } };
      collect(data); receipt.events.push({ path: pathname, status: response.status(), fields }); persist();
    } catch {}
  };
  page.on("filechooser", chooserListener); page.on("response", responseListener);
  try {
    await page.goto(config.destination, { waitUntil: "domcontentloaded", timeout: config.navigation_timeout_ms || 60000 });
    await page.getByTestId("ProfileButton").waitFor({ timeout: 45000 }); await identity();
    const expectedTeam = nativeDraftsDestination(config.destination), actualTeam = nativeDraftsDestination(page.url());
    if (!expectedTeam || expectedTeam !== actualTeam) throw new Error("Native import destination is not the approved team drafts");
    await page.waitForTimeout(8000);
    await page.getByRole("button", { name: "New file", exact: true }).evaluate((button) => button.click());
    await page.getByText("Import", { exact: true }).click({ timeout: 30000 });
    const input = page.locator('input[type="file"]').first();
    const importButton = page.getByRole("button", { name: "Import from computer", exact: true });
    let chooserTimer;
    try {
      await Promise.any([
        input.waitFor({ state: "attached", timeout: 45000 }), importButton.waitFor({ timeout: 45000 }),
        new Promise((resolve, reject) => { const until = Date.now() + 45000; const poll = () => chooser ? resolve() : Date.now() > until ? reject(new Error("No native import chooser")) : (chooserTimer=setTimeout(poll,100)); poll(); }),
      ]);
    } finally {clearTimeout(chooserTimer);}
    let selectFile;
    if (chooser) selectFile=()=>chooser.setFiles(upload);
    else if (await importButton.isVisible()) {
      const selected=page.waitForEvent('filechooser',{timeout:30000});selected.catch(()=>{});
      await importButton.click();const actual=await selected;selectFile=()=>actual.setFiles(upload);
    } else if (await input.count()===1) selectFile=()=>input.setInputFiles(upload);
    else throw new Error('Native import chooser is ambiguous; no file was selected');
    beforeDuplicate();receipt.upload_attempted=true;receipt.upload_started_at=new Date().toISOString();persist();
    await selectFile();
    await page.getByText(title, { exact: true }).first().waitFor({ timeout: 180000 });
    await page.getByText("Importing to Drafts", { exact: true }).waitFor({ state: "hidden", timeout: 180000 });
    const done = page.getByRole("button", { name: "Done", exact: true }); if (await done.isVisible()) await done.click();
    const newPage = context.waitForEvent("page", { timeout: 60000 }).then(async (tab) => { await tab.waitForURL(/\/(design|file)\//, { waitUntil: "commit", timeout: 60000 }); return tab; });
    const samePage = page.waitForURL(/\/(design|file)\//, { waitUntil: "commit", timeout: 60000 }).then(() => page);
    const opened = Promise.any([newPage, samePage]); opened.catch(() => {});
    await page.getByText(title, { exact: true }).first().dblclick({ timeout: 60000 });
    const target = await opened, key = figmaKey(target.url());
    if (key === sourceKey) throw new Error("Import returned the read-only template");
    receipt.target_figma_url = `https://www.figma.com/design/${key}/`; receipt.finished_at = new Date().toISOString(); persist();
    onDiscovered(receipt.target_figma_url);
    return target;
  } catch (error) {
    receipt.error = error.message;
    try { receipt.failure_location=page.url();receipt.failure_page_text=(await page.locator('body').innerText({timeout:3000})).slice(0,16000); } catch {}
    persist();throw error;
  }
  finally { page.off("filechooser", chooserListener); page.off("response", responseListener); }
}
