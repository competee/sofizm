const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const url = require('url');

const fallacies = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/fallacies.json')));
const topics    = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/topics.json')));

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', node: process.version, uptime: Math.floor(process.uptime()) + 's' }));
    return;
  }
  const filePath = path.join(__dirname, '../public', pathname === '/' ? '/index.html' : pathname);
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + pathname); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickFallacies(count, maxDiff) {
  return shuffle(fallacies.filter(f => f.id !== 0 && f.difficulty <= maxDiff)).slice(0, count);
}

function pickUniqueTopics(playerCount, maxDiff) {
  const pool = shuffle(topics.filter(t => t.difficulty <= maxDiff));
  const result = [];
  let idx = 0;
  for (let i = 0; i < playerCount; i++) {
    const group = [];
    for (let j = 0; j < 3; j++) {
      group.push((pool[idx % pool.length].text || pool[idx % pool.length]));
      idx++;
    }
    result.push(group);
  }
  return result;
}

function getDeckDifficulty(round) {
  if (round <= 2) return 2;
  if (round <= 4) return 3;
  return 4;
}

// HEX MAP - offset coordinates, pointy-top
function hexNeighborOffsets(row) {
  return row % 2 === 0
    ? [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]]
    : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
}

function hexDistance(r1, c1, r2, c2) {
  const toCube = (r, c) => {
    const x = c - (r - (r & 1)) / 2;
    const z = r;
    return { x, y: -x - z, z };
  };
  const a = toCube(r1, c1), b = toCube(r2, c2);
  return Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y), Math.abs(a.z-b.z));
}

function initMap(playerIds) {
  const n = playerIds.length;
  const RADIUS = n <= 3 ? 5 : n <= 5 ? 6 : 7;
  const GRID = RADIUS * 2 + 1;
  const CR = RADIUS, CC = RADIUS;
  const cells = [];
  const cellMap = {};

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const dist = hexDistance(r, c, CR, CC);
      if (dist <= RADIUS) {
        const id = r * GRID + c;
        const cell = { id, row: r, col: c, owner: null, dist };
        cells.push(cell);
        cellMap[r + ',' + c] = cell;
      }
    }
  }

  const edgeCells = cells.filter(c => c.dist === RADIUS);
  const CLUSTER = Math.max(3, Math.floor(edgeCells.length / n) - 1);

  const anchors = playerIds.map((_, i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    let best = null, bestD = Infinity;
    edgeCells.forEach(cell => {
      const a = Math.atan2(cell.row - CR, cell.col - CC);
      let diff = Math.abs(a - angle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < bestD) { bestD = diff; best = cell; }
    });
    return best;
  });

  anchors.forEach((anchor, i) => {
    if (!anchor) return;
    const pid = playerIds[i];
    const visited = new Set([anchor.row + ',' + anchor.col]);
    const queue = [anchor];
    let count = 0;
    while (queue.length && count < CLUSTER) {
      const cur = queue.shift();
      if (cur.owner && cur.owner !== pid) continue;
      cur.owner = pid;
      count++;
      hexNeighborOffsets(cur.row)
        .map(([dr, dc]) => cellMap[(cur.row+dr) + ',' + (cur.col+dc)])
        .filter(nb => nb && !visited.has(nb.row+','+nb.col) && (!nb.owner || nb.owner === pid))
        .sort((a, b) => b.dist - a.dist)
        .forEach(nb => { visited.add(nb.row+','+nb.col); queue.push(nb); });
    }
  });

  return { cells, grid: GRID, radius: RADIUS, centerR: CR, centerC: CC };
}

function isAdjacentHex(map, cellId, playerId) {
  const cell = map.cells.find(c => c.id === cellId);
  if (!cell || cell.owner === playerId) return false;
  return hexNeighborOffsets(cell.row).some(([dr, dc]) => {
    const nb = map.cells.find(c => c.row === cell.row+dr && c.col === cell.col+dc);
    return nb && nb.owner === playerId;
  });
}

