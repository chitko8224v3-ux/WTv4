import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(express.json());

interface ActiveRoom {
  code: string;
  hostName: string;
  movieTitle: string;
  movieUrl?: string;
  viewerCount: number;
  lastSeen: number;
  createdAt: number;
}

const rooms = new Map<string, ActiveRoom>();
const sseClients = new Set<express.Response>();

function getFilteredActiveRooms(): ActiveRoom[] {
  const now = Date.now();
  // Keep active rooms for up to 10 minutes without heartbeat (prevents background tab throttling drops)
  return Array.from(rooms.values())
    .filter((r) => now - r.lastSeen <= 600000)
    .sort((a, b) => (b.createdAt || b.lastSeen || 0) - (a.createdAt || a.lastSeen || 0));
}

function broadcastRooms() {
  const activeRooms = getFilteredActiveRooms();
  const payload = `data: ${JSON.stringify({ rooms: activeRooms })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Clean inactive rooms older than 10 minutes
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastSeen > 600000) {
      rooms.delete(code);
      changed = true;
    }
  }
  if (changed) {
    broadcastRooms();
  }
}, 15000);

// SSE stream for real-time instant room discovery (<50ms when any room is created)
app.get('/api/rooms/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  sseClients.add(res);

  // Send current rooms immediately upon connection
  const activeRooms = getFilteredActiveRooms();
  res.write(`data: ${JSON.stringify({ rooms: activeRooms })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// GET /api/rooms - list active rooms
app.get('/api/rooms', (req, res) => {
  res.json({ rooms: getFilteredActiveRooms() });
});

// POST /api/rooms - register or heartbeat an active room
app.post('/api/rooms', (req, res) => {
  const { code, hostName, movieTitle, movieUrl, viewerCount } = req.body;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Code is required' });
    return;
  }
  const cleanCode = code.trim().toUpperCase();
  const existing = rooms.get(cleanCode);
  const updated: ActiveRoom = {
    code: cleanCode,
    hostName: hostName || (existing ? existing.hostName : 'Host'),
    movieTitle: movieTitle || (existing ? existing.movieTitle : 'No movie loaded'),
    movieUrl: movieUrl || (existing ? existing.movieUrl : undefined),
    viewerCount: typeof viewerCount === 'number' ? viewerCount : 1,
    lastSeen: Date.now(),
    createdAt: existing ? existing.createdAt : Date.now(),
  };

  rooms.set(cleanCode, updated);
  broadcastRooms();
  res.json({ ok: true, room: updated });
});

// DELETE /api/rooms/:code - remove a room when host leaves
app.delete('/api/rooms/:code', (req, res) => {
  const cleanCode = req.params.code.trim().toUpperCase();
  if (cleanCode !== 'PARTY') {
    rooms.delete(cleanCode);
    broadcastRooms();
  }
  res.json({ ok: true });
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Watch Together Server listening on port ${PORT}`);
  });
}

startServer();
