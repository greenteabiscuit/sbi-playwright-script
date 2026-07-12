import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import crypto from "node:crypto";

const root = process.cwd();
const profileDir = path.join(root, "profile");
const fromYear = Number(process.env.SBI_FROM_YEAR || "2018");
const toYear = Number(process.env.SBI_TO_YEAR || "2026");
const downloadDir = path.join(root, "downloads", `${fromYear}-${toYear}`);
const snapshotDir = path.join(root, "snapshots");
const manifestPath = path.join(root, "downloads", `manifest-${fromYear}-${toYear}.jsonl`);
const edeliveryUrl = "https://www.sbisec.co.jp/ETGate/?_ControlID=WPLETsmR001Control&_DataStoreID=DSWPLETsmR001Control&OutSide=on&getFlg=on&sw_page=Edeliv&cat1=home&cat2=none";
const reportViewerUrl = "https://www.sbisec.co.jp/edeliv/deisw070.jsp?ePoboxFlag=true";

const rl = readline.createInterface({ input, output });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitize(inputText) {
  return String(inputText || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function ensureDirs() {
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(downloadDir, { recursive: true });
  await fs.mkdir(snapshotDir, { recursive: true });
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function appendManifest(record) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.appendFile(manifestPath, `${JSON.stringify(record)}\n`);
}

async function loadDownloadedKeys() {
  try {
    const content = await fs.readFile(manifestPath, "utf8");
    const keys = new Set();
    for (const line of content.split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.key) keys.add(record.key);
      keys.add(baseReportKey(record));
    }
    return keys;
  } catch {
    return new Set();
  }
}

function baseReportKey(metadata) {
  return [metadata.date, metadata.type, metadata.text].map(sanitize).join("|");
}

function reportKey(metadata) {
  return [metadata.date, metadata.type, metadata.text, metadata.pdfText || ""].map(sanitize).join("|");
}

async function saveSnapshot(page, label) {
  const safe = `${stamp()}-${sanitize(label) || "page"}`;
  const htmlPath = path.join(snapshotDir, `${safe}.html`);
  const pngPath = path.join(snapshotDir, `${safe}.png`);
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  console.log(`Snapshot: ${htmlPath}`);
}

async function visibleText(locator) {
  try {
    return sanitize(await locator.innerText({ timeout: 800 }));
  } catch {
    return "";
  }
}

async function clickText(page, texts) {
  for (const text of texts) {
    const candidates = [
      page.getByRole("link", { name: new RegExp(text) }),
      page.getByRole("button", { name: new RegExp(text) }),
      page.locator(`text=${text}`).first()
    ];
    for (const candidate of candidates) {
      try {
        if (await candidate.isVisible({ timeout: 1000 })) {
          console.log(`Clicking: ${text}`);
          await candidate.click({ timeout: 3000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          return true;
        }
      } catch {}
    }
  }
  return false;
}

async function dumpInteractiveHints(page) {
  const hints = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("a,button,input,select")];
    return nodes.slice(0, 1200).map((el, i) => ({
      i,
      tag: el.tagName,
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      value: el.getAttribute("value") || "",
      text: (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120),
      href: el.getAttribute("href") || ""
    })).filter(x => x.text || x.value || x.name || x.id || x.href);
  });
  const out = path.join(snapshotDir, `${stamp()}-interactive-elements.json`);
  await fs.writeFile(out, JSON.stringify(hints, null, 2), "utf8");
  console.log(`Interactive element dump: ${out}`);
}

async function dumpForms(page, label) {
  const forms = await page.evaluate(() => [...document.forms].map((form, formIndex) => ({
    formIndex,
    name: form.getAttribute("name") || "",
    id: form.id || "",
    action: form.action || "",
    method: form.method || "",
    text: (form.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2000),
    fields: [...form.querySelectorAll("input,select,textarea,button")].map((el, index) => ({
      index,
      tag: el.tagName,
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      value: el.getAttribute("value") || "",
      text: (el.innerText || el.textContent || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 160),
      options: el.tagName === "SELECT"
        ? [...el.options].map(o => ({ value: o.value, text: o.text })).slice(0, 80)
        : undefined
    }))
  })));
  const out = path.join(snapshotDir, `${stamp()}-${sanitize(label)}-forms.json`);
  await fs.writeFile(out, JSON.stringify(forms, null, 2), "utf8");
  console.log(`Form dump: ${out}`);
}

