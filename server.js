import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// In-memory job store (MVP)
const jobs = new Map();

/* -------------------- UTILITIES -------------------- */

function setJob(jobId, patch) {
  jobs.set(jobId, { ...(jobs.get(jobId) || {}), ...patch });
}

function runFfmpegAll(args) {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  const combined = (r.stdout || "") + "\n" + (r.stderr || "");
  if (r.status !== 0) {
    throw new Error(combined.slice(-2000));
  }
  return combined;
}

function parseLoudnormJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function getMasterTarget(profile) {
  if (profile === "apple_music") return { I: -16, TP: -1.0, LRA: 11 };
  if (profile === "loud") return { I: -10, TP: -0.8, LRA: 8 };
  return { I: -14, TP: -1.0, LRA: 10 };
}

function getFocusFilter(focus) {
  switch (focus) {
    case "bass": return "equalizer=f=90:t=q:w=1:g=2";
    case "presence": return "equalizer=f=3500:t=q:w=1:g=2";
    case "air": return "equalizer=f=12000:t=q:w=1:g=2";
    case "wide": return "stereotools=mlev=1:slev=1.2";
    case "punch": return "acompressor=threshold=-16dB:ratio=2.5:attack=8:release=80:makeup=2";
    default: return "";
  }
}

function tempoPitch(speed, semitones) {
  const base = [
    "aresample=48000:resampler=soxr",
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    `atempo=${speed}`
  ];
  if (!semitones) return base.join(",");

  const ratio = Math.pow(2, semitones / 12);
  return [
    ...base,
    `asetrate=48000*${ratio}`,
    "aresample=48000",
    `atempo=${1 / ratio}`
  ].join(",");
}

/* -------------------- ROUTES -------------------- */

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/enhance", async (req, res) => {
  try {
    const {
      inputFileUrl,
      enhancementType,
      speedMultiplier = 1,
      pitchSemitones = 0,
      focus = "none",
      masterProfile = "streaming"
    } = req.body || {};

    if (!inputFileUrl || !["mix", "master", "4d"].includes(enhancementType)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const jobId = nanoid();
    setJob(jobId, { status: "queued" });

    processJob(jobId, {
      inputFileUrl,
      enhancementType,
      speedMultiplier,
      pitchSemitones,
      focus,
      masterProfile
    }).catch(e => {
      setJob(jobId, { status: "failed", error: e.message });
    });

    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

app.get("/download/:id", (req, res) => {
  const out = `/tmp/${req.params.id}/output.wav`;
  if (!fs.existsSync(out)) return res.status(404).send("Not found");
  res.download(out, `enhanced-${req.params.id}.wav`);
});

/* -------------------- PROCESSING -------------------- */

async function processJob(jobId, opts) {
  setJob(jobId, { status: "processing", step: "Downloading audio…" });

  const dir = `/tmp/${jobId}`;
  fs.mkdirSync(dir, { recursive: true });

  const raw = path.join(dir, "input");
  const wav = path.join(dir, "decoded.wav");
  const out = path.join(dir, "output.wav");

  const r = await fetch(opts.inputFileUrl);
  if (!r.ok) throw new Error("Failed to fetch input file");
  fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));

  runFfmpegAll(["-y", "-i", raw, "-ac", "2", "-ar", "48000", wav]);

  const focusFilter = getFocusFilter(opts.focus);
  const tempo = tempoPitch(opts.speedMultiplier, opts.pitchSemitones);

  if (opts.enhancementType === "mix") {
    setJob(jobId, { step: "Mixing track…" });
    const af = [
      "highpass=f=30",
      "lowpass=f=18000",
      "equalizer=f=250:t=q:w=1:g=-2",
      "equalizer=f=3500:t=q:w=1:g=1.5",
      "acompressor=threshold=-18dB:ratio=3:attack=20:release=120:makeup=4",
      focusFilter,
      tempo,
      "alimiter=limit=0.99"
    ].filter(Boolean).join(",");

    runFfmpegAll(["-y", "-i", wav, "-af", af, out]);
  }

  if (opts.enhancementType === "4d
