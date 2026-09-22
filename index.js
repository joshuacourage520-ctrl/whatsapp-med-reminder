require('dotenv').config()
const express = require('express')
const Groq = require('groq-sdk')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const sessions = {}

async function sendWhatsAppMessage(phone, message) {
  const url = `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: process.env.ULTRAMSG_TOKEN,
        to: `+${phone}`,
        body: message
      })
    })
    const data = await response.json()
    console.log(`Sent to ${phone}:`, data)
  } catch (err) {
    console.error('Send failed:', err.message)
  }
}

async function alertCareProvider(userPhone, userName, symptoms) {
  if (!process.env.CARE_PROVIDER_WHATSAPP) return
  const msg =
    `🚨 MamaPlus HIGH RISK ALERT\n\n` +
    `Patient: ${userName || 'Unknown'}\n` +
    `Phone: +${userPhone}\n` +
    `Reported: "${symptoms}"\n\n` +
    `Patient advised to go to hospital immediately.\n` +
    `Please follow up for active monitoring.\n\n` +
    `Note: Automated alert. No diagnosis made.`
  await sendWhatsAppMessage(process.env.CARE_PROVIDER_WHATSAPP, msg)
  console.log(`Care provider alerted for ${userPhone}`)
}

function parseHour(timeStr) {
  if (!timeStr) return null
  const str = timeStr.toLowerCase().trim()
  const match = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  if (!match) return null
  let hour = parseInt(match[1])
  const meridiem = match[3]
  if (meridiem === 'pm' && hour !== 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  return hour
}

// DAILY PREGNANCY TIP - sends at 10AM personalised to pregnancy week
async function sendDailyTip(phone, name, week, conditions) {
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

    const nigeriaDayIndex = new Date().getUTCDay()
    const todayTopic = topics[nigeriaDayIndex]
    const isPostDelivery = week >= 40

    const promptContent = isPostDelivery
      ? `Daily newborn care tip for ${name || 'a new mother'} whose baby is approximately ${week - 40} weeks old. Topic: ${todayTopic}. Include one baby development fact, one feeding tip, and one self-care reminder for the mother. Keep it warm, practical and under 5 lines.`
      : `Daily pregnancy tip for ${name || 'a pregnant woman'} at week ${week} of pregnancy. Health conditions: ${conditions || 'none'}. Topic: ${todayTopic}. Include one specific fact about week ${week}, one practical tip related to today's topic, and one action she can take today. Keep it warm and under 5 lines.`

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
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
        {
          role: 'user',
          content: promptContent
        }
      ],
      max_tokens: 180,
      temperature: 0.8,
    })

    const tip = completion.choices[0].message.content.trim()
    await sendWhatsAppMessage(phone, tip)
    console.log(`Daily tip sent to ${phone} — week ${week} — topic: ${todayTopic}`)
  } catch (e) {
    console.error('Daily tip error:', e.message)
  }
}

