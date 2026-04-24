const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");

const SUPPORTED_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime"]);

let tasks = {};
let queue = [];
let workerRunning = false;
let initialized = false;

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureAppLayout() {
  ensureDirSync(DATA_DIR);
  ensureDirSync(UPLOAD_DIR);
  ensureDirSync(OUTPUT_DIR);
  if (!fs.existsSync(TASKS_FILE)) {
    fs.writeFileSync(TASKS_FILE, "{}\n", "utf8");
  }
}

function loadTasks() {
  try {
    const raw = fs.readFileSync(TASKS_FILE, "utf8");
    tasks = JSON.parse(raw || "{}");
  } catch {
    tasks = {};
  }
}

async function persistTasks() {
  await fsp.writeFile(TASKS_FILE, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
}

function formatStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}`;
}

function makeOutputName(inputName, mode) {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  })
    .format(new Date())
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(" ", "_");
  const suffix = crypto.randomBytes(2).toString("hex");

  if (mode === "image") {
    return `OpticalWash_${stamp}_${suffix}.jpg`;
  }

  const ext = path.extname(inputName).toLowerCase();
  return `OpticalWash_${stamp}_${suffix}${ext === ".mov" ? ".mov" : ".mp4"}`;
}

function getPublicTask(task) {
  return {
    original_name: task.original_name,
    output_file: task.output_file,
    status: task.status,
    upload_time: task.upload_time,
    error: task.error || "",
    kind: task.kind,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createImageOutput(inputPath, outputPath) {
  const metadata = await sharp(inputPath).metadata();
  const sourceWidth = metadata.width || 1080;
  const sourceHeight = metadata.height || 1920;
  const canvasWidth = 1080;
  const canvasHeight = 1920;

  const background = await sharp(inputPath)
    .resize(canvasWidth, canvasHeight, { fit: "cover" })
    .blur(22)
    .modulate({ brightness: 1.12, saturation: 0.85 })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${canvasWidth}" height="${canvasHeight}">
            <rect width="100%" height="100%" fill="white" opacity="0.16" />
          </svg>`,
        ),
      },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();

  const foregroundWidth = Math.min(canvasWidth - 120, sourceWidth);
  const foregroundHeight = Math.min(canvasHeight - 260, sourceHeight);

  const foreground = await sharp(inputPath)
    .resize(foregroundWidth, foregroundHeight, { fit: "inside", withoutEnlargement: true })
    .modulate({ brightness: 1.08, saturation: 0.96 })
    .sharpen()
    .png()
    .toBuffer();

  const shadowSvg = Buffer.from(
    `<svg width="${canvasWidth}" height="${canvasHeight}">
      <rect x="88" y="168" width="${canvasWidth - 176}" height="${canvasHeight - 336}" rx="40" fill="#000000" opacity="0.10" />
      <rect x="80" y="160" width="${canvasWidth - 160}" height="${canvasHeight - 320}" rx="40" fill="#ffffff" opacity="0.28" />
    </svg>`,
  );

  await sharp(background)
    .composite([
      { input: shadowSvg },
      {
        input: foreground,
        gravity: "center",
      },
    ])
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

async function createVideoOutput(inputPath, outputPath) {
  await sleep(1800);
  await fsp.copyFile(inputPath, outputPath);
}

async function processTask(taskId) {
  const task = tasks[taskId];
  if (!task) {
    return;
  }

  const inputPath = path.join(UPLOAD_DIR, task.stored_name);
  const outputPath = path.join(OUTPUT_DIR, task.output_file);

  try {
    if (task.kind === "image") {
      await createImageOutput(inputPath, outputPath);
    } else {
      await createVideoOutput(inputPath, outputPath);
    }

    task.status = "completed";
    task.error = "";
    await persistTasks();
  } catch (error) {
    task.status = "failed";
    task.error = error instanceof Error ? error.message : "处理失败";
    await persistTasks();
  }
}

async function runWorker() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;
  while (queue.length > 0) {
    const taskId = queue.shift();
    await processTask(taskId);
  }
  workerRunning = false;
}

function enqueueTask(taskId) {
  if (!queue.includes(taskId)) {
    queue.push(taskId);
    void runWorker();
  }
}

function restorePendingTasks() {
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.status === "processing") {
      enqueueTask(taskId);
    }
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, UPLOAD_DIR);
  },
  filename: (_req, file, callback) => {
    const taskId = crypto.randomUUID().replaceAll("-", "");
    const extension = path.extname(file.originalname) || (file.mimetype === "image/jpeg" ? ".jpg" : "");
    callback(null, `input_${taskId}${extension.toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 512 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    if (SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      callback(null, true);
      return;
    }
    callback(new Error("仅支持 mp4 / mov / jpg / png / webp"));
  },
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/tasks", (_req, res) => {
  const sortedEntries = Object.entries(tasks).sort(([, first], [, second]) => {
    return (second.created_at || 0) - (first.created_at || 0);
  });
  const response = Object.fromEntries(sortedEntries.map(([taskId, task]) => [taskId, getPublicTask(task)]));
  res.json(response);
});

app.post("/upload", upload.single("file"), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) {
    res.status(400).json({ error: "请先选择文件" });
    return;
  }

  const taskId = uploadedFile.filename.replace(/^input_/, "").replace(path.extname(uploadedFile.filename), "");
  const kind = VIDEO_MIME_TYPES.has(uploadedFile.mimetype) ? "video" : "image";

  tasks[taskId] = {
    created_at: Date.now(),
    stored_name: uploadedFile.filename,
    original_name: uploadedFile.originalname,
    output_file: makeOutputName(uploadedFile.originalname, kind),
    upload_time: formatStamp(),
    status: "processing",
    error: "",
    kind,
  };

  await persistTasks();
  enqueueTask(taskId);

  res.json({
    message: "上传成功，后台已接管",
    task_id: taskId,
  });
});

app.get("/download/:filename", async (req, res) => {
  const filePath = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    res.download(filePath);
  } catch {
    res.status(404).json({ error: "文件不存在或尚未生成" });
  }
});

app.post("/clear_tasks", async (_req, res) => {
  const folders = [UPLOAD_DIR, OUTPUT_DIR];
  await Promise.all(
    folders.map(async (folder) => {
      const entries = await fsp.readdir(folder);
      await Promise.all(entries.map((entry) => fsp.rm(path.join(folder, entry), { force: true, recursive: true })));
    }),
  );

  tasks = {};
  queue = [];
  await persistTasks();

  res.json({
    status: "success",
    msg: "所有记录及文件已强制清空！",
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(400).json({
    error: error instanceof Error ? error.message : "请求失败",
  });
});

function initializeState() {
  if (initialized) {
    return;
  }
  ensureAppLayout();
  loadTasks();
  restorePendingTasks();
  initialized = true;
}

function startServer(port = PORT) {
  initializeState();
  return app.listen(port, HOST, () => {
    console.log(`Server ready on http://${HOST}:${port}`);
  });
}

initializeState();

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  initializeState,
  paths: {
    DATA_DIR,
    UPLOAD_DIR,
    OUTPUT_DIR,
    TASKS_FILE,
  },
  helpers: {
    createImageOutput,
    makeOutputName,
    formatStamp,
  },
};
