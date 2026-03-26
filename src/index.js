const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const { unlink } = require("fs/promises");
const { join } = require("path");
const { tmpdir } = require("os");
const crypto = require("crypto");
const ffmpegPath = "ffmpeg";

const app = express();
const port = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.MUX_AUTH_TOKEN;
const SESSION_TTL_MS = 10 * 60 * 1000; // 10분

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

// Disk storage to avoid OOM
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

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
    });
    proc.on("error", reject);
  });
}

async function probeMedia(path) {
  try {
    const raw = await runFfprobe([
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name:format=duration",
      "-of",
      "json",
      path,
    ]);
    const json = JSON.parse(raw);
    const streams = Array.isArray(json.streams) ? json.streams : [];
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    return {
      videoCodec: video?.codec_name ?? "unknown",
      audioCodec: audio?.codec_name ?? "unknown",
      duration: Number.parseFloat(json?.format?.duration ?? "0") || 0,
    };
  } catch {
    return null;
  }
}

function summarizeFfmpegError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-6).join(" | ");
  if (!tail) return "ffmpeg 처리 실패";
  return tail.length > 1000 ? `${tail.slice(0, 1000)}...` : tail;
}

function isMovInput(videoExt, videoMime = "") {
  return videoExt === "mov" || String(videoMime).includes("quicktime");
}

async function cleanupFiles(paths) {
  await Promise.allSettled(
    paths.filter(Boolean).map((p) => unlink(p).catch(() => {})),
  );
}

// 세션 저장소: sessionId → { videoPath, videoExt, timer }
const sessions = new Map();

function deleteSession(sessionId, options = {}) {
  const { removeFile = true } = options;
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  sessions.delete(sessionId);
  if (removeFile) {
    unlink(session.videoPath).catch(() => {});
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /prepare
 * iOS용: 원본 영상을 한 번만 업로드
 *   1) 영상을 세션으로 보관
 *   2) startTime ~ endTime 기준 오디오 추출 후 반환
 * Form fields:
 *   - video: 원본 영상
 *   - startTime: 시작 시간(초)
 *   - endTime: 종료 시간(초, optional)
 * Response: audio/mpeg (+ X-Session-Id 헤더)
 */
app.post("/prepare", upload.fields([{ name: "video" }]), async (req, res) => {
  if (!checkAuth(req, res)) return;

  const videoFile = req.files?.["video"]?.[0];
  if (!videoFile) {
    return res.status(400).json({ error: "video가 필요합니다." });
  }

  const sessionId = crypto.randomUUID();
  const videoExt = (
    videoFile.originalname.split(".").pop() ?? "mp4"
  ).toLowerCase();
  const videoMime = String(videoFile.mimetype ?? "").toLowerCase();
  const movInput = isMovInput(videoExt, videoMime);

  // 영상을 세션 경로로 이동 (multer가 이미 tmpdir에 저장함)
  const sessionVideoPath = join(tmpdir(), `session-${sessionId}.${videoExt}`);

  const audioPath = join(tmpdir(), `prepare-audio-${sessionId}.mp3`);

  try {
    // multer 업로드 파일을 세션 경로로 rename
    const { rename } = require("fs/promises");
    await rename(videoFile.path, sessionVideoPath);

    const startTime = parseFloat(req.body?.startTime) || 0;
    const endTime = parseFloat(req.body?.endTime);
    const duration =
      Number.isFinite(endTime) && endTime > startTime ? endTime - startTime : 60;

    console.info("[prepare]", {
      sessionId,
      inputExt: videoExt,
      mime: videoMime,
      startTime,
      duration,
    });

    try {
      await runFfmpeg([
        "-ss",
        String(startTime),
        "-t",
        String(duration),
        "-i",
        sessionVideoPath,
        "-vn",
        "-acodec",
        "mp3",
        "-y",
        audioPath,
      ]);
    } catch (primaryErr) {
      if (!movInput) throw primaryErr;

      // MOV 입력은 optional map 재시도로 오디오 추출 호환성 보강
      console.warn("[prepare] mov audio extract primary failed, retrying", {
        sessionId,
        reason: summarizeFfmpegError(primaryErr),
      });
      await runFfmpeg([
        "-ss",
        String(startTime),
        "-t",
        String(duration),
        "-i",
        sessionVideoPath,
        "-map",
        "0:a:0?",
        "-vn",
        "-c:a",
        "mp3",
        "-y",
        audioPath,
      ]);
    }

    // 10분 후 세션 자동 만료
    const timer = setTimeout(() => {
      deleteSession(sessionId);
      unlink(audioPath).catch(() => {});
    }, SESSION_TTL_MS);

    sessions.set(sessionId, {
      videoPath: sessionVideoPath,
      videoExt,
      videoMime,
      timer,
    });

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": 'attachment; filename="extracted.mp3"',
      "X-Session-Id": sessionId,
      "Access-Control-Expose-Headers": "X-Session-Id",
    });

    res.sendFile(audioPath, { root: "/" }, async (err) => {
      if (err && !res.headersSent) res.status(500).end();
      await unlink(audioPath).catch(() => {});
    });
  } catch (err) {
    console.error("[prepare error]", err);
    await cleanupFiles([audioPath, sessionVideoPath]);
    sessions.delete(sessionId);
    if (!res.headersSent) {
      res.status(500).json({
        error: summarizeFfmpegError(err),
      });
    }
  }
});

