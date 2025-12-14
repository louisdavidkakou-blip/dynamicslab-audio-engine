import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { nanoid } from "nanoid";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" })); // payload is small; audio is fetched via URL

const PORT = process.env.PORT || 10000;

// In-memory jobs (fine for MVP). Later use Redis/DB.
const jobs = new Map();

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/enhance", async (req, res) => {
  try {
    const { inputFileUrl, enhancementType, speedMultiplier } = req.body || {};
    if (!inputFileUrl || !enhancementType || !speedMultiplier) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!["mix", "master", "4d"].includes(enhancementType)) {
      return res.status(400).json({ error: "Invalid enhancementType" });
    }
    const jobId = nanoid();
    jobs.set(jobId, { status: "queued" });

    // Fire-and-forget processing
    processJob(jobId, { inputFileUrl, enhancementType, speedMultiplier }).catch((e) => {
      jobs.set(jobId, { status: "failed", error: String(e?.message || e) });
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
  jobs.set(jobId, { status: "processing" });

  // workspace
  const workdir = `/tmp/${jobId}`;
  fs.mkdirSync(workdir, { recursive: true });

  const inPath = path.join(workdir, "input.wav");
  const outPath = path.join(workdir, "output.wav");

  // download input to file
  const r = await fetch(inputFileUrl);
  if (!r.ok) throw new Error(`Failed to fetch inputFileUrl: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(inPath, buf);

  // Choose a simple, audible FFmpeg chain (MVP)
  // Note: This is not “perfect AI”, but it WILL sound different.
  let af = "";

  if (enhancementType === "mix") {
    af = [
      "highpass=f=30",
      "lowpass=f=18000",
      "equalizer=f=250:t=q:w=1:g=-2",     // reduce low-mid mud
      "equalizer=f=3500:t=q:w=1:g=1.5",   // add presence
      "acompressor=threshold=-18dB:ratio=3:attack=20:release=120:makeup=4",
      "stereotools=mlev=1.0:slev=1.12"    // subtle width
    ].join(",");
  }

  if (enhancementType === "master") {
    af = [
      "highpass=f=25",
      "equalizer=f=120:t=q:w=1:g=1.2",    // low-end weight
      "equalizer=f=4500:t=q:w=1:g=1.0",   // clarity
      "acompressor=threshold=-20dB:ratio=2:attack=10:release=100:makeup=3",
      "alimiter=limit=0.95"
    ].join(",");
  }

  if (enhancementType === "4d") {
    af = [
      "highpass=f=30",
      "stereotools=mlev=1.0:slev=1.25",
      "apulsator=hz=0.12:amount=0.35",    // subtle movement
      "aecho=0.8:0.85:40:0.15",           // light depth
      "alimiter=limit=0.95"
    ].join(",");
  }

  // Apply speed last
  // atempo supports 0.5–2.0
  const speed = Number(speedMultiplier);
  const speedFilter = `atempo=${speed}`;

  const filter = `${af},${speedFilter}`;

  // Convert to wav output (you can later do mp3 too)
  execSync(`ffmpeg -y -i "${inPath}" -af "${filter}" "${outPath}"`, { stdio: "ignore" });

  jobs.set(jobId, { status: "done", enhancedFileUrl: `/download/${jobId}` });

  // Keep file on disk for download route
}

app.get("/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const outPath = `/tmp/${jobId}/output.wav`;
  if (!fs.existsSync(outPath)) return res.status(404).send("Not found");
  res.download(outPath, `enhanced-${jobId}.wav`);
});

app.listen(PORT, () => console.log(`Audio engine running on :${PORT}`));
