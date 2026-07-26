#!/usr/bin/env node
/**
 * Sube el mp4 a YouTube como Short (YouTube Data API v3, OAuth2 de escritorio).
 *
 * Solo pregunta lo que falte: si título, descripción, etiquetas y visibilidad
 * ya están en config.json o en banderas, sube directo.
 *
 *   node upload.js [--file out/casos_icfes.mp4] [--title "..."] [--desc "..."]
 *                  [--tags a,b,c] [--privacy private|unlisted|public]
 *                  [--yes] [--force] [--dry-run]
 *
 * Ver README.md → "Permisos de Google" para el trámite de credenciales.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { google } from "googleapis";
import { resolveFfmpeg, probe } from "./ffmpeg.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = path.join(ROOT, "token.json");
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

/* Costos reales de la API (unidades de cuota). */
const COST_UPLOAD = 1600;
const DAILY_QUOTA = 10000;

/* ------------------------------ argumentos ----------------------------- */
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], next = () => argv[++i];
    if (k === "--file") a.file = next();
    else if (k === "--title") a.title = next();
    else if (k === "--desc" || k === "--description") a.description = next();
    else if (k === "--tags") a.tags = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--privacy") a.privacy = next();
    else if (k === "--yes" || k === "-y") a.yes = true;
    else if (k === "--force") a.force = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "-h" || k === "--help") a.help = true;
    else if (k.startsWith("--")) throw friendly(`Opción desconocida: ${k}`);
  }
  return a;
}

const HELP = `
Uso: npm run publish -- [opciones]

  --file RUTA       mp4 a subir (default out/casos_icfes.mp4)
  --title "..."     título (se le agrega #Shorts si no lo trae)
  --desc "..."      descripción
  --tags a,b,c      etiquetas
  --privacy X       private | unlisted | public   (default private)
  --yes             no pedir confirmación final
  --force           subir aunque la validación se queje
  --dry-run         valida y muestra lo que subiría, sin subir nada
`;

