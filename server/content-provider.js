const fs = require("fs/promises");
const path = require("path");

const FALLBACK_PATH = path.join(__dirname, "..", "data", "fallback-words.json");

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

function normalizeValue(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, " ");
}

class ContentProvider {
  constructor(options) {
    this.timeoutMs = options.timeoutMs;
    this.fallbackCache = null;
  }

  async loadFallback() {
    if (this.fallbackCache) {
      return this.fallbackCache;
    }
    const raw = await fs.readFile(FALLBACK_PATH, "utf8");
    const sanitized = raw.replace(/^\uFEFF/, "");
    const parsed = JSON.parse(sanitized);
    this.fallbackCache = {
      kelime: Array.from(new Set((parsed.kelime || []).map(normalizeValue).filter((v) => v.length > 1))),
      unlu: Array.from(new Set((parsed.unlu || []).map(normalizeValue).filter((v) => v.length > 1)))
    };
    return this.fallbackCache;
  }

  async getRandomContent() {
    const category = Math.random() < 0.5 ? "kelime" : "unlu";
    const fallback = await this.loadFallback();
    const value = pickRandom(fallback[category]);
    if (!value) {
      throw new Error(`Yerel veri bulunamadı (${category})`);
    }
    console.log(`[content] source=local category=${category} value=${value}`);
    return {
      category,
      value,
      source: "local"
    };
  }
}

module.exports = {
  ContentProvider
};