function startScheduler() {
  setInterval(() => {
    const now = new Date()
    const nigeriaHour = (now.getUTCHours() + 1) % 24
    const nigeriaMinute = now.getUTCMinutes()
    if (nigeriaMinute !== 0) return

    console.log(`Scheduler running — Nigeria time: ${nigeriaHour}:00`)

    Object.entries(sessions).forEach(([phone, session]) => {
      if (!session.onboardingComplete) return

      // 1. DAILY MORNING CHECK-IN at 8AM
      if (nigeriaHour === 8) {
        sendWhatsAppMessage(phone,
          `Good morning ${session.name}! 🌅\n` +
          `How are you feeling today?\n` +
          `Any headaches, swelling or unusual pain?`
        )
        console.log(`Morning check-in sent to ${phone}`)
      }

      // 2. ANC REMINDERS at 9AM
      if (nigeriaHour === 9 && session.ancDate) {
        try {
          const anc = new Date(session.ancDate)
          const today = new Date()
          today.setHours(0, 0, 0, 0)
          const diffDays = Math.ceil((anc - today) / (1000 * 60 * 60 * 24))

          if (diffDays === 2) {
            sendWhatsAppMessage(phone,
              `Hi ${session.name}! 🏥\n` +
              `Your antenatal appointment is in 2 days.\n` +
              `Please don't forget to attend!`
            )
          }
          if (diffDays === 1) {
            sendWhatsAppMessage(phone,
              `Hi ${session.name}! 🏥\n` +
              `Your antenatal appointment is TOMORROW.\n` +
              `Make sure you are prepared. 💚`
            )
          }
          if (diffDays === 0) {
            sendWhatsAppMessage(phone,
              `Hi ${session.name}! 🏥\n` +
              `Your antenatal appointment is TODAY.\n` +
              `Please remember to go. Take care! 💚`
            )
          }
        } catch (e) {
          console.log(`ANC date error for ${phone}`)
        }
      }

      // 3. DAILY PREGNANCY TIP at 10AM
      if (nigeriaHour === 10 && session.weeksPregnant) {
        const daysPassed = session.registrationDate
          ? Math.floor((new Date() - new Date(session.registrationDate)) / (1000 * 60 * 60 * 24))
          : 0
        const currentWeek = Math.min(
          parseInt(session.weeksPregnant) + Math.floor(daysPassed / 7),
          42
        )
        session.currentWeek = currentWeek
        sendDailyTip(phone, session.name, currentWeek, session.conditions)
      }

      // 4. MEDICATION REMINDERS at user chosen time
      if (session.medications && session.medications.length > 0) {
        session.medications.forEach(med => {

          // Skip inactive medications
          if (!med.active) return

          // Check if end date has passed
          if (med.endDate) {
            const today = new Date()
            today.setHours(0, 0, 0, 0)
            const end = new Date(med.endDate)
            if (today > end) {
              med.active = false
              sendWhatsAppMessage(phone,
                `Hi ${session.name}! 🎉\n` +
                `Your ${med.name} course is now complete.\n` +
                `Well done for staying consistent! 💚`
              )
              console.log(`Medication course completed: ${med.name} for ${phone}`)
              return
            }
          }

          // Send reminder at user chosen time
          if (med.hour === nigeriaHour) {
            sendWhatsAppMessage(phone,
              `Hi ${session.name}! 💊\n` +
              `Time to take your ${med.name}.\n` +
              `Reply "taken" once you have taken it.`
            )
            med.pendingFollowUp = true
            med.followUpHour = (nigeriaHour + 1) % 24
            console.log(`Medication reminder sent to ${phone} for ${med.name}`)
          }

          // Follow-up 1 hour later if not confirmed
          if (
            med.pendingFollowUp &&
            med.followUpHour === nigeriaHour &&
            !med.takenToday
          ) {
            sendWhatsAppMessage(phone,
              `Just checking ${session.name} 💊\n` +
              `Did you take your ${med.name}?\n` +
              `It is important for you and your baby.`
            )
            med.pendingFollowUp = false
            console.log(`Medication follow-up sent to ${phone}`)
          }
        })
      }

      // 5. RESET medication status at midnight
      if (nigeriaHour === 0 && session.medications) {
        session.medications.forEach(med => {
          med.takenToday = false
          med.pendingFollowUp = false
        })
      }
    })
  }, 60 * 1000)

  console.log('✅ Master scheduler started')
}

