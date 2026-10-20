require('dotenv').config()
const express = require('express')
const crypto = require('crypto')
const Groq = require('groq-sdk')

const app = express()
app.use(express.urlencoded({ extended: false, limit: '5mb' }))
app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = buf } }))

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// One model for everything. Change it in Railway with GROQ_MODEL if you ever need to.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
const REASONING = /gpt-oss/.test(MODEL)

// gpt-oss "thinks" before it answers, and that thinking uses up the token limit.
// With a tiny limit the answer comes back empty, so every limit is multiplied here.
async function groqCreate(params) {
  const p = { ...params, model: MODEL }
  if (p.max_tokens) { p.max_completion_tokens = Math.max(p.max_tokens * 4, 300); delete p.max_tokens }
  if (REASONING) p.reasoning_effort = 'low'
  return groq.chat.completions.create(p)
}

// ================= SETTINGS YOU MAY CHANGE =================
const TRIAL_DAYS = 14
const PLANS = {
  pro: { monthly: 850, yearly: 8700 },
  premium: { monthly: 2630, yearly: 26900 }
}
const TIPS_PRO_ONLY = false        // true = daily tips only for Pro and trial users
const MAX_MESSAGES_PER_DAY = 80    // per phone number, protects your AI bill
const ONLINE_PAYMENTS = false      // false = bank transfer only. Set true later if Paystack goes live
const PREMIUM_OPEN = true          // true = Premium can be bought. false = waitlist only
const BANK = {
  bank: process.env.BANK_NAME || 'United Bank for Africa (UBA)',
  accountName: process.env.BANK_ACCOUNT_NAME || 'MAMAPLUS TECHNOLOGIES LTD',
  accountNumber: process.env.BANK_ACCOUNT_NUMBER || '1031617872'
}
// ===========================================================

const DAY = 24 * 60 * 60 * 1000
const sessions = {}
const dirty = new Set()
const mediaReplied = new Map()  // phone -> date we last told her we only read text
const nurseWindow = new Map()   // phone -> time (ms) until we treat her as a nurse applicant
const payWindow = new Map()     // phone -> time (ms) until we treat her photos as payment receipts
const NURSE_WINDOW_HOURS = 72

// ---------------- small helpers ----------------
const mask = p => '***' + String(p).slice(-4)
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const naira = n => '₦' + Number(n).toLocaleString('en-NG')
function nigeriaNow() {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' })
}
function markDirty(phone) { dirty.add(phone) }
const isPaidPlan = s => s.plan === 'pro' || s.plan === 'premium'
const proActive = s => isPaidPlan(s) && s.planEnd && Date.parse(s.planEnd) > Date.now()
const trialActive = s => !isPaidPlan(s) && s.trialEnd && Date.parse(s.trialEnd) > Date.now()
const planName = s => (s.plan === 'premium' ? 'Premium' : 'Pro')
const tierName = t => (t === 'premium' ? 'Premium' : 'Pro')

function newSession(extra = {}) {
  return Object.assign({
    messages: [], name: null, weeksPregnant: null, currentWeek: null, ancDate: null,
    conditions: null, medications: [], onboardingComplete: false,
    registrationDate: new Date().toISOString().split('T')[0],
    consent: false, consentAt: null, flow: null, flowAt: null,
    plan: 'none', trialStart: null, trialEnd: null, planStart: null, planEnd: null,
    premiumWaitlist: false, paused: false, flowData: null, babyBorn: null, email: null, payNudge: null, sent: {},
    messageCount: 0, activeDays: 0, lastActiveDay: null, lastActive: null,
    dayCount: { date: null, n: 0 }, aiCount: 0, source: 'bot'
  }, extra)
}

// ---------------- Supabase (saves users so a restart loses nothing) ----------------
const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_KEY
const dbOn = !!(SB_URL && SB_KEY)
let dbReady = false            // true once saved users have been loaded
const loadedPhones = new Set()

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function toRow(phone, s) {
  return {
    phone,
    data: s,
    onboarding_complete: !!s.onboardingComplete,
    plan: s.plan || 'none',
    plan_end: s.planEnd || null,
    trial_end: s.trialEnd || null,
    last_active: s.lastActive || null,
    message_count: s.messageCount || 0,
    active_days: s.activeDays || 0,
    premium_waitlist: !!s.premiumWaitlist,
    source: s.source || 'bot',
    updated_at: new Date().toISOString()
  }
}

async function flushDirty() {
  if (!dbOn || !dbReady || dirty.size === 0) return
  const phones = [...dirty].filter(p => sessions[p])
  dirty.clear()
  try {
    await sb('users?on_conflict=phone', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: phones.map(p => toRow(p, sessions[p]))
    })
  } catch (e) {
    console.error('Save failed:', e.message)
    phones.forEach(p => dirty.add(p))
  }
}

function mergeLoaded(phone, row) {
  if (loadedPhones.has(phone)) return
  loadedPhones.add(phone)
  const db = newSession(row.data || {})
  const mem = sessions[phone]
  if (mem) {
    // she messaged while Supabase was unreachable: keep her saved profile and add the new messages
    db.messages = [...(db.messages || []), ...(mem.messages || [])].slice(-30)
    db.messageCount = (db.messageCount || 0) + (mem.messageCount || 0)
    db.lastActive = mem.lastActive || db.lastActive
    if (mem.consent) db.consent = true
    markDirty(phone)
  }
  sessions[phone] = db
}

async function loadSessions() {
  if (!dbOn) { console.log('⚠️ Supabase is not set up: running in memory only, users will be lost on restart'); return }
  let offset = 0
  let count = 0
  while (true) {
    const rows = await sb(`users?select=phone,data&order=phone&limit=1000&offset=${offset}`)
    if (!rows || rows.length === 0) break
    rows.forEach(r => { mergeLoaded(r.phone, r); count++ })
    if (rows.length < 1000) break
    offset += 1000
  }
  dbReady = true
  console.log(`✅ Loaded ${count} users from Supabase`)
}

// payments: Supabase if available, otherwise memory
const memPayments = {}   // always kept, so payments still work if Supabase is down
async function tryDb(fn) {
  if (!dbOn || !dbReady) return undefined
  try { return await fn() } catch (e) { console.error('Payments database problem, using memory:', e.message); return undefined }
}
const payStore = {
  async save(row) {
    memPayments[row.reference] = { ...row }
    await tryDb(() => sb('payments', { method: 'POST', prefer: 'return=minimal', body: row }))
  },
  async get(ref) {
    if (memPayments[ref]) return memPayments[ref]
    const r = await tryDb(() => sb(`payments?reference=eq.${encodeURIComponent(ref)}&select=*`))
    return r && r[0]
  },
  async update(ref, patch) {
    if (memPayments[ref]) Object.assign(memPayments[ref], patch)
    await tryDb(() => sb(`payments?reference=eq.${encodeURIComponent(ref)}`, { method: 'PATCH', prefer: 'return=minimal', body: patch }))
  },
  async latestSuccess(phone) {
    const r = await tryDb(() => sb(`payments?phone=eq.${phone}&status=eq.success&order=paid_at.desc&limit=1&select=*`))
    if (r && r[0]) return r[0]
    return Object.values(memPayments).filter(p => p.phone === phone && p.status === 'success').pop()
  },
  async latestPending(phone) {
    const r = await tryDb(() => sb(`payments?phone=eq.${phone}&status=eq.pending&order=created_at.desc&limit=1&select=*`))
    if (r && r[0]) return r[0]
    return Object.values(memPayments).filter(p => p.phone === phone && p.status === 'pending').pop()
  }
}

