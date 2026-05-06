// server.js
// Streamshed - YouTube Stream Schedule + Tracked YouTube Channels
// Railway + GitHub friendly single-file Node/Express app.
//
// Admin login defaults:
// username: admin
// password: madrox79
//
// Env vars:
//   SESSION_SECRET   - random string, set on Railway
//   ADMIN_USER       - default "admin"
//   ADMIN_PASS       - default "madrox79"
//   ADMIN_IPS        - comma-separated IPs for auto-login (e.g. "1.2.3.4,5.6.7.8")
//   YOUTUBE_API_KEY  - YouTube Data API v3 key (optional, falls back to oEmbed)
//   AUTO_SCAN_MINUTES - default 5
//   PORT             - Railway sets this

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-on-railway";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "madrox79";

// Multi-IP support: ADMIN_IPS=1.2.3.4,5.6.7.8 (or fall back to single ADMIN_IP)
const ADMIN_IPS = (process.env.ADMIN_IPS || process.env.ADMIN_IP || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 5);

if (!fs.existsSync("./data")) fs.mkdirSync("./data");

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new SQLiteStore({ db: "sessions.sqlite", dir: "./data" }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  })
);

const db = new sqlite3.Database("./data/schedule.sqlite");

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, channel_name TEXT DEFAULT '', channel_url TEXT DEFAULT '', bio TEXT DEFAULT '', avatar_url TEXT DEFAULT '', is_admin INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");

  await run("CREATE TABLE IF NOT EXISTS streams (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, channel_name TEXT NOT NULL, channel_url TEXT NOT NULL, title TEXT NOT NULL, scheduled_at TEXT NOT NULL, duration_minutes INTEGER DEFAULT 120, thumbnail_url TEXT DEFAULT '', youtube_video_url TEXT DEFAULT '', is_live INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))");

  await run("CREATE TABLE IF NOT EXISTS tracked_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_name TEXT DEFAULT '', channel_url TEXT UNIQUE NOT NULL, default_duration_minutes INTEGER DEFAULT 120, enabled INTEGER DEFAULT 1, last_checked_at TEXT DEFAULT '', last_result TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");

  // Add is_live column if upgrading from older schema
  try { await run("ALTER TABLE streams ADD COLUMN is_live INTEGER DEFAULT 0"); } catch (e) {}

  const admin = await get("SELECT id FROM users WHERE username = ?", [ADMIN_USER]);
  if (!admin) {
    const hash = await bcrypt.hash(ADMIN_PASS, 10);
    await run("INSERT INTO users (username, password_hash, is_admin, channel_name) VALUES (?, ?, 1, ?)", [ADMIN_USER, hash, "Admin"]);
  }
}

function safeString(value, fallback = "") {
  const out = String(value || "").trim();
  return out || fallback;
}

function normalizeIp(ip) {
  return String(ip || "").replace("::ffff:", "").trim();
}

async function currentUser(req) {
  if (req.session.userId) {
    return await get("SELECT id, username, channel_name, channel_url, bio, avatar_url, is_admin FROM users WHERE id = ?", [req.session.userId]);
  }

  // Multi-IP admin auto-login
  const requestIp = normalizeIp(req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0]);
  if (ADMIN_IPS.length && ADMIN_IPS.map(normalizeIp).includes(requestIp)) {
    const admin = await get("SELECT id, username, channel_name, channel_url, bio, avatar_url, is_admin FROM users WHERE username = ?", [ADMIN_USER]);
    if (admin) {
      req.session.userId = admin.id;
      return admin;
    }
  }

  return null;
}

function requireAuth(handler) {
  return async (req, res) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: "Login required." });
      req.user = user;
      return await handler(req, res);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Server error." });
    }
  };
}

function requireAdmin(handler) {
  return requireAuth(async (req, res) => {
    if (!req.user.is_admin) return res.status(403).json({ error: "Admin only." });
    return await handler(req, res);
  });
}

const clients = new Set();
function broadcast(type = "refresh") {
  const nl = String.fromCharCode(10);
  const payload = "event: " + type + nl + "data: " + JSON.stringify({ at: Date.now() }) + nl + nl;
  for (const res of clients) res.write(payload);
}

function streamStatus(row) {
  const start = new Date(row.scheduled_at).getTime();
  const end = start + Number(row.duration_minutes || 120) * 60 * 1000;
  const now = Date.now();
  if (row.status !== "approved") return row.status;
  // is_live flag from API takes priority
  if (row.is_live) return "live";
  if (now >= start && now <= end) return "live";
  if (now < start) return "upcoming";
  return "ended";
}

