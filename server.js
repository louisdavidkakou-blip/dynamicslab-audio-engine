import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { nanoid } from "nanoid";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// In-memory jobs (MVP). Production: Redis/DB + object storage for outputs.
const jobs = new Map();

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/net-test", async (req, res) => {
  try {
    const r = await fetch("https://example.com", { method: "GET" });
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

function setJob(jobId, patch) {
  const prev = jobs.get(jobId) || {};
  jobs.set(jobId, { ...prev, ...patch });
}

function runFfmpeg(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    // ffmpeg often writes details to stderr
    const out = (e?.stdout?.toString() || "") + "\n" + (e?.stderr?.toString() || "");
    throw new Error(out.trim() || String(e?.message || e));
  }
}

function parseLoudnormJson(mixedOutput) {
  const start = mixedOutput.indexOf("{");
  const end = mixedOutput.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(mixedOutput.slice(start, end + 1));
  } catch {
    return null;
  }
}

function getMasterTarget(profile) {
  // Practical streaming targets (safe + consistent)
  if (profile === "apple_music") return { I: -16, TP: -1.0, LRA: 11 };
  if (profile === "loud") return { I: -10, TP: -0.8, LRA: 8 };
  // default streaming / spotify-ish
  return { I: -14, TP: -1.0, LRA: 10 };
}

function getFocusFilters(focus) {
  switch (focus) {
    case "bass":
      return "equalizer=f=90:t=q:w=1:g=2.0";
    case "presence":
      return "equalizer=f=3500:t=q:w=1:g=2.0";
    case "air":
      return "equalizer=f=12000:t=q:w=1:g=2.0";
    case "wide":
      return "stereotools=mlev=1.0:slev=1.20";
    case "punch":
      // “punch” feel via faster attack/release compression (not true transient shaping)
      return "acompressor=threshold=-16dB:ratio=2.5:attack=8:release=80:makeup=2";
    default:
      return "";
  }
}

function buildTempoPitchFilters({ speedMultiplier, pitchSemitones = 0 }) {
  // Stabilize first (reduces time-stretch artifacts)
  const base = ["aresample=48000:resampler=soxr:precision=28", "aformat=sample_fmts=fltp:channel_layouts=stereo"];

  // Tempo (atempo supports 0.5–2.0)
  const tempo = `atempo=${speedMultiplier}`;

  // Pitch shift (without keeping tempo) using sample-rate trick + compensation
  if (!pitchSemitones || pitchSemitones === 0) {
    return [...base, tempo].join(",");
  }

  const ratio = Math.pow(2, pitchSemitones / 12);

  const pitch = [
    `asetrate=48000*${ratio}`,
    "aresample=48000:resampler=soxr:precision=28",
    // compensate tempo so duration doesn't drift unexpectedly
    `atempo=${1 / ratio}`,
  ].join(",");

  return [...base, tempo, pitch].join(",");
}

app.post("/enhance", async (req, res) => {
  try {
    const { inputFileUrl, enhancementType } = req.body || {};

    const speedMultiplier = Number(req.body?.speedMultiplier ?? 1.0);

    // Optional controls
    const focus = String(req.body?.focus ?? "none"); // none|bass|presence|air|wide|punch
    const masterProfile = String(req.body?.masterProfile ?? "streaming"); // streaming|apple_music|loud
    const pitchSemitones = Number(req.body?.pitchSemitones ?? 0); // e.g. -1 for slowed

    if (!inputFileUrl || !enhancementType) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["inputFileUrl", "enhancementType"],
      });
    }

    if (!["mix", "master", "4d"].includes(enhancementType)) {
      return res.status(400).json({
        error: "Invalid enhancementType",
        allowed: ["mix", "master", "4d"],
      });
    }

    if (!(speedMultiplier >= 0.5 && speedMultiplier <= 2.0)) {
      return res.status(400).json({ error: "Invalid speedMultiplier (0.5–2.0)" });
    }

    if (!["none", "bass", "presence", "air", "wide", "punch"].includes(focus)) {
      return res.status(400).json({ error: "Invalid focus option" });
    }

    if (!["streaming", "apple_music", "loud"].includes(masterProfile)) {
      return res.status(400).json({ error: "Invalid masterProfile" });
    }

    if (!(pitchSemitones >= -4 && pitchSemitones <= 4)) {
      return res.status(400).json({ error: "pitchSemitones out of range (-4 to 4)" });
    }

    const jobId = nanoid();
    jobs.set(jobId, { status: "queued", createdAt: Date.now() });

    processJob(jobId, {
      inputFileUrl,
      enhancementType,
      speedMultiplier,
      pitchSemitones,
      focus,
      masterProfile,
    }).catch((e) => {
      setJob(jobId, { status: "failed", error: String(e?.message || e), failedAt: Date.now() });
    });

    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
});