// GAME STATE
const PHASES = { LOBBY:'lobby', TOPIC_SELECT:'topic_select', FALLACY_DEAL:'fallacy_deal', SPEECH:'speech', VOTE:'vote', MAP:'map', ROUND_END:'round_end' };
let rooms = {};

function createRoom(code) {
  return { code, phase: PHASES.LOBBY, host: null, players: {}, round: 0,
    playerTopics: {}, sharedCards: [], votes: {}, roundScores: {}, map: null, timer: null, timerEnd: null };
}

const COLORS = ['#e63946','#2a9d8f','#e9c46a','#f4a261','#457b9d','#06d6a0','#a8dadc','#ff6b6b'];

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  if (room.host && room.host.ws && room.host.ws.readyState === WebSocket.OPEN) room.host.ws.send(str);
  Object.values(room.players).forEach(p => { if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(str); });
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function startTimer(room, seconds, onEnd) {
  clearTimeout(room.timer);
  room.timerEnd = Date.now() + seconds * 1000;
  broadcast(room, { type: 'timer', timerEnd: room.timerEnd, seconds });
  room.timer = setTimeout(onEnd, seconds * 1000);
}

function gotoTopicSelect(room) {
  room.phase = PHASES.TOPIC_SELECT;
  room.playerTopics = {}; room.sharedCards = []; room.votes = {}; room.roundScores = {};
  room.round++;
  const diff = getDeckDifficulty(room.round);
  const players = Object.values(room.players);
  const topicGroups = pickUniqueTopics(players.length, diff);
  broadcast(room, { type: 'phase', phase: room.phase, round: room.round });
  players.forEach((p, i) => sendTo(p.ws, { type: 'topic_options', topics: topicGroups[i] }));
  // зберігаємо для автовибору
  room._topicGroups = topicGroups;
  room._playerOrder = players.map(p => p.id);
  startTimer(room, 30, () => {
    room._playerOrder.forEach((pid, i) => {
      if (!room.playerTopics[pid]) room.playerTopics[pid] = room._topicGroups[i][0];
    });
    gotoFallacyDeal(room);
  });
}

function gotoFallacyDeal(room) {
  room.phase = PHASES.FALLACY_DEAL;
  const diff = getDeckDifficulty(room.round);
  room.sharedCards = pickFallacies(5, diff);
  // broadcast phase + спільні картки хосту
  broadcast(room, { type: 'phase', phase: room.phase, sharedCards: room.sharedCards });
  // гравцям — самі картки + їхня тема
  Object.values(room.players).forEach(p => {
    sendTo(p.ws, { type: 'fallacy_deal', cards: room.sharedCards, yourTopic: room.playerTopics[p.id] });
  });
  startTimer(room, 60, () => gotoSpeech(room));
}

function gotoSpeech(room) {
  room.phase = PHASES.SPEECH;
  broadcast(room, { type: 'phase', phase: room.phase, playerTopics: room.playerTopics });
}

function gotoVote(room) {
  room.phase = PHASES.VOTE;
  broadcast(room, { type: 'phase', phase: room.phase,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
    playerTopics: room.playerTopics });
  startTimer(room, 30, () => tallyVotes(room));
}

function tallyVotes(room) {
  const tally = {};
  Object.values(room.players).forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(tid => { if (tally[tid] !== undefined) tally[tid]++; });
  const maxV = Math.max(0, ...Object.values(tally));
  Object.entries(tally).forEach(([pid, v]) => {
    const pts = v + (v === maxV && maxV > 0 ? 3 : 0);
    room.roundScores[pid] = pts;
    if (room.players[pid]) room.players[pid].score += pts;
  });
  broadcast(room, { type: 'vote_result', tally, roundScores: room.roundScores });
  setTimeout(() => gotoMap(room), 4000);
}

function gotoMap(room) {
  room.phase = PHASES.MAP;
  if (!room.map) room.map = initMap(Object.keys(room.players));
  const playerData = Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
  broadcast(room, { type: 'phase', phase: room.phase, map: room.map, roundScores: room.roundScores, players: playerData });
  Object.values(room.players).forEach(p => {
    sendTo(p.ws, { type: 'map_turn', capturePoints: room.roundScores[p.id] || 0, map: room.map, players: playerData });
  });
  startTimer(room, 45, () => gotoRoundEnd(room));
}

