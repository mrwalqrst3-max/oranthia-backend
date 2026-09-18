'use strict';

/*
 * أترايثيا (Oranthia) — عالـم الأساطير — لعبة خادم مستقلة (Stateless Architecture)
 * ============================================================================
 * بُنيت على البنية المثبتة نفسها (المعركة 100%): لا منطق لعبة ولا حالة في الذاكرة.
 * كل بيانات اللاعب تُخزَّن في database.json بكتابات ذرّية.
 * السيرفر يعالج: GET, PUT, PATCH, DELETE لواجهة REST متوافقة مع Firebase.
 * أوامر الإدارة تُعالَج فوراً وتُحفَظ في database.json.
 *
 * الطبقة الجديدة — العالم:
 *   - الخرائط نصية بصيغة Last-Fight (platform/staircase/zone/sign/door/music/...)
 *     وتُقرأ من مجلد worlds/ (لا حاجة لتضمينها في الملف السحابي).
 *   - الحضور داخل العالم server-authoritative: حركة "move" تُحدّث موضع اللاعب
 *     عند السيرفر وليس محلياً فقط، تماماً مثل move_to في النظام المرجعي.
 *   - بوابة الدخول: لا يمكن دخول عالم أترايثيا إلا عند المستوى 25 (يفرضها السيرفر).
 *
 * مبادئ أساسية:
 * - NO in-memory caching for player data
 * - Atomic file writes (temp + fsync + rename)
 * - Forced saves every 30 seconds
 * - Graceful shutdown flush on SIGTERM/SIGINT
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'database.json');
const TEMP_FILE = path.join(__dirname, 'database.json.tmp');
const BACKUP_FILE = path.join(__dirname, 'database.json.bak');
const WORLDS_DIR = path.join(__dirname, 'worlds');
const MAX_BODY = 4 * 1024 * 1024;

const SERVER_PORT = process.env.PORT || 3000;
const DB_URL = process.env.DB_URL || 'https://oranthia-backend.onrender.com';

/* بقية حصن: بوابة عالم أترايثيا الافتراضية. */
const WORLD_GATE_LEVEL = parseInt(process.env.WORLD_GATE_LEVEL || '25', 10);
const WORLD_PRESENCE_TTL = 90 * 1000; // سكون اللاعب داخل الخريطة قبل اعتباره غير متصل
const WORLD_CHAT_CAP = 200;

let saveQueue = Promise.resolve();
let saveTimer = null;
let isShuttingDown = false;

/* ============================ DATABASE LOADING ============================ */

function loadDatabase() {
  const candidates = [DATA_FILE, BACKUP_FILE];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw || !raw.trim()) continue;
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        console.log(`[DB] Loaded from ${file} (${Object.keys(data).length} top-level keys)`);
        return data;
      }
    } catch (e) {
      console.error('[DB] Failed to read ' + file + ': ' + e.message);
    }
  }
  console.log('[DB] No existing database found, starting fresh');
  return {};
}

let db = loadDatabase();
restoreFromRecoveries();

/* ============================ ATOMIC WRITE ============================ */

function writeAtomic(snapshot) {
  return new Promise((resolve, reject) => {
    const tmp = TEMP_FILE + '.' + process.pid;
    const stream = fs.createWriteStream(tmp, { flags: 'w' });
    let finished = false;
    const fail = (err) => {
      if (!finished) { finished = true; reject(err); }
    };
    stream.on('error', fail);
    stream.on('finish', () => {
      fs.fsync(stream.fd, (fsErr) => {
        if (fsErr) return fail(fsErr);
        stream.close(() => {
          try { fs.copyFileSync(DATA_FILE, BACKUP_FILE); } catch (e) {}
          fs.rename(tmp, DATA_FILE, (renErr) => {
            if (renErr) return fail(renErr);
            fs.open(DATA_FILE, 'r+', (oErr, fd) => {
              if (oErr) return resolve();
              fs.fsync(fd, (fsyncErr) => { fs.close(fd, () => { if (fsyncErr) return fail(fsyncErr); resolve(); }); });
            });
          });
        });
      });
    });
    stream.end(snapshot, 'utf8');
  });
}

