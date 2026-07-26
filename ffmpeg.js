/**
 * Localiza ffmpeg y ffprobe sin explotar con un stack trace.
 * Orden: variables de entorno -> PATH del sistema -> paquetes npm opcionales.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const INSTALL = `
No encontré ffmpeg (y lo necesito para armar el mp4).

  macOS        brew install ffmpeg
  Ubuntu/Deb   sudo apt install ffmpeg
  Windows      winget install Gyan.FFmpeg
  Sin permisos npm i ffmpeg-static ffprobe-static   (se instala dentro del proyecto)

También puedes apuntarlo a mano:  export FFMPEG_PATH=/ruta/a/ffmpeg
`;

function fromPath(bin) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [bin], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

async function fromModule(mod, pick) {
  try {
    const m = await import(mod);
    const p = pick(m.default ?? m);
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

let cache = null;

export async function resolveFfmpeg() {
  if (cache) return cache;

  const ffmpeg =
    (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : null) ||
    fromPath("ffmpeg") ||
    (await fromModule("ffmpeg-static", (m) => (typeof m === "string" ? m : m.path)));

  if (!ffmpeg) {
    const e = new Error(INSTALL.trim());
    e.friendly = true;
    throw e;
  }

  const ffprobe =
    (process.env.FFPROBE_PATH && existsSync(process.env.FFPROBE_PATH) ? process.env.FFPROBE_PATH : null) ||
    fromPath("ffprobe") ||
    (await fromModule("ffprobe-static", (m) => m.path));

  // El ffmpeg que trae Playwright viene recortado: sin libx264 ni filtros de
  // audio. Si es el único que hay, avisar antes de perder 5 minutos rendering.
  let encoders = "";
  try {
    encoders = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  } catch { /* seguimos, ya fallará más claro abajo */ }
  if (encoders && !/\blibx264\b/.test(encoders)) {
    const e = new Error(
      `El ffmpeg encontrado (${ffmpeg}) no tiene libx264, no puede producir H.264.\n${INSTALL.trim()}`
    );
    e.friendly = true;
    throw e;
  }

  cache = { ffmpeg, ffprobe };
  return cache;
}

/** Ejecuta ffmpeg y rechaza con las últimas líneas de log si falla. */
export function runFfmpeg(bin, args, { onStdin, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: [onStdin ? "pipe" : "ignore", "ignore", "pipe"] });
    let log = "";
    p.stderr.on("data", (d) => {
      log += d.toString();
      if (log.length > 20000) log = log.slice(-20000);
      if (!quiet) process.stderr.write(d);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg salió con código ${code}\n${log.split("\n").slice(-18).join("\n")}`));
    });
    if (onStdin) onStdin(p);
  });
}

/** "30/1" -> 30 */
function ratio(s) {
  const [a, b] = String(s || "0/1").split("/").map(Number);
  return b ? a / b : a || 0;
}

/** ffprobe -> objeto con duración, ancho, alto, códecs y tamaño. */
export async function probe(ffprobeBin, file) {
  if (!ffprobeBin) return null;
  const out = execFileSync(
    ffprobeBin,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf8", maxBuffer: 8 << 20 }
  );
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return {
    duration: parseFloat(j.format.duration),
    size: parseInt(j.format.size, 10),
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    fps: v ? ratio(v.r_frame_rate) : 0,
    vcodec: v ? v.codec_name : null,
    acodec: a ? a.codec_name : null,
    hasAudio: !!a,
  };
}
