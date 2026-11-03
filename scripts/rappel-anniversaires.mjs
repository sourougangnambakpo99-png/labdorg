// Rappel quotidien des anniversaires : lit les données du site (Firestore, lecture publique comme le site),
// puis envoie un mail à TOUS les membres de chaque promotion (bureau compris), via Gmail.
// Le 16 octobre (fondation de LABD), il envoie aussi l'anniversaire du groupe, avec la meilleure
// photo d'ensemble de l'année choisie parmi les photos du site.
import fs from 'node:fs';
import path from 'node:path';

const INDEX = process.env.INDEX_PATH || 'index.html';
const DRY = process.env.DRY_RUN === '1';
const SITE = 'https://labdorg.pages.dev';
const FOUNDED = { m: 10, d: 16, y: 2025 }; // fondation de LABD : 16 octobre 2025
const html = fs.readFileSync(INDEX, 'utf8');

const apiKey = (html.match(/apiKey:\s*"([^"]+)"/) || [])[1];
const projectId = (html.match(/projectId:\s*"([^"]+)"/) || [])[1];
if (!apiKey || !projectId) throw new Error("Configuration Firebase introuvable dans " + INDEX);
const emailsBlock = (html.match(/emails:\s*\{([^}]*)\}/) || [])[1] || '';
const fallbackEmails = [...emailsBlock.matchAll(/"([^"]+@[^"]+)"/g)].map(m => m[1]);

