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
