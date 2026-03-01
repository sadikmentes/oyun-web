function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return null;
  }
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class VampireEngine {
  constructor(options) {
    this.maxPlayers = options.maxPlayers;
    this.nightDurationSec = Number(options.nightDurationSec || 30);
    this.gameType = "vampire";
    this.players = new Map();
    this.hostSocketId = null;
    this.roundActive = false;
    this.phase = "waiting";
    this.roundCounter = 0;
    this.vampireVotes = new Map();
    this.doctorTargetId = null;
    this.nightEndsAt = null;
    this.winner = null;
  }

  registerHost(socketId) {
    this.hostSocketId = socketId;
  }

  isHost(socketId) {
    return this.hostSocketId === socketId;
  }

  clearHost(socketId) {
    if (this.hostSocketId === socketId) {
      this.hostSocketId = null;
    }
  }

  sanitizeName(name) {
    const clean = String(name || "").trim().replace(/\s+/g, " ");
    if (!clean) {
      return `Oyuncu-${this.players.size + 1}`;
    }
    return clean.slice(0, 24);
  }

  ensureUniqueName(name) {
    const existing = new Set(Array.from(this.players.values()).map((p) => p.name.toLowerCase()));
    if (!existing.has(name.toLowerCase())) {
      return name;
    }

    let suffix = 2;
    let candidate = `${name} ${suffix}`;
    while (existing.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${name} ${suffix}`;
    }
    return candidate;
  }

  addPlayer(socketId, name) {
    if (this.players.size >= this.maxPlayers) {
      return { ok: false, reason: "Oda dolu." };
    }
    if (this.players.has(socketId)) {
      return { ok: true };
    }

    const safeName = this.ensureUniqueName(this.sanitizeName(name));
    this.players.set(socketId, {
      id: socketId,
      name: safeName,
      connectedAt: Date.now(),
      role: null,
      alive: true
    });
    return { ok: true, playerName: safeName };
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.vampireVotes.delete(socketId);
    if (this.doctorTargetId === socketId) {
      this.doctorTargetId = null;
    }
    this.updateWinnerState();
  }

  canStartRound(vampireCount) {
    if (this.players.size < 2) {
      return { ok: false, reason: "Vampir Koylu oyunu icin en az 2 oyuncu gerekli." };
    }
    if (vampireCount !== 1 && vampireCount !== 2) {
      return { ok: false, reason: "Vampir sayisi 1 veya 2 olmali." };
    }
    if (vampireCount >= this.players.size) {
      return { ok: false, reason: "Vampir sayisi toplam oyuncudan az olmali." };
    }
    return { ok: true };
  }

  beginNight() {
    this.phase = "night";
    this.vampireVotes.clear();
    this.doctorTargetId = null;
    this.nightEndsAt = Date.now() + (this.nightDurationSec * 1000);
  }

  startRound(vampireCount) {
    const players = shuffle(Array.from(this.players.values()));
    for (const player of players) {
      player.alive = true;
      player.role = "koylu";
    }

    let index = 0;
    for (let i = 0; i < vampireCount; i += 1) {
      players[index].role = "vampir";
      index += 1;
    }

    if (players.length >= 3 && players[index]) {
      players[index].role = "doktor";
      index += 1;
    }

    if (players.length >= 5 && players[index]) {
      players[index].role = "gozlemci";
    }

    this.roundActive = true;
    this.roundCounter += 1;
    this.winner = null;
    this.beginNight();
  }

  resetRound() {
    this.roundActive = false;
    this.phase = "waiting";
    this.vampireVotes.clear();
    this.doctorTargetId = null;
    this.nightEndsAt = null;
    this.winner = null;
    for (const player of this.players.values()) {
      player.role = null;
      player.alive = true;
    }
  }

  getAlivePlayers() {
    return Array.from(this.players.values()).filter((p) => p.alive);
  }

  getAliveVampires() {
    return this.getAlivePlayers().filter((p) => p.role === "vampir");
  }

  getAliveVillagers() {
    return this.getAlivePlayers().filter((p) => p.role !== "vampir");
  }

  getAliveDoctor() {
    return this.getAlivePlayers().find((p) => p.role === "doktor") || null;
  }

  getSummary() {
    const alive = this.getAlivePlayers();
    return {
      aliveTotal: alive.length,
      aliveVampires: alive.filter((p) => p.role === "vampir").length,
      aliveVillagers: alive.filter((p) => p.role !== "vampir").length
    };
  }

  updateWinnerState() {
    if (!this.roundActive) {
      return null;
    }
    const aliveVampires = this.getAliveVampires().length;
    const aliveVillagers = this.getAliveVillagers().length;

    if (aliveVampires === 0) {
      this.winner = "koylu";
      this.roundActive = false;
      this.phase = "game_over";
      this.nightEndsAt = null;
      return this.winner;
    }

    // Vampir tarafi oyunu, iyi tarafla esitlendiginde veya iyi taraf tamamen bittiginde kazanir.
    if (aliveVillagers === 0 || aliveVampires === aliveVillagers) {
      this.winner = "vampir";
      this.roundActive = false;
      this.phase = "game_over";
      this.nightEndsAt = null;
      return this.winner;
    }

    return null;
  }

  submitVampireVote(socketId, targetId) {
    const voter = this.players.get(socketId);
    const target = this.players.get(targetId);
    if (!this.roundActive || this.phase !== "night") {
      return { ok: false, reason: "Su an gece asamasinda degil." };
    }
    if (!voter || !voter.alive || voter.role !== "vampir") {
      return { ok: false, reason: "Bu hareket sadece hayattaki vampirler icin." };
    }
    if (!target || !target.alive || target.id === voter.id) {
      return { ok: false, reason: "Gecerli bir hedef sec." };
    }

    this.vampireVotes.set(voter.id, target.id);
    return { ok: true };
  }

  submitDoctorProtect(socketId, targetId) {
    const doctor = this.players.get(socketId);
    const target = this.players.get(targetId);
    if (!this.roundActive || this.phase !== "night") {
      return { ok: false, reason: "Su an gece asamasinda degil." };
    }
    if (!doctor || !doctor.alive || doctor.role !== "doktor") {
      return { ok: false, reason: "Bu hareket sadece hayattaki doktor icin." };
    }
    if (!target || !target.alive) {
      return { ok: false, reason: "Gecerli bir hedef sec." };
    }

    this.doctorTargetId = target.id;
    return { ok: true };
  }

  isNightReadyToResolve() {
    if (!this.roundActive || this.phase !== "night") {
      return false;
    }

    const aliveVampires = this.getAliveVampires();
    const vampiresReady = aliveVampires.length > 0 && aliveVampires.every((v) => this.vampireVotes.has(v.id));
    if (!vampiresReady) {
      return false;
    }

    const aliveDoctor = this.getAliveDoctor();
    if (!aliveDoctor) {
      return true;
    }

    return Boolean(this.doctorTargetId);
  }

  resolveNight() {
    if (!this.roundActive || this.phase !== "night") {
      return { ok: false, reason: "Gece asamasi aktif degil." };
    }

    const counts = new Map();
    for (const targetId of this.vampireVotes.values()) {
      counts.set(targetId, (counts.get(targetId) || 0) + 1);
    }

    let topScore = 0;
    let candidates = [];
    for (const [targetId, score] of counts.entries()) {
      if (score > topScore) {
        topScore = score;
        candidates = [targetId];
      } else if (score === topScore) {
        candidates.push(targetId);
      }
    }

    let killedPlayer = null;
    const selectedTargetId = candidates.length ? pickRandom(candidates) : null;
    if (selectedTargetId && selectedTargetId !== this.doctorTargetId) {
      killedPlayer = this.players.get(selectedTargetId) || null;
      if (killedPlayer) {
        killedPlayer.alive = false;
      }
    }

    const protectedPlayer = this.doctorTargetId ? this.players.get(this.doctorTargetId) || null : null;

    this.phase = "day";
    this.vampireVotes.clear();
    this.doctorTargetId = null;
    this.nightEndsAt = null;
    this.updateWinnerState();

    return {
      ok: true,
      killedPlayerName: killedPlayer ? killedPlayer.name : null,
      protectedPlayerName: protectedPlayer ? protectedPlayer.name : null,
      winner: this.winner
    };
  }

  eliminateByDay(targetId) {
    if (!this.roundActive || this.phase !== "day") {
      return { ok: false, reason: "Gunduz elemesi sadece day fazinda yapilir." };
    }
    const target = this.players.get(targetId);
    if (!target || !target.alive) {
      return { ok: false, reason: "Gecerli bir hedef sec." };
    }
    target.alive = false;
    this.updateWinnerState();
    return { ok: true, eliminatedPlayerName: target.name, winner: this.winner };
  }

  startNight() {
    if (!this.roundActive) {
      return { ok: false, reason: "Aktif tur yok." };
    }
    if (this.phase !== "day") {
      return { ok: false, reason: "Yeni gece sadece day fazindan baslatilabilir." };
    }
    this.beginNight();
    return { ok: true };
  }

  getRoomUpdatePayload() {
    return {
      gameType: this.gameType,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      roundState: this.roundActive ? "active" : "waiting",
      phase: this.phase,
      nightEndsAt: this.nightEndsAt,
      winner: this.winner,
      summary: this.getSummary(),
      players: Array.from(this.players.values()).map((player) => ({
        id: player.id,
        name: player.name,
        alive: player.alive
      }))
    };
  }

  getPlayerRolePayload(socketId) {
    const base = {
      game: "vampire",
      phase: this.phase,
      nightEndsAt: this.nightEndsAt,
      winner: this.winner,
      summary: this.getSummary(),
      players: this.getRoomUpdatePayload().players
    };

    const player = this.players.get(socketId);
    if (!player || !this.roundActive || !player.role) {
      return {
        ...base,
        role: "waiting",
        alive: true
      };
    }

    return {
      ...base,
      role: player.role,
      alive: player.alive
    };
  }
}

module.exports = {
  VampireEngine
};