async function get(key, fb) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/labd-data/${encodeURIComponent(key)}?key=${apiKey}`;
  const r = await fetch(url);
  if (r.status === 404) return fb;
  if (!r.ok) throw new Error(`Lecture ${key} impossible : ${r.status}`);
  const j = await r.json();
  const v = j.fields && j.fields.value && j.fields.value.stringValue;
  return v ? JSON.parse(v) : fb;
}

const extra = await get('membres-extra', []);
const overrides = await get('membres-overrides', {});
const removed = await get('membres-removed', []);
const promotions = await get('promotions', {});

// Date du jour et de demain au Bénin (UTC+1).
const pad = n => String(n).padStart(2, '0');
const nowBj = new Date(Date.now() + 3600 * 1000);
const tomorrowBj = new Date(nowBj.getTime() + 86400000);
const key = d => pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const todayK = key(nowBj), tomorrowK = key(tomorrowBj);

const okEmail = e => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// ---------- Les membres, par promotion ----------
// groupe = { label, people:[{nom,email,anniv}], extra:Set(emails sans nom) }
const groups = new Map();
const grp = (label) => { if (!groups.has(label)) groups.set(label, { label, people: [], extra: new Set() }); return groups.get(label); };

// Promotion fondatrice : membres ajoutés et modifications ; les adresses d'origine servent de filet.
const gF = grp('Promotion fondatrice');
fallbackEmails.forEach(e => gF.extra.add(e));
Object.entries(overrides).forEach(([num, o]) => { if (!removed.includes(num) && o) gF.people.push({ nom: o.nom, email: o.email, anniv: o.anniv, abbr: o.abbr }); });
extra.forEach(m => { if (!removed.includes(m.num)) gF.people.push({ nom: m.nom, email: m.email, anniv: m.anniv, abbr: m.abbr }); });

for (const p of Object.values(promotions)) {
  const g = grp(p.nom + (p.annee ? ' ' + p.annee : ''));
  (p.bureau || []).concat(p.membres || []).forEach(m => g.people.push({ nom: m.nom, email: m.email, anniv: m.anniv, abbr: m.abbr }));
}

// Tous les destinataires possibles d'un groupe (sans doublon), nom conservé pour ne pas avertir la personne fêtée.
function recipientsOf(g) {
  const seen = new Set(), out = [];
  const add = (email, nom) => { const k = String(email).toLowerCase(); if (!okEmail(email) || seen.has(k)) return; seen.add(k); out.push({ email, nom: nom || null }); };
  g.people.forEach(m => add(m.email, m.nom));
  g.extra.forEach(e => add(e, null));
  return out;
}

// ---------- Mail d'anniversaire d'un membre ----------
const shownPlain = p => p.nom + (p.abbr && String(p.abbr).trim() ? ' (' + String(p.abbr).trim() + ' LABD)' : '');
const BTN = 'display:inline-block; background:#05b3c2; color:#ffffff; padding:12px 24px; border-radius:999px; text-decoration:none; font-weight:bold;';
// Nom affiché, suivi du poste s'il y en a un (ex. « Nom (PR LABD) »).
const shown = p => esc(p.nom) + (p.abbr && String(p.abbr).trim() ? ' (' + esc(String(p.abbr).trim()) + ' LABD)' : '');
function memberMailBody(label, nowNames, nextNames) {
  const lignes = [];
  if (nowNames.length) lignes.push("🎂 <b>Anniversaire aujourd'hui</b> : 🎉 " + nowNames.map(shown).join(', ') + ' 🥳');
  if (nextNames.length) lignes.push('🎈 <b>Anniversaire demain</b> : ' + nextNames.map(shown).join(', ') + ' ⏰');
  const pron = (nowNames.length ? nowNames : nextNames).length > 1 ? 'leur' : 'lui';
  const appel = nowNames.length
    ? `👉 Rendez-vous sur le site pour ${pron} souhaiter un joyeux anniversaire : un message de fête s'affiche à l'ouverture, avec un bouton pour le partager sur WhatsApp.`
    : `👉 Demain, pensez à passer sur le site pour ${pron} souhaiter un joyeux anniversaire.`;
  return `Bonjour 👋,<br><br>${lignes.join('<br><br>')}<br><br>${appel}<br><br>`
    + `<a href="${SITE}" style="${BTN}">🎉 Aller sur le site LABD</a><br><br>`
    + `<span style="color:#888; font-size:12px;">Rappel automatique du site LABD (${esc(label)}). Merci de ne pas répondre à ce message.</span>`;
}

// ---------- Photos pour l'anniversaire du groupe ----------
// Même logique que le site : une légende évoquant le groupe, plusieurs personnes citées,
// et une date récente donnent un meilleur score ; on garde la photo d'ensemble de l'année la mieux notée.
async function pickGroupPhoto() {
  const KW = ['ensemble', 'groupe', 'equipe', 'famille', 'tous', 'tout le monde', 'bureau', 'membres', 'reunion', 'seance', 'sortie', 'fondat', 'promotion', 'labdiens', 'cohesion', 'rencontre', 'photo de groupe', 'fete'];
  const end = Date.now(), start = end - 365 * 86400000;
  const score = (legende, date) => {
    const t = norm(legende);
    if (!t || t.includes('logo')) return -1;
    let sc = 0;
    KW.forEach(k => { if (t.includes(k)) sc += 6; });
    const people = (t.match(/,|&| et /g) || []).length + 1;
    sc += Math.min(people, 8) * 1.5;
    if (date) sc += Math.max(0, Math.min(1, (date - start) / (end - start))) * 3;
    return sc;
  };
  const medias = await get('medias', []);
  const seedHidden = await get('seed-hidden', []);
  const cand = [];
  const photos = (medias || []).filter(m => m.photo && !m.video);
  photos.forEach(m => { const d = m.date || 0; if (!d || d >= start) cand.push({ src: m.photo, legende: m.legende, sc: score(m.legende, d) }); });
  if (!cand.length) photos.forEach(m => cand.push({ src: m.photo, legende: m.legende, sc: score(m.legende, m.date) }));
  const seedBlock = (html.match(/seedGallery:\s*\[([\s\S]*?)\n\s*\]/) || [])[1] || '';
  [...seedBlock.matchAll(/legende:\s*"([^"]*)"\s*,\s*src:\s*"([^"]*)"/g)].forEach((m, i) => {
    if (!seedHidden.includes(i)) cand.push({ src: m[2], legende: m[1], sc: score(m[1], 0) - 0.5 });
  });
  return cand.filter(c => c.sc >= 0).sort((a, b) => b.sc - a.sc)[0] || null;
}

// Pièce jointe intégrée au mail : photo envoyée depuis le site (data:), hébergée (https) ou présente dans le dépôt.
function attachment(src, cid, name) {
  if (!src) return null;
  if (/^(data:|https?:)/.test(src)) return { filename: name, path: src, cid };
  const f = path.resolve(path.dirname(INDEX), src);
  return fs.existsSync(f) ? { filename: path.basename(f), path: f, cid } : null;
}

function groupMail(yrs, today, photo, logoSrc, to) {
  const an = `${yrs} an${yrs > 1 ? 's' : ''}`;
  const titre = today ? `🎂 LABD fête ses ${an} aujourd'hui ! 🎉` : `🎈 Demain, LABD fête ses ${an} !`;
  const phAtt = photo ? attachment(photo.src, 'photo-ensemble', 'labd-ensemble.jpg') : null;
  const lgAtt = attachment(logoSrc || 'images/visuel_labd_01.jpg', 'logo-labd', 'logo-labd.jpg');
  const attachments = [phAtt, lgAtt].filter(Boolean);
  const body = `
<div style="max-width:560px; margin:0 auto; font-family:Arial,Helvetica,sans-serif; color:#0b1c33; border:1px solid #dfe6ea; border-radius:14px; overflow:hidden;">
  <div style="background:#0b1c33; padding:14px 18px; color:#ffffff;">
    ${lgAtt ? '<img src="cid:logo-labd" width="40" height="40" style="border-radius:50%; vertical-align:middle; margin-right:10px;" alt="">' : ''}
    <span style="font-size:18px; font-weight:bold; vertical-align:middle;">LABD Org</span>
  </div>
  ${phAtt ? '<img src="cid:photo-ensemble" style="display:block; width:100%; height:auto;" alt="LABD ensemble">' : ''}
  <div style="padding:22px 20px; text-align:center;">
    <div style="font-size:24px; font-weight:bold; color:#048b98;">${titre}</div>
    <p style="font-size:15px; line-height:1.5;">Ensemble depuis le 16 octobre 2025 ! Merci à chacun de vous : c'est grâce à toute la famille LABD que le groupe grandit.</p>
    <p style="font-size:15px; line-height:1.5;">👉 Rendez-vous sur le site pour fêter ça ensemble : un message d'anniversaire s'affiche à l'ouverture, avec un bouton pour le partager sur WhatsApp.</p>
    <a href="${SITE}" style="${BTN}">🎉 Aller sur le site LABD</a>
  </div>
  <div style="background:#f6f8f9; padding:10px 16px; color:#888; font-size:12px; text-align:center;">Message automatique du site LABD. Merci de ne pas répondre à ce message.</div>
</div>`;
  return { label: 'Anniversaire du groupe', subject: today ? `🎂 LABD fête ses ${an} !` : `🎈 Demain, LABD fête ses ${an} !`, html: body, to, attachments, photo: photo && photo.legende };
}

