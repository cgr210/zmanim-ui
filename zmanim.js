/* Zmanim relay page.
   Loaded by the Shelly script's starter page, which defines: CORE (script id), SW (switch id), NM (device name), PEERS (fallback list).
   All devices are shown on one page; tap a device for its details. */

// ------------------------------------------------------------------ helpers
var DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var DL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var SD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
var FL = ["Every time", "Shabbos only", "Yom Tov only", "First night only"];
function $(i) { return document.getElementById(i); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function p2(x) { return (x < 10 ? "0" : "") + x; }
// Local time: the device's time zone (Europe/London etc.), so times either side of a clock change are right.
// Falls back to the device's current UTC offset if the browser can't do time zones.
var TZ = null, TZF = {}, OFFC = {};
function tzOff(t, tz) {                        // seconds east of UTC in time zone tz at unix time t
  var k = tz + Math.floor(t / 900); if (k in OFFC) return OFFC[k];
  if (!TZF[tz]) TZF[tz] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  var p = {}; TZF[tz].formatToParts(new Date(t * 1000)).forEach(function (x) { p[x.type] = +x.value; });
  return (OFFC[k] = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) / 1000 - t);
}
function offAt(t) { if (!TZ) return null; try { return tzOff(t, TZ); } catch (e) { TZ = null; return null; } }
function setTZ(z) { if (!z) return; try { tzOff(0, z); TZ = z; } catch (e) { } }
function O(t, off) { var o = offAt(t); return o === null ? (off || 0) : o; }
function wall(w, off) { var t = w - O(w, off); return w - O(t, off); }   // local wall-clock seconds -> unix
function local(t, off) { return new Date((t + O(t, off)) * 1000); }   // read with getUTC* = local time
function hm(t, off) { var d = local(t, off); return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()); }
function dmy(t, off) { var d = local(t, off); return DN[d.getUTCDay()] + " " + p2(d.getUTCDate()) + "/" + p2(d.getUTCMonth() + 1); }
function dayLabel(t, ref, off) {                                     // "Today", "Tomorrow", "Friday", "Fri 23/10"
  var a = Math.floor((t + O(t, off)) / 86400), b = Math.floor((ref + O(ref, off)) / 86400), d = local(t, off);
  if (a === b) return "Today";
  if (a === b + 1) return "Tomorrow";
  if (a - b < 7) return DL[d.getUTCDay()];
  return DN[d.getUTCDay()] + " " + d.getUTCDate() + "/" + (d.getUTCMonth() + 1);
}
function lc(s) { return s === "Today" || s === "Tomorrow" ? s.toLowerCase() : s; }   // "on Friday", "today"
function until(t, ref) {
  var m = Math.round((t - ref) / 60);
  if (m < 60) return "in " + m + " min";
  var h = Math.round(m / 60);
  if (h < 36) return "in " + h + " hours";
  return "in " + Math.round(h / 24) + " days";
}

// ------------------------------------------------------------------ talking to Shellys
// This device: its own RPC. Other devices: relayed through this Shelly's built-in HTTP.Request.
function rpcLocal(method, params) {
  return fetch("/rpc", { method: "POST", body: JSON.stringify({ id: 1, method: method, params: params || {} }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j.error) throw new Error(j.error.message || "RPC error"); return j.result; });
}
function rpcAt(base, method, params) {
  if (!base) return rpcLocal(method, params);
  return rpcLocal("HTTP.Request", { method: "POST", url: base + "/rpc", timeout: 10,
      body: JSON.stringify({ id: 1, method: method, params: params || {} }) })
    .then(function (r) {
      if (!r || r.code !== 200) throw new Error("HTTP " + (r && r.code));
      var j = JSON.parse(r.body);
      if (j.error) throw new Error(j.error.message || "RPC error");
      return j.result;
    });
}
function evalAt(base, id, code) {
  return rpcAt(base, "Script.Eval", { id: id, code: code }).then(function (r) { return r && r.result !== undefined ? r.result : r; });
}
function core(d, q) {
  return evalAt(d.base, d.core, "webCmd(" + JSON.stringify(q || "") + ")")
    .then(function (v) { return typeof v === "string" ? JSON.parse(v) : v; });
}

// ------------------------------------------------------------------ devices
// d = { base, ip, mac, core, sw, name, dname, err, sum (status from the script), sj (schedules), sk (skip list), rj (zman schedules) }
var DEVS = [{ base: "", core: CORE, sw: SW, name: window.NM || "This device", sj: [], sk: [] }];
var SEL = null, PEERS_DIRTY = false;

function parsePeer(s) { var p = String(s).split("#"); return { ip: p[0], mac: (p[1] || "").toLowerCase() }; }
function savePeers() {
  var v = DEVS.filter(function (d) { return d.base; }).map(function (d) { return d.ip + (d.mac ? "#" + d.mac : ""); });
  return rpcLocal("KVS.Set", { key: "zmanim_peers", value: JSON.stringify(v) });
}
// check it is the expected device, then find its zmanim script (the running script that defines webCmd)
function connect(d) {
  return rpcAt(d.base, "Shelly.GetDeviceInfo").then(function (i) {
    var mac = String(i.mac || "").toLowerCase();
    if (d.mac && mac && mac !== d.mac) { var e = new Error("A different device is now at " + d.ip); e.moved = true; throw e; }
    if (mac && !d.mac) { d.mac = mac; PEERS_DIRTY = true; }
    d.dname = i.name || ""; d.name = i.name || i.id || d.ip; cards();
  }, function (e) { e.moved = true; throw e; })
    .then(function () { return rpcAt(d.base, "Script.List"); })
    .then(function (r) {
      var run = (r.scripts || []).filter(function (x) { return x.running; }), found = null;
      return run.reduce(function (p, x) {
        return p.then(function () {
          if (found !== null) return;
          return evalAt(d.base, x.id, "typeof webCmd").then(function (t) { if (t === "function") found = x.id; }).catch(function () {});
        });
      }, Promise.resolve()).then(function () { return found; });
    })
    .then(function (id) {
      if (id === null) throw new Error("The zmanim script isn't running on this device");
      d.core = id;
      return evalAt(d.base, id, "CFG.switchId").then(function (sw) { d.sw = +sw || 0; });
    });
}
// scan this network (x.x.x.1-254) for a device's MAC, 4 at a time, nearest to its old address first
function myIp() {
  return rpcLocal("Wifi.GetStatus").then(function (s) { if (s && s.sta_ip) return s.sta_ip; throw 0; })
    .catch(function () { return rpcLocal("Eth.GetStatus").then(function (s) { if (s && s.ip) return s.ip; throw 0; }); })
    .catch(function () { return /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : null; });
}
function scan(d) {
  return myIp().then(function (me) {
    if (!me) return null;
    var pre = me.split(".").slice(0, 3).join("."), mine = +me.split(".")[3], old = +String(d.ip).split(".")[3] || mine, list = [];
    for (var n = 1; n < 255; n++) if (n !== mine) list.push(n);
    list.sort(function (a, b) { return Math.abs(a - old) - Math.abs(b - old); });
    var next = 0, done = 0, found = null;
    function worker() {
      if (found || next >= list.length) return Promise.resolve();
      var ip = pre + "." + list[next++];
      return rpcLocal("HTTP.Request", { method: "POST", url: "http://" + ip + "/rpc", timeout: 2,
          body: JSON.stringify({ id: 1, method: "Shelly.GetDeviceInfo" }) })
        .then(function (r) { var j = JSON.parse(r.body); if (j.result && String(j.result.mac).toLowerCase() === d.mac) found = ip; })
        .catch(function () {})
        .then(function () { done++; d.err = "Looking for this device on the network (" + done + " of " + list.length + ")"; cards(); return worker(); });
    }
    return Promise.all([worker(), worker(), worker(), worker()]).then(function () { return found; });
  });
}
function addPeer(entry) {
  var e = parsePeer(entry), d = { base: "http://" + e.ip, ip: e.ip, mac: e.mac, name: e.ip, sj: [], sk: [], err: "Connecting" };
  DEVS.push(d); cards();
  return connect(d).catch(function (err) {
    if (!err.moved || !d.mac) throw err;
    d.err = "Looking for this device on the network"; cards();
    return scan(d).then(function (ip) {
      if (!ip) throw new Error("Not found on this network");
      d.ip = ip; d.base = "http://" + ip; PEERS_DIRTY = true;
      return connect(d);
    });
  })
    .then(function () { d.err = null; return refreshDev(d, true); })
    .catch(function (x) { d.err = x.message || "Not reachable"; d.dead = true; cards(); });
}
function loadPeers(ips) {
  return ips.reduce(function (p, ip) { return p.then(function () { return addPeer(ip); }); }, Promise.resolve())
    .then(function () { if (PEERS_DIRTY) { PEERS_DIRTY = false; DE = null; return savePeers().catch(function () {}); } });
}

