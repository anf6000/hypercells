// hypercells evolve bridge
//
// Usage:   cd evolve && npm install && node bridge.mjs [--port 8787] [--model provider/id] [--thinking medium]
// Then open http://localhost:8787/ (serves hypercells-evolve.html) and switch "evolve" on in the panel.
//
// Serves the top-level *.html pages of the repo and a small JSON API for the page:
//   GET  /api/status        bridge + model info
//   POST /api/telemetry     latest params / rule / glsl / health / screenshot from the page
//   POST /api/evolve        runs one Pi agent step on the latest telemetry, returns a proposal
//   POST /api/verdict       the page's keep / roll-back decision (history.jsonl, versions/)
//   GET  /api/versions      accepted shader versions;  GET /api/versions/:n  one version
// The agent edits the live shader file evolve/behavior.glsl through read_shader / edit_shader / write_shader /
// submit_shader (plus submit_params, skip). Every accepted shader is kept as evolve/versions/NNNN.glsl and every
// proposed one (kept or rolled back) as evolve/candidates/<id>.glsl. It has no bash, edit or
// write, so it cannot touch the filesystem. Model and credentials come from your Pi config.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAgentSession, SessionManager, DefaultResourceLoader, ModelRuntime, getAgentDir, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERSIONS = path.join(HERE, 'versions');
const SESSIONS = path.join(HERE, 'sessions');
const SHOTS = path.join(HERE, 'shots');
const CANDIDATES = path.join(HERE, 'candidates');   // every proposed shader, kept or not
const HISTORY = path.join(HERE, 'history.jsonl');
const STATE = path.join(HERE, 'state.json');

