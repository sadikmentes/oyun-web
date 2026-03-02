require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const http = require("http");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const { GameEngine } = require("./game-engine");
const { VampireEngine } = require("./vampire-engine");
const { ContentProvider } = require("./content-provider");

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 12);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 3000);
const NIGHT_DURATION_SEC = Number(process.env.NIGHT_DURATION_SEC || 30);
const ROOM_IDLE_TTL_MS = Number(process.env.ROOM_IDLE_TTL_MS || (1000 * 60 * 90));
const ROOM_SWEEP_INTERVAL_MS = Number(process.env.ROOM_SWEEP_INTERVAL_MS || (1000 * 60 * 5));
const CHAT_MSG_MAX_LEN = Number(process.env.CHAT_MSG_MAX_LEN || 220);
const CHAT_MSG_RATE_WINDOW_SEC = Number(process.env.CHAT_MSG_RATE_WINDOW_SEC || 3);
const CHAT_MSG_RATE_MAX = Number(process.env.CHAT_MSG_RATE_MAX || 5);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const contentProvider = new ContentProvider({
  timeoutMs: API_TIMEOUT_MS
});

const rooms = new Map();
const joinRate = new Map();
const chatRate = new Map();
const socketRoom = new Map();
const nightTimers = new Map();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function getRemoteIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return socket.handshake.address || "unknown";
}

function isJoinRateLimited(ip) {
  const current = nowSec();
  const windowSec = 10;
  const maxHits = 20;
  const bucket = joinRate.get(ip) || [];
  const recent = bucket.filter((ts) => current - ts <= windowSec);
  recent.push(current);
  joinRate.set(ip, recent);
  return recent.length > maxHits;
}

function isChatRateLimited(socketId) {
  const current = nowSec();
  const bucket = chatRate.get(socketId) || [];
  const recent = bucket.filter((ts) => current - ts <= CHAT_MSG_RATE_WINDOW_SEC);
  recent.push(current);
  chatRate.set(socketId, recent);
  return recent.length > CHAT_MSG_RATE_MAX;
}

function sanitizeChatMessage(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.slice(0, CHAT_MSG_MAX_LEN);
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateHostKey() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeGameType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "vampire") {
    return "vampire";
  }
  return "impostor";
}

function createRoom(gameType) {
  let roomCode = generateRoomCode();
  while (rooms.has(roomCode)) {
    roomCode = generateRoomCode();
  }

  const normalizedType = normalizeGameType(gameType);
  const engine = normalizedType === "vampire"
    ? new VampireEngine({ maxPlayers: MAX_PLAYERS, nightDurationSec: NIGHT_DURATION_SEC })
    : new GameEngine({ maxPlayers: MAX_PLAYERS });

  const room = {
    code: roomCode,
    gameType: normalizedType,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    hostKey: generateHostKey(),
    nightChat: {
      nightId: 0,
      general: [],
      vampire: []
    },
    engine
  };
  rooms.set(roomCode, room);
  return room;
}

function touchRoom(room) {
  if (!room) {
    return;
  }
  room.lastActivityAt = Date.now();
}

function getRoom(roomCode) {
  if (!roomCode) {
    return null;
  }
  const room = rooms.get(String(roomCode).trim().toUpperCase()) || null;
  if (room) {
    touchRoom(room);
  }
  return room;
}

function deleteRoom(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) {
    return;
  }
  clearNightTimer(normalizedCode);
  rooms.delete(normalizedCode);
}

function isValidHostKey(room, providedHostKey) {
  if (!room || !room.hostKey) {
    return false;
  }
  const expected = Buffer.from(room.hostKey);
  const provided = Buffer.from(String(providedHostKey || ""));
  if (expected.length !== provided.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, provided);
}

function getNightChat(room) {
  if (!room.nightChat) {
    room.nightChat = {
      nightId: 0,
      general: [],
      vampire: []
    };
  }
  return room.nightChat;
}

function resetNightChat(room) {
  if (!room || room.gameType !== "vampire") {
    return;
  }
  const nightChat = getNightChat(room);
  nightChat.nightId += 1;
  nightChat.general = [];
  nightChat.vampire = [];
}

