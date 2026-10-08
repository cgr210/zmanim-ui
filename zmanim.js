/* Zmanim relay page - loaded by the Shelly core script (CORE = its script id, SW = switch id) */
(function () {
var BODY = "<div class=\"c\"><h1>Zmanim relay</h1><div class=\"mu\" id=\"now\"></div><div class=\"st\" id=\"st\">...</div><div class=\"row\"><button class=\"bon\" onclick=\"go(&quot;cmd=on&quot;)\">ON</button><button class=\"boff\" onclick=\"go(&quot;cmd=off&quot;)\">OFF</button></div><div class=\"mu\" style=\"margin-top:8px\">Manual switching holds until the next scheduled event.</div></div><div class=\"c\"><h2>Next</h2><div id=\"nx\"></div></div><div class=\"c\"><h2>History</h2><div id=\"hs\"></div></div><div class=\"c\"><h2>Schedules</h2><div id=\"sl\"></div><div class=\"sf\"><h3 id=\"sft\">Add schedule</h3><label>Trigger<select id=\"stg\" onchange=\"sform()\"><option value=\"0\">Fixed time</option><option value=\"1\">Candle lighting</option><option value=\"2\">Havdalah</option></select></label><div id=\"fx\"><label>Time<input type=\"time\" id=\"stm\" value=\"07:00\"></label><div class=\"dy\" id=\"sdy\"></div></div><div id=\"zm\"><label>Timing<span><select id=\"sof\" onchange=\"sform()\"><option value=\"0\">At the time</option><option value=\"-1\">Minutes before</option><option value=\"1\">Minutes after</option></select> <input type=\"number\" id=\"smn\" min=\"1\" max=\"180\" value=\"10\"></span></label><label>Applies to<select id=\"sfl\"></select></label></div><label>Action<select id=\"sac\"><option value=\"on\">Switch ON</option><option value=\"off\">Switch OFF</option></select></label><div class=\"row\"><button onclick=\"ssave()\">Save schedule</button><button onclick=\"sreset()\">Clear</button></div><div class=\"mu\" id=\"smsg\" style=\"margin-top:8px\"></div></div></div><div class=\"c\"><h2>Devices on this page</h2><div id=\"dvl\"></div><div class=\"row\"><button onclick=\"dadd()\">Add device</button><button onclick=\"dsave()\">Save devices</button></div><div class=\"mu\" id=\"dmsg\" style=\"margin-top:8px\"></div></div><div class=\"c\"><h2>Settings</h2><div class=\"mu\" style=\"margin-bottom:6px\">Defines when candle lighting and havdalah are. What happens then is set in Schedules.</div><label>Candle lighting (min before sunset)<input type=\"number\" id=\"c\" min=\"0\" max=\"60\"></label><label>Havdalah<select id=\"h\"><option value=\"0\">Tzeit 8.5&deg;</option><option value=\"42\">42 min</option><option value=\"50\">50 min</option><option value=\"60\">60 min</option><option value=\"72\">72 min (Rabbeinu Tam)</option></select></label><label>Israel (1-day Yom Tov)<input type=\"checkbox\" id=\"il\"></label><label>Pause app schedules on Shabbos/YT<input type=\"checkbox\" id=\"ps\"></label><div class=\"row\"><button onclick=\"save()\">Save settings</button></div><div class=\"mu\" id=\"msg\" style=\"margin-top:8px\"></div></div><div class=\"row\"><button onclick=\"go(&quot;cmd=refresh&quot;)\">Reload times from Hebcal</button></div>";
document.getElementById("app").outerHTML = "<main>" + BODY + "</main>";
})();

