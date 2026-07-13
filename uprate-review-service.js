/**
 * UpRate · שירות תגובות אוטומטי לביקורות — גרסת מולטי-טננט
 * ════════════════════════════════════════════════════════════════
 * הרעיון בפשטות:
 *   כל לקוח של UpRate מגדיר פעם אחת כלל בגימייל שלו: "כל מייל
 *   מגוגל על ביקורת חדשה — העבר לכתובת שלי ב-UpRate".
 *   מאותו רגע, בכל פעם שנכנסת ביקורת חדשה ללקוח:
 *     1. המייל מגיע אוטומטית לשרת הזה
 *     2. השרת מזהה איזה לקוח זה (לפי כתובת היעד)
 *     3. מחלץ את הביקורת (שם, כוכבים, טקסט)
 *     4. Claude מנסח תשובה בעברית
 *     5. הלקוח מקבל התראה במייל עם התשובה המוכנה + קישור לפרסום
 *     6. הכול נשמר בדשבורד האישי של הלקוח
 *
 * אין OAuth, אין גישה לתיבות של לקוחות, אין אימות CASA של גוגל.
 * רק מייל שמועבר לשרת שלנו.
 *
 * הרצה: node uprate-review-service.js   (Node 18+, אפס תלויות)
 * ════════════════════════════════════════════════════════════════
 */

import http from "http";
import fs from "fs";

const PORT = process.env.PORT || 3000;
const DB_FILE = "./customers-data.json";

const CONFIG = {
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY, model: "claude-sonnet-5" },
  // שירות שליחת מייל להתראות (SendGrid / Mailgun / Postmark).
  // אם ריק — ההתראה תודפס ללוג במקום להישלח, והשירות עדיין עובד.
  emailApi: { key: process.env.EMAIL_API_KEY, from: "reviews@uprate.app" },
  autoReplyThreshold: 4, // 4★+ → "מוכן לפרסום"; מתחת → "כדאי לבדוק"
  baseUrl: process.env.BASE_URL || `http://localhost:${PORT}`,
};

