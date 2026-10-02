import { parentPort, workerData } from "node:worker_threads";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const { body, mime, url, maxChars } = workerData;
class ExtractionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const error = (code, message) => { throw new ExtractionError(code, message); };
const canonical = (value) => value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
async function extract() {
  let result;
  const bytes = new Uint8Array(body);
  if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false });
    try {
      if (pdf.numPages > 200) error("CONTENT_TOO_LARGE", "PDF exceeds 200 pages.");
      const extracted = await extractText(pdf, { mergePages: false });
      let text = "";
      const pages = [];
      for (const [index, page] of extracted.text.entries()) {
        if (index) text += "\n\n";
        const start = text.length;
        text += canonical(page);
        pages.push({ pageNumber: index + 1, start, end: text.length });
        if (text.length > maxChars) error("CONTENT_TOO_LARGE", "Extracted text exceeds its limit.");
      }
      result = { text, format: "text", sourceType: "pdf", pages, pageCount: pdf.numPages };
    } finally { await pdf.destroy?.(); }
  } else {
    const type = mime.split(";")[0].trim().toLowerCase();
    if (type === "application/pdf") error("EXTRACTION_FAILED", "PDF signature is missing.");
    if (type && !type.startsWith("text/") && !["application/json", "application/xml", "application/xhtml+xml"].includes(type) && !type.endsWith("+json") && !type.endsWith("+xml")) error("CONTENT_UNSUPPORTED", "This media type is not supported.");
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(mime)?.[1] ?? "utf-8";
    let source;
    try { source = new TextDecoder(charset, { fatal: true }).decode(bytes); }
    catch { error("EXTRACTION_FAILED", "Unsupported or invalid text encoding."); }
    if (["text/html", "application/xhtml+xml"].includes(type) || (!type && /^\s*<!doctype html|^\s*<html/i.test(source))) {
      const { document } = parseHTML(source);
      const title = canonical(document.querySelector("title")?.textContent ?? "").slice(0, 500);
      if (/captcha|verify (you are|that you)|just a moment|access denied/i.test(title)) error("CONTENT_UNSUPPORTED", "Page appears to require an anti-bot challenge.");
      for (const node of document.querySelectorAll("script,style,form,iframe,object,embed,template,noscript,img")) node.remove();
      for (const node of document.querySelectorAll("a[href]")) {
        try {
          const link = new URL(node.getAttribute("href"), url);
          if (!["http:", "https:"].includes(link.protocol)) node.removeAttribute("href");
          else node.setAttribute("href", link.href);
        } catch { node.removeAttribute("href"); }
      }
      const article = new Readability(document.cloneNode(true)).parse();
      const html = article?.content || document.querySelector("main,article,body")?.innerHTML || "";
      const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      converter.remove(["img", "script", "style", "form"]);
      result = { text: canonical(converter.turndown(html)), title, format: "markdown", sourceType: "html" };
    } else if (type.startsWith("text/") || ["application/json", "application/xml"].includes(type) || type.endsWith("+json") || type.endsWith("+xml")) {
      result = { text: canonical(source), format: "text", sourceType: "text" };
    } else error("CONTENT_UNSUPPORTED", "This media type is not supported.");
  }
  if (result.sourceType === "html" && result.text.length < 300 && /enable javascript|javascript (is )?required/i.test(result.text)) error("CONTENT_UNSUPPORTED", "Page requires JavaScript rendering.");
  if (!result.text.trim()) error("CONTENT_EMPTY", "No extractable text. OCR and JavaScript rendering are not included.");
  if (result.text.length > maxChars) error("CONTENT_TOO_LARGE", "Extracted text exceeds its limit.");
  return result;
}
try { parentPort.postMessage({ result: await extract() }); }
catch (e) { parentPort.postMessage({ error: { code: e instanceof ExtractionError ? e.code : "EXTRACTION_FAILED", message: e instanceof ExtractionError ? e.message : "Could not extract text from this document." } }); }