// AI RISK DETECTION
async function detectRisk(userMessage, userName, weeksPregnant) {
  try {
    const result = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: `You are a maternal health risk detector.
Read a pregnant woman's message and decide if it describes a potential 
medical emergency or danger sign requiring immediate hospital attention.

Consider ANY of these HIGH RISK — not just exact phrases:
- Pain that is severe or unusual anywhere in the body
- Any bleeding
- Vision problems or blurred vision
- Reduced or no baby movement
- Swelling of face, hands or feet
- Difficulty breathing
- High fever or chills
- Vomiting blood or anything unusual
- Feeling very unwell, dizzy or faint
- Fainting or loss of consciousness
- Fits or convulsions
- Anything that sounds like a medical emergency
- Anything suggesting preeclampsia, infection, or labour complications

Reply with ONLY one word: YES or NO.
YES = danger sign present.
NO = safe to handle normally.`
        },
        {
          role: 'user',
          content: `Patient: ${userName || 'Unknown'}, ${weeksPregnant || 'unknown weeks'} pregnant.\nMessage: "${userMessage}"`
        }
      ],
      max_tokens: 5,
      temperature: 0,
    })
    const answer = result.choices[0].message.content.trim().toUpperCase()
    return answer.includes('YES')
  } catch (e) {
    console.error('Risk detection error:', e.message)
    return false
  }
}

