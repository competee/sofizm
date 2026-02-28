const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const url = require('url');

const fallacies = JSON.parse(fs.readFileSync('./data/fallacies.json'));
const topics = JSON.parse(fs.readFileSync('./data/topics.json'));

// ─── HTTP SERVER ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  filePath = path.join(__dirname, '../public', filePath);

  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── GAME STATE ──────────────────────────────────────────────────────────────
const PHASES = {
  LOBBY: 'lobby',
  TOPIC_SELECT: 'topic_select',
  FALLACY_DEAL: 'fallacy_deal',
  SPEECH: 'speech',
  VOTE: 'vote',
  MAP: 'map',
  CAPTURE: 'capture',
  ROUND_END: 'round_end',
};

let rooms = {};

function createRoom(code) {
  return {
    code,
    phase: PHASES.LOBBY,
    host: null,
    players: {},          // id -> { id, name, color, score, territories[] }
    round: 0,
    currentTopics: [],    // 3 topics for players to choose from
    playerTopics: {},     // playerId -> chosen topic
    dealtFallacies: {},   // playerId -> [5 fallacy ids]
    speeches: {},         // playerId -> done bool
    votes: {},            // voterId -> targetPlayerId
    roundScores: {},      // playerId -> points this round
    map: null,            // initialized on first MAP phase
    timer: null,
    timerEnd: null,
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickFallacies(count = 5, maxDifficulty = 4) {
  const pool = fallacies.filter(f => f.id !== 0 && f.difficulty <= maxDifficulty);
  return shuffle(pool).slice(0, count);
}

function pickTopics(count = 3, maxDifficulty = 4) {
  const pool = topics.filter(t => t.difficulty <= maxDifficulty);
  return shuffle(pool).slice(0, count).map(t => t.text || t);
}

function getDeckDifficulty(round) {
  // Gradually increase difficulty as rounds progress
  if (round <= 2) return 2;
  if (round <= 4) return 3;
  return 4;
}

function initMap(playerIds) {
  // Simple hex-like grid: 7x5 = 35 cells, distribute evenly
  const cells = [];
  const total = 35;
  const perPlayer = Math.floor(total / playerIds.length);

  let idx = 0;
  playerIds.forEach((pid, i) => {
    for (let j = 0; j < perPlayer; j++) {
      cells.push({ id: idx++, owner: pid });
    }
  });
  // remaining cells neutral
  while (idx < total) cells.push({ id: idx++, owner: null });

  return { cells, rows: 5, cols: 7 };
}

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  Object.values(room.players).forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(str);
  });
  if (room.host && room.host.ws && room.host.ws.readyState === WebSocket.OPEN) {
    room.host.ws.send(str);
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomPublicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
    })),
    map: room.map,
    timerEnd: room.timerEnd,
  };
}

function startTimer(room, seconds, onEnd) {
  clearTimeout(room.timer);
  room.timerEnd = Date.now() + seconds * 1000;
  broadcast(room, { type: 'timer', timerEnd: room.timerEnd });
  room.timer = setTimeout(onEnd, seconds * 1000);
}

// ─── PHASE TRANSITIONS ───────────────────────────────────────────────────────
function gotoTopicSelect(room) {
  room.phase = PHASES.TOPIC_SELECT;
  const diff = getDeckDifficulty(room.round);
  room.currentTopics = pickTopics(3, diff);
  room.playerTopics = {};
  room.dealtFallacies = {};
  room.speeches = {};
  room.votes = {};
  room.roundScores = {};
  room.round++;

  broadcast(room, { type: 'phase', phase: room.phase, round: room.round });

  // Send each player the topic options
  Object.values(room.players).forEach(p => {
    sendTo(p.ws, { type: 'topic_options', topics: room.currentTopics });
  });

  startTimer(room, 30, () => {
    // Auto-assign random topic to those who didn't choose
    Object.values(room.players).forEach(p => {
      if (!room.playerTopics[p.id]) {
        room.playerTopics[p.id] = room.currentTopics[Math.floor(Math.random() * room.currentTopics.length)];
      }
    });
    gotoFallacyDeal(room);
  });
}

function gotoFallacyDeal(room) {
  room.phase = PHASES.FALLACY_DEAL;

  const diff = getDeckDifficulty(room.round);
  Object.values(room.players).forEach(p => {
    const cards = pickFallacies(5, diff);
    room.dealtFallacies[p.id] = cards.map(c => c.id);
    sendTo(p.ws, {
      type: 'fallacy_deal',
      cards: cards,
      yourTopic: room.playerTopics[p.id],
    });
  });

  broadcast(room, { type: 'phase', phase: room.phase });
  startTimer(room, 60, () => gotoSpeech(room));
}

function gotoSpeech(room) {
  room.phase = PHASES.SPEECH;
  broadcast(room, {
    type: 'phase',
    phase: room.phase,
    playerTopics: room.playerTopics,
  });
  // Players speak in real life; host controls flow
}

function gotoVote(room) {
  room.phase = PHASES.VOTE;
  broadcast(room, {
    type: 'phase',
    phase: room.phase,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
  });
  startTimer(room, 30, () => tallyVotes(room));
}

