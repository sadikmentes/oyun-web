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
    this.defaultNightDurationSec = Number(options.nightDurationSec || 30);
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
    this.settings = {
      vampireCount: 1,
      doctorEnabled: true,
      gozcuEnabled: true,
      gozcuUses: 1,
      nightDurationSec: this.defaultNightDurationSec
    };
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
      alive: true,
      gozcuUsesLeft: 0
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

  normalizeStartOptions(options) {
    const vampireCount = Number(options && options.vampireCount ? options.vampireCount : 1);
    const doctorEnabled = options && typeof options.doctorEnabled === "boolean" ? options.doctorEnabled : true;
    const gozcuEnabled = options && typeof options.gozcuEnabled === "boolean" ? options.gozcuEnabled : true;
    const gozcuUses = Number(options && options.gozcuUses ? options.gozcuUses : 1);
    const nightDurationSec = Number(options && options.nightDurationSec ? options.nightDurationSec : this.defaultNightDurationSec);
    return {
      vampireCount,
      doctorEnabled,
      gozcuEnabled,
      gozcuUses,
      nightDurationSec
    };
  }

  canStartRound(options) {
    const normalized = this.normalizeStartOptions(options);

    if (this.players.size < 2) {
      return { ok: false, reason: "Vampir Koylu oyunu icin en az 2 oyuncu gerekli.", options: normalized };
    }
    if (normalized.vampireCount !== 1 && normalized.vampireCount !== 2) {
      return { ok: false, reason: "Vampir sayisi 1 veya 2 olmali.", options: normalized };
    }
    if (![10, 20, 30, 45, 60].includes(normalized.nightDurationSec)) {
      return { ok: false, reason: "Gece suresi 10/20/30/45/60 olmali.", options: normalized };
    }
    if (![1, 2, 3].includes(normalized.gozcuUses)) {
      return { ok: false, reason: "Gozcu hakki 1/2/3 olmali.", options: normalized };
    }

    const requiredRoles = normalized.vampireCount + (normalized.doctorEnabled ? 1 : 0) + (normalized.gozcuEnabled ? 1 : 0);
    if (requiredRoles > this.players.size) {
      return { ok: false, reason: "Secilen rol ayarlari oyuncu sayisini asiyor.", options: normalized };
    }
    if (normalized.vampireCount >= this.players.size) {
      return { ok: false, reason: "Vampir sayisi toplam oyuncudan az olmali.", options: normalized };
    }

    return { ok: true, options: normalized };
  }

  beginNight() {
    this.phase = "night";
    this.vampireVotes.clear();
    this.doctorTargetId = null;
    this.nightEndsAt = Date.now() + (this.settings.nightDurationSec * 1000);
  }

  startRound(options) {
    const normalized = this.normalizeStartOptions(options);
    this.settings = { ...normalized };

    const players = shuffle(Array.from(this.players.values()));
    for (const player of players) {
      player.alive = true;
      player.role = "koylu";
      player.gozcuUsesLeft = 0;
    }

    let index = 0;
    for (let i = 0; i < normalized.vampireCount; i += 1) {
      players[index].role = "vampir";
      index += 1;
    }

    if (normalized.doctorEnabled && players[index]) {
      players[index].role = "doktor";
      index += 1;
    }

    if (normalized.gozcuEnabled && players[index]) {
      players[index].role = "gozcu";
      players[index].gozcuUsesLeft = normalized.gozcuUses;
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
      player.gozcuUsesLeft = 0;
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

  getAliveGozcu() {
    return this.getAlivePlayers().find((p) => p.role === "gozcu") || null;
  }

  getAliveVampireTeam() {
    return this.getAliveVampires().map((player) => ({
      id: player.id,
      name: player.name
    }));
  }

  getVampireVoteState() {
    return this.getAliveVampires().map((vampire) => {
      const targetPlayerId = this.vampireVotes.get(vampire.id) || null;
      const targetPlayer = targetPlayerId ? this.players.get(targetPlayerId) || null : null;
      return {
        vampireId: vampire.id,
        vampireName: vampire.name,
        targetPlayerId,
        targetPlayerName: targetPlayer ? targetPlayer.name : null
      };
    });
  }

  hasVampireConsensus() {
    const aliveVampires = this.getAliveVampires();
    if (aliveVampires.length === 0) {
      return false;
    }
    const selectedTargets = aliveVampires.map((vampire) => this.vampireVotes.get(vampire.id) || null);
    if (selectedTargets.some((targetId) => !targetId)) {
      return false;
    }
    return new Set(selectedTargets).size === 1;
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

  submitGozcuInspect(socketId, targetId) {
    const gozcu = this.players.get(socketId);
    const target = this.players.get(targetId);
    if (!this.roundActive || this.phase !== "night") {
      return { ok: false, reason: "Su an gece asamasinda degil." };
    }
    if (!gozcu || !gozcu.alive || gozcu.role !== "gozcu") {
      return { ok: false, reason: "Bu hareket sadece hayattaki gozcu icin." };
    }
    if (gozcu.gozcuUsesLeft <= 0) {
      return { ok: false, reason: "Gozcu hakkin bitti." };
    }
    if (!target || !target.alive || target.id === gozcu.id) {
      return { ok: false, reason: "Gecerli bir hedef sec." };
    }

    gozcu.gozcuUsesLeft -= 1;
    return {
      ok: true,
      targetName: target.name,
      targetRole: target.role
    };
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

    const voteStateBeforeResolve = this.getVampireVoteState();
    const aliveVampires = this.getAliveVampires();
    let selectedTargetId = null;
    let consensusAchieved = false;

    if (aliveVampires.length === 1) {
      selectedTargetId = this.vampireVotes.get(aliveVampires[0].id) || null;
      consensusAchieved = Boolean(selectedTargetId);
    } else if (aliveVampires.length > 1 && this.hasVampireConsensus()) {
      selectedTargetId = this.vampireVotes.get(aliveVampires[0].id) || null;
      consensusAchieved = Boolean(selectedTargetId);
    }

    let killedPlayer = null;
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
      winner: this.winner,
      consensusAchieved,
      vampireVoteState: voteStateBeforeResolve
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
      settings: { ...this.settings },
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
      settings: { ...this.settings },
      players: this.getRoomUpdatePayload().players
    };

    const player = this.players.get(socketId);
    if (!player || !this.roundActive || !player.role) {
      return {
        ...base,
        role: "waiting",
        alive: true,
        gozcuUsesLeft: 0
      };
    }

    if (player.role === "vampir") {
      return {
        ...base,
        role: player.role,
        alive: player.alive,
        gozcuUsesLeft: player.gozcuUsesLeft || 0,
        vampireTeam: this.getAliveVampireTeam(),
        vampireVoteState: this.getVampireVoteState(),
        consensusAchieved: this.hasVampireConsensus()
      };
    }

    return {
      ...base,
      role: player.role,
      alive: player.alive,
      gozcuUsesLeft: player.gozcuUsesLeft || 0
    };
  }

  getVampireNightIntel(socketId) {
    const player = this.players.get(socketId);
    if (!player || !this.roundActive || player.role !== "vampir" || !player.alive) {
      return null;
    }
    return {
      phase: this.phase,
      vampireTeam: this.getAliveVampireTeam(),
      vampireVoteState: this.getVampireVoteState(),
      consensusAchieved: this.hasVampireConsensus()
    };
  }
}

module.exports = {
  VampireEngine
};