// ------------------------------------------------------------------ data per device
function parseSpec(ts) {                       // "0 30 7 * * MON,WED" -> {t:"07:30", d:[1,3]}
  var p = String(ts).trim().split(/\s+/);
  if (p.length !== 6 || p[0] !== "0" || p[3] !== "*" || p[4] !== "*") return null;
  if (!/^\d+$/.test(p[1]) || !/^\d+$/.test(p[2]) || +p[1] > 59 || +p[2] > 23) return null;
  var d = [];
  if (p[5] === "*") d = [0, 1, 2, 3, 4, 5, 6];
  else {
    var items = p[5].split(",");
    for (var i = 0; i < items.length; i++) {
      var r = items[i].split("-");
      if (r.length === 2) {
        var a = dayIdx(r[0]), b = dayIdx(r[1]); if (a < 0 || b < 0) return null;
        for (var k = a, g = 0; g < 7; g++) { d.push(k); if (k === b) break; k = (k + 1) % 7; }
      } else { var k2 = dayIdx(items[i]); if (k2 < 0) return null; d.push(k2); }
    }
    d = [0, 1, 2, 3, 4, 5, 6].filter(function (x) { return d.indexOf(x) >= 0; });
  }
  return { t: p2(+p[2]) + ":" + p2(+p[1]), d: d };
}
function dayIdx(s) { var i = SD.indexOf(String(s).toUpperCase()); if (i >= 0) return i; var n = parseInt(s, 10); return n >= 0 && n <= 7 && String(n) === s ? n % 7 : -1; }
function jobAction(j) {
  if (!j.calls || j.calls.length !== 1) return null;
  var c = j.calls[0];
  if (!c.method || c.method.toLowerCase() !== "switch.set" || !c.params) return null;
  return c.params.on === true ? true : (c.params.on === false ? false : null);
}
function loadSchedules(d) {                    // one request at a time: the main Shelly relays requests for the others
  return rpcAt(d.base, "Schedule.List").then(function (r) {
    d.sj = (r.jobs || []).map(function (j) {
      var ps = parseSpec(j.timespec || ""), a = jobAction(j), m = j.calls && j.calls[0] && j.calls[0].method;
      return { id: j.id, en: !!j.enable, t: ps && ps.t, d: ps && ps.d, a: a, ts: j.timespec, fx: !!(ps && a !== null), m: m };
    });
  })
    .then(function () { return rpcAt(d.base, "KVS.Get", { key: "zmanim_skip" }).then(function (r) { d.sk = JSON.parse(r.value); }).catch(function () { d.sk = []; }); })
    .then(function () { return rpcAt(d.base, "KVS.Get", { key: "zmanim_rules" }).then(function (r) { d.rj = JSON.parse(r.value); }).catch(function () { d.rj = []; }); });
}
function refreshDev(d, withSchedules) {
  if (d.core === undefined) return Promise.resolve();
  var p = withSchedules ? loadSchedules(d).catch(function () {}) : Promise.resolve();
  return p.then(function () { return core(d, ""); })
    .then(function (s) { d.sum = s; d.err = null; render(d); })
    .catch(function (e) { d.err = "Not reachable just now (" + e.message + ")"; cards(); });
}
// upcoming events for a device: zmanim events from the script + its fixed-time schedules, next 7 days
function upcoming(d) {
  var s = d.sum; if (!s || s.ts === undefined) return [];
  var list = s.next.map(function (e) { return { t: e[3], on: e[1], why: e[2], kind: e[4] }; }), end = s.ts + 7 * 86400;
  var win = [], st = s.holy ? s.ts : null, paused = s.paused || [];
  s.next.forEach(function (e) { if (e[4] === 1 && st === null) st = e[3]; else if (e[4] === 2 && st !== null) { win.push([st, e[3]]); st = null; } });
  if (st !== null) win.push([st, Infinity]);
  (d.sj || []).forEach(function (j) {
    if (!j.t || j.a === null || !(j.en || paused.indexOf(j.id) >= 0)) return;
    var sec = +j.t.slice(0, 2) * 3600 + +j.t.slice(3) * 60, day0 = Math.floor((s.ts + O(s.ts, s.off)) / 86400);
    for (var k = 0; k <= 7; k++) {
      var day = day0 + k; if (j.d.indexOf((day + 4) % 7) < 0) continue;
      var t = wall(day * 86400 + sec, s.off); if (t <= s.ts || t > end) continue;
      var skip = (d.sk || []).indexOf(j.id) >= 0 && win.some(function (w) { return t >= w[0] && t < w[1]; });
      list.push({ t: t, on: j.a, why: skip ? "Schedule, skipped for Shabbos/Yom Tov" : "Schedule", kind: 0, skip: skip });
    }
  });
  // hide a zman's information line when a zman schedule already switches near it
  list = list.filter(function (e) {
    if (e.on !== null || !e.kind) return true;
    var name = String(e.why).split(" - ")[0];
    return !list.some(function (x) { return x.kind === 0 && x.on !== null && String(x.why).indexOf(name) === 0 && Math.abs(x.t - e.t) <= 10800; });
  });
  return list.sort(function (a, b) { return a.t - b.t; });
}
function statusNote(s) {
  if (!s) return null;
  if (s.made === 0) return "No zmanim times loaded";
  if (s.made && s.ts - s.made >= 3 * 86400) return "Zmanim file is " + Math.floor((s.ts - s.made) / 86400) + " days old. Check the GitHub job.";
  return null;
}

// ------------------------------------------------------------------ rendering
function render(d) { hero(); cards(); if (d === SEL) details(); zshow(); }

// the next candle lighting / havdalah, from this device's times
function hero() {
  var s = DEVS[0].sum, el = $("hero");
  if (!s || s.ts === undefined) { el.innerHTML = '<p class="hero-wait">Loading zmanim</p>'; return; }
  var seen = {}, zs = [];                       // one entry per zman (the script's info markers)
  s.next.forEach(function (e) { if ((e[4] === 1 || e[4] === 2) && e[1] === null && !seen[e[3]]) { seen[e[3]] = 1; zs.push(e); } });
  if (!zs.length) { el.innerHTML = '<p class="hero-wait">' + esc(statusNote(s) || "No candle lighting or havdalah in the next week") + "</p>"; return; }
  function name(e) { var i = e[2].indexOf(" - "); return i > 0 ? e[2].slice(0, i) : e[2]; }   // Candle lighting / Havdalah / Yom Tov night
  function memo(e) { var i = e[2].indexOf(" - "); return i > 0 ? e[2].slice(i + 3) : ""; }
  var a = zs[0], b = zs[1];
  el.innerHTML =
    '<p class="hero-kind">' + name(a) + (memo(a) && memo(a) !== "Shabbat" ? ", " + esc(memo(a)) : "") + "</p>" +
    '<p class="hero-time">' + hm(a[3], s.off) + "</p>" +
    '<p class="hero-when">' + dayLabel(a[3], s.ts, s.off) + ", " + until(a[3], s.ts) + "</p>" +
    (b ? '<p class="hero-then">Then ' + name(b).toLowerCase() + " " + (/^(Today|Tomorrow)$/.test(dayLabel(b[3], s.ts, s.off)) ? "" : "on ") + lc(dayLabel(b[3], s.ts, s.off)) + " at " + hm(b[3], s.off) + "</p>" : "");
}