// ---------------- WhatsApp sending ----------------
async function sendWhatsAppMessage(phone, message) {
  const url = `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: process.env.ULTRAMSG_TOKEN,
        to: `+${String(phone).replace(/\D/g, '')}`,
        body: message
      })
    })
    const data = await response.json()
    if (data.error) {
      console.error(`❌ Send to ${mask(phone)} FAILED:`, JSON.stringify(data.error))
      if (/stopped|non-payment/i.test(String(data.error))) {
        console.error('⚠️ YOUR ULTRAMSG INSTANCE IS STOPPED. Renew your UltraMsg subscription or nobody receives messages.')
      }
      return false
    }
    console.log(`Sent to ${mask(phone)}`)
    return true
  } catch (err) {
    console.error('Send failed:', err.message)
    return false
  }
}

async function say(phone, session, text, remember = false) {
  if (remember && session) {
    session.messages.push({ role: 'assistant', content: text })
    markDirty(phone)
  }
  return sendWhatsAppMessage(phone, text)
}

async function notifyStaff(text) {
  if (!process.env.CARE_PROVIDER_WHATSAPP) {
    console.error('⚠️ CARE_PROVIDER_WHATSAPP is not set: staff cannot be notified')
    return false
  }
  return sendWhatsAppMessage(process.env.CARE_PROVIDER_WHATSAPP, text)
}

async function notifyNurseAdmin(text) {
  const admin = process.env.NURSE_ADMIN_WHATSAPP || process.env.CARE_PROVIDER_WHATSAPP
  if (!admin) { console.error('⚠️ NURSE_ADMIN_WHATSAPP is not set: nurse applications cannot be forwarded'); return false }
  return sendWhatsAppMessage(admin, text)
}

async function handleNurseApplicant(phone, text, first) {
  nurseWindow.set(phone, Date.now() + NURSE_WINDOW_HOURS * 60 * 60 * 1000)
  if (first) {
    await sendWhatsAppMessage(phone,
      `Thank you for your interest in joining MamaPlus as a nurse 💚\n\n` +
      `If you have not filled our short form yet, please do: ${process.env.NURSE_FORM_LINK || 'https://mamaplus.ng'}\n` +
      `You can also send a clear photo of your nursing licence here. Our team will check your details with the NMCN and contact you.`)
    await notifyNurseAdmin(`👩‍⚕️ NEW NURSE APPLICATION from +${phone}\n\n${text.slice(0, 800)}`)
  } else {
    await notifyNurseAdmin(`💬 Nurse applicant +${phone}:\n${text.slice(0, 800)}`)
  }
}

async function alertCareProvider(phone, name, symptoms) {
  return notifyStaff(
    `🚨 MamaPlus HIGH RISK ALERT\n\n` +
    `Patient: ${name || 'Unknown'}\n` +
    `Phone: +${phone}\n` +
    `Reported: "${symptoms}"\n\n` +
    `Patient advised to go to hospital immediately.\n` +
    `Please follow up for active monitoring.\n\n` +
    `Note: Automated alert. No diagnosis made.`
  )
}

// ---------------- time parsing (fixed: needs am/pm or a colon) ----------------
function parseHour(timeStr) {
  if (!timeStr) return null
  const str = timeStr.toLowerCase().trim()
  const match = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  if (!match) return null
  if (!match[3] && !match[2]) return null
  let hour = parseInt(match[1])
  const meridiem = match[3]
  if (meridiem === 'pm' && hour !== 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour < 0 || hour > 23) return null
  return hour
}

// ---------------- danger keywords (always run, even if the AI is down) ----------------
const NEGATION = /\b(no|not|without|never|don'?t have|do not have|haven'?t had|didn'?t have|nothing like)\s+(any\s+|much\s+|a\s+)?(\w+\s+)?(bleeding|bleed|fever|convulsions?|fits|headache|pain|swelling|contractions)\b/g
const DANGER_REGEX = new RegExp([
  '\\bbleed(ing)?\\b',
  "\\b(vomit(ing)?|passing|coughing|saw|see|seeing|there'?s|there is)\\s+(some\\s+)?blood\\b",
  "\\b(not moving|stopped moving|no (baby )?movement|no kicks?|not kicking|hasn'?t moved|doesn'?t move)\\b",
  '\\b(less|reduced|decreased)\\s+(baby\\s+)?(movement|kicks)\\b',
  '\\b(convuls\\w*|seizures?|fits)\\b',
  '\\b(faint(ed|ing)?|collapsed|unconscious|passed out|blacked? out)\\b',
  "\\b(blurr?(ed|y) vision|can'?t see|cannot see|vision problems?|seeing (spots|stars|flashing))\\b",
  '\\b(severe|terrible|very bad|unbearable|worst|sharp)\\s+(\\w+\\s+)?(headache|pain)\\b',
  "\\b(can'?t|cannot|difficulty|trouble|hard to|struggling to)\\s+breath",
  '\\bshort(ness)? of breath\\b',
  '\\bchest pain\\b',
  '\\bwaters? (has |have )?broke\\b',
  '\\bleaking (fluid|water)\\b',
  '\\bfever\\b',
  '\\b(swollen (face|hands)|(face|hands) (is |are )?swollen)\\b',
  '\\bcontractions\\b'
].join('|'), 'i')

function keywordDanger(text) {
  const t = String(text).toLowerCase().replace(NEGATION, ' ')
  return DANGER_REGEX.test(t)
}

// ---------------- what the user is asking for (service questions) ----------------
const NOT_PLAN = /(birth|delivery|labou?r|meal|diet|exercise|feeding|family|study|travel)\s+plans?/
function detectIntent(t) {
  if (/\b(i have paid|i paid|i've paid|already paid|just paid|paid already|payment (done|made|sent)|i made (the )?payment|i have made (the )?payment)\b/.test(t)) return 'paid'
  if (!/pregnan|weeks/.test(t) && (/\bnurse application\b|\b(register|apply|join|sign up|onboard)\b.{0,25}\b(as )?an? (nurse|midwife)\b|\bbecome an? (nurse|midwife)\b|\bnurse (registration|onboarding)\b|\b(i am|i'm|i’m) an? (registered |licensed |qualified )?(nurse|midwife)\b.{0,40}\b(join|register|apply|partner|work with|onboard)/.test(t))) return 'nurse_join'
  if (/\b(delete|remove|erase)\b.{0,20}\b(my )?(data|account|details|information|records|profile)\b/.test(t)) return 'delete_data'
  if (/\b(receipt|invoice|proof of payment)\b/.test(t)) return 'receipt'
  if (/^(stop|stop all|stop messages|pause|pause all|unsubscribe)[.! ]*$/.test(t)) return 'stop_all'
  if (/\b(premium|waitlist|wait list|drug wallet)\b/.test(t)) return 'premium'
  if (/\b(i want to pay|want to pay|how (do|can) i pay|pay now|make (a )?payment|payment link|send (me )?(the )?(payment|account)|account number|bank transfer|renew|upgrade|subscribe|subscription)\b/.test(t) ||
      /^(pay|payment|pay now)[.!? ]*$/.test(t) || /\bpro\b/.test(t) ||
      /\b(i wan( to)? pay|wan( to)? pay|how (i|we) go pay|make i pay|i wan subscribe|i wan upgrade)\b/.test(t)) return 'pro'
  if (/\b(14[- ]?days?|free trial|start (the |my )?trial|trial)\b/.test(t)) return 'trial'
  const t2 = t.replace(NOT_PLAN, ' ')
  if (/\b(plans?|pricing|prices?|packages?)\b/.test(t2) ||
      /how much (is|does|for)\b.{0,25}\b(it|pro|premium|plan|subscription|service|mama ?plus|trial)\b/.test(t) ||
      /\bhow much (do|does) (it|this) cost\b/.test(t) ||
      /\bhow much (e|it) (be|cost)\b|wetin be (the )?(price|plan)/.test(t)) return 'plans'
  if (/\b(cancel|refund|unsubscribe)\b/.test(t) && !/reminder|appointment|medication|tablet|drug/.test(t)) return 'cancel'
  if (/\b(my plan|plan status|when does my plan|expire|expiry|trial end)\b/.test(t2)) return 'status'
  if (/\b(want|wan|abeg|need|can i|could i|please|how (do|can) i|find|get|book|talk|speak|call|contact|connect|see|meet)\b.{0,30}\b(nurse|midwife)\b/.test(t) ||
      /\b(nurse|midwife) (near me|at home|visit)\b/.test(t) || /\bhome visits?\b/.test(t) || /\bvoice (call|access)\b/.test(t)) return 'nurse'
  if (/\b(talk|speak|connect|chat)\b.{0,15}\b(human|person|someone|agent|team|staff)\b/.test(t) ||
      /\b(customer (care|service)|human agent|real person)\b/.test(t) || /^help[.! ]*$/.test(t)) return 'human'
  return null
}

// ---------------- fixed messages ----------------
const PLAN_MENU =
  `Here are the MamaPlus plans 💚\n\n` +
  `1. 14-Day Trial: free. Daily check-ins, danger-sign support, medication and antenatal reminders, and meet a licensed nurse.\n\n` +
  `2. Pro: ${naira(PLANS.pro.monthly)} a month or ${naira(PLANS.pro.yearly)} a year. Everything in the trial, plus live nurse voice access and tips for your pregnancy week.\n\n` +
  (PREMIUM_OPEN
    ? `3. Premium: ${naira(PLANS.premium.monthly)} a month or ${naira(PLANS.premium.yearly)} a year. Everything in Pro, plus a verified drug wallet for you and your baby. Reply 3 to get Premium.\n\n`
    : `3. Premium (coming soon): ${naira(PLANS.premium.monthly)} a month or ${naira(PLANS.premium.yearly)} a year. A verified drug wallet for you and your baby. Reply 3 to join the waitlist.\n\n`) +
  `Payment is by bank transfer.\n\n` +
  `Reply 1, 2 or 3.`

function emergencyMessage(alerted) {
  return `I am concerned about what you describe. Please go to the nearest hospital or clinic right now, or ask someone near you to take you. Do not wait.` +
    (alerted ? `\nOur care team has been alerted.` : `\nIf you can, call someone close to you now.`)
}

// ---------------- AI helpers ----------------
async function detectRisk(userMessage, userName, weeksPregnant) {
  try {
    const result = await groqCreate({
      messages: [
        {
          role: 'system',
          content: `You are a maternal health risk detector.
Read a pregnant woman's message and decide if it describes a potential medical emergency or danger sign requiring prompt hospital attention.

YES examples: heavy or any vaginal bleeding, severe or sudden headache, blurred vision, reduced or no baby movement, swelling of face or hands, difficulty breathing, high fever, fits or convulsions, fainting, severe abdominal pain, fluid leaking, vomiting blood, signs of preeclampsia, infection or labour complications.

NO examples: mild tiredness, mild nausea, a mild headache alone, normal swollen feet at the end of the day, general questions, greetings, questions about plans, payment or nurses.

Reply with ONLY one word: YES or NO.`
        },
        {
          role: 'user',
          content: `Patient: ${userName || 'Unknown'}, ${weeksPregnant || 'unknown weeks'} pregnant.\nMessage: "${userMessage}"`
        }
      ],
      max_tokens: 5,
      temperature: 0,
    })
    const answer = (result.choices[0].message.content || '').trim().toUpperCase()
    if (!answer) return null
    return answer.includes('YES')
  } catch (e) {
    console.error('Risk detection error:', e.message)
    return null // unknown, keyword check still protects her
  }
}

async function extractProfileData(conversation, today) {
  try {
    const result = await groqCreate({
      messages: [
        {
          role: 'system',
          content: `You are a data extractor. Today's date is ${today}. Read the conversation and extract profile data.
Return ONLY a JSON object with these fields (use null if not found):
{
  "name": "first name if mentioned",
  "weeksPregnant": "number only e.g 28",
  "ancDate": "date in YYYY-MM-DD format if mentioned. If no year is given, use the next occurrence of that date on or after today. Never return a date before today.",
  "conditions": "health conditions mentioned e.g hypertension, diabetes, or none",
  "babyBorn": "YYYY-MM-DD only if she says her baby has already been born, else null",
  "medications": [
    {
      "name": "medication name",
      "hour": hour_as_number_0_to_23_or_null,
      "durationDays": number_of_days_or_null_if_ongoing,
      "stopped": true_if_user_said_they_stopped_or_no_longer_take_it_else_false
    }
  ],
  "onboardingComplete": true or false
}
Set onboardingComplete to true only when name, weeksPregnant, ancDate, conditions are all present AND medications question has been asked and answered.
Return pure JSON only. No explanation. No markdown.`
        },
        { role: 'user', content: JSON.stringify(conversation.slice(-10)) }
      ],
      max_tokens: 300,
      temperature: 0,
    })
    const text = result.choices[0].message.content.trim()
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch (e) {
    console.error('Profile extraction error:', e.message)
    return null
  }
}

async function sendDailyTip(phone, name, week, conditions, newborn) {
  try {
    const topics = [
      'baby development and size this week',
      'nutrition and the best foods to eat today',
      'common symptoms and how to manage them',
      'sleep, rest and relaxation tips',
      'mental health and emotional wellbeing',
      'safe exercise and gentle movement',
      'preparing for birth and what to expect soon'
    ]
    const todayTopic = topics[new Date().getUTCDay()]
    const promptContent = newborn
      ? `Daily newborn care tip for ${name || 'a new mother'} whose baby is approximately ${week} weeks old. Topic: ${todayTopic}. Include one baby development fact, one feeding tip, and one self-care reminder for the mother. Keep it warm, practical and under 5 lines.`
      : `Daily pregnancy tip for ${name || 'a pregnant woman'} at week ${week} of pregnancy. Health conditions: ${conditions || 'none'}. Topic: ${todayTopic}. Include one specific fact about week ${week}, one practical tip related to today's topic, and one action she can take today. Keep it warm and under 5 lines.`

    const completion = await groqCreate({
      messages: [
        {
          role: 'system',
          content: `You are MamaPlus, a warm maternal health assistant for pregnant women in Nigeria.
Generate a short daily tip that is specific, warm and practical.
Maximum 5 lines.
Start with a relevant emoji and her name.
Make the tip specific to her exact pregnancy week — not generic advice.
End with one clear action she can take today.
Never diagnose. Never prescribe. Keep language simple and encouraging.`
        },
        { role: 'user', content: promptContent }
      ],
      max_tokens: 180,
      temperature: 0.8,
    })
    const tip = (completion.choices[0].message.content || '').trim()
    if (!tip) { console.error('Daily tip came back empty'); return }
    const ok = await sendWhatsAppMessage(phone, tip)
    console.log(`Daily tip ${ok ? 'sent' : 'NOT sent'} to ${mask(phone)}, week ${week}`)
  } catch (e) {
    console.error('Daily tip error:', e.message)
  }
}

