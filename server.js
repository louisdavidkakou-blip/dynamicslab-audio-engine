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

// MVP store
const jobs = new Map();

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
  // key example: "mean_volume:" or "max_volume:"
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
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function getMasterTarget(profile) {
  // Practical loudness targets
  if (profile === "apple_music") return { I: -16, TP: -1.0, LRA: 11 };
  if (profile === "soundcloud") return { I: -13, TP: -1.0, LRA: 10 };
  if (profile === "spotify") return { I: -14, TP: -1.0, LRA: 10 };
  if (profile === "loud") return { I: -10, TP: -0.8, LRA: 8 };
  return { I: -14, TP: -1.0, LRA: 10 };
}

/**
 * Run a quick energy analysis using filtered volumedetect passes:
 * - low band (<=200 Hz)
 * - mid band (200–8000 Hz approx)
 * - high band (>=8000 Hz)
 * Also detects peak headroom.
 */
function analyzeBands(wavPath) {
  // Helpers: run a volumedetect with a band filter
  const vol = (af) => {
    const out = runFfmpegAll([
      "-hide_banner", "-nostats",
      "-i", wavPath,
      "-af", `${af},volumedetect`,
      "-f", "null", "-"
    ]);
    const mean = parseNumberFrom(out, "mean_volume:");
    const max = parseNumberFrom(out, "max_volume:");
    return { mean, max, raw: out };
  };

  const low = vol("lowpass=f=200");
  const high = vol("highpass=f=8000");
  const full = vol("anull"); // overall

  // Mid-ish: remove sub + remove extreme highs
  const mid = vol("highpass=f=200,lowpass=f=8000");

  // Build a simple profile
  const profile = {
    lowMean: low.mean,
    midMean: mid.mean,
    highMean: high.mean,
    fullMean: full.mean,
    fullMax: full.max
  };

  // Categorize (simple heuristics; we’ll improve later)
  const tags = [];

  // Low end weak: low band much quieter than mid
  if (Number.isFinite(profile.lowMean) && Number.isFinite(profile.midMean)) {
    if ((profile.lowMean - profile.midMean) < -8) tags.push("low_end_weak");
    if ((profile.lowMean - profile.midMean) > 6) tags.push("low_end_heavy");
  }

  // Harsh highs: highs too close to mid or unusually strong
  if (Number.isFinite(profile.highMean) && Number.isFinite(profile.midMean)) {
    if ((profile.highMean - profile.midMean) > -3) tags.push("harsh_highs");
    if ((profile.highMean - profile.midMean) < -14) tags.push("dull_highs");
  }

  // Muddy lowmids: mid loud but low not supporting can imply congestion around 200–400
  if (Number.isFinite(profile.midMean) && Number.isFinite(profile.fullMean)) {
    if ((profile.midMean - profile.fullMean) > 2.5) tags.push("mid_forward");
  }

  // Too loud / clipping risk
  if (Number.isFinite(profile.fullMax) && profile.fullMax > -1.0) tags.push("too_loud");

  // Too quiet
  if (Number.isFinite(profile.fullMean) && profile.fullMean < -22) tags.push("too_quiet");

  return { profile, tags };
}

function buildAdaptiveTone(tags) {
  // Use FFmpeg filters that are audible and safe:
  // bass / treble are shelf-like; equalizer for mud cuts
  const filters = [];

  if (tags.includes("low_end_weak")) {
    filters.push("bass=g=6:f=100:w=0.6");
  }
  if (tags.includes("low_end_heavy")) {
    filters.push("bass=g=-4:f=110:w=0.7");
    filters.push("equalizer=f=250:t=q:w=1:g=-2"); // tighten low-mid
  }
  if (tags.includes("harsh_highs")) {
    filters.push("treble=g=-4:f=9000:w=0.5");
    filters.push("equalizer=f=3500:t=q:w=1:g=-1"); // reduce bite
  }
  if (tags.includes("dull_highs")) {
    filters.push("treble=g=3:f=9000:w=0.5");
  }
  if (tags.includes("mid_forward")) {
    filters.push("equalizer=f=320:t=q:w=1:g=-3"); // mud cut
  }

  return filters;
}

function getFocusFilters(focus) {
  // Make these VERY audible so users feel value.
  // Note: Without stems we can’t isolate drums vs melody perfectly;
  // this is “mix focus” that changes perception.
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
      return [
        "treble=g=5:f=10000:w=0.6"
      ];
    case "wide":
      return [
        // stereotools increases side level; extrastereo makes it very noticeable
        "stereotools=mlev=1:slev=1.45",
        "extrastereo=m=2.5"
      ];
    case "punch":
      return [
        // snappier comp + slight presence bump
        "acompressor=threshold=-16dB:ratio=3:attack=6:release=70:makeup=3",
        "equalizer=f=120:t=q:w=1:g=1.5",
        "equalizer=f=3000:t=q:w=1:g=1.5"
      ];
    default:
      return [];
  }
}