function arg(name, def){
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = parseInt(arg('port', '8787'), 10);
const MODEL_ARG = arg('model', '');
const THINKING = arg('thinking', '');
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const PHYS_KEYS = ['sensor_gain', 'sensor_angle', 'sensor_distance', 'global_force_mult', 'drag', 'strafe_power',
                   'axial_force', 'lateral_force', 'mutation_scale', 'hazard_rate', 'trail_persistence', 'trail_diffusion'];

for (const d of [VERSIONS, SESSIONS, SHOTS, CANDIDATES]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
const pad = n => String(n).padStart(4, '0');
function readJson(p, def){ try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function listVersions(){
  return fs.readdirSync(VERSIONS).filter(f => /^\d{4}\.glsl$/.test(f)).map(f => parseInt(f, 10)).sort((a, b) => a - b)
    .map(n => ({ n, ...readJson(path.join(VERSIONS, pad(n) + '.json'), {}) }));
}
function versionInfo(){
  const versions = listVersions();
  const st = readJson(STATE, {});
  const current = versions.some(v => v.n === st.current) ? st.current : (versions.length ? versions[versions.length - 1].n : 0);
  return { versions, current };
}
function syncShaderFile(){
  const f = path.join(VERSIONS, pad(versionInfo().current) + '.glsl');
  if (fs.existsSync(f)) fs.writeFileSync(SHADER_FILE, fs.readFileSync(f, 'utf8'));
}
function setCurrent(n){ fs.writeFileSync(STATE, JSON.stringify({ current: n })); }
function appendHistory(rec){ fs.appendFileSync(HISTORY, JSON.stringify(rec) + '\n'); }
function recentHistory(n){
  try {
    return fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).slice(-n).map(l => JSON.parse(l));
  } catch { return []; }
}
function saveShot(name, b64){
  if (!b64) return;
  try {
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(b64, 'base64'));
    const files = fs.readdirSync(SHOTS).map(f => ({ f, t: fs.statSync(path.join(SHOTS, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const x of files.slice(0, Math.max(0, files.length - 100))) fs.unlinkSync(path.join(SHOTS, x.f));
  } catch (e){ console.warn('shot not saved:', e.message); }
}
const hashOf = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// ---------------------------------------------------------------------------
// Pi agent
// ---------------------------------------------------------------------------
const systemPrompt = fs.readFileSync(path.join(HERE, 'system.md'), 'utf8');
const SHADER_FILE = path.join(HERE, 'behavior.glsl');   // the live shader: the agent edits this file
let baseGlsl = '';           // the page's current shader at the start of the step
let pending = null;          // proposal captured by the tools during one step
let sessionP = null;

const num = (d) => Type.Number({ description: d });
const paramsSchema = Type.Object(Object.fromEntries(PHYS_KEYS.map(k => [k, Type.Optional(num(k))])), { description: 'physics parameters to change' });

const tools = [
  defineTool({
    name: 'submit_params',
    label: 'Submit params',
    description: 'Propose new physics parameters and/or a new 80-float rule. The page glides to them and its health monitor keeps or rolls them back.',
    parameters: Type.Object({
      params: Type.Optional(paramsSchema),
      rule: Type.Optional(Type.Array(Type.Number(), { description: 'exactly 80 numbers in [-8, 8]' })),
      rationale: Type.String({ description: 'one or two sentences: what you change and why' }),
    }),
    async execute(_id, a){
      pending = pending || {};
      if (a.params && Object.keys(a.params).length) pending.params = a.params;
      if (Array.isArray(a.rule)){
        if (a.rule.length !== 80) return { content: [{ type: 'text', text: 'rule must contain exactly 80 numbers; it was ignored' }], details: {} };
        pending.rule = a.rule;
      }
      pending.rationale = a.rationale;
      return { content: [{ type: 'text', text: 'recorded; the page will try it' }], details: {} };
    },
  }),
  defineTool({
    name: 'read_shader',
    label: 'Read shader',
    description: 'Read the shader file (behavior.glsl) you are editing: the page\'s current GLSL behaviour function.',
    parameters: Type.Object({}),
    async execute(){
      return { content: [{ type: 'text', text: fs.readFileSync(SHADER_FILE, 'utf8') }], details: {} };
    },
  }),
  defineTool({
    name: 'edit_shader',
    label: 'Edit shader',
    description: 'Replace exact text in behavior.glsl. old_text must match the file exactly (whitespace included) and be unique unless replace_all is set. Call submit_shader when the edits are done.',
    parameters: Type.Object({
      old_text: Type.String({ description: 'exact text to find' }),
      new_text: Type.String({ description: 'replacement text' }),
      replace_all: Type.Optional(Type.Boolean({ description: 'replace every occurrence' })),
    }),
    async execute(_id, a){
      const cur = fs.readFileSync(SHADER_FILE, 'utf8');
      if (!a.old_text) return { content: [{ type: 'text', text: 'error: old_text is empty' }], details: {} };
      const n = cur.split(a.old_text).length - 1;
      if (n === 0) return { content: [{ type: 'text', text: 'error: old_text not found; read_shader to see the file' }], details: {} };
      if (n > 1 && !a.replace_all) return { content: [{ type: 'text', text: 'error: old_text matches ' + n + ' places; add context or set replace_all' }], details: {} };
      fs.writeFileSync(SHADER_FILE, cur.split(a.old_text).join(a.new_text));
      return { content: [{ type: 'text', text: 'edited (' + n + ' replacement' + (n > 1 ? 's' : '') + ')' }], details: {} };
    },
  }),
  defineTool({
    name: 'write_shader',
    label: 'Write shader',
    description: 'Replace the whole of behavior.glsl. Prefer edit_shader for incremental changes.',
    parameters: Type.Object({ glsl: Type.String({ description: 'complete file content' }) }),
    async execute(_id, a){
      fs.writeFileSync(SHADER_FILE, a.glsl);
      return { content: [{ type: 'text', text: 'written (' + a.glsl.length + ' bytes)' }], details: {} };
    },
  }),
  defineTool({
    name: 'submit_shader',
    label: 'Submit shader',
    description: 'Send the current content of behavior.glsl to the page as a candidate. The page blends it in and keeps or rolls it back; a rolled-back candidate is restored in the file.',
    parameters: Type.Object({
      rationale: Type.String({ description: 'one or two sentences: what you changed and why' }),
    }),
    async execute(_id, a){
      const cur = fs.readFileSync(SHADER_FILE, 'utf8');
      if (cur === baseGlsl) return { content: [{ type: 'text', text: 'error: behavior.glsl is unchanged; edit it first' }], details: {} };
      pending = pending || {};
      pending.glsl = cur;
      pending.rationale = pending.rationale ? pending.rationale + ' | ' + a.rationale : a.rationale;
      return { content: [{ type: 'text', text: 'recorded; the page will compile and try it' }], details: {} };
    },
  }),
  defineTool({
    name: 'skip',
    label: 'Skip',
    description: 'Change nothing this time and keep watching.',
    parameters: Type.Object({ rationale: Type.String({ description: 'why nothing is the right move now' }) }),
    async execute(_id, a){
      pending = pending || {};
      pending.skip = true;
      pending.rationale = a.rationale;
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  }),
];
const TOOL_NAMES = tools.map(t => t.name);

async function getSession(){
  if (sessionP) return sessionP;
  sessionP = (async () => {
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: HERE, agentDir,
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
      noExtensions: false, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    });
    await loader.reload();
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: HERE, agentDir,
      ...(THINKING ? { thinkingLevel: THINKING } : {}),
      tools: TOOL_NAMES,
      customTools: tools,
      resourceLoader: loader,
      sessionManager: SessionManager.continueRecent(HERE, SESSIONS),
    });
    try { await session.bindExtensions({}); } catch (e){ console.warn('extension binding failed:', e.message); }
    if (MODEL_ARG){
      const [prov, ...rest] = MODEL_ARG.split('/');
      const model = session.modelRuntime.getModel(prov, rest.join('/'));
      if (!model){ session.dispose(); throw new Error('model not found in Pi config: ' + MODEL_ARG); }
      await session.setModel(model);
    } else if (!session.model || session.model.id === 'unknown'){
      const avail = await session.modelRuntime.getAvailable();
      if (!avail.length){ session.dispose(); throw new Error('no usable model in Pi: log in with pi (/login) or pass --model'); }
      await session.setModel(avail[0]);
    } else if (modelFallbackMessage) console.log('note:', modelFallbackMessage);
    const active = session.getActiveToolNames();
    const extra = active.filter(n => !TOOL_NAMES.includes(n));
    if (extra.length){ session.dispose(); throw new Error('refusing to run with extra tools enabled: ' + extra.join(', ')); }
    console.log('agent ready; model', session.model ? session.model.provider + '/' + session.model.id : '(none)', '; tools', active.join(', '));
    return session;
  })();
  sessionP.catch(() => { sessionP = null; });
  return sessionP;
}

const r3 = x => typeof x === 'number' ? Math.round(x * 1000) / 1000 : x;
function buildPrompt(t, req){
  const verdicts = recentHistory(8).map(h =>
    '- ' + new Date(h.ts).toISOString().slice(11, 19) + ' ' + h.kind + ' ' + (h.accepted ? 'KEPT' : 'ROLLED BACK') +
    ' (' + (h.reason || '') + ') :: ' + (h.rationale || '').slice(0, 200)).join('\n') || '(none yet)';
  const h = t.health || {};
  const params = Object.fromEntries(PHYS_KEYS.map(k => [k, r3(t.params && t.params[k])]));
  return [
    'Evolution step. Look at the screenshot and the numbers, then call submit_params, edit the shader + submit_shader, and/or skip.',
    '',
    '## Current parameters',
    JSON.stringify(params),
    '',
    '## Current rule (80 floats, 10 centers x [freq4, amp4])',
    JSON.stringify((t.rule || []).map(r3)),
    '',
    '## Current shader: behavior.glsl (version ' + (t.version ?? 0) + ')',
    'The file is already loaded in your workspace. Use read_shader / edit_shader / write_shader, then submit_shader.',
    '',
    '## Health',
    'fizz ratio ' + r3(h.ratio) + ' (fizzy above 0.55), mean field speed ' + r3(h.mean) + ' vs reference ' + r3(h.ref) +
      ' (dead below 12% of reference), good for ' + r3(h.goodSec) + ' s, bad ' + r3(h.badSec) + ' s, ' + r3(h.fps) + ' fps, cohorts ' + t.cohorts,
    '',
    '## Locked parameters (ignored if you change them)',
    (req.locks && req.locks.length ? req.locks.join(', ') : 'none'),
    '',
    '## Shader edits this step',
    req.allowShader ? 'allowed (but keep them rare and incremental)' : 'NOT allowed: do not call submit_shader',
    '',
    '## Recent verdicts (oldest first)',
    verdicts,
    ...(process.env.EVOLVE_HINT ? ['', '## Extra instruction from the operator', process.env.EVOLVE_HINT] : []),
  ].join('\n');
}

let evolveBusy = false;
let latest = null;
const proposals = new Map();

async function evolveStep(req){
  if (evolveBusy) throw Object.assign(new Error('an evolve step is already running'), { status: 409 });
  const t = latest;
  if (!t || Date.now() - t.ts > 120000) throw Object.assign(new Error('no fresh telemetry from the page'), { status: 409 });
  evolveBusy = true;
  const timer = { id: null };
  try {
    const session = await getSession();
    pending = null;
    baseGlsl = t.glsl || fs.readFileSync(path.join(VERSIONS, pad(versionInfo().current) + '.glsl'), 'utf8');
    fs.writeFileSync(SHADER_FILE, baseGlsl);
    const text = buildPrompt(t, req);
    const opts = {};
    const canSee = !session.model || !session.model.input || session.model.input.includes('image');
    if (t.png && canSee) opts.images = [{ type: 'image', data: t.png, mimeType: 'image/png' }];
    timer.id = setTimeout(() => { session.abort().catch(() => {}); }, STEP_TIMEOUT_MS);
    await session.prompt(text, opts);
    const p = pending || {};
    pending = null;
    if (!p.glsl && fs.readFileSync(SHADER_FILE, 'utf8') !== baseGlsl) fs.writeFileSync(SHADER_FILE, baseGlsl);   // unsubmitted edits are dropped
    const id = 'p' + Date.now().toString(36);
    const out = { id, rationale: p.rationale || (session.getLastAssistantText() || '').slice(0, 300) || 'no response' };
    if (!p.skip){
      if (p.params) out.params = p.params;
      if (p.rule) out.rule = p.rule;
      if (p.glsl && req.allowShader) out.glsl = p.glsl;
    }
    out.kind = out.glsl && (out.params || out.rule) ? 'params+shader' : out.glsl ? 'shader' : (out.params || out.rule) ? 'params' : 'skip';
    proposals.set(id, { ...out, ts: Date.now() });
    if (out.glsl){
      fs.writeFileSync(path.join(CANDIDATES, id + '.glsl'), out.glsl);
      fs.writeFileSync(path.join(CANDIDATES, id + '.json'), JSON.stringify({ ts: Date.now(), id, rationale: out.rationale, outcome: 'pending', base: t.version ?? 0 }));
    } else if (p.glsl && !req.allowShader) out.rationale += ' (shader edit ignored: not allowed this step)';
    for (const k of [...proposals.keys()].slice(0, Math.max(0, proposals.size - 20))) proposals.delete(k);
    if (out.kind === 'skip') appendHistory({ ts: Date.now(), id, kind: 'skip', accepted: true, reason: 'skip', rationale: out.rationale });
    return out;
  } finally {
    clearTimeout(timer.id);
    evolveBusy = false;
  }
}

function handleVerdict(v){
  const stored = proposals.get(v.id) || {};
  const rec = { ts: Date.now(), id: v.id, kind: v.kind || stored.kind || 'unknown', accepted: !!v.accepted,
                reason: v.reason || '', rationale: v.rationale || stored.rationale || '', health: v.health || null };
  if (v.params) rec.params = v.params;
  const glsl = typeof v.revert === 'number' ? null : (stored.glsl || v.glsl || null);
  if (glsl) rec.glsl_hash = hashOf(glsl);
  let version;
  if (typeof v.revert === 'number'){
    if (v.accepted && fs.existsSync(path.join(VERSIONS, pad(v.revert) + '.glsl'))){ setCurrent(v.revert); version = v.revert; rec.version = v.revert; rec.reason = 'revert to v' + v.revert; }
  } else if (v.accepted && glsl){
    const n = (listVersions().pop() || { n: 0 }).n + 1;
    fs.writeFileSync(path.join(VERSIONS, pad(n) + '.glsl'), glsl);
    fs.writeFileSync(path.join(VERSIONS, pad(n) + '.json'), JSON.stringify({ ts: Date.now(), id: v.id, rationale: rec.rationale }));
    setCurrent(n); version = n; rec.version = n;
  }
  if (glsl){
    const meta = path.join(CANDIDATES, v.id + '.json');
    fs.writeFileSync(meta, JSON.stringify({ ...readJson(meta, {}), outcome: v.accepted ? 'accepted' : 'rejected', reason: rec.reason, version }));
    if (!fs.existsSync(path.join(CANDIDATES, v.id + '.glsl'))) fs.writeFileSync(path.join(CANDIDATES, v.id + '.glsl'), glsl);
  }
  syncShaderFile();
  appendHistory(rec);
  saveShot(v.id + '-after', v.png);
  const info = versionInfo();
  return { ok: true, version, versions: info.versions };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function send(res, code, body, type){
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 12 * 1024 * 1024){ reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e){ reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const hostOk = h => !!h && new RegExp('^(localhost|127\\.0\\.0\\.1|\\[::1\\]):' + PORT + '$').test(h);
const originOk = o => !o || new RegExp('^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):' + PORT + '$').test(o);

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')){
      if (req.method === 'GET' && p === '/api/status'){
        const model = sessionP ? await sessionP.then(s => s.model && s.model.id !== 'unknown' ? s.model.provider + '/' + s.model.id : null, () => null) : (MODEL_ARG || null);
        return send(res, 200, { ok: true, model, busy: evolveBusy, current: versionInfo().current });
      }
      if (req.method === 'GET' && p === '/api/versions') return send(res, 200, versionInfo());
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/api\/versions\/(\d+)$/))){
        const n = parseInt(m[1], 10), f = path.join(VERSIONS, pad(n) + '.glsl');
        if (!fs.existsSync(f)) return send(res, 404, { error: 'no such version' });
        return send(res, 200, { n, glsl: fs.readFileSync(f, 'utf8'), ...readJson(path.join(VERSIONS, pad(n) + '.json'), {}) });
      }
      if (req.method === 'POST' && p === '/api/telemetry'){
        const b = await readBody(req);
        if (!b || typeof b.params !== 'object') return send(res, 400, { error: 'params missing' });
        latest = b;
        if (b.png) saveShot('latest', b.png);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/evolve'){
        const b = await readBody(req);
        const out = await evolveStep({ allowShader: !!b.allowShader, locks: Array.isArray(b.locks) ? b.locks.map(String) : [] });
        console.log(new Date().toISOString().slice(11, 19), 'proposal', out.id, out.kind, '-', out.rationale.slice(0, 100));
        return send(res, 200, out);
      }
      if (req.method === 'POST' && p === '/api/verdict'){
        const b = await readBody(req);
        if (!b || typeof b.id !== 'string') return send(res, 400, { error: 'id missing' });
        const out = handleVerdict(b);
        console.log(new Date().toISOString().slice(11, 19), 'verdict ', b.id, b.accepted ? 'KEPT' : 'ROLLED BACK', '-', (b.reason || '').slice(0, 100));
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET'){
      const name = p === '/' ? '/hypercells-evolve.html' : p;
      if (/^\/[\w.-]+\.html$/.test(name)){
        const f = path.join(ROOT, name.slice(1));
        if (fs.existsSync(f)) return send(res, 200, await fsp.readFile(f), 'text/html; charset=utf-8');
      }
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e){
    console.warn('request failed:', req.method, req.url, e.message);
    send(res, e.status || 500, { error: e.message });
  }
});

syncShaderFile();
server.listen(PORT, '127.0.0.1', () => {
  console.log('hypercells evolve bridge: http://localhost:' + PORT + '/hypercells-evolve.html');
  getSession().catch(e => console.warn('agent not ready yet (' + e.message + '); it will be retried on the first evolve step'));
});
process.on('SIGINT', () => process.exit(0));