const SYSTEM_PROMPT = `
You are MamaPlus, a warm maternal health assistant for pregnant women in Nigeria.

STYLE:
- One question at a time during onboarding
- Warm, simple English
- Max 1 emoji per message
- Never diagnose or prescribe
- For simple greetings or yes/no responses — keep it short (1-2 lines)
- For health questions, symptoms, nutrition, baby development, or medication questions — give a FULL detailed helpful answer (up to 8 lines). Do not cut explanations short. Women need complete information.
- For danger signs — be brief and urgent (3 lines max)
- Always end detailed answers with one practical tip or action they can take today

SCOPE — only discuss:
- Pregnancy health and stages
- Maternal nutrition and lifestyle
- Antenatal care and appointments
- Baby development and movement
- Warning signs and when to seek care
- Medication education — explain what medications do, their purpose and common side effects
- Medication reminders and adherence
- Postpartum recovery and newborn care
- General women's health
- The MamaPlus service itself: plans, trial, payment and nurses. If asked about these, say briefly: "Reply PLANS to see plans, PAY to pay, or NURSE to reach a nurse." Never invent prices.

MEDICATION EDUCATION RULES:
- You CAN explain what any medication is for and its common side effects
- You CAN say if a medication is generally considered safe in pregnancy
- You CANNOT tell a user what dose to take
- You CANNOT tell a user to stop or change their prescribed medication
- Always end medication explanations with: "Always follow your doctor's instructions for your specific prescription."

OUT OF SCOPE — anything unrelated to pregnancy, maternal health or the MamaPlus service:
Reply exactly: "I can help with pregnancy and maternal health, and with your MamaPlus plan, payment or nurse. What would you like to know? 😊"
Short replies like thanks, ok, yes, no, or an answer to your own question are NOT out of scope. Answer them naturally.

HANDLING INDIRECT OR VAGUE ANSWERS:
- If user gives a vague answer like "I am very far gone" for weeks — ask kindly for the number of weeks
- If user says "I don't know" for ANC date — say no problem and move to the next question
- If user goes off topic emotionally like "my husband is stressing me" — acknowledge warmly then gently connect it back to pregnancy health
- If user gives an unrelated answer — acknowledge it briefly then re-ask the question warmly
- Never make the user feel bad for not answering directly

ONBOARDING — collect these 5 things one at a time. Never skip or move on until each answer is complete and clear:

1. First name — if user says hi or hello first, greet them then ask their name

2. Weeks pregnant — if they say "a few months" or vague answer, ask for the number of weeks specifically

3. Next antenatal appointment date — accept any format like "July 10" or "10th July" or "next Friday". If they say "I don't know" — say "No problem, I will remind you to find out from your clinic. Let's continue."

4. Health conditions — ask: "Do you have any health conditions like high blood pressure or diabetes? Or just say none." If vague — ask to clarify.

5. Medications:
   - Ask: "Do you take any medications like iron tablets or folic acid?"
   - If YES — ask one question at a time:
     a. "What is the name of the medication?"
     b. "What time do you take it? For example 8am or 2pm." If vague like "morning" ask for exact time.
     c. "How many days or weeks are you supposed to take it? Or say ongoing if it has no end date."
   - Do NOT move on until you have medication name, time AND duration.
   - If NO medications — accept and move on.

After all 5 complete — send a warm confirmation of their full profile in 2-3 lines and tell them they can ask anything anytime.

STOPPING MEDICATIONS:
- If user says they no longer take a medication, stopped taking it, finished it, or doctor said to stop — confirm warmly
- Reply: "Understood! I have stopped your [medication name] reminder. Well done! 💚"

AFTER ONBOARDING:
- Answer based on their specific profile and pregnancy stage
- Give detailed practical advice — nutrition, symptoms, baby development, lifestyle, medications
- Keep onboarding answers brief but make health question answers thorough and complete
- Recommend clinic for any serious concern
- If user says "taken" or confirms medication — reply: "Great job! Staying consistent with your medication is great for your baby. 💚"
- If user seems worried or scared — be warm and reassuring first then give guidance

HIGH RISK — if user describes any danger sign or emergency:
Line 1: Acknowledge their concern briefly without diagnosing
Line 2: "Please go to hospital or clinic immediately."
Do NOT say anyone has been notified. The system adds that itself when it is true.
`

// ---------------- consent ----------------
async function askConsent(phone, session) {
  session.flow = 'consent'
  session.flowAt = Date.now()
  markDirty(phone)
  const contact = process.env.CONTACT_EMAIL ? ` Questions or deletion requests: ${process.env.CONTACT_EMAIL}.` : ''
  await sendWhatsAppMessage(phone,
    `Welcome to MamaPlus 💚\n\n` +
    `To support you, we save your pregnancy details (name, weeks, appointment date, health conditions, medicines) and your recent messages. ` +
    `If you report a danger sign, we share your name, number and message with our care team. ` +
    `Your messages are processed by AI and WhatsApp service providers. We never sell your data.${contact}\n\n` +
    `Reply YES to agree and continue, or NO to stop.`)
}

// ---------------- plans and payment ----------------
function bankDetailsText(phone, amount, label) {
  payWindow.set(phone, Date.now() + 24 * 60 * 60 * 1000)
  return (
    `We currently accept payment by bank transfer only 💚\n\n` +
    `Amount: ${naira(amount)} (${label})\n\n` +
    `🏦 Bank: ${BANK.bank}\n` +
    `👤 Account name: ${BANK.accountName}\n` +
    `🔢 Account number: ${BANK.accountNumber}\n\n` +
    `After you pay, send a screenshot of your receipt here, or reply PAID. ` +
    `Our team will confirm and activate your plan, usually within a few hours.\n\n` +
    `Please check that the account name above matches before you send.`
  )
}

async function startTrial(phone, session) {
  if (session.trialStart) {
    if (trialActive(session)) await say(phone, session, `Your free trial is active until ${fmtDate(session.trialEnd)}. Reply PRO to continue after that.`)
    else await say(phone, session, `Your free trial has ended. Reply PRO to continue with live nurse voice access and weekly tips.`)
    return
  }
  const now = new Date()
  session.trialStart = now.toISOString()
  session.trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY).toISOString()
  if (session.plan === 'none' || session.plan === 'free') session.plan = 'trial'
  markDirty(phone)
  const intro = process.env.NURSE_INTRO ? `\n\nMeet your nurse: ${process.env.NURSE_INTRO}` : ''
  await say(phone, session,
    `Your ${TRIAL_DAYS}-day trial has started 💚 It runs until ${fmtDate(session.trialEnd)}. ` +
    `You get daily check-ins, danger-sign support, medication and antenatal reminders, and a nurse introduction.${intro}`)
  if (!session.consent) await askConsent(phone, session)
  else if (!session.onboardingComplete) await aiReply(phone, session, 'Hi')
}

