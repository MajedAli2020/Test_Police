'use strict';
/**
 * لوحة مدراء القطاعات - سيرفر + بوت دسكورد في تطبيق واحد
 * محلياً:  npm run dev      |  على Render:  node server.js
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
  baseUrl: (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  port: Number(process.env.PORT) || 3000,
  owner: String(process.env.OWNER_ID || '1241144201199226965'),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
};
for (const k of ['token', 'clientId', 'clientSecret', 'guildId']) {
  if (!CFG[k]) { console.error('متغير ناقص: ' + k); process.exit(1); }
}
if (CFG.secret === 'change-this-secret') console.warn('تنبيه: غيّر SESSION_SECRET');

/* ----------------------------- قاعدة البيانات ----------------------------- */
const DB_FILE = path.join(CFG.dataDir, 'db.json');
const UP_DIR = path.join(CFG.dataDir, 'uploads');
fs.mkdirSync(UP_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  siteName: 'لوحة مدراء القطاعات',
  accent: '#5865f2',
  overlay: 85,
  logo: '',
  loginBg: '',
  dashBg: '',
  notify: { channelId: '', duty: true, warnings: true },
};
let db = { sectors: [], users: {}, shifts: [], warnings: [], settings: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch { /* أول تشغيل */ }
db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings || {});
const oldWh = db.settings.webhook; delete db.settings.webhook;
db.settings.notify = Object.assign({}, DEFAULT_SETTINGS.notify, oldWh ? { duty: oldWh.duty, warnings: oldWh.warnings } : {}, db.settings.notify || {});

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

/* ------------------------------- إشعارات الروم ------------------------------- */
const COLORS = { green: 0x3ecf8e, red: 0xf0556a, amber: 0xf5a524, blue: 0x5865f2 };

