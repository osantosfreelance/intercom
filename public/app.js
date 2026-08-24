'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let socket = null;
let localStream = null;
let mySocketId = null;
let myAlias = null;
let isSpeaking = false;

// peers[socketId] = { alias, pc (RTCPeerConnection), speaking }
const peers = {};

// ── DOM refs ───────────────────────────────────────────────────────────────
const screenJoin    = document.getElementById('screen-join');
const screenSession = document.getElementById('screen-session');
const inputAlias    = document.getElementById('input-alias');
const inputCode     = document.getElementById('input-code');
const joinError     = document.getElementById('join-error');
const btnJoin       = document.getElementById('btn-join');
const btnExit       = document.getElementById('btn-exit');
const grid          = document.getElementById('participants-grid');
const pttZone       = document.getElementById('ptt-zone');
const pttIndicator  = document.getElementById('ptt-indicator');

// ── RTC config ─────────────────────────────────────────────────────────────
// Free public STUN — enough for LAN/intranet use; add TURN for cross-NAT if needed
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// ── Utility ────────────────────────────────────────────────────────────────
function initials(alias) {
  return alias
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function showJoinError(msg) {
  joinError.textContent = msg;
  joinError.hidden = false;
  inputCode.classList.add('input-error');
  // Re-trigger animation
  joinError.style.animation = 'none';
  joinError.offsetHeight; // reflow
  joinError.style.animation = '';
}

function clearJoinError() {
  joinError.hidden = true;
  inputCode.classList.remove('input-error');
}

// ── Participant card rendering ─────────────────────────────────────────────
function buildCard(socketId, alias, isSelf) {
  const card = document.createElement('div');
  card.className = 'participant-card' + (isSelf ? ' self' : '');
  card.dataset.id = socketId;

  const avatar = document.createElement('div');
  avatar.className = 'participant-avatar';
  avatar.textContent = initials(alias);

  const name = document.createElement('div');
  name.className = 'participant-name';
  name.textContent = alias + (isSelf ? ' (you)' : '');

  const mic = document.createElement('div');
  mic.className = 'participant-mic';
  mic.textContent = '🔇';

  card.appendChild(avatar);
  card.appendChild(name);
  card.appendChild(mic);
  return card;
}

function renderGrid() {
  grid.innerHTML = '';

  // Self
  const selfCard = buildCard(mySocketId, myAlias, true);
  if (isSpeaking) {
    selfCard.classList.add('speaking');
    selfCard.querySelector('.participant-mic').textContent = '🎙';
  }
  grid.appendChild(selfCard);

  // Remote peers
  for (const [id, peer] of Object.entries(peers)) {
    const card = buildCard(id, peer.alias, false);
    if (peer.speaking) {
      card.classList.add('speaking');
      card.querySelector('.participant-mic').textContent = '🎙';
    }
    grid.appendChild(card);
  }

  if (grid.children.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V19c0 .55.45 1 1 1s1-.45 1-1v-1.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
        </svg>
        <p>Waiting for others to join…</p>
      </div>`;
  }
}

function setSpeakingCard(socketId, speaking) {
  const card = grid.querySelector(`[data-id="${socketId}"]`);
  if (!card) return;
  card.classList.toggle('speaking', speaking);
  card.querySelector('.participant-mic').textContent = speaking ? '🎙' : '🔇';
}

// ── WebRTC ─────────────────────────────────────────────────────────────────
async function createPeer(remoteId, polite) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  peers[remoteId] = peers[remoteId] || { alias: peers[remoteId]?.alias || remoteId, speaking: false };
  peers[remoteId].pc = pc;

  // Attach local audio tracks
  if (localStream) {
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  }

  // Receive remote audio
  pc.ontrack = ({ streams }) => {
    if (!streams[0]) return;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = streams[0];
    // Keep audio elements off-screen
    audio.style.display = 'none';
    audio.dataset.peer = remoteId;
    document.body.appendChild(audio);
  };

  // Send ICE candidates via Socket.IO
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { to: remoteId, signal: { candidate } });
  };

  // Negotiation (perfect negotiation pattern)
  let makingOffer = false;
  let ignoreOffer = false;

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('signal', { to: remoteId, signal: { description: pc.localDescription } });
    } catch (e) {
      console.error('negotiation error', e);
    } finally {
      makingOffer = false;
    }
  };

  pc.onsignalingstatechange = () => {
    if (pc.signalingState === 'closed') removePeer(remoteId);
  };

  // Store polite/making/ignore on the pc object for the signal handler
  pc._polite = polite;
  pc._makingOffer = () => makingOffer;
  pc._ignoreOffer = (v) => { ignoreOffer = v; };
  pc._getIgnoreOffer = () => ignoreOffer;

  return pc;
}

async function handleSignal(fromId, signal) {
  let peer = peers[fromId];

  if (!peer || !peer.pc) {
    // Incoming offer from someone we haven't set up a PC for yet — create one (polite=true)
    await createPeer(fromId, true);
    peer = peers[fromId];
  }

  const pc = peer.pc;
  const polite = pc._polite;

  try {
    if (signal.description) {
      const offerCollision =
        signal.description.type === 'offer' &&
        (pc._makingOffer() || pc.signalingState !== 'stable');

      pc._ignoreOffer(!polite && offerCollision);
      if (pc._getIgnoreOffer()) return;

      await pc.setRemoteDescription(signal.description);

      if (signal.description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('signal', { to: fromId, signal: { description: pc.localDescription } });
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (e) {
        if (!pc._getIgnoreOffer()) throw e;
      }
    }
  } catch (e) {
    console.error('signal handling error', e);
  }
}

function removePeer(socketId) {
  const peer = peers[socketId];
  if (!peer) return;
  if (peer.pc) {
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.close();
  }
  // Remove audio element
  const audio = document.querySelector(`audio[data-peer="${socketId}"]`);
  if (audio) audio.remove();
  delete peers[socketId];
}

function removeAllPeers() {
  for (const id of Object.keys(peers)) removePeer(id);
}

// ── Push-to-talk ───────────────────────────────────────────────────────────
function setMuted(muted) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
}

function startSpeaking() {
  if (isSpeaking) return;
  isSpeaking = true;
  setMuted(false);
  document.body.classList.add('ptt-active');
  pttIndicator.hidden = false;
  setSpeakingCard(mySocketId, true);
  socket.emit('speaking:start');
}

function stopSpeaking() {
  if (!isSpeaking) return;
  isSpeaking = false;
  setMuted(true);
  document.body.classList.remove('ptt-active');
  pttIndicator.hidden = true;
  setSpeakingCard(mySocketId, false);
  socket.emit('speaking:end');
}

// PTT zone: pointerdown = start speaking, pointerup/cancel = stop
pttZone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startSpeaking();
});
pttZone.addEventListener('pointerup', (e) => {
  e.preventDefault();
  stopSpeaking();
});
pttZone.addEventListener('pointercancel', stopSpeaking);
pttZone.addEventListener('pointerleave', stopSpeaking);

// Also handle keyboard (spacebar) for desktop
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && screenSession.classList.contains('active') && !e.repeat) {
    e.preventDefault();
    startSpeaking();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && screenSession.classList.contains('active')) {
    e.preventDefault();
    stopSpeaking();
  }
});

// ── Exit ───────────────────────────────────────────────────────────────────
btnExit.addEventListener('click', (e) => {
  e.stopPropagation(); // prevent PTT trigger
  exitSession();
});

function exitSession() {
  stopSpeaking();
  if (socket) socket.emit('leave');
  removeAllPeers();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  mySocketId = null;
  myAlias = null;
  peers.__proto__ = Object.prototype; // keep ref but clear

  // Switch back to join screen
  screenSession.classList.remove('active');
  screenJoin.classList.add('active');
  clearJoinError();
  inputAlias.value = '';
  inputCode.value = '';
  grid.innerHTML = '';
}

// ── Join ───────────────────────────────────────────────────────────────────
btnJoin.addEventListener('click', handleJoin);
[inputAlias, inputCode].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleJoin(); })
);

async function handleJoin() {
  clearJoinError();
  const alias = inputAlias.value.trim();
  const sessionCode = inputCode.value.trim();

  if (!alias) {
    inputAlias.focus();
    return;
  }
  if (!sessionCode) {
    inputCode.focus();
    return;
  }

  btnJoin.disabled = true;
  btnJoin.textContent = 'Connecting…';

  // Request mic access first
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false, // device default — PTT means no noise anyway
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1,
      },
      video: false,
    });
    // Start muted — only unmuted on PTT hold
    setMuted(true);
  } catch (err) {
    showJoinError('Microphone access denied. Please allow mic and try again.');
    btnJoin.disabled = false;
    btnJoin.textContent = 'Join Session';
    return;
  }

  // Connect to signaling server
  if (!socket || !socket.connected) {
    socket = io();

    socket.on('join:ok', async ({ socketId, participants }) => {
      mySocketId = socketId;
      myAlias = alias;

      // Switch screens
      screenJoin.classList.remove('active');
      screenSession.classList.add('active');
      btnJoin.disabled = false;
      btnJoin.textContent = 'Join Session';

      // Set up peers for existing participants
      for (const p of participants) {
        if (p.id === mySocketId) continue;
        peers[p.id] = { alias: p.alias, speaking: p.speaking, pc: null };
        // We are impolite (we initiated connection to existing peer)
        await createPeer(p.id, false);
      }

      renderGrid();
    });

    socket.on('join:error', ({ message }) => {
      if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
      showJoinError(message);
      btnJoin.disabled = false;
      btnJoin.textContent = 'Join Session';
    });

    socket.on('participant:joined', async ({ id, alias: pAlias }) => {
      peers[id] = { alias: pAlias, speaking: false, pc: null };
      // New joiner: existing peers are polite toward them
      await createPeer(id, true);
      renderGrid();
    });

    socket.on('participant:left', ({ id }) => {
      removePeer(id);
      delete peers[id];
      renderGrid();
    });

    socket.on('signal', ({ from, signal }) => {
      handleSignal(from, signal);
    });

    socket.on('speaking:start', ({ id }) => {
      if (peers[id]) peers[id].speaking = true;
      setSpeakingCard(id, true);
    });

    socket.on('speaking:end', ({ id }) => {
      if (peers[id]) peers[id].speaking = false;
      setSpeakingCard(id, false);
    });

    socket.on('disconnect', () => {
      // Server went away
      exitSession();
    });
  }

  socket.emit('join', { alias, sessionCode });
}