// ── מאגר לקוחות + ביקורות (קובץ JSON פשוט, אפשר להחליף ב-DB) ──────
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { customers: seedCustomers(), reviews: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// לקוח לדוגמה — אתה. כל לקוח מקבל inboxId ייחודי לכתובת ההעברה.
function seedCustomers() {
  return {
    menachem: {
      name: "מנחם",
      businessName: "המסעדה היהודית",
      notifyEmail: "minachw@gmail.com",
      contactLine: "אפשר ליצור איתנו קשר ישיר ונדאג לך אישית",
    },
  };
}

// ── חילוץ פרטי הביקורת מגוף המייל (זהה ללוגיקה שבנינו) ───────────
function parseReview(subject, body) {
  const cleanSubj = subject.replace(/^(Fwd:|נ:|Re:)\s*/gi, "").trim();
  const subjMatch = cleanSubj.match(/^(.+?)\s+כתב\/ה ביקורת על\s+(.+)$/);
  const reviewer = subjMatch ? subjMatch[1].trim() : "הלקוח";

  const starsMatch = body.match(/דירוג של\s*(\d+)\s*כוכב/);
  const stars = starsMatch ? parseInt(starsMatch[1], 10) : 0;

  let text = "";
  const afterName = body.split(reviewer).pop() || body;
  const textMatch = afterName.match(/([\s\S]*?)כתיבת תגובה לביקורת/);
  if (textMatch) {
    text = textMatch[1]
      .replace(/\(Translated by Google\)/g, "")
      .replace(/\(Original\)[\s\S]*/g, "")
      .replace(/<https?:\/\/[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const linkMatch = body.match(
    /כתיבת תגובה לביקורת\s*<?(https:\/\/business\.google\.com\/[^\s>]+)/
  );
  const replyLink = linkMatch ? linkMatch[1] : null;

  return { reviewer, stars, text, replyLink };
}

// ── ניסוח תשובה עם Claude ───────────────────────────────────────
async function draftReply(review, customer) {
  const tone =
    review.stars >= CONFIG.autoReplyThreshold
      ? "הודה בחום, הזכר פרט ספציפי אחד מהביקורת, והזמן לחזור."
      : `התנצל בכנות ובלי להתגונן, קח אחריות, והצע ליצור קשר ישיר (${customer.contactLine}). אל תתווכח.`;

  const prompt = `אתה עונה בשם בעל העסק "${customer.businessName}" לביקורת ב-Google.
כתוב תשובה קצרה בעברית תקנית, 2–3 משפטים, בטון אנושי וחם.
הנחיה לפי הדירוג: ${tone}
פנה ללקוח בשמו.

ביקורת (${review.stars} כוכבים) מאת ${review.reviewer}:
"${review.text || "(ללא טקסט, רק דירוג)"}"

החזר אך ורק את נוסח התשובה — בלי מרכאות ובלי הקדמות.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropic.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CONFIG.anthropic.model,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// ── שליחת התראה במייל ללקוח ─────────────────────────────────────
async function notifyCustomer(customer, review, reply, customerId) {
  const link = `${CONFIG.baseUrl}/dashboard?c=${customerId}`;
  const subject = `⭐ ביקורת חדשה (${review.stars}★) — התשובה מוכנה`;
  const html = `
    <div dir="rtl" style="font-family:Arial;max-width:520px">
      <h2>קיבלת ביקורת חדשה על ${customer.businessName}</h2>
      <p><b>${review.reviewer}</b> · ${review.stars} כוכבים</p>
      <p style="color:#555">${review.text || "(רק דירוג)"}</p>
      <p><b>תשובה מוכנה מ-UpRate:</b><br>${reply}</p>
      <p><a href="${link}" style="background:#0F766E;color:#fff;padding:10px 18px;
         border-radius:8px;text-decoration:none">פתח בדשבורד ופרסם</a></p>
    </div>`;

  if (!CONFIG.emailApi.key) {
    console.log(`\n📧 [התראה ל-${customer.notifyEmail}] ${subject}\n${reply}\n→ ${link}`);
    return;
  }
  // דוגמה מול שירות מייל כללי (התאם ל-SendGrid/Mailgun/Postmark שתבחר)
  await fetch("https://api.emailprovider.example/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.emailApi.key}`,
    },
    body: JSON.stringify({ from: CONFIG.emailApi.from, to: customer.notifyEmail, subject, html }),
  }).catch((e) => console.error("notify failed:", e.message));
}

// ── עיבוד מייל נכנס (הלב של המערכת) ──────────────────────────────
async function handleInboundEmail({ to, subject, body }) {
  const db = loadDB();

  // מזהים את הלקוח לפי כתובת היעד: cust_ID@in.uprate.app  או  inbox+ID@...
  const local = (to || "").split("@")[0];
  const customerId = local.includes("+") ? local.split("+")[1] : local;
  const customer = db.customers[customerId];
  if (!customer) { console.warn(`לקוח לא מזוהה: ${to}`); return; }

  const review = parseReview(subject || "", body || "");
  if (!review.stars) { console.warn("לא זוהתה ביקורת במייל"); return; }

  const reply = await draftReply(review, customer);
  const record = {
    id: Date.now().toString(),
    customerId,
    ...review,
    reply,
    status: review.stars >= CONFIG.autoReplyThreshold ? "מוכן" : "לבדיקה",
    published: false,
    createdAt: new Date().toISOString(),
  };
  db.reviews.unshift(record);
  saveDB(db);

  await notifyCustomer(customer, review, reply, customerId);
  console.log(`✓ עובד: ${review.reviewer} (${review.stars}★) ← ${customer.businessName}`);
}

// ── שרת HTTP: webhook נכנס + דשבורד + מסך הגדרה ──────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, CONFIG.baseUrl);

  // (1) נקודת קצה למייל נכנס — שירות המייל שולח לכאן POST
  if (req.method === "POST" && url.pathname === "/inbound") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        const p = JSON.parse(raw || "{}");
        // תומך בשמות שדות נפוצים של ספקי מייל נכנס
        await handleInboundEmail({
          to: p.to || p.recipient || p.envelope?.to,
          subject: p.subject || p.Subject,
          body: p.text || p["body-plain"] || p.TextBody || p.plain || "",
        });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });
    return;
  }

  // (2) דשבורד אישי ללקוח
  if (url.pathname === "/dashboard") {
    const cid = url.searchParams.get("c");
    const db = loadDB();
    const customer = db.customers[cid];
    if (!customer) { res.writeHead(404); res.end("לקוח לא נמצא"); return; }
    const items = db.reviews.filter((r) => r.customerId === cid);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboard(customer, items));
    return;
  }

  // (3) מסך הגדרה — מסביר ללקוח איך להעביר את המיילים
  if (url.pathname === "/setup") {
    const cid = url.searchParams.get("c") || "YOUR_ID";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSetup(cid));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<div dir="rtl" style="font-family:Arial;padding:40px">UpRate Review Service פועל ✓</div>');
});