async function resolveChannel(id) {
  try {
    const ch = await client.channels.fetch(id);
    if (!ch || ch.guildId !== CFG.guildId || !ch.isTextBased()) return { ok: false, error: 'هذا مو روم كتابي في السيرفر المربوط بالبوت' };
    const p = ch.permissionsFor(client.user);
    if (!p || !p.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return { ok: false, error: 'البوت يحتاج صلاحيات: عرض الروم، إرسال الرسائل، تضمين الروابط' };
    return { ok: true, channel: ch, name: ch.name };
  } catch { return { ok: false, error: 'ما لقيت الروم. تأكد من الايدي وأن البوت يشوفه' }; }
}
async function sendNotice(payload) {
  const id = db.settings.notify.channelId;
  if (!id) return { ok: false, error: 'ما فيه ايدي روم محفوظ' };
  const r = await resolveChannel(id);
  if (!r.ok) return r;
  try { await r.channel.send(Object.assign({ allowedMentions: { parse: [] } }, payload)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
function notify(type, e) {
  const n = db.settings.notify;
  if (!n.channelId || !n[type]) return;
  sendNotice({ embeds: [{ title: e.title, description: e.description, color: e.color, fields: e.fields, footer: { text: db.settings.siteName }, timestamp: new Date().toISOString() }] })
    .then((r) => { if (!r.ok) console.error('فشل إرسال الإشعار', r.error); });
}
const tnow = () => `<t:${Math.floor(Date.now() / 1000)}:t>`;

/* -------------------------------- إحصائيات -------------------------------- */
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

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  console.log('البوت شغال: ' + client.user.tag);
  const g = client.guilds.cache.get(CFG.guildId);
  if (!g) return console.error('البوت مو موجود في السيرفر GUILD_ID');
  await g.commands.set(COMMANDS).catch((e) => console.error('فشل تسجيل الأوامر', e.message));
  await getGuild();
}
client.once('clientReady', boot);
client.once('ready', boot);

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
      notify('duty', {
        title: 'بدء مباشرة', color: COLORS.green, description: `<@${i.user.id}>`,
        fields: [{ name: 'القطاع', value: sec.name, inline: true }, { name: 'الوقت', value: tnow(), inline: true }],
      });
      return say(`✅ بدأت مباشرتك في قطاع **${sec.name}**.`);
    }

    if (i.commandName === 'endduty') {
      const open = db.shifts.find((s) => s.userId === i.user.id && !s.end);
      if (!open) return say('⚠️ ما عندك مباشرة شغالة.');
      open.end = Date.now();
      save();
      const mins = Math.round((open.end - open.start) / 60000);
      const s2 = db.sectors.find((s) => s.id === open.sectorId);
      notify('duty', {
        title: 'إنهاء مباشرة', color: COLORS.red, description: `<@${i.user.id}>`,
        fields: [
          { name: 'القطاع', value: s2 ? s2.name : '-', inline: true },
          { name: 'المدة', value: `${Math.floor(mins / 60)}س ${mins % 60}د`, inline: true },
        ],
      });
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
      const reason = i.options.getString('reason').slice(0, 300);
      db.warnings.push({ id: uid(), sectorId: tsec.id, userId: target.id, reason, by: i.user.id, at: Date.now() });
      save();
      notify('warnings', {
        title: 'تحذير جديد', color: COLORS.amber, description: `<@${target.id}>`,
        fields: [
          { name: 'القطاع', value: tsec.name, inline: true },
          { name: 'بواسطة', value: `<@${i.user.id}>`, inline: true },
          { name: 'السبب', value: reason },
        ],
      });
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
app.set('trust proxy', 1);
// رفع الصور يحتاج حجم أكبر، لازم يكون قبل المحلل العام
app.use('/api/admin/upload', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '50kb' }));

app.get('/healthz', (req, res) => res.send('ok'));

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
    const next = cookies(req).next;
    setCookie(res, 'oauth_state', '', 0);
    setCookie(res, 'next', '', 0);
    res.redirect(next === '/admin' ? '/admin' : '/');
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

/* صفحة الإدارة: ملف منفصل ولا تُعرض إلا للمالك */
app.get('/admin', (req, res) => {
  const u = verify(cookies(req).sid);
  if (!u) { setCookie(res, 'next', '/admin', 600); return res.redirect('/login'); }
  if (!isOwner(u.id)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

/* ---------------------------------- API ---------------------------------- */
// المظهر العام (يُستخدم في صفحة الدخول أيضاً، بدون الويب هوك)
app.get('/api/branding', (req, res) => {
  const s = db.settings;
  res.set('Cache-Control', 'no-store');
  res.json({ siteName: s.siteName, accent: s.accent, overlay: s.overlay, logo: s.logo, loginBg: s.loginBg, dashBg: s.dashBg });
});

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

app.post('/api/sectors/:id/warnings', auth, async (req, res) => {
  const sid = req.params.id;
  const sec = db.sectors.find((s) => s.id === sid);
  if (!sec) return res.status(404).json({ error: 'قطاع غير موجود' });
  if (!canEdit(req.user.id, sid)) return res.status(403).json({ error: 'ما عندك صلاحية تعديل' });
  const { userId, reason } = req.body || {};
  if (!isId(userId) || !reason || !String(reason).trim()) return res.status(400).json({ error: 'بيانات ناقصة' });
  const clean = String(reason).trim().slice(0, 300);
  db.warnings.push({ id: uid(), sectorId: sid, userId: String(userId), reason: clean, by: req.user.id, at: Date.now() });
  save();
  notify('warnings', {
    title: 'تحذير جديد', color: COLORS.amber, description: `<@${userId}>`,
    fields: [
      { name: 'القطاع', value: sec.name, inline: true },
      { name: 'بواسطة', value: req.user.name, inline: true },
      { name: 'السبب', value: clean },
    ],
  });
  res.json({ ok: true });
});

app.delete('/api/sectors/:id/warnings/:wid', auth, (req, res) => {
  if (!canEdit(req.user.id, req.params.id)) return res.status(403).json({ error: 'ما عندك صلاحية تعديل' });
  const w = db.warnings.find((x) => x.id === req.params.wid && x.sectorId === req.params.id);
  if (w) {
    db.warnings = db.warnings.filter((x) => x !== w);
    save();
    notify('warnings', {
      title: 'حذف تحذير', color: COLORS.blue, description: `<@${w.userId}>`,
      fields: [{ name: 'بواسطة', value: req.user.name, inline: true }, { name: 'كان السبب', value: w.reason }],
    });
  }
  res.json({ ok: true });
});

app.post('/api/sectors/:id/members/:uid/endduty', auth, (req, res) => {
  if (!canEdit(req.user.id, req.params.id)) return res.status(403).json({ error: 'ما عندك صلاحية تعديل' });
  const open = db.shifts.find((s) => s.sectorId === req.params.id && s.userId === req.params.uid && !s.end);
  if (open) {
    open.end = Date.now();
    save();
    const mins = Math.round((open.end - open.start) / 60000);
    const sec = db.sectors.find((s) => s.id === open.sectorId);
    notify('duty', {
      title: 'إنهاء مباشرة (من الموقع)', color: COLORS.red, description: `<@${open.userId}>`,
      fields: [
        { name: 'القطاع', value: sec ? sec.name : '-', inline: true },
        { name: 'المدة', value: `${Math.floor(mins / 60)}س ${mins % 60}د`, inline: true },
        { name: 'بواسطة', value: req.user.name, inline: true },
      ],
    });
  }
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

/* المظهر والإعدادات */
const withCh = async (s) => { const c = s.notify.channelId ? await resolveChannel(s.notify.channelId) : null; return { ...s, channel: c && (c.ok ? { name: c.name } : { error: c.error }) }; };
app.get('/api/admin/settings', auth, ownerOnly, async (req, res) => res.json(await withCh(db.settings)));

app.put('/api/admin/settings', auth, ownerOnly, async (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  if (b.siteName !== undefined) {
    const n = String(b.siteName).trim().slice(0, 60);
    if (!n) return res.status(400).json({ error: 'اكتب اسم الموقع' });
    s.siteName = n;
  }
  if (b.accent !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(b.accent))) return res.status(400).json({ error: 'لون غير صالح' });
    s.accent = String(b.accent).toLowerCase();
  }
  if (b.overlay !== undefined) {
    const o = Number(b.overlay);
    if (!(o >= 30 && o <= 98)) return res.status(400).json({ error: 'قيمة التعتيم غير صالحة' });
    s.overlay = Math.round(o);
  }
  if (b.notify) {
    const channelId = String(b.notify.channelId || '').trim();
    if (channelId) {
      if (!isId(channelId)) return res.status(400).json({ error: 'ايدي الروم غير صالح، لازم أرقام فقط' });
      const r = await resolveChannel(channelId);
      if (!r.ok) return res.status(400).json({ error: r.error });
    }
    s.notify = { channelId, duty: !!b.notify.duty, warnings: !!b.notify.warnings };
  }
  save();
  res.json(await withCh(s));
});

app.post('/api/admin/notify/test', auth, ownerOnly, async (req, res) => {
  const r = await sendNotice({ embeds: [{ title: 'اختبار الإشعارات', description: 'إذا وصلتك هذي الرسالة فالربط شغال.', color: COLORS.blue, timestamp: new Date().toISOString() }] });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

/* رفع الشعار والخلفيات */
const KINDS = ['logo', 'loginBg', 'dashBg'];
function sniff(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.subarray(0, 3).toString() === 'GIF') return 'gif';
  return null;
}
function rmUpload(url) {
  if (typeof url === 'string' && /^\/uploads\/[\w.-]+$/.test(url)) fs.unlink(path.join(UP_DIR, path.basename(url)), () => {});
}
app.post('/api/admin/upload', auth, ownerOnly, (req, res) => {
  const { kind, data } = req.body || {};
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'نوع غير صالح' });
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) return res.status(400).json({ error: 'صيغة الصورة غير مدعومة (PNG أو JPG أو WEBP أو GIF)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > (kind === 'logo' ? 2 : 6) * 1024 * 1024) return res.status(400).json({ error: 'حجم الصورة كبير' });
  const ext = sniff(buf);
  if (!ext) return res.status(400).json({ error: 'الملف ليس صورة صالحة' });
  const name = `${kind}-${uid()}.${ext}`;
  fs.writeFileSync(path.join(UP_DIR, name), buf);
  rmUpload(db.settings[kind]);
  db.settings[kind] = '/uploads/' + name;
  save();
  res.json({ ok: true, url: db.settings[kind] });
});
app.delete('/api/admin/upload/:kind', auth, ownerOnly, (req, res) => {
  if (!KINDS.includes(req.params.kind)) return res.status(400).json({ error: 'نوع غير صالح' });
  rmUpload(db.settings[req.params.kind]);
  db.settings[req.params.kind] = '';
  save();
  res.json({ ok: true });
});

app.use('/uploads', express.static(UP_DIR, {
  maxAge: '1h',
  setHeaders: (r) => r.setHeader('X-Content-Type-Options', 'nosniff'),
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------- تشغيل ---------------------------------- */
client.login(CFG.token).catch((e) => { console.error('فشل تسجيل دخول البوت:', e.message); process.exit(1); });
app.listen(CFG.port, () => console.log(`الموقع شغال على ${CFG.baseUrl} (المنفذ ${CFG.port})`));
