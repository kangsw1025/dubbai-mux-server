const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const { createReadStream, createWriteStream } = require("fs");
const { unlink, rename } = require("fs/promises");
const { join } = require("path");
const { tmpdir } = require("os");
const crypto = require("crypto");
const ffmpegPath = "ffmpeg";

const app = express();
const port = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.MUX_AUTH_TOKEN;
const SESSION_TTL_MS = 10 * 60 * 1000; // 10분

app.use(express.json({ limit: "1mb" }));

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

async function cleanupFiles(paths) {
  await Promise.allSettled(
    paths.filter(Boolean).map((p) => unlink(p).catch(() => {})),
  );
}

function appendPathToFile(sourcePath, targetPath) {
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(sourcePath);
    const writeStream = createWriteStream(targetPath, { flags: "a" });

    readStream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);

    readStream.pipe(writeStream);
  });
}

function normalizeContainer(container) {
  const value = String(container ?? "").toLowerCase();
  return value === "webm" ? "webm" : "mp4";
}

function detectContainerFromUpload(file) {
  const ext = (file?.originalname?.split(".").pop() ?? "").toLowerCase();
  const mime = String(file?.mimetype ?? "").toLowerCase();
  if (mime.includes("webm") || ext === "webm") return "webm";
  return "mp4";
}

// 세션 저장소: sessionId → { videoPath, videoExt, timer }
const sessions = new Map();
// 클립 세션 저장소: sessionId → { clipPath, container, nextSeq, totalBytes, completed, timer }
const clipSessions = new Map();

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

