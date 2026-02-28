const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const url = require('url');

const fallacies = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/fallacies.json')));
const civData   = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/civilizations.json')));

// ─── HTTP ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) + 's', rooms: Object.keys(rooms).length }));
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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

function getDeckDifficulty(round) {
  if (round <= 2) return 2;
  if (round <= 4) return 3;
  return 4;
}

// Факти конфронтації між двома цивілізаціями (в будь-якому порядку ключа)
function getConfrontationFacts(civA, civB) {
  return civData.confrontations[`${civA}_vs_${civB}`]
      || civData.confrontations[`${civB}_vs_${civA}`]
      || [];
}

// ─── HEX MAP ─────────────────────────────────────────────────────────────────
function hexNeighborOffsets(row) {
  return row % 2 === 0
    ? [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]]
    : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
}

function hexDistance(r1, c1, r2, c2) {
  const toCube = (r, c) => { const x = c - (r - (r & 1)) / 2; return { x, y: -x - r, z: r }; };
  const a = toCube(r1, c1), b = toCube(r2, c2);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

function initMap(playerIds) {
  const n = playerIds.length;
  const RADIUS = n <= 3 ? 5 : n <= 5 ? 6 : 7;
  const GRID = RADIUS * 2 + 1;
  const CR = RADIUS, CC = RADIUS;
  const cells = [], cellMap = {};

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const dist = hexDistance(r, c, CR, CC);
      if (dist <= RADIUS) {
        const cell = { id: r * GRID + c, row: r, col: c, owner: null, dist };
        cells.push(cell); cellMap[r + ',' + c] = cell;
      }
    }
  }

  const edgeCells = cells.filter(c => c.dist === RADIUS);
  const CLUSTER = Math.max(3, Math.floor(edgeCells.length / n) - 1);

  playerIds.forEach((pid, i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    let best = null, bestD = Infinity;
    edgeCells.forEach(cell => {
      let diff = Math.abs(Math.atan2(cell.row - CR, cell.col - CC) - angle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < bestD) { bestD = diff; best = cell; }
    });
    if (!best) return;
    const visited = new Set([best.row + ',' + best.col]);
    const queue = [best];
    let count = 0;
    while (queue.length && count < CLUSTER) {
      const cur = queue.shift();
      if (cur.owner && cur.owner !== pid) continue;
      cur.owner = pid; count++;
      hexNeighborOffsets(cur.row)
        .map(([dr, dc]) => cellMap[(cur.row + dr) + ',' + (cur.col + dc)])
        .filter(nb => nb && !visited.has(nb.row + ',' + nb.col) && (!nb.owner || nb.owner === pid))
        .sort((a, b) => b.dist - a.dist)
        .forEach(nb => { visited.add(nb.row + ',' + nb.col); queue.push(nb); });
    }
  });

  return { cells, grid: GRID, radius: RADIUS, centerR: CR, centerC: CC };
}

function isAdjacentHex(map, cellId, playerId) {
  const cell = map.cells.find(c => c.id === cellId);
  if (!cell || cell.owner === playerId) return false;
  return hexNeighborOffsets(cell.row).some(([dr, dc]) => {
    const nb = map.cells.find(c => c.row === cell.row + dr && c.col === cell.col + dc);
    return nb && nb.owner === playerId;
  });
}

// ─── GAME STATE ───────────────────────────────────────────────────────────────
const PHASES = {
  LOBBY:       'lobby',
  CIV_SELECT:  'civ_select',
  ATTACK_PREP: 'attack_prep',
  DEFENSE:     'defense',
  CANCEL_VOTE: 'cancel_vote',
  RATING:      'rating',
  MAP:         'map',
  ROUND_END:   'round_end',
};

let rooms = {};

function createRoom(code) {
  return {
    code, phase: PHASES.LOBBY,
    host: null, players: {}, round: 0,
    attackOrder: [], currentAttackerIdx: 0,
    currentAttack: null,   // { attackerId, defenderId, factId, fallacyId, attackerCards, defenderCards }
    defenseChoice: null,   // 'speak' | 'silence'
    cancelVotes: {},       // playerId -> 'cancel' | 'ok'
    speeches: [],          // [{ playerId, role, civEmoji, civName, fallacyName }]
    ratings: {},           // voterId -> [playerId, ...]  (від кращого)
    roundScores: {},
    map: null,
    timer: null, timerEnd: null,
  };
}

