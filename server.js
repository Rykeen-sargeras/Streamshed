// server.js
// Streamshed - YouTube Stream Schedule Sign-Up App
// Railway + GitHub friendly single-file Node/Express app.
// Admin login defaults:
// username: admin
// password: madrox79

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
const ADMIN_IP = process.env.ADMIN_IP || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

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
  await run("CREATE TABLE IF NOT EXISTS streams (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, channel_name TEXT NOT NULL, channel_url TEXT NOT NULL, title TEXT NOT NULL, scheduled_at TEXT NOT NULL, duration_minutes INTEGER DEFAULT 120, thumbnail_url TEXT DEFAULT '', youtube_video_url TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))");

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

  const requestIp = normalizeIp(req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0]);
  if (ADMIN_IP && requestIp === normalizeIp(ADMIN_IP)) {
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

async function youtubeLookup(channelUrl) {
  const parsed = extractYouTubeHandleOrId(channelUrl);
  const result = {
    channelName: "",
    channelUrl: channelUrl,
    avatarUrl: "",
    thumbnailUrl: "",
    title: "",
    videoUrl: "",
    scheduledAt: "",
    source: "none",
  };

  if (YOUTUBE_API_KEY) {
    try {
      let channelId = "";

      if (parsed.type === "channelId") channelId = parsed.value;

      if (parsed.type === "handle") {
        const url = "https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=" + encodeURIComponent(parsed.value) + "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
        const data = await fetchJson(url);
        const item = data.items && data.items[0];
        if (item) {
          channelId = item.id || "";
          result.channelName = item.snippet && item.snippet.title ? item.snippet.title : "";
          result.avatarUrl = item.snippet && item.snippet.thumbnails && item.snippet.thumbnails.default ? item.snippet.thumbnails.default.url : "";
        }
      }

      if (!channelId && parsed.value) {
        const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=" + encodeURIComponent(parsed.value) + "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
        const search = await fetchJson(url);
        const item = search.items && search.items[0];
        if (item) {
          channelId = item.snippet.channelId || "";
          result.channelName = item.snippet.channelTitle || "";
        }
      }

      if (channelId) {
        result.channelUrl = "https://www.youtube.com/channel/" + channelId;
        const upcomingUrl = "https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=" + encodeURIComponent(channelId) + "&eventType=upcoming&type=video&order=date&maxResults=1&key=" + encodeURIComponent(YOUTUBE_API_KEY);
        const upcoming = await fetchJson(upcomingUrl);
        const stream = upcoming.items && upcoming.items[0];

        if (stream) {
          const videoId = stream.id.videoId;
          result.title = stream.snippet.title || "Scheduled Stream";
          result.thumbnailUrl =
            (stream.snippet.thumbnails && stream.snippet.thumbnails.high && stream.snippet.thumbnails.high.url) ||
            (stream.snippet.thumbnails && stream.snippet.thumbnails.medium && stream.snippet.thumbnails.medium.url) ||
            "";
          result.videoUrl = "https://www.youtube.com/watch?v=" + videoId;
          result.source = "youtube_api";

          const detailsUrl = "https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=" + encodeURIComponent(videoId) + "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
          const details = await fetchJson(detailsUrl);
          const video = details.items && details.items[0];
          if (video && video.liveStreamingDetails && video.liveStreamingDetails.scheduledStartTime) {
            result.scheduledAt = video.liveStreamingDetails.scheduledStartTime;
          }
        } else {
          result.source = "youtube_api_no_upcoming_streams_found";
        }
      }
    } catch (err) {
      console.error("YouTube API lookup failed:", err.message);
      result.source = "api_failed_fallback_attempted";
    }
  }

  if (!result.thumbnailUrl) {
    try {
      const endpoint = "https://www.youtube.com/oembed?url=" + encodeURIComponent(channelUrl) + "&format=json";
      const data = await fetchJson(endpoint);
      result.channelName = result.channelName || data.author_name || "";
      result.thumbnailUrl = data.thumbnail_url || "";
      if (result.source === "none") result.source = "youtube_oembed";
    } catch (err) {
      if (result.source === "none") result.source = "embed_unavailable";
    }
  }

  return result;
}

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const nl = String.fromCharCode(10);
  res.write("event: connected" + nl + "data: " + JSON.stringify({ ok: true }) + nl + nl);
  clients.add(res);
  req.on("close", () => clients.delete(res));
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

  await run("INSERT INTO streams (user_id, channel_name, channel_url, title, scheduled_at, duration_minutes, thumbnail_url, youtube_video_url, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')", [req.user.id, channelName, channelUrl, title, scheduledAt, duration, thumbnailUrl, videoUrl]);
  broadcast();
  res.json({ ok: true });
}));

