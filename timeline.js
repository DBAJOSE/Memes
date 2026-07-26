/**
 * Puente entre la página determinista (casos_icfes.html) y Node.
 *
 * La animación vive en el HTML como una función del tiempo; aquí solo se
 * abre en Chromium a 1080x1920, se escala el lienzo y se expone seek().
 * Lo usan tanto render.js (cuadros) como audio.js (WAV offline), así que
 * ambos comparten exactamente la misma línea de tiempo.
 */
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

export const OUT_W = 1080;
export const OUT_H = 1920;
export const CANVAS_W = 540;
export const CANVAS_H = 960;

/**
 * @param {object} opts
 * @param {string} opts.page       ruta al html
 * @param {number} [opts.caso]     1..N para renderizar un solo caso (con su cortinilla)
 * @param {string} [opts.meme]     ruta a la imagen entre casos
 * @param {number} [opts.width]    ancho de salida (default 1080)
 * @param {number} [opts.height]   alto de salida (default 1920)
 */
export async function openTimeline(opts = {}) {
  const htmlPath = path.resolve(opts.page || "casos_icfes.html");
  if (!existsSync(htmlPath)) throw friendly(`No encuentro la página: ${htmlPath}`);

  const W = opts.width || OUT_W;
  const H = opts.height || OUT_H;

  const url = new URL(pathToFileURL(htmlPath));
  url.searchParams.set("det", "1");
  if (opts.caso) url.searchParams.set("caso", String(opts.caso));
  if (opts.meme) {
    const m = path.resolve(opts.meme);
    if (!existsSync(m)) throw friendly(`No encuentro la imagen: ${m}`);
    url.searchParams.set("meme", pathToFileURL(m).href);
  }

  // CHROMIUM_PATH permite usar un Chromium ya instalado (útil en CI o en
  // entornos donde `npx playwright install` no puede correr).
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(url.href, { waitUntil: "load" });

  // El lienzo mide 540x960 CSS; se escala para llenar el viewport exacto.
  await page.addStyleTag({
    content: `
      html,body{margin:0!important;padding:0!important;background:#000!important;
                overflow:hidden!important;display:block!important;width:${W}px;height:${H}px}
      #bar{display:none!important}
      #guides{display:none!important}
      #canvas{position:fixed!important;left:0!important;top:0!important;
              transform:scale(${W / CANVAS_W},${H / CANVAS_H})!important;
              transform-origin:top left!important}
      *{scroll-behavior:auto!important}
    `,
  });

  // La imagen entre casos tiene que estar cargada antes del primer cuadro.
  await page.waitForFunction("window.__ready === true", null, { timeout: 15000 }).catch(() => {
    throw friendly("La página nunca marcó __ready (¿falta la imagen o hay un error de JS?)");
  });
  await page.evaluate(() => document.fonts && document.fonts.ready);

  if (errors.length) throw friendly(`La página lanzó errores de JS:\n  ${errors.join("\n  ")}`);

  const duration = await page.evaluate(() => window.__duration());
  if (!Number.isFinite(duration) || duration <= 0) throw friendly("__duration() no devolvió un número válido.");

  return {
    page,
    browser,
    duration, // ms
    async seek(tMs) {
      await page.evaluate((t) => window.__seek(t), tMs);
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

function friendly(msg) {
  const e = new Error(msg);
  e.friendly = true;
  return e;
}
