import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

import { authMiddleware } from "./auth.js";
import { uploadPdf, getPresignedUrl } from "./storage.js";

// ---------------------------------------------------------------------------
// Reference files shipped by pdf-forge-mcp
// ---------------------------------------------------------------------------
const SKILLS_DIR = resolve(
  import.meta.dirname,
  "..",
  "node_modules",
  "pdf-forge-mcp",
  "skills",
  "pdf-forge",
  "references",
);

const RESOURCE_MAP: Record<string, string> = {
  "pdf-forge://design-system": "design-system.md",
  "pdf-forge://templates/slides": "slide-layouts.md",
  "pdf-forge://templates/docs": "doc-layouts.md",
  "pdf-forge://color-palettes": "color-palettes.md",
  "pdf-forge://anti-patterns": "anti-patterns.md",
};

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------
const mcp = new McpServer(
  { name: "pdf-forge-remote", version: "0.1.0" },
  { capabilities: { resources: {}, tools: {} } },
);

// Register resources
for (const [uri, filename] of Object.entries(RESOURCE_MAP)) {
  const name = uri.replace("pdf-forge://", "");
  mcp.resource(name, uri, { description: `Reference: ${filename}` }, async () => ({
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: await readFile(join(SKILLS_DIR, filename), "utf-8"),
      },
    ],
  }));
}

// ---------------------------------------------------------------------------
// Tool: generate_pdf
// ---------------------------------------------------------------------------
mcp.tool(
  "generate_pdf",
  "Render HTML pages into a single PDF and upload to R2",
  {
    format: z.enum(["slides", "docs"]),
    pages: z.array(z.string()).min(1),
    scale: z.number().int().min(1).max(4).optional(),
  },
  async ({ format, pages, scale }) => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pdf-forge-"));

    try {
      // 1. Write HTML pages to temp dir
      const htmlPaths: string[] = [];
      for (let i = 0; i < pages.length; i++) {
        const htmlPath = join(tmpDir, `page-${i}.html`);
        await writeFile(htmlPath, pages[i], "utf-8");
        htmlPaths.push(htmlPath);
      }

      // 2. Render pages with Playwright
      const browser = await chromium.launch({ headless: true });

      try {
        const isSlides = format === "slides";
        const viewport = isSlides
          ? { width: 1920, height: 1080 }
          : { width: 794, height: 1123 }; // A4 at 96 DPI

        const deviceScale = scale ?? (isSlides ? 2 : 1);

        const renderedFiles: string[] = [];

        for (let i = 0; i < htmlPaths.length; i++) {
          const context = await browser.newContext({
            viewport,
            deviceScaleFactor: deviceScale,
          });
          const page = await context.newPage();
          await page.goto(`file://${htmlPaths[i]}`, { waitUntil: "networkidle" });

          // Wait for Tailwind CSS custom properties
          await page.waitForFunction(
            () => {
              const el = document.querySelector("[class]");
              if (!el) return true;
              const styles = getComputedStyle(el);
              return styles.getPropertyValue("--tw-ring-offset-width") !== "";
            },
            { timeout: 5000 },
          ).catch(() => {
            /* Tailwind may not be present, that's fine */
          });

          // Wait for web fonts
          await page.evaluate(() => document.fonts.ready);

          if (isSlides) {
            const outPath = join(tmpDir, `page-${i}.png`);
            await page.screenshot({
              path: outPath,
              fullPage: false,
              type: "png",
            });
            renderedFiles.push(outPath);
          } else {
            const outPath = join(tmpDir, `page-${i}.pdf`);
            await page.pdf({
              path: outPath,
              format: "A4",
              printBackground: true,
            });
            renderedFiles.push(outPath);
          }

          await context.close();
        }

        // 3. Merge into a single PDF
        const mergedPdfPath = join(tmpDir, "output.pdf");

        if (isSlides) {
          // Merge PNGs into PDF: each page 1920x1080 at 72 DPI → 1440x810 pt
          const pdfDoc = await PDFDocument.create();
          const PAGE_W = 1440;
          const PAGE_H = 810;

          for (const pngPath of renderedFiles) {
            const pngBytes = await readFile(pngPath);
            const pngImage = await pdfDoc.embedPng(pngBytes);
            const pdfPage = pdfDoc.addPage([PAGE_W, PAGE_H]);
            pdfPage.drawImage(pngImage, {
              x: 0,
              y: 0,
              width: PAGE_W,
              height: PAGE_H,
            });
          }

          const pdfBytes = await pdfDoc.save();
          await writeFile(mergedPdfPath, pdfBytes);
        } else {
          // Merge PDFs
          const mergedDoc = await PDFDocument.create();

          for (const pdfPath of renderedFiles) {
            const pdfBytes = await readFile(pdfPath);
            const srcDoc = await PDFDocument.load(pdfBytes);
            const copiedPages = await mergedDoc.copyPages(
              srcDoc,
              srcDoc.getPageIndices(),
            );
            for (const page of copiedPages) {
              mergedDoc.addPage(page);
            }
          }

          const mergedBytes = await mergedDoc.save();
          await writeFile(mergedPdfPath, mergedBytes);
        }

        // 4. Upload to R2
        const key = await uploadPdf(mergedPdfPath);

        // 5. Get presigned URL
        const url = await getPresignedUrl(key);

        // 6. File size
        const { size: fileSize } = await stat(mergedPdfPath);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { url, pageCount: pages.length, fileSize },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        await browser.close();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Transport management
// ---------------------------------------------------------------------------
const transports = new Map<string, StreamableHTTPServerTransport>();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(authMiddleware);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// POST /mcp — Streamable HTTP transport
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    // Reuse existing transport for this session
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — create transport & connect
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
  };

  await mcp.connect(transport);

  if (transport.sessionId) {
    transports.set(transport.sessionId, transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE stream for server-initiated notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE /mcp — close session
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.close();
  transports.delete(sessionId);
  res.status(200).json({ status: "session closed" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`pdf-forge-remote listening on :${PORT}`);
});