function persistNow() {
  if (isShuttingDown) return Promise.resolve();
  const snapshot = JSON.stringify(db, null, 0);
  saveQueue = saveQueue.then(() => writeAtomic(snapshot));
  return saveQueue;
}

function scheduleSave() {
  if (isShuttingDown) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistNow(); }, 150);
}

async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await persistNow();
}

/* ============================ PATH HELPERS ============================ */

function splitPath(rawPath) {
  let p = (rawPath || '').split('?')[0];
  if (p.endsWith('.json')) p = p.slice(0, -5);
  if (p.startsWith('/')) p = p.slice(1);
  if (!p) return [];
  return p.split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } }).filter((s) => s.length > 0);
}

function getAt(segs) {
  let cur = db;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function setAt(segs, value) {
  if (segs.length === 0) { db = value && typeof value === 'object' ? value : {}; scheduleSave(); return; }
  let cur = db;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] === null || typeof cur[s] !== 'object' || Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  const last = segs[segs.length - 1];
  if (value === null) delete cur[last]; else cur[last] = value;
  scheduleSave();
}

function delAt(segs) {
  if (segs.length === 0) { db = {}; scheduleSave(); return; }
  let cur = db;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    if (!Object.prototype.hasOwnProperty.call(cur, segs[i])) return;
    cur = cur[segs[i]];
  }
  if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, segs[segs.length - 1])) {
    delete cur[segs[segs.length - 1]];
    scheduleSave();
  }
}

function mergeAt(segs, value) {
  const cur = getAt(segs);
  const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  const merged = Object.assign({}, base, value);
  setAt(segs, merged);
  return merged;
}

/* ===================== GLOBAL-STATE RECOVERY (Render-safe) =====================
 * نفس آلية الاسترجاع المثبتة: أي جهاز لاعب يحمل صورة `_server_backup`
 * تُنقى وتُحفظ تحت recovery/<username>، وتُملأ منها أي مفاتيح عامة مفقودة.
 */
const RECOVERABLE_GLOBAL_KEYS = ['tribes_system', 'medals', 'world_boss', 'shops', 'announcements', 'welcome_messages'];

function objectSize(v) {
  if (v === null || v === undefined) return 0;
  try {
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'object') return Object.keys(v).length;
  } catch (e) {}
  return 1;
}

function handlePlayerBackup(username, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!Object.prototype.hasOwnProperty.call(value, '_server_backup')) return value;
  let bak = value._server_backup;
  if (typeof bak === 'string') { try { bak = JSON.parse(bak); } catch (e) { bak = null; } }
  value = Object.assign({}, value);
  delete value._server_backup;
  if (bak && typeof bak === 'object' && !Array.isArray(bak)) {
    if (bak.data && typeof bak.data === 'object') bak = bak.data;
    db.recovery = db.recovery || {};
    db.recovery[String(username)] = {
      ts: Math.floor(Date.now() / 1000),
      data: bak
    };
    const recKeys = Object.keys(db.recovery);
    if (recKeys.length > 400) {
      recKeys.sort((a, b) => (db.recovery[a].ts || 0) - (db.recovery[b].ts || 0));
      for (let i = 0; i < recKeys.length - 400; i++) delete db.recovery[recKeys[i]];
    }
    scheduleSave();
  }
  return value;
}