server.listen(PORT, () => console.log(`UpRate review service → ${CONFIG.baseUrl}`));

// ── תצוגת הדשבורד (RTL עברית) ───────────────────────────────────
function renderDashboard(customer, items) {
  const rows = items.map((r) => `
    <article style="background:#fff;border:1px solid #E6E8EC;border-radius:14px;padding:16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>${r.reviewer} · ${"★".repeat(r.stars)}<span style="color:#ccc">${"★".repeat(5 - r.stars)}</span></b>
        <span style="font-size:12px;padding:4px 10px;border-radius:999px;
          background:${r.status === "מוכן" ? "#E4F3EA;color:#178048" : "#FBEAE7;color:#D8452F"}">
          ${r.published ? "פורסם ✓" : r.status}</span>
      </div>
      <p style="color:#555;font-size:14px">${r.text || "(רק דירוג)"}</p>
      <div style="background:#FBFBFC;border-right:3px solid #0F766E;border-radius:10px;padding:12px">
        <div style="font-size:12px;color:#888;margin-bottom:6px">תשובה מוכנה:</div>
        <div id="t${r.id}">${r.reply}</div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button onclick="navigator.clipboard.writeText(document.getElementById('t${r.id}').innerText)"
          style="border:1px solid #E6E8EC;background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer">העתק תשובה</button>
        ${r.replyLink ? `<a href="${r.replyLink}" target="_blank"
          style="background:#0F766E;color:#fff;border-radius:8px;padding:8px 14px;text-decoration:none">פתח בגוגל ופרסם</a>` : ""}
      </div>
    </article>`).join("");

  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>UpRate · ${customer.businessName}</title></head>
    <body style="font-family:Arial;background:#F4F5F7;margin:0;padding:24px">
    <div style="max-width:640px;margin:0 auto">
      <h1 style="margin:0 0 4px">הביקורות של ${customer.businessName}</h1>
      <p style="color:#666;margin:0 0 20px">כל ביקורת חדשה מקבלת תשובה מוכנה. בדוק, ופרסם בלחיצה.</p>
      ${rows || '<p style="color:#888">עדיין אין ביקורות. ברגע שתגיע אחת — היא תופיע כאן.</p>'}
    </div></body></html>`;
}

// ── תצוגת מסך ההגדרה ללקוח ──────────────────────────────────────
function renderSetup(cid) {
  const address = `cust_${cid}@in.uprate.app`;
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>חיבור UpRate</title></head>
    <body style="font-family:Arial;background:#F4F5F7;margin:0;padding:24px">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">
      <h1>חיבור בלחיצה אחת</h1>
      <p>כדי ש-UpRate יגיב לביקורות שלך אוטומטית, צריך פעם אחת להגדיר בגימייל
         שהמיילים של גוגל על ביקורות יועברו אלינו:</p>
      <ol style="line-height:2">
        <li>בגימייל: הגדרות ← מסננים ← "יצירת מסנן חדש"</li>
        <li>בשדה <b>מאת</b> כתוב: <code>businessprofile-noreply@google.com</code></li>
        <li>לחץ "יצירת מסנן" ובחר <b>העבר אל</b> את הכתובת:</li>
      </ol>
      <div style="background:#E4F1EF;border-radius:10px;padding:14px;text-align:center;
        font-size:18px;font-weight:bold;color:#0F766E">${address}</div>
      <p style="color:#666;margin-top:18px">זהו. מרגע זה, כל ביקורת חדשה תקבל תשובה מוכנה
         שתחכה לך במייל ובדשבורד.</p>
    </div></body></html>`;
}

export { handleInboundEmail, parseReview, draftReply };