app.get("/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

async function processJob(jobId, { inputFileUrl, enhancementType, speedMultiplier, pitchSemitones, focus, masterProfile }) {
  setJob(jobId, { status: "processing", step: "Downloading track…" });

  const workdir = `/tmp/${jobId}`;
  fs.mkdirSync(workdir, { recursive: true });

  const rawPath = path.join(workdir, "input.raw");
  const decodedWav = path.join(workdir, "decoded.wav");
  const outPath = path.join(workdir, "output.wav");

  // Download
  const r = await fetch(inputFileUrl);
  if (!r.ok) throw new Error(`Failed to fetch inputFileUrl: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf?.length) throw new Error("Downloaded input file is empty");
  fs.writeFileSync(rawPath, buf);

  // Decode to stable WAV (prevents many atempo glitches)
  setJob(jobId, { step: "Preparing audio…" });
  runFfmpeg(`ffmpeg -y -i "${rawPath}" -ac 2 -ar 48000 -c:a pcm_s16le "${decodedWav}"`);

  // Build enhancement filters
  const focusFilter = getFocusFilters(focus);
  const tempoPitch = buildTempoPitchFilters({ speedMultiplier, pitchSemitones });

  // MIX chain: cleanup + gentle comp + limiter
  let mixCore = [
    "highpass=f=30",
    "lowpass=f=18000",
    "equalizer=f=250:t=q:w=1:g=-2",       // reduce mud
    "equalizer=f=3500:t=q:w=1:g=1.5",     // presence
    "acompressor=threshold=-18dB:ratio=3:attack=20:release=120:makeup=4",
  ];

  // MASTER chain: we will do analysis + loudnorm + final limiter
  // Before loudnorm we can do gentle tone shaping + glue compression
  let masterPre = [
    "highpass=f=25",
    "acompressor=threshold=-20dB:ratio=2:attack=10:release=100:makeup=2",
  ];

  // 4D chain: movement + depth + limiter
  let d4Core = [
    "highpass=f=30",
    "stereotools=mlev=1.0:slev=1.25",
    "apulsator=hz=0.12:amount=0.35",
    "aecho=0.8:0.85:40:0.15",
  ];

  // Add focus (optional) into chains
  if (focusFilter) {
    mixCore.push(focusFilter);
    masterPre.push(focusFilter);
    d4Core.push(focusFilter);
  }

  // Add widen subtly for mix (only if user requested "wide" it already did more)
  if (focus !== "wide") mixCore.push("stereotools=mlev=1.0:slev=1.12");

  // Add limiter at end (mix + 4d). Master uses loudnorm + limiter after.
  const mixLimiter = "alimiter=limit=0.99:attack=5:release=80";
  const d4Limiter = "alimiter=limit=0.98:attack=3:release=60";

  // Build final filter depending on type
  if (enhancementType === "mix") {
    setJob(jobId, { step: "Mixing (balance, EQ, dynamics)..." });

    const af = [...mixCore, tempoPitch, mixLimiter].join(",");
    setJob(jobId, { step: "Rendering mix..." });

    runFfmpeg(`ffmpeg -y -i "${decodedWav}" -af "${af}" "${outPath}"`);
  }

  if (enhancementType === "4d") {
    setJob(jobId, { step: "Designing spatial depth..." });

    const af = [...d4Core, tempoPitch, d4Limiter].join(",");
    setJob(jobId, { step: "Rendering 4D audio..." });

    runFfmpeg(`ffmpeg -y -i "${decodedWav}" -af "${af}" "${outPath}"`);
  }

  if (enhancementType === "master") {
    setJob(jobId, { step: "Analyzing loudness (LUFS/True Peak)..." });

    const target = getMasterTarget(masterProfile);

    // 1) Measure loudness (first pass)
    const measureCmd = `ffmpeg -i "${decodedWav}" -af "loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:print_format=json" -f null -`;
    let mixedOut = "";
    try {
      mixedOut = execSync(measureCmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
    } catch (e) {
      mixedOut = (e?.stdout?.toString() || "") + "\n" + (e?.stderr?.toString() || "");
    }

    const measured = parseLoudnormJson(mixedOut);
    if (!measured) throw new Error("Could not read loudnorm measurement JSON");

    // 2) Build a smarter “pre” chain (conditional-ish)
    // We can’t fully detect low-end vs highs perfectly without deeper DSP,
    // but loudnorm alone will stabilize loudness + true peak.
    // We add gentle tone shaping + glue before loudnorm:
    setJob(jobId, { step: "Applying mastering chain..." });

    const tone = [
      // Mild “balance” EQ (very gentle)
      "equalizer=f=120:t=q:w=1:g=1.0",
      "equalizer=f=4500:t=q:w=1:g=0.8",
    ];

    const ln2 = `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:` +
      `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:` +
      `measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`;

    const masterLimiter = "alimiter=limit=0.98:attack=2:release=50";

    const af = [
      ...masterPre,
      ...tone,
      tempoPitch,
      ln2,
      masterLimiter,
    ].join(",");

    setJob(jobId, {
      step:
        masterProfile === "apple_music"
          ? "Finalizing Apple Music-safe master..."
          : masterProfile === "loud"
            ? "Finalizing loud master..."
            : "Finalizing streaming master..."
    });

    runFfmpeg(`ffmpeg -y -i "${decodedWav}" -af "${af}" "${outPath}"`);
  }

  if (!fs.existsSync(outPath)) throw new Error("Output file missing after render");
  const stat = fs.statSync(outPath);
  if (!stat.size) throw new Error("Output file is empty");

  setJob(jobId, {
    status: "done",
    finishedAt: Date.now(),
    enhancedFileUrl: `${PUBLIC_BASE_URL}/download/${jobId}`,
  });
}

app.get("/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const outPath = `/tmp/${jobId}/output.wav`;
  if (!fs.existsSync(outPath)) return res.status(404).send("Not found");
  res.download(outPath, `enhanced-${jobId}.wav`);
});

app.listen(PORT, () => console.log(`Audio engine running on :${PORT}`));