function restoreFromRecoveries() {
  try {
    const recs = db.recovery ? Object.values(db.recovery) : [];
    if (!recs.length) return;
    for (const key of RECOVERABLE_GLOBAL_KEYS) {
      const cur = db[key];
      if (cur && objectSize(cur) > 0) continue;
      let best = null;
      for (const r of recs) {
        if (!r || !r.data || !Object.prototype.hasOwnProperty.call(r.data, key)) continue;
        const v = r.data[key];
        if (!v) continue;
        const score = objectSize(v) * (r.ts ? 1 : 0);
        if (!best || score > best.score) best = { v, score };
      }
      if (best && best.v) {
        db[key] = best.v;
        console.log('[RECOVERY] Restored missing "' + key + '" from player backups (' + best.score + ' entries)');
        scheduleSave();
      }
    }
  } catch (e) {
    console.error('[RECOVERY] restoreFromRecoveries error: ' + (e && e.message) + ' — ' + e);
  }
}

function applyQuery(node, search) {
  const orderBy = (search.get('orderBy') || '').replace(/"/g, '');
  const equalToRaw = search.get('equalTo');
  const equalTo = equalToRaw == null ? undefined : equalToRaw.replace(/"/g, '');
  const shallow = search.get('shallow') === 'true';
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return (shallow || equalTo !== undefined) ? {} : node;
  if (shallow) { const out = {}; for (const k of Object.keys(node)) out[k] = true; return out; }
  if (orderBy) {
    const out = {};
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (child === null || typeof child !== 'object') continue;
      const val = orderBy === '$key' ? k : child[orderBy];
      if (equalTo === undefined || val === equalTo) out[k] = child;
    }
    return out;
  }
  if (equalTo !== undefined) {
    const out = {};
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (child === null || typeof child !== 'object') continue;
      if (child.name === equalTo) out[k] = child;
    }
    return out;
  }
  return node;
}

/* ============================ ADMIN COMMANDS ============================ */

function enqueueCommand(target, type, fields) {
  db.admin_commands = db.admin_commands || {};
  db.admin_commands[target] = db.admin_commands[target] || {};
  const entries = db.admin_commands[target];
  let max = 0;
  for (const k of Object.keys(entries)) { const n = parseInt(k, 10); if (!isNaN(n) && n > max) max = n; }
  const seq = max + 1;
  const cmd = Object.assign({ type, seq, ts: Math.floor(Date.now() / 1000) }, fields);
  entries[String(seq)] = cmd;
  scheduleSave();
  return cmd;
}

function adminUpdatePlayer(targetUsername, updates) {
  const userPath = 'players/' + encodeURIComponent(targetUsername);
  const segs = splitPath(userPath);
  const current = getAt(segs);
  if (!current) {
    return { success: false, error: 'Player not found' };
  }
  const merged = Object.assign({}, current, updates);
  setAt(segs, merged);
  persistNow();
  enqueueCommand(targetUsername, 'sync_data', { data: merged });
  return { success: true, player: merged };
}

function adminDeleteTribe(targetClan) {
  const tribePath = 'tribes_system/' + encodeURIComponent(targetClan);
  const segs = splitPath(tribePath);
  const tribe = getAt(segs);
  if (!tribe || typeof tribe !== 'object') {
    return { success: false, error: 'Tribe not found' };
  }
  const members = tribe.members && typeof tribe.members === 'object' && !Array.isArray(tribe.members)
    ? tribe.members : {};
  const now = Math.floor(Date.now() / 1000);
  for (const id of Object.keys(members)) {
    try {
      const pSegs = splitPath('players/' + encodeURIComponent(id));
      const playerRec = getAt(pSegs);
      if (playerRec && typeof playerRec === 'object') {
        playerRec.clan = 'لا يوجد';
        const inbox = Array.isArray(playerRec.inbox) ? playerRec.inbox : [];
        inbox.push({ type: 'tribe_deleted', tribe_name: targetClan, ts: now });
        playerRec.inbox = inbox;
      }
    } catch (e) { /* skip member */ }
  }
  delAt(segs);
  persistNow();
  return { success: true, kicked: Object.keys(members).length };
}

