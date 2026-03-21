const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const { writeFile, readFile, unlink } = require("fs/promises");
const { join } = require("path");
const { tmpdir } = require("os");

const app = express();
const port = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.MUX_AUTH_TOKEN;

// 멀티파트 업로드: 메모리 저장 (파일 크기 제한 500MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
    proc.on("error", reject);
  });
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /mux
 * Form fields:
 *   - video: 영상 파일 (webm 또는 mp4/mov)
 *   - audio: 더빙 오디오 (mp3)
 *   - startTime: (선택) iOS 경로 — 서버에서 클립할 시작 시간(초)
 * Header:
 *   - Authorization: Bearer <MUX_AUTH_TOKEN>
 */
app.post(
  "/mux",
  upload.fields([{ name: "video" }, { name: "audio" }]),
  async (req, res) => {
    // 인증
    if (AUTH_TOKEN) {
      const authHeader = req.headers["authorization"] ?? "";
      if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const videoFile = req.files?.["video"]?.[0];
    const audioFile = req.files?.["audio"]?.[0];

    if (!videoFile || !audioFile) {
      return res.status(400).json({ error: "video와 audio가 필요합니다." });
    }

    const ts = Date.now();
    const videoExt = (
      videoFile.originalname.split(".").pop() ?? "mp4"
    ).toLowerCase();
    const videoPath = join(tmpdir(), `mux-video-${ts}.${videoExt}`);
    const audioPath = join(tmpdir(), `mux-audio-${ts}.mp3`);
    const tempPaths = [videoPath, audioPath];

    try {
      await Promise.all([
        writeFile(videoPath, videoFile.buffer),
        writeFile(audioPath, audioFile.buffer),
      ]);

      let videoToMux = videoPath;

      // iOS 경로: startTime이 있으면 서버에서 클립
      const startTimeStr = req.body?.startTime;
      if (startTimeStr != null) {
        const startTime = parseFloat(startTimeStr) || 0;
        const clippedExt = videoExt;
        const clippedPath = join(tmpdir(), `mux-clip-${ts}.${clippedExt}`);
        tempPaths.push(clippedPath);

        await runFfmpeg([
          "-ss",
          String(startTime),
          "-i",
          videoPath,
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

      // mux
      const isWebm = videoExt === "webm";
      const outputExt = isWebm ? "webm" : "mp4";
      const outputPath = join(tmpdir(), `mux-output-${ts}.${outputExt}`);
      tempPaths.push(outputPath);

      if (isWebm) {
        // Android: VP8(webm) + mp3 → webm (libopus)
        await runFfmpeg([
          "-i",
          videoToMux,
          "-i",
          audioPath,
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
        // iOS: mp4/mov + mp3 → mp4
        await runFfmpeg([
          "-i",
          videoToMux,
          "-i",
          audioPath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-map_metadata",
          "0",
          "-y",
          outputPath,
        ]);
      }

      const outputBuffer = await readFile(outputPath);
      const mimeType = isWebm ? "video/webm" : "video/mp4";

      res.set({
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="dubbed.${outputExt}"`,
        "Content-Length": String(outputBuffer.length),
      });
      res.send(outputBuffer);
    } catch (err) {
      console.error("[mux error]", err);
      res.status(500).json({ error: err.message ?? "서버 오류" });
    } finally {
      await Promise.allSettled(tempPaths.map((p) => unlink(p).catch(() => {})));
    }
  },
);

app.listen(port, () => {
  console.log(`mux server running on port ${port}`);
});