function cards() {
  $("cards").innerHTML = DEVS.map(function (d, i) {
    var s = d.sum, on = s && s.relay, note = d.err || statusNote(s), nx = null;
    if (s) upcoming(d).some(function (e) { if (e.on !== null && !e.skip) { nx = e; return true; } });
    var nextTxt = !s ? "" : nx ? "Turns " + (nx.on ? "on" : "off") + " " + (/^(Today|Tomorrow)$/.test(dayLabel(nx.t, s.ts, s.off)) ? "" : "on ") + lc(dayLabel(nx.t, s.ts, s.off)) + " at " + hm(nx.t, s.off) : "Nothing scheduled this week";
    var ready = s && d.core !== undefined && !d.dead;
    return '<article class="dev' + (on ? " is-on" : "") + (d === SEL ? " is-sel" : "") + (ready ? "" : " is-wait") + '">' +
      '<button class="dev-head" onclick="pick(' + i + ')" aria-expanded="' + (d === SEL) + '">' +
        '<span class="lamp" aria-hidden="true"></span>' +
        '<span class="dev-name">' + esc(d.name) + "</span>" +
        '<span class="dev-state">' + (s ? (on ? "On" : "Off") : "") + "</span>" +
        '<span class="chev" aria-hidden="true"></span>' +
      "</button>" +
      (nextTxt ? '<p class="dev-next">' + esc(nextTxt) + "</p>" : "") +
      (note ? '<p class="dev-note">' + esc(note) + "</p>" : "") +
      '<div class="dev-ctl">' +
        '<button class="b-on" onclick="sw(' + i + ',1)"' + (ready ? "" : " disabled") + ">Turn on</button>" +
        '<button class="b-off" onclick="sw(' + i + ',0)"' + (ready ? "" : " disabled") + ">Turn off</button>" +
      "</div>" +
    "</article>";
  }).join("");
}
function sw(i, on) {
  var d = DEVS[i];
  core(d, on ? "cmd=on" : "cmd=off").then(function () { setTimeout(function () { refreshDev(d); }, 1200); })
    .catch(function (e) { d.err = "Couldn't switch (" + e.message + ")"; cards(); });
}
function pick(i) {
  var d = DEVS[i];
  if (d.core === undefined) return;
  SEL = SEL === d ? null : d;
  ED = null; msg("");
  if (SEL) sreset();
  cards(); details();
  if (SEL) { $("detail").scrollIntoView({ behavior: "smooth", block: "start" }); refreshDev(d, true); }
}

// ------------------------------------------------------------------ details of the selected device
var ED = null;
function details() {
  var el = $("detail");
  if (!SEL) { el.hidden = true; return; }
  el.hidden = false;
  var d = SEL, s = d.sum;
  $("det-name").textContent = d.name;
  $("det-bar").classList.toggle("is-on", !!(s && s.relay));
  $("det-state").textContent = s ? (s.relay ? "On" : "Off") : "";
  var up = upcoming(d);
  $("up").innerHTML = !s ? '<li class="empty">Loading</li>' : up.length ? up.map(function (e) {
    return '<li class="ev' + (e.skip ? " skip" : "") + (e.on === null ? " info" : "") + '">' +
      '<span class="ev-when">' + esc(dayLabel(e.t, s.ts, s.off)) + "<b>" + hm(e.t, s.off) + "</b></span>" +
      '<span class="ev-act ' + (e.on === null ? "" : e.on ? "on" : "off") + '">' + (e.on === null ? "" : e.on ? "On" : "Off") + "</span>" +
      '<span class="ev-why">' + esc(e.why) + "</span></li>";
  }).join("") : '<li class="empty">Nothing in the next 7 days</li>';
  $("hist").innerHTML = !s ? "" : s.hist.length ? s.hist.map(function (e) {
    var p = typeof e[3] === "number" ? [dmy(e[3], s.off), hm(e[3], s.off)] : String(e[0]).split(/ (?=\d\d:)/);   // v8.2 sends "Fri 09/10 18:25" only
    return '<li class="ev"><span class="ev-when">' + esc(p[0]) + "<b>" + esc(p[1] || "") + '</b></span><span class="ev-act ' + (e[1] ? "on" : "off") + '">' + (e[1] ? "On" : "Off") + '</span><span class="ev-why">' + esc(e[2]) + "</span></li>";
  }).join("") : '<li class="empty">No switching recorded yet</li>';
  slist();
}

// ---- schedules
function dtxt(d) { return d.length === 7 ? "Every day" : d.map(function (x) { return DN[x]; }).join(", "); }
function rtxt(r) {
  return (r[0] === 1 ? "Candle lighting" : "Havdalah") + (r[1] ? ", " + Math.abs(r[1]) + " min " + (r[1] < 0 ? "before" : "after") : "");
}
function slist() {
  var d = SEL, s = d.sum, paused = (s && s.paused) || [], h = "";
  (d.sj || []).forEach(function (j, i) {
    var p = paused.indexOf(j.id) >= 0, skip = d.sk.indexOf(j.id) >= 0;
    var what = j.a !== null ? (j.a ? "On" : "Off") : (j.m === "Shelly.Update" ? "Firmware update" : esc(j.m || "Other action"));
    var tags = (skip ? '<span class="tag">Skips Shabbos/Yom Tov</span>' : "") + (p ? '<span class="tag">Paused now</span>' : "");
    h += '<li class="sch' + (j.en || p ? "" : " off") + '">' +
      '<div class="sch-main"><span class="sch-when">' + (j.t || "Custom") + "</span>" +
        '<span class="sch-what ' + (j.a === null ? "" : j.a ? "on" : "off") + '">' + what + "</span>" +
        '<span class="sch-days">' + (j.t ? dtxt(j.d) : esc(j.ts)) + "</span>" + tags + "</div>" +
      '<div class="sch-ctl">' +
        (j.fx ? "" : '<button onclick="sktog(' + i + ')">' + (skip ? "Run on Shabbos" : "Skip Shabbos") + "</button>") +
        '<button onclick="sen(' + i + ')">' + (j.en || p ? "Disable" : "Enable") + "</button>" +
        (j.fx ? '<button onclick="sedit(' + i + ')">Edit</button>' : "") +
        '<button onclick="sdel(' + i + ')">Delete</button></div></li>';
  });
  (d.rj || []).forEach(function (r, i) {
    h += '<li class="sch' + (r[4] ? "" : " off") + '">' +
      '<div class="sch-main"><span class="sch-when">' + rtxt(r) + "</span>" +
        '<span class="sch-what ' + (r[2] ? "on" : "off") + '">' + (r[2] ? "On" : "Off") + "</span>" +
        (r[3] ? '<span class="sch-days">' + FL[r[3]] + "</span>" : '<span class="sch-days">Every time</span>') + "</div>" +
      '<div class="sch-ctl"><button onclick="ren(' + i + ')">' + (r[4] ? "Disable" : "Enable") + '</button>' +
        '<button onclick="redit(' + i + ')">Edit</button><button onclick="rdel(' + i + ')">Delete</button></div></li>';
  });
  $("sl").innerHTML = h || '<li class="empty">No schedules yet. Add one below.</li>';
}
function msg(t) { $("smsg").textContent = t || ""; }
function after(p) {                              // run a change, then reload this device's schedules and status
  var d = SEL; msg("Saving");
  return p.then(function () { return refreshDev(d, true); }).catch(function (e) { msg("Failed: " + e.message); throw e; });
}
function skset(d, id, on) { var i = d.sk.indexOf(id); if (on && i < 0) d.sk.push(id); if (!on && i >= 0) d.sk.splice(i, 1); return rpcAt(d.base, "KVS.Set", { key: "zmanim_skip", value: JSON.stringify(d.sk) }); }
function sktog(i) { var d = SEL, j = d.sj[i]; after(skset(d, j.id, d.sk.indexOf(j.id) < 0)).then(function () { msg(""); }); }
function sen(i) {
  var d = SEL, j = d.sj[i];
  if (((d.sum && d.sum.paused) || []).indexOf(j.id) >= 0) { msg("Paused for Shabbos/Yom Tov. It resumes at havdalah."); return; }
  after(rpcAt(d.base, "Schedule.Update", { id: j.id, enable: !j.en })).then(function () { msg(""); });
}
function sdel(i) {
  var d = SEL, id = d.sj[i].id;
  if (confirm("Delete this schedule?")) after(rpcAt(d.base, "Schedule.Delete", { id: id }).then(function () { return d.sk.indexOf(id) >= 0 ? skset(d, id, false) : null; })).then(function () { sreset(); msg("Deleted"); });
}
function rsave(d) {
  var v = JSON.stringify(d.rj);
  if (v.length > 250) return Promise.reject(new Error("too many zman schedules for the device's storage"));
  return rpcAt(d.base, "KVS.Set", { key: "zmanim_rules", value: v }).then(function () { return core(d, "cmd=refresh"); })
    .then(function () { return new Promise(function (ok) { setTimeout(ok, 2500); }); });
}
function rchange(f) { var d = SEL, old = JSON.stringify(d.rj || []); d.rj = d.rj || []; f(d.rj); return after(rsave(d).catch(function (e) { d.rj = JSON.parse(old); throw e; })); }
function ren(i) { rchange(function (rj) { rj[i][4] = rj[i][4] ? 0 : 1; }).then(function () { msg(""); }); }
function rdel(i) { if (confirm("Delete this schedule?")) rchange(function (rj) { rj.splice(i, 1); }).then(function () { sreset(); msg("Deleted"); }); }

