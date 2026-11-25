'use strict';
/**
 * لوحة مدراء القطاعات - سيرفر + بوت دسكورد في تطبيق واحد
 * تشغيل:  node --env-file=.env server.js
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');

/* ------------------------------ الإعدادات ------------------------------ */
const CFG = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  guildId: process.env.GUILD_ID,
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  port: Number(process.env.PORT) || 3000,
  owner: String(process.env.OWNER_ID || '1241144201199226965'),
};
for (const k of ['token', 'clientId', 'clientSecret', 'guildId']) {
  if (!CFG[k]) { console.error('متغير ناقص في ملف .env: ' + k); process.exit(1); }
}
if (CFG.secret === 'change-this-secret') console.warn('تنبيه: غيّر SESSION_SECRET في .env');

/* ----------------------------- قاعدة البيانات ----------------------------- */
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { sectors: [], users: {}, shifts: [], warnings: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch { /* أول تشغيل */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}
const uid = () => crypto.randomBytes(5).toString('hex');
const isId = (s) => /^\d{15,22}$/.test(String(s));

/* ------------------------------- الصلاحيات ------------------------------- */
const isOwner = (id) => id === CFG.owner;
const userSectors = (id) =>
  isOwner(id)
    ? db.sectors.map((s) => s.id)
    : ((db.users[id] && db.users[id].sectors) || []).filter((sid) => db.sectors.some((s) => s.id === sid));
const canView = (id, sid) => userSectors(id).includes(sid);
const canEdit = (id, sid) => isOwner(id) || (!!(db.users[id] && db.users[id].canEdit) && canView(id, sid));

/* -------------------------------- دسكورد -------------------------------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
let lastFetch = 0;
async function getGuild() {
  const g = client.guilds.cache.get(CFG.guildId);
  if (!g) return null;
  if (Date.now() - lastFetch > 60000) {
    lastFetch = Date.now();
    await g.members.fetch().catch(() => {});
  }
  return g;
}
const nameOf = (g, id) => {
  const m = g && g.members.cache.get(id);
  if (m) return m.displayName;
  const u = client.users.cache.get(id);
  return u ? u.globalName || u.username : id;
};

async function sectorStats(sec) {
  const g = await getGuild();
  const now = Date.now();
  const weekAgo = now - 7 * 864e5;
  const role = g && g.roles.cache.get(sec.roleId);
  const offRole = sec.officerRoleId && g && g.roles.cache.get(sec.officerRoleId);
  const people = new Map();
  if (role) for (const m of role.members.values()) if (!m.user.bot) people.set(m.id, m);

  const agg = {};
  for (const s of db.shifts) {
    if (s.sectorId !== sec.id) continue;
    const end = s.end || now;
    const a = (agg[s.userId] = agg[s.userId] || { total: 0, week: 0, since: null });
    a.total += end - s.start;
    const ws = Math.max(s.start, weekAgo);
    if (end > ws) a.week += end - ws;
    if (!s.end) a.since = s.start;
  }
  const warns = db.warnings.filter((w) => w.sectorId === sec.id);
  const wc = {};
  for (const w of warns) wc[w.userId] = (wc[w.userId] || 0) + 1;

  const members = [...people.values()].map((m) => {
    const a = agg[m.id] || { total: 0, week: 0, since: null };
    return {
      id: m.id,
      name: m.displayName,
      avatar: m.displayAvatarURL({ size: 64 }),
      isOfficer: !!(offRole && m.roles.cache.has(offRole.id)),
      onDuty: !!a.since,
      since: a.since,
      totalSec: Math.floor(a.total / 1000),
      weekSec: Math.floor(a.week / 1000),
      warns: wc[m.id] || 0,
    };
  });
  members.sort((x, y) => Number(y.onDuty) - Number(x.onDuty) || y.totalSec - x.totalSec);

  return {
    sector: { id: sec.id, name: sec.name },
    totals: {
      members: members.length,
      officers: members.filter((m) => m.isOfficer).length,
      onDuty: members.filter((m) => m.onDuty).length,
      totalSec: members.reduce((n, m) => n + m.totalSec, 0),
      weekSec: members.reduce((n, m) => n + m.weekSec, 0),
      warnings: warns.length,
    },
    members,
    warnings: warns
      .slice()
      .sort((a, b) => b.at - a.at)
      .map((w) => ({ id: w.id, userId: w.userId, name: nameOf(g, w.userId), reason: w.reason, by: nameOf(g, w.by), at: w.at })),
  };
}

/* ------------------------------ أوامر البوت ------------------------------ */
const COMMANDS = [
  { name: 'duty', description: 'بدء مباشرتك (تسجيل دخول للخدمة)' },
  { name: 'endduty', description: 'إنهاء مباشرتك (تسجيل خروج من الخدمة)' },
  { name: 'myhours', description: 'عرض ساعات مباشرتك' },
  {
    name: 'warn',
    description: 'إضافة تحذير لعضو في قطاعك (للمصرّح لهم فقط)',
    options: [
      { name: 'user', description: 'العضو', type: 6, required: true },
      { name: 'reason', description: 'سبب التحذير', type: 3, required: true },
    ],
  },
];

client.once('clientReady', async () => {
  console.log('البوت شغال: ' + client.user.tag);
  const g = client.guilds.cache.get(CFG.guildId);
  if (!g) return console.error('البوت مو موجود في السيرفر GUILD_ID');
  await g.commands.set(COMMANDS).catch((e) => console.error('فشل تسجيل الأوامر', e.message));
  await getGuild();
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || i.guildId !== CFG.guildId) return;
  const say = (content) => i.reply({ content, flags: MessageFlags.Ephemeral });
  try {
    const sec = db.sectors.find((s) => i.member.roles.cache.has(s.roleId));

    if (i.commandName === 'duty') {
      if (!sec) return say('❌ ما انت تابع لأي قطاع.');
      if (db.shifts.some((s) => s.userId === i.user.id && !s.end)) return say('⚠️ انت مباشر بالفعل.');
      db.shifts.push({ id: uid(), sectorId: sec.id, userId: i.user.id, start: Date.now(), end: null });
      save();
      return say(`✅ بدأت مباشرتك في قطاع **${sec.name}**.`);
    }

    if (i.commandName === 'endduty') {
      const open = db.shifts.find((s) => s.userId === i.user.id && !s.end);
      if (!open) return say('⚠️ ما عندك مباشرة شغالة.');
      open.end = Date.now();
      save();
      const mins = Math.round((open.end - open.start) / 60000);
      return say(`✅ انتهت مباشرتك. المدة: **${Math.floor(mins / 60)}س ${mins % 60}د**.`);
    }

    if (i.commandName === 'myhours') {
      const now = Date.now();
      let total = 0;
      for (const s of db.shifts) if (s.userId === i.user.id) total += (s.end || now) - s.start;
      const mins = Math.floor(total / 60000);
      return say(`⏱️ مجموع ساعاتك: **${Math.floor(mins / 60)}س ${mins % 60}د**.`);
    }

    if (i.commandName === 'warn') {
      const target = i.options.getMember('user');
      if (!target) return say('❌ ما لقيت العضو.');
      const tsec = db.sectors.find((s) => target.roles.cache.has(s.roleId));
      if (!tsec) return say('❌ هذا العضو مو تابع لأي قطاع.');
      if (!canEdit(i.user.id, tsec.id)) return say('❌ ما عندك صلاحية تعديل على هذا القطاع.');
      db.warnings.push({
        id: uid(), sectorId: tsec.id, userId: target.id,
        reason: i.options.getString('reason').slice(0, 300), by: i.user.id, at: Date.now(),
      });
      save();
      return say(`⚠️ تم تحذير <@${target.id}> في قطاع **${tsec.name}**.`);
    }
  } catch (e) {
    console.error(e);
    if (!i.replied) say('حصل خطأ، حاول مرة ثانية.').catch(() => {});
  }
});

