'use strict';

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');
const helmet = require('helmet');

const app = express();

// Use HTTPS if cert files exist (generated in local Docker), unless FORCE_HTTP=true.
// Cloud Run terminates TLS at the platform edge and forwards HTTP to the container.
const certPath = path.join(__dirname, 'cert.pem');
const keyPath  = path.join(__dirname, 'key.pem');
const forceHttp = String(process.env.FORCE_HTTP || '').toLowerCase() === 'true';
const useTLS = !forceHttp && fs.existsSync(certPath) && fs.existsSync(keyPath);

const server = useTLS
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3001;
const VALID_SESSION = process.env.SESSION_CODE || 'tech-be-townhall-2k26';

function parseIceServers() {
  const defaultIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const iceServersJson = process.env.ICE_SERVERS_JSON;
  const turnUrls = process.env.TURN_URLS;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (iceServersJson) {
    try {
      const parsed = JSON.parse(iceServersJson);
      if (
        Array.isArray(parsed) &&
        parsed.every((entry) => entry && (typeof entry.urls === 'string' || Array.isArray(entry.urls)))
      ) {
        return parsed;
      }
      console.warn('ICE_SERVERS_JSON is invalid; falling back to default STUN config.');
    } catch (err) {
      console.warn(`Failed to parse ICE_SERVERS_JSON: ${err.message}`);
    }
  }

  if (turnUrls) {
    const urls = turnUrls.split(/[;,]/).map((url) => url.trim()).filter(Boolean);
    if (urls.length > 0) {
      const turnServer = {
        urls,
      };
      if (turnUsername) turnServer.username = turnUsername;
      if (turnCredential) turnServer.credential = turnCredential;
      return [defaultIceServers[0], turnServer];
    }
  }

  return defaultIceServers;
}

const RTC_CONFIG = {
  iceServers: parseIceServers(),
};
const iceTransportPolicy = process.env.ICE_TRANSPORT_POLICY;
if (iceTransportPolicy === 'all' || iceTransportPolicy === 'relay') {
  RTC_CONFIG.iceTransportPolicy = iceTransportPolicy;
}

// Security headers — relaxed for WebRTC + Socket.IO
app.use(
  helmet({
    contentSecurityPolicy: false, // Socket.IO needs flexible CSP; handled by network boundary
  })
);
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/rtc-config', (_req, res) => res.json(RTC_CONFIG));

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
  const proto = useTLS ? 'https' : 'http';
  const inDocker = process.env.container === 'docker' ||
    fs.existsSync('/.dockerenv');

  console.log(`\n🎙  intercom listening on ${proto} port ${PORT}`);
  console.log(`   Local:   ${proto}://localhost:${PORT}`);

  if (inDocker) {
    const hostIP = process.env.HOST_IP;
    if (hostIP) {
      console.log(`\n   Network:  ${proto}://${hostIP}:${PORT}`);
    } else {
      console.log('\n   Tip: set HOST_IP in docker-compose.yml to see your LAN URL here.');
      console.log(`   Or run:  HOST_IP=$(hostname -I | awk '{print $1}') docker compose up -d`);
    }
    if (useTLS) {
      console.log('   ⚠️  Self-signed cert: browser will warn — click "Advanced" → "Proceed" once.');
    }
  } else {
    const ips = getHostIPs();
    if (ips.length) {
      console.log('   Network:');
      ips.forEach((ip) => console.log(`     ${proto}://${ip.split(': ')[1]}:${PORT}  (${ip.split(':')[0]})`));
    }
  }
  console.log(`\n   Valid session code: ${VALID_SESSION}\n`);
});