function hclear() {
  var d = SEL; if (!d || !confirm("Clear the switching history for " + d.name + "?")) return;
  evalAt(d.base, d.core, 'history=[];call("KVS.Set",{key:"zmanim_hist",value:"[]"});1')
    .then(function () { return refreshDev(d); })
    .catch(function (e) { alert("Couldn't clear: " + e.message); });
}

// ---- add / edit form
function sform() {
  var tg = +$("stg").value;
  $("fx").hidden = tg > 0; $("zm").hidden = tg === 0;
  $("smn").hidden = $("sof").value === "0";
  var opts = tg === 2 ? FL.slice(0, 3) : FL, cur = $("sfl").value;
  $("sfl").innerHTML = opts.map(function (t, i) { return '<option value="' + i + '">' + t + "</option>"; }).join("");
  if (cur && +cur < opts.length) $("sfl").value = cur;
}
function dsty() { for (var i = 0; i < 7; i++) $("dl" + i).classList.toggle("on", $("d" + i).checked); }
function sreset() {
  ED = null; $("sft").textContent = "Add a schedule"; $("stg").value = "0"; $("sof").value = "0"; $("ssk").checked = false;
  for (var k = 0; k < 7; k++) $("d" + k).checked = false;
  dsty(); sform();
}
function sedit(i) {
  var j = SEL.sj[i]; ED = j.id; $("sft").textContent = "Edit schedule";
  $("stg").value = "0"; sform(); $("stm").value = j.t;
  for (var k = 0; k < 7; k++) $("d" + k).checked = j.d.indexOf(k) >= 0;
  dsty(); $("sac").value = j.a ? "on" : "off"; $("ssk").checked = SEL.sk.indexOf(j.id) >= 0; msg("");
  $("sform").scrollIntoView({ behavior: "smooth", block: "center" });
}
function redit(i) {
  var r = SEL.rj[i]; ED = "r" + i; $("sft").textContent = "Edit schedule";
  $("stg").value = r[0]; $("sof").value = r[1] < 0 ? "-1" : (r[1] > 0 ? "1" : "0"); $("smn").value = Math.abs(r[1]) || 10;
  sform(); $("sfl").value = r[3]; $("sac").value = r[2] ? "on" : "off"; msg("");
  $("sform").scrollIntoView({ behavior: "smooth", block: "center" });
}
function done() { sreset(); msg("Saved"); }
function ssave() {
  var d = SEL, tg = +$("stg").value, on = $("sac").value === "on";
  if (tg > 0) {
    var sg = +$("sof").value, mn = Math.round(+$("smn").value);
    if (sg !== 0 && !(mn >= 1 && mn <= 180)) { msg("Minutes must be between 1 and 180"); return; }
    var r = [tg, sg ? sg * mn : 0, on ? 1 : 0, +$("sfl").value, 1];
    if (typeof ED === "string") {
      var ri = +ED.slice(1); r[4] = d.rj[ri][4];
      rchange(function (rj) { rj[ri] = r; }).then(done);
    } else if (ED !== null) {                     // fixed-time schedule changed into a zman one
      var old = ED;
      rchange(function (rj) { rj.push(r); }).then(function () { return after(rpcAt(d.base, "Schedule.Delete", { id: old })); }).then(done);
    } else rchange(function (rj) { rj.push(r); }).then(done);
    return;
  }
  var days = []; for (var k = 0; k < 7; k++) if ($("d" + k).checked) days.push(k);
  var t = $("stm").value;
  if (!days.length) { msg("Pick at least one day"); return; }
  if (!/^\d\d:\d\d$/.test(t)) { msg("Enter a time"); return; }
  var ts = "0 " + (+t.slice(3)) + " " + (+t.slice(0, 2)) + " * * " + (days.length === 7 ? "*" : days.map(function (x) { return SD[x]; }).join(","));
  var p = { enable: true, timespec: ts, calls: [{ method: "Switch.Set", params: { id: d.sw, on: on } }] }, sk = $("ssk").checked;
  if (typeof ED === "string") {                   // zman schedule changed into a fixed-time one
    var zi = +ED.slice(1);
    after(rpcAt(d.base, "Schedule.Create", p).then(function (c) { return skset(d, c.id, sk); }))
      .then(function () { return rchange(function (rj) { rj.splice(zi, 1); }); }).then(done);
    return;
  }
  var eid = ED; if (eid !== null) p.id = eid;
  after(rpcAt(d.base, eid === null ? "Schedule.Create" : "Schedule.Update", p).then(function (c) { return skset(d, eid === null ? c.id : eid, sk); })).then(done);
}