function extractYouTubeHandleOrId(url) {
  const text = safeString(url);
  const handle = text.match(/youtube\.com\/@([^/?#]+)/i);
  if (handle) return { type: "handle", value: handle[1] };

  const channel = text.match(/youtube\.com\/channel\/([^/?#]+)/i);
  if (channel) return { type: "channelId", value: channel[1] };

  const custom = text.match(/youtube\.com\/(c|user)\/([^/?#]+)/i);
  if (custom) return { type: "search", value: custom[2] };

  return { type: "search", value: text };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "streamshed-schedule-app" } });
  if (!r.ok) throw new Error("Fetch failed " + r.status);
  return await r.json();
}

// Resolve a channel URL to a channel ID + basic info
async function resolveChannelInfo(channelUrl) {
  const parsed = extractYouTubeHandleOrId(channelUrl);
  const out = { channelId: "", channelName: "", avatarUrl: "" };

  if (!YOUTUBE_API_KEY) return out;

  try {
    if (parsed.type === "channelId") {
      out.channelId = parsed.value;
      const url = "https://www.googleapis.com/youtube/v3/channels?part=snippet&id=" + encodeURIComponent(parsed.value) + "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
      const data = await fetchJson(url);
      const item = data.items && data.items[0];
      if (item && item.snippet) {
        out.channelName = item.snippet.title || "";
        out.avatarUrl = (item.snippet.thumbnails && item.snippet.thumbnails.default && item.snippet.thumbnails.default.url) || "";
      }
    } else if (parsed.type === "handle") {
      const url = "https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=" + encodeURIComponent(parsed.value) + "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
      const data = await fetchJson(url);
      const item = data.items && data.items[0];
      if (item) {
        out.channelId = item.id || "";
        out.channelName = (item.snippet && item.snippet.title) || "";
        out.avatarUrl = (item.snippet && item.snippet.thumbnails && item.snippet.thumbnails.default && item.snippet.thumbnails.default.url) || "";
      }
    }

    if (!out.channelId && parsed.value) {
      const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=" + encodeURIComponent(parsed.value) + "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
      const search = await fetchJson(url);
      const item = search.items && search.items[0];
      if (item) {
        out.channelId = item.snippet.channelId || "";
        out.channelName = item.snippet.channelTitle || "";
      }
    }
  } catch (err) {
    console.error("resolveChannelInfo err:", err.message);
  }
  return out;
}

// Pull live AND upcoming streams from a channel, returning an array
async function fetchAllStreams(channelUrl) {
  const info = await resolveChannelInfo(channelUrl);
  const results = [];

  if (YOUTUBE_API_KEY && info.channelId) {
    for (const eventType of ["live", "upcoming"]) {
      try {
        const sUrl = "https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=" + encodeURIComponent(info.channelId) + "&eventType=" + eventType + "&type=video&order=date&maxResults=5&key=" + encodeURIComponent(YOUTUBE_API_KEY);
        const search = await fetchJson(sUrl);
        const items = search.items || [];
        for (const item of items) {
          const videoId = item.id.videoId;
          // Get scheduled start time + live status
          const dUrl = "https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=" + encodeURIComponent(videoId) + "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
          const detail = await fetchJson(dUrl);
          const v = detail.items && detail.items[0];
          if (!v) continue;

          const lsd = v.liveStreamingDetails || {};
          const isLive = eventType === "live" || (lsd.actualStartTime && !lsd.actualEndTime);
          const scheduledAt = lsd.scheduledStartTime || lsd.actualStartTime || new Date().toISOString();
          const thumbs = v.snippet.thumbnails || {};
          const thumb = (thumbs.maxres && thumbs.maxres.url) || (thumbs.high && thumbs.high.url) || (thumbs.medium && thumbs.medium.url) || "";

          results.push({
            channelName: info.channelName || v.snippet.channelTitle,
            channelUrl: "https://www.youtube.com/channel/" + info.channelId,
            avatarUrl: info.avatarUrl,
            title: v.snippet.title || "Live Stream",
            thumbnailUrl: thumb,
            videoUrl: "https://www.youtube.com/watch?v=" + videoId,
            scheduledAt,
            isLive: isLive ? 1 : 0,
            source: "youtube_api",
          });
        }
      } catch (err) {
        console.error("fetchAllStreams " + eventType + " err:", err.message);
      }
    }
  }

  // Fallback: oEmbed gives at least a thumbnail and channel name
  if (results.length === 0) {
    try {
      const endpoint = "https://www.youtube.com/oembed?url=" + encodeURIComponent(channelUrl) + "&format=json";
      const data = await fetchJson(endpoint);
      results.push({
        channelName: info.channelName || data.author_name || "",
        channelUrl,
        avatarUrl: info.avatarUrl,
        title: "",
        thumbnailUrl: data.thumbnail_url || "",
        videoUrl: "",
        scheduledAt: "",
        isLive: 0,
        source: "youtube_oembed",
      });
    } catch (err) {
      results.push({
        channelName: info.channelName,
        channelUrl,
        avatarUrl: info.avatarUrl,
        title: "",
        thumbnailUrl: "",
        videoUrl: "",
        scheduledAt: "",
        isLive: 0,
        source: "embed_unavailable",
      });
    }
  }

  return { info, results };
}

// Backwards-compatible single lookup (returns first found)
async function youtubeLookup(channelUrl) {
  const { info, results } = await fetchAllStreams(channelUrl);
  const first = results.find((r) => r.scheduledAt) || results[0] || {};
  return {
    channelName: first.channelName || info.channelName || "",
    channelUrl: first.channelUrl || channelUrl,
    avatarUrl: first.avatarUrl || info.avatarUrl || "",
    thumbnailUrl: first.thumbnailUrl || "",
    title: first.title || "",
    videoUrl: first.videoUrl || "",
    scheduledAt: first.scheduledAt || "",
    isLive: first.isLive || 0,
    source: first.source || "none",
    allResults: results,
  };
}

async function saveTrackedChannel(channelUrl, channelName = "") {
  const cleanUrl = safeString(channelUrl);
  const cleanName = safeString(channelName, cleanUrl);
  if (!cleanUrl) return null;

  const existing = await get("SELECT id FROM tracked_channels WHERE channel_url = ?", [cleanUrl]);
  if (existing) {
    await run("UPDATE tracked_channels SET channel_name = ?, enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [cleanName, existing.id]);
    return existing.id;
  }

  const out = await run("INSERT INTO tracked_channels (channel_name, channel_url, enabled) VALUES (?, ?, 1)", [cleanName, cleanUrl]);
  return out.lastID;
}

async function upsertStreamFromResult(result, trackedChannel) {
  if (!result || !result.scheduledAt) return { added: false, reason: "no_scheduled_stream" };

  const channelName = safeString(result.channelName, trackedChannel.channel_name || "YouTube Creator");
  const channelUrl = safeString(result.channelUrl, trackedChannel.channel_url);
  const title = safeString(result.title, "Scheduled Stream");
  const scheduledAt = safeString(result.scheduledAt);
  const duration = Number(trackedChannel.default_duration_minutes || 120);
  const thumb = safeString(result.thumbnailUrl);
  const video = safeString(result.videoUrl);
  const isLive = result.isLive ? 1 : 0;

  let existing = null;
  if (video) existing = await get("SELECT id FROM streams WHERE youtube_video_url = ?", [video]);
  if (!existing) existing = await get("SELECT id FROM streams WHERE channel_url = ? AND scheduled_at = ?", [channelUrl, scheduledAt]);

  if (existing) {
    await run("UPDATE streams SET channel_name=?, title=?, duration_minutes=?, thumbnail_url=?, youtube_video_url=?, is_live=?, status='approved', updated_at=CURRENT_TIMESTAMP WHERE id=?", [channelName, title, duration, thumb, video, isLive, existing.id]);
    return { added: false, updated: true, id: existing.id };
  }

  const out = await run("INSERT INTO streams (user_id, channel_name, channel_url, title, scheduled_at, duration_minutes, thumbnail_url, youtube_video_url, is_live, status) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')", [channelName, channelUrl, title, scheduledAt, duration, thumb, video, isLive]);
  return { added: true, updated: false, id: out.lastID };
}

async function scanTrackedChannel(channel) {
  const { info, results } = await fetchAllStreams(channel.channel_url);
  let added = 0;
  let updated = 0;
  for (const r of results) {
    if (!r.scheduledAt) continue;
    const out = await upsertStreamFromResult(r, channel);
    if (out.added) added++;
    if (out.updated) updated++;
  }
  const resultText = "Found " + results.length + " streams (" + added + " added, " + updated + " updated)";

  await run("UPDATE tracked_channels SET channel_name = ?, channel_url = ?, last_checked_at = ?, last_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [safeString(info.channelName, channel.channel_name), safeString(channel.channel_url), new Date().toISOString(), resultText, channel.id]);

  return { channel: channel.channel_name || channel.channel_url, added, updated, total: results.length };
}

async function scanAllTrackedChannels() {
  const channels = await all("SELECT * FROM tracked_channels WHERE enabled = 1 ORDER BY channel_name ASC");
  const results = [];

  for (const channel of channels) {
    try {
      results.push(await scanTrackedChannel(channel));
    } catch (err) {
      console.error("Tracked channel scan failed:", channel.channel_url, err.message);
      await run("UPDATE tracked_channels SET last_checked_at = ?, last_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [new Date().toISOString(), "scan failed: " + err.message, channel.id]);
      results.push({ channel: channel.channel_name || channel.channel_url, error: err.message });
    }
  }

  if (results.length) broadcast();
  return results;
}

// Auto-clear is_live flag for streams whose end time has passed
async function clearStaleLiveFlags() {
  const liveStreams = await all("SELECT id, scheduled_at, duration_minutes FROM streams WHERE is_live = 1");
  const now = Date.now();
  for (const s of liveStreams) {
    const end = new Date(s.scheduled_at).getTime() + Number(s.duration_minutes || 120) * 60 * 1000;
    // Give a 10 min grace; API scan will re-set if still live
    if (now > end + 10 * 60 * 1000) {
      await run("UPDATE streams SET is_live = 0 WHERE id = ?", [s.id]);
    }
  }
}

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const nl = String.fromCharCode(10);
  res.write("event: connected" + nl + "data: " + JSON.stringify({ ok: true }) + nl + nl);
  clients.add(res);
  // Heartbeat every 25s to keep proxies happy
  const hb = setInterval(() => {
    try { res.write(": heartbeat" + nl + nl); } catch (e) {}
  }, 25000);
  req.on("close", () => {
    clearInterval(hb);
    clients.delete(res);
  });
});

app.get("/api/me", async (req, res) => {
  try {
    const user = await currentUser(req);
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/register", async (req, res) => {
  const username = safeString(req.body.username).toLowerCase();
  const password = safeString(req.body.password);
  const channelName = safeString(req.body.channelName);
  const channelUrl = safeString(req.body.channelUrl);

  if (!username || !password) return res.status(400).json({ error: "Username and password required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (!/^[a-z0-9_-]{3,30}$/.test(username)) return res.status(400).json({ error: "Username must be 3-30 chars, letters/numbers/_-" });

  try {
    const hash = await bcrypt.hash(password, 10);
    const out = await run("INSERT INTO users (username, password_hash, channel_name, channel_url) VALUES (?, ?, ?, ?)", [username, hash, channelName, channelUrl]);
    req.session.userId = out.lastID;
    broadcast();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "That username is already taken." });
  }
});

app.post("/api/login", async (req, res) => {
  const username = safeString(req.body.username).toLowerCase();
  const password = safeString(req.body.password);

  try {
    const user = await get("SELECT * FROM users WHERE username = ?", [username]);
    if (!user) return res.status(401).json({ error: "Invalid login." });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid login." });
    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.put("/api/profile", requireAuth(async (req, res) => {
  await run("UPDATE users SET channel_name = ?, channel_url = ?, bio = ?, avatar_url = ? WHERE id = ?", [safeString(req.body.channelName), safeString(req.body.channelUrl), safeString(req.body.bio), safeString(req.body.avatarUrl), req.user.id]);
  broadcast();
  res.json({ ok: true });
}));

app.post("/api/password", requireAuth(async (req, res) => {
  const current = safeString(req.body.currentPassword);
  const next = safeString(req.body.newPassword);
  if (next.length < 6) return res.status(400).json({ error: "New password must be 6+ chars." });
  const user = await get("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
  const ok = await bcrypt.compare(current, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Current password incorrect." });
  const hash = await bcrypt.hash(next, 10);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
  res.json({ ok: true });
}));

app.get("/api/streams", async (req, res) => {
  try {
    const user = await currentUser(req);
    const rows = await all("SELECT s.*, u.username, u.avatar_url, u.bio FROM streams s LEFT JOIN users u ON s.user_id = u.id ORDER BY datetime(s.scheduled_at) ASC");
    const mapped = rows
      .filter((r) => (user && user.is_admin) || r.status === "approved" || (user && r.user_id === user.id))
      .map((r) => ({ ...r, computed_status: streamStatus(r) }));
    res.json({ streams: mapped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/streams", requireAuth(async (req, res) => {
  const channelName = safeString(req.body.channelName, req.user.channel_name);
  const channelUrl = safeString(req.body.channelUrl, req.user.channel_url);
  const title = safeString(req.body.title, "Untitled Stream");
  const scheduledAt = safeString(req.body.scheduledAt);
  const duration = Number(req.body.durationMinutes || 120);
  const thumbnailUrl = safeString(req.body.thumbnailUrl);
  const videoUrl = safeString(req.body.youtubeVideoUrl);

  if (!channelName || !channelUrl || !scheduledAt) {
    return res.status(400).json({ error: "Channel name, URL, and scheduled time are required." });
  }

  // Admin submissions auto-approve; users go to pending
  const status = req.user.is_admin ? "approved" : "pending";
  await run("INSERT INTO streams (user_id, channel_name, channel_url, title, scheduled_at, duration_minutes, thumbnail_url, youtube_video_url, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [req.user.id, channelName, channelUrl, title, scheduledAt, duration, thumbnailUrl, videoUrl, status]);
  broadcast();
  res.json({ ok: true, status });
}));

app.put("/api/streams/:id", requireAuth(async (req, res) => {
  const id = Number(req.params.id);
  const stream = await get("SELECT * FROM streams WHERE id = ?", [id]);
  if (!stream) return res.status(404).json({ error: "Stream not found." });
  if (!req.user.is_admin && stream.user_id !== req.user.id) return res.status(403).json({ error: "Not allowed." });

  // If admin sets a status, use it. Otherwise, user-edited streams revert to pending
  let status = stream.status;
  if (req.user.is_admin && req.body.status) {
    status = safeString(req.body.status, stream.status);
  } else if (!req.user.is_admin) {
    // User editing their own approved stream: keep approved (don't punish them)
    status = stream.status;
  }

  await run("UPDATE streams SET channel_name=?, channel_url=?, title=?, scheduled_at=?, duration_minutes=?, thumbnail_url=?, youtube_video_url=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [safeString(req.body.channelName, stream.channel_name), safeString(req.body.channelUrl, stream.channel_url), safeString(req.body.title, stream.title), safeString(req.body.scheduledAt, stream.scheduled_at), Number(req.body.durationMinutes || stream.duration_minutes), safeString(req.body.thumbnailUrl, stream.thumbnail_url), safeString(req.body.youtubeVideoUrl, stream.youtube_video_url), status, id]);

  broadcast();
  res.json({ ok: true });
}));

app.delete("/api/streams/:id", requireAuth(async (req, res) => {
  const id = Number(req.params.id);
  const stream = await get("SELECT * FROM streams WHERE id = ?", [id]);
  if (!stream) return res.status(404).json({ error: "Stream not found." });
  if (!req.user.is_admin && stream.user_id !== req.user.id) return res.status(403).json({ error: "Not allowed." });
  await run("DELETE FROM streams WHERE id = ?", [id]);
  broadcast();
  res.json({ ok: true });
}));

app.post("/api/streams/:id/approve", requireAdmin(async (req, res) => {
  await run("UPDATE streams SET status='approved', updated_at=CURRENT_TIMESTAMP WHERE id=?", [Number(req.params.id)]);
  broadcast();
  res.json({ ok: true });
}));

app.post("/api/streams/:id/reject", requireAdmin(async (req, res) => {
  await run("UPDATE streams SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?", [Number(req.params.id)]);
  broadcast();
  res.json({ ok: true });
}));

// Lookup only — does NOT auto-save to tracked. Use /api/tracked to add explicitly.
app.post("/api/youtube/lookup", requireAdmin(async (req, res) => {
  const channelUrl = safeString(req.body.channelUrl);
  if (!channelUrl) return res.status(400).json({ error: "Channel URL required." });

  try {
    const data = await youtubeLookup(channelUrl);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.get("/api/tracked", requireAdmin(async (req, res) => {
  const channels = await all("SELECT * FROM tracked_channels ORDER BY enabled DESC, channel_name ASC");
  res.json({ channels });
}));

app.post("/api/tracked", requireAdmin(async (req, res) => {
  const channelUrl = safeString(req.body.channelUrl);
  const channelName = safeString(req.body.channelName, channelUrl);
  if (!channelUrl) return res.status(400).json({ error: "Channel URL required." });
  const id = await saveTrackedChannel(channelUrl, channelName);
  // Immediately scan to populate
  try {
    const ch = await get("SELECT * FROM tracked_channels WHERE id = ?", [id]);
    if (ch) await scanTrackedChannel(ch);
  } catch (e) {}
  broadcast();
  res.json({ ok: true, id });
}));

app.post("/api/tracked/:id/toggle", requireAdmin(async (req, res) => {
  const id = Number(req.params.id);
  const row = await get("SELECT enabled FROM tracked_channels WHERE id = ?", [id]);
  if (!row) return res.status(404).json({ error: "Tracked channel not found." });
  await run("UPDATE tracked_channels SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.enabled ? 0 : 1, id]);
  broadcast();
  res.json({ ok: true });
}));

app.delete("/api/tracked/:id", requireAdmin(async (req, res) => {
  await run("DELETE FROM tracked_channels WHERE id = ?", [Number(req.params.id)]);
  broadcast();
  res.json({ ok: true });
}));

app.post("/api/tracked/scan", requireAdmin(async (req, res) => {
  const results = await scanAllTrackedChannels();
  res.json({ ok: true, results });
}));

app.post("/api/tracked/:id/scan", requireAdmin(async (req, res) => {
  const id = Number(req.params.id);
  const ch = await get("SELECT * FROM tracked_channels WHERE id = ?", [id]);
  if (!ch) return res.status(404).json({ error: "Not found." });
  const result = await scanTrackedChannel(ch);
  broadcast();
  res.json({ ok: true, result });
}));

app.get("/", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>STREAMSHED</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{
  --bg-0:#0a0a0c;
  --bg-1:#121215;
  --bg-2:#1a1a1f;
  --bg-3:#242429;
  --metal-0:#2a2a30;
  --metal-1:#36363d;
  --metal-2:#454550;
  --text:#e8e8ec;
  --text-mute:#9a9aa3;
  --text-dim:#5a5a63;
  --red:#e10600;
  --red-bright:#ff1a1a;
  --red-glow:rgba(225,6,0,.4);
  --red-soft:rgba(225,6,0,.1);
  --green:#00d68f;
  --green-glow:rgba(0,214,143,.3);
  --amber:#ffb020;
  --amber-soft:rgba(255,176,32,.12);
  --blue:#4a9eff;
  --border:rgba(255,255,255,.08);
  --border-strong:rgba(255,255,255,.18);
  --shadow-deep:0 24px 60px rgba(0,0,0,.6);
}

*{box-sizing:border-box}
::selection{background:var(--red);color:#fff}

body{
  margin:0;
  background: var(--bg-0);
  background-image:
    radial-gradient(ellipse 80% 50% at 50% -10%, rgba(225,6,0,.08), transparent),
    radial-gradient(ellipse 60% 60% at 100% 100%, rgba(74,158,255,.04), transparent),
    linear-gradient(180deg, #0a0a0c 0%, #050507 100%);
  background-attachment: fixed;
  color:var(--text);
  font-family:'Inter',system-ui,sans-serif;
  font-size:14px;
  -webkit-font-smoothing:antialiased;
  min-height:100vh;
}

a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}

button,input,textarea,select{font:inherit;font-family:'Inter',system-ui,sans-serif}

/* ============ NAVBAR ============ */
.navbar{
  background: linear-gradient(180deg, rgba(26,26,31,.95) 0%, rgba(18,18,21,.95) 100%);
  backdrop-filter: blur(12px);
  border-bottom:1px solid var(--border);
  padding:0 24px;
  height:64px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  position:sticky;
  top:0;
  z-index:100;
  box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 8px 24px rgba(0,0,0,.4);
}

.brand{display:flex;align-items:center;gap:12px;cursor:pointer}
.brand-logo{
  width:38px;height:38px;
  background: linear-gradient(135deg, var(--red) 0%, #8b0000 100%);
  border-radius:8px;
  display:flex;align-items:center;justify-content:center;
  position:relative;
  box-shadow: 0 0 0 1px rgba(255,255,255,.1) inset, 0 4px 16px var(--red-glow);
}
.brand-logo::after{
  content:'';
  border-left:11px solid #fff;
  border-top:7px solid transparent;
  border-bottom:7px solid transparent;
  margin-left:3px;
}
.brand-text{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:3px;color:#fff}
.brand-text span{color:var(--red-bright)}

.nav-right{display:flex;align-items:center;gap:10px}
.live-indicator{
  display:flex;align-items:center;gap:8px;
  padding:6px 12px;
  background:var(--bg-2);
  border:1px solid var(--border);
  border-radius:20px;
  font-size:11px;
  color:var(--text-mute);
  font-weight:600;
  letter-spacing:.5px;
  text-transform:uppercase;
}
.live-dot{
  width:8px;height:8px;border-radius:50%;
  background:var(--text-dim);
  transition:all .3s;
}
.live-dot.connected{
  background:var(--green);
  box-shadow:0 0 0 3px rgba(0,214,143,.2), 0 0 12px var(--green-glow);
  animation:pulse 2s ease-in-out infinite;
}

@keyframes pulse{
  0%,100%{opacity:1}
  50%{opacity:.5}
}

/* ============ BUTTONS ============ */
.btn{
  display:inline-flex;align-items:center;gap:6px;
  padding:9px 16px;
  background: linear-gradient(180deg, var(--metal-1) 0%, var(--metal-0) 100%);
  border:1px solid var(--border-strong);
  border-radius:8px;
  color:var(--text);
  font-size:13px;
  font-weight:600;
  cursor:pointer;
  transition:all .15s;
  white-space:nowrap;
  box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 2px 4px rgba(0,0,0,.3);
}
.btn:hover{
  background: linear-gradient(180deg, var(--metal-2) 0%, var(--metal-1) 100%);
  border-color:rgba(255,255,255,.25);
  transform:translateY(-1px);
  box-shadow: 0 1px 0 rgba(255,255,255,.1) inset, 0 4px 12px rgba(0,0,0,.4);
}
.btn:active{transform:translateY(0)}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none}

.btn-primary{
  background: linear-gradient(180deg, var(--red-bright) 0%, var(--red) 100%);
  border-color: rgba(255,80,80,.5);
  color:#fff;
  box-shadow: 0 1px 0 rgba(255,255,255,.2) inset, 0 4px 12px var(--red-glow);
}
.btn-primary:hover{
  background: linear-gradient(180deg, #ff3333 0%, var(--red-bright) 100%);
  border-color: rgba(255,120,120,.7);
  box-shadow: 0 1px 0 rgba(255,255,255,.25) inset, 0 6px 20px var(--red-glow);
}
.btn-good{
  background: linear-gradient(180deg, #00e89c 0%, var(--green) 100%);
  border-color: rgba(0,255,160,.4);
  color:#001f12;
}
.btn-good:hover{filter:brightness(1.1)}
.btn-warn{
  background: linear-gradient(180deg, #ffc14d 0%, var(--amber) 100%);
  border-color: rgba(255,200,100,.4);
  color:#3a1f00;
}
.btn-warn:hover{filter:brightness(1.1)}
.btn-ghost{background:transparent;border-color:var(--border);box-shadow:none}
.btn-ghost:hover{background:var(--bg-2);box-shadow:none;transform:none}
.btn-sm{padding:5px 10px;font-size:12px}
.btn-icon{width:34px;height:34px;padding:0;justify-content:center}

/* ============ LAYOUT ============ */
.wrap{max-width:1280px;margin:0 auto;padding:32px 24px}

.hero-row{
  display:flex;justify-content:space-between;align-items:flex-end;
  margin-bottom:32px;
  flex-wrap:wrap;
  gap:16px;
}
.hero-title{
  font-family:'Bebas Neue',sans-serif;
  font-size:48px;
  letter-spacing:3px;
  line-height:1;
  margin:0;
  background: linear-gradient(180deg, #fff 0%, #999 100%);
  -webkit-background-clip:text;
  background-clip:text;
  color:transparent;
}
.hero-sub{color:var(--text-mute);font-size:14px;margin-top:6px}
.hero-sub a{color:var(--red-bright);cursor:pointer;font-weight:600}

/* ============ TABS ============ */
.tabs{
  display:flex;gap:2px;
  background:var(--bg-1);
  border:1px solid var(--border);
  border-radius:10px;
  padding:4px;
  margin-bottom:24px;
  overflow-x:auto;
}
.tab{
  padding:9px 18px;
  background:transparent;
  border:0;
  color:var(--text-mute);
  font-size:13px;
  font-weight:600;
  cursor:pointer;
  border-radius:7px;
  transition:all .15s;
  white-space:nowrap;
  letter-spacing:.3px;
}
.tab:hover{color:var(--text);background:rgba(255,255,255,.04)}
.tab.active{
  background: linear-gradient(180deg, var(--metal-1) 0%, var(--metal-0) 100%);
  color:#fff;
  box-shadow: 0 1px 0 rgba(255,255,255,.08) inset, 0 0 20px rgba(225,6,0,.15);
}
.tab .badge{
  display:inline-flex;align-items:center;justify-content:center;
  margin-left:6px;
  background:var(--red);
  color:#fff;
  width:18px;height:18px;
  border-radius:50%;
  font-size:10px;
  font-weight:700;
}

/* ============ PANEL / CARD ============ */
.panel{
  background: linear-gradient(180deg, var(--bg-1) 0%, var(--bg-2) 100%);
  border:1px solid var(--border);
  border-radius:14px;
  padding:24px;
  box-shadow: var(--shadow-deep), 0 1px 0 rgba(255,255,255,.04) inset;
}
.panel + .panel{margin-top:16px}

/* ============ STREAM CARD ============ */
.section-label{
  font-family:'Bebas Neue',sans-serif;
  font-size:14px;
  letter-spacing:3px;
  color:var(--text-dim);
  margin:24px 0 12px;
  display:flex;align-items:center;gap:12px;
}
.section-label::before{
  content:'';
  width:24px;height:1px;
  background:var(--red);
}
.section-label.live::before{background:var(--green)}

.stream-list{display:flex;flex-direction:column;gap:10px}

.stream{
  display:grid;
  grid-template-columns:160px 1fr auto;
  gap:18px;
  align-items:center;
  background: linear-gradient(180deg, var(--bg-1) 0%, var(--bg-2) 100%);
  border:1px solid var(--border);
  border-radius:14px;
  padding:14px;
  transition:all .2s;
  position:relative;
  overflow:hidden;
}
.stream::before{
  content:'';
  position:absolute;
  left:0;top:0;bottom:0;
  width:3px;
  background:var(--metal-1);
  transition:all .2s;
}
.stream:hover{
  border-color:var(--border-strong);
  transform:translateY(-1px);
  box-shadow:0 8px 24px rgba(0,0,0,.4);
}
.stream.live{
  border-color: rgba(0,214,143,.25);
  background: linear-gradient(135deg, rgba(0,214,143,.05) 0%, var(--bg-2) 60%);
}
.stream.live::before{background:var(--green);box-shadow:0 0 12px var(--green-glow)}
.stream.upcoming::before{background:var(--amber)}
.stream.pending{border-color:rgba(74,158,255,.2)}
.stream.pending::before{background:var(--blue)}
.stream.rejected::before{background:#666}
.stream.ended::before{background:var(--metal-2)}
.stream.ended{opacity:.65}

.thumb{
  width:160px;
  aspect-ratio:16/9;
  border-radius:8px;
  background-color:var(--bg-3);
  background-size:cover;
  background-position:center;
  border:1px solid var(--border);
  position:relative;
  overflow:hidden;
}
.thumb-overlay{
  position:absolute;
  inset:0;
  display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.4);
  opacity:0;
  transition:opacity .2s;
}
.thumb:hover .thumb-overlay{opacity:1}
.thumb-overlay::after{
  content:'';
  width:0;height:0;
  border-left:18px solid #fff;
  border-top:12px solid transparent;
  border-bottom:12px solid transparent;
  margin-left:6px;
  filter: drop-shadow(0 0 8px rgba(255,255,255,.5));
}

.stream-body{min-width:0}
.stream-channel{
  display:flex;align-items:center;gap:8px;
  font-size:13px;
  font-weight:600;
  color:var(--text-mute);
  margin-bottom:4px;
}
.stream-channel .av{
  width:20px;height:20px;
  border-radius:50%;
  background:var(--bg-3);
  background-size:cover;
  background-position:center;
}
.stream-title{
  font-size:16px;
  font-weight:700;
  color:#fff;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  margin-bottom:6px;
}
.stream-meta{
  font-size:12px;
  color:var(--text-mute);
  font-family:'JetBrains Mono',monospace;
  letter-spacing:.3px;
}
.countdown{
  display:inline-block;
  margin-top:6px;
  padding:3px 10px;
  border-radius:6px;
  background:var(--bg-3);
  border:1px solid var(--border);
  font-family:'JetBrains Mono',monospace;
  font-size:12px;
  font-weight:600;
  color:var(--amber);
}
.countdown.live-text{
  background: rgba(0,214,143,.1);
  border-color: rgba(0,214,143,.3);
  color:var(--green);
}
.countdown.ended-text{color:var(--text-dim)}

.stream-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px}

.badge{
  display:inline-flex;align-items:center;gap:5px;
  padding:4px 10px;
  border-radius:14px;
  font-size:10px;
  font-weight:800;
  letter-spacing:1.5px;
  text-transform:uppercase;
}
.badge.live{
  background: rgba(0,214,143,.15);
  color: var(--green);
  border:1px solid rgba(0,214,143,.4);
}
.badge.live::before{
  content:'';
  width:6px;height:6px;border-radius:50%;
  background:var(--green);
  box-shadow:0 0 8px var(--green-glow);
  animation:pulseDot 1.2s ease-in-out infinite;
}
@keyframes pulseDot{
  0%,100%{transform:scale(1);opacity:1}
  50%{transform:scale(1.4);opacity:.5}
}
.badge.upcoming{background:var(--amber-soft);color:var(--amber);border:1px solid rgba(255,176,32,.3)}
.badge.pending{background:rgba(74,158,255,.1);color:var(--blue);border:1px solid rgba(74,158,255,.3)}
.badge.rejected{background:rgba(255,255,255,.05);color:var(--text-mute);border:1px solid var(--border)}
.badge.ended{background:rgba(255,255,255,.04);color:var(--text-dim);border:1px solid var(--border)}

.action-row{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}

/* ============ FORMS ============ */
.form-grid{display:grid;gap:14px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-label{
  display:block;
  font-size:11px;
  font-weight:700;
  letter-spacing:1px;
  text-transform:uppercase;
  color:var(--text-mute);
  margin-bottom:6px;
}
.form-input,.form-textarea,.form-select{
  width:100%;
  padding:10px 14px;
  background:var(--bg-0);
  border:1px solid var(--border-strong);
  border-radius:8px;
  color:var(--text);
  font-size:14px;
  outline:none;
  transition: border-color .15s, box-shadow .15s;
}
.form-input:focus,.form-textarea:focus,.form-select:focus{
  border-color:var(--red);
  box-shadow:0 0 0 3px var(--red-soft);
}
.form-input::placeholder{color:var(--text-dim)}
.form-textarea{min-height:90px;resize:vertical;font-family:inherit}
.form-note{font-size:11px;color:var(--text-dim);margin-top:6px}
.form-error{
  background: rgba(225,6,0,.1);
  border: 1px solid rgba(225,6,0,.3);
  color: #ff6b6b;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
}
.form-success{
  background: rgba(0,214,143,.1);
  border: 1px solid rgba(0,214,143,.3);
  color: var(--green);
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
}

/* ============ MAIN GRID ============ */
.main-grid{display:grid;grid-template-columns:1fr 320px;gap:24px}

.sidebar{display:flex;flex-direction:column;gap:16px}
.sidebar h3{
  font-family:'Bebas Neue',sans-serif;
  font-size:18px;
  letter-spacing:2px;
  margin:0 0 12px;
  color:#fff;
}

.user-card{
  background: linear-gradient(135deg, var(--metal-0) 0%, var(--bg-1) 100%);
  border:1px solid var(--border-strong);
  border-radius:12px;
  padding:18px;
}
.user-card .avatar{
  width:56px;height:56px;
  border-radius:50%;
  background:var(--bg-3);
  background-size:cover;
  background-position:center;
  display:flex;align-items:center;justify-content:center;
  font-family:'Bebas Neue',sans-serif;
  font-size:24px;
  color:var(--text-mute);
  border:2px solid var(--border-strong);
  margin-bottom:12px;
}
.user-card .name{font-size:16px;font-weight:700;color:#fff}
.user-card .role{font-size:12px;color:var(--text-mute);margin-top:2px}
.user-card .role.admin{color:var(--red-bright);font-weight:700;letter-spacing:.5px;text-transform:uppercase}

.divider{
  height:1px;
  background:var(--border);
  margin:16px 0;
}

/* ============ EMPTY ============ */
.empty{
  text-align:center;
  padding:32px 16px;
  border:1px dashed var(--border);
  border-radius:12px;
  color:var(--text-mute);
  font-size:13px;
}
.empty-icon{font-size:32px;opacity:.4;margin-bottom:8px}

/* ============ TRACKED CHANNEL ============ */
.tracked-card{
  display:flex;align-items:center;gap:14px;
  background:var(--bg-1);
  border:1px solid var(--border);
  border-radius:10px;
  padding:12px 14px;
  margin-bottom:8px;
  transition:all .15s;
}
.tracked-card:hover{border-color:var(--border-strong)}
.tracked-card.disabled{opacity:.5}
.tracked-info{flex:1;min-width:0}
.tracked-name{font-weight:700;color:#fff;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tracked-url{font-size:11px;color:var(--text-mute);font-family:'JetBrains Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tracked-result{font-size:11px;color:var(--text-dim);margin-top:4px}

/* ============ MODAL ============ */
.modal-bg{
  position:fixed;inset:0;
  background: rgba(0,0,0,.85);
  backdrop-filter: blur(8px);
  z-index:1000;
  display:none;
  align-items:center;justify-content:center;
  padding:16px;
}
.modal-bg.show{display:flex}
.modal{
  background: linear-gradient(180deg, var(--bg-1) 0%, var(--bg-2) 100%);
  border:1px solid var(--border-strong);
  border-radius:14px;
  padding:28px;
  width:520px;max-width:100%;
  max-height:90vh;
  overflow-y:auto;
  box-shadow: var(--shadow-deep);
}
.modal-title{
  font-family:'Bebas Neue',sans-serif;
  font-size:28px;
  letter-spacing:2.5px;
  margin:0 0 6px;
}
.modal-sub{color:var(--text-mute);font-size:13px;margin-bottom:20px}

/* ============ TOAST ============ */
.toast{
  position:fixed;
  bottom:24px;right:24px;
  background: var(--bg-1);
  border:1px solid var(--border-strong);
  border-radius:10px;
  padding:12px 18px;
  font-size:13px;
  font-weight:600;
  box-shadow: var(--shadow-deep);
  z-index:9999;
  opacity:0;
  transform:translateY(12px);
  transition:all .25s;
  max-width:340px;
}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{border-color:rgba(0,214,143,.4);color:var(--green)}
.toast.error{border-color:rgba(225,6,0,.4);color:#ff6b6b}

/* ============ DROPDOWN ============ */
.dropdown{position:relative}
.user-pill{
  display:inline-flex;align-items:center;gap:8px;
  padding:5px 14px 5px 5px;
  background:var(--bg-2);
  border:1px solid var(--border-strong);
  border-radius:24px;
  cursor:pointer;
  transition:all .15s;
}
.user-pill:hover{border-color:rgba(255,255,255,.3)}
.user-pill .av{
  width:28px;height:28px;
  border-radius:50%;
  background:var(--bg-3);
  background-size:cover;
  background-position:center;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:#fff;
}
.user-pill .un{font-size:13px;font-weight:600}
.dropdown-menu{
  position:absolute;
  top:calc(100% + 8px);right:0;
  background:var(--bg-1);
  border:1px solid var(--border-strong);
  border-radius:10px;
  min-width:200px;
  padding:6px;
  box-shadow: var(--shadow-deep);
  z-index:50;
  display:none;
}
.dropdown-menu.show{display:block}
.dropdown-menu button{
  display:block;width:100%;
  padding:9px 12px;
  background:transparent;border:0;
  color:var(--text);
  font-size:13px;font-weight:500;
  text-align:left;cursor:pointer;
  border-radius:7px;
  box-shadow:none;
}
.dropdown-menu button:hover{background:var(--bg-3);transform:none}
.dropdown-menu .menu-divider{
  height:1px;background:var(--border);margin:4px 0;
}

/* ============ TOGGLE ============ */
.toggle{position:relative;display:inline-block;width:42px;height:22px}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{
  position:absolute;cursor:pointer;
  inset:0;background:var(--bg-3);
  border:1px solid var(--border);
  transition:.2s;border-radius:22px;
}
.toggle-slider::before{
  content:'';
  position:absolute;
  height:16px;width:16px;
  left:2px;bottom:2px;
  background:#fff;
  transition:.2s;
  border-radius:50%;
}
.toggle input:checked + .toggle-slider{
  background:var(--red);
  border-color:var(--red-bright);
}
.toggle input:checked + .toggle-slider::before{transform:translateX(20px)}

/* ============ ADMIN BADGE ============ */
.admin-pill{
  display:inline-flex;align-items:center;gap:5px;
  padding:4px 10px;
  background: rgba(225,6,0,.12);
  border:1px solid rgba(225,6,0,.4);
  color:var(--red-bright);
  border-radius:20px;
  font-size:11px;
  font-weight:800;
  letter-spacing:1px;
  text-transform:uppercase;
}

/* ============ HIDDEN ============ */
.hidden{display:none!important}

/* ============ RESPONSIVE ============ */
@media(max-width:900px){
  .main-grid{grid-template-columns:1fr}
  .stream{grid-template-columns:1fr;gap:12px}
  .thumb{width:100%}
  .form-row{grid-template-columns:1fr}
  .navbar{padding:0 16px}
  .wrap{padding:20px 16px}
  .hero-title{font-size:36px}
  .stream-side{align-items:flex-start;flex-direction:row;justify-content:space-between;width:100%}
}
</style>
</head>
<body>

<nav class="navbar">
  <div class="brand" onclick="setView('schedule')">
    <div class="brand-logo"></div>
    <div class="brand-text">STREAM<span>SHED</span></div>
  </div>
  <div class="nav-right">
    <span class="live-indicator">
      <span class="live-dot" id="connDot"></span>
      <span id="connText">offline</span>
    </span>
    <span id="adminPill" class="admin-pill hidden">⚡ Admin</span>
    <div id="navAuthOut">
      <button class="btn btn-ghost" onclick="openModal('login')">Log in</button>
      <button class="btn btn-primary" onclick="openModal('register')">Sign up</button>
    </div>
    <div id="navAuthIn" class="dropdown hidden">
      <div class="user-pill" onclick="toggleUserMenu(event)">
        <span class="av" id="userAv">?</span>
        <span class="un" id="userUn">user</span>
      </div>
      <div class="dropdown-menu" id="userMenu">
        <button onclick="setView('profile');closeUserMenu()">My Profile</button>
        <button onclick="setView('submit');closeUserMenu()">+ Submit Stream</button>
        <button onclick="openModal('password');closeUserMenu()">Change Password</button>
        <div class="menu-divider"></div>
        <button onclick="logout()">Log out</button>
      </div>
    </div>
  </div>
</nav>

<div class="wrap">

  <div class="hero-row">
    <div>
      <h1 class="hero-title">UPCOMING STREAMS</h1>
      <div class="hero-sub">Live now & coming up · <a onclick="requireLogin(()=>setView('submit'))">+ Add your stream</a></div>
    </div>
    <div id="heroStats" style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-dim)"></div>
  </div>

  <div class="tabs" id="mainTabs">
    <button class="tab active" data-view="schedule" onclick="setView('schedule')">📅 Schedule</button>
    <button class="tab hidden" id="tabMine" data-view="mine" onclick="setView('mine')">🎬 My Streams</button>
    <button class="tab hidden" id="tabAdmin" data-view="admin" onclick="setView('admin')">🔐 Admin <span class="badge" id="pendingBadge" style="display:none">0</span></button>
    <button class="tab hidden" id="tabSetup" data-view="setup" onclick="setView('setup')">⚙️ Setup</button>
  </div>

  <div class="main-grid">

    <div>
      <!-- SCHEDULE -->
      <div class="view" id="view-schedule">
        <div class="section-label live">🔴 Live now</div>
        <div class="stream-list" id="liveList"></div>
        <div class="section-label">⏳ Upcoming</div>
        <div class="stream-list" id="upcomingList"></div>
        <div class="section-label">✅ Recently ended</div>
        <div class="stream-list" id="endedList"></div>
      </div>

      <!-- MY STREAMS -->
      <div class="view hidden" id="view-mine">
        <div class="panel">
          <button class="btn btn-primary" onclick="setView('submit')" style="margin-bottom:16px">+ New Stream</button>
          <div class="stream-list" id="mineList"></div>
        </div>
      </div>

      <!-- SUBMIT -->
      <div class="view hidden" id="view-submit">
        <button class="btn btn-ghost" onclick="setView('schedule')" style="margin-bottom:16px">← Back</button>
        <div class="panel">
          <h2 style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:2px;margin:0 0 4px" id="submitTitle">SUBMIT A STREAM</h2>
          <p style="color:var(--text-mute);margin:0 0 20px;font-size:13px" id="submitSub">Pending until an admin approves it.</p>
          <form id="streamForm" class="form-grid">
            <div class="form-row">
              <div><label class="form-label">Channel Name *</label><input class="form-input" id="sChannelName" required></div>
              <div><label class="form-label">Channel URL *</label><input class="form-input" id="sChannelUrl" required placeholder="https://youtube.com/@you"></div>
            </div>
            <div><label class="form-label">Stream Title *</label><input class="form-input" id="sTitle" required></div>
            <div class="form-row">
              <div><label class="form-label">Date & Time *</label><input class="form-input" type="datetime-local" id="sTime" required></div>
              <div><label class="form-label">Duration (min)</label><input class="form-input" type="number" id="sDuration" value="120" min="15"></div>
            </div>
            <div class="form-row">
              <div><label class="form-label">Thumbnail URL</label><input class="form-input" id="sThumb" placeholder="Optional"></div>
              <div><label class="form-label">Stream URL</label><input class="form-input" id="sVideo" placeholder="Optional"></div>
            </div>
            <div id="sErr" class="form-error hidden"></div>
            <div style="display:flex;gap:8px">
              <button type="submit" class="btn btn-primary" style="flex:1;padding:12px">Submit</button>
              <button type="button" class="btn btn-ghost" onclick="setView('schedule')">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <!-- PROFILE -->
      <div class="view hidden" id="view-profile">
        <button class="btn btn-ghost" onclick="setView('schedule')" style="margin-bottom:16px">← Back</button>
        <div class="panel">
          <h2 style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:2px;margin:0 0 20px">YOUR PROFILE</h2>
          <form id="profileForm" class="form-grid">
            <div class="form-row">
              <div><label class="form-label">Channel Name</label><input class="form-input" id="pChannelName"></div>
              <div><label class="form-label">Channel URL</label><input class="form-input" id="pChannelUrl"></div>
            </div>
            <div><label class="form-label">Avatar URL</label><input class="form-input" id="pAvatar" placeholder="https://..."></div>
            <div><label class="form-label">Bio</label><textarea class="form-textarea" id="pBio" placeholder="Tell viewers what you stream"></textarea></div>
            <div id="pSuccess" class="form-success hidden">Profile saved.</div>
            <div><button type="submit" class="btn btn-primary">Save Profile</button></div>
          </form>
        </div>
      </div>

      <!-- ADMIN -->
      <div class="view hidden" id="view-admin">
        <div class="panel">
          <div class="section-label" style="margin-top:0">⏳ Pending approval</div>
          <div class="stream-list" id="pendingList"></div>
        </div>
        <div class="panel">
          <div class="section-label" style="margin-top:0">📋 All streams</div>
          <div class="stream-list" id="allStreamsList"></div>
        </div>
      </div>

      <!-- SETUP -->
      <div class="view hidden" id="view-setup">
        <div class="panel">
          <h3 style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;margin:0 0 6px">YOUTUBE LOOKUP</h3>
          <p style="color:var(--text-mute);margin:0 0 16px;font-size:13px">
            Paste any YouTube channel URL to peek at their next scheduled stream. To track it permanently and auto-import streams, use the section below.
          </p>
          <div class="form-row">
            <div style="grid-column:1/-1"><label class="form-label">Channel URL</label><input class="form-input" id="lookupUrl" placeholder="https://youtube.com/@creator"></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
            <button class="btn" onclick="doLookup()" id="lookupBtn">🔍 Preview</button>
            <button class="btn btn-good" onclick="addLookupAsPending()" id="addLookupBtn" disabled>+ Add as Pending Stream</button>
          </div>
          <pre id="lookupResult" style="margin-top:14px;background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:14px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-mute);white-space:pre-wrap;max-height:300px;overflow:auto"></pre>
        </div>

        <div class="panel">
          <h3 style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;margin:0 0 6px">TRACKED CHANNELS</h3>
          <p style="color:var(--text-mute);margin:0 0 16px;font-size:13px">
            These channels are auto-scanned every few minutes. New live + upcoming streams are imported automatically with thumbnails.
          </p>
          <div class="form-row">
            <div><label class="form-label">Channel Name</label><input class="form-input" id="trackedName" placeholder="Optional"></div>
            <div><label class="form-label">Channel URL</label><input class="form-input" id="trackedUrl" placeholder="https://youtube.com/@creator"></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-good" onclick="addTracked()">+ Add Channel</button>
            <button class="btn" onclick="scanAll()" id="scanBtn">▶ Scan all now</button>
          </div>
          <div style="margin-top:18px" id="trackedList"></div>
        </div>

        <div class="panel">
          <h3 style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;margin:0 0 6px">CONFIG</h3>
          <p style="color:var(--text-mute);margin:0;font-size:13px">
            Defaults: <code>admin / madrox79</code>. Configure server-side via Railway env vars:<br>
            <code style="font-family:'JetBrains Mono',monospace;font-size:11px">ADMIN_IPS</code> · comma-separated IPs for auto-login<br>
            <code style="font-family:'JetBrains Mono',monospace;font-size:11px">YOUTUBE_API_KEY</code> · for accurate detection<br>
            <code style="font-family:'JetBrains Mono',monospace;font-size:11px">AUTO_SCAN_MINUTES</code> · scan interval (default 5)
          </p>
        </div>
      </div>
    </div>

    <!-- SIDEBAR -->
    <aside class="sidebar">
      <div id="sidebarLoggedOut" class="panel">
        <h3>JOIN STREAMSHED</h3>
        <p style="color:var(--text-mute);font-size:13px;margin:0 0 16px">Create an account to add your YouTube streams to the schedule.</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" onclick="openModal('register')">Sign up</button>
          <button class="btn btn-ghost" onclick="openModal('login')">Log in</button>
        </div>
      </div>

      <div id="sidebarLoggedIn" class="user-card hidden">
        <div class="avatar" id="sbAvatar">?</div>
        <div class="name" id="sbName">user</div>
        <div class="role" id="sbRole">Creator</div>
        <div class="divider"></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" onclick="setView('submit')">+ Submit Stream</button>
          <button class="btn btn-ghost" onclick="setView('profile')">Edit Profile</button>
        </div>
      </div>
    </aside>

  </div>
</div>

<!-- LOGIN MODAL -->
<div class="modal-bg" id="modalLogin">
  <div class="modal">
    <div class="modal-title">LOG IN</div>
    <div class="modal-sub">Sign in to manage your streams.</div>
    <form id="loginForm" class="form-grid">
      <div><label class="form-label">Username</label><input class="form-input" id="loginUser" autocomplete="username"></div>
      <div><label class="form-label">Password</label><input type="password" class="form-input" id="loginPass" autocomplete="current-password"></div>
      <div id="loginErr" class="form-error hidden"></div>
      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-primary" style="flex:1;padding:12px">Log in</button>
        <button type="button" class="btn btn-ghost" onclick="closeModal('login')">Cancel</button>
      </div>
    </form>
    <div style="text-align:center;font-size:13px;color:var(--text-mute);margin-top:14px">
      No account? <a onclick="closeModal('login');openModal('register')">Sign up</a>
    </div>
  </div>
</div>

<!-- REGISTER MODAL -->
<div class="modal-bg" id="modalRegister">
  <div class="modal">
    <div class="modal-title">CREATE ACCOUNT</div>
    <div class="modal-sub">Set up a profile to post streams faster.</div>
    <form id="registerForm" class="form-grid">
      <div class="form-row">
        <div><label class="form-label">Username *</label><input class="form-input" id="regUser" required></div>
        <div><label class="form-label">Password *</label><input type="password" class="form-input" id="regPass" required></div>
      </div>
      <div class="form-row">
        <div><label class="form-label">Channel Name</label><input class="form-input" id="regChannelName"></div>
        <div><label class="form-label">Channel URL</label><input class="form-input" id="regChannelUrl" placeholder="https://youtube.com/@you"></div>
      </div>
      <div id="regErr" class="form-error hidden"></div>
      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-primary" style="flex:1;padding:12px">Create Account</button>
        <button type="button" class="btn btn-ghost" onclick="closeModal('register')">Cancel</button>
      </div>
    </form>
    <div style="text-align:center;font-size:13px;color:var(--text-mute);margin-top:14px">
      Already have one? <a onclick="closeModal('register');openModal('login')">Log in</a>
    </div>
  </div>
</div>

<!-- EDIT MODAL -->
<div class="modal-bg" id="modalEdit">
  <div class="modal">
    <div class="modal-title">EDIT STREAM</div>
    <div class="modal-sub">Update stream details.</div>
    <form id="editForm" class="form-grid">
      <input type="hidden" id="eId">
      <div class="form-row">
        <div><label class="form-label">Channel Name</label><input class="form-input" id="eChannelName"></div>
        <div><label class="form-label">Channel URL</label><input class="form-input" id="eChannelUrl"></div>
      </div>
      <div><label class="form-label">Stream Title</label><input class="form-input" id="eTitle"></div>
      <div class="form-row">
        <div><label class="form-label">Date & Time</label><input type="datetime-local" class="form-input" id="eTime"></div>
        <div><label class="form-label">Duration (min)</label><input type="number" class="form-input" id="eDuration" min="15"></div>
      </div>
      <div class="form-row">
        <div><label class="form-label">Thumbnail URL</label><input class="form-input" id="eThumb"></div>
        <div><label class="form-label">Stream URL</label><input class="form-input" id="eVideo"></div>
      </div>
      <div id="eAdminFields" class="hidden">
        <label class="form-label">Status (admin)</label>
        <select class="form-select" id="eStatus">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <div id="eErr" class="form-error hidden"></div>
      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-primary" style="flex:1;padding:12px">Save</button>
        <button type="button" class="btn btn-ghost" onclick="closeModal('edit')">Cancel</button>
      </div>
    </form>
  </div>
</div>

<!-- PASSWORD MODAL -->
<div class="modal-bg" id="modalPassword">
  <div class="modal">
    <div class="modal-title">CHANGE PASSWORD</div>
    <form id="passwordForm" class="form-grid">
      <div><label class="form-label">Current Password</label><input type="password" class="form-input" id="pwCur"></div>
      <div><label class="form-label">New Password</label><input type="password" class="form-input" id="pwNew"></div>
      <div id="pwErr" class="form-error hidden"></div>
      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-primary" style="flex:1;padding:12px">Update</button>
        <button type="button" class="btn btn-ghost" onclick="closeModal('password')">Cancel</button>
      </div>
    </form>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let me = null;
let streams = [];
let trackedChannels = [];
let lastLookup = null;
let currentView = 'schedule';

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

async function api(path, options) {
  options = options || {};
  options.credentials = 'include';
  options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const response = await fetch(path, options);
  const data = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '';
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function defaultThumb(stream) {
  if (stream.thumbnail_url) return stream.thumbnail_url;
  // YouTube auto-thumb from video URL
  const m = String(stream.youtube_video_url || '').match(/[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/);
  if (m) return 'https://i.ytimg.com/vi/' + (m[1] || m[2]) + '/hqdefault.jpg';
  return '';
}

function initials(s) {
  return String(s || '?').split(/\s+/).map(w => w[0]).join('').substring(0,2).toUpperCase();
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return days + 'd ' + hours + 'h ' + minutes + 'm';
  if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
  if (minutes > 0) return minutes + 'm ' + seconds + 's';
  return seconds + 's';
}

function updateCountdowns() {
  document.querySelectorAll('.countdown').forEach(function (el) {
    const start = new Date(el.dataset.start).getTime();
    const dur = Number(el.dataset.duration || 120);
    const end = start + dur * 60 * 1000;
    const now = Date.now();
    const isLive = el.dataset.live === '1';
    el.classList.remove('live-text', 'ended-text');
    if (!start || isNaN(start)) { el.textContent = ''; return; }
    if (isLive || (now >= start && now <= end)) {
      el.classList.add('live-text');
      el.textContent = '● LIVE NOW';
      return;
    }
    if (now < start) { el.textContent = '⏱ Starts in ' + fmtCountdown(start - now); return; }
    el.classList.add('ended-text');
    el.textContent = 'Ended ' + fmtCountdown(now - end) + ' ago';
  });
}

function renderStream(stream) {
  const status = stream.computed_status || stream.status;
  const link = stream.youtube_video_url || stream.channel_url || '#';
  const thumb = defaultThumb(stream);
  const isAdmin = !!(me && me.is_admin);
  const isMine = !!(me && stream.user_id === me.id);
  const canEdit = isAdmin || isMine;

  let actions = '';
  if (status === 'live' || status === 'upcoming') {
    actions += '<a href="' + esc(link) + '" target="_blank" rel="noopener"><button class="btn btn-primary btn-sm">▶ ' + (status === 'live' ? 'Watch' : 'Open') + '</button></a>';
  }
  if (isAdmin && status === 'pending') {
    actions += '<button class="btn btn-good btn-sm" onclick="approve(' + stream.id + ')">✓ Approve</button>';
    actions += '<button class="btn btn-warn btn-sm" onclick="rejectStream(' + stream.id + ')">✕ Reject</button>';
  }
  if (canEdit) {
    actions += '<button class="btn btn-sm" onclick="editStream(' + stream.id + ')">Edit</button>';
    actions += '<button class="btn btn-ghost btn-sm" onclick="deleteStream(' + stream.id + ')">Delete</button>';
  }

  const av = stream.avatar_url ? '<span class="av" style="background-image:url(' + esc(stream.avatar_url) + ')"></span>' : '';
  const submitter = stream.username ? '<span style="color:var(--text-dim);margin-left:6px">· @' + esc(stream.username) + '</span>' : '';

  const thumbHtml = thumb
    ? '<a href="' + esc(link) + '" target="_blank" rel="noopener" class="thumb" style="background-image:url(' + esc(thumb) + ')"><span class="thumb-overlay"></span></a>'
    : '<div class="thumb" style="display:flex;align-items:center;justify-content:center;font-family:Bebas Neue;font-size:32px;color:var(--text-dim)">' + esc(initials(stream.channel_name)) + '</div>';

  return '' +
    '<div class="stream ' + esc(status) + '">' +
    thumbHtml +
    '<div class="stream-body">' +
      '<div class="stream-channel">' + av + esc(stream.channel_name) + submitter + '</div>' +
      '<div class="stream-title">' + esc(stream.title) + '</div>' +
      '<div class="stream-meta">' + esc(fmtTime(stream.scheduled_at)) + ' · ' + esc(stream.duration_minutes || 120) + ' min</div>' +
      '<div class="countdown" data-start="' + esc(stream.scheduled_at) + '" data-duration="' + esc(stream.duration_minutes || 120) + '" data-live="' + (status === 'live' ? '1' : '0') + '"></div>' +
    '</div>' +
    '<div class="stream-side">' +
      '<span class="badge ' + esc(status) + '">' + esc(status) + '</span>' +
      '<div class="action-row">' + actions + '</div>' +
    '</div>' +
    '</div>';
}

function emptyHtml(msg, icon) {
  return '<div class="empty"><div class="empty-icon">' + (icon || '📭') + '</div>' + msg + '</div>';
}

function renderTracked() {
  if (!(me && me.is_admin)) return;
  const html = trackedChannels.map(function (c) {
    return '' +
      '<div class="tracked-card ' + (c.enabled ? '' : 'disabled') + '">' +
        '<div class="tracked-info">' +
          '<div class="tracked-name">' + esc(c.channel_name || c.channel_url) + '</div>' +
          '<div class="tracked-url">' + esc(c.channel_url) + '</div>' +
          '<div class="tracked-result">' + (c.enabled ? '✓ Enabled' : '○ Disabled') + ' · last: ' + esc(c.last_checked_at ? fmtTime(c.last_checked_at) : 'never') + '</div>' +
          (c.last_result ? '<div class="tracked-result">' + esc(c.last_result) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-sm" onclick="scanOne(' + c.id + ')">▶ Scan</button>' +
        '<button class="btn btn-sm" onclick="toggleTracked(' + c.id + ')">' + (c.enabled ? 'Disable' : 'Enable') + '</button>' +
        '<button class="btn btn-warn btn-sm" onclick="deleteTracked(' + c.id + ')">✕</button>' +
      '</div>';
  }).join('');
  $('trackedList').innerHTML = html || emptyHtml('No tracked channels yet. Add one above.', '📡');
}

function render() {
  const approved = streams.filter(s => s.status === 'approved');
  const liveS = approved.filter(s => s.computed_status === 'live');
  const upcomingS = approved.filter(s => s.computed_status === 'upcoming');
  const endedS = approved.filter(s => s.computed_status === 'ended').slice(-6).reverse();

  $('liveList').innerHTML = liveS.length ? liveS.map(renderStream).join('') : emptyHtml('Nobody is live right now.', '⏸');
  $('upcomingList').innerHTML = upcomingS.length ? upcomingS.map(renderStream).join('') : emptyHtml('No upcoming streams scheduled.', '📅');
  $('endedList').innerHTML = endedS.length ? endedS.map(renderStream).join('') : emptyHtml('No recent streams.', '✓');

  // My streams
  if (me) {
    const mine = streams.filter(s => s.user_id === me.id);
    $('mineList').innerHTML = mine.length ? mine.map(renderStream).join('') : emptyHtml('You haven\\'t submitted any streams.', '🎬');
  }

  // Admin
  if (me && me.is_admin) {
    const pending = streams.filter(s => s.status !== 'approved');
    $('pendingList').innerHTML = pending.length ? pending.map(renderStream).join('') : emptyHtml('No pending streams.', '✨');
    $('allStreamsList').innerHTML = streams.length ? streams.map(renderStream).join('') : emptyHtml('No streams yet.', '📋');
    const pb = $('pendingBadge');
    if (pending.length > 0) { pb.style.display = 'inline-flex'; pb.textContent = pending.length; }
    else pb.style.display = 'none';
    renderTracked();
  }

  // Hero stats
  $('heroStats').innerHTML = '<span style="color:var(--green)">● ' + liveS.length + ' live</span> · <span style="color:var(--amber)">' + upcomingS.length + ' upcoming</span>';

  updateCountdowns();
}

async function load() {
  try {
    const meData = await api('/api/me');
    me = meData.user;

    document.querySelectorAll('#mainTabs .tab').forEach(t => {
      const v = t.dataset.view;
      if (v === 'mine') t.classList.toggle('hidden', !me);
      if (v === 'admin' || v === 'setup') t.classList.toggle('hidden', !(me && me.is_admin));
    });

    $('navAuthOut').classList.toggle('hidden', !!me);
    $('navAuthIn').classList.toggle('hidden', !me);
    $('sidebarLoggedOut').classList.toggle('hidden', !!me);
    $('sidebarLoggedIn').classList.toggle('hidden', !me);
    $('adminPill').classList.toggle('hidden', !(me && me.is_admin));

    if (me) {
      $('userUn').textContent = me.username;
      $('userAv').textContent = initials(me.username);
      $('sbName').textContent = me.username;
      $('sbRole').textContent = me.is_admin ? 'Admin Access' : 'Creator';
      $('sbRole').classList.toggle('admin', !!me.is_admin);
      $('sbAvatar').textContent = initials(me.username);
      if (me.avatar_url) {
        $('userAv').style.backgroundImage = 'url(' + me.avatar_url + ')';
        $('userAv').textContent = '';
        $('sbAvatar').style.backgroundImage = 'url(' + me.avatar_url + ')';
        $('sbAvatar').textContent = '';
      }
      $('sChannelName').value = me.channel_name || '';
      $('sChannelUrl').value = me.channel_url || '';
      $('pChannelName').value = me.channel_name || '';
      $('pChannelUrl').value = me.channel_url || '';
      $('pAvatar').value = me.avatar_url || '';
      $('pBio').value = me.bio || '';
    }

    const data = await api('/api/streams');
    streams = data.streams;

    if (me && me.is_admin) {
      const trackedData = await api('/api/tracked');
      trackedChannels = trackedData.channels;
    } else {
      trackedChannels = [];
    }

    render();
  } catch (e) { console.error(e); }
}

function setView(view) {
  if (view === 'submit' && !me) { openModal('login'); return; }
  if (view === 'profile' && !me) { openModal('login'); return; }
  if (view === 'mine' && !me) { openModal('login'); return; }
  if ((view === 'admin' || view === 'setup') && !(me && me.is_admin)) { openModal('login'); return; }

  currentView = view;
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  $('view-' + view).classList.remove('hidden');
  document.querySelectorAll('#mainTabs .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });

  if (view === 'submit' && me) {
    $('submitTitle').textContent = me.is_admin ? 'ADD A STREAM' : 'SUBMIT A STREAM';
    $('submitSub').textContent = me.is_admin ? 'As admin, your streams are auto-approved.' : 'Pending until an admin approves it.';
  }
}

function requireLogin(fn) { if (!me) openModal('login'); else fn(); }

function openModal(name) {
  $('modal' + name.charAt(0).toUpperCase() + name.slice(1)).classList.add('show');
  ['loginErr','regErr','sErr','eErr','pwErr'].forEach(id => { const el = $(id); if (el) el.classList.add('hidden'); });
}
function closeModal(name) {
  $('modal' + name.charAt(0).toUpperCase() + name.slice(1)).classList.remove('show');
}

function toggleUserMenu(e) { e.stopPropagation(); $('userMenu').classList.toggle('show'); }
function closeUserMenu() { $('userMenu').classList.remove('show'); }
document.addEventListener('click', closeUserMenu);

async function logout() {
  await api('/api/logout', { method: 'POST' });
  me = null;
  setView('schedule');
  load();
  closeUserMenu();
}

async function approve(id) { try { await api('/api/streams/' + id + '/approve', { method: 'POST' }); toast('Approved', 'success'); load(); } catch(e) { toast(e.message, 'error'); } }
async function rejectStream(id) { try { await api('/api/streams/' + id + '/reject', { method: 'POST' }); toast('Rejected', ''); load(); } catch(e) { toast(e.message, 'error'); } }
async function deleteStream(id) { if (!confirm('Delete this stream?')) return; try { await api('/api/streams/' + id, { method: 'DELETE' }); toast('Deleted', ''); load(); } catch(e) { toast(e.message, 'error'); } }
async function toggleTracked(id) { try { await api('/api/tracked/' + id + '/toggle', { method: 'POST' }); load(); } catch(e) { toast(e.message, 'error'); } }
async function deleteTracked(id) { if (!confirm('Stop tracking this channel?')) return; try { await api('/api/tracked/' + id, { method: 'DELETE' }); load(); } catch(e) { toast(e.message, 'error'); } }
async function scanOne(id) {
  toast('Scanning...', '');
  try {
    const r = await api('/api/tracked/' + id + '/scan', { method: 'POST' });
    toast('Found ' + r.result.total + ' streams', 'success');
    load();
  } catch (e) { toast(e.message, 'error'); }
}

function editStream(id) {
  const s = streams.find(x => x.id === id);
  if (!s) return;
  $('eId').value = s.id;
  $('eChannelName').value = s.channel_name || '';
  $('eChannelUrl').value = s.channel_url || '';
  $('eTitle').value = s.title || '';
  // datetime-local needs YYYY-MM-DDTHH:mm
  try {
    const d = new Date(s.scheduled_at);
    const pad = n => String(n).padStart(2, '0');
    $('eTime').value = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch (e) { $('eTime').value = ''; }
  $('eDuration').value = s.duration_minutes || 120;
  $('eThumb').value = s.thumbnail_url || '';
  $('eVideo').value = s.youtube_video_url || '';
  $('eStatus').value = s.status || 'pending';
  $('eAdminFields').classList.toggle('hidden', !(me && me.is_admin));
  openModal('edit');
}

// ============ FORMS ============
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value }) });
    closeModal('login');
    toast('Welcome back', 'success');
    load();
  } catch (err) { $('loginErr').textContent = err.message; $('loginErr').classList.remove('hidden'); }
});

$('registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify({ username: $('regUser').value, password: $('regPass').value, channelName: $('regChannelName').value, channelUrl: $('regChannelUrl').value }) });
    closeModal('register');
    toast('Account created!', 'success');
    load();
  } catch (err) { $('regErr').textContent = err.message; $('regErr').classList.remove('hidden'); }
});

$('profileForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/profile', { method: 'PUT', body: JSON.stringify({ channelName: $('pChannelName').value, channelUrl: $('pChannelUrl').value, avatarUrl: $('pAvatar').value, bio: $('pBio').value }) });
    $('pSuccess').classList.remove('hidden');
    setTimeout(() => $('pSuccess').classList.add('hidden'), 2500);
    load();
  } catch (err) { toast(err.message, 'error'); }
});

$('streamForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const time = $('sTime').value;
    if (!time) throw new Error('Date & time required');
    const r = await api('/api/streams', { method: 'POST', body: JSON.stringify({ channelName: $('sChannelName').value, channelUrl: $('sChannelUrl').value, title: $('sTitle').value, scheduledAt: new Date(time).toISOString(), durationMinutes: $('sDuration').value, thumbnailUrl: $('sThumb').value, youtubeVideoUrl: $('sVideo').value }) });
    e.target.reset();
    $('sChannelName').value = me.channel_name || '';
    $('sChannelUrl').value = me.channel_url || '';
    $('sDuration').value = 120;
    toast(r.status === 'approved' ? 'Stream added' : 'Submitted! Awaiting admin approval', 'success');
    setView('schedule');
    load();
  } catch (err) { $('sErr').textContent = err.message; $('sErr').classList.remove('hidden'); }
});

$('editForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const id = $('eId').value;
    const body = {
      channelName: $('eChannelName').value,
      channelUrl: $('eChannelUrl').value,
      title: $('eTitle').value,
      scheduledAt: new Date($('eTime').value).toISOString(),
      durationMinutes: $('eDuration').value,
      thumbnailUrl: $('eThumb').value,
      youtubeVideoUrl: $('eVideo').value,
    };
    if (me && me.is_admin) body.status = $('eStatus').value;
    await api('/api/streams/' + id, { method: 'PUT', body: JSON.stringify(body) });
    closeModal('edit');
    toast('Saved', 'success');
    load();
  } catch (err) { $('eErr').textContent = err.message; $('eErr').classList.remove('hidden'); }
});

$('passwordForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('pwCur').value, newPassword: $('pwNew').value }) });
    closeModal('password');
    $('pwCur').value = ''; $('pwNew').value = '';
    toast('Password updated', 'success');
  } catch (err) { $('pwErr').textContent = err.message; $('pwErr').classList.remove('hidden'); }
});

// ============ SETUP TAB ============
async function doLookup() {
  const url = $('lookupUrl').value.trim();
  if (!url) return toast('Paste a channel URL first', 'error');
  $('lookupBtn').disabled = true; $('lookupBtn').textContent = '⌛ Looking up...';
  try {
    lastLookup = await api('/api/youtube/lookup', { method: 'POST', body: JSON.stringify({ channelUrl: url }) });
    $('lookupResult').textContent = JSON.stringify(lastLookup, null, 2);
    $('addLookupBtn').disabled = !lastLookup.scheduledAt;
    if (!lastLookup.scheduledAt) toast('No scheduled stream found', '');
    else toast('Found scheduled stream', 'success');
  } catch (err) {
    $('lookupResult').textContent = 'Error: ' + err.message;
    toast(err.message, 'error');
  }
  $('lookupBtn').disabled = false; $('lookupBtn').textContent = '🔍 Preview';
}

async function addLookupAsPending() {
  if (!lastLookup || !lastLookup.scheduledAt) return toast('No scheduled stream to add', 'error');
  try {
    await api('/api/streams', { method: 'POST', body: JSON.stringify({
      channelName: lastLookup.channelName || 'YouTube Creator',
      channelUrl: lastLookup.channelUrl,
      title: lastLookup.title || 'Scheduled Stream',
      scheduledAt: lastLookup.scheduledAt,
      durationMinutes: 120,
      thumbnailUrl: lastLookup.thumbnailUrl || '',
      youtubeVideoUrl: lastLookup.videoUrl || ''
    }) });
    toast('Added (auto-approved as admin)', 'success');
    load();
  } catch (err) { toast(err.message, 'error'); }
}

async function addTracked() {
  const url = $('trackedUrl').value.trim();
  if (!url) return toast('Channel URL required', 'error');
  try {
    await api('/api/tracked', { method: 'POST', body: JSON.stringify({ channelName: $('trackedName').value, channelUrl: url }) });
    $('trackedName').value = ''; $('trackedUrl').value = '';
    toast('Added & scanned', 'success');
    load();
  } catch (err) { toast(err.message, 'error'); }
}

async function scanAll() {
  $('scanBtn').disabled = true; $('scanBtn').textContent = '⌛ Scanning...';
  try {
    const r = await api('/api/tracked/scan', { method: 'POST' });
    toast('Scanned ' + r.results.length + ' channels', 'success');
    load();
  } catch (err) { toast(err.message, 'error'); }
  $('scanBtn').disabled = false; $('scanBtn').textContent = '▶ Scan all now';
}

// ============ TOAST ============
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = 'toast', 3500);
}

// ============ SSE ============
function connectSSE() {
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('connected', () => {
      $('connDot').classList.add('connected');
      $('connText').textContent = 'live';
    });
    es.addEventListener('refresh', () => load());
    es.onerror = () => {
      $('connDot').classList.remove('connected');
      $('connText').textContent = 'reconnecting';
    };
  } catch (e) {}
}

// ============ INIT ============
connectSSE();
setInterval(updateCountdowns, 1000);
setInterval(load, 60000);
load();
</script>
</body>
</html>`;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Streamshed running on port " + PORT);
      console.log("Admin: " + ADMIN_USER + " / " + ADMIN_PASS);
      if (ADMIN_IPS.length) console.log("Admin IPs: " + ADMIN_IPS.join(", "));
      if (YOUTUBE_API_KEY) console.log("YouTube API: configured");
      else console.log("YouTube API: NOT configured (using oEmbed fallback)");
    });

    const scanMs = Math.max(1, AUTO_SCAN_MINUTES) * 60 * 1000;
    setInterval(() => {
      scanAllTrackedChannels().catch((err) => console.error("Auto scan failed:", err.message));
      clearStaleLiveFlags().catch((err) => console.error("Clear stale live failed:", err.message));
    }, scanMs);

    setTimeout(() => {
      scanAllTrackedChannels().catch((err) => console.error("Initial auto scan failed:", err.message));
    }, 10000);
  })
  .catch((err) => {
    console.error("Failed to start app:", err);
    process.exit(1);
  });