const COLORS = ['#e63946','#2a9d8f','#e9c46a','#f4a261','#457b9d','#06d6a0','#a8dadc','#ff6b6b'];

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  if (room.host?.ws?.readyState === WebSocket.OPEN) room.host.ws.send(str);
  Object.values(room.players).forEach(p => {
    if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(str);
  });
}

function sendTo(ws, msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function pubPlayers(room) {
  return Object.values(room.players).map(p => ({
    id: p.id, name: p.name, color: p.color, score: p.score,
    civId: p.civId || null, civName: p.civName || null, civEmoji: p.civEmoji || null,
  }));
}

function startTimer(room, seconds, onEnd) {
  clearTimeout(room.timer);
  room.timerEnd = Date.now() + seconds * 1000;
  broadcast(room, { type: 'timer', timerEnd: room.timerEnd, seconds });
  room.timer = setTimeout(onEnd, seconds * 1000);
}

// ─── PHASES ───────────────────────────────────────────────────────────────────

function gotoCivSelect(room) {
  room.phase = PHASES.CIV_SELECT;
  broadcast(room, {
    type: 'phase', phase: room.phase,
    civilizations: civData.civilizations,
    players: pubPlayers(room),
  });
  startTimer(room, 45, () => {
    // Автовибір для тих хто не встиг
    const taken = new Set(Object.values(room.players).filter(p => p.civId).map(p => p.civId));
    let ai = 0;
    const available = civData.civilizations.filter(c => !taken.has(c.id));
    Object.values(room.players).forEach(p => {
      if (!p.civId) {
        const civ = available[ai++ % available.length] || civData.civilizations[0];
        p.civId = civ.id; p.civName = civ.name; p.civEmoji = civ.emoji;
      }
    });
    gotoRoundStart(room);
  });
}

function gotoRoundStart(room) {
  room.round++;
  room.speeches = [];
  room.ratings = {};
  room.roundScores = {};
  Object.values(room.players).forEach(p => { room.roundScores[p.id] = 0; });

  room.attackOrder = shuffle(Object.keys(room.players));
  room.currentAttackerIdx = 0;

  broadcast(room, {
    type: 'round_start', round: room.round,
    players: pubPlayers(room),
    attackOrder: room.attackOrder,
  });

  setTimeout(() => gotoAttackPrep(room), 2500);
}

function gotoAttackPrep(room) {
  // Пропустити гравців що від'єднались
  while (room.currentAttackerIdx < room.attackOrder.length &&
         !room.players[room.attackOrder[room.currentAttackerIdx]]) {
    room.currentAttackerIdx++;
  }

  if (room.currentAttackerIdx >= room.attackOrder.length) {
    gotoRating(room);
    return;
  }

  room.phase = PHASES.ATTACK_PREP;
  const attackerId = room.attackOrder[room.currentAttackerIdx];
  const attacker = room.players[attackerId];
  const diff = getDeckDifficulty(room.round);
  const cards = pickFallacies(5, diff);

  const targets = Object.values(room.players)
    .filter(p => p.id !== attackerId)
    .map(p => ({ id: p.id, name: p.name, color: p.color, civId: p.civId, civName: p.civName, civEmoji: p.civEmoji }));

  room.currentAttack = { attackerId, defenderId: null, factId: null, fallacyId: null, attackerCards: cards, defenderCards: null };

  broadcast(room, {
    type: 'phase', phase: room.phase,
    attackerId, attackerName: attacker.name,
    attackerCivEmoji: attacker.civEmoji, attackerCivName: attacker.civName,
    players: pubPlayers(room),
    attackIndex: room.currentAttackerIdx + 1,
    attackTotal: room.attackOrder.length,
  });

  // Тільки атакуючому — картки і цілі з попереднім переглядом фактів
  sendTo(attacker.ws, {
    type: 'your_attack_turn',
    cards,
    targets,
    factsPreview: targets.reduce((acc, t) => {
      acc[t.id] = getConfrontationFacts(attacker.civId, t.civId).map(f => ({ id: f.id, title: f.title }));
      return acc;
    }, {}),
  });

  startTimer(room, 60, () => {
    // Автовибір якщо не встиг
    if (!room.currentAttack.defenderId && targets.length > 0) {
      const t = targets[0];
      const facts = getConfrontationFacts(attacker.civId, t.civId);
      room.currentAttack.defenderId = t.id;
      room.currentAttack.factId = facts[0]?.id || null;
      room.currentAttack.fallacyId = cards[0]?.id || null;
    }
    gotoDefense(room);
  });
}

function gotoDefense(room) {
  room.phase = PHASES.DEFENSE;
  room.defenseChoice = null;
  room.cancelVotes = {};

  const { attackerId, defenderId, factId, fallacyId, attackerCards } = room.currentAttack;
  const attacker = room.players[attackerId];
  const defender = room.players[defenderId];

  if (!attacker || !defender) { advanceAttack(room); return; }

  const allFacts = getConfrontationFacts(attacker.civId, defender.civId);
  const fact = allFacts.find(f => f.id === factId) || allFacts[0] || null;
  // FIX: fallacyId може бути string з клієнта — порівнюємо через Number()
  const usedFallacy = fallacies.find(f => f.id === Number(fallacyId)) || null;

  const diff = getDeckDifficulty(room.round);
  const defenderCards = pickFallacies(5, diff);
  room.currentAttack.defenderCards = defenderCards;

  // FIX: зберігаємо виступ АТАКУЮЧОГО в speeches
  room.speeches.push({
    playerId: attackerId,
    role: 'attack',
    civEmoji: attacker.civEmoji || '⚔️',
    civName: attacker.civName || '',
    playerName: attacker.name,
    fallacyName: usedFallacy?.name || null,
    fallacyId: Number(fallacyId),
    factTitle: fact?.title || null,
    targetName: defender.name,
    targetCivEmoji: defender.civEmoji || '',
  });

  broadcast(room, {
    type: 'phase', phase: room.phase,
    attackerId, attackerName: attacker.name,
    attackerCivEmoji: attacker.civEmoji, attackerCivName: attacker.civName,
    defenderId, defenderName: defender.name,
    defenderCivEmoji: defender.civEmoji, defenderCivName: defender.civName,
    fact: fact ? { id: fact.id, title: fact.title, body: fact.body, attacker_angle: fact.attacker_angle } : null,
    usedFallacy: usedFallacy ? { id: usedFallacy.id, name: usedFallacy.name, desc: usedFallacy.desc } : null,
    players: pubPlayers(room),
  });

  // Тільки захиснику — його картки і підказка захисту
  sendTo(defender.ws, {
    type: 'your_defense_turn',
    cards: defenderCards,
    fact: fact ? {
      id: fact.id, title: fact.title, body: fact.body,
      defender_angle: fact.defender_angle,
      attacker_angle: fact.attacker_angle,
    } : null,
  });

  startTimer(room, 30, () => {
    if (!room.defenseChoice) {
      room.defenseChoice = 'silence';
      room.roundScores[defenderId] = (room.roundScores[defenderId] || 0) - 1;
      broadcast(room, { type: 'defense_result', choice: 'silence', defenderId });
      setTimeout(() => advanceAttack(room), 2000);
    }
  });
}

function gotoCancelVote(room) {
  room.phase = PHASES.CANCEL_VOTE;
  const { defenderId } = room.currentAttack;
  const defender = room.players[defenderId];

  broadcast(room, {
    type: 'phase', phase: room.phase,
    defenderId,
    defenderName: defender?.name || '?',
    defenderCivEmoji: defender?.civEmoji || '🛡️',
    defenderCivName: defender?.civName || '',
  });

  startTimer(room, 20, () => tallyCancel(room));
}

function tallyCancel(room) {
  const { defenderId } = room.currentAttack;
  const cancelCount = Object.values(room.cancelVotes).filter(v => v === 'cancel').length;
  const totalVoters = Object.keys(room.players).length - 1;
  const cancelled = cancelCount > totalVoters / 2;

  if (cancelled) {
    room.roundScores[defenderId] = (room.roundScores[defenderId] || 0) - 4;
  } else {
    room.roundScores[defenderId] = (room.roundScores[defenderId] || 0) + 3;
    // Атакуючий теж отримує бал за успішну атаку
    room.roundScores[room.currentAttack.attackerId] = (room.roundScores[room.currentAttack.attackerId] || 0) + 2;
  }

  broadcast(room, { type: 'cancel_result', cancelled, defenderId, cancelCount, totalVoters });
  setTimeout(() => advanceAttack(room), 3000);
}

function advanceAttack(room) {
  room.currentAttackerIdx++;
  setTimeout(() => gotoAttackPrep(room), 2000);
}

function gotoRating(room) {
  room.phase = PHASES.RATING;
  const n = Object.keys(room.players).length;
  const topCount = n >= 6 ? 3 : n >= 4 ? 2 : 1;

  broadcast(room, {
    type: 'phase', phase: room.phase,
    speeches: room.speeches,
    topCount,
    players: pubPlayers(room),
  });

  startTimer(room, 45, () => tallyRatings(room));
}

function tallyRatings(room) {
  const pts = [5, 3, 1];
  const n = Object.keys(room.players).length;
  const topCount = n >= 6 ? 3 : n >= 4 ? 2 : 1;

  Object.values(room.ratings).forEach(ranked => {
    ranked.slice(0, topCount).forEach((pid, i) => {
      room.roundScores[pid] = (room.roundScores[pid] || 0) + (pts[i] || 1);
    });
  });

  Object.values(room.players).forEach(p => {
    p.score = (p.score || 0) + (room.roundScores[p.id] || 0);
  });

  broadcast(room, { type: 'rating_result', roundScores: room.roundScores, players: pubPlayers(room) });
  setTimeout(() => gotoMap(room), 3000);
}

function gotoMap(room) {
  room.phase = PHASES.MAP;
  if (!room.map) room.map = initMap(Object.keys(room.players));

  broadcast(room, {
    type: 'phase', phase: room.phase,
    map: room.map, roundScores: room.roundScores,
    players: pubPlayers(room),
  });

  Object.values(room.players).forEach(p => {
    sendTo(p.ws, {
      type: 'map_turn',
      capturePoints: Math.max(0, room.roundScores[p.id] || 0),
      map: room.map, players: pubPlayers(room),
    });
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
  broadcast(room, {
    type: 'phase', phase: room.phase,
    players: pubPlayers(room), map: room.map,
  });
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log('[WS] upgrade:', req.url);
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  console.log('[WS] new connection');

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type } = msg;

    if (type === 'create_room') {
      const code = Math.random().toString(36).slice(2, 6).toUpperCase();
      rooms[code] = createRoom(code);
      rooms[code].host = { ws };
      ws.roomCode = code; ws.role = 'host';
      sendTo(ws, { type: 'room_created', code });
      return;
    }

    if (type === 'join_room') {
      const room = rooms[msg.code];
      if (!room) { sendTo(ws, { type: 'error', msg: 'Кімнату не знайдено' }); return; }
      if (room.phase !== PHASES.LOBBY) { sendTo(ws, { type: 'error', msg: 'Гра вже йде' }); return; }
      if (Object.keys(room.players).length >= 8) { sendTo(ws, { type: 'error', msg: 'Кімната повна (макс 8)' }); return; }
      const id = Math.random().toString(36).slice(2, 8);
      const color = COLORS[Object.keys(room.players).length % COLORS.length];
      const name = (msg.name || 'Гравець').slice(0, 20);
      room.players[id] = { id, name, color, score: 0, ws, civId: null, civName: null, civEmoji: null };
      ws.roomCode = msg.code; ws.playerId = id; ws.role = 'player';
      sendTo(ws, { type: 'joined', playerId: id, color, name });
      broadcast(room, { type: 'player_joined', players: pubPlayers(room) });
      return;
    }

    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;

    // HOST ACTIONS
    if (ws.role === 'host') {
      if (type === 'start_game') {
        if (Object.keys(room.players).length < 2) { sendTo(ws, { type: 'error', msg: 'Потрібно мінімум 2 гравці' }); return; }
        gotoCivSelect(room);
      }
      if (type === 'next_phase') {
        clearTimeout(room.timer);
        const p = room.phase;
        if (p === PHASES.CIV_SELECT) gotoRoundStart(room);
        else if (p === PHASES.ATTACK_PREP) {
          // Автовибір першої доступної цілі якщо не вибрав
          const atk = room.currentAttack;
          if (!atk.defenderId) {
            const targets = Object.values(room.players).filter(pl => pl.id !== atk.attackerId);
            if (targets.length > 0) {
              const t = targets[0];
              const facts = getConfrontationFacts(room.players[atk.attackerId]?.civId, t.civId);
              atk.defenderId = t.id; atk.factId = facts[0]?.id || null;
              atk.fallacyId = atk.attackerCards[0]?.id || null;
            }
          }
          gotoDefense(room);
        }
        else if (p === PHASES.DEFENSE) {
          if (!room.defenseChoice) {
            room.defenseChoice = 'silence';
            room.roundScores[room.currentAttack.defenderId] = (room.roundScores[room.currentAttack.defenderId]||0) - 1;
            broadcast(room, { type: 'defense_result', choice: 'silence', defenderId: room.currentAttack.defenderId });
          }
          setTimeout(() => advanceAttack(room), 500);
        }
        else if (p === PHASES.CANCEL_VOTE) tallyCancel(room);
        else if (p === PHASES.RATING) tallyRatings(room);
        else if (p === PHASES.MAP) gotoRoundEnd(room);
        else if (p === PHASES.ROUND_END) gotoRoundStart(room);
      }
      return;
    }

    // PLAYER ACTIONS
    if (ws.role !== 'player') return;
    const pid = ws.playerId;

    if (type === 'choose_civ' && room.phase === PHASES.CIV_SELECT) {
      const civ = civData.civilizations.find(c => c.id === msg.civId);
      if (!civ) return;
      if (Object.values(room.players).some(p => p.id !== pid && p.civId === msg.civId)) {
        sendTo(ws, { type: 'error', msg: 'Цю цивілізацію вже обрали' }); return;
      }
      const p = room.players[pid];
      p.civId = civ.id; p.civName = civ.name; p.civEmoji = civ.emoji;
      sendTo(ws, { type: 'civ_chosen', civ });
      broadcast(room, { type: 'civ_update', players: pubPlayers(room) });
      if (Object.values(room.players).every(p => p.civId)) {
        clearTimeout(room.timer); gotoRoundStart(room);
      }
      return;
    }

    if (type === 'choose_attack' && room.phase === PHASES.ATTACK_PREP) {
      if (room.currentAttack?.attackerId !== pid) return;
      room.currentAttack.defenderId = msg.defenderId;
      room.currentAttack.factId = msg.factId;
      // FIX: нормалізуємо до Number
      room.currentAttack.fallacyId = Number(msg.fallacyId);
      clearTimeout(room.timer);
      gotoDefense(room);
      return;
    }

    if (type === 'defense_choice' && room.phase === PHASES.DEFENSE) {
      if (room.currentAttack?.defenderId !== pid || room.defenseChoice) return;
      room.defenseChoice = msg.choice;

      if (msg.choice === 'silence') {
        clearTimeout(room.timer);
        room.roundScores[pid] = (room.roundScores[pid] || 0) - 1;
        broadcast(room, { type: 'defense_result', choice: 'silence', defenderId: pid });
        setTimeout(() => advanceAttack(room), 2000);
      } else {
        // 'speak' — зберігаємо виступ захисника і переходимо до cancel
        clearTimeout(room.timer);
        const defender = room.players[pid];
        // FIX: нормалізуємо fallacyId до Number
        const fallacyId = Number(msg.fallacyId);
        const fallacy = fallacies.find(f => f.id === fallacyId) || null;
        room.speeches.push({
          playerId: pid,
          role: 'defense',
          civEmoji: defender.civEmoji || '🛡️',
          civName: defender.civName || '',
          playerName: defender.name,
          fallacyName: fallacy?.name || null,
          fallacyId,
        });
        broadcast(room, { type: 'defense_result', choice: 'speak', defenderId: pid });
        setTimeout(() => gotoCancelVote(room), 1500);
      }
      return;
    }

    if (type === 'cancel_vote' && room.phase === PHASES.CANCEL_VOTE) {
      if (pid === room.currentAttack?.defenderId) return; // захисник не голосує
      if (room.cancelVotes[pid]) return; // вже голосував
      room.cancelVotes[pid] = msg.vote; // 'cancel' | 'ok'
      broadcast(room, { type: 'cancel_vote_update', votes: Object.keys(room.cancelVotes).length,
        total: Object.keys(room.players).length - 1 });
      if (Object.keys(room.cancelVotes).length >= Object.keys(room.players).length - 1) {
        clearTimeout(room.timer); tallyCancel(room);
      }
      return;
    }

    if (type === 'submit_rating' && room.phase === PHASES.RATING) {
      if (room.ratings[pid]) return;
      room.ratings[pid] = msg.ranked; // [playerId, ...]
      broadcast(room, { type: 'rating_update', submitted: Object.keys(room.ratings).length,
        total: Object.keys(room.players).length });
      if (Object.keys(room.ratings).length >= Object.keys(room.players).length) {
        clearTimeout(room.timer); tallyRatings(room);
      }
      return;
    }

    if (type === 'capture' && room.phase === PHASES.MAP) {
      applyCapture(room, pid, msg.cellIds);
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room || ws.role !== 'player') return;
    delete room.players[ws.playerId];
    broadcast(room, { type: 'player_left', players: pubPlayers(room) });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`FallacyMania running on port ${PORT}`));