/* ------------------------------- أدوات الويب ------------------------------- */
function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const s = crypto.createHmac('sha256', CFG.secret).update(p).digest('base64url');
  return p + '.' + s;
}
function verify(t) {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const e = crypto.createHmac('sha256', CFG.secret).update(p).digest('base64url');
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function setCookie(res, name, val, maxAge) {
  res.append('Set-Cookie',
    `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${CFG.baseUrl.startsWith('https') ? '; Secure' : ''}`);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

/* ----------------------------- تسجيل الدخول ----------------------------- */
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'oauth_state', state, 600);
  const q = new URLSearchParams({
    client_id: CFG.clientId, response_type: 'code', scope: 'identify',
    redirect_uri: CFG.baseUrl + '/callback', state,
  });
  res.redirect('https://discord.com/oauth2/authorize?' + q);
});

app.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== cookies(req).oauth_state) return res.status(400).send('طلب غير صالح، ارجع وسجّل دخول من جديد.');
    const tr = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CFG.clientId, client_secret: CFG.clientSecret, grant_type: 'authorization_code',
        code: String(code), redirect_uri: CFG.baseUrl + '/callback',
      }),
    });
    const tok = await tr.json();
    if (!tok.access_token) throw new Error('no token');
    const u = await (await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tok.access_token },
    })).json();
    setCookie(res, 'sid', sign({
      id: u.id,
      name: u.global_name || u.username,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
      exp: Date.now() + 7 * 864e5,
    }), 7 * 86400);
    setCookie(res, 'oauth_state', '', 0);
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('فشل تسجيل الدخول عبر دسكورد.');
  }
});

app.get('/logout', (req, res) => { setCookie(res, 'sid', '', 0); res.redirect('/'); });

const auth = (req, res, next) => {
  const u = verify(cookies(req).sid);
  if (!u) return res.status(401).json({ error: 'غير مسجّل' });
  req.user = u;
  next();
};
const ownerOnly = (req, res, next) =>
  isOwner(req.user.id) ? next() : res.status(403).json({ error: 'للمالك فقط' });