function deleteClipSession(sessionId, options = {}) {
  const { removeFile = true } = options;
  const session = clipSessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  clipSessions.delete(sessionId);
  if (removeFile) {
    unlink(session.clipPath).catch(() => {});
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /clip-session/init
 * iOS용: 클라이언트 녹화 청크 업로드 세션 시작
 * Body(JSON):
 *   - container: mp4 | webm (optional, default mp4)
 */
app.post("/clip-session/init", (req, res) => {
  if (!checkAuth(req, res)) return;

  const sessionId = crypto.randomUUID();
  const container = normalizeContainer(req.body?.container);
  const clipPath = join(tmpdir(), `clip-session-${sessionId}.${container}`);
  const timer = setTimeout(() => {
    deleteClipSession(sessionId);
  }, SESSION_TTL_MS);

  clipSessions.set(sessionId, {
    clipPath,
    container,
    nextSeq: 0,
    totalBytes: 0,
    completed: false,
    timer,
  });

  res.json({ sessionId });
});

/**
 * POST /clip-session/chunk
 * iOS용: 클라이언트에서 전송한 클립 청크를 순서대로 append
 * Form fields:
 *   - sessionId
 *   - seq
 *   - chunk(file)
 */
app.post(
  "/clip-session/chunk",
  upload.fields([{ name: "chunk" }]),
  async (req, res) => {
    if (!checkAuth(req, res)) return;

    const chunkFile = req.files?.["chunk"]?.[0];
    const sessionId = req.body?.sessionId;
    const seq = Number.parseInt(String(req.body?.seq ?? ""), 10);

    if (!chunkFile || !sessionId || !Number.isFinite(seq) || seq < 0) {
      if (chunkFile?.path) await unlink(chunkFile.path).catch(() => {});
      return res
        .status(400)
        .json({ error: "sessionId, seq, chunk가 필요합니다." });
    }

    const session = clipSessions.get(sessionId);
    if (!session) {
      await unlink(chunkFile.path).catch(() => {});
      return res
        .status(404)
        .json({ error: "클립 세션이 만료되었거나 존재하지 않습니다." });
    }

    if (session.completed) {
      await unlink(chunkFile.path).catch(() => {});
      return res
        .status(409)
        .json({ error: "이미 완료된 클립 세션입니다." });
    }

    if (seq !== session.nextSeq) {
      await unlink(chunkFile.path).catch(() => {});
      return res.status(409).json({
        error: "청크 순서가 올바르지 않습니다.",
        expectedSeq: session.nextSeq,
      });
    }

    try {
      await appendPathToFile(chunkFile.path, session.clipPath);
      session.nextSeq += 1;
      session.totalBytes += chunkFile.size;
      res.json({ ok: true, nextSeq: session.nextSeq });
    } catch (err) {
      console.error("[clip-session/chunk error]", err);
      res.status(500).json({ error: err.message ?? "청크 저장 실패" });
    } finally {
      await unlink(chunkFile.path).catch(() => {});
    }
  },
);

/**
 * POST /clip-session/complete
 * iOS용: 청크 업로드 완료 마킹
 * Body(JSON):
 *   - sessionId
 *   - totalChunks(optional): 클라이언트가 보낸 총 청크 수 검증
 *   - container(optional): 실제 녹화 컨테이너(mp4|webm)
 */
app.post("/clip-session/complete", (req, res) => {
  if (!checkAuth(req, res)) return;

  const sessionId = req.body?.sessionId;
  const totalChunksRaw = req.body?.totalChunks;
  const container = normalizeContainer(req.body?.container);
  const totalChunks =
    totalChunksRaw === undefined
      ? undefined
      : Number.parseInt(String(totalChunksRaw), 10);

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId가 필요합니다." });
  }

  const session = clipSessions.get(sessionId);
  if (!session) {
    return res
      .status(404)
      .json({ error: "클립 세션이 만료되었거나 존재하지 않습니다." });
  }

  if (session.nextSeq === 0) {
    return res.status(400).json({ error: "업로드된 청크가 없습니다." });
  }

  if (
    totalChunks !== undefined &&
    (Number.isNaN(totalChunks) || totalChunks !== session.nextSeq)
  ) {
    return res.status(409).json({
      error: "totalChunks가 서버 청크 수와 일치하지 않습니다.",
      expected: session.nextSeq,
    });
  }

  session.completed = true;
  session.container = container;
  res.json({
    ok: true,
    chunkCount: session.nextSeq,
    totalBytes: session.totalBytes,
    container: session.container,
  });
});

/**
 * POST /clip-session/abort
 * iOS용: 실패 시 업로드 세션 즉시 정리
 * Body(JSON):
 *   - sessionId
 */
app.post("/clip-session/abort", (req, res) => {
  if (!checkAuth(req, res)) return;

  const sessionId = req.body?.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId가 필요합니다." });
  }

  deleteClipSession(sessionId);
  res.json({ ok: true });
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

  // 영상을 세션 경로로 이동 (multer가 이미 tmpdir에 저장함)
  const sessionVideoPath = join(tmpdir(), `session-${sessionId}.${videoExt}`);

  const audioPath = join(tmpdir(), `prepare-audio-${sessionId}.mp3`);

  try {
    // multer 업로드 파일을 세션 경로로 rename
    await rename(videoFile.path, sessionVideoPath);

    const startTime = parseFloat(req.body?.startTime) || 0;
    const endTime = parseFloat(req.body?.endTime);
    const duration =
      Number.isFinite(endTime) && endTime > startTime ? endTime - startTime : 60;

    await runFfmpeg([
      "-ss",
      String(startTime),
      "-i",
      sessionVideoPath,
      "-t",
      String(duration),
      "-vn",
      "-acodec",
      "mp3",
      "-y",
      audioPath,
    ]);

    // 10분 후 세션 자동 만료
    const timer = setTimeout(() => {
      deleteSession(sessionId);
      unlink(audioPath).catch(() => {});
    }, SESSION_TTL_MS);

    sessions.set(sessionId, { videoPath: sessionVideoPath, videoExt, timer });

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
    if (!res.headersSent)
      res.status(500).json({ error: err.message ?? "서버 오류" });
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

    deleteSession(sessionId, { removeFile: false }); // 레이스 방지를 위해 파일은 아래에서 정리
    const { videoPath, videoExt } = session;
    const id = crypto.randomUUID();
    const tempPaths = [audioFile.path, videoPath];

    try {
      const startTime = parseFloat(req.body?.startTime) || 0;
      const endTime = parseFloat(req.body?.endTime);
      const duration =
        Number.isFinite(endTime) && endTime > startTime ? endTime - startTime : 60;

      const isWebm = videoExt === "webm";
      const outputExt = isWebm ? "webm" : "mp4";
      const outputPath = join(tmpdir(), `mux-output-${id}.${outputExt}`);
      tempPaths.push(outputPath);

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
          "-shortest",
          "-y",
          outputPath,
        ]);
      } else {
        await runFfmpeg([
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
          "-shortest",
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
      console.error("[mux-session error]", err);
      await cleanupFiles(tempPaths);
      if (!res.headersSent)
        res.status(500).json({ error: err.message ?? "서버 오류" });
    }
  },
);

/**
 * POST /mux-clip-session
 * iOS용: 클라이언트가 청크 업로드한 클립 영상 + 더빙 오디오를 mux
 * Form fields:
 *   - audio: 더빙 오디오(mp3)
 *   - sessionId: /clip-session/init에서 받은 세션 ID
 */
app.post(
  "/mux-clip-session",
  upload.fields([{ name: "audio" }]),
  async (req, res) => {
    if (!checkAuth(req, res)) return;

    const audioFile = req.files?.["audio"]?.[0];
    const sessionId = req.body?.sessionId;

    if (!audioFile || !sessionId) {
      return res.status(400).json({ error: "audio와 sessionId가 필요합니다." });
    }

    const session = clipSessions.get(sessionId);
    if (!session) {
      await unlink(audioFile.path).catch(() => {});
      return res
        .status(404)
        .json({ error: "클립 세션이 만료되었거나 존재하지 않습니다." });
    }

    if (!session.completed) {
      await unlink(audioFile.path).catch(() => {});
      return res.status(409).json({ error: "클립 업로드가 완료되지 않았습니다." });
    }

    deleteClipSession(sessionId, { removeFile: false });

    const { clipPath, container } = session;
    const id = crypto.randomUUID();
    const outputExt = container === "webm" ? "webm" : "mp4";
    const outputPath = join(tmpdir(), `clip-mux-output-${id}.${outputExt}`);
    const tempPaths = [audioFile.path, clipPath, outputPath];

    try {
      if (container === "webm") {
        await runFfmpeg([
          "-i",
          clipPath,
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
          "-shortest",
          "-y",
          outputPath,
        ]);
      } else {
        try {
          await runFfmpeg([
            "-i",
            clipPath,
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
            "-shortest",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "0",
            "-y",
            outputPath,
          ]);
        } catch {
          // 코덱/컨테이너가 copy 불가한 케이스 대비 재인코딩 fallback
          await runFfmpeg([
            "-i",
            clipPath,
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
            "-shortest",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "0",
            "-y",
            outputPath,
          ]);
        }
      }

      const mimeType = container === "webm" ? "video/webm" : "video/mp4";
      res.set({
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="dubbed.${outputExt}"`,
      });

      res.sendFile(outputPath, { root: "/" }, async (err) => {
        if (err && !res.headersSent) res.status(500).end();
        await cleanupFiles(tempPaths);
      });
    } catch (err) {
      console.error("[mux-clip-session error]", err);
      await cleanupFiles(tempPaths);
      if (!res.headersSent)
        res.status(500).json({ error: err.message ?? "서버 오류" });
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
    const container = detectContainerFromUpload(videoFile);
    const tempPaths = [videoFile.path, audioFile.path];

    try {
      const isWebm = container === "webm";
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
          "-shortest",
          "-y",
          outputPath,
        ]);
      } else {
        try {
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
            "-shortest",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "0",
            "-y",
            outputPath,
          ]);
        } catch {
          // copy 불가 시 재인코딩 fallback
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
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-shortest",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "0",
            "-y",
            outputPath,
          ]);
        }
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