async function gotoElectronicDelivery(page) {
  console.log("Opening SBI electronic-delivery reports page directly...");
  await page.goto(edeliveryUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  if (/login|ログイン/i.test(await page.title().catch(() => ""))) {
    return false;
  }
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return /電子交付|取引報告書|報告書|閲覧|交付/.test(body);
}

async function openReportViewerFromPortal(page) {
  console.log("Opening report viewer from the portal button...");
  if (await page.locator("mat-expansion-panel.item").first().isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log("Already on the current report viewer.");
    return page;
  }

  const candidates = [
    page.getByRole("button", { name: /報告書閲覧/ }).first(),
    page.locator("button:has-text('報告書閲覧'), a:has-text('報告書閲覧')").first(),
    page.locator("input[type='button'][value*='報告書閲覧'], input[type='submit'][value*='報告書閲覧']").first(),
    page.locator("button:has-text('閲覧'), a:has-text('閲覧'), input[type='button'][value*='閲覧'], input[type='submit'][value*='閲覧']").first()
  ];
  let reportButton = null;
  for (const candidate of candidates) {
    if (await candidate.isVisible({ timeout: 2500 }).catch(() => false)) {
      reportButton = candidate;
      break;
    }
  }
  if (!reportButton) {
    await saveSnapshot(page, "portal-without-report-viewer-button");
    await dumpInteractiveHints(page);
    throw new Error("Could not find the SBI report-viewer button on the portal page.");
  }

  await reportButton.scrollIntoViewIfNeeded({ timeout: 10000 });
  const popupPromise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
  await reportButton.click({ timeout: 10000 });
  const popup = await popupPromise;
  const viewer = popup || page;
  await viewer.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await viewer.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return viewer;
}

async function openLegacyViewerFromCurrent(page) {
  console.log("Opening legacy report viewer from the current viewer link...");
  const legacyLink = page.locator("a[href*='deisw070.jsp'], a:has-text('2022年4月22日以前')").first();
  await legacyLink.scrollIntoViewIfNeeded({ timeout: 15000 });
  const popupPromise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
  await legacyLink.click({ timeout: 10000, force: true });
  const popup = await popupPromise;
  const legacy = popup || page;
  await legacy.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await legacy.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return legacy;
}

async function expandFirstReportItem(page) {
  const firstHeader = page.locator("mat-expansion-panel.item mat-expansion-panel-header.item__header").first();
  await firstHeader.scrollIntoViewIfNeeded({ timeout: 10000 });
  await firstHeader.click({ timeout: 10000, force: true });
  await page.waitForTimeout(12000);
}

async function openFilterPanel(page) {
  const filterButton = page.getByRole("button", { name: /絞り込み/ }).first();
  if (await filterButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await filterButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function dumpInputs(page, label) {
  const inputs = await page.evaluate(() => [...document.querySelectorAll("input, textarea")].map((el, index) => {
    const rect = el.getBoundingClientRect();
    const parentText = (el.closest("mat-form-field, .detailed-filter, .search-filter, label, div")?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 240);
    return {
      index,
      id: el.id || "",
      name: el.getAttribute("name") || "",
      type: el.getAttribute("type") || "",
      placeholder: el.getAttribute("placeholder") || "",
      value: el.value || "",
      visible: rect.width > 0 && rect.height > 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      parentText
    };
  }));
  const out = path.join(snapshotDir, `${stamp()}-${sanitize(label)}-inputs.json`);
  await fs.writeFile(out, JSON.stringify(inputs, null, 2), "utf8");
  console.log(`Input dump: ${out}`);
}

async function applyCurrentDateFilter(page, from, to) {
  await openFilterPanel(page);
  await page.evaluate(({ from, to }) => {
    const setInput = (selector, value) => {
      const input = document.querySelector(selector);
      if (!input) return false;
      input.removeAttribute("readonly");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    };
    setInput("#mat-input-2", from);
    setInput("#mat-input-3", to);
  }, { from, to });
  await page.waitForTimeout(500);
  const searchButtons = page.locator(".detailed-filter__footer button", { hasText: "再検索" });
  const count = await searchButtons.count();
  const button = count > 0 ? searchButtons.nth(count - 1) : page.getByRole("button", { name: /^再検索$/ }).last();
  await button.click({ timeout: 10000, force: true });
  await page.waitForTimeout(5000);
}

async function dumpReportSummary(page, label) {
  const summary = await page.evaluate(() => [...document.querySelectorAll("mat-expansion-panel")].map((panel, index) => ({
    index,
    expanded: panel.className.includes("mat-expanded"),
    headerText: (panel.querySelector("mat-expansion-panel-header")?.innerText || "").replace(/\s+/g, " ").trim(),
    date: (panel.querySelector(".item__date")?.textContent || "").trim(),
    type: (panel.querySelector(".item__type")?.textContent || "").trim(),
    text: (panel.querySelector(".item__text")?.textContent || "").replace(/\s+/g, " ").trim(),
    buttons: [...panel.querySelectorAll("button")].map((button, buttonIndex) => ({
      buttonIndex,
      text: (button.innerText || button.textContent || "").replace(/\s+/g, " ").trim(),
      className: button.className,
      disabled: button.disabled
    })),
    links: [...panel.querySelectorAll("a")].map((a, linkIndex) => ({
      linkIndex,
      text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim(),
      href: a.href || a.getAttribute("href") || ""
    }))
  })).slice(0, 120));
  const out = path.join(snapshotDir, `${stamp()}-${sanitize(label)}-report-summary.json`);
  await fs.writeFile(out, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Report summary dump: ${out}`);
}

async function saveDownload(download, metadata) {
  const suggested = sanitize(download.suggestedFilename());
  const datePart = sanitize(metadata.date || "unknown-date").replaceAll("/", "-");
  const typePart = sanitize(metadata.type || "report");
  const textPart = sanitize(metadata.text || suggested || "document");
  const filename = `${datePart}-${typePart}-${textPart}-${stamp()}.pdf`;
  const filePath = path.join(downloadDir, filename);
  await download.saveAs(filePath);
  await appendManifest({
    downloadedAt: new Date().toISOString(),
    key: reportKey(metadata),
    ...metadata,
    suggestedFilename: suggested,
    filePath,
    sha256: await hashFile(filePath)
  });
  console.log(`Downloaded: ${filePath}`);
}

async function savePdfBytes(bytes, metadata, sourceKind) {
  const datePart = sanitize(metadata.date || "unknown-date").replaceAll("/", "-");
  const typePart = sanitize(metadata.type || "report");
  const textPart = sanitize(metadata.text || "document");
  const filename = `${datePart}-${typePart}-${textPart}-${stamp()}.pdf`;
  const filePath = path.join(downloadDir, filename);
  await fs.writeFile(filePath, Buffer.from(bytes));
  await appendManifest({
    downloadedAt: new Date().toISOString(),
    key: reportKey(metadata),
    ...metadata,
    sourceKind,
    filePath,
    sha256: await hashFile(filePath)
  });
  console.log(`Saved PDF: ${filePath}`);
}

async function saveBlobPopup(popup, metadata) {
  await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const bytes = await popup.evaluate(async () => {
    const response = await fetch(location.href);
    const buffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  });
  await savePdfBytes(bytes, { ...metadata, popupUrl: popup.url() }, "blob-popup");
  await popup.close().catch(() => {});
}

async function savePdfFromPageUrl(page, metadata, sourceKind) {
  const result = await page.evaluate(async () => {
    const response = await fetch(location.href);
    const buffer = await response.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    const header = String.fromCharCode(...bytes.slice(0, 4));
    return {
      ok: header === "%PDF",
      bytes
    };
  });
  if (!result.ok) return false;
  await savePdfBytes(result.bytes, { ...metadata, popupUrl: page.url() }, sourceKind);
  return true;
}

async function clickFirstPdfButton(page) {
  const panel = page.locator("mat-expansion-panel.item.mat-expanded").first();
  const metadata = await panel.evaluate(el => ({
    sourceUrl: location.href,
    date: (el.querySelector(".item__date")?.textContent || "").trim(),
    type: (el.querySelector(".item__type")?.textContent || "").trim(),
    text: (el.querySelector(".item__text")?.textContent || "").replace(/\s+/g, " ").trim()
  }));
  const pdfButton = panel.locator("button.-pdf, button:has-text('PDFファイル')").first();
  await pdfButton.scrollIntoViewIfNeeded({ timeout: 10000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
  const popupPromise = page.waitForEvent("popup", { timeout: 20000 }).catch(() => null);
  await pdfButton.click({ timeout: 10000, force: true });
  const download = await downloadPromise;
  const popup = await popupPromise;
  if (download) {
    await saveDownload(download, metadata);
  } else if (popup) {
    await saveBlobPopup(popup, metadata);
  } else {
    console.log("No direct download or popup was observed after clicking the PDF button.");
  }
}

async function setYearRange(page) {
  const selects = await page.locator("select").all();
  for (const select of selects) {
    const text = await visibleText(select);
    const name = await select.getAttribute("name").catch(() => "");
    const id = await select.getAttribute("id").catch(() => "");
    const haystack = `${text} ${name} ${id}`;
    if (/年|year|YYYY|yyyy|from|to/i.test(haystack)) {
      await select.selectOption({ label: new RegExp(String(toYear)) }).catch(async () => {
        await select.selectOption(String(toYear)).catch(() => {});
      });
    }
  }

  const inputs = await page.locator("input").all();
  for (const field of inputs) {
    const name = await field.getAttribute("name").catch(() => "");
    const id = await field.getAttribute("id").catch(() => "");
    const placeholder = await field.getAttribute("placeholder").catch(() => "");
    const type = await field.getAttribute("type").catch(() => "");
    const haystack = `${name} ${id} ${placeholder}`;
    if (!/date|text|tel|number|search|/.test(type || "text")) continue;
    if (/from|start|開始|始|date/i.test(haystack)) {
      await field.fill(`${fromYear}/01/01`).catch(() => {});
    } else if (/to|end|終了|終|date/i.test(haystack)) {
      await field.fill(`${toYear}/12/31`).catch(() => {});
    }
  }
}

async function collectReportLinks(page) {
  const links = await page.locator("a").evaluateAll(anchors =>
    anchors.map((a, index) => ({
      index,
      text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim(),
      href: a.href || a.getAttribute("href") || "",
      target: a.target || ""
    }))
  );
  return links.filter(link => {
    const text = link.text || "";
    const href = link.href || "";
    return /PDF|pdf|閲覧|表示|照会|報告書|交付|書面|電子/i.test(`${text} ${href}`);
  });
}

async function downloadCurrentVisibleReports(page) {
  const reportLinks = await collectReportLinks(page);
  console.log(`Candidate report links on current page: ${reportLinks.length}`);
  let downloaded = 0;

  for (let i = 0; i < reportLinks.length; i += 1) {
    const link = reportLinks[i];
    const linkText = sanitize(link.text || `report-${i + 1}`);
    const locator = page.locator("a").nth(link.index);
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      const downloadPromise = page.waitForEvent("download", { timeout: 7000 }).catch(() => null);
      const popupPromise = page.waitForEvent("popup", { timeout: 7000 }).catch(() => null);
      await locator.click({ timeout: 5000 });

      const download = await downloadPromise;
      const popup = await popupPromise;

      if (download) {
        const suggested = sanitize(download.suggestedFilename());
        const filename = `${String(downloaded + 1).padStart(3, "0")}-${linkText || suggested || "sbi-report"}.pdf`;
        const filePath = path.join(downloadDir, filename);
        await download.saveAs(filePath);
        downloaded += 1;
        await appendManifest({
          downloadedAt: new Date().toISOString(),
          sourceUrl: page.url(),
          linkText,
          suggestedFilename: suggested,
          filePath,
          sha256: await hashFile(filePath)
        });
        console.log(`Downloaded: ${filePath}`);
      } else if (popup) {
        await popup.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        await saveSnapshot(popup, `popup-${linkText}`);
        const url = popup.url();
        if (/\.pdf|pdf/i.test(url)) {
          console.log(`Opened PDF-like popup URL: ${url}`);
        }
        await popup.close().catch(() => {});
      }

      await page.waitForTimeout(800);
    } catch (error) {
      console.log(`Skipped candidate ${i + 1}: ${linkText} (${error.message})`);
    }
  }

  return downloaded;
}

async function downloadPdfButton(page, panel, button, metadata) {
  await button.scrollIntoViewIfNeeded({ timeout: 10000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 12000 })
    .then(download => ({ kind: "download", download }))
    .catch(() => null);
  const popupPromise = page.waitForEvent("popup", { timeout: 12000 })
    .then(popup => ({ kind: "popup", popup }))
    .catch(() => null);
  await button.click({ timeout: 10000, force: true });
  const event = await Promise.race([downloadPromise, popupPromise]);
  if (event?.kind === "download") {
    await saveDownload(event.download, metadata);
    return true;
  }
  if (event?.kind === "popup") {
    await saveBlobPopup(event.popup, metadata);
    return true;
  }
  console.log(`No PDF event for ${metadata.date} ${metadata.type} ${metadata.text}`);
  return false;
}

async function collectLegacyReports(page) {
  return page.evaluate(() => {
    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
    const html = document.body.innerHTML;
    const chunks = html.split(/<li[^>]+class=["'][^"']*message[^"']*["'][^>]*>/i).slice(1);
    return chunks.map((chunk, index) => {
      const beforeEnd = chunk.split(/<\/li>/i)[0] || chunk;
      const textFromClass = className => {
        const match = beforeEnd.match(new RegExp(`<[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
        if (!match) return "";
        const div = document.createElement("div");
        div.innerHTML = match[1];
        return clean(div.textContent);
      };
      const onclick = beforeEnd.match(/doInline\([^)]*'([0-9]+)'[^)]*\)/i)?.[0] || "";
      const messageNo = onclick.match(/'([0-9]+)'/)?.[1] || "";
      const titleMatch = beforeEnd.match(/<div[^>]+class=["'][^"']*title[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      const div = document.createElement("div");
      div.innerHTML = titleMatch?.[1] || "";
      return {
        index,
        messageNo,
        date: textFromClass("date"),
        type: textFromClass("type"),
        text: clean(div.textContent),
        displayText: beforeEnd.includes("doInline") ? "表示" : ""
      };
    }).filter(item => item.messageNo && item.date && item.type);
  });
}

