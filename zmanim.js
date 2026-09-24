/* Zmanim relay page - loaded by the Shelly core script (CORE = its script id, SW = switch id) */
(function () {
var BODY = "<div class=\"c\"><h1>Zmanim relay</h1><div class=\"mu\" id=\"now\"></div><div class=\"st\" id=\"st\">...</div><div class=\"row\"><button class=\"bon\" onclick=\"go(&quot;cmd=on&quot;)\">ON</button><button class=\"boff\" onclick=\"go(&quot;cmd=off&quot;)\">OFF</button></div><div class=\"mu\" style=\"margin-top:8px\">Manual switching holds until the next scheduled event.</div></div><div class=\"c\"><h2>Next</h2><div id=\"nx\"></div></div><div class=\"c\"><h2>History</h2><div id=\"hs\"></div></div><div class=\"c\"><h2>Schedules</h2><div id=\"sl\"></div><div class=\"sf\"><h3 id=\"sft\">Add schedule</h3><label>Time<input type=\"time\" id=\"stm\" value=\"07:00\"></label><div class=\"dy\" id=\"sdy\"></div><label>Action<select id=\"sac\"><option value=\"on\">Switch ON</option><option value=\"off\">Switch OFF</option></select></label><div class=\"row\"><button onclick=\"ssave()\">Save schedule</button><button onclick=\"sreset()\">Clear</button></div><div class=\"mu\" id=\"smsg\" style=\"margin-top:8px\"></div></div></div><div class=\"c\"><h2>Settings</h2><label>At candle lighting<select id=\"sa\"><option value=\"on\">Switch ON</option><option value=\"off\">Switch OFF</option><option value=\"none\">Do nothing</option></select></label><label>At havdalah<select id=\"ea\"><option value=\"on\">Switch ON</option><option value=\"off\">Switch OFF</option><option value=\"none\">Do nothing</option></select></label><label>Candle lighting (min before sunset)<input type=\"number\" id=\"c\" min=\"0\" max=\"60\"></label><label>Havdalah<select id=\"h\"><option value=\"0\">Tzeit 8.5&deg;</option><option value=\"42\">42 min</option><option value=\"50\">50 min</option><option value=\"60\">60 min</option><option value=\"72\">72 min (Rabbeinu Tam)</option></select></label><label>Extra min at start (- = earlier)<input type=\"number\" id=\"so\" min=\"-60\" max=\"60\"></label><label>Extra min at end (+ = later)<input type=\"number\" id=\"eo\" min=\"-60\" max=\"60\"></label><label>Israel (1-day Yom Tov)<input type=\"checkbox\" id=\"il\"></label><label>Pause app schedules on Shabbos/YT<input type=\"checkbox\" id=\"ps\"></label><div class=\"row\"><button onclick=\"save()\">Save settings</button></div><div class=\"mu\" id=\"msg\" style=\"margin-top:8px\"></div></div><div class=\"row\"><button onclick=\"go(&quot;cmd=refresh&quot;)\">Reload times from Hebcal</button></div>";
document.getElementById("app").outerHTML = "<main>" + BODY + "</main>";
})();

var filled = false, DN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], SD = ["SUN","MON","TUE","WED","THU","FRI","SAT"], ED = null, PZ = [], SJ = [];
function $(i) { return document.getElementById(i); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }

// Shelly JSON-RPC over HTTP (same origin as this page)
function rpc(method, params) {
  return fetch("/rpc", { method: "POST", body: JSON.stringify({ id: 1, method: method, params: params || {} }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j.error) throw new Error(j.error.message || "RPC error"); return j.result; });
}
function core(q) {
  return rpc("Script.Eval", { id: CORE, code: "webCmd(" + JSON.stringify(q || "") + ")" })
    .then(function (r) { var v = r && r.result !== undefined ? r.result : r; return typeof v === "string" ? JSON.parse(v) : v; });
}