// ------------------------------------------------------------------ zmanim settings (the same on every device)
// Each Shelly keeps its own copy (it must run without this page); Save writes the same values to all of them.
var GH = (function () {                         // "user/repo" this page was loaded from
  var src = (document.currentScript && document.currentScript.src) || "", m = /^https:\/\/([^.\/]+)\.github\.io\/([^\/?#]+)\//.exec(src);
  return m ? m[1] + "/" + m[2] : "cgr210/zmanim-ui";
})();
var RAW = "https://raw.githubusercontent.com/" + GH + "/main/";
var GEO = { 0: "nightfall 8.5°", 1: "nightfall 7.08°", 2: "nightfall 6°", 42: "42 min after sunset", 50: "50 min after sunset", 60: "60 min after sunset" };
function havText(c) { return c.hm === 1 ? "Rabbeinu Tam " + c.rt + " min" : "Geonim, " + (GEO[c.g] || c.g); }
var LOCS = [], NEWLOC = null, ZFILLED = false, ZDIRTY = false, ZPOLL = null;

// a device's zmanim settings. Script v8.2 has only h (minutes after sunset, 0 = 8.5 deg) and no rounding rules.
function cfgOf(d) {
  var c = d.sum && d.sum.cfg; if (!c) return null;
  if (typeof c.hm === "number") return { c: c.c, hm: c.hm, g: c.g, rt: c.rt, l: c.l || "london", old: false };
  return { c: c.c, hm: c.h >= 72 ? 1 : 0, g: c.h >= 72 ? 0 : c.h, rt: c.h >= 72 ? c.h : 72, l: c.l || "london", old: true };
}
function sameCfg(a, b) { return a.c === b.c && a.hm === b.hm && a.g === b.g && (a.hm !== 1 || a.rt === b.rt) && a.l === b.l; }
function zform() { return { c: Math.round(+$("zc").value), hm: +$("zhm").value, g: +$("zg").value, rt: +$("zrt").value }; }
function zhv() { $("zrtl").hidden = $("zhm").value !== "1"; }
function locById(id) {
  if (NEWLOC && NEWLOC.id === id) return NEWLOC;
  for (var i = 0; i < LOCS.length; i++) if (LOCS[i].id === id) return LOCS[i];
  return null;
}
function locName(id) { var L = locById(id); return L ? (L.name || L.id) : id; }
function zloc() {                               // the location chosen in the form
  return locById($("zl").value) || LOCS[0] || { id: "london", name: "London", lat: 51.50853, lon: -0.12574, tz: "Europe/London" };
}
function fetchLocs() {
  // GitHub's API first: it isn't cached, so a location added a minute ago is there. Then the plain file (cached up to ~5 min).
  var t = tokGet(), h = { "Accept": "application/vnd.github+json" };
  if (t) h.Authorization = "Bearer " + t;
  return fetch("https://api.github.com/repos/" + GH + "/contents/locations.json?ref=main", { cache: "no-store", headers: h })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (f) { return JSON.parse(b64dec(f.content)); })
    .catch(function () {
      return fetch(RAW + "locations.json?t=" + Date.now(), { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    });
}
function loadLocs() {
  return fetchLocs()
    .then(function (a) {
      LOCS = a;
      if (NEWLOC && LOCS.some(function (x) { return x.id === NEWLOC.id; })) NEWLOC = null;
      zlocs(); $("zlmsg").textContent = ""; zshow();
    })
    .catch(function (e) { $("zlmsg").textContent = "Couldn't load the list of locations from GitHub (" + e.message + ")"; });
}
function zlocs() {                              // fill the Location list, keeping the current choice
  var cur = $("zl").value || ((DEVS[0] && cfgOf(DEVS[0])) || {}).l || "london", list = LOCS.slice();
  if (NEWLOC) list.push(NEWLOC);
  if (!locById(cur)) list.push({ id: cur, name: cur + " (not in locations.json)" });
  $("zl").innerHTML = list.map(function (L) {
    var where = L.lat !== undefined ? " (" + (+L.lat).toFixed(4) + ", " + (+L.lon).toFixed(4) + ")" : "";
    return '<option value="' + esc(L.id) + '">' + esc((L.name || L.id) + where + (L === NEWLOC ? ", not on GitHub yet" : "")) + "</option>";
  }).join("");
  $("zl").value = cur;
}
function zfill(c) { $("zc").value = c.c; $("zhm").value = c.hm; $("zg").value = c.g; $("zrt").value = c.rt; zhv(); if (locById(c.l)) $("zl").value = c.l; else { zlocs(); $("zl").value = c.l; } }
function zchanged() { ZDIRTY = true; $("zmsg").textContent = ""; if ($("zweek").open) wk(0); }

// summary line + warnings; called whenever a device's status comes in
function zshow() {
  var c0 = DEVS[0] && cfgOf(DEVS[0]);
  if (!c0) return;
  if (!ZFILLED && !ZDIRTY) { zfill(c0); ZFILLED = true; }
  $("zsum").textContent = locName(c0.l) + ", candles " + c0.c + " min before sunset, havdalah " + havText(c0);
  var diff = [], old = [];
  DEVS.forEach(function (d) {
    var c = cfgOf(d); if (!c || d.dead) return;
    if (!sameCfg(c, c0)) diff.push(d.name + " (" + locName(c.l) + ", " + c.c + " min, havdalah " + havText(c) + ")");
    if (c.old) old.push(d.name);
  });
  var w = [];
  if (diff.length) w.push("Not the same on every device: " + diff.join("; ") + ". Save to make them match.");
  if (old.length) w.push(old.join(", ") + (old.length > 1 ? " have" : " has") + " the older script (v8.2): London only, Hebcal's rounding instead of yours, no 8-minute rule and no 7.08° / 6°. Update to v8.3.");
  $("zwarn").textContent = w.join(" ");
  $("zwarn").hidden = !w.length;
}

function zsave() {
  var F = zform(), c = F.c, L = zloc(), m = $("zmsg");
  if (!($("zc").value !== "" && c >= 0 && c <= 60)) { m.textContent = "Candle lighting must be 0 to 60 minutes"; return; }
  if (L === NEWLOC) { m.textContent = "Finish adding " + L.name + " on GitHub first (steps under Add a location)."; return; }
  if (!/^[a-z0-9_-]{1,30}$/.test(L.id)) { m.textContent = "The id \"" + L.id + "\" in locations.json can't be used: it must be lower-case letters, digits or - (e.g. \"" + String(L.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "\"). Change the id on GitHub; the name can stay as it is."; return; }
  m.textContent = "Checking the times file for " + (L.name || L.id);
  fetch(RAW + "times/" + L.id + ".v2.csv?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) { return r.ok ? r.text() : ""; }, function () { return null; })
    .then(function (b) {
      if (b === "" || (b && b.indexOf("#zmanim v2") !== 0)) throw new Error("There's no times file for " + (L.name || L.id) + " on GitHub yet. If you've just added it, wait a minute and try again.");
      var devs = DEVS.filter(function (d) { return d.core !== undefined && !d.dead; }), errs = [], ok = 0;
      m.textContent = "Saving";
      return devs.reduce(function (p, d) {
        return p.then(function () {
          var cf = cfgOf(d);
          if (cf && cf.old && L.id !== "london") { errs.push(d.name + ": needs script v8.3 for another location"); return; }
          if (cf && cf.old && F.hm === 0 && F.g < 42 && F.g !== 0) { errs.push(d.name + ": needs script v8.3 for " + GEO[F.g]); return; }
          var q = cf && cf.old ? "&h=" + (F.hm === 1 ? F.rt : F.g)                 // v8.2: minutes after sunset, 0 = 8.5 deg
                               : "&hm=" + F.hm + "&g=" + F.g + "&rt=" + F.rt + "&l=" + encodeURIComponent(L.id);
          return core(d, "set=1&c=" + c + q + "&il=0&ps=1")
            .then(function (s) { if (s.msg && !/^Saved/.test(s.msg)) errs.push(d.name + ": " + s.msg); else ok++; d.sum = s; },
                  function (e) { errs.push(d.name + ": " + e.message); });
        });
      }, Promise.resolve()).then(function () {
        ZDIRTY = false;
        m.textContent = (ok ? "Saved on " + ok + (ok === 1 ? " device" : " devices") + ". Times are being recalculated." : "") + (errs.length ? " Not saved on " + errs.join("; ") : "");
        zshow(); render(DEVS[0]);
        setTimeout(function () { DEVS.reduce(function (p, d) { return p.then(function () { return d.dead ? null : refreshDev(d); }); }, Promise.resolve()); }, 3000);
      });
    })
    .catch(function (e) { m.textContent = e.message; });
}

// ---- add a location: the page writes the new locations.json, you commit it on GitHub, the job makes the times file
// GitHub token (optional): lets the page commit locations.json itself. Kept only in this browser.
var TOKKEY = "zmanim-github-token";
function tokGet() { try { return localStorage.getItem(TOKKEY) || ""; } catch (e) { return ""; } }
function tokSave() {
  var v = $("ztok").value.trim();
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(v)) { $("ztmsg").textContent = "That doesn't look like a GitHub token (it starts with github_pat_)"; return; }
  $("ztmsg").textContent = "Checking the token";
  gh("GET", "", null, v).then(function (r) {
    if (r.permissions && r.permissions.push === false) throw new Error("this token can't change " + GH);
    try { localStorage.setItem(TOKKEY, v); } catch (e) { throw new Error("this browser won't store it (private window?)"); }
    $("ztok").value = ""; tokShow(); $("ztmsg").textContent = "Saved. Add a location and the page commits it for you.";
  }).catch(function (e) { $("ztmsg").textContent = "Not saved: " + e.message; });
}
function tokForget() { try { localStorage.removeItem(TOKKEY); } catch (e) { } tokShow(); $("ztmsg").textContent = "Forgotten in this browser."; }
function tokShow() {
  var t = tokGet();
  $("ztok-set").hidden = !t; $("ztok-new").hidden = !!t;
  $("zgo").textContent = t ? "Add location" : "Next";
}
// GitHub API call for this repo; path "" = the repo itself
function gh(method, path, body, tok) {
  tok = tok || tokGet() || $("ztok").value.trim();
  return fetch("https://api.github.com/repos/" + GH + (path ? "/contents/" + path : ""), {
    method: method, cache: "no-store",
    headers: { "Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.ok) return j;
      if (r.status === 401) throw new Error("GitHub didn't accept the token (wrong, or expired)");
      if (r.status === 403 || r.status === 404) throw new Error("the token doesn't have access to " + GH + " (needs Contents: Read and write)");
      if (r.status === 409) throw new Error("locations.json changed at the same moment; press Add location again");
      throw new Error("GitHub said " + r.status + (j.message ? ": " + j.message : ""));
    });
  });
}
function b64dec(s) { return decodeURIComponent(escape(atob(String(s).replace(/\s/g, "")))); }
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
function locText(list) {
  return "[\n" + list.map(function (x) { return "  " + JSON.stringify(x).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, "{ ").replace(/\}$/, " }"); }).join(",\n") + "\n]\n";
}

function zprep() {
  var nm = $("zn").value.trim(), co = $("zco").value.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/), m = $("zamsg"), tok = tokGet();
  if (!nm || nm.length > 40) { m.textContent = "Enter a name (up to 40 characters)"; return; }
  if (!co) { m.textContent = "Enter the coordinates as latitude, longitude, e.g. 51.5484, 0.1716"; return; }
  var lat = +co[1], lon = +co[2];
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) { m.textContent = "Latitude must be -90 to 90 and longitude -180 to 180"; return; }
  function entry(list) {
    var base = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "site", id = base, n = 2;
    while (list.some(function (x) { return x.id === id; })) id = base + "-" + n++;
    return { id: id, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, tz: TZ || "Europe/London", name: nm };
  }
  function pending(L) { NEWLOC = L; zlocs(); $("zl").value = L.id; zchanged(); zwatch(L.id); }
  m.textContent = "Getting the current list from GitHub";
  if (tok) {                                     // automatic: commit locations.json through the GitHub API
    var sha;
    gh("GET", "locations.json").then(function (f) {
      sha = f.sha;
      var list = JSON.parse(b64dec(f.content)), L = entry(list);
      LOCS = list;
      m.textContent = "Adding " + nm + " to locations.json on GitHub";
      return gh("PUT", "locations.json", { message: "Add location " + nm, content: b64enc(locText(list.concat([L]))), sha: sha }).then(function () { return L; });
    }).then(function (L) {
      $("zsteps").hidden = true; m.textContent = "Added to GitHub.";
      pending(L);
    }).catch(function (e) { m.textContent = "Couldn't add it: " + e.message; });
    return;
  }
  fetchLocs()
    .then(function (list) {
      LOCS = list;
      var L = entry(list);
      $("zjson").value = locText(list.concat([L]));
      $("zgh").href = "https://github.com/" + GH + "/edit/main/locations.json";
      $("zsteps").hidden = false; m.textContent = "";
      pending(L);
    })
    .catch(function (e) { m.textContent = "Couldn't get locations.json from GitHub (" + e.message + ")"; });
}
function zcopy() {
  var ta = $("zjson"), done = function () { $("zpoll").textContent = "Copied. Now open locations.json on GitHub (step 2)."; };
  function byHand() {
    ta.focus(); ta.select();
    try { if (document.execCommand("copy")) { done(); return; } } catch (e) { }
    $("zpoll").textContent = "Select the text above and copy it (Ctrl+C, or press and hold on a phone).";
  }
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(ta.value).then(done, byHand); else byHand();
}
function zwatch(id) {                            // wait for GitHub to make times/<id>.csv
  if (ZPOLL) clearInterval(ZPOLL);
  var tries = 0, el = $("zpoll");
  el.textContent = tokGet() ? "Waiting for GitHub to make the times file. This usually takes about a minute." : "Waiting for the times file. Once you've committed on GitHub it usually takes about a minute.";
  ZPOLL = setInterval(function () {
    if (++tries > 60) { clearInterval(ZPOLL); ZPOLL = null; el.textContent = "Still no times file after 20 minutes. Check the Actions tab on GitHub for a failed run."; return; }
    fetch(RAW + "times/" + id + ".v2.csv?t=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (b) {
        if (b.indexOf("#zmanim v2") !== 0) return;
        clearInterval(ZPOLL); ZPOLL = null;
        return loadLocs().then(function () {
          $("zl").value = id; zchanged();
          el.textContent = "Ready. " + locName(id) + " is selected: press Save for all devices to use it.";
        });
      }).catch(function () { });
  }, 20000);
}

