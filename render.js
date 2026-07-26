#!/usr/bin/env node
/**
 * Renderizado determinista de casos_icfes.html a mp4 vertical.
 *
 * No graba la pantalla: pide el cuadro exacto de cada instante con
 * window.__seek(t) y los une con ffmpeg. Mismo resultado en cualquier
 * máquina, sin cuadros saltados.
 *
 *   node render.js [--caso N] [--fps 30] [--out out/casos_icfes.mp4]
 *                  [--music assets/musica.mp3] [--meme assets/meme.jpg]
 *                  [--keep-frames] [--no-audio] [--trim-silence] [--crf 18]
 */
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFfmpeg, runFfmpeg, probe } from "./ffmpeg.js";
import { openTimeline, OUT_W, OUT_H } from "./timeline.js";
import { renderWav, mixAudio } from "./audio.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------ argumentos ----------------------------- */
function parseArgs(argv) {
  const a = { fps: 30, crf: 18, keepFrames: false, audio: true, trimSilence: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--caso") a.caso = parseInt(next(), 10);
    else if (k === "--fps") a.fps = parseInt(next(), 10);
    else if (k === "--crf") a.crf = parseInt(next(), 10);
    else if (k === "--sfx-gain") a.sfxGain = parseFloat(next());
    else if (k === "--out") a.out = next();
    else if (k === "--music") a.music = next();
    else if (k === "--meme") a.meme = next();
    else if (k === "--page") a.page = next();
    else if (k === "--keep-frames") a.keepFrames = true;
    else if (k === "--no-audio") a.audio = false;
    else if (k === "--trim-silence") a.trimSilence = true;
    else if (k === "-h" || k === "--help") a.help = true;
    else if (k.startsWith("--")) throw friendly(`Opción desconocida: ${k}`);
  }
  return a;
}

const HELP = `
Uso: npm run render -- [opciones]

  --caso N          renderiza solo ese caso (con su cortinilla)
  --fps N           cuadros por segundo (default 30)
  --crf N           calidad H.264, menor = mejor (default 18)
  --out RUTA        archivo de salida (default out/casos_icfes.mp4)
  --music RUTA      pista de fondo (default assets/musica.mp3 si existe)
  --meme RUTA       imagen entre casos (default assets/meme.jpg)
  --keep-frames     además guarda los PNG en out/frames/
  --no-audio        vídeo mudo
  --sfx-gain N      dB que se le suben a los efectos (default 10)
  --trim-silence    recorta silencio SOLO al final (no toca los internos)
`;