// ---- status / next / history / settings ----
function row(e) {
  var k = e[1] === null ? "pna" : (e[1] ? "pon" : "poff"), a = e[1] === null ? "&ndash;" : (e[1] ? "ON" : "OFF");
  return '<div class="e"><span class="t">' + esc(e[0]) + '</span><span class="p ' + k + '">' + a + "</span><span>" + esc(e[2]) + "</span></div>";
}
function show(d) {
  $("now").textContent = d.now;
  var s = $("st"); s.textContent = d.relay ? "ON" : "OFF"; s.style.color = d.relay ? "var(--on)" : "var(--off)";
  $("nx").innerHTML = d.next.map(row).join("") || '<div class="mu">none loaded</div>';
  $("hs").innerHTML = d.hist.map(row).join("") || '<div class="mu">none yet</div>';
  if (!filled && d.cfg) {
    var c = d.cfg;
    $("c").value = c.c; $("h").value = c.h; $("so").value = c.so; $("eo").value = c.eo;
    $("il").checked = c.il; $("ps").checked = c.ps; $("sa").value = c.sa; $("ea").value = c.ea; filled = true;
  }
  if (d.msg) $("msg").textContent = d.msg;
  PZ = d.paused || [];
  slist(SJ);
}
function go(q) {
  core(q).then(show).catch(function (e) { $("now").textContent = "Core script not reachable: " + e.message; });
  if (q) setTimeout(function () { go(); sreq(); }, 3000);
}
function save() {
  go("set=1&c=" + $("c").value + "&h=" + $("h").value + "&so=" + $("so").value + "&eo=" + $("eo").value +
     "&sa=" + $("sa").value + "&ea=" + $("ea").value + "&il=" + ($("il").checked ? 1 : 0) + "&ps=" + ($("ps").checked ? 1 : 0));
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
function sreq() {
  return rpc("Schedule.List").then(function (r) {
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
  $("sl").innerHTML = h || '<div class="mu">No schedules</div>';
}
function sdo(p) { $("smsg").textContent = ""; return p.then(sreq).catch(function (e) { $("smsg").textContent = "Failed: " + e.message; throw e; }); }
function sen(i) {
  var s = SJ[i];
  if (PZ.indexOf(s.id) >= 0) { $("smsg").textContent = "Paused for Shabbos/YT - it will resume at havdalah"; return; }
  sdo(rpc("Schedule.Update", { id: s.id, enable: !s.en }));
}
function sdel(i) { if (confirm("Delete this schedule?")) sdo(rpc("Schedule.Delete", { id: SJ[i].id })).then(sreset); }
function sedit(i) {
  var s = SJ[i]; ED = s.id; $("sft").textContent = "Edit schedule"; $("stm").value = s.t;
  for (var k = 0; k < 7; k++) $("d" + k).checked = s.d.indexOf(k) >= 0;
  dsty(); $("sac").value = s.a ? "on" : "off"; $("smsg").textContent = "";
}
function sreset() { ED = null; $("sft").textContent = "Add schedule"; for (var k = 0; k < 7; k++) $("d" + k).checked = false; dsty(); }
function dsty() { for (var i = 0; i < 7; i++) $("dl" + i).className = $("d" + i).checked ? "on" : ""; }
function ssave() {
  var d = []; for (var k = 0; k < 7; k++) if ($("d" + k).checked) d.push(k);
  var t = $("stm").value;
  if (!d.length) { $("smsg").textContent = "Pick at least one day"; return; }
  if (!/^\d\d:\d\d$/.test(t)) { $("smsg").textContent = "Enter a time"; return; }
  var ts = "0 " + (+t.slice(3)) + " " + (+t.slice(0, 2)) + " * * " + (d.length === 7 ? "*" : d.map(function (x) { return SD[x]; }).join(","));
  var p = { enable: true, timespec: ts, calls: [{ method: "Switch.Set", params: { id: SW, on: $("sac").value === "on" } }] };
  if (ED !== null) p.id = ED;
  sdo(rpc(ED === null ? "Schedule.Create" : "Schedule.Update", p)).then(function () { sreset(); $("smsg").textContent = "Saved"; });
}

(function () {
  var h = ""; for (var i = 0; i < 7; i++) h += '<label id="dl' + i + '"><input type="checkbox" id="d' + i + '" onchange="dsty()">' + DN[i] + "</label>";
  $("sdy").innerHTML = h;
})();
go(); sreq();
setInterval(function () { go(); }, 15000);