async function downloadLegacyVisibleReports(page) {
  const downloadedKeys = await loadDownloadedKeys();
  let saved = 0;
  let skipped = 0;
  const maxPages = Number(process.env.SBI_LEGACY_MAX_PAGES || "50");

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    const reports = await collectLegacyReports(page);
    console.log(`Visible legacy-report rows on page ${pageIndex}: ${reports.length}`);
    if (reports.length === 0) break;

    for (let i = 0; i < reports.length; i += 1) {
      const report = reports[i];
      const metadata = {
        sourceUrl: page.url(),
        index: report.index,
        date: report.date,
        type: report.type,
        text: report.text,
        pdfIndex: 0,
        pdfText: report.messageNo,
        legacyMessageNo: report.messageNo
      };
      if (downloadedKeys.has(baseReportKey(metadata)) || downloadedKeys.has(reportKey(metadata))) {
        skipped += 1;
        continue;
      }

      const downloadPromise = page.waitForEvent("download", { timeout: 15000 })
        .then(download => ({ kind: "download", download }))
        .catch(() => null);
      const popupPromise = page.waitForEvent("popup", { timeout: 15000 })
        .then(popup => ({ kind: "popup", popup }))
        .catch(() => null);
      const navigationPromise = page.waitForURL(url => String(url).includes("DocumentTextDisplayAction"), { timeout: 15000 })
        .then(() => ({ kind: "navigation" }))
        .catch(() => null);

      await page.evaluate(messageNo => {
        if (typeof window.clearProcess === "function") window.clearProcess();
        window.doInline("/web/DocumentTextDisplayAction.do", messageNo, document.f_sub06);
      }, report.messageNo);
      const event = await Promise.race([downloadPromise, popupPromise, navigationPromise]);

      let ok = false;
      if (event?.kind === "download") {
        await saveDownload(event.download, metadata);
        ok = true;
      } else if (event?.kind === "popup") {
        await event.popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        ok = await savePdfFromPageUrl(event.popup, metadata, "legacy-popup").catch(() => false);
        await event.popup.close().catch(() => {});
      } else {
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        ok = await savePdfFromPageUrl(page, metadata, "legacy-inline").catch(() => false);
      }
      if (page.url() !== metadata.sourceUrl) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      }

      if (ok) {
        downloadedKeys.add(reportKey(metadata));
        downloadedKeys.add(baseReportKey(metadata));
        saved += 1;
      } else {
        console.log(`No legacy PDF event for ${metadata.date} ${metadata.type} ${metadata.text}`);
        skipped += 1;
      }
      await page.waitForTimeout(2200);
    }

    const hasNext = await page.locator("a[title='次のページへ']").count().then(count => count > 0).catch(() => false);
    if (!hasNext) break;
    const nextPage = String(pageIndex + 1);
    const pagePromise = page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.evaluate(nextPage => {
      if (typeof window.clearProcess === "function") window.clearProcess();
      window.goChangePage(nextPage, document.f_subpage);
    }, nextPage);
    await pagePromise;
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2200);
  }

  console.log(`Saved ${saved} legacy PDF(s), skipped ${skipped}.`);
  return saved;
}

