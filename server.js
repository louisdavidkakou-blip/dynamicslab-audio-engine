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

// Ephemeral MVP log (tomorrow move to DB)
const CLASSIFICATION_LOG_PATH =
  process.env.CLASSIFICATION_LOG_PATH || "/tmp/classification.ndjson";

const jobs = new Map();
const classificationEvents = [];

function setJob(jobId, patch) {
  jobs.set(jobId, { ...(jobs.get(jobId) || {}), ...patch });
}

function runFfmpegAll(args) {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  const combined = (r.stdout || "") + "\n" + (r.stderr || "");
  if (r.status !== 0) throw new Error(combined.slice(-2500));
  return combined;
}

function parseNumberFrom(text, key) {
  const idx = text.indexOf(key);
  if (idx === -1) return null;
  const slice = text.slice(idx + key.length);
  const m = slice.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
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

function logClassification(event) {
  const line = JSON.stringify(event) + "\n";
  classificationEvents.push(event);
  if (classificationEvents.length > 500) classificationEvents.shift();
  try {
    fs.appendFileSync(CLASSIFICATION_LOG_PATH, line);
  } catch {
    // ignore for MVP
  }
}

/** Platform mastering targets */
function getMasterTarget(profile) {
  if (profile === "apple_music") return { I: -16, TP: -1.0, LRA: 11 };
  if (profile === "soundcloud") return { I: -13, TP: -1.0, LRA: 10 };
  if (profile === "spotify") return { I: -14, TP: -1.0, LRA: 10 };
  if (profile === "loud") return { I: -10, TP: -0.8, LRA: 8 };
  return { I: -14, TP: -1.0, LRA: 10 };
}

/**
 * MIX SAFETY TARGET (balanced, never crushed):
 * -16 LUFS integrated and -1.2 dBTP true peak is a safe “preview/download” level.
 */
function getMixTarget() {
  return { I: -16, TP: -1.2, LRA: 12 };
}

/** Quick energy analysis using volumedetect on bands */
function analyzeBands(wavPath) {
  const vol = (af) => {
    const out = runFfmpegAll([
      "-hide_banner",
      "-nostats",
      "-i",
      wavPath,
      "-af",
      `${af},volumedetect`,
      "-f",
      "null",
      "-"
    ]);
    return {
      mean: parseNumberFrom(out, "mean_volume:"),
      max: parseNumberFrom(out, "max_volume:")
    };
  };

  const low = vol("lowpass=f=200");
  const mid = vol("highpass=f=200,lowpass=f=8000");
  const high = vol("highpass=f=8000");
  const full = vol("anull");

  const profile = {
    lowMean: low.mean,
    midMean: mid.mean,
    highMean: high.mean,
    fullMean: full.mean,
    fullMax: full.max
  };

  const tags = [];

  if (Number.isFinite(profile.lowMean) && Number.isFinite(profile.midMean)) {
    if (profile.lowMean - profile.midMean < -8) tags.push("low_end_weak");
    if (profile.lowMean - profile.midMean > 6) tags.push("low_end_heavy");
  }

  if (Number.isFinite(profile.highMean) && Number.isFinite(profile.midMean)) {
    if (profile.highMean - profile.midMean > -3) tags.push("harsh_highs");
    if (profile.highMean - profile.midMean < -14) tags.push("dull_highs");
  }

  if (Number.isFinite(profile.midMean) && Number.isFinite(profile.fullMean)) {
    if (profile.midMean - profile.fullMean > 2.5) tags.push("mid_forward");
  }

  if (Number.isFinite(profile.fullMax) && profile.fullMax > -1.0) tags.push("too_loud");
  if (Number.isFinite(profile.fullMean) && profile.fullMean < -22) tags.push("too_quiet");

  return { profile, tags };
}

/**
 * Adaptive tone fixes (tuned DOWN to avoid harsh processing)
 * We’ll rely on loudnorm at the end for level consistency.
 */
function buildAdaptiveTone(tags) {
  const filters = [];

  if (tags.includes("low_end_weak")) {
    filters.push("bass=g=3.5:f=100:w=0.7");
  }
  if (tags.includes("low_end_heavy")) {
    filters.push("bass=g=-3:f=110:w=0.8");
    filters.push("equalizer=f=250:t=q:w=1:g=-1.5");
  }
  if (tags.includes("harsh_highs")) {
    filters.push("treble=g=-2.8:f=9000:w=0.6");
    filters.push("equalizer=f=3500:t=q:w=1:g=-1");
  }
  if (tags.includes("dull_highs")) {
    filters.push("treble=g=2.0:f=9000:w=0.6");
  }
  if (tags.includes("mid_forward")) {
    filters.push("equalizer=f=320:t=q:w=1:g=-2.0");
  }

  return filters;
}

/**
 * Focus filters made AUDIBLE but safer:
 * (Wide no longer explodes the level because loudnorm/limiter will catch it.)
 */
function getFocusFilters(focus) {
  switch (focus) {
    case "bass":
      return [
        "bass=g=6:f=90:w=0.8",
        "acompressor=threshold=-20dB:ratio=2.0:attack=25:release=160:makeup=1.2"
      ];
    case "presence":
      return [
        "equalizer=f=3500:t=q:w=1:g=2.5",
        "equalizer=f=6000:t=q:w=1:g=1.0"
      ];
    case "air":
      return ["treble=g=3.5:f=10000:w=0.7"];
    case "wide":
      return ["stereotools=mlev=1:slev=1.35", "extrastereo=m=2.0"];
    case "punch":
      return [
        "acompressor=threshold=-18dB:ratio=2.6:attack=8:release=90:makeup=1.5",
        "equalizer=f=120:t=q:w=1:g=1.0",
        "equalizer=f=3000:t=q:w=1:g=1.0"
      ];
    default:
      return [];
  }
}

function buildTempoPitch(speedMultiplier, pitchSemitones) {
  const base = [
    "aresample=48000:resampler=soxr",
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    `atempo=${speedMultiplier}`
  ];

  if (!pitchSemitones) return base;

  const ratio = Math.pow(2, pitchSemitones / 12);
  return [
    ...base,
    `asetrate=48000*${ratio}`,
    "aresample=48000:resampler=soxr",
    `atempo=${1 / ratio}`
  ];
}

/** Double-pass loudnorm helper */
function loudnormMeasure(wavPath, target) {
  const out = runFfmpegAll([
    "-hide_banner",
    "-nostats",
    "-i",
    wavPath,
    "-af",
    `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:print_format=json`,
    "-f",
    "null",
    "-"
  ]);
  const m = parseLoudnormJson(out);
  if (!m) throw new Error("Loudnorm measurement failed (JSON missing)");
  return m;
}

function loudnormSecondPassFilter(target, measured) {
  return (
    `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:` +
    `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:` +
    `measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
  );
}

/* ---------------- ROUTES ---------------- */

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/classification/recent", (req, res) => {
  res.json({ count: classificationEvents.length, events: classificationEvents.slice(-50) });
});

app.get("/classification/export", (req, res) => {
  try {
    if (!fs.existsSync(CLASSIFICATION_LOG_PATH)) return res.status(404).send("No log file yet");
    res.download(CLASSIFICATION_LOG_PATH, "classification.ndjson");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post("/enhance", async (req, res) => {
  try {
    const body = req.body || {};
    const inputFileUrl = body.inputFileUrl;
    const enhancementType = body.enhancementType;

    const speedMultiplier = Number(body.speedMultiplier ?? 1.0);
    const pitchSemitones = Number(body.pitchSemitones ?? 0);
    const focus = String(body.focus ?? "none");
    const masterProfile = String(body.masterProfile ?? "spotify");

    if (!inputFileUrl) return res.status(400).json({ error: "Missing inputFileUrl" });
    if (!["mix", "master", "4d"].includes(enhancementType)) {
      return res.status(400).json({ error: "Invalid enhancementType" });
    }
    if (!(speedMultiplier >= 0.5 && speedMultiplier <= 2.0)) {
      return res.status(400).json({ error: "Invalid speedMultiplier" });
    }
    if (!(pitchSemitones >= -4 && pitchSemitones <= 4)) {
      return res.status(400).json({ error: "Invalid pitchSemitones" });
    }
    if (!["none", "bass", "presence", "air", "wide", "punch"].includes(focus)) {
      return res.status(400).json({ error: "Invalid focus" });
    }
    if (!["spotify", "apple_music", "soundcloud", "loud"].includes(masterProfile)) {
      return res.status(400).json({ error: "Invalid masterProfile" });
    }

    const jobId = nanoid();

    setJob(jobId, {
      status: "queued",
      createdAt: Date.now(),
      request: {
        inputFileUrl,
        enhancementType,
        speedMultiplier,
        pitchSemitones,
        focus,
        masterProfile
      }
    });

    processJob(jobId, {
      inputFileUrl,
      enhancementType,
      speedMultiplier,
      pitchSemitones,
      focus,
      masterProfile
    }).catch((e) => {
      setJob(jobId, { status: "failed", error: e.message, failedAt: Date.now() });
      logClassification({
        eventType: "render_failed",
        id: nanoid(),
        createdAt: Date.now(),
        jobId,
        request: jobs.get(jobId)?.request ?? null,
        analysis: jobs.get(jobId)?.analysis ?? null,
        renderPlan: jobs.get(jobId)?.renderPlan ?? null,
        error: e.message
      });
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

app.post("/feedback", (req, res) => {
  try {
    const body = req.body || {};
    const jobId = String(body.jobId || "");
    const rating = String(body.rating || "");
    const reason = String(body.reason || "");
    const notes = String(body.notes || "");
    const userId = body.userId ? String(body.userId) : null;

    if (!jobId) return res.status(400).json({ error: "Missing jobId" });
    if (!["satisfied", "not_satisfied"].includes(rating)) {
      return res.status(400).json({ error: "Invalid rating" });
    }

    const job = jobs.get(jobId);
    const event = {
      eventType: "feedback",
      id: nanoid(),
      createdAt: Date.now(),
      jobId,
      rating,
      reason,
      notes,
      userId,
      request: job?.request ?? null,
      analysis: job?.analysis ?? null,
      renderPlan: job?.renderPlan ?? null
    };

    logClassification(event);
    res.json({ ok: true, feedbackId: event.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- PROCESSING ---------------- */

async function processJob(jobId, opts) {
  setJob(jobId, { status: "processing", step: "Downloading audio..." });

  const dir = `/tmp/${jobId}`;
  fs.mkdirSync(dir, { recursive: true });

  const raw = path.join(dir, "input.bin");
  const wav = path.join(dir, "decoded.wav");
  const pre = path.join(dir, "pre.wav");
  const out = path.join(dir, "output.wav");

  const r = await fetch(opts.inputFileUrl);
  if (!r.ok) throw new Error(`Failed to fetch input file: ${r.status}`);
  fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));

  setJob(jobId, { step: "Decoding & preparing audio..." });
  runFfmpegAll(["-y", "-i", raw, "-ac", "2", "-ar", "48000", wav]);

  setJob(jobId, { step: "Analyzing tone & dynamics..." });
  const bandAnalysis = analyzeBands(wav);

  const summary = bandAnalysis.tags.length
    ? `Detected: ${bandAnalysis.tags.join(", ")}`
    : "Detected: balanced";

  setJob(jobId, {
    analysis: {
      tags: bandAnalysis.tags,
      profile: bandAnalysis.profile,
      summary
    }
  });

  const adaptiveTone = buildAdaptiveTone(bandAnalysis.tags);
  const tempoPitch = buildTempoPitch(opts.speedMultiplier, opts.pitchSemitones);
  const focusFilters = getFocusFilters(opts.focus);

  // Render plan (logged + displayed)
  const renderPlan = {
    tags: bandAnalysis.tags,
    actions: {
      adaptiveToneFilters: adaptiveTone,
      focus: opts.focus,
      focusFilters,
      speedMultiplier: opts.speedMultiplier,
      pitchSemitones: opts.pitchSemitones,
      enhancementType: opts.enhancementType,
      masterProfile: opts.masterProfile
    },
    safety: {
      mixTarget: getMixTarget(),
      masterTarget: getMasterTarget(opts.masterProfile)
    }
  };
  setJob(jobId, { renderPlan });

  // Step 1: apply "creative" processing to PRE file (no loudness forcing yet)
  if (opts.enhancementType === "mix") {
    setJob(jobId, { step: "Applying mix enhancements (EQ/Dynamics/Space)..." });

    // Mild compression (NO heavy makeup gain) to avoid saturation
    const mixEnhance = [
      "highpass=f=30",
      "lowpass=f=18000",
      "acompressor=threshold=-20dB:ratio=2.0:attack=25:release=160:makeup=1.0",
      "stereotools=mlev=1:slev=1.12",
      ...adaptiveTone,
      ...focusFilters,
      ...tempoPitch
    ].filter(Boolean).join(",");

    runFfmpegAll(["-y", "-i", wav, "-af", mixEnhance, pre]);

    // Step 2: standards-based loudness + true-peak cap (double pass)
    setJob(jobId, { step: "Balancing loudness & true peak (EBU R128)..." });
    const target = getMixTarget();
    const measured = loudnormMeasure(pre, target);
    const ln2 = loudnormSecondPassFilter(target, measured);

    // Safety limiter as final guard (should barely work)
    const final = [ln2, "alimiter=limit=0.985:attack=2:release=60"].join(",");

    setJob(jobId, { step: "Finalizing mix..." });
    runFfmpegAll(["-y", "-i", pre, "-af", final, out]);
  }

  if (opts.enhancementType === "4d") {
    setJob(jobId, { step: "Creating 4D space..." });

    const d4 = [
      "highpass=f=30",
      "stereotools=mlev=1:slev=1.28",
      "apulsator=hz=0.12:amount=0.30",
      "aecho=0.8:0.85:40:0.10",
      ...adaptiveTone,
      ...focusFilters,
      ...tempoPitch
    ].filter(Boolean).join(",");

    runFfmpegAll(["-y", "-i", wav, "-af", d4, pre]);

    // keep 4D balanced too
    setJob(jobId, { step: "Balancing loudness & true peak..." });
    const target = getMixTarget();
    const measured = loudnormMeasure(pre, target);
    const ln2 = loudnormSecondPassFilter(target, measured);
    const final = [ln2, "alimiter=limit=0.985:attack=2:release=60"].join(",");

    setJob(jobId, { step: "Finalizing 4D output..." });
    runFfmpegAll(["-y", "-i", pre, "-af", final, out]);
  }

  if (opts.enhancementType === "master") {
    setJob(jobId, { step: "Measuring loudness (LUFS/True Peak)..." });
    const target = getMasterTarget(opts.masterProfile);

    // Pre-master (gentle)
    const preMaster = [
      "highpass=f=25",
      "acompressor=threshold=-22dB:ratio=1.8:attack=15:release=120:makeup=1.0",
      ...adaptiveTone,
      ...focusFilters,
      ...tempoPitch
    ].filter(Boolean).join(",");

    runFfmpegAll(["-y", "-i", wav, "-af", preMaster, pre]);

    // Double-pass loudnorm to hit platform target safely (true peak cap)
    setJob(jobId, { step: "Normalizing to platform target (EBU R128 / BS.1770)..." });
    const measured = loudnormMeasure(pre, target);
    const ln2 = loudnormSecondPassFilter(target, measured);

    const final = [ln2, "alimiter=limit=0.985:attack=2:release=60"].join(",");

    setJob(jobId, {
      step:
        opts.masterProfile === "apple_music"
          ? "Finalizing Apple Music master..."
          : opts.masterProfile === "soundcloud"
            ? "Finalizing SoundCloud master..."
            : opts.masterProfile === "loud"
              ? "Finalizing loud master..."
              : "Finalizing Spotify master..."
    });

    runFfmpegAll(["-y", "-i", pre, "-af", final, out]);
  }

  if (!fs.existsSync(out)) throw new Error("Output missing after render");

  logClassification({
    eventType: "render_completed",
    id: nanoid(),
    createdAt: Date.now(),
    jobId,
    request: jobs.get(jobId)?.request ?? null,
    analysis: jobs.get(jobId)?.analysis ?? null,
    renderPlan: jobs.get(jobId)?.renderPlan ?? null
  });

  setJob(jobId, {
    status: "done",
    enhancedFileUrl: `${PUBLIC_BASE_URL}/download/${jobId}`,
    finishedAt: Date.now()
  });
}

app.listen(PORT, () => {
  console.log(`Audio engine running on ${PORT}`);
});