// ---- devices: this Shelly + PEERS (other Shellys running the same script) ----
var DEVS = [{ base: "", core: CORE, sw: SW, name: window.NM || "This device" }], D = DEVS[0];
document.querySelector("main").insertAdjacentHTML("afterbegin", '<div class="tabs" id="tabs"></div>');
function tabs() {
  if (DEVS.length < 2) { $("tabs").style.display = "none"; return; }
  $("tabs").style.display = "";
  $("tabs").innerHTML = DEVS.map(function (d, i) {
    return '<button class="' + (d === D ? "act" : "") + (d.err ? " terr" : "") + '" onclick="pick(' + i + ')">' + esc(d.name) + "</button>";
  }).join("");
}
function pick(i) {
  var d = DEVS[i];
  if (d.err) { $("now").textContent = d.name + ": " + d.err; return; }
  D = d; filled = false; SJ = []; PZ = []; LD = null; RJ = [];
  document.title = D.name; document.querySelector("h1").textContent = D.name;
  $("nx").innerHTML = $("hs").innerHTML = $("sl").innerHTML = ""; $("msg").textContent = $("smsg").textContent = "";
  sreset(); tabs(); go(); sreq();
}
// this device: call its RPC directly. Other devices: relay through this Shelly's
// built-in HTTP.Request (avoids browser cross-origin blocking; uses no script memory)
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
// find the zmanim script on a peer: the running script that defines webCmd
// one request at a time per device: the main Shelly relays every request, and limits how many it handles at once
function addPeer(ip) {
  var d = { base: "http://" + ip, ip: ip, name: ip }; DEVS.push(d); tabs();
  return rpcAt(d.base, "Shelly.GetDeviceInfo").then(function (i) { d.dname = i.name || ""; d.name = i.name || i.id || ip; tabs(); })
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
      if (id === null) throw new Error("zmanim script not running");
      d.core = id;
      return evalAt(d.base, id, "CFG.switchId").then(function (sw) { d.sw = +sw || 0; });
    })
    .catch(function (e) { d.err = e.message || "not reachable"; })
    .then(tabs);
}
function loadPeers(ips) { return ips.reduce(function (p, ip) { return p.then(function () { return addPeer(ip); }); }, Promise.resolve()); }

// ---- device list editor (list of IPs saved on this Shelly in KVS "zmanim_peers"; names are each Shelly's own device name) ----
var DE = null;
function dlist() {
  if (DE === null) DE = DEVS.map(function (d) { return { ip: d.ip || "", name: d.base ? (d.dname || "") : (DEVS[0].dname || ""), self: !d.base, orig: d.base ? (d.dname || "") : (DEVS[0].dname || "") }; });
  $("dvl").innerHTML = DE.map(function (e, i) {
    return '<div class="dv"><input placeholder="Name" value="' + esc(e.name) + '" oninput="DE[' + i + '].name=this.value">' +
      (e.self ? '<span class="mu dvs">this device</span>' : '<input placeholder="IP address" value="' + esc(e.ip) + '" oninput="DE[' + i + '].ip=this.value.trim()"><button onclick="ddel(' + i + ')">&times;</button>') + "</div>";
  }).join("");
}
function dadd() { DE.push({ ip: "", name: "", self: false, orig: "" }); dlist(); }
function ddel(i) { DE.splice(i, 1); dlist(); }
function dsave() {
  var ips = [], bad = null;
  DE.forEach(function (e) { if (e.self) return; if (!/^[A-Za-z0-9.\-]+(:\d+)?$/.test(e.ip)) bad = e.ip || "(empty)"; else ips.push(e.ip); });
  if (bad) { $("dmsg").textContent = "Invalid IP address: " + bad; return; }
  if (DE.some(function (e) { return e.name.length > 40; })) { $("dmsg").textContent = "Names must be 40 characters or less"; return; }
  $("dmsg").textContent = "Saving...";
  var errs = [], p = rpcLocal("KVS.Set", { key: "zmanim_peers", value: JSON.stringify(ips) });
  DE.forEach(function (e) {
    if (e.name === e.orig) return;
    p = p.then(function () {
      return rpcAt(e.self ? "" : "http://" + e.ip, "Sys.SetConfig", { config: { device: { name: e.name || null } } })
        .catch(function (x) { errs.push((e.name || e.ip) + ": " + x.message); });
    });
  });
  p.then(function () {
    if (errs.length) $("dmsg").textContent = "Saved list, but could not rename " + errs.join("; ");
    else location.reload();
  }).catch(function (x) { $("dmsg").textContent = "Failed: " + x.message; });
}

