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

// IMPORTANT: set this in Render ENV so download links are clickable anywhere
// e.g. PUBLIC_BASE_URL = https://dynamicslab-audio-engine.onrender.com
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// In-memory jobs (fine for MVP testing). For production use DB/Redis.
const jobs = new Map();

app.get("/health", (req, res) => res.json({ ok: true }));

// Useful for diagnosing outbound internet/DNS from Render
app.get("/net-test", async (req, res) => {
  try {
    const r = await fetch("https://example.com", { method: "GET" });
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/enhance", async (req, res) => {
  try {
    const { inputFileUrl, enhancementType } = req.body || {};
    const speedMultiplier = Number(req.body?.speedMultiplier ?? 1.0);

    // Validation
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
      return res.status(400).json({
        error: "Invalid speedMultiplier (must be between 0.5 and 2.0)",
      });
    }

    const jobId = nanoid();
    jobs.set(jobId, { status: "queued", createdAt: Date.now() });

    // Fire-and-forget
    processJob(jobId, { inputFileUrl, enhancementType, speedMultiplier }).catch((e) => {
      jobs.set(jobId, {
        status: "failed",
        error: String(e?.message || e),
        failedAt: Date.now(),
      });
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

async function processJob(jobId, { inputFileUrl, enhancementType, speedMultiplier }) {
  jobs.set(jobId, { status: "processing", step: "Downloading input…" });

  // workspace
  const workdir = `/tmp/${jobId}`;
  fs.mkdirSync(workdir, { recursive: true });

  // We keep original extension irrelevant; we decode into wav internally
  const inPath = path.join(workdir, "input");
  const outPath = path.join(workdir, "output.wav");

  // Download input
  const r = await fetch(inputFileUrl);
  if (!r.ok) throw new Error(`Failed to fetch inputFileUrl: HTTP ${r.status}`);

  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf?.length) throw new Error("Downloaded input file is empty");

  fs.writeFileSync(inPath, buf);

  // Build FFmpeg filter chain
  jobs.set(jobId, { status: "processing", step: "Applying enhancement…" });

  let af = "";

  if (enhancementType === "mix") {
    af = [
      "highpass=f=30",
      "lowpass=f=18000",
      "equalizer=f=250:t=q:w=1:g=-2",
      "equalizer=f=3500:t=q:w=1:g=1.5",
      "acompressor=threshold=-18dB:ratio=3:attack=20:release=120:makeup=4",
      "stereotools=mlev=1.0:slev=1.12",
    ].join(",");
  }

  if (enhancementType === "master") {
    af = [
      "highpass=f=25",
      "equalizer=f=120:t=q:w=1:g=1.2",
      "equalizer=f=4500:t=q:w=1:g=1.0",
      "acompressor=threshold=-20dB:ratio=2:attack=10:release=100:makeup=3",
      "alimiter=limit=0.95",
    ].join(",");
  }

  if (enhancementType === "4d") {
    af = [
      "highpass=f=30",
      "stereotools=mlev=1.0:slev=1.25",
      "apulsator=hz=0.12:amount=0.35",
      "aecho=0.8:0.85:40:0.15",
      "alimiter=limit=0.95",
    ].join(",");
  }

  // Speed last
  jobs.set(jobId, { status: "processing", step: `Time-stretching to ${speedMultiplier}x…` });
  const speedFilter = `atempo=${speedMultiplier}`;

  const filter = af ? `${af},${speedFilter}` : speedFilter;

  // Run FFmpeg
  // IMPORTANT: don’t hide errors while debugging; capture stderr
  jobs.set(jobId, { status: "processing", step: "Rendering audio…" });

  try {
    execSync(`ffmpeg -y -i "${inPath}" -af "${filter}" "${outPath}"`, {
      stdio: "pipe", // capture errors
    });
  } catch (e) {
    const msg = e?.stderr ? e.stderr.toString() : String(e?.message || e);
    throw new Error(`FFmpeg failed: ${msg}`);
  }

  if (!fs.existsSync(outPath)) throw new Error("Output file missing after render");
  const stat = fs.statSync(outPath);
  if (!stat.size) throw new Error("Output file is empty");

  // Mark as done with ABSOLUTE download URL
  jobs.set(jobId, {
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