const mails = []; // { label, subject, html, to:[emails], attachments? }

// ---------- Anniversaires des membres : un mail à tous les membres du groupe ----------
for (const g of groups.values()) {
  const now = g.people.filter(m => m.nom && m.anniv === todayK);
  const next = g.people.filter(m => m.nom && m.anniv === tomorrowK);
  if (!now.length && !next.length) continue;
  // Chaque membre reçoit le mail, sauf pour sa propre fête (la surprise reste entière).
  const buckets = new Map();
  for (const r of recipientsOf(g)) {
    const n = now.filter(x => norm(x.nom) !== norm(r.nom)), t = next.filter(x => norm(x.nom) !== norm(r.nom));
    if (!n.length && !t.length) continue;
    const k = JSON.stringify([n.map(x => x.nom), t.map(x => x.nom)]);
    if (!buckets.has(k)) buckets.set(k, { n, t, to: [] });
    buckets.get(k).to.push(r.email);
  }
  for (const b of buckets.values()) {
    mails.push({ label: g.label, subject: '🎂 RAPPEL ANNIVERSAIRE', html: memberMailBody(g.label, b.n, b.t), to: b.to, lignes: [b.n.map(x => shownPlain(x)), b.t.map(x => shownPlain(x))] });
  }
}

// ---------- Anniversaire du groupe LABD (16 octobre) : mail à tous les membres, avec la photo d'ensemble ----------
const gKey = `${pad(FOUNDED.m)}-${pad(FOUNDED.d)}`;
const gToday = todayK === gKey || process.env.TEST_GROUP === '1';
const gTomorrow = !gToday && tomorrowK === gKey;
if (gToday || gTomorrow) {
  const years = (gToday ? nowBj : tomorrowBj).getUTCFullYear() - FOUNDED.y;
  if (years >= 1 || process.env.TEST_GROUP === '1') {
    const photo = await pickGroupPhoto();
    let logo = null;
    try { logo = await get('group-logo', null); } catch (e) { /* le logo du dépôt servira */ }
    const all = [], seen = new Set();
    for (const g of groups.values()) for (const r of recipientsOf(g)) { const k = r.email.toLowerCase(); if (!seen.has(k)) { seen.add(k); all.push(r.email); } }
    if (all.length) mails.push(groupMail(Math.max(1, years), gToday, photo, logo, all));
  }
}

console.log(`Date ${todayK} : ${mails.length} mail(s) à envoyer.`);
if (!mails.length) process.exit(0);

if (DRY) {
  for (const m of mails) {
    console.log('[TEST]', m.label, '|', m.subject, '| destinataires :', m.to.length,
      m.lignes ? JSON.stringify(m.lignes) : '',
      m.photo ? '| photo choisie : ' + m.photo : '',
      m.attachments ? '| pièces jointes : ' + m.attachments.length : '');
  }
  process.exit(0);
}

const nodemailer = (await import('nodemailer')).default;
const transport = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});
// L'envoi se fait en copie cachée, par paquets de 90 : personne ne voit les adresses des autres.
for (const m of mails) {
  for (const part of chunk(m.to, 90)) {
    await transport.sendMail({
      from: `"LABD Org" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      bcc: part.join(','),
      subject: m.subject,
      html: m.html,
      attachments: m.attachments || []
    });
  }
  console.log('Envoyé :', m.label, `(${m.to.length} destinataire(s))`);
}