/* --------------------------------- main -------------------------------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP.trim()); return; }

  const cfg = await loadJson(path.join(ROOT, "config.json"), {});
  const up = cfg.upload || {};

  const file = path.resolve(args.file || cfg.output || path.join(ROOT, "out", "casos_icfes.mp4"));
  if (!existsSync(file)) throw friendly(`No existe ${rel(file)}. Corre primero:  npm run render`);

  /* ------------------------- 1. validar el mp4 ------------------------- */
  const { ffprobe } = await resolveFfmpeg();
  const info = await probe(ffprobe, file);
  if (!info) throw friendly("No pude analizar el mp4 (falta ffprobe). Instálalo o usa --force.");

  const problems = [];
  if (!(info.duration > 0)) problems.push("el archivo no tiene duración válida");
  if (info.duration > 60) problems.push(`dura ${info.duration.toFixed(1)}s y para Short querías menos de 60s`);
  if (info.width !== 1080 || info.height !== 1920) problems.push(`la resolución es ${info.width}x${info.height}, no 1080x1920`);
  if (!info.hasAudio) problems.push("no tiene pista de audio");
  if (info.size > 512 * 1024 * 1024) problems.push(`pesa ${(info.size / 1048576).toFixed(0)} MB (demasiado para un Short)`);

  console.log(`· archivo: ${rel(file)}`);
  console.log(`  ${info.width}x${info.height} · ${info.duration.toFixed(2)}s · ${(info.size / 1048576).toFixed(1)} MB · audio ${info.acodec || "ninguno"}`);

  if (problems.length) {
    const msg = "El vídeo no pasa la validación:\n  - " + problems.join("\n  - ");
    if (!args.force) throw friendly(msg + "\n\nCorrígelo o repite con --force si sabes lo que haces.");
    console.log("· AVISO (--force): " + problems.join("; "));
  }

  /* --------------------- 2. metadatos: pedir lo que falte -------------- */
  const rl = createInterface({ input, output });
  const ask = async (label, def) => {
    const r = (await rl.question(`  ${label}${def ? ` [${def}]` : ""}: `)).trim();
    return r || def || "";
  };

  let title = args.title || up.title || "";
  let description = args.description ?? up.description ?? "";
  let tags = args.tags || up.tags || null;
  let privacy = args.privacy || up.privacy || "private";

  const needsAsking = !title || description === "" || !tags || !privacy;
  if (needsAsking) console.log("\n· faltan datos, te los pregunto (Enter acepta el valor por defecto):");

  if (!title) title = await ask("título", "Le pedí ayuda a la IA en el ICFES #Shorts");
  if (description === "") {
    description = await ask(
      "descripción",
      "Tres casos muy reales de usar IA para el ICFES. #Shorts #ICFES #humor"
    );
  }
  if (!tags) tags = (await ask("etiquetas (coma)", "icfes,ia,humor,colombia,shorts")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!privacy) privacy = await ask("visibilidad (private/unlisted/public)", "private");

  if (!/#shorts/i.test(title) && !/#shorts/i.test(description)) {
    description = (description ? description + "\n\n" : "") + "#Shorts";
    console.log("· le agregué #Shorts a la descripción");
  }
  if (!["private", "unlisted", "public"].includes(privacy)) {
    throw friendly(`Visibilidad inválida: ${privacy} (usa private, unlisted o public)`);
  }

  const meta = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5000),
      tags,
      categoryId: String(up.categoryId || 23),          // 23 = Comedy
      defaultLanguage: up.language || "es-CO",
      defaultAudioLanguage: up.language || "es-CO",
    },
    status: {
      privacyStatus: privacy,
      selfDeclaredMadeForKids: up.madeForKids === true,
    },
  };

  console.log("\n· se va a subir esto:");
  console.log(`  título      ${meta.snippet.title}`);
  console.log(`  visibilidad ${meta.status.privacyStatus}`);
  console.log(`  categoría   ${meta.snippet.categoryId} · idioma ${meta.snippet.defaultLanguage}`);
  console.log(`  etiquetas   ${meta.snippet.tags.join(", ")}`);
  console.log(`  cuota       ${COST_UPLOAD} unidades de ${DAILY_QUOTA}/día (te quedan ~${Math.floor(DAILY_QUOTA / COST_UPLOAD) - 1} subidas más hoy)`);

  if (args.dryRun) { console.log("\n· --dry-run: no subo nada."); rl.close(); return; }
  if (!args.yes) {
    const ok = (await rl.question("\n  ¿Subir? (s/N): ")).trim().toLowerCase();
    if (ok !== "s" && ok !== "si" && ok !== "sí" && ok !== "y") { console.log("· cancelado."); rl.close(); return; }
  }
  rl.close();

  /* ------------------------------ 3. subir ----------------------------- */
  const auth = await authorize();
  const yt = google.youtube({ version: "v3", auth });

  const size = statSync(file).size;
  let sent = 0, lastPct = -1;

  const res = await yt.videos.insert(
    {
      part: ["snippet", "status"],
      requestBody: meta,
      media: { body: createReadStream(file) },
      notifySubscribers: false,
    },
    {
      onUploadProgress: (e) => {
        sent = e.bytesRead;
        const pct = Math.floor((sent / size) * 100);
        if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r  subiendo ${String(pct).padStart(3)}%   `); }
      },
    }
  );
  process.stdout.write("\n");

  const id = res.data.id;
  console.log(`· listo: https://youtu.be/${id}`);
  console.log(`  estudio: https://studio.youtube.com/video/${id}/edit`);
  if (res.data.status?.uploadStatus) console.log(`  estado de subida: ${res.data.status.uploadStatus}`);
  if (privacy !== "private") {
    console.log("  nota: si tu proyecto de Google Cloud no pasó la auditoría de la API,");
    console.log("        YouTube dejará el vídeo en privado sin importar lo que pidas (ver README).");
  }
}

/* ------------------------------- OAuth2 -------------------------------- */
async function authorize() {
  const creds = await loadCredentials();
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://127.0.0.1:0");

  const saved = await loadJson(TOKEN, null);
  if (saved) {
    oauth2.setCredentials(saved);
    oauth2.on("tokens", async (t) => {
      if (t.refresh_token || t.access_token) {
        await writeFile(TOKEN, JSON.stringify({ ...saved, ...t }, null, 2));
      }
    });
    try { await oauth2.getAccessToken(); return oauth2; }
    catch { console.log("· el token guardado ya no sirve, vuelvo a pedir permiso"); }
  }

  // Flujo de aplicación de escritorio: servidor local efímero + navegador.
  const { code, redirectUri } = await waitForCode(oauth2, creds);
  oauth2.redirectUri = redirectUri;
  const { tokens } = await oauth2.getToken({ code, redirect_uri: redirectUri });
  oauth2.setCredentials(tokens);
  await writeFile(TOKEN, JSON.stringify(tokens, null, 2));
  console.log(`· permiso concedido, token guardado en ${rel(TOKEN)} (no lo subas al repo)`);
  return oauth2;
}

function waitForCode(oauth2, creds) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/") { res.writeHead(404).end(); return; }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:system-ui;background:#0b0e14;color:#e6eef8;padding:40px">
        <h2>${code ? "Listo ✅" : "Falló ❌"}</h2>
        <p>${code ? "Ya puedes cerrar esta pestaña y volver a la terminal." : "Error: " + (err || "desconocido")}</p>
      </body></html>`);
      server.close();
      code ? resolve({ code, redirectUri }) : reject(friendly(`Google devolvió un error: ${err}`));
    });

    let redirectUri;
    server.listen(0, "127.0.0.1", async () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const oa = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
      const url = oa.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
      console.log("\n· abre este enlace y autoriza la subida con tu cuenta de YouTube:\n");
      console.log("  " + url + "\n");
      await openBrowser(url);
    });
    server.on("error", reject);
    setTimeout(() => { server.close(); reject(friendly("Se acabó el tiempo esperando la autorización (5 min).")); }, 5 * 60_000);
  });
}

async function loadCredentials() {
  // 1) client_secret.json descargado de Google Cloud
  for (const f of ["client_secret.json", "credentials.json"]) {
    const p = path.join(ROOT, f);
    if (existsSync(p)) {
      const j = await loadJson(p, null);
      const c = j.installed || j.web;
      if (!c?.client_id) throw friendly(`${f} no parece un OAuth client de escritorio (falta "installed").`);
      return c;
    }
  }
  // 2) variables de entorno
  if (process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET) {
    return { client_id: process.env.YT_CLIENT_ID, client_secret: process.env.YT_CLIENT_SECRET };
  }
  throw friendly(
    "No encuentro credenciales de Google.\n\n" +
    "  Necesito un OAuth client de tipo 'Aplicación de escritorio'. Pasos en README.md\n" +
    "  → sección «Permisos de Google». Luego deja el archivo descargado como\n" +
    "    client_secret.json en la raíz del proyecto, o exporta YT_CLIENT_ID / YT_CLIENT_SECRET."
  );
}

async function openBrowser(url) {
  const { spawn } = await import("node:child_process");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); }
  catch { /* si no hay navegador, el enlace ya está impreso */ }
}

/* -------------------------------- util --------------------------------- */
async function loadJson(f, def) {
  if (!existsSync(f)) return def;
  try { return JSON.parse(await readFile(f, "utf8")); }
  catch { throw friendly(`${path.basename(f)} no es JSON válido.`); }
}
const rel = (p) => path.relative(process.cwd(), p) || p;
function friendly(msg) { const e = new Error(msg); e.friendly = true; return e; }

main().catch((e) => {
  process.stdout.write("\n");
  const gapi = e?.errors?.[0]?.message || e?.response?.data?.error?.message;
  if (gapi) console.error(`\nYouTube rechazó la subida: ${gapi}\n`);
  else console.error(e.friendly ? `\n${e.message}\n` : e);
  process.exit(1);
});