function applyCapture(room, playerId, cellIds) {
  let pts = room.roundScores[playerId] || 0;
  let used = 0;
  cellIds.forEach(cid => {
    if (used >= pts) return;
    if (!isAdjacentHex(room.map, cid, playerId)) return;
    const cell = room.map.cells.find(c => c.id === cid);
    if (cell && cell.owner !== playerId) { cell.owner = playerId; used++; }
  });
  room.roundScores[playerId] = pts - used;
  broadcast(room, { type: 'map_update', map: room.map });
}

function gotoRoundEnd(room) {
  room.phase = PHASES.ROUND_END;
  broadcast(room, { type: 'phase', phase: room.phase,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
    map: room.map });
}

// WEBSOCKET
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log('[WS] upgrade:', req.url);
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  console.log('[WS] connected');
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type } = msg;

    if (type === 'create_room') {
      const code = Math.random().toString(36).slice(2,6).toUpperCase();
      rooms[code] = createRoom(code);
      rooms[code].host = { ws };
      ws.roomCode = code; ws.role = 'host';
      sendTo(ws, { type: 'room_created', code });
      return;
    }

    if (type === 'join_room') {
      const room = rooms[msg.code];
      if (!room) { sendTo(ws, { type: 'error', msg: 'Кімната не знайдена' }); return; }
      if (room.phase !== PHASES.LOBBY) { sendTo(ws, { type: 'error', msg: 'Гра вже почалась' }); return; }
      const id = Math.random().toString(36).slice(2,8);
      const color = COLORS[Object.keys(room.players).length % COLORS.length];
      const name = msg.name || 'Гравець';
      room.players[id] = { id, name, color, score: 0, ws };
      ws.roomCode = msg.code; ws.playerId = id; ws.role = 'player';
      sendTo(ws, { type: 'joined', playerId: id, color, name });
      broadcast(room, { type: 'player_joined', players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })) });
      return;
    }

    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;

    if (type === 'start_game' && ws.role === 'host') {
      if (Object.keys(room.players).length < 2) { sendTo(ws, { type: 'error', msg: 'Потрібно мінімум 2 гравці' }); return; }
      gotoTopicSelect(room); return;
    }
    if (type === 'next_phase' && ws.role === 'host') {
      clearTimeout(room.timer);
      if (room.phase === PHASES.FALLACY_DEAL) gotoSpeech(room);
      else if (room.phase === PHASES.SPEECH) gotoVote(room);
      else if (room.phase === PHASES.ROUND_END) gotoTopicSelect(room);
      return;
    }
    if (type === 'choose_topic' && ws.role === 'player' && room.phase === PHASES.TOPIC_SELECT && !room.playerTopics[ws.playerId]) {
      room.playerTopics[ws.playerId] = msg.topic;
      sendTo(ws, { type: 'topic_chosen', topic: msg.topic });
      if (Object.keys(room.playerTopics).length === Object.keys(room.players).length) {
        clearTimeout(room.timer); gotoFallacyDeal(room);
      }
      return;
    }
    if (type === 'vote' && ws.role === 'player' && room.phase === PHASES.VOTE) {
      room.votes[ws.playerId] = msg.targetId;
      sendTo(ws, { type: 'vote_cast' });
      if (Object.keys(room.votes).length === Object.keys(room.players).length) {
        clearTimeout(room.timer); tallyVotes(room);
      }
      return;
    }
    if (type === 'capture' && ws.role === 'player' && room.phase === PHASES.MAP) {
      applyCapture(room, ws.playerId, msg.cellIds);
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room || ws.role !== 'player' || !ws.playerId) return;
    delete room.players[ws.playerId];
    broadcast(room, { type: 'player_left', players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })) });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`FallacyMania running on port ${PORT}`));