/* ---------------------------------- API ---------------------------------- */
app.get('/api/me', auth, (req, res) => {
  const ids = userSectors(req.user.id);
  res.json({
    user: { id: req.user.id, name: req.user.name, avatar: req.user.avatar },
    owner: isOwner(req.user.id),
    sectors: db.sectors.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, name: s.name, canEdit: canEdit(req.user.id, s.id) })),
  });
});

app.get('/api/sectors/:id/stats', auth, async (req, res) => {
  const sec = db.sectors.find((s) => s.id === req.params.id);
  if (!sec || !canView(req.user.id, sec.id)) return res.status(403).json({ error: 'ما عندك صلاحية على هذا القطاع' });
  const st = await sectorStats(sec);
  st.canEdit = canEdit(req.user.id, sec.id);
  res.json(st);
});

app.post('/api/sectors/:id/warnings', auth, (req, res) => {
  const sid = req.params.id;
  if (!db.sectors.some((s) => s.id === sid)) return res.status(404).json({ error: 'قطاع غير موجود' });
  if (!canEdit(req.user.id, sid)) return res.status(403).json({ error: 'ما عندك صلاحية تعديل' });
  const { userId, reason } = req.body || {};
  if (!isId(userId) || !reason || !String(reason).trim()) return res.status(400).json({ error: 'بيانات ناقصة' });
  db.warnings.push({ id: uid(), sectorId: sid, userId: String(userId), reason: String(reason).trim().slice(0, 300), by: req.user.id, at: Date.now() });
  save();
  res.json({ ok: true });
});

app.delete('/api/sectors/:id/warnings/:wid', auth, (req, res) => {
  if (!canEdit(req.user.id, req.params.id)) return res.status(403).json({ error: 'ما عندك صلاحية تعديل' });
  db.warnings = db.warnings.filter((w) => !(w.id === req.params.wid && w.sectorId === req.params.id));
  save();
  res.json({ ok: true });
});

app.post('/api/sectors/:id/members/:uid/endduty', auth, (req, res) => {
  if (!canEdit(req.user.id, req.params.id)) return res.status(403).json({ error: 'ما عندك صلاحية تعديل' });
  const open = db.shifts.find((s) => s.sectorId === req.params.id && s.userId === req.params.uid && !s.end);
  if (open) { open.end = Date.now(); save(); }
  res.json({ ok: true });
});

/* ------------------------------ لوحة المالك ------------------------------ */
app.get('/api/admin/data', auth, ownerOnly, async (req, res) => {
  const g = await getGuild();
  const roles = g ? [...g.roles.cache.values()].filter((r) => r.id !== g.id).sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name })) : [];
  res.json({
    sectors: db.sectors,
    users: Object.entries(db.users).map(([id, u]) => ({ id, name: nameOf(g, id), sectors: u.sectors || [], canEdit: !!u.canEdit })),
    roles,
  });
});

function cleanSector(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name || !isId(b.roleId)) return null;
  return { name, roleId: String(b.roleId), officerRoleId: isId(b.officerRoleId) ? String(b.officerRoleId) : '' };
}
app.post('/api/admin/sectors', auth, ownerOnly, (req, res) => {
  const c = cleanSector(req.body || {});
  if (!c) return res.status(400).json({ error: 'اكتب اسم القطاع واختر رتبة الأعضاء' });
  db.sectors.push({ id: uid(), ...c });
  save();
  res.json({ ok: true });
});
app.put('/api/admin/sectors/:id', auth, ownerOnly, (req, res) => {
  const s = db.sectors.find((x) => x.id === req.params.id);
  const c = cleanSector(req.body || {});
  if (!s || !c) return res.status(400).json({ error: 'بيانات غير صالحة' });
  Object.assign(s, c);
  save();
  res.json({ ok: true });
});
app.delete('/api/admin/sectors/:id', auth, ownerOnly, (req, res) => {
  const id = req.params.id;
  db.sectors = db.sectors.filter((s) => s.id !== id);
  db.shifts = db.shifts.filter((s) => s.sectorId !== id);
  db.warnings = db.warnings.filter((w) => w.sectorId !== id);
  for (const u of Object.values(db.users)) u.sectors = (u.sectors || []).filter((x) => x !== id);
  save();
  res.json({ ok: true });
});
app.put('/api/admin/users/:id', auth, ownerOnly, (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'ايدي دسكورد غير صالح' });
  if (isOwner(req.params.id)) return res.status(400).json({ error: 'المالك عنده كل الصلاحيات تلقائياً' });
  const ids = Array.isArray(req.body.sectors) ? req.body.sectors.filter((x) => db.sectors.some((s) => s.id === x)) : [];
  db.users[req.params.id] = { sectors: ids, canEdit: !!req.body.canEdit };
  client.users.fetch(req.params.id).catch(() => {});
  save();
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth, ownerOnly, (req, res) => {
  delete db.users[req.params.id];
  save();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------- تشغيل ---------------------------------- */
client.login(CFG.token).catch((e) => { console.error('فشل تسجيل دخول البوت:', e.message); process.exit(1); });
app.listen(CFG.port, () => console.log(`الموقع شغال على ${CFG.baseUrl} (المنفذ ${CFG.port})`));
