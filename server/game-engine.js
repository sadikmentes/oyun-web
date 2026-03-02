function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return null;
  }
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

class GameEngine {
  constructor(options) {
    this.maxPlayers = options.maxPlayers;
    this.gameType = "impostor";
    this.players = new Map();
    this.hostSocketId = null;
    this.round = null;
    this.roundCounter = 0;
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
      roundId: null
    });
    return { ok: true, playerName: safeName };
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  getRoomUpdatePayload() {
    return {
      gameType: this.gameType,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      roundState: this.round ? "active" : "waiting",
      phase: this.round ? "active" : "waiting",
      players: Array.from(this.players.values()).map((player) => ({
        id: player.id,
        name: player.name,
        alive: true
      }))
    };
  }

  canStartRound() {
    if (this.players.size < 2) {
      return { ok: false, reason: "Tur baslatmak icin en az 2 oyuncu gerekli." };
    }
    return { ok: true };
  }

  startRound(contentItem) {
    const players = Array.from(this.players.values());
    const impostor = pickRandom(players);
    if (!impostor) {
      throw new Error("Oyuncu bulunamadi.");
    }

    this.roundCounter += 1;
    const roundId = `round_${this.roundCounter}_${Date.now()}`;
    this.round = {
      id: roundId,
      startedAt: Date.now(),
      category: contentItem.category,
      answer: contentItem.value,
      source: contentItem.source,
      impostorPlayerId: impostor.id
    };

    for (const player of players) {
      player.role = player.id === impostor.id ? "impostor" : "player";
      player.roundId = roundId;
    }

    return this.round;
  }

  resetRound() {
    this.round = null;
    for (const player of this.players.values()) {
      player.role = null;
      player.roundId = null;
    }
  }

  getPlayerRolePayload(socketId) {
    const player = this.players.get(socketId);
    if (!player) {
      return null;
    }

    if (!this.round) {
      return {
        game: "impostor",
        role: "waiting",
        category: null
      };
    }

    if (player.roundId !== this.round.id) {
      return {
        game: "impostor",
        role: "waiting",
        category: null
      };
    }

    if (player.role === "impostor") {
      return {
        game: "impostor",
        role: "impostor",
        category: this.round.category
      };
    }

    return {
      game: "impostor",
      role: "player",
      category: this.round.category,
      clue: this.round.answer
    };
  }
}

module.exports = {
  GameEngine
};
