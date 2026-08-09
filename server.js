// LYKAN Miner — Backend API
// Handles auth (Telegram WebApp initData verification), tapping, upgrades,
// passive mining, referrals, tasks, and leaderboard.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ENERGY_REGEN_SECONDS = 3;     // 1 energy every 3 seconds
const MAX_TAPS_PER_REQUEST = 50;    // anti-cheat cap per /api/tap call

// ---------- Telegram WebApp initData verification ----------
// This proves the request really came from Telegram and wasn't spoofed.
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const user = JSON.parse(params.get('user') || '{}');
  return user;
}

// Middleware: every protected route expects { initData } in body or ?initData= query
async function auth(req, res, next) {
  const initData = req.body.initData || req.query.initData;
  const user = verifyInitData(initData);
  if (!user || !user.id) {
    return res.status(401).json({ error: 'Invalid or missing Telegram initData' });
  }
  req.tgUser = user;
  next();
}

// ---------- Helpers ----------
function applyEnergyRegen(user) {
  const now = Date.now();
  const last = new Date(user.last_energy_ts).getTime();
  const secondsPassed = Math.floor((now - last) / 1000);
  const regenerated = Math.floor(secondsPassed / ENERGY_REGEN_SECONDS);
  const newEnergy = Math.min(user.max_energy, user.energy + regenerated);
  return { energy: newEnergy, last_energy_ts: regenerated > 0 ? new Date().toISOString() : user.last_energy_ts };
}

function applyPassiveMining(user) {
  const now = Date.now();
  const last = new Date(user.last_passive_ts).getTime();
  const hoursPassed = (now - last) / (1000 * 60 * 60);
  const earned = hoursPassed * user.mine_rate;
  return { coins: user.coins + earned, last_passive_ts: new Date().toISOString() };
}

// ---------- Routes ----------

// Get or create user; also credits referral bonus on first login
app.post('/api/auth', auth, async (req, res) => {
  const { id, username, first_name } = req.tgUser;
  const referredBy = req.body.startParam ? Number(req.body.startParam) : null;

  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', id).single();

  if (!user) {
    const insertPayload = {
      telegram_id: id,
      username: username || null,
      first_name: first_name || null,
      referred_by: referredBy && referredBy !== id ? referredBy : null,
    };
    const { data: created, error } = await supabase.from('users').insert(insertPayload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    user = created;

    // Reward referrer (flat bonus per new referral — adjust as needed)
    if (user.referred_by) {
      const { data: referrer } = await supabase.from('users').select('*').eq('telegram_id', user.referred_by).single();
      if (referrer) {
        await supabase
          .from('users')
          .update({
            coins: referrer.coins + 1000,
            referral_count: referrer.referral_count + 1,
            referral_earnings: referrer.referral_earnings + 1000,
          })
          .eq('telegram_id', user.referred_by);
      }
    }
  }

  const energyUpdate = applyEnergyRegen(user);
  const passiveUpdate = applyPassiveMining({ ...user, ...energyUpdate });
  const merged = { ...user, ...energyUpdate, ...passiveUpdate };

  await supabase.from('users').update(merged).eq('telegram_id', id);
  res.json(merged);
});

// Daily claim — once every 24 hours
app.post('/api/claim', auth, async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', req.tgUser.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const now = Date.now();
  const last = user.last_claim_ts ? new Date(user.last_claim_ts).getTime() : 0;
  const msSinceLastClaim = now - last;
  const cooldownMs = 24 * 60 * 60 * 1000;

  if (msSinceLastClaim < cooldownMs) {
    const remainingMs = cooldownMs - msSinceLastClaim;
    return res.status(400).json({ error: 'Claim not yet available', remainingMs });
  }

  const updated = {
    coins: user.coins + user.claim_amount,
    last_claim_ts: new Date().toISOString(),
  };
  await supabase.from('users').update(updated).eq('telegram_id', req.tgUser.id);
  res.json({ ...user, ...updated, claimedAmount: user.claim_amount });
});

// Tap to earn
app.post('/api/tap', auth, async (req, res) => {
  const taps = Math.min(Number(req.body.taps) || 1, MAX_TAPS_PER_REQUEST);
  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', req.tgUser.id).single();
  if (!user) return res.status(404).json({ error: 'User not found. Call /api/auth first.' });

  const energyUpdate = applyEnergyRegen(user);
  const availableEnergy = Math.min(energyUpdate.energy, taps);
  if (availableEnergy <= 0) {
    return res.status(400).json({ error: 'No energy left', ...energyUpdate });
  }

  const coinsEarned = availableEnergy * user.tap_power;
  const updated = {
    coins: user.coins + coinsEarned,
    energy: energyUpdate.energy - availableEnergy,
    last_energy_ts: new Date().toISOString(),
  };

  await supabase.from('users').update(updated).eq('telegram_id', req.tgUser.id);
  res.json({ ...user, ...updated, coinsEarned });
});

// Buy an upgrade (tap power or passive mine rate)
app.post('/api/upgrade', auth, async (req, res) => {
  const { type } = req.body; // 'tap' or 'mine'
  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', req.tgUser.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  let cost, updated;
  if (type === 'tap') {
    cost = Math.floor(500 * Math.pow(1.6, user.tap_level));
    if (user.coins < cost) return res.status(400).json({ error: 'Not enough coins', cost });
    updated = { coins: user.coins - cost, tap_power: user.tap_power + 1, tap_level: user.tap_level + 1 };
  } else if (type === 'mine') {
    cost = Math.floor(1000 * Math.pow(1.7, user.mine_level));
    if (user.coins < cost) return res.status(400).json({ error: 'Not enough coins', cost });
    updated = { coins: user.coins - cost, mine_rate: user.mine_rate + 10, mine_level: user.mine_level + 1 };
  } else {
    return res.status(400).json({ error: "type must be 'tap' or 'mine'" });
  }

  await supabase.from('users').update(updated).eq('telegram_id', req.tgUser.id);
  res.json({ ...user, ...updated });
});

// Fetch current state (with energy/passive regen applied)
app.post('/api/state', auth, async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', req.tgUser.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const energyUpdate = applyEnergyRegen(user);
  const passiveUpdate = applyPassiveMining({ ...user, ...energyUpdate });
  const merged = { ...user, ...energyUpdate, ...passiveUpdate };

  await supabase.from('users').update(merged).eq('telegram_id', req.tgUser.id);
  res.json(merged);
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('telegram_id, username, first_name, coins')
    .order('coins', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Tasks
app.get('/api/tasks', async (req, res) => {
  const { data, error } = await supabase.from('tasks').select('*').eq('active', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tasks/complete', auth, async (req, res) => {
  const { taskId } = req.body;
  const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { data: existing } = await supabase
    .from('user_tasks')
    .select('*')
    .eq('telegram_id', req.tgUser.id)
    .eq('task_id', taskId)
    .maybeSingle();
  if (existing) return res.status(400).json({ error: 'Task already completed' });

  await supabase.from('user_tasks').insert({ telegram_id: req.tgUser.id, task_id: taskId });

  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', req.tgUser.id).single();
  const updated = { coins: user.coins + task.reward };
  await supabase.from('users').update(updated).eq('telegram_id', req.tgUser.id);
  res.json({ ...user, ...updated });
});

app.get('/', (req, res) => res.send('LYKAN Miner backend is running'));

const PORT = 3000; // Fixed to match Back4app's expected container port
app.listen(PORT, '0.0.0.0', () => console.log(`LYKAN Miner backend running on port ${PORT}`));
