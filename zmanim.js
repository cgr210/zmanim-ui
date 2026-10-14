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
function local(t, off) { return new Date((t + off) * 1000); }        // read with getUTC* = device local time
function hm(t, off) { var d = local(t, off); return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()); }
function dayLabel(t, ref, off) {                                     // "Today", "Tomorrow", "Friday", "Fri 23/10"
  var a = Math.floor((t + off) / 86400), b = Math.floor((ref + off) / 86400), d = local(t, off);
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
    var sec = +j.t.slice(0, 2) * 3600 + +j.t.slice(3) * 60, day0 = Math.floor((s.ts + s.off) / 86400);
    for (var k = 0; k <= 7; k++) {
      var day = day0 + k; if (j.d.indexOf((day + 4) % 7) < 0) continue;
      var t = day * 86400 + sec - s.off; if (t <= s.ts || t > end) continue;
      var skip = (d.sk || []).indexOf(j.id) >= 0 && win.some(function (w) { return t >= w[0] && t < w[1]; });
      list.push({ t: t, on: j.a, why: skip ? "Schedule, skipped for Shabbos/Yom Tov" : "Schedule", kind: 0, skip: skip });
    }
  });
  // hide a zman's information line when a zman schedule already switches near it
  list = list.filter(function (e) {
    if (e.on !== null || !e.kind) return true;
    var name = e.kind === 1 ? "Candle lighting" : "Havdalah";
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
function render(d) { hero(); cards(); if (d === SEL) details(); }

// the next candle lighting / havdalah, from this device's times
function hero() {
  var s = DEVS[0].sum, el = $("hero");
  if (!s || s.ts === undefined) { el.innerHTML = '<p class="hero-wait">Loading zmanim</p>'; return; }
  var seen = {}, zs = [];                       // one entry per zman (the script's info markers)
  s.next.forEach(function (e) { if ((e[4] === 1 || e[4] === 2) && e[1] === null && !seen[e[3]]) { seen[e[3]] = 1; zs.push(e); } });
  if (!zs.length) { el.innerHTML = '<p class="hero-wait">' + esc(statusNote(s) || "No candle lighting or havdalah in the next week") + "</p>"; return; }
  function name(e) { return e[4] === 1 ? "Candle lighting" : "Havdalah"; }
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
  ED = null; FILLED = false; msg(""); $("cmsg").textContent = "";
  if (SEL) sreset();
  cards(); details();
  if (SEL) { $("detail").scrollIntoView({ behavior: "smooth", block: "start" }); refreshDev(d, true); }
}

// ------------------------------------------------------------------ details of the selected device
var ED = null, FILLED = false;
function details() {
  var el = $("detail");
  if (!SEL) { el.hidden = true; return; }
  el.hidden = false;
  var d = SEL, s = d.sum;
  $("det-name").textContent = d.name;
  var up = upcoming(d);
  $("up").innerHTML = !s ? '<li class="empty">Loading</li>' : up.length ? up.map(function (e) {
    return '<li class="ev' + (e.skip ? " skip" : "") + (e.on === null ? " info" : "") + '">' +
      '<span class="ev-when">' + esc(dayLabel(e.t, s.ts, s.off)) + "<b>" + hm(e.t, s.off) + "</b></span>" +
      '<span class="ev-act ' + (e.on === null ? "" : e.on ? "on" : "off") + '">' + (e.on === null ? "" : e.on ? "On" : "Off") + "</span>" +
      '<span class="ev-why">' + esc(e.why) + "</span></li>";
  }).join("") : '<li class="empty">Nothing in the next 7 days</li>';
  $("hist").innerHTML = !s ? "" : s.hist.length ? s.hist.map(function (e) {
    var p = String(e[0]).split(" ");           // "Fri 09/10 18:25"
    return '<li class="ev"><span class="ev-when">' + esc(p[0] + " " + (p[1] || "")) + "<b>" + esc(p[2] || "") + '</b></span><span class="ev-act ' + (e[1] ? "on" : "off") + '">' + (e[1] ? "On" : "Off") + '</span><span class="ev-why">' + esc(e[2]) + "</span></li>";
  }).join("") : '<li class="empty">No switching recorded yet</li>';
  slist();
  if (s && !FILLED && s.cfg) { $("c").value = s.cfg.c; $("h").value = s.cfg.h; FILLED = true; }
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

// ---- zmanim settings (per device)
function save() {
  var d = SEL;
  $("cmsg").textContent = "Saving";
  core(d, "set=1&c=" + $("c").value + "&h=" + $("h").value + "&il=0&ps=1").then(function (s) {
    $("cmsg").textContent = /^Saved/.test(s.msg || "Saved") ? "Saved. Times are being recalculated." : s.msg;
    setTimeout(function () { refreshDev(d); }, 2500);
  }).catch(function (e) { $("cmsg").textContent = "Failed: " + e.message; });
}

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
function dadd() { DE.push({ ip: "", oip: "", mac: "", name: "", orig: "", self: false }); dlist(); }
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
    '<h2 id="det-name"></h2>' +
    '<div class="grid">' +
      '<div class="panel"><h3>Coming up</h3><ul id="up" class="evs"></ul></div>' +
      '<div class="panel"><h3>Recent switching</h3><ul id="hist" class="evs"></ul></div>' +
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
    '<div class="panel"><h3>Zmanim settings</h3>' +
      '<p class="hint">When candle lighting and havdalah are for this device. What happens at those times is set in Schedules.</p>' +
      '<label>Candle lighting, minutes before sunset<input type="number" id="c" min="0" max="60"></label>' +
      '<label>Havdalah<select id="h"><option value="0">Nightfall (8.5&deg;)</option><option value="42">42 minutes after sunset</option><option value="50">50 minutes after sunset</option><option value="60">60 minutes after sunset</option><option value="72">72 minutes after sunset (Rabbeinu Tam)</option></select></label>' +
      '<div class="row"><button class="primary" onclick="save()">Save settings</button></div><p class="note" id="cmsg" aria-live="polite"></p></div>' +
  '</section>' +
  '<details class="manage"><summary>Manage devices</summary>' +
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
rpcLocal("Shelly.GetDeviceInfo").then(function (i) { DEVS[0].dname = i.name || ""; DEVS[0].name = i.name || i.id || DEVS[0].name; cards(); }).catch(function () {})
  .then(function () { return refreshDev(DEVS[0], true); })
  .then(function () { return rpcLocal("KVS.Get", { key: "zmanim_peers" }).then(function (r) { return JSON.parse(r.value); }).catch(function () { return window.PEERS || []; }); })
  .then(function (ips) { return loadPeers(ips); })
  .then(function () { dlist(); });
// keep status current: one device at a time, every 15 s
setInterval(function () {
  DEVS.reduce(function (p, d) { return p.then(function () { return d.dead ? null : refreshDev(d); }); }, Promise.resolve());
}, 15000);
