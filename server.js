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

// IMPORTANT: Render's filesystem is ephemeral. This is fine for MVP logging.
// Tomorrow we can switch this to a DB (Supabase/Postgres) or object storage.
const CLASSIFICATION_LOG_PATH = process.env.CLASSIFICATION_LOG_PATH || "/tmp/classification.ndjson";

const jobs = new Map();

// Simple in-memory cache of recent classification events
const classificationEvents = [];

function setJob(jobId, patch) {
  jobs.set(jobId, { ...(jobs.get(jobId) || {}), ...patch });
}

function runFfmpegAll(args) {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  const combined = (r.stdout || "") + "\n" + (r.stderr || "");
  if (r.status !== 0) throw new Error(combined.slice(-2000));
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

function getMasterTarget(profile) {
  if (profile === "apple_music") return { I: -16, TP: -1.0, LRA: 11 };
  if (profile === "soundcloud") return { I: -13, TP: -1.0, LRA: 10 };
  if (profile === "spotify") return { I: -14, TP: -1.0, LRA: 10 };
  if (profile === "loud") return { I: -10, TP: -0.8, LRA: 8 };
  return { I: -14, TP: -1.0, LRA: 10 };
}

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
    const mean = parseNumberFrom(out, "mean_volume:");
    const max = parseNumberFrom(out, "max_volume:");
    return { mean, max };
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

function buildAdaptiveTone(tags) {
  const filters = [];

  if (tags.includes("low_end_weak")) {
    filters.push("bass=g=6:f=100:w=0.6");
  }
  if (tags.includes("low_end_heavy")) {
    filters.push("bass=g=-4:f=110:w=0.7");
    filters.push("equalizer=f=250:t=q:w=1:g=-2");
  }
  if (tags.includes("harsh_highs")) {
    filters.push("treble=g=-4:f=9000:w=0.5");
    filters.push("equalizer=f=3500:t=q:w=1:g=-1");
  }
  if (tags.includes("dull_highs")) {
    filters.push("treble=g=3:f=9000:w=0.5");
  }
  if (tags.includes("mid_forward")) {
    filters.push("equalizer=f=320:t=q:w=1:g=-3");
  }

  return filters;
}

function getFocusFilters(focus) {
  switch (focus) {
    case "bass":
      return [
        "bass=g=8:f=90:w=0.7",
        "acompressor=threshold=-18dB:ratio=2.2:attack=20:release=140:makeup=2"
      ];
    case "presence":
      return [
        "equalizer=f=3500:t=q:w=1:g=3.5",
        "equalizer=f=6000:t=q:w=1:g=1.5"
      ];
    case "air":
      return ["treble=g=5:f=10000:w=0.6"];
    case "wide":
      return ["stereotools=mlev=1:slev=1.45", "extrastereo=m=2.5"];
    case "punch":
      return [
        "acompressor=threshold=-16dB:ratio=3:attack=6:release=70:makeup=3",
        "equalizer=f=120:t=q:w=1:g=1.5",
        "equalizer=f=3000:t=q:w=1:g=1.5"
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

/**
 * Classification logging:
 * Append a single JSON object per line (NDJSON).
 * This is easy to import into a DB later.
 */
function logClassification(event) {
  const line = JSON.stringify(event) + "\n";
  classificationEvents.push(event);

  // keep memory bounded
  if (classificationEvents.length > 500) classificationEvents.shift();

  try {
    fs.appendFileSync(CLASSIFICATION_LOG_PATH, line);
  } catch {
    // ignore for MVP (Render FS is ephemeral)
  }
}

/* ---------------- ROUTES ---------------- */

app.get("/health", (req, res) => res.json({ ok: true }));

// Optional: quick view of recent events (for you only; lock later)
app.get("/classification/recent", (req, res) => {
  res.json({
    count: classificationEvents.length,
    events: classificationEvents.slice(-50)
  });
});

// Optional: download current NDJSON log (ephemeral but useful)
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

    // Store request on job for later feedback + logging
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

      // Log failed jobs too (very useful for later)
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

/**
 * Feedback endpoint:
 * rating: "satisfied" | "not_satisfied"
 * reason: optional enum (too_bright, too_bassy, not_loud_enough, etc.)
 * notes: optional free text
 * userId: optional (from Base44 auth)
 */
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
  const out = path.join(dir, "output.wav");

  const r = await fetch(opts.inputFileUrl);
  if (!r.ok) throw new Error(`Failed to fetch input file: ${r.status}`);
  fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));

  setJob(jobId, { step: "Decoding & preparing audio..." });
  runFfmpegAll(["-y", "-i", raw, "-ac", "2", "-ar", "48000", wav]);

  // ANALYSIS PASS (tone & dynamics proxy)
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

  // DECISION: build a render plan (this is your "classification result")
  const adaptiveTone = buildAdaptiveTone(bandAnalysis.tags);
  const preGain = bandAnalysis.tags.includes("too_loud") ? ["volume=0.85"] : [];
  const tempoPitch = buildTempoPitch(opts.speedMultiplier, opts.pitchSemitones);
  const focusFilters = getFocusFilters(opts.focus);

  const renderPlan = {
    tags: bandAnalysis.tags,
    actions: {
      preGainApplied: preGain.length > 0,
      adaptiveToneFilters: adaptiveTone,
      focus: opts.focus,
      focusFilters,
      speedMultiplier: opts.speedMultiplier,
      pitchSemitones: opts.pitchSemitones,
      enhancementType: opts.enhancementType,
      masterProfile: opts.masterProfile
    }
  };

  setJob(jobId, { renderPlan });

  // Finishers
  const finalLimiterMix = ["alimiter=limit=0.99:attack=5:release=80"];
  const finalLimiterMaster = ["alimiter=limit=0.98:attack=2:release=50"];

  if (opts.enhancementType === "mix") {
    setJob(jobId, { step: "Building adaptive mix chain..." });

    const mixCore = [
      "highpass=f=30",
      "lowpass=f=18000",
      "acompressor=threshold=-18dB:ratio=2.5:attack=18:release=120:makeup=3",
      "stereotools=mlev=1:slev=1.18"
    ];

    const af = [
      ...preGain,
      ...mixCore,
      ...adaptiveTone,
      ...focusFilters,
      ...tempoPitch,
      ...finalLimiterMix
    ].filter(Boolean).join(",");

    setJob(jobId, { step: "Rendering mix..." });
    runFfmpegAll(["-y", "-i", wav, "-af", af, out]);
  }

  if (opts.enhancementType === "4d") {
    setJob(jobId, { step: "Creating 4D space..." });

    const d4 = [
      "highpass=f=30",
      "stereotools=mlev=1:slev=1.35",
      "apulsator=hz=0.12:amount=0.35",
      "aecho=0.8:0.85:40:0.12"
    ];

    const af = [
      ...preGain,
      ...d4,
      ...adaptiveTone,
      ...focusFilters,
      ...tempoPitch,
      "alimiter=limit=0.98:attack=3:release=60"
    ].filter(Boolean).join(",");

    setJob(jobId, { step: "Rendering 4D output..." });
    runFfmpegAll(["-y", "-i", wav, "-af", af, out]);
  }

  if (opts.enhancementType === "master") {
    setJob(jobId, { step: "Measuring loudness (LUFS/True Peak)..." });

    const t = getMasterTarget(opts.masterProfile);

    const loudnormMeasureOut = runFfmpegAll([
      "-hide_banner",
      "-nostats",
      "-i",
      wav,
      "-af",
      `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:print_format=json`,
      "-f",
      "null",
      "-"
    ]);

    const m = parseLoudnormJson(loudnormMeasureOut);
    if (!m) throw new Error("Loudness analysis failed (loudnorm JSON missing)");

    setJob(jobId, { step: "Applying adaptive mastering..." });

    const masterPre = [
      "highpass=f=25",
      "acompressor=threshold=-20dB:ratio=2:attack=10:release=100:makeup=2"
    ];

    const ln2 =
      `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:` +
      `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
      `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;

    const af = [
      ...preGain,
      ...masterPre,
      ...adaptiveTone,
      ...focusFilters,
      ...tempoPitch,
      ln2,
      ...finalLimiterMaster
    ].filter(Boolean).join(",");

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

    runFfmpegAll(["-y", "-i", wav, "-af", af, out]);
  }

  if (!fs.existsSync(out)) throw new Error("Output missing after render");

  // Log successful classification event (for future ML training)
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