// ------------------------------------------------------------------ check a week (worked out in this browser with Hebcal's library)
var HC = null;
function hebcalLib() {
  if (window.hebcal) return Promise.resolve(window.hebcal);
  if (HC) return HC;
  HC = new Promise(function (ok, no) {
    var sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/@hebcal/core@6.14.1/dist/bundle.min.js";   // same version as the GitHub job
    sc.onload = function () { if (window.hebcal) ok(window.hebcal); else { HC = null; no(new Error("the Hebcal library didn't load")); } };
    sc.onerror = function () { HC = null; no(new Error("couldn't load the Hebcal library (needs internet)")); };
    document.head.appendChild(sc);
  });
  return HC;
}
function ymdL(g) { return g.getFullYear() + "-" + p2(g.getMonth() + 1) + "-" + p2(g.getDate()); }
// the same rows the GitHub job writes (see tools/make-times.mjs), for dates start..end
function zrows(hc, L, start, end) {
  var loc = new hc.Location(L.lat, L.lon, false, L.tz, L.name || L.id, "XX");
  var evs = hc.HebrewCalendar.calendar({ start: start, end: end, location: loc, il: false, candlelighting: true,
    candleLightingMins: 18, havdalahDeg: 8.5, noMinorFast: true, noModern: true, noRoshChodesh: true, noSpecialShabbat: true });
  var yt = {}, name = {}, rows = [];
  evs.forEach(function (e) {
    var ds = e.getDesc();
    if (ds === "Candle lighting" || ds === "Havdalah" || !(e.getFlags() & hc.flags.CHAG)) return;
    var d = ymdL(e.getDate().greg()); yt[d] = 1; name[d] = e.render("en");
  });
  evs.forEach(function (e) {
    var ds = e.getDesc(); if (ds !== "Candle lighting" && ds !== "Havdalah") return;
    var g = e.getDate().greg(), d = ymdL(g), z = new hc.Zmanim(loc, g, false);
    var ex = function (x) { return x instanceof Date && !isNaN(x.getTime()) ? Math.floor(x.getTime() / 1000) : 0; };   // exact, as the GitHub job writes
    var sunset = ex(z.sunset()), tz = [ex(z.tzeit(8.5)), ex(z.tzeit(7.083)), ex(z.tzeit(6))];
    var nx = new Date(g.getFullYear(), g.getMonth(), g.getDate() + 1), nd = ymdL(nx), wd = g.getDay();
    if (ds === "Candle lighting") {
      var mode = e.eventTime.getTime() > z.sunset().getTime() ? 1 : 0, shab = nx.getDay() === 6;
      rows.push({ date: d, type: 1, sunset: sunset, tz: tz, mode: mode, shab: shab, yt: !!yt[nd], first: mode === 0 && wd !== 6 && !yt[d], memo: name[nd] || (shab ? "Shabbat" : "") });
    } else rows.push({ date: d, type: 2, sunset: sunset, tz: tz, mode: 1, shab: wd === 6, yt: !!yt[d], first: false, memo: name[d] || (wd === 6 ? "Shabbat" : "") });
  });
  return rows;
}
// The same rules as the script (v8.3): havdalah up to 24 seconds past the minute -> that minute, otherwise the next;
// Rabbeinu Tam never less than 8 minutes after the Geonim. $S/$G/$R in "how" = sunset / Geonim / Rabbeinu Tam times.
function r24(t) { var x = t % 60; return x <= 24 ? t - x : t - x + 60; }
function havCalc(r, F) {
  var gt = F.g >= 42 ? r.sunset + F.g * 60 : r.tz[F.g];
  if (!gt) return { t: 0, how: "" };
  gt = r24(gt);
  var gtxt = "Geonim, " + GEO[F.g] + " = $G";
  if (F.hm !== 1) return { t: gt, g: gt, how: gtxt + " (sunset $S)" };
  var rt = r24(r.sunset + F.rt * 60);
  if (rt < gt + 480) return { t: gt + 480, g: gt, r: rt, how: "Rabbeinu Tam: " + F.rt + " min after sunset $S would be $R, less than 8 min after the Geonim ($G), so Geonim + 8" };
  return { t: rt, g: gt, r: rt, how: "Rabbeinu Tam, " + F.rt + " min after sunset $S (Geonim $G)" };
}
function hmIn(t, tz) { var d = new Date((t + tzOff(t, tz)) * 1000); return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()); }
function wallIn(w, tz) { var t = w - tzOff(w, tz); return w - tzOff(t, tz); }