var filled = false, DN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], SD = ["SUN","MON","TUE","WED","THU","FRI","SAT"], ED = null, PZ = [], SJ = [];
function $(i) { return document.getElementById(i); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }

// Shelly JSON-RPC over HTTP (same origin as this page)
function rpc(method, params) { return rpcAt(D.base, method, params); }
function core(q) {
  var d = D;
  return evalAt(d.base, d.core, "webCmd(" + JSON.stringify(q || "") + ")")
    .then(function (v) { if (d !== D) throw new Error("switched"); return typeof v === "string" ? JSON.parse(v) : v; });
}

// ---- status / next / history / settings ----
function row(e) {
  var k = e[1] === null ? "pna" : (e[1] ? "pon" : "poff"), a = e[1] === null ? "&ndash;" : (e[1] ? "ON" : "OFF");
  return '<div class="e' + (e[5] ? " dis" : "") + '"><span class="t">' + esc(e[0]) + '</span><span class="p ' + k + '">' + a + "</span><span>" + esc(e[2]) + "</span></div>";
}
// ---- Next: zmanim events + the device's own schedules for the coming 7 days ----
var LD = null;
function fmtT(t, off) {
  var d = new Date((t + off) * 1000), p = function (x) { return (x < 10 ? "0" : "") + x; };
  return DN[d.getUTCDay()] + " " + p(d.getUTCDate()) + "/" + p(d.getUTCMonth() + 1) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
function renderNext() {
  if (!LD) return;
  var d = LD;
  if (d.ts === undefined) { $("nx").innerHTML = d.next.map(row).join("") || '<div class="mu">none loaded</div>'; return; }
  var list = d.next.slice(), end = d.ts + 7 * 86400;
  // Shabbos/YT windows (schedules are paused inside them when that setting is on)
  var win = [], st = d.holy ? d.ts : null;
  d.next.forEach(function (e) { if (e[4] === 1 && st === null) st = e[3]; else if (e[4] === 2 && st !== null) { win.push([st, e[3]]); st = null; } });
  if (st !== null) win.push([st, Infinity]);
  var ps = d.cfg && d.cfg.ps;
  SJ.forEach(function (s) {
    if (!s.t || s.a === null || !(s.en || PZ.indexOf(s.id) >= 0)) return;
    var hm = +s.t.slice(0, 2) * 3600 + +s.t.slice(3) * 60, day0 = Math.floor((d.ts + d.off) / 86400);
    for (var k = 0; k <= 7; k++) {
      var day = day0 + k; if (s.d.indexOf((day + 4) % 7) < 0) continue;
      var t = day * 86400 + hm - d.off; if (t <= d.ts || t > end) continue;
      var skip = ps && win.some(function (w) { return t >= w[0] && t < w[1]; });
      list.push([fmtT(t, d.off), s.a, skip ? "Schedule - skipped (Shabbos/YT)" : "Schedule", t, 0, skip]);
    }
  });
  list.sort(function (a, b) { return a[3] - b[3]; });
  $("nx").innerHTML = list.map(row).join("") || '<div class="mu">none loaded</div>';
}
function show(d) {
  $("now").textContent = d.now;
  var s = $("st"); s.textContent = d.relay ? "ON" : "OFF"; s.style.color = d.relay ? "var(--on)" : "var(--off)";
  LD = d; renderNext();
  $("hs").innerHTML = d.hist.map(row).join("") || '<div class="mu">none yet</div>';
  if (!filled && d.cfg) {
    var c = d.cfg;
    $("c").value = c.c; $("h").value = c.h; $("il").checked = c.il; $("ps").checked = c.ps; filled = true;
  }
  if (d.msg) $("msg").textContent = d.msg;
  PZ = d.paused || [];
  slist(SJ);
}
function go(q) {
  core(q).then(show).catch(function (e) { if (e.message !== "switched") $("now").textContent = "Zmanim script not reachable: " + e.message; });
  if (q) setTimeout(function () { go(); sreq(); }, 3000);
}
function save() {
  go("set=1&c=" + $("c").value + "&h=" + $("h").value + "&il=" + ($("il").checked ? 1 : 0) + "&ps=" + ($("ps").checked ? 1 : 0));
}

// ---- schedules (Shelly's own Schedule component, called directly) ----
function dayIdx(s) { var i = SD.indexOf(String(s).toUpperCase()); if (i >= 0) return i; var n = parseInt(s, 10); return n >= 0 && n <= 7 && String(n) === s ? n % 7 : -1; }
function parseSpec(ts) {
  var p = String(ts).trim().split(/\s+/);
  if (p.length !== 6 || p[0] !== "0" || p[3] !== "*" || p[4] !== "*") return null;
  var mi = +p[1], hr = +p[2];
  if (!/^\d+$/.test(p[1]) || !/^\d+$/.test(p[2]) || mi > 59 || hr > 23) return null;
  var d = [];
  if (p[5] === "*") d = [0,1,2,3,4,5,6];
  else {
    var items = p[5].split(",");
    for (var i = 0; i < items.length; i++) {
      var r = items[i].split("-");
      if (r.length === 2) {
        var a = dayIdx(r[0]), b = dayIdx(r[1]); if (a < 0 || b < 0) return null;
        for (var k = a, g = 0; g < 7; g++) { d.push(k); if (k === b) break; k = (k + 1) % 7; }
      } else { var k2 = dayIdx(items[i]); if (k2 < 0) return null; d.push(k2); }
    }
    d = [0,1,2,3,4,5,6].filter(function (x) { return d.indexOf(x) >= 0; });
  }
  return { t: (hr < 10 ? "0" : "") + hr + ":" + (mi < 10 ? "0" : "") + mi, d: d };
}
function jobAction(j) {
  if (!j.calls || j.calls.length !== 1) return null;
  var c = j.calls[0];
  if (!c.method || c.method.toLowerCase() !== "switch.set" || !c.params) return null;
  return c.params.on === true ? true : (c.params.on === false ? false : null);
}
// ---- zman schedules (run by the script; saved on the device in KVS "zmanim_rules") ----
// rule = [type 1=candle 2=havdalah, offset min, on 1/0, filter 0=all 1=Shabbos 2=YT 3=first night, enabled 1/0]
var RJ = [], FL = ["Every time", "Shabbos only", "Yom Tov only", "First night only"];
function rload() {
  var d = D;
  return rpc("KVS.Get", { key: "zmanim_rules" }).then(function (r) { return JSON.parse(r.value); }).catch(function () { return []; })
    .then(function (x) { if (d === D) { RJ = x; slist(SJ); } });
}
function rsave() {
  var v = JSON.stringify(RJ);
  if (v.length > 250) { $("smsg").textContent = "Too many zman schedules for the device's storage"; return Promise.reject(new Error("too many")); }
  return rpc("KVS.Set", { key: "zmanim_rules", value: v }).then(function () { return core("cmd=refresh"); })
    .then(function () { setTimeout(function () { go(); }, 3000); });
}
function rtxt(r) {
  return (r[0] === 1 ? "Candle lighting" : "Havdalah") + (r[1] ? " " + Math.abs(r[1]) + " min " + (r[1] < 0 ? "before" : "after") : "") +
    (r[3] ? " &middot; " + FL[r[3]] : "");
}
function sform() {
  var tg = +$("stg").value, z = tg > 0;
  $("fx").style.display = z ? "none" : ""; $("zm").style.display = z ? "" : "none";
  $("smn").style.display = $("sof").value === "0" ? "none" : "";
  var opts = tg === 2 ? FL.slice(0, 3) : FL, cur = $("sfl").value;
  $("sfl").innerHTML = opts.map(function (t, i) { return '<option value="' + i + '">' + t + "</option>"; }).join("");
  if (cur && +cur < opts.length) $("sfl").value = cur;
}

function sreq() {
  var d = D;
  rload();
  return rpc("Schedule.List").then(function (r) {
    if (d !== D) return;
    SJ = (r.jobs || []).map(function (j) { var ps = parseSpec(j.timespec || ""); return { id: j.id, en: !!j.enable, t: ps && ps.t, d: ps && ps.d, a: jobAction(j), ts: j.timespec }; });
    slist(SJ);
  }).catch(function (e) { $("smsg").textContent = "Could not read schedules: " + e.message; });
}
function dtxt(d) { return d.length === 7 ? "Every day" : d.map(function (x) { return DN[x]; }).join(" "); }
function slist(j) {
  var h = "";
  j.forEach(function (s, i) {
    var p = PZ.indexOf(s.id) >= 0;
    h += '<div class="sr' + (s.en || p ? "" : " dis") + '"><span class="x"><b>' + (s.t || "custom") + "</b> " +
      (s.a === null ? "" : '<span class="' + (s.a ? "pon" : "poff") + '">' + (s.a ? "ON" : "OFF") + "</span> ") +
      (s.t ? dtxt(s.d) : esc(s.ts)) + (p ? ' <span class="tag">paused for Shabbos/YT</span>' : "") + "</span>" +
      '<button onclick="sen(' + i + ')">' + (s.en || p ? "Disable" : "Enable") + "</button>" +
      (s.t ? '<button onclick="sedit(' + i + ')">Edit</button>' : "") + '<button onclick="sdel(' + i + ')">&times;</button></div>';
  });
  RJ.forEach(function (r, i) {
    h += '<div class="sr' + (r[4] ? "" : " dis") + '"><span class="x"><b>' + rtxt(r) + "</b> " +
      '<span class="' + (r[2] ? "pon" : "poff") + '">' + (r[2] ? "ON" : "OFF") + "</span></span>" +
      '<button onclick="ren(' + i + ')">' + (r[4] ? "Disable" : "Enable") + '</button><button onclick="redit(' + i + ')">Edit</button><button onclick="rdel(' + i + ')">&times;</button></div>';
  });
  $("sl").innerHTML = h || '<div class="mu">No schedules</div>';
  renderNext();
}
function sdo(p) { $("smsg").textContent = ""; return p.then(sreq).catch(function (e) { $("smsg").textContent = "Failed: " + e.message; throw e; }); }
function sen(i) {
  var s = SJ[i];
  if (PZ.indexOf(s.id) >= 0) { $("smsg").textContent = "Paused for Shabbos/YT - it will resume at havdalah"; return; }
  sdo(rpc("Schedule.Update", { id: s.id, enable: !s.en }));
}
function sdel(i) { if (confirm("Delete this schedule?")) sdo(rpc("Schedule.Delete", { id: SJ[i].id })).then(sreset); }
function sedit(i) {
  var s = SJ[i]; ED = s.id; $("sft").textContent = "Edit schedule"; $("stg").value = "0"; sform(); $("stm").value = s.t;
  for (var k = 0; k < 7; k++) $("d" + k).checked = s.d.indexOf(k) >= 0;
  dsty(); $("sac").value = s.a ? "on" : "off"; $("smsg").textContent = "";
}
function rdo(f) { $("smsg").textContent = ""; f(); return rsave().then(function () { slist(SJ); }).catch(function (e) { $("smsg").textContent = "Failed: " + e.message; return rload(); }); }
function ren(i) { rdo(function () { RJ[i][4] = RJ[i][4] ? 0 : 1; }); }
function rdel(i) { if (confirm("Delete this schedule?")) rdo(function () { RJ.splice(i, 1); }).then(sreset); }
function redit(i) {
  var r = RJ[i]; ED = "r" + i; $("sft").textContent = "Edit schedule";
  $("stg").value = r[0]; $("sof").value = r[1] < 0 ? "-1" : (r[1] > 0 ? "1" : "0"); $("smn").value = Math.abs(r[1]) || 10;
  sform(); $("sfl").value = r[3]; $("sac").value = r[2] ? "on" : "off"; $("smsg").textContent = "";
}
function sreset() { ED = null; $("stg").value = "0"; $("sof").value = "0"; sform(); $("sft").textContent = "Add schedule"; for (var k = 0; k < 7; k++) $("d" + k).checked = false; dsty(); }
function dsty() { for (var i = 0; i < 7; i++) $("dl" + i).className = $("d" + i).checked ? "on" : ""; }
function ssave() {
  var tg = +$("stg").value;
  if (tg > 0) {
    var sg = +$("sof").value, mn = Math.round(+$("smn").value);
    if (sg !== 0 && !(mn >= 1 && mn <= 180)) { $("smsg").textContent = "Minutes must be 1-180"; return; }
    var r = [tg, sg * (sg ? mn : 0), $("sac").value === "on" ? 1 : 0, +$("sfl").value, 1];
    if (typeof ED === "string") { var i = +ED.slice(1); r[4] = RJ[i][4]; }
    if (ED !== null && typeof ED !== "string") {
      // editing a fixed-time schedule into a zman one: remove the fixed one
      var old = ED;
      rdo(function () { RJ.push(r); }).then(function () { return sdo(rpc("Schedule.Delete", { id: old })); }).then(function () { sreset(); $("smsg").textContent = "Saved"; });
      return;
    }
    rdo(function () { if (typeof ED === "string") RJ[+ED.slice(1)] = r; else RJ.push(r); }).then(function () { sreset(); $("smsg").textContent = "Saved"; });
    return;
  }
  var d = []; for (var k = 0; k < 7; k++) if ($("d" + k).checked) d.push(k);
  var t = $("stm").value;
  if (!d.length) { $("smsg").textContent = "Pick at least one day"; return; }
  if (!/^\d\d:\d\d$/.test(t)) { $("smsg").textContent = "Enter a time"; return; }
  var ts = "0 " + (+t.slice(3)) + " " + (+t.slice(0, 2)) + " * * " + (d.length === 7 ? "*" : d.map(function (x) { return SD[x]; }).join(","));
  var p = { enable: true, timespec: ts, calls: [{ method: "Switch.Set", params: { id: D.sw, on: $("sac").value === "on" } }] };
  if (typeof ED === "string") {
    // editing a zman schedule into a fixed-time one: create the fixed one, then remove the zman one
    var ri = +ED.slice(1);
    sdo(rpc("Schedule.Create", p)).then(function () { return rdo(function () { RJ.splice(ri, 1); }); }).then(function () { sreset(); $("smsg").textContent = "Saved"; });
    return;
  }
  if (ED !== null) p.id = ED;
  sdo(rpc(ED === null ? "Schedule.Create" : "Schedule.Update", p)).then(function () { sreset(); $("smsg").textContent = "Saved"; });
}

(function () {
  var h = ""; for (var i = 0; i < 7; i++) h += '<label id="dl' + i + '"><input type="checkbox" id="d' + i + '" onchange="dsty()">' + DN[i] + "</label>";
  $("sdy").innerHTML = h;
  sform();
})();
function setTitle() { document.title = DEVS[0].name; if (D === DEVS[0]) document.querySelector("h1").textContent = DEVS[0].name; }
setTitle(); tabs(); go();
rpcLocal("Shelly.GetDeviceInfo").then(function (i) { DEVS[0].dname = i.name || ""; DEVS[0].name = i.name || i.id || DEVS[0].name; setTitle(); tabs(); }).catch(function () {})
  .then(sreq)
  .then(function () { return rpcLocal("KVS.Get", { key: "zmanim_peers" }).then(function (r) { return JSON.parse(r.value); }).catch(function () { return window.PEERS || []; }); })
  .then(function (ips) { $("dvl").innerHTML = '<div class="mu">Loading devices...</div>'; return loadPeers(ips); })
  .then(dlist);
setInterval(function () { go(); }, 15000);