// AI PROFILE EXTRACTION
async function extractProfileData(conversation) {
  try {
    const result = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: `You are a data extractor. Read the conversation and extract profile data.
Return ONLY a JSON object with these fields (use null if not found):
{
  "name": "first name if mentioned",
  "weeksPregnant": "number only e.g 28",
  "ancDate": "date in YYYY-MM-DD format if mentioned, convert any natural date like July 10 2025",
  "conditions": "health conditions mentioned e.g hypertension, diabetes, or none",
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
        {
          role: 'user',
          content: JSON.stringify(conversation.slice(-10))
        }
      ],
      max_tokens: 300,
      temperature: 0,
    })

    const text = result.choices[0].message.content.trim()
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (e) {
    console.error('Profile extraction error:', e.message)
    return null
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

MEDICATION EDUCATION RULES:
- You CAN explain what any medication is for and its common side effects
- You CAN say if a medication is generally considered safe in pregnancy
- You CANNOT tell a user what dose to take
- You CANNOT tell a user to stop or change their prescribed medication
- Always end medication explanations with: "Always follow your doctor's instructions for your specific prescription."

OUT OF SCOPE — anything unrelated to pregnancy or maternal health:
Reply exactly: "I can only help with pregnancy and maternal health questions. What would you like to know about your pregnancy? 😊"

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
Line 3: "Your care provider has been notified for active monitoring."
`

app.post('/webhook', async (req, res) => {
  const body = req.body
  if (body.data?.fromMe) return res.sendStatus(200)

  const userMessage = body.data?.body?.trim()
  const userPhone = body.data?.from
    ?.replace('@c.us', '')
    ?.replace('+', '')

  if (!userMessage || !userPhone) return res.sendStatus(200)

  console.log(`📩 From ${userPhone}: ${userMessage}`)

  // Create session for new user — includes registrationDate for week tracking
  if (!sessions[userPhone]) {
    sessions[userPhone] = {
      messages: [],
      name: null,
      weeksPregnant: null,
      currentWeek: null,
      ancDate: null,
      conditions: null,
      medications: [],
      onboardingComplete: false,
      registrationDate: new Date().toISOString().split('T')[0]
    }
  }

  const session = sessions[userPhone]

  // Check if user is stopping a medication
  const stopPhrases = [
    'no longer take', 'stopped taking', 'i stopped', 'finished my',
    'doctor said stop', 'cancel reminder', 'stop reminder',
    'dont take anymore', "don't take anymore", 'no more', 'i finished'
  ]
  if (stopPhrases.some(p => userMessage.toLowerCase().includes(p))) {
    session.medications.forEach(med => {
      if (userMessage.toLowerCase().includes(med.name.toLowerCase())) {
        med.active = false
        console.log(`Medication stopped by user: ${med.name} for ${userPhone}`)
      }
    })
  }

  // Check if user confirms taking medication
  const takenPhrases = ['taken', 'i have taken', 'already taken', 'yes i took', 'i took it', 'done']
  if (takenPhrases.some(p => userMessage.toLowerCase().includes(p))) {
    const pending = session.medications?.find(m => m.pendingFollowUp)
    if (pending) {
      pending.takenToday = true
      pending.pendingFollowUp = false
    }
  }

  // Add user message to history
  session.messages.push({ role: 'user', content: userMessage })

  // Acknowledge webhook immediately
  res.sendStatus(200)

  // Run risk detection and main reply at the same time
  const [danger, completion] = await Promise.all([
    detectRisk(userMessage, session.name, session.weeksPregnant),
    groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages
      ],
      max_tokens: 400,
      temperature: 0.7,
    }).catch(err => {
      console.error('Groq error:', err.message)
      return null
    })
  ])

  if (!completion) {
    await sendWhatsAppMessage(userPhone, 'Sorry, something went wrong. Please try again.')
    return
  }

  let botReply = completion.choices[0].message.content.trim()

  // Alert care provider if danger detected
  if (danger) {
    await alertCareProvider(userPhone, session.name, userMessage)
    if (!botReply.includes('notified')) {
      botReply += '\nYour care provider has been notified for active monitoring.'
    }
    console.log(`🚨 Danger detected for ${userPhone}`)
  }

  // Save bot reply to history
  session.messages.push({ role: 'assistant', content: botReply })

  // Extract and update profile data from conversation every few messages
  if (session.messages.length % 4 === 0 || !session.onboardingComplete) {
    const extracted = await extractProfileData(session.messages)
    if (extracted) {
      if (extracted.name) session.name = extracted.name
      if (extracted.weeksPregnant) session.weeksPregnant = extracted.weeksPregnant
      if (extracted.ancDate) session.ancDate = extracted.ancDate
      if (extracted.conditions) session.conditions = extracted.conditions
      if (extracted.onboardingComplete) session.onboardingComplete = true

      if (extracted.medications && extracted.medications.length > 0) {
        extracted.medications.forEach(med => {

          // Handle stopped medications
          if (med.stopped) {
            const existing = session.medications.find(
              m => m.name.toLowerCase() === med.name.toLowerCase()
            )
            if (existing) {
              existing.active = false
              console.log(`Medication deactivated via extraction: ${med.name}`)
            }
            return
          }

          // Add new medications with end date
          // Add new medications with end date
if (med.name) {
  let hour = (med.hour !== null && med.hour !== undefined) ? med.hour : null

  // FALLBACK: if AI extraction missed the hour, try parsing it directly
  // from the last few user messages (uses the existing parseHour() helper)
  if (hour === null) {
    const recentUserMsgs = session.messages
      .filter(m => m.role === 'user')
      .slice(-5)
      .map(m => m.content)
      .reverse()
    for (const msg of recentUserMsgs) {
      const parsed = parseHour(msg)
      if (parsed !== null) {
        hour = parsed
        break
      }
    }
  }

  if (hour !== null) {
    const exists = session.medications.find(
      m => m.name.toLowerCase() === med.name.toLowerCase()
    )
    if (!exists) {
      const startDate = new Date()
      const endDate = med.durationDays
        ? new Date(
            startDate.getTime() + med.durationDays * 24 * 60 * 60 * 1000
          ).toISOString().split('T')[0]
        : null

      session.medications.push({
        name: med.name,
        hour: hour,
        takenToday: false,
        pendingFollowUp: false,
        followUpHour: null,
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate,
        active: true
      })
      console.log(`💊 Medication saved: ${med.name} at ${hour}:00 — ends: ${endDate || 'ongoing'} for ${userPhone}`)
    }
  } else {
    console.log(`⚠️ Could not determine time for medication "${med.name}" — will retry as conversation continues for ${userPhone}`)
  }
}
        })
      }

      console.log(`Profile updated for ${userPhone}:`, {
        name: session.name,
        weeks: session.weeksPregnant,
        anc: session.ancDate,
        meds: session.medications.length,
        complete: session.onboardingComplete
      })
    }
  }

  // Send reply to user
  await sendWhatsAppMessage(userPhone, botReply)
})

app.get('/', (req, res) => res.send('MamaPlus bot is running ✅'))

startScheduler()

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`🚀 MamaPlus bot running on port ${PORT}`))