async function startPro(phone, session, lower, tier = 'pro') {
  const period = /year|annual/.test(lower) ? 'yearly' : /month/.test(lower) ? 'monthly' : null
  if (period) return createAndSendPayment(phone, session, period, tier)
  session.flow = 'billing'
  session.flowAt = Date.now()
  session.flowData = { tier }
  markDirty(phone)
  const P = PLANS[tier]
  const active = proActive(session) ? `Your ${planName(session)} plan is active until ${fmtDate(session.planEnd)}. Paying now adds more time.\n\n` : ''
  const blurb = tier === 'premium'
    ? `MamaPlus Premium includes everything in Pro plus a verified drug wallet.\n\n`
    : `MamaPlus Pro includes live nurse voice access and tips for your pregnancy week.\n\n`
  await say(phone, session,
    `${active}${blurb}` +
    `How would you like to pay?\n1. Monthly: ${naira(P.monthly)}\n2. Yearly: ${naira(P.yearly)} (saves ${naira(P.monthly * 12 - P.yearly)})\n\nReply 1 or 2.`)
}

async function createAndSendPayment(phone, session, period, tier = 'pro') {
  session.flow = null
  session.flowData = null
  markDirty(phone)
  const amount = PLANS[tier][period]
  const label = `MamaPlus ${tierName(tier)}, ${period}`

  if (!ONLINE_PAYMENTS || !process.env.PAYSTACK_SECRET_KEY) {
    await say(phone, session, bankDetailsText(phone, amount, label))
    await notifyStaff(`💳 ${tier.toUpperCase()} payment request (bank transfer)\nPatient: ${session.name || 'Unknown'}\nPhone: +${phone}\nPlan: ${tier} ${period} (${naira(amount)})\nWatch your bank app for this amount.`)
    return
  }

  const reference = `MP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const email = session.email || `${phone}@mamaplus.ng`
  try {
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, amount: amount * 100, currency: 'NGN', reference,
        metadata: { phone, plan: tier, period }
      })
    })
    const data = await res.json()
    if (!data.status) throw new Error(data.message || 'Paystack refused')
    await payStore.save({
      reference, phone, plan: tier, period, amount_kobo: amount * 100,
      status: 'pending', created_at: new Date().toISOString()
    })
    session.payNudge = { reference, at: Date.now() + DAY }
    markDirty(phone)
    await say(phone, session,
      `Here is your secure Paystack link for ${label.replace(', ', ' (')}, ${naira(amount)}):\n${data.data.authorization_url}\n\n` +
      `I will message you here as soon as your payment is confirmed. If you have any problem, reply HELP.`)
  } catch (e) {
    console.error('Payment creation failed:', e.message)
    await say(phone, session, `Sorry, I could not create your payment link. I have asked our team to help you.`)
    await notifyStaff(`💳 Payment link FAILED\nPhone: +${phone}\nPlan: ${tier} ${period}\nError: ${e.message}`)
  }
}

async function paystackVerify(reference) {
  try {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    })
    const data = await res.json()
    return data.status ? data.data : null
  } catch (e) {
    console.error('Paystack verify error:', e.message)
    return null
  }
}

async function confirmPayment(reference) {
  const pay = await payStore.get(reference)
  if (!pay) return { ok: false, reason: 'unknown' }
  if (pay.status === 'success') return { ok: true, already: true }
  const v = await paystackVerify(reference)
  if (!v || v.status !== 'success') return { ok: false, reason: 'not_success' }
  if (Number(v.amount) !== Number(pay.amount_kobo)) {
    await notifyStaff(`⚠️ Payment amount mismatch\nReference: ${reference}\nExpected: ${pay.amount_kobo}\nPaid: ${v.amount}`)
    return { ok: false, reason: 'amount' }
  }
  await payStore.update(reference, { status: 'success', paid_at: new Date().toISOString() })

  const phone = pay.phone
  if (!sessions[phone]) sessions[phone] = newSession()
  const s = sessions[phone]
  const tier = pay.plan === 'premium' ? 'premium' : 'pro'
  const now = Date.now()
  const base = s.planEnd && Date.parse(s.planEnd) > now ? Date.parse(s.planEnd) : now
  const days = pay.period === 'yearly' ? 365 : 30
  s.plan = tier
  if (!s.planStart) s.planStart = new Date().toISOString()
  s.planEnd = new Date(base + days * DAY).toISOString()
  s.flow = null
  s.payNudge = null
  payWindow.delete(phone)
  markDirty(phone)
  await say(phone, s,
    `Payment received, thank you 💚 Your MamaPlus ${tierName(tier)} plan is active until ${fmtDate(s.planEnd)}.\n` +
    `Reply NURSE any time to reach a nurse.`)
  await notifyStaff(`✅ ${tierName(tier)} payment received\nPhone: +${phone}\nPeriod: ${pay.period}\nRef: ${reference}`)
  return { ok: true }
}

function statusText(s) {
  if (proActive(s)) return `Your MamaPlus ${planName(s)} plan is active until ${fmtDate(s.planEnd)}.`
  if (trialActive(s)) {
    const left = Math.max(1, Math.ceil((Date.parse(s.trialEnd) - Date.now()) / DAY))
    return `Your free trial runs until ${fmtDate(s.trialEnd)} (${left} day${left === 1 ? '' : 's'} left). Reply PRO to continue after that.`
  }
  return `You are on the free level. Reply PLANS to see your options.`
}

async function handleIntent(phone, session, intent, lower) {
  switch (intent) {
    case 'plans':
      session.flow = 'plan_menu'; session.flowAt = Date.now(); markDirty(phone)
      return say(phone, session, PLAN_MENU)
    case 'stop_all':
      session.paused = true; markDirty(phone)
      return say(phone, session, `I have paused all reminders and daily messages 💚 You can still message me any time. Reply START to turn them back on. To stop only one medicine reminder, tell me its name.`)
    case 'delete_data':
      session.flow = 'confirm_delete'; session.flowAt = Date.now(); markDirty(phone)
      return say(phone, session, `I can delete your details and messages from MamaPlus. This also stops all reminders. We keep payment records for accounting. Reply DELETE to confirm, or ignore this message to keep everything.`)
    case 'receipt': {
      const pay = await payStore.latestSuccess(phone)
      if (!pay) {
        await say(phone, session, `I do not see a completed payment for this number yet. If you paid, reply PAID and I will check, or reply HELP.`)
        return
      }
      await say(phone, session,
        `Here is your payment confirmation 💚\nPlan: MamaPlus ${tierName(pay.plan)} (${pay.period})\nAmount: ${naira(pay.amount_kobo / 100)}\nReference: ${pay.reference}\nPaid: ${fmtDate(pay.paid_at || pay.created_at)}` +
        (session.planEnd ? `\nYour plan runs until ${fmtDate(session.planEnd)}.` : '') +
        `\nIf you need a formal receipt, I have asked our team to send it.`)
      return notifyStaff(`🧾 Receipt request\nPhone: +${phone}\nReference: ${pay.reference}`)
    }
    case 'nurse_join':
      return say(phone, session,
        `Thank you for your interest in joining MamaPlus as a nurse 💚 Please fill in our short form: ${process.env.NURSE_FORM_LINK || 'https://mamaplus.ng'}\nWe will check your licence with the NMCN and contact you on WhatsApp.`)
    case 'trial':
      return startTrial(phone, session)
    case 'pro':
      return startPro(phone, session, lower, proActive(session) && session.plan === 'premium' ? 'premium' : 'pro')
    case 'premium':
      if (PREMIUM_OPEN) return startPro(phone, session, lower, 'premium')
      session.premiumWaitlist = true; session.flow = null; markDirty(phone)
      return say(phone, session,
        `You are on the Premium waitlist 💚 It is not open yet, so no payment is needed. Premium will include everything in Pro plus a verified drug wallet (${naira(PLANS.premium.monthly)} a month or ${naira(PLANS.premium.yearly)} a year). We will message you when it opens.`)
    case 'paid': {
      const pay = await payStore.latestPending(phone)
      if (pay) {
        const r = await confirmPayment(pay.reference)
        if (!r.ok) await say(phone, session, `I cannot see your payment yet. Banks can take a few minutes. Please wait 5 minutes and reply PAID again. If it still fails, reply HELP.`)
        return
      }
      // bank transfer: no automatic check, so staff confirm
      payWindow.set(phone, Date.now() + 24 * 60 * 60 * 1000)
      await say(phone, session,
        `Thank you 💚 Please send a screenshot of your transfer receipt here so our team can confirm it. ` +
        `Once confirmed, I will message you that your plan is active.`)
      return notifyStaff(`💳 Says PAID (bank transfer)\nPatient: ${session.name || 'Unknown'}\nPhone: +${phone}\nCheck your bank app, then activate:\n/admin/activate?key=YOUR_KEY&phone=${phone}&tier=pro&period=monthly\n(change tier=premium or period=yearly if needed)`)
    }
    case 'cancel':
      await say(phone, session,
        `MamaPlus never charges you automatically. Your plan simply ends on its end date, and you pay again only if you choose. ` +
        (proActive(session) ? `Your ${planName(session)} plan stays active until ${fmtDate(session.planEnd)}. ` : '') +
        `If you need a refund, I have asked our team to contact you.`)
      return notifyStaff(`↩️ Cancel/refund request\nPhone: +${phone}\nPlan: ${session.plan}`)
    case 'status':
      return say(phone, session, statusText(session))
    case 'nurse': {
      let text
      if (proActive(session)) {
        text = `Your ${planName(session)} plan includes live nurse voice access. ` + (process.env.NURSE_CONTACT ? process.env.NURSE_CONTACT : `I have told our team, and a nurse will contact you on this number.`)
      } else if (trialActive(session)) {
        text = `During your trial, a MamaPlus nurse introduces herself to you. ` + (process.env.NURSE_INTRO || `Our team will message you shortly.`) +
          `\n\nFor live nurse voice access, upgrade to Pro (${naira(PLANS.pro.monthly)} a month). Reply PRO and I will send the bank details.`
      } else {
        text = `Live nurse voice access is part of our Pro plan (${naira(PLANS.pro.monthly)} a month). Reply PRO and I will send the bank details. I have also told our team.`
      }
      await say(phone, session, text)
      return notifyStaff(`📞 Nurse request\nPatient: ${session.name || 'Unknown'}\nPhone: +${phone}\nPlan: ${session.plan}`)
    }
    case 'human': {
      const ok = await notifyStaff(`🙋 Asked for a person\nPatient: ${session.name || 'Unknown'}\nPhone: +${phone}`)
      return say(phone, session,
        (ok ? `I have asked a team member to message you.` : `I could not reach our team right now, but your message is saved.`) +
        ` If this is an emergency, please go to the nearest hospital now.`)
    }
  }
}

async function handleFlow(phone, session, lower) {
  if (['plan_menu', 'billing', 'confirm_delete', 'med_time', 'med_which'].includes(session.flow)) {
    if (session.flowAt && Date.now() - session.flowAt > 30 * 60 * 1000) { session.flow = null; markDirty(phone); return false }
  }
  if (session.flow === 'confirm_delete') {
    if (/^(delete|yes delete|confirm|yes)\b/.test(lower)) { await deleteUserData(phone); return true }
    session.flow = null; markDirty(phone)
    await say(phone, session, `OK, I have not deleted anything.`)
    return true
  }
  if (session.flow === 'med_which') {
    const found = session.medications.find(m => lower.includes(m.name.toLowerCase()))
    if (!found) { session.flow = null; session.flowData = null; markDirty(phone); return false }
    const hour = parseHour(lower)
    if (hour === null) {
      session.flow = 'med_time'; session.flowAt = Date.now(); session.flowData = { name: found.name }; markDirty(phone)
      await say(phone, session, `What new time do you want for your ${found.name}? For example 8am or 9pm.`, true)
      return true
    }
    applyMedTime(session, found, found.name, hour, null)
    session.flow = null; session.flowData = null; markDirty(phone)
    await say(phone, session, `Done 💚 I will remind you to take your ${found.name} at ${fmtHour(hour)} every day.`, true)
    return true
  }
  if (session.flow === 'med_time') {
    const fd = session.flowData || {}
    const hour = parseHour(lower)
    if (hour === null) {
      fd.tries = (fd.tries || 0) + 1
      session.flowData = fd
      if (fd.tries >= 2) { session.flow = null; session.flowData = null; markDirty(phone); return false }
      await say(phone, session, `Please include am or pm, for example 8am or 9pm.`)
      return true
    }
    const existing = session.medications.find(m => m.name.toLowerCase() === String(fd.name).toLowerCase())
    applyMedTime(session, existing, fd.name, hour, fd.durationDays)
    session.flow = null; session.flowData = null; markDirty(phone)
    await say(phone, session, `Done 💚 I will remind you to take your ${fd.name} at ${fmtHour(hour)} every day.`, true)
    return true
  }
  if (session.flow === 'consent') {
    if (/^(yes|y|ok|okay|i agree|agree|yes please|sure)\b/.test(lower)) {
      session.consent = true
      session.consentAt = new Date().toISOString()
      session.flow = null
      session.messages.push({ role: 'user', content: 'Hi' })
      markDirty(phone)
      await say(phone, session, `Thank you 💚 Let's set you up. What is your first name?`, true)
      return true
    }
    if (/^(no|n|nope|i do not agree|disagree)\b/.test(lower)) {
      session.flow = null
      markDirty(phone)
      await say(phone, session, `No problem. We will not save your details. You can message us any time. In an emergency, go to the nearest hospital.`)
      return true
    }
    return false
  }
  if (session.flow === 'plan_menu') {
    if (lower === '1') { session.flow = null; await startTrial(phone, session); return true }
    if (lower === '2') { await startPro(phone, session, '', 'pro'); return true }
    if (lower === '3') { await handleIntent(phone, session, 'premium', lower); return true }
    return false
  }
  if (session.flow === 'billing') {
    const tier = (session.flowData && session.flowData.tier) === 'premium' ? 'premium' : 'pro'
    if (/^(1|monthly|month)\b/.test(lower)) { await createAndSendPayment(phone, session, 'monthly', tier); return true }
    if (/^(2|yearly|year|annual)\b/.test(lower)) { await createAndSendPayment(phone, session, 'yearly', tier); return true }
    if (/^(no|cancel|stop|back)\b/.test(lower)) { session.flow = null; session.flowData = null; markDirty(phone); await say(phone, session, `No problem. Reply PLANS any time.`); return true }
    return false
  }
  return false
}