function adminUpdateTribe(targetClan, updates) {
  const tribePath = 'tribes_system/' + encodeURIComponent(targetClan);
  const segs = splitPath(tribePath);
  const current = getAt(segs);
  if (!current) {
    return { success: false, error: 'Tribe not found' };
  }
  const merged = Object.assign({}, current, updates);
  setAt(segs, merged);
  persistNow();
  return { success: true, tribe: merged };
}

/* ============================ WORLD LAYER (أترايثيا) ============================
 * الخرائط نصية بصيغة Last-Fight وتُقرأ من worlds/<name>.map
 *  movete: move_to → server-authoritative positions (مثل النظام المرجعي).
 *  الدخول: world/enter لا يسمح إلا لمن وصل المستوى 25 (WORLD_GATE_LEVEL).
 */

function safeMapName(name) {
  return String(name || '').replace(/[^A-Za-z0-9_\-\u0600-\u06FF]/g, '').slice(0, 60);
}

function listWorldMaps() {
  try {
    if (!fs.existsSync(WORLDS_DIR)) return [];
    return fs.readdirSync(WORLDS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.map'))
      .map((f) => f.slice(0, -4));
  } catch (e) { return []; }
}

function loadMapText(name) {
  const safe = safeMapName(name);
  if (!safe) return null;
  const file = path.join(WORLDS_DIR, safe + '.map');
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return String(raw || '');
  } catch (e) { return null; }
}

function prunePresence() {
  if (!db.world_presence || typeof db.world_presence !== 'object') return;
  const now = Date.now();
  for (const u of Object.keys(db.world_presence)) {
    const p = db.world_presence[u];
    if (!p || (now - (p.alive_ts || 0)) > WORLD_PRESENCE_TTL) {
      delete db.world_presence[u];
    }
  }
}

function worldOnline(map) {
  prunePresence();
  const online = [];
  const target = safeMapName(map);
  if (db.world_presence && typeof db.world_presence === 'object') {
    for (const u of Object.keys(db.world_presence)) {
      const p = db.world_presence[u];
      if (!p) continue;
      if (target && p.map !== target) continue;
      online.push({ user: u, map: p.map, x: p.x, y: p.y, z: p.z, ts: p.alive_ts || 0 });
    }
  }
  online.sort((a, b) => b.ts - a.ts);
  return online;
}

function playerRecord(username) {
  const segs = splitPath('players/' + encodeURIComponent(username));
  return getAt(segs);
}

function worldEnter(username, mapName) {
  const rec = playerRecord(username);
  if (!rec) return { success: false, error: 'اللاعب غير موجود' };
  const level = Number(rec.level || 1);
  if (level < WORLD_GATE_LEVEL) {
    return {
      success: false,
      locked: true,
      required: WORLD_GATE_LEVEL,
      level: level,
      error: 'بوابة أترايثيا مغلقة. يجب أن تصل إلى المستوى ' + WORLD_GATE_LEVEL + ' أولاً.'
    };
  }
  const safe = safeMapName(mapName);
  const mapText = loadMapText(safe);
  if (!mapText) return { success: false, error: 'الخريطة غير موجودة' };
  db.world_presence = db.world_presence || {};
  const now = Date.now();
  const prev = db.world_presence[String(username)];
  db.world_presence[String(username)] = {
    map: safe,
    x: 2, y: 2, z: 5,
    entered_ts: now,
    alive_ts: now
  };
  scheduleSave();
  addServerLog({ t: Math.floor(Date.now() / 1000), ts: new Date().toISOString(), method: 'WORLD', path: 'world/enter', user: username, detail: 'دخل عالم أترايثيا — الخريطة: ' + safe });
  return { success: true, map: safe, mapdata: mapText, level: level, online: worldOnline(safe), prev: prev ? 'ok' : undefined };
}

