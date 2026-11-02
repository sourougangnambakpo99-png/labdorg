// Rappel quotidien des anniversaires : lit les données du site (Firestore, lecture publique comme le site),
// puis envoie un mail au bureau de chaque promotion concernée, via Gmail.
import fs from 'node:fs';
import nodemailer from 'nodemailer';

const INDEX = process.env.INDEX_PATH || 'index.html';
const DRY = process.env.DRY_RUN === '1';
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
const nowBj = new Date(Date.now() + 3600 * 1000);
const key = d => String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
const todayK = key(nowBj), tomorrowK = key(new Date(nowBj.getTime() + 86400000));

const groups = new Map(); // libellé -> { emails:Set, now:[], next:[] }
const grp = (label) => { if (!groups.has(label)) groups.set(label, { emails: new Set(), now: [], next: [] }); return groups.get(label); };
const okEmail = e => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// Promotion fondatrice : membres ajoutés et modifications ; les adresses d'origine servent de filet.
const founders = [];
Object.entries(overrides).forEach(([num, o]) => { if (!removed.includes(num)) founders.push(o); });
extra.forEach(m => { if (!removed.includes(m.num)) founders.push(m); });
const gF = grp('Promotion fondatrice');
fallbackEmails.forEach(e => gF.emails.add(e));
founders.forEach(m => { if (m.cat === 'bureau' && okEmail(m.email)) gF.emails.add(m.email); });
founders.forEach(m => { if (m.nom && m.anniv === todayK) gF.now.push(m.nom); if (m.nom && m.anniv === tomorrowK) gF.next.push(m.nom); });

for (const p of Object.values(promotions)) {
  const label = p.nom + (p.annee ? ' ' + p.annee : '');
  const g = grp(label);
  (p.bureau || []).forEach(m => { if (okEmail(m.email)) g.emails.add(m.email); });
  (p.bureau || []).concat(p.membres || []).forEach(m => {
    if (!m.nom) return;
    if (m.anniv === todayK) g.now.push(m.nom);
    if (m.anniv === tomorrowK) g.next.push(m.nom);
  });
}

const jobs = [...groups.entries()].filter(([, g]) => (g.now.length || g.next.length) && g.emails.size);
console.log(`Date ${todayK} : ${jobs.length} mail(s) à envoyer.`);
if (!jobs.length) process.exit(0);

const transport = DRY ? null : nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});

for (const [label, g] of jobs) {
  const lignes = [];
  if (g.now.length) lignes.push('<b>Anniversaire aujourd\'hui</b> : ' + g.now.join(', '));
  if (g.next.length) lignes.push('<b>Anniversaire demain</b> : ' + g.next.join(', '));
  const body = `Bonjour,<br><br>${lignes.join('<br>')}<br><br><span style="color:#888; font-size:12px;">Rappel automatique du site LABD (${label}). Merci de ne pas répondre à ce message.</span>`;
  if (DRY) { console.log('[TEST]', label, [...g.emails], lignes); continue; }
  await transport.sendMail({
    from: `"LABD Org" <${process.env.GMAIL_USER}>`,
    to: [...g.emails].join(','),
    subject: 'RAPPEL ANNIVERSAIRE',
    html: body
  });
  console.log('Envoyé :', label);
}
