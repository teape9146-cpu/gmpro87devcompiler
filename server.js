const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsP = require('fs/promises');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });
const jobs = new Map();
let cliPath = null;
const installedBoards = new Set();

const BOARDS = {
  esp8266: { fqbn: 'esp8266:esp8266:generic', url: 'https://arduino.esp8266.com/stable/package_esp8266com_index.json', pkg: 'esp8266:esp8266', name: 'ESP8266 Standard' },
  esp32:   { fqbn: 'esp32:esp32:esp32', url: 'https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json', pkg: 'esp32:esp32', name: 'ESP32 Standard' },
  'esp8266-deauther': { fqbn: 'SpacehuhnTech:esp8266:esp8266_deauther_1m', url: 'https://raw.githubusercontent.com/SpacehuhnTech/arduino/main/package_spacehuhn_index.json', pkg: 'SpacehuhnTech:esp8266', name: 'ESP8266 Deauther SDK' },
  'esp32-deauther':   { fqbn: 'esp32:esp32:esp32', url: 'https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json', pkg: 'esp32:esp32', name: 'ESP32 Deauther SDK' }
};

async function getCLI() {
  if (cliPath) return cliPath;
  const candidates = ['/home/user/.local/bin/arduino-cli', '/usr/local/bin/arduino-cli', 'arduino-cli'];
  for (const c of candidates) {
    try { await execAsync(c + ' version', { timeout: 8000 }); cliPath = c; return c; } catch {}
  }
  // Install
  const dir = path.join(os.homedir(), '.local', 'bin');
  await fsP.mkdir(dir, { recursive: true });
  await execAsync('curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=' + dir + ' sh', { shell: '/bin/bash', timeout: 180000 });
  cliPath = path.join(dir, 'arduino-cli');
  return cliPath;
}

async function setupBoard(cli, boardId, log) {
  if (installedBoards.has(boardId)) return;
  const b = BOARDS[boardId];
  log('[setup] Board: ' + b.name);
  try { await execAsync(cli + ' config add board_manager.additional_urls "' + b.url + '"', { timeout: 15000 }); } catch {}
  log('[setup] Updating board index...');
  await execAsync(cli + ' core update-index', { timeout: 120000 });
  try {
    const { stdout } = await execAsync(cli + ' core list', { timeout: 15000 });
    if (stdout.includes(b.pkg.replace(':', ' '))) { installedBoards.add(boardId); log('[setup] Board already installed'); return; }
  } catch {}
  log('[setup] Installing board package (first time may take a few minutes)...');
  await execAsync(cli + ' core install "' + b.pkg + '"', { timeout: 600000, maxBuffer: 100*1024*1024 });
  installedBoards.add(boardId);
  log('[setup] Board installed');
}

async function findIno(dir) {
  try {
    const ents = await fsP.readdir(dir, { withFileTypes: true });
    for (const e of ents) { if (e.name.endsWith('.ino')) return path.join(dir, e.name); }
    for (const e of ents) { if (e.isDirectory()) { const r = await findIno(path.join(dir, e.name)); if (r) return r; } }
  } catch {}
  return null;
}

function getMissingLibs(out) {
  const libs = [], re = /fatal error:\s*([^\s/:]+)\.h:\s*No such file/gi;
  let m; while ((m = re.exec(out)) !== null) { if (!libs.includes(m[1])) libs.push(m[1]); }
  return libs;
}

async function fixLib(cli, name, log) {
  log('[auto-fix] Searching: ' + name);
  try {
    const { stdout } = await execAsync(cli + ' lib search "' + name + '" --format json', { timeout: 30000 });
    const r = JSON.parse(stdout);
    if (r.libraries?.length > 0) {
      const lib = r.libraries[0].name;
      log('[auto-fix] Installing: ' + lib);
      await execAsync(cli + ' lib install "' + lib + '"', { timeout: 120000 });
      log('[auto-fix] Installed: ' + lib);
      return true;
    }
  } catch {}
  log('[auto-fix] Not found: ' + name);
  return false;
}