function pushNightChatMessage(room, channel, entry) {
  if (!room || room.gameType !== "vampire") {
    return;
  }
  const nightChat = getNightChat(room);
  const target = channel === "vampire" ? nightChat.vampire : nightChat.general;
  target.push(entry);
  const maxEntries = 80;
  if (target.length > maxEntries) {
    target.splice(0, target.length - maxEntries);
  }
}

function buildNightChatStateForPlayer(room, playerId) {
  const player = room.engine.players.get(playerId) || null;
  const isNight = room.gameType === "vampire"
    && room.engine.roundActive
    && room.engine.phase === "night";
  const canGeneral = Boolean(player && isNight);
  const canVampire = Boolean(player && player.alive && player.role === "vampir" && isNight);
  const nightChat = getNightChat(room);

  return {
    roomCode: room.code,
    isNight,
    canGeneral,
    canVampire,
    general: canGeneral ? nightChat.general.map((entry) => ({ ...entry })) : [],
    vampire: canVampire ? nightChat.vampire.map((entry) => ({ ...entry })) : []
  };
}

function emitNightChatState(room) {
  if (!room || room.gameType !== "vampire") {
    return;
  }
  for (const playerId of room.engine.players.keys()) {
    io.to(playerId).emit("chat:state", buildNightChatStateForPlayer(room, playerId));
  }
}

function emitGeneralChatMessage(room, entry) {
  io.to(room.code).emit("chat:message", {
    channel: "general",
    entry
  });
}

function emitVampireChatMessage(room, entry) {
  for (const player of room.engine.players.values()) {
    if (player.alive && player.role === "vampir") {
      io.to(player.id).emit("chat:message", {
        channel: "vampire",
        entry
      });
    }
  }
}

function emitRoomUpdate(room) {
  io.to(room.code).emit("room:update", {
    roomCode: room.code,
    ...room.engine.getRoomUpdatePayload()
  });
}

function emitRoleAssignments(room) {
  for (const playerId of room.engine.players.keys()) {
    const payload = room.engine.getPlayerRolePayload(playerId);
    io.to(playerId).emit("round:assigned", payload);
  }
}

function emitVampireVoteState(room) {
  if (!room || room.gameType !== "vampire") {
    return;
  }
  for (const player of room.engine.players.values()) {
    const payload = room.engine.getVampireNightIntel(player.id);
    if (payload) {
      io.to(player.id).emit("vampire:vote_state", payload);
    }
  }
}

function isHostForRoom(socketId, room) {
  return room && room.engine.isHost(socketId);
}

function clearNightTimer(roomCode) {
  const timer = nightTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    nightTimers.delete(roomCode);
  }
}

function resolveNightForRoom(room, reason) {
  if (!room || room.gameType !== "vampire") {
    return;
  }
  const result = room.engine.resolveNight();
  if (!result.ok) {
    return;
  }
  touchRoom(room);
  clearNightTimer(room.code);
  io.to(room.code).emit("vampire:night_result", {
    ...result,
    reason
  });
  if (result.winner) {
    io.to(room.code).emit("vampire:game_over", {
      winner: result.winner,
      reason: "night"
    });
    room.engine.resetRound();
    resetNightChat(room);
    emitRoleAssignments(room);
    emitVampireVoteState(room);
    emitNightChatState(room);
    emitRoomUpdate(room);
    return;
  }
  emitRoleAssignments(room);
  emitVampireVoteState(room);
  emitNightChatState(room);
  emitRoomUpdate(room);
}

function scheduleNightResolution(room) {
  if (!room || room.gameType !== "vampire") {
    return;
  }
  clearNightTimer(room.code);
  const endsAt = room.engine.nightEndsAt;
  if (!endsAt) {
    return;
  }
  const delay = Math.max(0, endsAt - Date.now());
  const timer = setTimeout(() => {
    resolveNightForRoom(room, "timeout");
  }, delay);
  nightTimers.set(room.code, timer);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/host/:roomCode", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "host.html"));
});

app.get("/join/:roomCode", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "player.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/rooms", (req, res) => {
  const gameType = normalizeGameType(req.body && req.body.gameType);
  const room = createRoom(gameType);
  res.json({
    roomCode: room.code,
    gameType: room.gameType,
    maxPlayers: MAX_PLAYERS,
    hostKey: room.hostKey
  });
});

