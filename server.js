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
  const { businessName, businessType, city, hours, services, address, website } = req.body;
  if (!businessName) return res.status(400).json({ error: 'businessName is required' });

  const systemPrompt = `You are Nova, a warm and highly intelligent AI receptionist for ${businessName}, a ${businessType} located in ${city}.

You have a natural, human-like conversation style. You actively listen, respond directly to what the caller says, and never ignore their questions.

BUSINESS INFO — answer these immediately and confidently:
- Hours: ${hours}
- Services: ${services}
- Address: ${address}
- Website: ${website || 'not available'}

CONVERSATION RULES:
- If someone asks about hours, answer immediately
- If someone gives their name or number, confirm it back right away
- If you don't understand something, say "I'm sorry, could you repeat that?"
- Never ignore a question — always respond to what was just said
- Sound natural, warm, and human — not robotic or scripted
- Keep responses short — 1 to 2 sentences max
- If you don't know something, say "Let me have someone follow up with you on that"

GOAL EVERY CALL:
Get the caller's name, phone number, and reason for calling before the call ends.

End every call with: "Perfect, I've got your information noted and someone will be in touch with you soon. Have a wonderful day!"`;

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