/**
 * POST /mux-session
 * iOS용: 세션에 보관된 영상 + 더빙 오디오 → mux
 * Form fields:
 *   - audio: 더빙 오디오 (mp3)
 *   - sessionId: /prepare에서 받은 세션 ID
 *   - startTime: 시작 시간(초)
 *   - endTime: 종료 시간(초, optional)
 */
app.post(
  "/mux-session",
  upload.fields([{ name: "audio" }]),
  async (req, res) => {
    if (!checkAuth(req, res)) return;

    const audioFile = req.files?.["audio"]?.[0];
    const sessionId = req.body?.sessionId;

    if (!audioFile || !sessionId) {
      return res.status(400).json({ error: "audio와 sessionId가 필요합니다." });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ error: "세션이 만료되었거나 존재하지 않습니다." });
    }

    // 세션 맵에서는 제거하되, ffmpeg가 읽을 수 있게 파일 삭제는 뒤로 미룸
    deleteSession(sessionId, { removeFile: false });
    const { videoPath, videoExt, videoMime } = session;
    const id = crypto.randomUUID();
    const tempPaths = [audioFile.path, videoPath];

    try {
      const startTime = parseFloat(req.body?.startTime) || 0;
      const endTime = parseFloat(req.body?.endTime);
      const duration =
        Number.isFinite(endTime) && endTime > startTime ? endTime - startTime : 60;

      const isWebm = videoExt === "webm";
      const movInput = isMovInput(videoExt, videoMime);
      const outputExt = isWebm ? "webm" : "mp4";
      const outputPath = join(tmpdir(), `mux-output-${id}.${outputExt}`);
      tempPaths.push(outputPath);

      const videoMeta = await probeMedia(videoPath);
      const audioMeta = await probeMedia(audioFile.path);
      console.info("[mux-session]", {
        sessionId,
        inputExt: videoExt,
        mime: videoMime ?? "",
        startTime,
        duration,
        videoCodec: videoMeta?.videoCodec ?? "unknown",
        audioCodec: audioMeta?.audioCodec ?? "unknown",
        inputDuration: videoMeta?.duration ?? 0,
      });

      if (isWebm) {
        await runFfmpeg([
          "-ss",
          String(startTime),
          "-t",
          String(duration),
          "-i",
          videoPath,
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
          // 출력 길이를 선택 구간(duration)으로 고정
          "-t",
          String(duration),
          "-y",
          outputPath,
        ]);
      } else {
        const mp4Args = [
          "-ss",
          String(startTime),
          "-t",
          String(duration),
          "-noautorotate",
          "-i",
          videoPath,
          "-i",
          audioFile.path,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          // 출력 길이를 선택 구간(duration)으로 고정
          "-t",
          String(duration),
          "-movflags",
          "+faststart",
          "-map_metadata",
          "0",
          "-y",
          outputPath,
        ];

        if (movInput) {
          // iPhone MOV 호환성 + 서버 안정성: 720p/30fps로 다운스케일
          const mapIndex = mp4Args.indexOf("-map_metadata");
          mp4Args.splice(
            mapIndex,
            0,
            "-af",
            "apad",
            "-vf",
            "scale=-2:720,format=yuv420p,fps=30",
            "-pix_fmt",
            "yuv420p",
          );
        }

        await runFfmpeg(mp4Args);
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
      console.error("[mux-session error]", err);
      await cleanupFiles(tempPaths);
      if (!res.headersSent)
        res.status(500).json({ error: summarizeFfmpegError(err) });
    }
  },
);

/**
 * POST /mux
 * Android용: 클라이언트에서 이미 클립된 영상 + 더빙 오디오 → mux
 * Form fields:
 *   - video: 클립된 영상 (webm)
 *   - audio: 더빙 오디오 (mp3)
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
      videoFile.originalname.split(".").pop() ?? "webm"
    ).toLowerCase();
    const tempPaths = [videoFile.path, audioFile.path];

    try {
      const isWebm = videoExt === "webm";
      const outputExt = isWebm ? "webm" : "mp4";
      const outputPath = join(tmpdir(), `mux-output-${id}.${outputExt}`);
      tempPaths.push(outputPath);

      if (isWebm) {
        await runFfmpeg([
          "-i",
          videoFile.path,
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
        await runFfmpeg([
          "-i",
          videoFile.path,
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
