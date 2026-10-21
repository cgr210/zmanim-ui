// Builds times/<id>.csv (v1, for script v8.2) and times/<id>.v2.csv (v2, for script v8.3+) for each entry in
// locations.json, using Hebcal's own library (@hebcal/core).
//
// v2 file: exact times in unix seconds (not rounded); each Shelly applies its own rounding rules and settings.
//   #zmanim v2,made=<unix>,loc=<id>
//   type,sunset,tz85,tz708,tz6,mode,shab,yt,first,memo
//     tz85 / tz708 / tz6   nightfall with the sun 8.5 / 7.08 / 6 degrees below the horizon (0 if it doesn't happen)
//     other fields as in v1 below
// Runs daily on GitHub Actions. The Shellys read these files; they apply their own candle/havdalah minutes.
//
// File format (plain ASCII, one event per line):
//   #zmanim v1,made=<unix>,loc=<id>
//   type,sunset,tzeit,mode,shab,yt,first,memo
//     type   1 = candle lighting, 2 = havdalah
//     sunset that civil day's sunset, unix seconds, rounded to the minute (as Hebcal rounds)
//     tzeit  that day's tzeit 8.5 deg, unix seconds, rounded to the minute
//     mode   0 = candle lighting is "sunset minus N"; 1 = it is at nightfall (2nd night Yom Tov / after Shabbos)
//     shab   1 = for candles: tomorrow is Shabbos; for havdalah: today is Shabbos
//     yt     1 = for candles: tomorrow is Yom Tov; for havdalah: today is Yom Tov
//     first  1 = candles on a weekday evening (not lit at nightfall)
//     memo   ASCII name, e.g. "Shabbat", "Sukkot I"
import { HebrewCalendar, Location, Zmanim, flags } from '@hebcal/core';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const DAYS_BACK = 1, DAYS_AHEAD = 35;
const locs = JSON.parse(readFileSync(new URL('../locations.json', import.meta.url)));
mkdirSync(new URL('../times/', import.meta.url), { recursive: true });

const unix = (d) => Math.round(d.getTime() / 1000);
const ymd = (d) => d.toISOString().slice(0, 10);
const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, '').replace(/,/g, ' ').trim();

for (const L of locs) {
  const loc = new Location(L.lat, L.lon, false, L.tz, L.name || L.id, 'XX');
  const today = process.env.TODAY ? new Date(process.env.TODAY) : new Date();   // TODAY=2026-09-20 for testing
  const start = new Date(today.getTime() - DAYS_BACK * 86400e3);
  const end = new Date(today.getTime() + DAYS_AHEAD * 86400e3);
  // candleLightingMins / havdalahMins here only decide WHICH evenings have events and whether they are at nightfall;
  // the actual minutes are applied on each Shelly from its own settings.
  const evs = HebrewCalendar.calendar({
    start, end, location: loc, il: false, candlelighting: true,
    candleLightingMins: 18, havdalahDeg: 8.5,
    noMinorFast: true, noModern: true, noRoshChodesh: true, noSpecialShabbat: true,
  });
  // Yom Tov days (civil dates of Hebcal CHAG holiday events)
  const yt = new Set(evs.filter(e => e.getDesc() !== 'Candle lighting' && e.getDesc() !== 'Havdalah' && (e.getFlags() & flags.CHAG))
    .map(e => ymd(e.getDate().greg())));
  const name = {};
  for (const e of evs) {
    if (e.getDesc() === 'Candle lighting' || e.getDesc() === 'Havdalah') continue;
    if (e.getFlags() & flags.CHAG) name[ymd(e.getDate().greg())] = ascii(e.render('en'));
  }
  const lines = [`#zmanim v1,made=${unix(today)},loc=${L.id}`];
  const lines2 = [`#zmanim v2,made=${unix(today)},loc=${L.id}`];
  const exact = (d) => (d instanceof Date && !isNaN(d.getTime())) ? Math.floor(d.getTime() / 1000) : 0;
  for (const e of evs) {
    const desc = e.getDesc();
    if (desc !== 'Candle lighting' && desc !== 'Havdalah') continue;
    const g = e.getDate().greg();                        // civil date of the event
    const d = ymd(g);
    const z = new Zmanim(loc, g, false);
    const sunset = Zmanim.roundTime(z.sunset());
    const tzeit = Zmanim.roundTime(z.tzeit(8.5));
    const wd = g.getDay();
    const next = new Date(g.getTime() + 86400e3), nd = ymd(next);
    let row;
    if (desc === 'Candle lighting') {
      const mode = e.eventTime.getTime() > z.sunset().getTime() ? 1 : 0;
      const shab = next.getDay() === 6 ? 1 : 0, ytn = yt.has(nd) ? 1 : 0;
      const first = mode === 0 && wd !== 6 && !yt.has(d) ? 1 : 0;
      row = [1, unix(sunset), unix(tzeit), mode, shab, ytn, first, name[nd] || (shab ? 'Shabbat' : '')];
    } else {
      row = [2, unix(sunset), unix(tzeit), 1, wd === 6 ? 1 : 0, yt.has(d) ? 1 : 0, 0, name[d] || (wd === 6 ? 'Shabbat' : '')];
    }
    lines.push(row.join(','));
    lines2.push([row[0], exact(z.sunset()), exact(z.tzeit(8.5)), exact(z.tzeit(7.083)), exact(z.tzeit(6))].concat(row.slice(3)).join(','));
  }
  writeFileSync(new URL(`../times/${L.id}.csv`, import.meta.url), lines.join('\n') + '\n');
  writeFileSync(new URL(`../times/${L.id}.v2.csv`, import.meta.url), lines2.join('\n') + '\n');
  console.log(`${L.id}: ${lines.length - 1} events`);
}
