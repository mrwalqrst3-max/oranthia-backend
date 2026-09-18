'use strict';
/* اختبار خادم أترايثيا (Oranthia) — يُشغّل نسخة مؤقتة من السيرفر ويختبر:
 *  1) ping/healthz/maps
 *  2) بوابة المستوى 25 (رفض الدخول قبل 25، قبول بعده)
 *  3) دخول العالم + الحصول على mapdata
 *  4) تحريك اللاعب server-authoritative + الحضور المشترك
 *  5) دردشة الخريطة
 *  6) REST الكلاسيكي (players PUT/GET/PATCH) والاسترجاع
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = __dirname;
const PORT = 34567;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? '  — ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

async function req(method, p, bodyObj, headers) {
  const opts = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
  if (bodyObj !== undefined) opts.body = JSON.stringify(bodyObj);
  const res = await fetch(BASE + p, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { data = await res.text(); }
  return { status: res.status, data };
}

async function waitForServer(url, tries) {
  for (let i = 0; i < (tries || 30); i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(url + '/ping', { signal: ctl.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  // إعداد نسخة مؤقتة نظيفة (بدون database قديم)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oranthia-test-'));
  for (const f of fs.readdirSync(SRC)) {
    if (f.startsWith('database.json')) continue;
    if (f === 'node_modules') continue;
    const src = path.join(SRC, f), dst = path.join(tmp, f);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }

  console.log('\n=== أترايثيا (Oranthia) server test ===');
  console.log('Temp dir:', tmp, '\n');

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: Object.assign({}, process.env, { PORT: String(PORT), DB_URL: BASE })
  });
  let serverOut = '';
  proc.stdout.on('data', (d) => { serverOut += d; });
  proc.stderr.on('data', (d) => { serverOut += d; });

  const up = await waitForServer(BASE, 40);
  check('server started /ping', up);
  if (!up) { console.log(serverOut); process.exit(1); }

  try {
    // 1) الحالة العامة
    const health = await req('GET', '/healthz');
    check('healthz', health.status === 200 && health.data.ok === true, 'game=' + health.data.game);
    check('gate_level=25 في healthz', health.data.gate_level === 25);

    const status = await req('GET', '/world/status');
    check('world/status يعرض البوابات والخرائط', status.status === 200 && Array.isArray(status.data.maps) && status.data.maps.indexOf('main') !== -1, 'maps=' + status.data.maps.join(','));

    const mapdata = await req('GET', '/world/map/main');
    check('أخذ mapdata الخريطة', mapdata.status === 200 && /mapname:/.test(mapdata.data.mapdata), 'يحتوي mapname:');

    // 2) بوابة المستوى 25
    const newbie = { username: 'مبتدئ', name: 'مبتدئ', level: 5, gold: 0 };
    const putNew = await req('PUT', '/players/مبتدئ', newbie);
    check('إنشاء لاعب مبتدئ', putNew.status === 200);

    const enterLow = await req('POST', '/world/enter', { username: 'مبتدئ', map: 'main' });
    check('منع الدخول قبل المستوى 25', enterLow.status === 403 && enterLow.data.locked === true, 'required=' + enterLow.data.required);

    // لاعب بدون حساب أصلاً
    const enterGhost = await req('POST', '/world/enter', { username: 'شبح', map: 'main' });
    check('رفض لاعب غير موجود', enterGhost.status === 200 && enterGhost.data.success === false, enterGhost.data.error);

    // 3) ترقية اللاعب إلى 25 ثم الدخول
    const promote = await req('PATCH', '/players/مبتدئ', { level: 25 });
    check('ترقية اللاعب إلى المستوى 25', promote.status === 200 && promote.data.level === 25);

    const enterOk = await req('POST', '/world/enter', { username: 'مبتدئ', map: 'main' });
    check('دخول العالم عند 25', enterOk.status === 200 && enterOk.data.success === true && enterOk.data.mapdata);
    check('الحضور المشترك يحتوي اللاعب', Array.isArray(enterOk.data.online) && enterOk.data.online.some((o) => o.user === 'مبتدئ'));

    // 4) حركة server-authoritative
    const move = await req('POST', '/world/move', { username: 'مبتدئ', map: 'main', x: 10.5, y: 12, z: 6 });
    check('move يحدّث الموضع', move.status === 200 && move.data.success === true);

    const presence = await req('GET', '/world/presence/main');
    const me = presence.data.online.find((o) => o.user === 'مبتدئ');
    check('الحضور يظهر الموقع الجديد', !!me, me ? ('x=' + me.x + ' y=' + me.y + ' z=' + me.z) : '');

    // 5) دردشة الخريطة
    const chat = await req('POST', '/world/message', { username: 'مبتدئ', map: 'main', msg: 'أهلاً بعالم أترايثيا!' });
    check('رسالة داخل العالم', chat.status === 200 && chat.data.success === true && chat.data.messages.length > 0);
    const chatGet = await req('GET', '/world/chat/main');
    check('قراءة دردشة الخريطة', chatGet.data.messages.some((m) => m.text.indexOf('أترايثيا') !== -1));

    // 5b) الخريطة غير الموجودة تعطي 404
    const noMap = await req('GET', '/world/map/nonexistent');
    check('خريطة غير موجودة → 404', noMap.status === 404);

    // 6) REST الكلاسيكي باقٍ يعمل (استرجاع/قائمة اللاعبين)
    const list = await req('GET', '/players.json');
    check('قائمة اللاعبين (REST)', list.status === 200 && list.data && list.data['مبتدئ']);

    // اللاعب خارج العالم بعد الدخول بتعديل RFID لا يلغيه
    const after = await req('GET', '/players/مبتدئ');
    check('استرجاع اللاعب بعد الدخول', after.status === 200 && after.data.level === 25);

  } catch (e) {
    failed++;
    console.log('  FAIL  استثناء غير متوقع:', e.message);
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n=== النتائج: ' + passed + ' نجحت، ' + failed + ' فشلت ===');
  process.exit(failed === 0 ? 0 : 1);
}

main();