async function runCompile(job, zipPath) {
  job.status = 'running';
  const log = msg => job.logs.push(msg);
  const work = path.join(os.tmpdir(), 'gmpro-' + job.id);
  try {
    log('GMpro87devcompiler ESP Compiler');
    log('Board: ' + BOARDS[job.board].name);
    log('');
    log('[1/5] Initializing Arduino CLI...');
    const cli = await getCLI();
    const { stdout: ver } = await execAsync(cli + ' version', { timeout: 10000 });
    log('[1/5] ' + ver.split('\n')[0]);
    try { await execAsync(cli + ' config init', { timeout: 15000 }); } catch {}

    log('[2/5] Extracting ZIP...');
    await fsP.mkdir(work, { recursive: true });
    const unzipper = require('unzipper');
    await new Promise((res, rej) => {
      fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: work })).on('close', res).on('error', rej);
    });
    const ino = await findIno(work);
    if (!ino) throw new Error('No .ino file found in ZIP');
    log('[2/5] Found: ' + path.basename(ino));

    log('[3/5] Setting up board...');
    await setupBoard(cli, job.board, log);

    const outDir = path.join(work, 'out');
    await fsP.mkdir(outDir, { recursive: true });
    const b = BOARDS[job.board];
    let done = false;

    for (let i = 1; i <= 5 && !done; i++) {
      log('[4/5] Attempt ' + i + '/5...');
      try {
        const { stdout, stderr } = await execAsync(
          cli + ' compile --fqbn "' + b.fqbn + '" "' + path.dirname(ino) + '" --output-dir "' + outDir + '"',
          { timeout: 300000, maxBuffer: 100*1024*1024 }
        );
        (stdout+'\n'+stderr).split('\n').filter(l=>l.trim()&&l.length<300).forEach(l=>log(l.trim()));
        done = true;
      } catch (e) {
        const out = e.stderr || e.stdout || e.message || '';
        out.split('\n').filter(l=>l.includes('error:')||l.includes('Error:')).slice(0,10).forEach(l=>log(l.trim()));
        const libs = getMissingLibs(out);
        if (libs.length && i < 5) {
          log('[auto-fix] Found ' + libs.length + ' missing lib(s)');
          let fixed = false;
          for (const l of libs) { if (await fixLib(cli, l, log)) fixed = true; }
          if (fixed) { log('[auto-fix] Retrying...'); continue; }
        }
        throw new Error('Compilation failed: ' + (out.split('\n').find(l=>l.includes('error:'))||e.message||'').replace(/^.*?error:/i,'').trim());
      }
    }

    log('[5/5] Finding binary...');
    const files = await fsP.readdir(outDir);
    const bin = files.find(f => f.endsWith('.bin'));
    if (!bin) throw new Error('No .bin found in output');
    const binPath = path.join(outDir, bin);
    const stat = await fsP.stat(binPath);
    log('[5/5] Binary: ' + bin + ' (' + (stat.size/1024).toFixed(1) + ' KB)');
    log('');
    log('COMPILATION COMPLETE!');
    log(bin + ' is ready to flash.');
    job.binPath = binPath;
    job.status = 'success';
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    log('FAILED: ' + e.message);
  } finally {
    fsP.unlink(zipPath).catch(()=>{});
  }
}

// Routes
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/compile', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const board = req.body.board;
  if (!BOARDS[board]) return res.status(400).json({ error: 'Invalid board' });
  const id = Date.now() + '-' + Math.random().toString(36).slice(2,8);
  const job = { id, status: 'queued', logs: [], board, binPath: null, error: null };
  jobs.set(id, job);
  runCompile(job, req.file.path).catch(() => {});
  res.json({ jobId: id, status: 'queued' });
});

app.get('/compile/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ jobId: job.id, status: job.status, logs: job.logs, downloadUrl: job.status === 'success' ? '/compile/' + job.id + '/download' : undefined, error: job.error });
});

app.get('/compile/:id/download', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'success' || !job.binPath) return res.status(404).json({ error: 'Not available' });
  const buf = await fsP.readFile(job.binPath);
  res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(job.binPath) + '"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(buf);
});

app.listen(PORT, () => console.log('GMpro87devcompiler server running on port ' + PORT));