function wkToday() { var L = zloc(), t = Math.floor(Date.now() / 1000), d = new Date((t + tzOff(t, L.tz)) * 1000); $("zwd").value = d.toISOString().slice(0, 10); wk(0); }
function wk(n) {
  var out = $("zwk"), L = zloc();
  if (!$("zwd").value) { var t0 = Math.floor(Date.now() / 1000); $("zwd").value = new Date((t0 + tzOff(t0, L.tz)) * 1000).toISOString().slice(0, 10); }
  var p = $("zwd").value.split("-"), sel = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  $("zwd").value = sel.toISOString().slice(0, 10);
  var sun = Date.UTC(sel.getUTCFullYear(), sel.getUTCMonth(), sel.getUTCDate() - sel.getUTCDay()) / 1000;   // Sunday 00:00 as "wall" seconds
  var F = zform(), c = F.c || 0;
  out.innerHTML = '<p class="empty">Working it out</p>';
  hebcalLib().then(function (hc) {
    var s0 = new Date(sun * 1000);
    var rows = zrows(hc, L, new Date(s0.getUTCFullYear(), s0.getUTCMonth(), s0.getUTCDate() - 7), new Date(s0.getUTCFullYear(), s0.getUTCMonth(), s0.getUTCDate() + 8));
    // the zmanim, as the Shellys work them out from the times file and these settings
    var z = rows.map(function (r) {
      if (r.type === 1 && r.mode === 0) return { r: r, kind: 1, t: r.sunset - r.sunset % 60 - c * 60 };
      var hv = havCalc(r, F); return { r: r, kind: r.type, t: hv.t, hv: hv };
    }).filter(function (e) { return e.t; }).sort(function (a, b) { return a.t - b.t; });
    var win = [], st = null;                       // Shabbos / Yom Tov: from candle lighting to havdalah
    z.forEach(function (e) { if (e.kind === 1 && st === null) st = e.t; else if (e.kind === 2 && st !== null) { win.push([st, e.t]); st = null; } });
    if (st !== null) win.push([st, Infinity]);
    var a = wallIn(sun, L.tz), b = wallIn(sun + 7 * 86400, L.tz), items = [];
    z.forEach(function (e) {
      if (e.t < a || e.t >= b) return;
      var r = e.r, nm = e.kind === 2 ? "Havdalah" : r.mode === 0 ? "Candle lighting" : "Yom Tov night";
      var how = e.hv ? (r.type === 1 ? "no candle lighting time, havdalah time used: " : "") + e.hv.how.replace(/\$S/g, hmIn(r.sunset, L.tz)).replace(/\$G/g, hmIn(e.hv.g, L.tz)).replace(/\$R/g, e.hv.r ? hmIn(e.hv.r, L.tz) : "")
                     : c + " min before sunset (sunset " + hmIn(r.sunset, L.tz) + ")";
      items.push({ t: e.t, info: true, why: nm + (r.memo ? ", " + r.memo : "") + ": " + how });
      DEVS.forEach(function (d) {
        if (d.core === undefined || d.dead) return;
        (d.rj || []).forEach(function (q) {
          if (q[0] !== e.kind || !q[4]) return;
          if ((q[3] === 1 && !r.shab) || (q[3] === 2 && !r.yt) || (q[3] === 3 && !r.first)) return;
          items.push({ t: e.t + q[1] * 60, on: !!q[2], why: d.name + ": " + rtxt(q) + (r.type === 1 && r.mode === 1 ? " (Yom Tov night)" : "") + (q[3] ? ", " + FL[q[3]] : "") });
        });
      });
    });
    // fixed-time schedules that fall on Shabbos / Yom Tov
    DEVS.forEach(function (d) {
      if (d.core === undefined || d.dead) return;
      var paused = (d.sum && d.sum.paused) || [];
      (d.sj || []).forEach(function (j) {
        if (!j.fx || j.a === null || !(j.en || paused.indexOf(j.id) >= 0)) return;
        var sec = +j.t.slice(0, 2) * 3600 + +j.t.slice(3) * 60;
        for (var k = 0; k < 7; k++) {
          if (j.d.indexOf(k) < 0) continue;
          var t = wallIn(sun + k * 86400 + sec, L.tz);
          if (!win.some(function (w) { return t >= w[0] && t < w[1]; })) continue;
          var skip = (d.sk || []).indexOf(j.id) >= 0;
          items.push({ t: t, on: j.a, skip: skip, warn: !skip, why: d.name + ": " + j.t + " schedule" + (skip ? ", skipped for Shabbos/Yom Tov" : ", runs on Shabbos/Yom Tov (not set to skip)") });
        }
      });
    });
    items.sort(function (x, y) { return x.t - y.t || (y.info ? 1 : 0) - (x.info ? 1 : 0); });
    var html = '<p class="wk-head">' + esc(dayTitle(sun) + " to " + dayTitle(sun + 6 * 86400)) + ", " + esc(L.name || L.id) + "</p>", day = null;
    if (!items.length) html += '<p class="empty">No candle lighting or havdalah this week</p>';
    items.forEach(function (e) {
      var dd = Math.floor((e.t + tzOff(e.t, L.tz)) / 86400);
      if (dd !== day) { if (day !== null) html += "</ul>"; day = dd; html += '<h4 class="wk-day">' + esc(dayTitle(dd * 86400)) + '</h4><ul class="evs">'; }
      html += '<li class="ev' + (e.info ? " info" : "") + (e.skip ? " skip" : "") + (e.warn ? " warn" : "") + '">' +
        '<span class="ev-when"><b>' + hmIn(e.t, L.tz) + "</b></span>" +
        '<span class="ev-act ' + (e.info ? "" : e.on ? "on" : "off") + '">' + (e.info ? "" : e.on ? "On" : "Off") + "</span>" +
        '<span class="ev-why">' + esc(e.why) + "</span></li>";
    });
    if (day !== null) html += "</ul>";
    html += '<p class="hint">Fixed-time schedules are listed only when they fall on Shabbos or Yom Tov.</p>';
    out.innerHTML = html;
  }).catch(function (e) { out.innerHTML = '<p class="empty">' + esc(e.message) + "</p>"; });
}
function dayTitle(w) { var d = new Date(w * 1000); return DL[d.getUTCDay()] + " " + d.getUTCDate() + " " + ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()]; }

// ------------------------------------------------------------------ device list editor
var DE = null;
function dlist() {
  if (DE === null) DE = DEVS.map(function (d) {
    var nm = d.base ? (d.dname || "") : (DEVS[0].dname || "");
    return { ip: d.ip || "", oip: d.ip || "", mac: d.mac || "", name: nm, orig: nm, self: !d.base };
  });
  $("dvl").innerHTML = DE.map(function (e, i) {
    return '<li class="dv"><input aria-label="Name" placeholder="Name" value="' + esc(e.name) + '" oninput="DE[' + i + '].name=this.value">' +
      (e.self ? '<span class="dv-self">This device</span>' :
        '<input aria-label="IP address" placeholder="IP address" inputmode="decimal" value="' + esc(e.ip) + '" oninput="DE[' + i + '].ip=this.value.trim()">' +
        '<button onclick="ddel(' + i + ')">Remove</button>') + "</li>";
  }).join("");
}
function dadd() { if (DE === null) dlist(); DE.push({ ip: "", oip: "", mac: "", name: "", orig: "", self: false }); dlist(); }
function ddel(i) { DE.splice(i, 1); dlist(); }
function dsave() {
  var ips = [], bad = null;
  DE.forEach(function (e) { if (e.self) return; if (!/^[A-Za-z0-9.\-]+(:\d+)?$/.test(e.ip)) bad = e.ip || "(empty)"; else ips.push(e.ip + (e.mac && e.ip === e.oip ? "#" + e.mac : "")); });
  if (bad) { $("dmsg").textContent = "Not a valid IP address: " + bad; return; }
  if (DE.some(function (e) { return e.name.length > 40; })) { $("dmsg").textContent = "Names can be up to 40 characters"; return; }
  $("dmsg").textContent = "Saving";
  var errs = [], p = rpcLocal("KVS.Set", { key: "zmanim_peers", value: JSON.stringify(ips) });
  DE.forEach(function (e) {
    if (e.name === e.orig) return;
    p = p.then(function () {
      return rpcAt(e.self ? "" : "http://" + e.ip, "Sys.SetConfig", { config: { device: { name: e.name || null } } })
        .catch(function (x) { errs.push((e.name || e.ip) + ": " + x.message); });
    });
  });
  p.then(function () {
    if (errs.length) $("dmsg").textContent = "Saved the list, but couldn't rename " + errs.join("; ");
    else location.reload();
  }).catch(function (x) { $("dmsg").textContent = "Failed: " + x.message; });
}

