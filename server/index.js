const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      trail_time INTEGER,
      cows_lost INTEGER,
      wolves_repelled INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

app.post('/api/scores', async (req, res) => {
  const { name, score, trailTime, cowsLost, wolvesRepelled } = req.body;
  if (!name || score == null) return res.status(400).json({ error: 'name and score required' });
  const { rows } = await pool.query(
    'INSERT INTO scores (name, score, trail_time, cows_lost, wolves_repelled) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [name.slice(0, 20), Math.floor(score), trailTime ?? null, cowsLost ?? null, wolvesRepelled ?? null]
  );
  res.json({ ok: true, id: rows[0].id });
});

app.get('/api/leaderboard', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT name, MAX(score) AS score FROM scores GROUP BY name ORDER BY score DESC LIMIT 10'
  );
  res.json(rows);
});

app.get('/health', (_, res) => res.json({ ok: true }));

init().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`cows-and-boys server on :${port}`));
});
