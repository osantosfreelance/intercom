'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3001;
const VALID_SESSION = 'tech-be-townhall-2k26';

// Security headers — relaxed for WebRTC + Socket.IO
app.use(
  helmet({
    contentSecurityPolicy: false, // Socket.IO needs flexible CSP; handled by network boundary
  })
);
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── In-memory session state ────────────────────────────────────────────────
// sessions[sessionId] = Map<socketId, { alias, speaking }>
const sessions = {};

function getParticipants(sessionId) {
  if (!sessions[sessionId]) return [];
  return Array.from(sessions[sessionId].entries()).map(([id, info]) => ({
    id,
    alias: info.alias,
    speaking: info.speaking,
  }));
}

// ── Socket.IO signaling ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentSession = null;
  let currentAlias = null;

  // ── Join ──────────────────────────────────────────────────────────────────
  socket.on('join', ({ alias, sessionCode }) => {
    if (!alias || typeof alias !== 'string' || alias.trim().length === 0) {
      socket.emit('join:error', { message: 'Alias is required.' });
      return;
    }
    if (sessionCode !== VALID_SESSION) {
      socket.emit('join:error', { message: 'Invalid session code.' });
      return;
    }

    currentSession = sessionCode;
    currentAlias = alias.trim().slice(0, 32);

    if (!sessions[currentSession]) sessions[currentSession] = new Map();
    sessions[currentSession].set(socket.id, { alias: currentAlias, speaking: false });

    socket.join(currentSession);

    // Tell the joiner who else is already in the session
    socket.emit('join:ok', {
      sessionId: currentSession,
      alias: currentAlias,
      socketId: socket.id,
      participants: getParticipants(currentSession),
    });

    // Tell everyone else a new participant arrived
    socket.to(currentSession).emit('participant:joined', {
      id: socket.id,
      alias: currentAlias,
    });
  });

  // ── WebRTC signaling relay ────────────────────────────────────────────────
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // ── Push-to-talk speaking state ───────────────────────────────────────────
  socket.on('speaking:start', () => {
    if (!currentSession || !sessions[currentSession]) return;
    const info = sessions[currentSession].get(socket.id);
    if (info) info.speaking = true;
    socket.to(currentSession).emit('speaking:start', { id: socket.id });
  });

  socket.on('speaking:end', () => {
    if (!currentSession || !sessions[currentSession]) return;
    const info = sessions[currentSession].get(socket.id);
    if (info) info.speaking = false;
    socket.to(currentSession).emit('speaking:end', { id: socket.id });
  });

  // ── Disconnect / exit ─────────────────────────────────────────────────────
  function leave() {
    if (!currentSession || !sessions[currentSession]) return;
    sessions[currentSession].delete(socket.id);
    if (sessions[currentSession].size === 0) delete sessions[currentSession];
    socket.to(currentSession).emit('participant:left', { id: socket.id });
    socket.leave(currentSession);
    currentSession = null;
    currentAlias = null;
  }

  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

// ── Startup ────────────────────────────────────────────────────────────────
function getHostIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(`${name}: ${iface.address}`);
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  const inDocker = process.env.container === 'docker' ||
    require('fs').existsSync('/.dockerenv');

  console.log(`\n🎙  intercom listening on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);

  const ips = getHostIPs();
  if (inDocker) {
    console.log('\n   ⚠️  Running inside Docker.');
    console.log('   Access the app using your HOST machine\'s IP on port ' + PORT + ':');
    console.log(`   e.g.  http://<your-laptop-ip>:${PORT}`);
    console.log('   (run `ipconfig` on Windows or `ip a` on Linux to find your LAN IP)\n');
  } else if (ips.length) {
    console.log('   Network:');
    ips.forEach((ip) => console.log(`     http://${ip.split(': ')[1]}:${PORT}  (${ip.split(':')[0]})`));
  }
  console.log(`   Valid session code: ${VALID_SESSION}\n`);
});