function worldMove(username, mapName, x, y, z) {
  db.world_presence = db.world_presence || {};
  const p = db.world_presence[String(username)];
  if (!p) return { success: false, locked: true, error: 'يجب الدخول إلى العالم أولاً' };
  const safe = safeMapName(mapName);
  if (safe && p.map !== safe) p.map = safe;
  p.x = Number(x || 0); p.y = Number(y || 0); p.z = Number(z || 5);
  p.alive_ts = Date.now();
  scheduleSave();
  return { success: true, online: worldOnline(safe || p.map) };
}

function worldChat(username, mapName, msg) {
  db.world_chat = db.world_chat || {};
  const safe = safeMapName(mapName) || 'main';
  db.world_chat[safe] = db.world_chat[safe] || [];
  const text = String(msg || '').slice(0, 300);
  if (!text.trim()) return { success: false, error: 'الرسالة فارغة' };
  db.world_chat[safe].push({ user: username, text: text, ts: Math.floor(Date.now() / 1000) });
  if (db.world_chat[safe].length > WORLD_CHAT_CAP) {
    db.world_chat[safe] = db.world_chat[safe].slice(-WORLD_CHAT_CAP);
  }
  scheduleSave();
  return { success: true, messages: db.world_chat[safe].slice(-30) };
}

/* ============================ SERVER LOGS ============================ */

function addServerLog(entry) {
  try {
    db.server_logs = Array.isArray(db.server_logs) ? db.server_logs : [];
    db.server_logs.push(entry);
    if (db.server_logs.length > 3000) db.server_logs = db.server_logs.slice(-3000);
    scheduleSave();
  } catch (e) { /* never crash on logging */ }
}

const FIELD_LABELS = { name:'الاسم', gold:'الذهب', crystals:'الكريستال', diamonds:'الألماس', exp:'الخبرة', level:'المستوى', max_exp:'الحد الأقصى للخبرة', points:'نقاط التطوير', hp:'الطاقة', maxHp:'أقصى طاقة', last_online:'آخر ظهور', bank_gold:'بنك الذهب', stats:'الإحصائيات', inventory:'الحقيبة', equipped:'المعدات المجهزة', desc:'الوصف', effect:'التأثير', rarity:'الندرة', price:'السعر', category:'الفئة', clan:'القبيلة', location:'الموقع' };

function reqLog(method, p, user, detail) {
  return {
    t: Math.floor(Date.now() / 1000),
    ts: new Date().toISOString(),
    method: method,
    path: p,
    user: user || '',
    detail: detail || ''
  };
}

function summarizeBody(raw, pathPart) {
  if (!raw) return '';
  let s = String(raw);
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const path = String(pathPart || '');
      let detail = '';
      if (path === 'players' || path.indexOf('players/') === 0) {
        const keys = Object.keys(o);
        const parts = [];
        for (const k of keys) {
          if (k === 'username') continue;
          if (k === '_server_backup') continue;
          let v = o[k];
          if (v === null || v === undefined) v = '';
          if (Array.isArray(v)) v = '[' + v.length + ' عنصر]';
          else if (typeof v === 'object') v = '{' + Object.keys(v).length + ' حقول}';
          const lbl = FIELD_LABELS[k] || k;
          parts.push(lbl + ': ' + String(v).slice(0, 40));
          if (parts.length >= 5) break;
        }
        if (parts.length) detail = 'تحديث بيانات اللاعب (' + keys.length + ' حقلاً): ' + parts.join('، ') + (keys.length > 5 ? ' (+' + (keys.length - 5) + ')' : '');
      } else {
        if (o.msg || o.message || o.text) detail = 'الرسالة: ' + String(o.msg || o.message || o.text);
        if (o.event) detail = (detail ? detail + ' | ' : '') + 'الحدث: ' + String(o.event);
        if (o.name && !o.msg && path.indexOf('players') !== 0) detail = (detail ? detail + ' | ' : '') + 'الاسم: ' + String(o.name);
        if (o.reason) detail = (detail ? detail + ' | ' : '') + 'السبب: ' + String(o.reason);
      }
      if (detail) return detail.slice(0, 200);
    }
  } catch (e) {}
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}