app.put("/api/streams/:id", requireAuth(async (req, res) => {
  const id = Number(req.params.id);
  const stream = await get("SELECT * FROM streams WHERE id = ?", [id]);
  if (!stream) return res.status(404).json({ error: "Stream not found." });
  if (!req.user.is_admin && stream.user_id !== req.user.id) return res.status(403).json({ error: "Not allowed." });

  const status = req.user.is_admin ? safeString(req.body.status, stream.status) : "pending";
  await run("UPDATE streams SET channel_name=?, channel_url=?, title=?, scheduled_at=?, duration_minutes=?, thumbnail_url=?, youtube_video_url=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [safeString(req.body.channelName, stream.channel_name), safeString(req.body.channelUrl, stream.channel_url), safeString(req.body.title, stream.title), safeString(req.body.scheduledAt, stream.scheduled_at), Number(req.body.durationMinutes || stream.duration_minutes), safeString(req.body.thumbnailUrl, stream.thumbnail_url), safeString(req.body.youtubeVideoUrl, stream.youtube_video_url), status, id]);

  broadcast();
  res.json({ ok: true });
}));

app.delete("/api/streams/:id", requireAdmin(async (req, res) => {
  await run("DELETE FROM streams WHERE id = ?", [Number(req.params.id)]);
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

app.post("/api/youtube/lookup", requireAdmin(async (req, res) => {
  const channelUrl = safeString(req.body.channelUrl);
  if (!channelUrl) return res.status(400).json({ error: "Channel URL required." });
  const data = await youtubeLookup(channelUrl);
  res.json(data);
}));

app.get("/", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Streamshed Schedule</title>
<style>
:root{--bg:#09090f;--card:#151522;--card2:#202033;--text:#f8f8fb;--muted:#b8b8ca;--red:#ff2d2d;--green:#2be282;--yellow:#ffd166;--blue:#69a7ff;--border:rgba(255,255,255,.12)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#23233a,#09090f 45%);color:var(--text);font-family:Arial,Helvetica,sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer;border:0;border-radius:12px;padding:10px 14px;font-weight:800;background:var(--red);color:#fff}button.secondary{background:var(--card2)}button.good{background:var(--green);color:#051009}button.warn{background:var(--yellow);color:#1d1400}button.blue{background:var(--blue);color:#06101d}input,textarea,select{width:100%;padding:12px;border-radius:12px;border:1px solid var(--border);background:#0e0e18;color:var(--text)}label{font-size:13px;color:var(--muted);font-weight:800}.wrap{max-width:1180px;margin:0 auto;padding:22px}.hero{display:flex;gap:18px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:18px}.title h1{font-size:clamp(30px,5vw,58px);margin:0;letter-spacing:-2px}.title p{color:var(--muted);margin:8px 0 0}.pill{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border);border-radius:999px;background:rgba(255,255,255,.06);color:var(--muted);font-weight:800}.dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 16px var(--green)}.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}.panel{background:rgba(21,21,34,.92);border:1px solid var(--border);border-radius:22px;padding:18px;box-shadow:0 18px 50px rgba(0,0,0,.35)}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.tab{background:var(--card2);color:var(--muted)}.tab.active{background:var(--red);color:white}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stack{display:grid;gap:12px}.stream{display:grid;grid-template-columns:140px 1fr;gap:14px;background:#10101b;border:1px solid var(--border);border-radius:18px;padding:12px;margin-bottom:12px}.thumb{width:140px;aspect-ratio:16/9;border-radius:14px;background:#27273a;object-fit:cover}.badge{display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:900;text-transform:uppercase}.live{background:var(--green);color:#061209}.upcoming{background:var(--blue);color:#06101d}.pending{background:var(--yellow);color:#211600}.rejected,.ended{background:#555;color:white}.meta{color:var(--muted);font-size:14px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.hidden{display:none!important}.mini{font-size:12px;color:var(--muted)}.notice{padding:12px;border-radius:14px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--muted)}.adminOnly{border-color:rgba(255,45,45,.35)}.countdown{margin-top:8px;font-weight:900;color:var(--yellow);font-size:15px}.countdown.liveText{color:var(--green)}.countdown.endedText{color:var(--muted)}@media(max-width:900px){.grid{grid-template-columns:1fr}.stream{grid-template-columns:1fr}.thumb{width:100%}.row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div class="title">
      <h1>Streamshed Schedule</h1>
      <p>Creators sign up, admins approve, viewers see who is live and upcoming.</p>
    </div>
    <div class="pill"><span class="dot"></span><span id="connectionStatus">Connected</span></div>
  </div>

  <div class="grid">
    <section class="panel">
      <div class="tabs">
        <button class="tab active" type="button" data-view="schedule">Schedule</button>
        <button class="tab" type="button" data-view="submit">Submit Stream</button>
        <button class="tab" type="button" data-view="profile">Profile</button>
        <button class="tab adminTab hidden" type="button" data-view="admin">Admin Approval</button>
        <button class="tab adminTab hidden" type="button" data-view="setup">Setup / YouTube Lookup</button>
      </div>

      <div id="view-schedule" class="view">
        <h2>Live Now</h2><div id="liveList"></div>
        <h2>Upcoming</h2><div id="upcomingList"></div>
        <h2>Recently Ended</h2><div id="endedList"></div>
      </div>

      <div id="view-submit" class="view hidden">
        <h2>Submit a Stream</h2>
        <div id="submitGate" class="notice">Log in or create an account first.</div>
        <form id="streamForm" class="stack hidden">
          <div class="row"><div><label>Channel Name</label><input id="sChannelName" required /></div><div><label>Channel URL</label><input id="sChannelUrl" required placeholder="https://youtube.com/@name" /></div></div>
          <div><label>Stream Title</label><input id="sTitle" required placeholder="Tonight show" /></div>
          <div class="row"><div><label>Scheduled Date/Time</label><input id="sTime" type="datetime-local" required /></div><div><label>Duration Minutes</label><input id="sDuration" type="number" value="120" min="15" /></div></div>
          <div class="row"><div><label>Thumbnail URL</label><input id="sThumb" placeholder="Optional" /></div><div><label>YouTube Video URL</label><input id="sVideo" placeholder="Optional" /></div></div>
          <button type="submit">Submit for Admin Approval</button>
          <p class="mini">New submissions stay pending until admin approves them.</p>
        </form>
      </div>

      <div id="view-profile" class="view hidden">
        <h2>Your Creator Profile</h2>
        <div id="profileGate" class="notice">Log in or create an account first.</div>
        <form id="profileForm" class="stack hidden">
          <div class="row"><div><label>Channel Name</label><input id="pChannelName" /></div><div><label>Channel URL</label><input id="pChannelUrl" /></div></div>
          <div><label>Avatar URL</label><input id="pAvatar" placeholder="Optional image URL" /></div>
          <div><label>Bio</label><textarea id="pBio" rows="4" placeholder="Tell viewers who you are."></textarea></div>
          <button type="submit">Save Profile</button>
        </form>
      </div>

      <div id="view-admin" class="view hidden"><h2>Admin Approval Queue</h2><div id="adminList"></div></div>

      <div id="view-setup" class="view hidden">
        <h2>Admin Setup / YouTube Lookup</h2>
        <div class="panel adminOnly">
          <p class="mini">Paste a channel URL. The server tries the YouTube API first if YOUTUBE_API_KEY is set.</p>
          <div class="stack">
            <label>Streamer Channel URL</label>
            <input id="lookupUrl" placeholder="https://youtube.com/@creator" />
            <button id="lookupBtn" type="button" class="blue">Auto-Lookup Scheduled Stream</button>
            <button id="addLookupBtn" type="button" class="good">Add Lookup Result as Pending Stream</button>
            <pre id="lookupResult" class="notice" style="white-space:pre-wrap"></pre>
          </div>
        </div>
      </div>
    </section>

    <aside class="panel">
      <h2>Account</h2>
      <div id="loggedOut" class="stack">
        <form id="loginForm" class="stack">
          <label>Username</label><input id="loginUser" />
          <label>Password</label><input id="loginPass" type="password" />
          <button type="submit">Log In</button>
        </form>
        <hr style="border-color:var(--border);width:100%" />
        <form id="registerForm" class="stack">
          <h3>Create Account</h3>
          <label>Username</label><input id="regUser" required />
          <label>Password</label><input id="regPass" type="password" required />
          <label>Channel Name</label><input id="regChannelName" />
          <label>Channel URL</label><input id="regChannelUrl" />
          <button type="submit" class="secondary">Create Account</button>
        </form>
      </div>
      <div id="loggedIn" class="stack hidden">
        <div class="notice">Logged in as <b id="meName"></b><br><span id="meRole"></span></div>
        <button id="logoutBtn" type="button" class="secondary">Log Out</button>
      </div>
    </aside>
  </div>
</div>

<script>
let me = null;
let streams = [];
let lastLookup = null;
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
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function defaultThumb(stream) {
  return stream.thumbnail_url || 'https://dummyimage.com/1280x720/202033/ffffff&text=YouTube+Stream';
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return days + 'd ' + hours + 'h ' + minutes + 'm ' + seconds + 's';
  if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
  if (minutes > 0) return minutes + 'm ' + seconds + 's';
  return seconds + 's';
}

function updateCountdowns() {
  document.querySelectorAll('.countdown').forEach(function (el) {
    const start = new Date(el.dataset.start).getTime();
    const durationMinutes = Number(el.dataset.duration || 120);
    const end = start + durationMinutes * 60 * 1000;
    const now = Date.now();

    el.classList.remove('liveText', 'endedText');

    if (!start || isNaN(start)) {
      el.textContent = '';
      return;
    }

    if (now < start) {
      el.textContent = 'Starts in ' + formatCountdown(start - now);
      return;
    }

    if (now >= start && now <= end) {
      el.classList.add('liveText');
      el.textContent = 'LIVE NOW • Ends in ' + formatCountdown(end - now);
      return;
    }

    el.classList.add('endedText');
    el.textContent = 'Ended ' + formatCountdown(now - end) + ' ago';
  });
}

function renderStream(stream, admin) {
  const status = stream.computed_status || stream.status;
  const link = stream.youtube_video_url || stream.channel_url || '#';
  let adminButtons = '';

  if (admin) {
    adminButtons =
      '<button class="good" type="button" onclick="approve(' + stream.id + ')">Approve</button>' +
      '<button class="warn" type="button" onclick="rejectStream(' + stream.id + ')">Reject</button>' +
      '<button class="blue" type="button" onclick="editStream(' + stream.id + ')">Edit</button>' +
      '<button class="secondary" type="button" onclick="deleteStream(' + stream.id + ')">Delete</button>';
  }

  return '' +
    '<div class="stream">' +
    '<img class="thumb" src="' + esc(defaultThumb(stream)) + '" alt="Stream thumbnail">' +
    '<div>' +
    '<span class="badge ' + esc(status) + '">' + esc(status) + '</span>' +
    '<h3>' + esc(stream.title) + '</h3>' +
    '<div class="meta"><b>' + esc(stream.channel_name) + '</b> • ' + fmtTime(stream.scheduled_at) + ' • ' + esc(stream.duration_minutes) + ' min</div>' +
    '<div class="countdown" data-start="' + esc(stream.scheduled_at) + '" data-duration="' + esc(stream.duration_minutes) + '"></div>' +
    '<div class="meta">' + esc(stream.bio || '') + '</div>' +
    '<div class="actions">' +
    '<a href="' + esc(link) + '" target="_blank"><button class="secondary" type="button">Open Stream</button></a>' +
    adminButtons +
    '</div></div></div>';
}

function render() {
  const approved = streams.filter(function (s) { return s.status === 'approved'; });
  const liveHtml = approved.filter(function (s) { return s.computed_status === 'live'; }).map(function (s) { return renderStream(s, false); }).join('');
  const upcomingHtml = approved.filter(function (s) { return s.computed_status === 'upcoming'; }).map(function (s) { return renderStream(s, false); }).join('');
  const endedHtml = approved.filter(function (s) { return s.computed_status === 'ended'; }).slice(-5).map(function (s) { return renderStream(s, false); }).join('');

  $('liveList').innerHTML = liveHtml || '<div class="notice">Nobody is marked live right now.</div>';
  $('upcomingList').innerHTML = upcomingHtml || '<div class="notice">No approved upcoming streams yet.</div>';
  $('endedList').innerHTML = endedHtml || '<div class="notice">No ended streams yet.</div>';

  updateCountdowns();

  if (me && me.is_admin) {
    const adminHtml = streams.filter(function (s) { return s.status !== 'approved'; }).map(function (s) { return renderStream(s, true); }).join('');
    $('adminList').innerHTML = adminHtml || '<div class="notice">No pending streams.</div>';
    updateCountdowns();
  }
}

async function load() {
  const meData = await api('/api/me');
  me = meData.user;

  document.querySelectorAll('.adminTab').forEach(function (x) { x.classList.toggle('hidden', !(me && me.is_admin)); });
  $('loggedOut').classList.toggle('hidden', !!me);
  $('loggedIn').classList.toggle('hidden', !me);
  $('submitGate').classList.toggle('hidden', !!me);
  $('streamForm').classList.toggle('hidden', !me);
  $('profileGate').classList.toggle('hidden', !!me);
  $('profileForm').classList.toggle('hidden', !me);

  if (me) {
    $('meName').textContent = me.username;
    $('meRole').textContent = me.is_admin ? 'Admin access active' : 'Creator account';
    $('sChannelName').value = me.channel_name || '';
    $('sChannelUrl').value = me.channel_url || '';
    $('pChannelName').value = me.channel_name || '';
    $('pChannelUrl').value = me.channel_url || '';
    $('pAvatar').value = me.avatar_url || '';
    $('pBio').value = me.bio || '';
  }

  const data = await api('/api/streams');
  streams = data.streams;
  render();
}

async function approve(id) { await api('/api/streams/' + id + '/approve', { method: 'POST' }); await load(); }
async function rejectStream(id) { await api('/api/streams/' + id + '/reject', { method: 'POST' }); await load(); }
async function deleteStream(id) { if (confirm('Delete this stream?')) { await api('/api/streams/' + id, { method: 'DELETE' }); await load(); } }
async function editStream(id) {
  const s = streams.find(function (x) { return x.id === id; });
  if (!s) return;
  const title = prompt('Stream title', s.title) || s.title;
  const scheduledAt = prompt('Scheduled time ISO format', s.scheduled_at) || s.scheduled_at;
  const status = prompt('Status: pending, approved, rejected', s.status) || s.status;
  await api('/api/streams/' + id, {
    method: 'PUT',
    body: JSON.stringify({ channelName: s.channel_name, channelUrl: s.channel_url, title: title, scheduledAt: scheduledAt, durationMinutes: s.duration_minutes, thumbnailUrl: s.thumbnail_url, youtubeVideoUrl: s.youtube_video_url, status: status })
  });
  await load();
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
      $('view-' + btn.dataset.view).classList.remove('hidden');
    });
  });
}

function bindForms() {
  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value }) });
      await load();
    } catch (err) { alert(err.message); }
  });

  $('registerForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      await api('/api/register', { method: 'POST', body: JSON.stringify({ username: $('regUser').value, password: $('regPass').value, channelName: $('regChannelName').value, channelUrl: $('regChannelUrl').value }) });
      await load();
    } catch (err) { alert(err.message); }
  });

  $('logoutBtn').addEventListener('click', async function () {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  });

  $('profileForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    await api('/api/profile', { method: 'PUT', body: JSON.stringify({ channelName: $('pChannelName').value, channelUrl: $('pChannelUrl').value, avatarUrl: $('pAvatar').value, bio: $('pBio').value }) });
    alert('Profile saved.');
    await load();
  });

  $('streamForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    await api('/api/streams', { method: 'POST', body: JSON.stringify({ channelName: $('sChannelName').value, channelUrl: $('sChannelUrl').value, title: $('sTitle').value, scheduledAt: new Date($('sTime').value).toISOString(), durationMinutes: $('sDuration').value, thumbnailUrl: $('sThumb').value, youtubeVideoUrl: $('sVideo').value }) });
    e.target.reset();
    alert('Submitted. Admin must approve it before it appears publicly.');
    await load();
  });

  $('lookupBtn').addEventListener('click', async function () {
    $('lookupResult').textContent = 'Looking up...';
    try {
      lastLookup = await api('/api/youtube/lookup', { method: 'POST', body: JSON.stringify({ channelUrl: $('lookupUrl').value }) });
      $('lookupResult').textContent = JSON.stringify(lastLookup, null, 2);
    } catch (err) { $('lookupResult').textContent = err.message; }
  });

  $('addLookupBtn').addEventListener('click', async function () {
    if (!lastLookup) return alert('Run lookup first.');
    if (!lastLookup.scheduledAt) return alert('No scheduled stream time found. You can still add it manually from Submit Stream.');
    await api('/api/streams', { method: 'POST', body: JSON.stringify({ channelName: lastLookup.channelName || 'YouTube Creator', channelUrl: lastLookup.channelUrl || $('lookupUrl').value, title: lastLookup.title || 'Scheduled Stream', scheduledAt: lastLookup.scheduledAt, durationMinutes: 120, thumbnailUrl: lastLookup.thumbnailUrl || '', youtubeVideoUrl: lastLookup.videoUrl || '' }) });
    alert('Lookup result added as pending stream. Approve it in Admin Approval.');
    await load();
  });
}

bindTabs();
bindForms();

try {
  const es = new EventSource('/api/events');
  es.addEventListener('refresh', function () { load(); });
  es.onerror = function () { $('connectionStatus').textContent = 'Polling backup active'; };
} catch (e) {}

setInterval(updateCountdowns, 1000);
setInterval(load, 30000);
load().catch(function (err) { console.error(err); });
</script>
</body>
</html>`;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Streamshed running on port " + PORT);
    });
  })
  .catch((err) => {
    console.error("Failed to start app:", err);
    process.exit(1);
  });