// ---------------- understanding what she wants (any wording, English or Pidgin) ----------------
function fmtHour(h) { const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}:00 ${h < 12 ? 'am' : 'pm'}` }

function applyMedTime(session, existing, name, hour, durationDays) {
  const today = nigeriaNow().date
  const endDate = durationDays ? new Date(Date.now() + durationDays * DAY).toISOString().split('T')[0] : null
  if (existing) {
    existing.hour = hour; existing.active = true; existing.takenToday = false; existing.pendingFollowUp = false
    if (endDate) existing.endDate = endDate
    return existing
  }
  const med = { name, hour, takenToday: false, pendingFollowUp: false, followUpHour: null, startDate: today, endDate, active: true }
  session.medications.push(med)
  return med
}

async function deleteUserData(phone) {
  delete sessions[phone]
  dirty.delete(phone)
  if (dbOn) {
    try { await sb(`users?phone=eq.${phone}`, { method: 'DELETE', prefer: 'return=minimal' }) }
    catch (e) {
      console.error('Delete failed:', e.message)
      await notifyStaff(`⚠️ Data deletion FAILED for +${phone}. Please delete her row in Supabase.`)
    }
  }
  console.log(`Deleted data for ${mask(phone)}`)
  await sendWhatsAppMessage(phone, `Done. I have deleted your details and messages. We keep payment records for accounting. You can message MamaPlus again any time.`)
}

function routerPrompt(today, meds) {
  return `You read ONE WhatsApp message from a pregnant woman in Nigeria (English or Pidgin). Decide whether she is asking the MamaPlus bot to DO something. Today is ${today}.
Her current medicine reminders: ${meds.length ? meds.join(', ') : 'none'}.

Return ONLY a JSON object, no explanation:
{"action":"chat","confident":false,"medication":null,"hour":null,"durationDays":null,"date":null,"weeks":null,"name":null}

Actions:
- chat: health questions, feelings, greetings, answers to questions, anything unclear. This is the default.
- add_med: she says she has started, or is taking, a NEW medicine, or wants a reminder for a medicine she does not have yet. Fill medication (null if she did not name it), and hour (0-23) and durationDays if she said them.
- set_med: she wants to change the time of a medicine reminder she ALREADY has. Fill medication, and hour (0-23) if she said it.
- stop_med: she clearly wants a medicine reminder stopped. Fill medication if she named it.
- update_anc: she gives a new antenatal appointment date. Put it in date as YYYY-MM-DD (the next occurrence on or after today).
- update_weeks: she corrects how many weeks pregnant she is. Put the number in weeks.
- baby_born: her baby has been born. Put the birth date in date, or null for today.
- change_name: she wants her name changed. Put it in name.
- pause_all: she wants all messages or reminders stopped.
- delete_data: she wants her data or account deleted.
- receipt: she wants a receipt, invoice or proof of payment.
- plans: asks about prices or plans. pay: wants to pay or subscribe. trial: wants the free trial. premium: Premium or the waitlist. paid: says she has already paid. nurse: wants to talk to or find a nurse. human: wants a person from the team. cancel: wants to cancel or get a refund. status: asks when her plan ends.
- service_other: she asks the MamaPlus service to do something else that is not a health question and not listed above.