function buildTempoPitch(speedMultiplier, pitchSemitones) {
  // Stabilize and reduce artifacts:
  // decode->48000 already happens; still keep soxr and fltp.
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/enhance", async (req, res) => {
  try {
    const body = req.body || {};
    const inputFileUrl = body.inputFileUrl;
    const enhancementType = body.enhancementType;

    const speedMultiplier = Number(body.speedMultiplier ?? 1.0);

    // NEW default for slowed: less granular
    const pitchSemitones = Number(body.pitchSemitones ?? 0);
    const focus = String(body.focus ?? "none");
    const masterProfile = String(body.masterProfile ?? "spotify"); // spotify|apple_music|soundcloud|loud

    if (!inputFileUrl) return res.status(400).json({ error: "Missing inputFileUrl" });
    if (!["mix", "master", "4d"].includes(enhancementType)) {
      return res.status(400).json({ error: "Invalid enhancementType" });
    }
    if (!(speedMultiplier >= 0.5 && speedMultiplier <= 2.0)) {
      return res.status(400).json({ error: "Invalid speedMultiplier" });
    }

    const jobId = nanoid();
    setJob(jobId, { status: "queued", createdAt: Date.now() });

    processJob(jobId, {
      inputFileUrl,
      enhancementType,
      speedMultiplier,
      pitchSemitones,
      focus,
      masterProfile
    }).catch((e) => {
      setJob(jobId, { status: "failed", error: e.message, failedAt: Date.now() });
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

  // ANALYSIS PASS
  setJob(jobId, { step: "Analyzing tone & dynamics..." });
  const analysis = analyzeBands(wav);

  // Store analysis in job so Base44 can display it
  const summary = analysis.tags.length
    ? `Detected: ${analysis.tags.join(", ")}`
    : "Detected: balanced";

  setJob(jobId, {
    analysis: {
      tags: analysis.tags,
      profile: analysis.profile,
      summary
    }
  });

  // Adaptive tone corrections based on tags
  const adaptiveTone = buildAdaptiveTone(analysis.tags);

  // If too loud (near clipping), pull gain slightly before limiting
  const preGain = analysis.tags.includes("too_loud") ? ["volume=0.85"] : [];
  const tempoPitch = buildTempoPitch(opts.speedMultiplier, opts.pitchSemitones);

  // Strong focus filters
  const focusFilters = getFocusFilters(opts.focus);

  // Common finishing (audible but safe)
  const finalLimiterMix = ["alimiter=limit=0.99:attack=5:release=80"];
  const finalLimiterMaster = ["alimiter=limit=0.98:attack=2:release=50"];

  if (opts.enhancementType === "mix") {
    setJob(jobId, { step: "Building adaptive mix chain..." });

    const mixCore = [
      "highpass=f=30",
      "lowpass=f=18000",
      // light glue compression
      "acompressor=threshold=-18dB:ratio=2.5:attack=18:release=120:makeup=3",
      // stereo enhancement (base)
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

    // Loudnorm measurement (prints JSON to stderr; we capture all)
    const analysisOut = runFfmpegAll([
      "-hide_banner", "-nostats",
      "-i", wav,
      "-af", `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:print_format=json`,
      "-f", "null", "-"
    ]);

    const m = parseLoudnormJson(analysisOut);
    if (!m) throw new Error("Loudness analysis failed (loudnorm JSON missing)");

    setJob(jobId, { step: "Applying adaptive mastering..." });

    // Gentle mastering pre-chain + adaptive tone
    const masterPre = [
      "highpass=f=25",
      "acompressor=threshold=-20dB:ratio=2:attack=10:release=100:makeup=2"
    ];

    // Second pass loudnorm (adaptive loudness)
    const ln = `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:` +
      `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
      `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;

    const af = [
      ...preGain,
      ...masterPre,
      ...adaptiveTone,
      ...focusFilters,
      ...tempoPitch,
      ln,
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

  setJob(jobId, {
    status: "done",
    enhancedFileUrl: `${PUBLIC_BASE_URL}/download/${jobId}`,
    finishedAt: Date.now()
  });
}

app.listen(PORT, () => {
  console.log(`Audio engine running on ${PORT}`);
});
