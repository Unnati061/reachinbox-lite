import { Router } from 'express';
import { getEmailDispatchQueue, QUEUE_NAMES } from '../services/queue.service.js';

export const queueRouter = Router();

/** A small live BullMQ inspector with no extra server or background poller. */
queueRouter.get('/metrics', async (_req, res) => {
  const counts = await getEmailDispatchQueue().getJobCounts(
    'active',
    'completed',
    'delayed',
    'failed',
    'prioritized',
    'waiting',
    'waiting-children',
  );
  res.json({ queue: QUEUE_NAMES.emailDispatch, captured_at: new Date().toISOString(), counts });
});

// Intentionally boring HTML: it is dependency-free, works while the Next app
// is down, and polls the exact JSON endpoint above so its numbers are live.
queueRouter.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReachInbox queue dashboard</title><style>
body{margin:0;background:#0b1020;color:#e5e7eb;font:16px system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:48px 24px}h1{margin:0 0 8px}.muted{color:#9ca3af}#grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:28px}.card{padding:18px;border:1px solid #27334d;border-radius:10px;background:#111a2d}.value{font-size:30px;font-weight:700;margin-top:8px}code{color:#93c5fd}</style></head>
<body><main><h1>BullMQ live dashboard</h1><p class="muted">Queue <code>${QUEUE_NAMES.emailDispatch}</code> · refreshes every 2 seconds</p><div id="grid" aria-live="polite">Loading queue counts…</div><p id="updated" class="muted"></p></main>
<script>const grid=document.querySelector('#grid'),updated=document.querySelector('#updated');async function load(){try{const r=await fetch('metrics',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();grid.innerHTML=Object.entries(d.counts).map(([k,v])=>'<article class="card"><div class="muted">'+k+'</div><div class="value">'+v+'</div></article>').join('');updated.textContent='Last updated '+new Date(d.captured_at).toLocaleTimeString()}catch(e){grid.textContent='Could not load queue metrics: '+e.message}}load();setInterval(load,2000)</script></body></html>`);
});
