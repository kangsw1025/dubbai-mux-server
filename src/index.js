const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const { unlink } = require("fs/promises");
const { join } = require("path");
const { tmpdir } = require("os");
const crypto = require("crypto");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const port = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.MUX_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.warn("[warn] MUX_AUTH_TOKEN is not set — server is unprotected");
}

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Disk storage to avoid OOM on large uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, cb) => cb(null, `upload-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const authHeader = req.headers["authorization"] ?? "";
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
    proc.on("error", reject);
  });
}

async function cleanupFiles(paths) {
  await Promise.allSettled(
    paths.filter(Boolean).map((p) => unlink(p).catch(() => {})),
  );
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /extract-audio
 * iOS용: 원본 영상에서 startTime 기준 1분 오디오 추출
 */
app.post(
  "/extract-audio",
  upload.fields([{ name: "video" }]),
  async (req, res) => {
    if (!checkAuth(req, res)) return;

    const videoFile = req.files?.["video"]?.[0];
    if (!videoFile) {
      return res.status(400).json({ error: "video가 필요합니다." });
    }

    const id = crypto.randomUUID();
    const audioPath = join(tmpdir(), `extract-audio-${id}.mp3`);
    const tempPaths = [videoFile.path, audioPath];

    try {
      const startTime = parseFloat(req.body?.startTime) || 0;

      await runFfmpeg([
        "-ss",
        String(startTime),
        "-i",
        videoFile.path,
        "-t",
        "60",
        "-vn",
        "-acodec",
        "mp3",
        "-y",
        audioPath,
      ]);

      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'attachment; filename="extracted.mp3"',
      });

      res.sendFile(audioPath, { root: "/" }, async (err) => {
        if (err && !res.headersSent) res.status(500).end();
        await cleanupFiles(tempPaths);
      });
    } catch (err) {
      console.error("[extract-audio error]", err);
      await cleanupFiles(tempPaths);
      if (!res.headersSent)
        res.status(500).json({ error: err.message ?? "서버 오류" });
    }
  },
);

/**
 * POST /mux
 * video + audio → muxed video
 * Form fields:
 *   - video: 영상 파일 (webm 또는 mp4/mov)
 *   - audio: 더빙 오디오 (mp3)
 *   - startTime: (선택) iOS 경로 — 서버에서 클립할 시작 시간(초)
 */
app.post(
  "/mux",
  upload.fields([{ name: "video" }, { name: "audio" }]),
  async (req, res) => {
    if (!checkAuth(req, res)) return;

    const videoFile = req.files?.["video"]?.[0];
    const audioFile = req.files?.["audio"]?.[0];

    if (!videoFile || !audioFile) {
      return res.status(400).json({ error: "video와 audio가 필요합니다." });
    }

    const id = crypto.randomUUID();
    const videoExt = (
      videoFile.originalname.split(".").pop() ?? "mp4"
    ).toLowerCase();
    const tempPaths = [videoFile.path, audioFile.path];

    try {
      let videoToMux = videoFile.path;

      // iOS 경로: startTime이 있으면 서버에서 클립
      const startTimeStr = req.body?.startTime;
      if (startTimeStr != null) {
        const startTime = parseFloat(startTimeStr) || 0;
        const clippedPath = join(tmpdir(), `mux-clip-${id}.${videoExt}`);
        tempPaths.push(clippedPath);

        await runFfmpeg([
          "-ss",
          String(startTime),
          "-i",
          videoFile.path,
          "-t",
          "60",
          "-c:v",
          "copy",
          "-c:a",
          "copy",
          "-map_metadata",
          "0",
          "-y",
          clippedPath,
        ]);

        videoToMux = clippedPath;
      }

      const isWebm = videoExt === "webm";
      const outputExt = isWebm ? "webm" : "mp4";
      const outputPath = join(tmpdir(), `mux-output-${id}.${outputExt}`);
      tempPaths.push(outputPath);

      if (isWebm) {
        // Android: VP8(webm) + mp3 → webm (libopus)
        await runFfmpeg([
          "-i",
          videoToMux,
          "-i",
          audioFile.path,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          "libopus",
          "-y",
          outputPath,
        ]);
      } else {
        // iOS: mp4/mov + mp3 → mp4 (AAC audio for compatibility)
        await runFfmpeg([
          "-i",
          videoToMux,
          "-i",
          audioFile.path,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-map_metadata",
          "0",
          "-y",
          outputPath,
        ]);
      }

      const mimeType = isWebm ? "video/webm" : "video/mp4";
      res.set({
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="dubbed.${outputExt}"`,
      });

      res.sendFile(outputPath, { root: "/" }, async (err) => {
        if (err && !res.headersSent) res.status(500).end();
        await cleanupFiles(tempPaths);
      });
    } catch (err) {
      console.error("[mux error]", err);
      await cleanupFiles(tempPaths);
      if (!res.headersSent)
        res.status(500).json({ error: err.message ?? "서버 오류" });
    }
  },
);

// Multer error handler
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error("[unhandled error]", err);
  res.status(500).json({ error: "서버 오류" });
});

app.listen(port, () => {
  console.log(`mux server running on port ${port}`);
});
