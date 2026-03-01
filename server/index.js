require("dotenv").config();

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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const contentProvider = new ContentProvider({
  timeoutMs: API_TIMEOUT_MS
});

const rooms = new Map();
const joinRate = new Map();
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

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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
    engine
  };
  rooms.set(roomCode, room);
  return room;
}

function getRoom(roomCode) {
  if (!roomCode) {
    return null;
  }
  return rooms.get(String(roomCode).trim().toUpperCase()) || null;
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
    emitRoleAssignments(room);
    emitRoomUpdate(room);
    return;
  }
  emitRoleAssignments(room);
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
    maxPlayers: MAX_PLAYERS
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
  socket.on("host:register", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("round:error", { message: "Oda bulunamadi." });
      return;
    }
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
  });

  socket.on("host:start_round", async ({ roomCode, options }) => {
    const room = getRoom(roomCode);
    if (!room || !isHostForRoom(socket.id, room)) {
      socket.emit("round:error", { message: "Bu islem sadece host tarafindan yapilabilir." });
      return;
    }

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
    scheduleNightResolution(room);
    emitRoleAssignments(room);
    emitRoomUpdate(room);
  });

  socket.on("host:reset_round", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !isHostForRoom(socket.id, room)) {
      socket.emit("round:error", { message: "Bu islem sadece host tarafindan yapilabilir." });
      return;
    }

    room.engine.resetRound();
    clearNightTimer(room.code);
    emitRoleAssignments(room);
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

    scheduleNightResolution(room);
    emitRoleAssignments(room);
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

    io.to(room.code).emit("vampire:day_result", {
      eliminatedPlayerName: result.eliminatedPlayerName
    });
    if (result.winner) {
      io.to(room.code).emit("vampire:game_over", {
        winner: result.winner,
        reason: "day"
      });
      room.engine.resetRound();
      emitRoleAssignments(room);
      emitRoomUpdate(room);
      return;
    }
    emitRoleAssignments(room);
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

    socket.emit("action:ok", { message: "Hedef secimi kaydedildi." });
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

  socket.on("disconnect", () => {
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
    if (room.engine.players.size === 0) {
      clearNightTimer(room.code);
    }
    emitRoleAssignments(room);
    emitRoomUpdate(room);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