app.get("/api/rooms/:roomCode", (req, res) => {
  const room = getRoom(req.params.roomCode);
  if (!room) {
    return res.status(404).json({ message: "Oda bulunamadi." });
  }
  return res.json({
    roomCode: room.code,
    gameType: room.gameType,
    maxPlayers: MAX_PLAYERS
  });
});

app.get("/api/qr", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    if (!text) {
      return res.status(400).json({ message: "text query zorunlu." });
    }
    const dataUrl = await QRCode.toDataURL(text, {
      margin: 1,
      width: 320
    });
    return res.json({ dataUrl });
  } catch (error) {
    return res.status(500).json({ message: "QR olusturulamadi." });
  }
});

io.on("connection", (socket) => {
  socket.on("host:register", ({ roomCode, hostKey }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("round:error", { message: "Oda bulunamadi." });
      return;
    }
    if (!isValidHostKey(room, hostKey)) {
      socket.emit("round:error", { message: "Host yetkisi dogrulanamadi." });
      return;
    }
    touchRoom(room);
    room.engine.registerHost(socket.id);
    socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    socket.emit("host:registered", {
      roomCode: room.code,
      gameType: room.gameType,
      maxPlayers: MAX_PLAYERS
    });
    emitRoomUpdate(room);
  });

  socket.on("player:join", ({ roomCode, name }) => {
    const ip = getRemoteIp(socket);
    if (isJoinRateLimited(ip)) {
      socket.emit("round:error", { message: "Cok fazla deneme. Biraz sonra tekrar dene." });
      return;
    }

    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("round:error", { message: "Gecersiz oda baglantisi." });
      return;
    }

    const joined = room.engine.addPlayer(socket.id, name);
    if (!joined.ok) {
      socket.emit("round:error", { message: joined.reason });
      return;
    }

    touchRoom(room);
    socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    socket.emit("player:joined", {
      playerName: joined.playerName,
      gameType: room.gameType
    });
    emitRoomUpdate(room);

    const payload = room.engine.getPlayerRolePayload(socket.id);
    if (payload) {
      socket.emit("round:assigned", payload);
    }
    emitNightChatState(room);
  });

  socket.on("host:start_round", async ({ roomCode, options }) => {
    const room = getRoom(roomCode);
    if (!room || !isHostForRoom(socket.id, room)) {
      socket.emit("round:error", { message: "Bu islem sadece host tarafindan yapilabilir." });
      return;
    }
    touchRoom(room);

    if (room.gameType === "impostor") {
      const canStart = room.engine.canStartRound();
      if (!canStart.ok) {
        socket.emit("round:error", { message: canStart.reason });
        return;
      }

      try {
        const content = await contentProvider.getRandomContent();
        room.engine.startRound(content);
        emitRoleAssignments(room);
        emitRoomUpdate(room);
      } catch (error) {
        socket.emit("round:error", { message: `Tur baslatilamadi: ${error.message}` });
      }
      return;
    }

    const startOptions = {
      vampireCount: Number(options && options.vampireCount ? options.vampireCount : 1),
      doctorEnabled: options && typeof options.doctorEnabled === "boolean" ? options.doctorEnabled : true,
      gozcuEnabled: options && typeof options.gozcuEnabled === "boolean" ? options.gozcuEnabled : true,
      gozcuUses: Number(options && options.gozcuUses ? options.gozcuUses : 1),
      nightDurationSec: Number(options && options.nightDurationSec ? options.nightDurationSec : NIGHT_DURATION_SEC)
    };
    const canStart = room.engine.canStartRound(startOptions);
    if (!canStart.ok) {
      socket.emit("round:error", { message: canStart.reason });
      return;
    }

    room.engine.startRound(canStart.options);
    resetNightChat(room);
    scheduleNightResolution(room);
    emitRoleAssignments(room);
    emitVampireVoteState(room);
    emitNightChatState(room);
    emitRoomUpdate(room);
  });

  socket.on("host:reset_round", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !isHostForRoom(socket.id, room)) {
      socket.emit("round:error", { message: "Bu islem sadece host tarafindan yapilabilir." });
      return;
    }

    touchRoom(room);
    room.engine.resetRound();
    resetNightChat(room);
    clearNightTimer(room.code);
    emitRoleAssignments(room);
    emitVampireVoteState(room);
    emitNightChatState(room);
    emitRoomUpdate(room);
  });

  socket.on("host:resolve_night", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !isHostForRoom(socket.id, room) || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Bu islem sadece vampir hostu tarafindan yapilabilir." });
      return;
    }

    if (!room.engine.roundActive || room.engine.phase !== "night") {
      socket.emit("round:error", { message: "Gece asamasi aktif degil." });
      return;
    }
    touchRoom(room);
    resolveNightForRoom(room, "host");
  });

  socket.on("host:start_night", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !isHostForRoom(socket.id, room) || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Bu islem sadece vampir hostu tarafindan yapilabilir." });
      return;
    }

    const startNight = room.engine.startNight();
    if (!startNight.ok) {
      socket.emit("round:error", { message: startNight.reason });
      return;
    }

    touchRoom(room);
    resetNightChat(room);
    scheduleNightResolution(room);
    emitRoleAssignments(room);
    emitVampireVoteState(room);
    emitNightChatState(room);
    emitRoomUpdate(room);
  });

  socket.on("host:day_eliminate", ({ roomCode, targetPlayerId }) => {
    const room = getRoom(roomCode);
    if (!room || !isHostForRoom(socket.id, room) || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Bu islem sadece vampir hostu tarafindan yapilabilir." });
      return;
    }

    const result = room.engine.eliminateByDay(targetPlayerId);
    if (!result.ok) {
      socket.emit("round:error", { message: result.reason });
      return;
    }

    touchRoom(room);
    io.to(room.code).emit("vampire:day_result", {
      eliminatedPlayerName: result.eliminatedPlayerName
    });
    if (result.winner) {
      io.to(room.code).emit("vampire:game_over", {
        winner: result.winner,
        reason: "day"
      });
      room.engine.resetRound();
      resetNightChat(room);
      emitRoleAssignments(room);
      emitVampireVoteState(room);
      emitNightChatState(room);
      emitRoomUpdate(room);
      return;
    }
    emitRoleAssignments(room);
    emitVampireVoteState(room);
    emitNightChatState(room);
    emitRoomUpdate(room);
  });

  socket.on("vampire:vote_kill", ({ roomCode, targetPlayerId }) => {
    const room = getRoom(roomCode);
    if (!room || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Vampir odasi bulunamadi." });
      return;
    }

    const vote = room.engine.submitVampireVote(socket.id, targetPlayerId);
    if (!vote.ok) {
      socket.emit("round:error", { message: vote.reason });
      return;
    }

    touchRoom(room);
    socket.emit("action:ok", { message: "Hedef secimi kaydedildi." });
    emitVampireVoteState(room);
    if (room.engine.isNightReadyToResolve()) {
      resolveNightForRoom(room, "all_voted");
    }
  });

  socket.on("doctor:protect", ({ roomCode, targetPlayerId }) => {
    const room = getRoom(roomCode);
    if (!room || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Vampir odasi bulunamadi." });
      return;
    }

    const protect = room.engine.submitDoctorProtect(socket.id, targetPlayerId);
    if (!protect.ok) {
      socket.emit("round:error", { message: protect.reason });
      return;
    }
    touchRoom(room);
    socket.emit("action:ok", { message: "Koruma secimi kaydedildi." });
    if (room.engine.isNightReadyToResolve()) {
      resolveNightForRoom(room, "all_voted");
    }
  });

  socket.on("gozcu:inspect", ({ roomCode, targetPlayerId }) => {
    const room = getRoom(roomCode);
    if (!room || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Vampir odasi bulunamadi." });
      return;
    }

    const inspect = room.engine.submitGozcuInspect(socket.id, targetPlayerId);
    if (!inspect.ok) {
      socket.emit("round:error", { message: inspect.reason });
      return;
    }

    touchRoom(room);
    socket.emit("vampire:inspect_result", {
      targetName: inspect.targetName,
      targetRole: inspect.targetRole
    });

    const payload = room.engine.getPlayerRolePayload(socket.id);
    if (payload) {
      io.to(socket.id).emit("round:assigned", payload);
    }
    emitRoomUpdate(room);
  });

  socket.on("chat:send_general", ({ roomCode, message }) => {
    const room = getRoom(roomCode);
    if (!room || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Sohbet icin vampir odasi bulunamadi." });
      return;
    }

    const sender = room.engine.players.get(socket.id);
    if (!sender) {
      socket.emit("round:error", { message: "Sohbet izni yok." });
      return;
    }
    if (!room.engine.roundActive || room.engine.phase !== "night") {
      socket.emit("round:error", { message: "Sohbet sadece gece asamasinda acik." });
      return;
    }
    if (isChatRateLimited(socket.id)) {
      socket.emit("round:error", { message: "Cok hizli mesaj gonderiyorsun." });
      return;
    }

    const text = sanitizeChatMessage(message);
    if (!text) {
      return;
    }

    const entry = {
      senderId: sender.id,
      senderName: sender.name,
      text,
      sentAt: Date.now()
    };
    touchRoom(room);
    pushNightChatMessage(room, "general", entry);
    emitGeneralChatMessage(room, entry);
  });

  socket.on("chat:send_vampire", ({ roomCode, message }) => {
    const room = getRoom(roomCode);
    if (!room || room.gameType !== "vampire") {
      socket.emit("round:error", { message: "Sohbet icin vampir odasi bulunamadi." });
      return;
    }

    const sender = room.engine.players.get(socket.id);
    if (!sender || !sender.alive || sender.role !== "vampir") {
      socket.emit("round:error", { message: "Vampir ozel sohbetine erisim yok." });
      return;
    }
    if (!room.engine.roundActive || room.engine.phase !== "night") {
      socket.emit("round:error", { message: "Sohbet sadece gece asamasinda acik." });
      return;
    }
    if (isChatRateLimited(socket.id)) {
      socket.emit("round:error", { message: "Cok hizli mesaj gonderiyorsun." });
      return;
    }

    const text = sanitizeChatMessage(message);
    if (!text) {
      return;
    }

    const entry = {
      senderId: sender.id,
      senderName: sender.name,
      text,
      sentAt: Date.now()
    };
    touchRoom(room);
    pushNightChatMessage(room, "vampire", entry);
    emitVampireChatMessage(room, entry);
  });

  socket.on("disconnect", () => {
    chatRate.delete(socket.id);
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) {
      return;
    }

    socketRoom.delete(socket.id);
    const room = getRoom(roomCode);
    if (!room) {
      return;
    }

    room.engine.clearHost(socket.id);
    room.engine.removePlayer(socket.id);
    touchRoom(room);
    if (room.engine.players.size === 0 && !room.engine.hostSocketId) {
      deleteRoom(room.code);
      return;
    }
    emitRoleAssignments(room);
    emitVampireVoteState(room);
    emitNightChatState(room);
    emitRoomUpdate(room);
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [ip, bucket] of joinRate.entries()) {
    const recent = bucket.filter((ts) => nowSec() - ts <= 10);
    if (recent.length > 0) {
      joinRate.set(ip, recent);
    } else {
      joinRate.delete(ip);
    }
  }

  for (const [socketId, bucket] of chatRate.entries()) {
    const recent = bucket.filter((ts) => nowSec() - ts <= CHAT_MSG_RATE_WINDOW_SEC);
    if (recent.length > 0) {
      chatRate.set(socketId, recent);
    } else {
      chatRate.delete(socketId);
    }
  }

  for (const room of rooms.values()) {
    const idleMs = now - (room.lastActivityAt || room.createdAt || now);
    const hasHost = Boolean(room.engine.hostSocketId);
    const hasPlayers = room.engine.players.size > 0;
    if (!hasHost && !hasPlayers && idleMs > 60 * 1000) {
      deleteRoom(room.code);
      continue;
    }
    if (idleMs > ROOM_IDLE_TTL_MS) {
      deleteRoom(room.code);
    }
  }
}, ROOM_SWEEP_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