function tallyVotes(room) {
  const tally = {};
  Object.values(room.players).forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(targetId => {
    if (tally[targetId] !== undefined) tally[targetId]++;
  });

  // Points: 3 for most votes, 1 for each vote received
  let maxVotes = 0;
  Object.values(tally).forEach(v => { if (v > maxVotes) maxVotes = v; });

  Object.entries(tally).forEach(([pid, v]) => {
    const pts = v + (v === maxVotes && maxVotes > 0 ? 3 : 0);
    room.roundScores[pid] = pts;
    room.players[pid].score += pts;
  });

  broadcast(room, { type: 'vote_result', tally, roundScores: room.roundScores });
  setTimeout(() => gotoMap(room), 4000);
}

function gotoMap(room) {
  room.phase = PHASES.MAP;
  if (!room.map) room.map = initMap(Object.keys(room.players));

  broadcast(room, {
    type: 'phase',
    phase: room.phase,
    map: room.map,
    roundScores: room.roundScores,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
  });

  // Send each player their available capture points
  Object.values(room.players).forEach(p => {
    sendTo(p.ws, {
      type: 'map_turn',
      capturePoints: room.roundScores[p.id] || 0,
      map: room.map,
    });
  });

  startTimer(room, 45, () => gotoRoundEnd(room));
}

function applyCapture(room, playerId, cellIds) {
  const pts = room.roundScores[playerId] || 0;
  let used = 0;
  cellIds.forEach(cid => {
    if (used >= pts) return;
    const cell = room.map.cells.find(c => c.id === cid);
    if (cell && cell.owner !== playerId) {
      cell.owner = playerId;
      used++;
    }
  });
  room.roundScores[playerId] = pts - used; // remaining points
  broadcast(room, { type: 'map_update', map: room.map });
}

function gotoRoundEnd(room) {
  room.phase = PHASES.ROUND_END;
  broadcast(room, {
    type: 'phase',
    phase: room.phase,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
    map: room.map,
  });
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

const COLORS = ['#e63946','#2a9d8f','#e9c46a','#f4a261','#457b9d','#8ecae6','#a8dadc','#606c38'];

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    // ── CREATE ROOM ──
    if (type === 'create_room') {
      const code = Math.random().toString(36).slice(2, 6).toUpperCase();
      rooms[code] = createRoom(code);
      rooms[code].host = { ws };
      ws.roomCode = code;
      ws.role = 'host';
      sendTo(ws, { type: 'room_created', code, state: roomPublicState(rooms[code]) });
      return;
    }

    // ── JOIN ROOM ──
    if (type === 'join_room') {
      const room = rooms[msg.code];
      if (!room) { sendTo(ws, { type: 'error', msg: 'Кімната не знайдена' }); return; }
      if (room.phase !== PHASES.LOBBY) { sendTo(ws, { type: 'error', msg: 'Гра вже почалась' }); return; }

      const id = Math.random().toString(36).slice(2, 8);
      const colorIdx = Object.keys(room.players).length % COLORS.length;
      room.players[id] = { id, name: msg.name || `Гравець ${colorIdx + 1}`, color: COLORS[colorIdx], score: 0, ws };
      ws.roomCode = msg.code;
      ws.playerId = id;
      ws.role = 'player';

      sendTo(ws, { type: 'joined', playerId: id, color: COLORS[colorIdx], state: roomPublicState(room) });
      broadcast(room, { type: 'player_joined', players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })) });
      return;
    }

    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;

    // ── HOST: START GAME ──
    if (type === 'start_game' && ws.role === 'host') {
      if (Object.keys(room.players).length < 2) {
        sendTo(ws, { type: 'error', msg: 'Потрібно мінімум 2 гравці' });
        return;
      }
      gotoTopicSelect(room);
      return;
    }

    // ── HOST: NEXT PHASE ──
    if (type === 'next_phase' && ws.role === 'host') {
      clearTimeout(room.timer);
      if (room.phase === PHASES.FALLACY_DEAL) gotoSpeech(room);
      else if (room.phase === PHASES.SPEECH) gotoVote(room);
      else if (room.phase === PHASES.ROUND_END) gotoTopicSelect(room);
      return;
    }

    // ── PLAYER: CHOOSE TOPIC ──
    if (type === 'choose_topic' && ws.role === 'player') {
      const pid = ws.playerId;
      if (room.phase === PHASES.TOPIC_SELECT && !room.playerTopics[pid]) {
        room.playerTopics[pid] = msg.topic;
        sendTo(ws, { type: 'topic_chosen', topic: msg.topic });

        // Check if all chose
        if (Object.keys(room.playerTopics).length === Object.keys(room.players).length) {
          clearTimeout(room.timer);
          gotoFallacyDeal(room);
        }
      }
      return;
    }

    // ── PLAYER: VOTE ──
    if (type === 'vote' && ws.role === 'player') {
      if (room.phase === PHASES.VOTE) {
        room.votes[ws.playerId] = msg.targetId;
        sendTo(ws, { type: 'vote_cast' });

        if (Object.keys(room.votes).length === Object.keys(room.players).length) {
          clearTimeout(room.timer);
          tallyVotes(room);
        }
      }
      return;
    }

    // ── PLAYER: CAPTURE ──
    if (type === 'capture' && ws.role === 'player') {
      if (room.phase === PHASES.MAP) {
        applyCapture(room, ws.playerId, msg.cellIds);
      }
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;
    if (ws.role === 'player' && ws.playerId) {
      delete room.players[ws.playerId];
      broadcast(room, {
        type: 'player_left',
        players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score }))
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`FallacyMania server running on http://localhost:${PORT}`));
