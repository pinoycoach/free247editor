#!/usr/bin/env node
// One-time setup for Fable: checks tools, installs the engine's packages into fable/,
// renders a test video into outbox/, and reports what is ready. Safe to re-run.
//
//   node setup.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const engine = join(root, 'fable');
const legacyKit = join(root, 'kit');

const win = process.platform === 'win32';
const step = (msg) => console.log(`\n== ${msg}`);
const run = (cmd, args, cwd = root, quiet = false) => {
  const opts = { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' };
  // npm and npx are .cmd shims on Windows and need a shell; every argument here is a fixed constant.
  const r = win && (cmd === 'npm' || cmd === 'npx')
    ? spawnSync([cmd, ...args].join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
  return !r.error && r.status === 0;
};
const fail = (msg) => { console.error(`\nSETUP STOPPED: ${msg}`); process.exit(1); };

step('Checking tools');
const missing = [];
if (Number(process.versions.node.split('.')[0]) < 22) missing.push('Node.js 22 or newer');
for (const [tool, flag, label] of [['git', '--version', 'Git'], ['ffmpeg', '-version', 'FFmpeg'], ['ffprobe', '-version', 'FFmpeg']]) {
  if (!run(tool, [flag], root, true)) missing.push(label);
}
if (missing.length) {
  const hint = win
    ? 'winget install OpenJS.NodeJS.LTS Git.Git Gyan.FFmpeg   (then open a new terminal)'
    : process.platform === 'darwin' ? 'brew install node git ffmpeg' : 'Use your package manager: node (22+), git, ffmpeg';
  fail(`missing ${[...new Set(missing)].join(', ')}.\nInstall with: ${hint}`);
}
console.log(`Node ${process.versions.node}, Git, FFmpeg: OK`);

step('Installing engine packages into fable/ (npm ci)');
if (!existsSync(join(engine, 'package.json'))) fail('fable/ is missing. Clone the whole repository again.');
if (!existsSync(join(engine, 'node_modules', 'hyperframes'))) {
  // An older install (the kit/ folder) already has the same packages; reuse them instead of downloading.
  if (existsSync(join(legacyKit, 'node_modules', 'hyperframes'))) {
    console.log('Reusing packages from the older kit/ folder.');
    cpSync(join(legacyKit, 'node_modules'), join(engine, 'node_modules'), { recursive: true });
  } else if (!run('npm', ['ci', '--no-audit', '--no-fund'], engine)) {
    fail('npm ci failed in fable/. Read the error above.');
  }
}

// Edits made with the older kit/ engine move over so nothing is lost.
if (existsSync(join(legacyKit, 'video-projects'))) {
  mkdirSync(join(engine, 'video-projects'), { recursive: true });
  let moved = 0;
  for (const name of readdirSync(join(legacyKit, 'video-projects'))) {
    const from = join(legacyKit, 'video-projects', name), to = join(engine, 'video-projects', name);
    if (existsSync(join(from, 'assets', 'raw.mp4')) && !existsSync(to)) { renameSync(from, to); moved++; }
  }
  if (moved) console.log(`Moved ${moved} earlier edit${moved > 1 ? 's' : ''} from kit/video-projects to fable/video-projects.`);
}

step('Rendering a test video');
const demo = join(engine, 'video-projects', 'demo');
const testVideo = join(root, 'outbox', 'setup-test.mp4');
for (const dir of ['inbox', 'outbox', 'my-sounds']) mkdirSync(join(root, dir), { recursive: true });
if (!existsSync(demo)) run('npm', ['run', 'demo', '--silent'], engine);
const rendered = join(demo, 'renders', 'demo.mp4');
if (!existsSync(rendered) && !run('npx', ['hyperframes', 'render', '--quality', 'draft', '--output', 'renders/demo.mp4'], demo)) {
  fail('the test render failed. Run `npx hyperframes doctor` inside fable/video-projects/demo to see why (usually Chrome).');
}
copyFileSync(rendered, testVideo);
console.log(`Test video: ${testVideo}`);

step('Transcription');
if (!existsSync(join(root, '.env'))) copyFileSync(join(root, '.env.example'), join(root, '.env'));
try { process.loadEnvFile(join(root, '.env')); } catch {}
const groq = Boolean(process.env.GROQ_API_KEY);
const localWhisper = Boolean(run('python', ['-c', 'import faster_whisper'], root, true));
console.log(`Groq key in .env: ${groq ? 'yes' : 'no'}`);
console.log(`Local faster-whisper: ${localWhisper ? 'yes' : 'no'}`);
const opencv = Boolean(run('python', ['-c', 'import cv2'], root, true));
console.log(`Face tracking (OpenCV): ${opencv ? 'yes' : 'no. Optional, keeps text off the face: pip install opencv-python-headless'}`);

if (existsSync(legacyKit) && !readdirSync(join(legacyKit, 'video-projects'), { withFileTypes: true }).some((d) => d.isDirectory() && existsSync(join(legacyKit, 'video-projects', d.name, 'assets', 'raw.mp4')))) {
  console.log('\nThe old kit/ folder is no longer used. Delete it when you like; everything you made is in fable/video-projects.');
}

console.log(`\nSETUP COMPLETE${groq || localWhisper ? '' : ' (transcription not configured yet)'}`);
console.log(`Drop raw videos in ${resolve(root, 'inbox')} and say "edit this", or run: node fable.mjs watch`);