async function downloadVisibleCurrentReports(page) {
  const downloadedKeys = await loadDownloadedKeys();
  const panels = page.locator("mat-expansion-panel.item");
  const count = await panels.count();
  console.log(`Visible current-report panels: ${count}`);
  let saved = 0;
  let skipped = 0;

  for (let i = 0; i < count; i += 1) {
    const panel = panels.nth(i);
    const metadataBase = await panel.evaluate(el => ({
      sourceUrl: location.href,
      index: [...document.querySelectorAll("mat-expansion-panel.item")].indexOf(el),
      date: (el.querySelector(".item__date")?.textContent || "").trim(),
      type: (el.querySelector(".item__type")?.textContent || "").trim(),
      text: (el.querySelector(".item__text")?.textContent || "").replace(/\s+/g, " ").trim()
    })).catch(() => null);

    if (!metadataBase?.date || !metadataBase?.type) {
      skipped += 1;
      continue;
    }

    if (downloadedKeys.has(baseReportKey(metadataBase))) {
      skipped += 1;
      continue;
    }

    const year = Number(metadataBase.date.slice(0, 4));
    if (year < 2022 || year > toYear) {
      skipped += 1;
      continue;
    }

    const header = panel.locator("mat-expansion-panel-header.item__header").first();
    const expanded = await panel.evaluate(el => el.classList.contains("mat-expanded")).catch(() => false);
    if (!expanded) {
      await header.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
      await header.click({ timeout: 10000, force: true }).catch(error => {
        console.log(`Could not expand ${metadataBase.date} ${metadataBase.type}: ${error.message}`);
      });
    }

    await panel.locator("button.-pdf, button:has-text('PDFファイル')").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    const pdfButtons = panel.locator("button.-pdf, button:has-text('PDFファイル')");
    const pdfCount = await pdfButtons.count();
    if (pdfCount === 0) {
      console.log(`No PDF button: ${metadataBase.date} ${metadataBase.type} ${metadataBase.text}`);
      skipped += 1;
      continue;
    }

    for (let j = 0; j < pdfCount; j += 1) {
      const button = pdfButtons.nth(j);
      const pdfText = sanitize(await button.innerText({ timeout: 1000 }).catch(() => `pdf-${j + 1}`));
      const metadata = { ...metadataBase, pdfIndex: j, pdfText };
      const key = reportKey(metadata);
      if (downloadedKeys.has(key)) {
        skipped += 1;
        continue;
      }
      const ok = await downloadPdfButton(page, panel, button, metadata);
      if (ok) {
        downloadedKeys.add(key);
        downloadedKeys.add(baseReportKey(metadata));
        saved += 1;
      }
      await page.waitForTimeout(800);
    }
  }

  console.log(`Saved ${saved} PDF(s), skipped ${skipped}.`);
  return saved;
}