function extractUserFromBody(raw) {
  if (!raw) return '';
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      if (typeof o.username === 'string' && o.username) return o.username;
      if (typeof o.user === 'string' && o.user) return o.user;
      if (typeof o.player === 'string' && o.player) return o.player;
      if (typeof o.from === 'string' && o.from) return o.from;
      if (typeof o.sender === 'string' && o.sender) return o.sender;
    }
  } catch (e) {}
  return '';
}

function isLikelyInternalIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (!isNaN(second) && second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('100.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (!isNaN(second) && second >= 64 && second <= 127) return true;
  }
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  if (ip === 'unknown' || ip === 'null') return true;
  return false;
}

function adminBanDevice(ip, reason) {
  if (isLikelyInternalIp(ip)) {
    return { success: false, error: 'Refusing to ban an internal/shared IP.' };
  }
  const banPath = 'device_bans/' + encodeURIComponent(ip);
  const segs = splitPath(banPath);
  const banRecord = {
    ip: ip,
    reason: reason || 'Admin ban',
    banned_at: Math.floor(Date.now() / 1000),
    banned_by: 'admin'
  };
  setAt(segs, banRecord);
  persistNow();
  return { success: true, ban: banRecord };
}

function adminUnbanDevice(ip) {
  const banPath = 'device_bans/' + encodeURIComponent(ip);
  const segs = splitPath(banPath);
  delAt(segs);
  persistNow();
  return { success: true };
}

/* ============================ RECENT EVENT (client polled) ============================ */

function recentEvents(limit) {
  const out = [];
  if (Array.isArray(db.server_logs)) {
    const arr = db.server_logs;
    for (let i = Math.max(0, arr.length - (limit || 20)); i < arr.length; i++) out.push(arr[i]);
  }
  return out;
}