// ------------------------------------------------------------------ page
document.getElementById("app").outerHTML =
'<main>' +
  '<section class="hero" id="hero" aria-live="polite"><p class="hero-wait">Loading zmanim</p></section>' +
  '<section aria-label="Devices"><div id="cards" class="cards"></div></section>' +
  '<section class="detail" id="detail" hidden>' +
    '<div class="det-bar" id="det-bar"><span class="lamp"></span><h2 id="det-name"></h2><span class="dev-state" id="det-state"></span>' +
      '<button class="det-close" onclick="pick(DEVS.indexOf(SEL))">Close</button></div>' +
    '<div class="grid">' +
      '<div class="panel"><h3>Coming up</h3><ul id="up" class="evs"></ul></div>' +
      '<div class="panel"><div class="ph"><h3>Recent switching</h3><button class="ph-btn" onclick="hclear()">Clear</button></div><ul id="hist" class="evs"></ul></div>' +
    '</div>' +
    '<div class="panel"><h3>Schedules</h3><ul id="sl" class="schs"></ul>' +
      '<div class="form" id="sform"><h4 id="sft">Add a schedule</h4>' +
        '<label>When<select id="stg" onchange="sform()"><option value="0">At a fixed time</option><option value="1">At candle lighting</option><option value="2">At havdalah</option></select></label>' +
        '<div id="fx"><label>Time<input type="time" id="stm" value="07:00"></label><div class="days" id="days" role="group" aria-label="Days"></div>' +
          '<label class="check"><input type="checkbox" id="ssk">Skip on Shabbos and Yom Tov</label></div>' +
        '<div id="zm" hidden><label>Timing<span class="pair"><select id="sof" onchange="sform()"><option value="0">At the time</option><option value="-1">Minutes before</option><option value="1">Minutes after</option></select>' +
          '<input type="number" id="smn" min="1" max="180" value="10" aria-label="Minutes"></span></label>' +
          '<label>Applies to<select id="sfl"></select></label></div>' +
        '<label>Action<select id="sac"><option value="on">Turn on</option><option value="off">Turn off</option></select></label>' +
        '<div class="row"><button class="primary" onclick="ssave()">Save schedule</button><button onclick="sreset();msg(\'\')">Clear</button></div>' +
        '<p class="note" id="smsg" aria-live="polite"></p></div></div>' +
  '</section>' +
  '<details class="manage fold" id="zset"><summary>Zmanim settings <span class="sum-note" id="zsum"></span></summary>' +
    '<p class="hint">For all devices. What each device does at candle lighting and havdalah is set in its own Schedules.</p>' +
    '<label>Location<select id="zl" onchange="zchanged()"></select></label><p class="note" id="zlmsg"></p>' +
    '<label>Candle lighting, minutes before sunset<input type="number" id="zc" min="0" max="60" oninput="zchanged()"></label>' +
    '<label>Havdalah<select id="zhm" onchange="zhv();zchanged()"><option value="0">Geonim</option><option value="1">Rabbeinu Tam</option></select></label>' +
    '<label>Geonim<select id="zg" onchange="zchanged()"><option value="0">Nightfall, sun 8.5&deg; below</option><option value="1">Nightfall, sun 7.08&deg; below</option><option value="2">Nightfall, sun 6&deg; below</option><option value="42">42 minutes after sunset</option><option value="50">50 minutes after sunset</option><option value="60">60 minutes after sunset</option></select></label>' +
    '<label id="zrtl">Rabbeinu Tam<select id="zrt" onchange="zchanged()"><option value="72">72 minutes after sunset</option><option value="90">90 minutes after sunset</option></select></label>' +
    '<p class="hint">Rabbeinu Tam is never less than 8 minutes after the Geonim time. Sunset and candle lighting drop the seconds; havdalah up to 24 seconds past the minute uses that minute, otherwise the next.</p>' +
    '<p class="warn" id="zwarn" hidden></p>' +
    '<div class="row"><button class="primary" onclick="zsave()">Save for all devices</button></div><p class="note" id="zmsg" aria-live="polite"></p>' +
    '<details class="sub" id="zadd"><summary>Add a location</summary>' +
      '<p class="hint">In Google Maps, right-click the spot (on a phone, press and hold). The numbers that appear are the coordinates; click them to copy.</p>' +
      '<label>Name<input id="zn" maxlength="40" placeholder="Site office"></label>' +
      '<label>Coordinates<input id="zco" placeholder="51.5484, 0.1716" inputmode="decimal"></label>' +
      '<div class="row"><button class="primary" id="zgo" onclick="zprep()">Next</button></div><p class="note" id="zamsg" aria-live="polite"></p>' +
      '<div id="zsteps" hidden><ol class="steps">' +
        '<li>Copy the updated list of locations.<textarea id="zjson" rows="4" readonly aria-label="Updated locations.json"></textarea><div class="row"><button onclick="zcopy()">Copy</button></div></li>' +
        '<li><a id="zgh" target="_blank" rel="noopener">Open locations.json on GitHub</a>, select everything in it, paste, and press <b>Commit changes</b>.</li>' +
        '<li>Come back here. GitHub makes the times file in about a minute; this page checks, then selects the new location. Press <b>Save for all devices</b>.</li>' +
      '</ol></div><p class="note" id="zpoll" aria-live="polite"></p>' +
      '<div class="tok"><h4>Add locations automatically</h4>' +
        '<div id="ztok-new"><p class="hint">With a GitHub token this page commits the new location itself; without one you paste it on GitHub by hand. The token is kept only in this browser.</p>' +
          '<label>GitHub token<input type="password" id="ztok" autocomplete="off" spellcheck="false" placeholder="github_pat_..."></label>' +
          '<div class="row"><button onclick="tokSave()">Save token</button></div></div>' +
        '<div id="ztok-set" hidden><p class="hint">This browser has a GitHub token, so new locations are committed automatically.</p><div class="row"><button onclick="tokForget()">Forget token</button></div></div>' +
        '<p class="note" id="ztmsg" aria-live="polite"></p></div>' +
    '</details>' +
  '</details>' +
  '<details class="manage fold" id="zweek" ontoggle="if(this.open)wk(0)"><summary>Check a week</summary>' +
    '<p class="hint">The zmanim for any week with the settings above, saved or not, and what each device will do.</p>' +
    '<div class="wk-bar"><button onclick="wk(-7)">&minus; week</button><input type="date" id="zwd" onchange="wk(0)" aria-label="Date in the week"><button onclick="wk(7)">+ week</button><button onclick="wkToday()">This week</button></div>' +
    '<div id="zwk" aria-live="polite"></div>' +
  '</details>' +
  '<details class="manage" id="manage" ontoggle="if(this.open){DE=null;dlist();}"><summary>Manage devices</summary>' +
    '<p class="hint">The devices shown on this page. Names are each device\'s own name.</p>' +
    '<ul id="dvl" class="dvl"></ul>' +
    '<div class="row"><button onclick="dadd()">Add device</button><button class="primary" onclick="dsave()">Save devices</button></div>' +
    '<p class="note" id="dmsg" aria-live="polite"></p></details>' +
'</main>';
(function () {
  var h = ""; for (var i = 0; i < 7; i++) h += '<label id="dl' + i + '"><input type="checkbox" id="d' + i + '" onchange="dsty()">' + DN[i] + "</label>";
  $("days").innerHTML = h;
  sform();
})();

document.title = "Zmanim";
cards();
setTZ((function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })());   // until the device says
rpcLocal("Sys.GetConfig").then(function (c) { if (c && c.location && c.location.tz) { setTZ(c.location.tz); DEVS.forEach(function (d) { if (d.sum) render(d); }); } }).catch(function () {});
zlocs(); loadLocs(); tokShow();
rpcLocal("Shelly.GetDeviceInfo").then(function (i) { DEVS[0].dname = i.name || ""; DEVS[0].name = i.name || i.id || DEVS[0].name; cards(); }).catch(function () {})
  .then(function () { return refreshDev(DEVS[0], true); })
  .then(function () { return rpcLocal("KVS.Get", { key: "zmanim_peers" }).then(function (r) { return JSON.parse(r.value); }).catch(function () { return window.PEERS || []; }); })
  .then(function (ips) { var p = loadPeers(ips); if (!$("manage").open) { DE = null; dlist(); } return p; })
  .then(function () { if (!$("manage").open) { DE = null; dlist(); } });
// keep status current: one device at a time, every 15 s
setInterval(function () {
  DEVS.reduce(function (p, d) { return p.then(function () { return d.dead ? null : refreshDev(d); }); }, Promise.resolve());
}, 15000);