async function main() {
  await ensureDirs();

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    acceptDownloads: true,
    downloadsPath: downloadDir,
    viewport: { width: 1440, height: 950 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo"
  });

  let page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);

  const directReady = await gotoElectronicDelivery(page);
  if (!directReady) {
    await page.goto("https://www.sbisec.co.jp/", { waitUntil: "domcontentloaded" });
    console.log("\nA Playwright browser is open.");
    console.log("Please log in to SBI manually in that browser. Do not type credentials here.");
    console.log("After login, navigate to the electronic reports / transaction history area if SBI does not land there.");
    await rl.question("Press Enter here after you are logged in and ready for downloads...");
    await gotoElectronicDelivery(page);
  }

  if (process.env.SBI_VIEWER === "1") {
    page = await openReportViewerFromPortal(page);
  }

  if (process.env.SBI_LEGACY === "1") {
    page = await openLegacyViewerFromCurrent(page);
  }

  if (process.env.SBI_EXPAND_FIRST === "1") {
    await expandFirstReportItem(page);
  }

  if (process.env.SBI_OPEN_FILTER === "1") {
    await openFilterPanel(page);
    await dumpInputs(page, "filter-open");
  }

  if (process.env.SBI_FILTER_FROM && process.env.SBI_FILTER_TO) {
    await applyCurrentDateFilter(page, process.env.SBI_FILTER_FROM, process.env.SBI_FILTER_TO);
  }

  if (process.env.SBI_TEST_DOWNLOAD_FIRST === "1") {
    await clickFirstPdfButton(page);
  }

  if (process.env.SBI_LEGACY_DOWNLOAD_VISIBLE === "1") {
    await downloadLegacyVisibleReports(page);
  }

  if (process.env.SBI_DOWNLOAD_VISIBLE === "1") {
    await downloadVisibleCurrentReports(page);
  }

  await saveSnapshot(page, "edelivery-entry");
  await dumpInteractiveHints(page);
  await dumpForms(page, "edelivery-entry");
  await dumpReportSummary(page, "edelivery-entry");

  if (process.env.SBI_INSPECT_ONLY === "1") {
    console.log("Inspect-only mode complete. Browser left open until you press Enter.");
    await rl.question("Press Enter to close...");
    await context.close();
    rl.close();
    return;
  }

  await setYearRange(page);
  await clickText(page, ["検索", "照会", "表示", "絞込", "適用"]).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await saveSnapshot(page, "report-search");
  await dumpInteractiveHints(page);

  const count = await downloadCurrentVisibleReports(page);
  console.log(`\nDownloaded ${count} file(s) from the current visible report list.`);
  console.log(`Download directory: ${downloadDir}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log("If the current page is not the right report list, leave the browser open and tell Codex what you see.");

  await rl.question("Press Enter to close the Playwright browser, or leave this process running while we adjust...");
  await context.close();
  rl.close();
}

main().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  rl.close();
});
