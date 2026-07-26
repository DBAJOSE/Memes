/**
 * Audio del short.
 *
 * 1) renderWav()  — pide a la página que renderice los efectos con
 *    OfflineAudioContext sobre la MISMA línea de tiempo que los cuadros, y
 *    trae el WAV a disco. Al no grabarse en tiempo real, queda sincronizado
 *    al sample con el vídeo.
 *
 * 2) mixAudio()   — opcionalmente mete assets/musica.mp3 por debajo a −18 dB
 *    con sidechaincompress (la música se agacha sola cuando suena un efecto),
 *    recorta al valor exacto de __duration() y aplica un fundido de 300 ms.
 */
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./ffmpeg.js";

const SAMPLE_RATE = 48000;
const CHUNK = 1 << 20; // 1 MiB de base64 por viaje

/** Renderiza los efectos de la página a un WAV en disco. */
export async function renderWav(tl, outWav, log = () => {}) {
  log("audio: renderizando efectos offline…");
  const total = await tl.page.evaluate((sr) => window.__renderAudio(sr), SAMPLE_RATE);
  if (!total) throw friendly("__renderAudio() no devolvió datos.");

  const parts = [];
  for (let i = 0; i < total; i += CHUNK) {
    const s = await tl.page.evaluate(([a, b]) => window.__wavSlice(a, b), [i, Math.min(total, i + CHUNK)]);
    parts.push(Buffer.from(s, "base64"));
  }
  // Se libera la copia del WAV que quedó en la página.
  await tl.page.evaluate(() => { delete window.__wav; });

  const buf = Buffer.concat(parts);
  await writeFile(outWav, buf);
  log(`audio: ${(buf.length / 1048576).toFixed(1)} MB de efectos -> ${path.basename(outWav)}`);
  return outWav;
}

/**
 * Mezcla efectos + música y deja un WAV del largo exacto del vídeo.
 * @param {object} o
 * @param {string} o.ffmpeg
 * @param {string} o.sfx        wav de efectos
 * @param {string|null} o.music mp3 opcional
 * @param {number} o.duration   segundos exactos (= __duration()/1000)
 * @param {string} o.out
 * @param {boolean} [o.trimSilence] recorta silencio SOLO al final
 */
export async function mixAudio({ ffmpeg, sfx, music, duration, out, trimSilence = false, sfxGain = 10, log = () => {} }) {
  const fadeAt = Math.max(0, duration - 0.3).toFixed(3);
  const dur = duration.toFixed(3);

  // Los efectos salen con picos bajos (~−15 dBFS): se suben y se limita para
  // que el short no suene tímido al lado del resto del feed.
  const lift = `volume=${sfxGain}dB,alimiter=limit=0.92:level=disabled`;

  // Recorte de cola: se hace con areverse para que NO toque los silencios
  // internos (el silencio mientras la IA "piensa" es parte del chiste).
  const tail = trimSilence
    ? "areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-60dB,areverse,"
    : "";

  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", sfx];
  let filter;

  if (music && existsSync(music)) {
    log(`audio: mezclando música (${path.basename(music)}) a −18 dB con sidechain`);
    args.push("-stream_loop", "-1", "-i", music);
    filter =
      `[0:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,${lift}[sfx];` +
      `[1:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,volume=-18dB[mus];` +
      `[sfx]asplit=2[sfxa][sfxkey];` +
      `[mus][sfxkey]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300:makeup=1[duck];` +
      `[sfxa][duck]amix=inputs=2:duration=first:normalize=0[m];` +
      `[m]${tail}atrim=0:${dur},asetpts=N/SR/TB,afade=t=out:st=${fadeAt}:d=0.3[a]`;
  } else {
    if (music) log(`audio: no existe ${music}, sigo solo con los efectos`);
    filter =
      `[0:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,${lift},` +
      `${tail}atrim=0:${dur},asetpts=N/SR/TB,afade=t=out:st=${fadeAt}:d=0.3[a]`;
  }

  args.push("-filter_complex", filter, "-map", "[a]", "-t", dur, "-c:a", "pcm_s16le", out);
  await runFfmpeg(ffmpeg, args);
  return out;
}

function friendly(msg) {
  const e = new Error(msg);
  e.friendly = true;
  return e;
}