/* ============================ HTTP SERVER ============================ */

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const rawUrl = req.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const pathPart = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const search = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '');
  const segs = splitPath(pathPart);

  const send = (obj, code) => {
    if (res.writableEnded) return;
    try {
      const body = (obj === null || obj === undefined) ? 'null' : JSON.stringify(obj);
      res.writeHead(code || 200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) { /* response already closed; ignore */ }
  };

  const clientIp = () => {
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
      const first = xff.split(',')[0].trim().replace(/^::ffff:/, '');
      if (first && first !== 'unknown') return first;
    }
    return (req.socket.remoteAddress || '').replace('::ffff:', '');
  };

  const readJson = (cb) => {
    let body = '';
    let aborted = false;
    req.on('data', (c) => { if (!aborted) body += c; });
    req.on('end', () => {
      if (aborted) return;
      try { cb(JSON.parse(body || '{}')); } catch (e) { cb({}); }
    });
  };

  const collect = (cb) => {
    let body = '';
    let aborted = false;
    req.on('data', (c) => { if (!aborted) body += c; });
    req.on('end', () => {
      if (aborted) return;
      cb(body);
    });
  };

  try {
    // Health check endpoints
    if (segs.length === 1 && segs[0] === 'ping') return send({ ok: true, t: Math.floor(Date.now() / 1000) });
    if (segs.length === 1 && segs[0] === 'time') return send({ unixtime: Math.floor(Date.now() / 1000), datetime: new Date().toISOString(), timezone: 'UTC' });
    if (segs.length === 1 && segs[0] === 'myip') return send({ ip: clientIp() });
    if (segs.length === 1 && segs[0] === 'healthz') return send({ ok: true, game: 'Oranthia', gate_level: WORLD_GATE_LEVEL, persistence: 'file', db_url: DB_URL, mode: 'stateless', recovery: (db.recovery ? Object.keys(db.recovery).length : 0) });

    // ================= WORLD ROUTES =================
    if (segs.length === 2 && segs[0] === 'world' && segs[1] === 'enter' && req.method === 'POST') {
      readJson((v) => {
        const username = String(v.username || v.user || '');
        const mapName = String(v.map || 'main');
        if (!username) return send({ success: false, error: 'username مطلوب' }, 400);
        const result = worldEnter(username, mapName);
        return send(result, result.locked ? 403 : 200);
      });
      return;
    }
    if (segs.length === 2 && segs[0] === 'world' && segs[1] === 'move' && req.method === 'POST') {
      readJson((v) => {
        const username = String(v.username || v.user || '');
        const mapName = String(v.map || '');
        return send(worldMove(username, mapName, v.x, v.y, v.z));
      });
      return;
    }
    if (segs.length === 2 && segs[0] === 'world' && segs[1] === 'message' && req.method === 'POST') {
      readJson((v) => {
        const username = String(v.username || v.user || '');
        return send(worldChat(username, String(v.map || 'main'), v.msg || v.message || v.text));
      });
      return;
    }
    if (segs.length === 2 && segs[0] === 'world' && segs[1] === 'status' && req.method === 'GET') {
      return send({ success: true, game: 'Oranthia', gate_level: WORLD_GATE_LEVEL, maps: listWorldMaps(), online: worldOnline('') });
    }
    if (segs.length === 3 && segs[0] === 'world' && segs[1] === 'map' && segs[2] && req.method === 'GET') {
      const text = loadMapText(segs[2]);
      if (text === null) return send({ success: false, error: 'الخريطة غير موجودة' }, 404);
      return send({ success: true, mapdata: text });
    }
    if (segs.length === 3 && segs[0] === 'world' && segs[1] === 'presence' && segs[2] && req.method === 'GET') {
      return send({ success: true, map: segs[2], online: worldOnline(segs[2]) });
    }
    if (segs.length === 3 && segs[0] === 'world' && segs[1] === 'chat' && segs[2] && req.method === 'GET') {
      const arr = (db.world_chat && db.world_chat[safeMapName(segs[2])]) || [];
      return send({ success: true, messages: arr.slice(-50) });
    }
    if (segs.length === 2 && segs[0] === 'recent_events' && req.method === 'GET') {
      return send({ success: true, events: recentEvents(30) });
    }

    // Admin commands: POST /admin_commands
    if (segs.length === 1 && segs[0] === 'admin_commands' && req.method === 'POST') {
      readJson((value) => {
        const target = value.target;
        const type = value.type;
        const adminToken = value.admin_token || req.headers['x-admin-token'];

        if (process.env.ADMIN_TOKEN && adminToken !== process.env.ADMIN_TOKEN) {
          return send({ error: 'Invalid admin token' }, 401);
        }

        delete value.target; delete value.type; delete value.admin_token;

        if (!target || !type) return send({ error: 'target and type are required' }, 400);

        let result;
        switch (type) {
          case 'update_player':
            result = adminUpdatePlayer(target, value);
            break;
          case 'update_tribe':
            result = adminUpdateTribe(target, value);
            break;
          case 'delete_tribe':
            result = adminDeleteTribe(target);
            break;
          case 'ban_device':
            result = adminBanDevice(target, value.reason);
            break;
          case 'unban_device':
            result = adminUnbanDevice(target);
            break;
          default:
            result = enqueueCommand(target, type, value);
        }
        addServerLog({
          t: Math.floor(Date.now() / 1000),
          ts: new Date().toISOString(),
          method: 'ADMIN',
          path: 'admin_commands',
          user: value.user || value.by || target || '',
          detail: type + ' -> ' + target + (result && result.success ? ' [OK]' : ' [FAIL]')
        });
        return send(result, 200);
      });
      return;
    }

    // Client-side game event logging
    if (segs.length === 2 && segs[0] === 'server_logs' && segs[1] === 'event' && req.method === 'POST') {
      readJson((val) => {
        addServerLog({
          t: Math.floor(Date.now() / 1000),
          ts: new Date().toISOString(),
          method: 'CLIENT_EVENT',
          path: 'server_logs/event',
          user: val.user || val.username || '',
          detail: val.event || val.msg || ''
        });
        return send({ ok: true });
      });
      return;
    }

    // Track player IPs
    if (segs.length >= 2 && segs[0] === 'players' && segs[1]) {
      const ip = clientIp();
      if (ip) {
        db.player_ips = db.player_ips || {};
        const cur = db.player_ips[segs[1]];
        if (!cur || cur.ip !== ip) {
          db.player_ips[segs[1]] = { ip, last_seen: Math.floor(Date.now() / 1000) };
          scheduleSave();
        }
      }
    }

    collect((body) => {
      try {
        if (req.method === 'GET') return send(applyQuery(getAt(segs), search));
        if (req.method === 'DELETE') { delAt(segs); addServerLog(reqLog(req.method, pathPart, segs[0] === 'players' && segs[1] ? segs[1] : '', 'delete')); return send(null); }
        const isPatch = req.method === 'PATCH' || (req.method === 'POST' && (req.headers['x-http-method-override'] || '').toUpperCase() === 'PATCH');
        if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
          const trimmed = body.trim();
          if (trimmed === '' || trimmed === 'null') { delAt(segs); addServerLog(reqLog(req.method, pathPart, '', 'delete empty')); return send(null); }
          let value = JSON.parse(trimmed);
          if (value === null) { delAt(segs); addServerLog(reqLog(req.method, pathPart, '', 'delete null')); return send(null); }
          if (typeof value !== 'object' || Array.isArray(value)) return send({ error: 'body must be a JSON object' }, 400);
          if (segs[0] === 'players' && segs[1]) value = handlePlayerBackup(segs[1], value);
          addServerLog(reqLog(req.method, pathPart, extractUserFromBody(trimmed), (isPatch ? 'patch ' : 'put ') + summarizeBody(trimmed, pathPart)));
          if (isPatch) return send(mergeAt(segs, value));
          setAt(segs, value);
          return send(value);
        }
        return send({ error: 'method not allowed' }, 405);
      } catch (e) {
        console.error('request error:', e.message);
        return send({ error: String((e && e.message) || e) }, 400);
      }
    });
  } catch (e) {
    console.error('handler error:', e.message);
    return send({ error: String((e && e.message) || e) }, 500);
  }
});