Rules: A question such as "should I stop my iron?" or "is it safe to take X?" is chat. Set confident to true only when you are sure. If unsure, use chat.`
}

async function routeWithAI(text, session, today) {
  try {
    const meds = (session.medications || []).filter(m => m.active).map(m => m.name)
    const result = await groqCreate({
      messages: [{ role: 'system', content: routerPrompt(today, meds) }, { role: 'user', content: text }],
      max_tokens: 150,
      temperature: 0,
    })
    const r = JSON.parse(result.choices[0].message.content.trim().replace(/```json|```/g, '').trim())
    return r && r.confident === true ? r : null
  } catch (e) {
    return null
  }
}

const ACTION_TO_INTENT = {
  plans: 'plans', pay: 'pro', trial: 'trial', premium: 'premium', nurse: 'nurse', human: 'human',
  cancel: 'cancel', status: 'status', paid: 'paid', receipt: 'receipt', pause_all: 'stop_all', delete_data: 'delete_data'
}

async function setMedication(phone, session, r, text) {
  const active = session.medications.filter(m => m.active)
  let name = (r.medication || '').trim()
  if (!name) {
    if (active.length === 1) name = active[0].name
    else if (active.length > 1) {
      session.flow = 'med_which'; session.flowAt = Date.now(); markDirty(phone)
      await say(phone, session, `Which medicine do you want to change: ${active.map(m => m.name).join(', ')}? You can also tell me the new time, for example "iron 9pm".`, true)
      return true
    } else {
      await say(phone, session, `You have no medicine reminders yet. Tell me the medicine and the time you take it, for example "folic acid 8am".`, true)
      return true
    }
  }
  const existing = session.medications.find(m => m.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(m.name.toLowerCase()))
  const hour = (Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23) ? r.hour : parseHour(text)
  if (hour === null) {
    session.flow = 'med_time'; session.flowAt = Date.now(); markDirty(phone)
    session.flowData = { name: existing ? existing.name : name, durationDays: r.durationDays || null }
    await say(phone, session, `What time do you take your ${existing ? existing.name : name}? For example 8am or 9pm.`, true)
    return true
  }
  const medName = existing ? existing.name : name
  applyMedTime(session, existing, medName, hour, r.durationDays || null)
  markDirty(phone)
  await say(phone, session, `Done 💚 I will remind you to take your ${medName} at ${fmtHour(hour)} every day.`, true)
  return true
}

async function runAction(phone, session, r, text) {
  const today = nigeriaNow().date
  const mapped = ACTION_TO_INTENT[r.action]
  if (mapped) { await handleIntent(phone, session, mapped, text.toLowerCase()); return true }

  if (r.action === 'service_other') {
    await say(phone, session, `I am not sure I can do that myself, so I have asked our team to help you. They will message you here.`, true)
    await notifyStaff(`❓ Request the bot could not handle\nPatient: ${session.name || 'Unknown'}\nPhone: +${phone}\nMessage: "${text.slice(0, 400)}"`)
    return true
  }

  // profile changes only make sense once onboarding is finished
  if (!session.onboardingComplete) return false

  switch (r.action) {
    case 'add_med': {
      if (!(r.medication || '').trim()) {
        await say(phone, session, `Happy to add it 💚 What is the name of the new medicine, and what time do you take it? For example "folic acid 8am".`, true)
        return true
      }
      return setMedication(phone, session, r, text)
    }
    case 'set_med':
      return setMedication(phone, session, r, text)
    case 'stop_med': {
      const name = (r.medication || '').toLowerCase()
      const meds = session.medications.filter(m => m.active && (!name || m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase())))
      if (meds.length === 0) { await say(phone, session, `I could not find that medicine in your reminders. Which one do you mean?`, true); return true }
      if (!name && meds.length > 1) { await say(phone, session, `Which reminder should I stop: ${meds.map(m => m.name).join(', ')}?`, true); return true }
      meds.forEach(m => { m.active = false })
      markDirty(phone)
      await say(phone, session, `Done 💚 I have stopped your ${meds.map(m => m.name).join(', ')} reminder. If you are stopping the medicine itself because of side effects, please tell your doctor or pharmacist first.`, true)
      return true
    }
    case 'update_anc': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || r.date < today) {
        await say(phone, session, `Please tell me the date of your next antenatal appointment again, for example 10 December.`, true)
        return true
      }
      session.ancDate = r.date
      markDirty(phone)
      await say(phone, session, `Your next antenatal appointment is saved for ${fmtDate(r.date)} 💚 I will remind you 2 days before, the day before and on the day.`, true)
      return true
    }
    case 'update_weeks': {
      const w = parseInt(r.weeks)
      if (!(w >= 1 && w <= 44)) return false
      session.weeksPregnant = String(w)
      session.registrationDate = today
      markDirty(phone)
      await say(phone, session, `Thank you, I have updated you to week ${w} 💚`, true)
      return true
    }
    case 'baby_born': {
      session.babyBorn = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : today
      session.ancDate = null
      markDirty(phone)
      await say(phone, session, `Congratulations 💚 I will now send newborn care tips and stop pregnancy appointment reminders.`, true)
      return true
    }
    case 'change_name': {
      const n = String(r.name || '').trim().slice(0, 40)
      if (!n) return false
      session.name = n
      markDirty(phone)
      await say(phone, session, `Done, I will call you ${n} 💚`, true)
      return true
    }
  }
  return false
}

// ---------------- the normal AI chat (pregnancy questions and onboarding) ----------------
const STOP_PHRASES = [
  'no longer take', 'stopped taking', 'i stopped', 'finished my',
  'doctor said stop', 'cancel reminder', 'stop reminder',
  'dont take anymore', "don't take anymore", 'i finished'
]
const TAKEN_PHRASES = ['taken', 'i have taken', 'already taken', 'yes i took', 'i took it', 'took it', 'took my']

async function aiReply(phone, session, userMessage) {
  const lower = userMessage.toLowerCase()

  if (STOP_PHRASES.some(p => lower.includes(p))) {
    session.medications.forEach(med => {
      if (lower.includes(med.name.toLowerCase())) { med.active = false; console.log(`Medication stopped by user for ${mask(phone)}`) }
    })
  }
  if (TAKEN_PHRASES.some(p => lower.includes(p)) && !/\b(not|haven'?t|have not|didn'?t|did not|never|yet)\b/.test(lower)) {
    const pending = (session.medications || []).find(m => m.pendingFollowUp)
    if (pending) { pending.takenToday = true; pending.pendingFollowUp = false }
  }

  session.messages.push({ role: 'user', content: userMessage })
  if (session.messages.length > 30) session.messages = session.messages.slice(-30)

  const [danger, completion, routed] = await Promise.all([
    detectRisk(userMessage, session.name, session.weeksPregnant),
    groqCreate({
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages.slice(-20)],
      max_tokens: 400,
      temperature: 0.7,
    }).catch(err => { console.error('Groq error:', err.message); return null }),
    routeWithAI(userMessage, session, nigeriaNow().date)
  ])

  // If she asked the bot to DO something, do it instead of sending a chat answer
  if (danger !== true && routed && routed.action && routed.action !== 'chat') {
    if (await runAction(phone, session, routed, userMessage)) { markDirty(phone); return }
  }

  if (!completion) {
    await sendWhatsAppMessage(phone, 'Sorry, something went wrong. Please try again.')
    return
  }

  let botReply = (completion.choices[0].message.content || '').trim()
  if (!botReply) {
    await sendWhatsAppMessage(phone, 'Sorry, something went wrong. Please try again.')
    return
  }

  if (danger === true) {
    const alerted = await alertCareProvider(phone, session.name, userMessage)
    botReply += alerted
      ? '\nOur care team has been alerted.'
      : '\nIf you can, ask someone near you to go with you to the hospital now.'
    console.log(`🚨 Danger detected by AI for ${mask(phone)}, alert ${alerted ? 'delivered' : 'NOT delivered'}`)
  }

  session.messages.push({ role: 'assistant', content: botReply })
  markDirty(phone)

  session.aiCount = (session.aiCount || 0) + 1
  if (session.aiCount % 4 === 0 || !session.onboardingComplete) {
    const today = nigeriaNow().date
    const extracted = await extractProfileData(session.messages, today)
    if (extracted) applyExtraction(phone, session, extracted, today)
  }

  await sendWhatsAppMessage(phone, botReply)
}

function applyExtraction(phone, session, extracted, today) {
  if (extracted.name) session.name = extracted.name
  if (extracted.weeksPregnant) session.weeksPregnant = extracted.weeksPregnant
  if (extracted.ancDate && /^\d{4}-\d{2}-\d{2}$/.test(extracted.ancDate) && extracted.ancDate >= today) session.ancDate = extracted.ancDate
  if (extracted.conditions) session.conditions = extracted.conditions
  if (extracted.babyBorn && /^\d{4}-\d{2}-\d{2}$/.test(extracted.babyBorn)) session.babyBorn = extracted.babyBorn
  if (extracted.onboardingComplete) session.onboardingComplete = true

  if (extracted.medications && extracted.medications.length > 0) {
    extracted.medications.forEach(med => {
      if (!med.name) return
      if (med.stopped) {
        const existing = session.medications.find(m => m.name.toLowerCase() === med.name.toLowerCase())
        if (existing) existing.active = false
        return
      }
      let hour = (med.hour !== null && med.hour !== undefined && med.hour >= 0 && med.hour <= 23) ? med.hour : null
      if (hour === null) {
        const recent = session.messages.filter(m => m.role === 'user').slice(-5).map(m => m.content).reverse()
        for (const msg of recent) {
          const parsed = parseHour(msg)
          if (parsed !== null) { hour = parsed; break }
        }
      }
      if (hour === null) { console.log(`⚠️ No time yet for a medication for ${mask(phone)}`); return }
      if (session.medications.find(m => m.name.toLowerCase() === med.name.toLowerCase())) return
      const startDate = new Date()
      const endDate = med.durationDays
        ? new Date(startDate.getTime() + med.durationDays * DAY).toISOString().split('T')[0]
        : null
      session.medications.push({
        name: med.name, hour, takenToday: false, pendingFollowUp: false, followUpHour: null,
        startDate: startDate.toISOString().split('T')[0], endDate, active: true
      })
      console.log(`💊 Medication saved for ${mask(phone)}`)
    })
  }
  markDirty(phone)
  console.log(`Profile updated for ${mask(phone)}: complete=${session.onboardingComplete}, meds=${session.medications.length}`)
}

// ---------------- message handling ----------------
function touch(s) {
  const { date } = nigeriaNow()
  s.lastActive = new Date().toISOString()
  s.messageCount = (s.messageCount || 0) + 1
  if (s.lastActiveDay !== date) { s.activeDays = (s.activeDays || 0) + 1; s.lastActiveDay = date }
  if (!s.dayCount || s.dayCount.date !== date) s.dayCount = { date, n: 0 }
  s.dayCount.n++
}

async function handleMessage(phone, text) {
  // Nurse applicants are handled first and never become mother users
  const lowerText = text.toLowerCase().trim()
  const applicantActive = (nurseWindow.get(phone) || 0) > Date.now()
  if (applicantActive && /\b(pregnan|my baby|my pregnancy)\b/.test(lowerText)) {
    nurseWindow.delete(phone) // she is also a mother: treat her as one again
  } else if (applicantActive || (detectIntent(lowerText) === 'nurse_join' && !(sessions[phone] && sessions[phone].onboardingComplete))) {
    await handleNurseApplicant(phone, text, !applicantActive)
    return
  }

  if (!sessions[phone]) sessions[phone] = newSession()
  const session = sessions[phone]
  touch(session)
  markDirty(phone)

  if (session.dayCount.n > MAX_MESSAGES_PER_DAY) {
    if (session.dayCount.n === MAX_MESSAGES_PER_DAY + 1) await sendWhatsAppMessage(phone, `You have reached today's message limit. Please message us again tomorrow. In an emergency, go to the nearest hospital.`)
    return
  }

  const lower = text.toLowerCase().trim()

  // 1. Danger words always come first
  if (keywordDanger(text)) {
    const alerted = await alertCareProvider(phone, session.name, text)
    const msg = emergencyMessage(alerted)
    session.messages.push({ role: 'user', content: text }, { role: 'assistant', content: msg })
    if (session.messages.length > 30) session.messages = session.messages.slice(-30)
    console.log(`🚨 Danger words from ${mask(phone)}, alert ${alerted ? 'delivered' : 'NOT delivered'}`)
    await sendWhatsAppMessage(phone, msg)
    return
  }

  if (session.paused && /^(start|resume|unpause|start again)[.! ]*$/.test(lower)) {
    session.paused = false; markDirty(phone)
    await say(phone, session, `Welcome back 💚 Reminders and daily messages are on again.`)
    return
  }

  // 2. Replies to a question the bot just asked (consent, plan menu, billing)
  if (await handleFlow(phone, session, lower)) return

  // 3. Plan, payment and nurse requests
  const intent = detectIntent(lower)
  if (intent) { await handleIntent(phone, session, intent, lower); return }

  // 4. Consent before collecting health details
  if (!session.consent) { await askConsent(phone, session); return }

  // 5. Normal pregnancy chat and onboarding
  await aiReply(phone, session, text)
}

