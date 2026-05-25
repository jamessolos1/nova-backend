require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function makeOutboundCall(name, phone) {
  if (!phone) return;
  const cleaned = phone.replace(/\D/g, '');
  const formatted = cleaned.length === 10 ? `+1${cleaned}` : `+${cleaned}`;
  try {
    const res = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        assistantId: process.env.VAPI_ASSISTANT_ID,
        customer: { number: formatted, name },
        assistantOverrides: {
          firstMessage: `Hi ${name}! This is Nova calling back from Nova AI Agency. You just reached out to us and I wanted to follow up right away — is this a good time to chat?`
        }
      })
    });
    const data = await res.json();
    console.log('Outbound call placed to', formatted, '| ID:', data.id);
  } catch (err) {
    console.error('Outbound call error:', err.message);
  }
}

async function sendSMS(to, message) {
  if (!to) return;
  const cleaned = to.replace(/\D/g, '');
  const formatted = cleaned.length === 10 ? `+1${cleaned}` : `+${cleaned}`;
  try {
    await twilio.messages.create({ body: message, from: process.env.TWILIO_PHONE, to: formatted });
    console.log('SMS sent to', formatted);
  } catch (err) {
    console.error('SMS error:', err.message);
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'Nova backend running', version: '1.0.0' });
});

// Submit a new lead
app.post('/api/leads', async (req, res) => {
  const { name, email, phone, message, need, source, conversation } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  const { data, error } = await supabase
    .from('leads')
    .insert([{
      name,
      email,
      phone: phone || null,
      need: need || message || null,
      source: source || null,
      conversation: conversation || null
    }])
    .select()
    .single();

  if (error) {
    console.error('Supabase error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // SMS follow-up to the lead
  sendSMS(phone, `Hi ${name}! Thanks for reaching out to us. We've received your message and will be in touch with you shortly. - Nova AI Agency`);

  // Outbound call back within 60 seconds
  if (phone) setTimeout(() => makeOutboundCall(name, phone), 60000);

  // Fire-and-forget notification email
  resend.emails.send({
    from: 'Nova <onboarding@resend.dev>',
    to: process.env.NOTIFY_EMAIL,
    subject: `New lead from ${name}`,
    html: `
      <h2>New lead captured by Nova</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Phone:</strong> ${phone || 'not provided'}</p>
      <p><strong>Need:</strong> ${need || message || 'none'}</p>
      <p><strong>Source:</strong> ${source || 'none'}</p>
    `
  }).catch(err => console.error('Resend error:', err.message));

  res.status(201).json({ success: true, lead: data });
});

// Get all leads (for dashboard)
app.get('/api/leads', async (req, res) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Parse requested booking time from transcript
function parseBookingTime(transcript) {
  const days = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const now = new Date();
  let targetDate = null;
  let targetHour = null;
  let targetMinute = 0;

  if (/tomorrow/i.test(transcript)) {
    targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + 1);
  }

  const dayMatch = transcript.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (dayMatch && !targetDate) {
    const targetDay = days[dayMatch[1].toLowerCase()];
    targetDate = new Date(now);
    const daysUntil = ((targetDay - targetDate.getDay()) + 7) % 7 || 7;
    targetDate.setDate(targetDate.getDate() + daysUntil);
  }

  const timeMatch = transcript.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (timeMatch) {
    targetHour = parseInt(timeMatch[1]);
    targetMinute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const ampm = timeMatch[3].toLowerCase();
    if (ampm === 'pm' && targetHour < 12) targetHour += 12;
    if (ampm === 'am' && targetHour === 12) targetHour = 0;
  }

  if (!targetDate) targetDate = new Date(now);
  if (targetHour !== null) {
    targetDate.setHours(targetHour, targetMinute, 0, 0);
    return targetDate;
  }
  return null;
}

// Create a Cal.com booking
async function createCalBooking(name, phone, startTime) {
  const res = await fetch('https://api.cal.com/v2/bookings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CAL_API_KEY}`,
      'Content-Type': 'application/json',
      'cal-api-version': '2024-08-13'
    },
    body: JSON.stringify({
      start: startTime.toISOString(),
      eventTypeId: parseInt(process.env.CAL_EVENT_TYPE_ID),
      attendee: {
        name: name || 'Phone Caller',
        email: `caller.${Date.now()}@nova-placeholder.com`,
        timeZone: 'America/Toronto',
        language: 'en'
      },
      metadata: { phone: phone || 'unknown', source: 'nova_phone_call' }
    })
  });
  return await res.json();
}