/* --------------------------------- main -------------------------------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP.trim()); return; }

  const cfg = await loadConfig();
  const fps = args.fps || 30;
  const outFile = path.resolve(args.out || cfg.output || path.join(ROOT, "out", "casos_icfes.mp4"));
  const outDir = path.dirname(outFile);
  const framesDir = path.join(outDir, "frames");

  const memePath = args.meme || path.join(ROOT, "assets", "meme.jpg");
  const musicPath = args.music || path.join(ROOT, "assets", "musica.mp3");

  await mkdir(outDir, { recursive: true });
  if (args.keepFrames) { await rm(framesDir, { recursive: true, force: true }); await mkdir(framesDir, { recursive: true }); }

  const { ffmpeg, ffprobe } = await resolveFfmpeg();
  log(`ffmpeg: ${ffmpeg}`);

  log("abriendo la página en Chromium 1080x1920…");
  const tl = await openTimeline({
    page: args.page || path.join(ROOT, "casos_icfes.html"),
    caso: args.caso,
    meme: existsSync(memePath) ? memePath : undefined,
  });

  if (!existsSync(memePath)) log(`aviso: no existe ${rel(memePath)} — la imagen entre casos sale en negro`);

  try {
    const frames = Math.round((tl.duration / 1000) * fps);
    const vDur = frames / fps; // duración real del vídeo; el audio se corta aquí
    log(`duración: ${(tl.duration / 1000).toFixed(2)}s -> ${frames} cuadros a ${fps} fps${args.caso ? ` (caso ${args.caso})` : ""}`);
    if (vDur >= 60) log(`AVISO: ${vDur.toFixed(1)}s supera los 60s de Shorts.`);

    /* ---------------------------- 1. vídeo ---------------------------- */
    const silentMp4 = path.join(outDir, ".video-sin-audio.mp4");
    await renderFrames({ tl, ffmpeg, fps, frames, crf: args.crf, out: silentMp4, framesDir: args.keepFrames ? framesDir : null });

    /* ---------------------------- 2. audio ---------------------------- */
    let mixWav = null;
    if (args.audio) {
      const sfxWav = path.join(outDir, ".sfx.wav");
      await renderWav(tl, sfxWav, log);
      mixWav = path.join(outDir, ".mix.wav");
      await mixAudio({
        ffmpeg, sfx: sfxWav, music: existsSync(musicPath) ? musicPath : null,
        duration: vDur, out: mixWav, trimSilence: args.trimSilence,
        sfxGain: args.sfxGain != null ? args.sfxGain : (cfg.sfxGain != null ? cfg.sfxGain : 10),
        log,
      });
      await rm(sfxWav, { force: true });
    }

    /* ---------------------------- 3. mux ------------------------------ */
    log("uniendo vídeo y audio…");
    const muxArgs = ["-y", "-hide_banner", "-loglevel", "error", "-i", silentMp4];
    if (mixWav) muxArgs.push("-i", mixWav);
    muxArgs.push("-map", "0:v:0");
    if (mixWav) muxArgs.push("-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-ar", "48000");
    muxArgs.push("-c:v", "copy", "-t", vDur.toFixed(3), "-movflags", "+faststart", outFile);
    await runFfmpeg(ffmpeg, muxArgs);

    await rm(silentMp4, { force: true });
    if (mixWav) await rm(mixWav, { force: true });

    /* ---------------------------- 4. informe -------------------------- */
    // El informe final nunca debe tumbar un render que ya terminó bien.
    let info = null;
    try { info = await probe(ffprobe, outFile); }
    catch (e) { log(`aviso: ffprobe no pudo leer el resultado (${e.message.split("\n")[0]})`); }
    log(`listo: ${rel(outFile)}`);
    if (info) {
      log(`       ${info.width}x${info.height} · ${info.fps.toFixed(0)} fps · ${info.duration.toFixed(2)}s · ` +
          `${(info.size / 1048576).toFixed(1)} MB · vídeo ${info.vcodec} · audio ${info.acodec || "ninguno"}`);
    } else {
      log("       (sin ffprobe no puedo verificar el resultado)");
    }
  } finally {
    await tl.close();
  }
}

/* --------------------- cuadro a cuadro hacia ffmpeg -------------------- */
async function renderFrames({ tl, ffmpeg, fps, frames, crf, out, framesDir }) {
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0",
    "-an",
    "-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-movflags", "+faststart",
    "-vf", `scale=${OUT_W}:${OUT_H}:flags=lanczos`,
    out,
  ];

  let proc;
  const done = runFfmpeg(ffmpeg, args, { onStdin: (p) => { proc = p; } });
  // runFfmpeg llama onStdin de forma síncrona al spawnear
  const stdin = proc.stdin;
  stdin.on("error", () => {}); // si ffmpeg muere, el error real llega por `done`

  const t0 = Date.now();
  let lastPct = -1;

  for (let i = 0; i < frames; i++) {
    await tl.seek((i * 1000) / fps);
    const png = await tl.page.screenshot({ type: "png" });

    if (framesDir) await writeFile(path.join(framesDir, `f${String(i).padStart(6, "0")}.png`), png);

    if (!stdin.write(png)) await new Promise((r) => stdin.once("drain", r));

    const pct = Math.floor(((i + 1) / frames) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      const el = (Date.now() - t0) / 1000;
      const eta = el / (i + 1) * (frames - i - 1);
      process.stdout.write(`\r  cuadros ${String(pct).padStart(3)}%  ${i + 1}/${frames}  ETA ${fmt(eta)}   `);
    }
  }
  process.stdout.write("\n");
  stdin.end();
  await done;
}

/* -------------------------------- util --------------------------------- */
async function loadConfig() {
  const f = path.join(ROOT, "config.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(await readFile(f, "utf8")); }
  catch { throw friendly("config.json no es JSON válido."); }
}
const rel = (p) => path.relative(process.cwd(), p) || p;
const fmt = (s) => (s < 60 ? `${Math.ceil(s)}s` : `${Math.floor(s / 60)}m${String(Math.ceil(s % 60)).padStart(2, "0")}s`);
const log = (m) => console.log(`· ${m}`);
function friendly(msg) { const e = new Error(msg); e.friendly = true; return e; }

main().catch((e) => {
  process.stdout.write("\n");
  console.error(e.friendly ? `\n${e.message}\n` : e);
  process.exit(1);
});