app.post('/webhook', async (req, res) => {
  if (process.env.WEBHOOK_TOKEN && req.query.token !== process.env.WEBHOOK_TOKEN) return res.sendStatus(401)
  const body = req.body
  if (body.data?.fromMe) return res.sendStatus(200)
  const from = body.data?.from || ''
  if (from.includes('@g.us')) return res.sendStatus(200)
  const userMessage = body.data?.body?.trim()
  const userPhone = from.replace('@c.us', '').replace('+', '')
  const msgType = body.data?.type
  if (userPhone && ['image', 'video', 'ptt', 'audio', 'voice', 'document', 'sticker'].includes(msgType)) {
    res.sendStatus(200)
    if ((payWindow.get(userPhone) || 0) > Date.now()) {
      await notifyStaff(`🧾 Payment receipt (${msgType}) from +${userPhone}. Open the WhatsApp chat to view it, then activate her plan.`)
      await sendWhatsAppMessage(userPhone, `Receipt received 💚 Our team will confirm and activate your plan shortly.`)
    } else if ((nurseWindow.get(userPhone) || 0) > Date.now()) {
      await notifyNurseAdmin(`📎 Nurse applicant +${userPhone} sent a ${msgType}. Open the WhatsApp chat to view it.`)
    } else if (mediaReplied.get(userPhone) !== nigeriaNow().date) {
      mediaReplied.set(userPhone, nigeriaNow().date)
      await sendWhatsAppMessage(userPhone, `Thank you 💚 I can only read typed messages for now. Please type what you need and I will help.`)
    }
    return
  }
  if (!userMessage || !userPhone) return res.sendStatus(200)
  res.sendStatus(200)
  console.log(`📩 Message from ${mask(userPhone)}`)
  try {
    await handleMessage(userPhone, userMessage)
  } catch (e) {
    console.error('Handler error:', e.message)
  }
})

// ---------------- Paystack webhook ----------------
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
app.post('/paystack/webhook', async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY
  const sig = req.headers['x-paystack-signature']
  if (!secret || !sig || !req.rawBody) return res.sendStatus(400)
  const hash = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex')
  if (!safeEqual(hash, sig)) return res.sendStatus(401)
  res.sendStatus(200)
  try {
    const ev = req.body
    const ref = String(ev.data?.reference || '')
    if (ev.event === 'charge.success' && ref.startsWith('MP-')) await confirmPayment(ref)
  } catch (e) {
    console.error('Paystack webhook error:', e.message)
  }
})

// ---------------- scheduler (reminders) ----------------
function once(phone, s, key, date) {
  const k = `${key}|${date}`
  if (s.sent[k]) return false
  s.sent[k] = 1
  markDirty(phone)
  return true
}

async function runUserSchedule(phone, s, date, hour) {
  // clean up old "already sent" marks
  for (const k of Object.keys(s.sent)) if (!k.endsWith('|' + date)) { delete s.sent[k]; markDirty(phone) }

  if (s.paused) return
  const nm = s.name || 'mama'

  // payment nudge (one gentle reminder after 24 hours)
  if (s.payNudge && Date.now() > s.payNudge.at && hour >= 9 && hour <= 20) {
    const pay = await payStore.get(s.payNudge.reference)
    s.payNudge = null
    markDirty(phone)
    if (pay && pay.status === 'pending') {
      await sendWhatsAppMessage(phone, `Hi ${nm}, your payment link for MamaPlus is still waiting. Reply PRO for a new link, or HELP if you need a hand.`)
    }
  }

  // trial and plan reminders
  if (hour >= 9 && hour <= 20) {
    if (s.plan === 'trial' && s.trialEnd) {
      const left = Math.ceil((Date.parse(s.trialEnd) - Date.now()) / DAY)
      if ((left === 4 || left === 1) && once(phone, s, `trial${left}`, date)) {
        await sendWhatsAppMessage(phone, `Hi ${nm}, your free trial ends in ${left} day${left === 1 ? '' : 's'}. To keep live nurse voice access and weekly tips, reply PRO. Reply PLANS to see options.`)
      }
      if (left <= 0 && once(phone, s, 'trialend', date)) {
        s.plan = 'free'
        await sendWhatsAppMessage(phone, `Hi ${nm}, your free trial has ended. Reply PRO to continue with live nurse voice access and weekly tips.`)
      }
    }
    if (isPaidPlan(s) && s.planEnd) {
      const left = Math.ceil((Date.parse(s.planEnd) - Date.now()) / DAY)
      if ((left === 3 || left === 1) && once(phone, s, `pro${left}`, date)) {
        await sendWhatsAppMessage(phone, `Hi ${nm}, your MamaPlus ${planName(s)} plan ends in ${left} day${left === 1 ? '' : 's'}. Reply PAY to renew.`)
      }
      if (left <= 0 && once(phone, s, 'proend', date)) {
        const was = planName(s)
        s.plan = 'free'
        await sendWhatsAppMessage(phone, `Hi ${nm}, your MamaPlus ${was} plan has ended. Reply PAY to renew whenever you are ready.`)
      }
    }
  }

  if (!s.onboardingComplete) return

  // 1. morning check-in at 8AM
  if (hour === 8 && once(phone, s, 'checkin', date)) {
    await sendWhatsAppMessage(phone, `Good morning ${nm}! 🌅\nHow are you feeling today?\nAny headaches, swelling or unusual pain?`)
  }

  // 2. antenatal appointment reminders at 9AM
  if (hour === 9 && s.ancDate) {
    const diff = Math.round((Date.parse(s.ancDate) - Date.parse(date)) / DAY)
    if ([2, 1, 0].includes(diff) && once(phone, s, `anc${diff}`, date)) {
      const when = diff === 2 ? 'is in 2 days' : diff === 1 ? 'is TOMORROW' : 'is TODAY'
      await sendWhatsAppMessage(phone, `Hi ${nm}! 🏥\nYour antenatal appointment ${when}.\n${diff === 2 ? "Please don't forget to attend!" : diff === 1 ? 'Make sure you are prepared. 💚' : 'Please remember to go. Take care! 💚'}`)
    }
  }

  // 3. daily tip at 10AM
  if (hour === 10 && (s.weeksPregnant || s.babyBorn) && (!TIPS_PRO_ONLY || proActive(s) || trialActive(s)) && once(phone, s, 'tip', date)) {
    if (s.babyBorn) {
      const babyWeeks = Math.max(0, Math.floor((Date.now() - Date.parse(s.babyBorn)) / (7 * DAY)))
      sendDailyTip(phone, s.name, babyWeeks, s.conditions, true)
    } else {
      const daysPassed = s.registrationDate ? Math.floor((Date.now() - Date.parse(s.registrationDate)) / DAY) : 0
      const week = Math.min(parseInt(s.weeksPregnant) + Math.floor(daysPassed / 7), 42)
      s.currentWeek = week
      sendDailyTip(phone, s.name, week, s.conditions, false)
    }
  }

  // 4. medication reminders
  for (const med of (s.medications || [])) {
    if (!med.active) continue
    if (med.endDate && date > med.endDate) {
      med.active = false
      markDirty(phone)
      await sendWhatsAppMessage(phone, `Hi ${nm}! 🎉\nYour ${med.name} course is now complete.\nWell done for staying consistent! 💚`)
      continue
    }
    if (med.hour === hour && once(phone, s, `med:${med.name}`, date)) {
      await sendWhatsAppMessage(phone, `Hi ${nm}! 💊\nTime to take your ${med.name}.\nReply "taken" once you have taken it.`)
      med.pendingFollowUp = true
      med.followUpHour = (hour + 1) % 24
    }
    if (med.pendingFollowUp && med.followUpHour === hour && !med.takenToday && once(phone, s, `medfu:${med.name}`, date)) {
      await sendWhatsAppMessage(phone, `Just checking ${nm} 💊\nDid you take your ${med.name}?\nIt is important for you and your baby.`)
      med.pendingFollowUp = false
    }
  }

  // 5. reset medication status at midnight
  if (hour === 0 && once(phone, s, 'medreset', date)) {
    (s.medications || []).forEach(med => { med.takenToday = false; med.pendingFollowUp = false })
  }
}