// Vapi webhook — fires when a call ends
app.post('/api/vapi-webhook', async (req, res) => {
  const msg = req.body?.message;
  if (!msg || msg.type !== 'end-of-call-report') return res.json({ received: true });

  const phone       = msg.call?.customer?.number || null;
  const transcript  = msg.transcript || '';
  const summary     = msg.summary || '';
  const assistantName = msg.assistant?.name || 'Nova';

  // Extract caller name from transcript
  const nameMatch = transcript.match(/(?:my name is|this is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const callerName = nameMatch ? nameMatch[1] : (phone ? `Caller ${phone}` : 'Unknown Caller');

  const { data, error } = await supabase
    .from('leads')
    .insert([{
      name: callerName,
      email: null,
      phone,
      need: summary || 'Phone call — see conversation',
      source: `phone_call`,
      conversation: transcript
    }])
    .select()
    .single();

  if (error) console.error('Supabase error:', error.message);

  // SMS follow-up to the caller
  sendSMS(phone, `Hi ${callerName}! Thanks for calling us. We've got your info and someone will be in touch with you soon. - Nova AI Agency`);

  // Auto-create Cal.com booking if caller requested a time
  const bookingTime = parseBookingTime(transcript);
  if (bookingTime) {
    createCalBooking(callerName, phone, bookingTime)
      .then(b => console.log('Cal.com booking:', b?.uid || JSON.stringify(b)))
      .catch(err => console.error('Cal.com error:', err.message));
  }

  resend.emails.send({
    from: 'Nova <onboarding@resend.dev>',
    to: process.env.NOTIFY_EMAIL,
    subject: `📞 New call lead: ${callerName}`,
    html: `
      <h2>New phone lead captured by ${assistantName}</h2>
      <p><strong>Name:</strong> ${callerName}</p>
      <p><strong>Phone:</strong> ${phone || 'unknown'}</p>
      <p><strong>Summary:</strong> ${summary || 'none'}</p>
      <hr/>
      <p><strong>Full transcript:</strong></p>
      <pre style="background:#f8fafc;padding:12px;border-radius:8px;font-size:13px">${transcript}</pre>
    `
  }).catch(err => console.error('Resend error:', err.message));

  res.json({ received: true });
});

// Create a Vapi assistant for a client (white-label)
app.post('/api/create-assistant', async (req, res) => {
  const { businessName, businessType, city, hours, services, address, website, calendly } = req.body;
  if (!businessName) return res.status(400).json({ error: 'businessName is required' });

  const bookingSection = calendly
    ? `BOOKING APPOINTMENTS:
- Always ask if they want to book an appointment before ending the call
- If they say yes, give them this link: ${calendly}
- Say exactly: "You can book directly at ${calendly.replace('https://', '')}"
- If they say no — that is fine, just let them know someone will follow up shortly`
    : `BOOKING APPOINTMENTS:
- Always ask if they want to book an appointment before ending the call
- If they say yes — let them know someone will call them back to confirm a time
- If they say no — that is fine, just let them know someone will follow up shortly`;

  const systemPrompt = `You are Nova, a warm and highly intelligent AI receptionist for ${businessName}, a ${businessType} located in ${city}.

You have a natural, human-like conversation style. You actively listen, respond directly to what the caller says, and never ignore their questions.

BUSINESS INFO — answer these immediately and confidently:
- Hours: ${hours}
- Services: ${services}
- Address: ${address}
- Website: ${website || 'not available'}

CONVERSATION RULES:
- If someone gives their name, confirm it back immediately
- Never repeat a phone number back — it is captured automatically
- If you don't understand something, say "I'm sorry, could you repeat that?"
- Never ignore a question — always respond to what was just said
- Sound natural, warm, and human — not robotic or scripted
- Keep responses under 2 sentences — this is a voice call
- If you don't know something, say "Let me have someone follow up with you on that"

${bookingSection}

GOAL EVERY CALL:
1. Get the caller's name and reason for calling
2. Always ask: "Would you like to book an appointment right now?"
3. If yes — give them the Calendly link
4. If no — confirm someone will follow up

ENDING THE CALL:
Say exactly this and nothing after: "Perfect, I've got your information noted and someone will be in touch with you soon. Have a wonderful day, goodbye!"
Then immediately end the call.`;

  try {
    const vapiRes = await fetch('https://api.vapi.ai/assistant', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `Nova – ${businessName}`,
        model: { provider: 'openai', model: 'gpt-4.1', messages: [{ role: 'system', content: systemPrompt }] },
        voice: { provider: '11labs', voiceId: 'burt' },
        firstMessage: `Thank you for calling ${businessName}, my name is Nova! How can I help you today?`,
        serverUrl: `${process.env.SERVER_URL}/api/vapi-webhook`
      })
    });
    const assistant = await vapiRes.json();
    if (!vapiRes.ok) return res.status(500).json({ error: assistant });
    res.json({ success: true, assistant });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a lead
app.delete('/api/leads/:id', async (req, res) => {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nova backend running on port ${PORT}`));
