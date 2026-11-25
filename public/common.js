/* أدوات مشتركة بين صفحة المدراء وصفحة الإدارة */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dur = sec => { const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h + 'س ' + m + 'د'; };
const since = ms => dur(Math.max(0, Math.floor((Date.now() - ms) / 1000)));
const fdate = ms => new Date(ms).toLocaleString('ar-SA', {dateStyle: 'medium', timeStyle: 'short'});

function toast(msg, err) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(path, o = {}) {
  const r = await fetch(path, {
    method: o.method || 'GET',
    headers: o.body ? {'Content-Type': 'application/json'} : undefined,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  if (r.status === 401) { if (window.onUnauthorized) window.onUnauthorized(); throw new Error('401'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'صار خطأ');
  return d;
}
const act = async fn => { try { await fn(); } catch (e) { if (e.message !== '401') toast(e.message, true); } };

/* المظهر: الشعار والخلفيات واللون */
const safeImg = u => typeof u === 'string' && (/^\/uploads\/[\w.-]+$/.test(u) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u)) ? u : '';
function applyBranding(b, kind) {
  if (!b) return;
  const r = document.documentElement.style;
  if (/^#[0-9a-f]{6}$/i.test(b.accent)) r.setProperty('--accent', b.accent);
  r.setProperty('--ov', String((Number(b.overlay) || 85) / 100));
  const bg = safeImg(kind === 'login' ? b.loginBg : b.dashBg);
  r.setProperty('--bg-img', bg ? 'url("' + bg + '")' : 'none');
  $$('[data-brand-name]').forEach(e => { e.textContent = b.siteName; });
  const logo = safeImg(b.logo);
  $$('[data-brand-logo]').forEach(e => { if (logo) { e.src = logo; e.hidden = false; } else { e.hidden = true; } });
  document.title = b.siteName + (kind === 'admin' ? ' · الإدارة' : '');
}
async function loadBranding(kind) {
  try { applyBranding(await (await fetch('/api/branding')).json(), kind); } catch { /* يبقى الشكل الافتراضي */ }
}