if (require.main === module) {
  console.log('أترايثيا (Oranthia) Server started — بوابة الدخول: مستوى ' + WORLD_GATE_LEVEL);
  console.log('Data file:', DATA_FILE);
  console.log('Server URL:', DB_URL);
  console.log('Mode: Stateless (no in-memory player cache)');
  server.listen(SERVER_PORT, () => console.log('Server listening on port ' + SERVER_PORT));

  setInterval(() => { if (!isShuttingDown) scheduleSave(); }, 5000).unref();

  setInterval(() => { if (!isShuttingDown) restoreFromRecoveries(); }, 60000).unref();

  setInterval(() => {
    const reqKeep = http.get(DB_URL + '/ping', (resKeep) => { resKeep.resume(); });
    reqKeep.setTimeout(15000, () => { try { reqKeep.destroy(); } catch (e) {} });
    reqKeep.on('error', () => {});
  }, 5 * 60 * 1000).unref();

  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection (recovered):', (reason && reason.message) || reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception (recovered):', (err && err.message) || err);
  });

  const shutdown = () => {
    console.log('\n[SHUTDOWN] Received termination signal, flushing database...');
    isShuttingDown = true;
    flush().then(() => {
      console.log('[SHUTDOWN] Database flushed successfully. Exiting.');
      server.close(() => process.exit(0));
    }).catch((e) => {
      console.error('[SHUTDOWN] Error during flush:', e.message);
      process.exit(1);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = server;