let schedulerBusy = false
function startScheduler() {
  setInterval(async () => {
    if (schedulerBusy) return
    schedulerBusy = true
    try {
      const { date, hour } = nigeriaNow()
      for (const [phone, s] of Object.entries(sessions)) {
        try { await runUserSchedule(phone, s, date, hour) } catch (e) { console.error('Schedule error', mask(phone), e.message) }
      }
    } finally { schedulerBusy = false }
  }, 60 * 1000)
  console.log('✅ Scheduler started')
}

// ---------------- restore users from old Railway logs ----------------
function parseLogs(text) {
  const users = {}
  const get = p => (users[p] = users[p] || { phone: p, messages: 0, profile: null, week: null, meds: {} })
  let m
  const reFrom = /📩 From (\d{8,15}):/g
  while ((m = reFrom.exec(text))) get(m[1]).messages++

  const reProf = /Profile updated for (\d{8,15}):\s*\{([^}]*)\}/g
  while ((m = reProf.exec(text))) {
    const body = m[2]
    const val = k => {
      const r = new RegExp(k + ":\\s*(?:'([^']*)'|\"([^\"]*)\"|([^,\\s]+))").exec(body)
      const v = r ? (r[1] ?? r[2] ?? r[3]) : null
      return v === 'null' || v === undefined ? null : v
    }
    get(m[1]).profile = { name: val('name'), weeks: val('weeks'), anc: val('anc'), complete: val('complete') === 'true' }
  }

  const reTip = /Daily tip sent to (\d{8,15})\s+\S+\s+week (\d+)/g
  while ((m = reTip.exec(text))) get(m[1]).week = parseInt(m[2])

  const reMed = /Medication saved: (.+?) at (\d{1,2}):00\s+\S+\s+ends: (\S+) for (\d{8,15})/g
  while ((m = reMed.exec(text))) {
    get(m[4]).meds[m[1].toLowerCase()] = { name: m[1], hour: parseInt(m[2]), endDate: /^\d{4}-/.test(m[3]) ? m[3] : null, active: true }
  }
  const reStop = /Medication (?:stopped by user|course completed): (.+?) for (\d{8,15})/g
  while ((m = reStop.exec(text))) {
    const u = users[m[2]]
    if (u && u.meds[m[1].toLowerCase()]) u.meds[m[1].toLowerCase()].active = false
  }
  return Object.values(users)
}

function buildImported(u) {
  const today = nigeriaNow().date
  const p = u.profile || {}
  const complete = !!p.complete
  const now = new Date()
  const s = newSession({
    name: p.name || null,
    weeksPregnant: String(u.week || p.weeks || '') || null,
    ancDate: p.anc && p.anc >= today ? p.anc : null,
    onboardingComplete: complete,
    consent: true, consentAt: null,
    messageCount: u.messages || 0,
    source: 'log_import',
    medications: Object.values(u.meds).map(md => ({
      name: md.name, hour: md.hour, takenToday: false, pendingFollowUp: false, followUpHour: null,
      startDate: today, endDate: md.endDate, active: md.active
    }))
  })
  if (complete) {
    s.plan = 'trial'
    s.trialStart = now.toISOString()
    s.trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY).toISOString()
  }
  return s
}

function adminOk(req) { return !!process.env.ADMIN_KEY && req.query.key === process.env.ADMIN_KEY }

function importPage(key, logs, msg) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Import</title></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:720px;margin:20px auto;padding:0 12px">` +
    `<h2>Restore users from Railway logs</h2><p>${msg || 'Paste your Railway deploy logs, click Preview, then Save.'}</p>` +
    `<form method="post" action="/admin/import?key=${encodeURIComponent(key)}">` +
    `<textarea name="logs" rows="14" style="width:100%" placeholder="Paste logs here">${esc(logs || '')}</textarea><br><br>` +
    `<button name="action" value="preview">1. Preview (counts only)</button> ` +
    `<button name="action" value="save">2. Save to database</button></form></body></html>`
}

app.get('/admin/import', (req, res) => {
  if (!adminOk(req)) return res.sendStatus(401)
  res.send(importPage(req.query.key, '', ''))
})

app.post('/admin/import', async (req, res) => {
  if (!adminOk(req)) return res.sendStatus(401)
  const logs = req.body.logs || ''
  const found = parseLogs(logs)
  const fresh = found.filter(u => !sessions[u.phone])
  const summary = `Found ${found.length} users in the logs: ${found.filter(u => u.profile && u.profile.complete).length} finished onboarding, ` +
    `${found.reduce((n, u) => n + Object.keys(u.meds).length, 0)} medication reminders. ` +
    `${fresh.length} are new and ${found.length - fresh.length} are already saved.`
  if (req.body.action !== 'save') return res.send(importPage(req.query.key, logs, summary + ' Nothing saved yet.'))
  fresh.forEach(u => { sessions[u.phone] = buildImported(u); markDirty(u.phone) })
  await flushDirty()
  res.send(importPage(req.query.key, '', `Saved ${fresh.length} users. Now open the stats page to see the totals.`))
})

// ---------------- manual activation after a bank transfer ----------------
// Usage: /admin/activate?key=YOUR_ADMIN_KEY&phone=2348012345678&tier=pro&period=monthly
app.get('/admin/activate', async (req, res) => {
  if (!adminOk(req)) return res.sendStatus(401)
  const phone = String(req.query.phone || '').replace(/\D/g, '')
  const period = req.query.period === 'yearly' ? 'yearly' : 'monthly'
  const tier = req.query.tier === 'premium' ? 'premium' : 'pro'
  if (!phone) return res.status(400).send('phone missing')
  if (!sessions[phone]) sessions[phone] = newSession()
  const s = sessions[phone]
  const now = Date.now()
  const base = s.planEnd && Date.parse(s.planEnd) > now ? Date.parse(s.planEnd) : now
  s.plan = tier
  if (!s.planStart) s.planStart = new Date().toISOString()
  s.planEnd = new Date(base + (period === 'yearly' ? 365 : 30) * DAY).toISOString()
  s.flow = null
  s.flowData = null
  s.payNudge = null
  payWindow.delete(phone)
  markDirty(phone)
  // keep a payment record so the RECEIPT command works for bank-transfer customers
  try {
    await payStore.save({
      reference: `BANK-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      phone, plan: tier, period, amount_kobo: PLANS[tier][period] * 100,
      status: 'success', created_at: new Date().toISOString(), paid_at: new Date().toISOString()
    })
  } catch (e) { console.error('Could not save manual payment record:', e.message) }
  await flushDirty()
  await say(phone, s, `Payment confirmed, thank you 💚 Your MamaPlus ${tierName(tier)} plan is active until ${fmtDate(s.planEnd)}.\nReply NURSE any time to reach a nurse.`)
  res.send(`Activated ${tierName(tier)} (${period}) for ${mask(phone)} until ${fmtDate(s.planEnd)}`)
})

// ---------------- counts only (no names or numbers) ----------------
app.get('/stats', (req, res) => {
  if (!adminOk(req)) return res.sendStatus(401)
  const all = Object.values(sessions)
  const weekAgo = Date.now() - 7 * DAY
  res.json({
    as_of: new Date().toISOString(),
    total_users: all.length,
    onboarded: all.filter(s => s.onboardingComplete).length,
    active_last_7_days: all.filter(s => s.lastActive && Date.parse(s.lastActive) > weekAgo).length,
    came_back_on_2plus_days: all.filter(s => (s.activeDays || 0) >= 2).length,
    on_free_trial_now: all.filter(s => trialActive(s)).length,
    paying_pro_now: all.filter(s => proActive(s) && s.plan === 'pro').length,
    paying_premium_now: all.filter(s => proActive(s) && s.plan === 'premium').length,
    premium_waitlist: all.filter(s => s.premiumWaitlist).length,
    restored_from_old_logs: all.filter(s => s.source === 'log_import').length
  })
})

app.get('/', (req, res) => res.send('MamaPlus bot is running ✅'))

// ---------------- start ----------------
async function main() {
  let loaded = false
  for (let i = 1; i <= 3 && !loaded; i++) {
    try { await loadSessions(); loaded = true } catch (e) {
      console.error(`Could not load users (try ${i}/3):`, e.message)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  if (!loaded) {
    console.error('⚠️ Supabase is not reachable. Starting anyway. Saving is paused and will resume when it reconnects.')
    const retry = setInterval(async () => {
      try { await loadSessions(); clearInterval(retry); console.log('✅ Supabase reconnected') }
      catch (e) { console.error('Still cannot reach Supabase:', e.message) }
    }, 60 * 1000)
  }

  if (!process.env.WEBHOOK_TOKEN) console.log('⚠️ WEBHOOK_TOKEN is not set: anyone can post to /webhook')
  startScheduler()
  setInterval(flushDirty, 15000)
  process.on('SIGTERM', async () => { await flushDirty(); process.exit(0) })

  const PORT = process.env.PORT || 3001
  app.listen(PORT, () => console.log(`🚀 MamaPlus bot running on port ${PORT}`))
}

if (require.main === module) main()
module.exports = { payStore, mergeLoaded, groqCreate, detectIntent, keywordDanger, parseLogs, parseHour, buildImported, runAction, handleFlow, newSession, sessions }
