/* Transformer Health Check: front end
   Talks to the backend at /api/*. If there is no backend (for example when you open
   this file straight from your computer), it switches to a built-in demo with simulated data.

   Numbers on the Performance page are in PERF below. If the models are retrained, update them. */
(function () {
  "use strict";

  /* ================= settings you may want to edit ================= */
  var PERF = {
    fdd: { accuracy: 95, review: 45, total: 900,
           weakest: "Weakest class: low-temperature overheating. When the model names it, it is right about 3 times in 4." },
    rul: {
      validation: { mae: 38.7, rmse: 55.5, r2: 0.79, inside: 90 },
      test:       { mae: 40.3, rmse: 58.0, r2: 0.76, inside: 89 },
      belowMaxR2: 0.42,
      radius: 95
    }
  };
  var DEFAULTS = { threshold: 0.82, radius: 95, capDays: 546.5 };

  var FAULTS = {
    1: { name: "Normal", color: "var(--c1)", blurb: "The gases show no sign of a fault." },
    2: { name: "Partial discharge", color: "var(--c2)", blurb: "Small electrical sparks inside the insulation." },
    3: { name: "Low-energy discharge", color: "var(--c3)", blurb: "Weak electrical arcing inside the transformer." },
    4: { name: "Low-temperature overheating", color: "var(--c4)", blurb: "Part of the transformer is running hotter than normal." }
  };
  var GASES = [
    { key: "H2", full: "Hydrogen" },
    { key: "CO", full: "Carbon monoxide" },
    { key: "C2H4", full: "Ethylene" },
    { key: "C2H2", full: "Acetylene" }
  ];
  var N_READINGS = 420, STEP_DAYS = 0.5, MAX_BYTES = 2 * 1024 * 1024;

  /* ================= tiny helpers ================= */
  var NS = "http://www.w3.org/2000/svg";
  var $ = function (id) { return document.getElementById(id); };
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) for (var k in props) {
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function s(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) el.setAttribute(k, attrs[k]);
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function num(v) { var n = typeof v === "string" ? parseFloat(v) : v; return typeof n === "number" && isFinite(n) ? n : null; }
  function pick(o, keys) { if (!o) return undefined; for (var i = 0; i < keys.length; i++) if (o[keys[i]] != null) return o[keys[i]]; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function pct(p) { return Math.round(p * 1000) / 10; }
  function nice(v) { return Number(Number(v).toPrecision(2)).toString(); }
  function reduceMotion() { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

  /* ================= theme ================= */
  var root = document.documentElement;
  function currentTheme() {
    return root.getAttribute("data-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  $("theme").addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  });

  /* ================= router ================= */
  var VIEWS = ["analyse", "how", "performance"];
  var TITLES = { analyse: "Transformer Health Check | STOCHOS", how: "How it works | Transformer Health Check", performance: "Performance | Transformer Health Check" };
  var firstRoute = true;
  function route() {
    var v = (location.hash.replace(/^#\/?/, "") || "analyse");
    if (VIEWS.indexOf(v) < 0) v = "analyse";
    VIEWS.forEach(function (name) {
      $("view-" + name).hidden = name !== v;
      var a = document.querySelector('[data-tab="' + name + '"]');
      if (name === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.title = TITLES[v];
    if (!firstRoute) { window.scrollTo(0, 0); $("main").focus({ preventScroll: true }); }
    firstRoute = false;
    if (v === "analyse") requestAnimationFrame(drawCharts);
  }
  window.addEventListener("hashchange", route);

  /* ================= state ================= */
  var mode = "demo";           // "api" or "demo"
  var ready = true;
  var runId = 0;               // ignore answers that arrive after a newer request
  var shown = null;            // the analysis currently on screen

  /* ================= status banners ================= */
  function setStatus(kind, title, text) {
    var box = $("status");
    box.textContent = "";
    if (!title) return;
    box.appendChild(h("div", { class: "banner " + (kind || "") }, h("strong", { text: title }), text ? h("p", { text: text }) : null));
  }

  /* ================= talking to the backend ================= */
  function ApiError(status, message) { this.status = status; this.message = message; }
  function messageFrom(body) {
    if (!body) return null;
    var d = body.detail != null ? body.detail : body.error != null ? body.error : body.message;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map(function (x) { return typeof x === "string" ? x : (x && (x.msg || x.message)) || ""; }).filter(Boolean).join(" ");
    if (d && typeof d === "object") return d.message || d.msg || null;
    return null;
  }
  function friendly(status, fromServer) {
    if (status === 413) return "That file is bigger than 2 MB. A transformer file should be much smaller than that.";
    if (status === 404) return fromServer || "We could not find that example.";
    if (status === 422) return fromServer || "That file could not be used.";
    if (status === 503) return "The models are still starting up. Wait a minute and try again.";
    if (status >= 500) return "The server had a problem. Try again in a minute.";
    return fromServer || "Something went wrong (error " + status + ").";
  }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { /* not JSON */ }
        if (!r.ok) throw new ApiError(r.status, friendly(r.status, messageFrom(body)));
        return body;
      });
    });
  }
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("timeout")); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* ================= reading the backend's answers (tolerant of small differences) ================= */
  function normProbs(raw, cls) {
    var p = { 1: 0, 2: 0, 3: 0, 4: 0 };
    if (Array.isArray(raw)) raw.forEach(function (v, i) { if (num(v) != null) p[i + 1] = num(v); });
    else if (raw && typeof raw === "object") for (var k in raw) {
      var m = String(k).match(/[1-4]/); if (m && num(raw[k]) != null) p[m[0]] = num(raw[k]);
    }
    var sum = p[1] + p[2] + p[3] + p[4];
    if (sum > 1.5) for (var i = 1; i <= 4; i++) p[i] /= 100;   // given as percentages
    return p;
  }
  function normSeries(raw) {
    if (!raw) return null;
    var days = null, cols = {};
    if (Array.isArray(raw) && raw.length && Array.isArray(raw[0])) {            // rows: [day, H2, CO, C2H4, C2H2]
      days = raw.map(function (r) { return r[0]; });
      GASES.forEach(function (g, i) { cols[g.key] = raw.map(function (r) { return r[i + 1]; }); });
    } else if (Array.isArray(raw) && raw.length && typeof raw[0] === "object") {
      if (raw[0].H2 != null || raw[0].h2 != null) {                              // rows: {day, H2, ...}
        days = raw.map(function (r, i) { return pick(r, ["day", "days", "x", "t"]) != null ? pick(r, ["day", "days", "x", "t"]) : i * STEP_DAYS; });
        GASES.forEach(function (g) { cols[g.key] = raw.map(function (r) { return pick(r, [g.key, g.key.toLowerCase()]); }); });
      } else {                                                                   // list: {gas, values}
        raw.forEach(function (o) {
          var name = String(pick(o, ["gas", "name", "label"]) || "").toUpperCase();
          var vals = pick(o, ["values", "y", "data"]);
          if (name && vals) cols[name] = vals;
          var xs = pick(o, ["days", "x"]); if (xs && !days) days = xs;
        });
      }
    } else if (typeof raw === "object") {
      days = pick(raw, ["days", "day", "x", "time", "t"]);
      var src = raw.gases || raw.values || raw;
      GASES.forEach(function (g) { cols[g.key] = pick(src, [g.key, g.key.toLowerCase()]); });
    }
    var n = 0;
    GASES.forEach(function (g) { if (!Array.isArray(cols[g.key])) cols[g.key] = null; else n = Math.max(n, cols[g.key].length); });
    if (!n) return null;
    if (!Array.isArray(days) || days.length !== n) { days = []; for (var i = 0; i < n; i++) days.push(i * STEP_DAYS); }
    var out = { days: days.map(Number) };
    GASES.forEach(function (g) { out[g.key] = cols[g.key] ? cols[g.key].map(Number) : null; });
    return out;
  }
  function normActual(raw) {
    var a = pick(raw, ["actual", "actuals", "truth", "true", "true_values"]);
    if (!a || typeof a !== "object") return null;
    var cls = num(pick(a, ["fdd_class", "class", "fdd", "fault", "fault_class"]));
    var rulRaw = pick(a, ["rul_days", "rul", "days", "remaining_life_days", "remaining_life"]);
    var rul = num(rulRaw != null && typeof rulRaw === "object" ? pick(rulRaw, ["days", "value"]) : rulRaw);
    if (cls == null && rul == null) return null;
    return { cls: cls, rul: rul };
  }
  function normAnalysis(raw, filename) {
    var f = pick(raw, ["fdd", "fault", "diagnosis"]) || {};
    var r = pick(raw, ["rul", "remaining_life", "life"]) || {};
    var cls = num(pick(f, ["class", "fdd_class", "label", "predicted_class"]));
    var probs = normProbs(pick(f, ["probabilities", "probs", "class_probabilities"]), cls);
    var conf = num(pick(f, ["confidence", "probability", "prob"]));
    if (conf != null && conf > 1) conf /= 100;
    if (cls == null || !FAULTS[cls]) throw new Error("fdd class missing");
    if (conf == null) conf = probs[cls] || null;
    if (!probs[cls] && conf != null) probs[cls] = conf;
    var thr = num(pick(f, ["threshold", "low_confidence_threshold"]));
    if (thr != null && thr > 1) thr /= 100;
    var review = pick(f, ["needs_review", "low_confidence", "review"]);
    if (review == null) review = conf != null && conf < (thr != null ? thr : DEFAULTS.threshold);
    var days = num(pick(r, ["days", "rul_days", "estimate", "value"]));
    if (days == null) throw new Error("rul days missing");
    var radius = num(pick(r, ["radius", "error_radius_days", "plus_minus"]));
    if (radius == null) radius = DEFAULTS.radius;
    var low = num(pick(r, ["low", "lower", "min"])), high = num(pick(r, ["high", "upper", "max"]));
    if (low == null) low = Math.max(0, days - radius);
    if (high == null) high = days + radius;
    var cap = num(pick(r, ["cap_days", "cap", "max_days"]));
    if (cap == null) cap = DEFAULTS.capDays;
    var nearCap = pick(r, ["near_cap", "at_cap", "capped"]);
    if (nearCap == null) nearCap = days >= 0.9 * cap;
    return {
      name: pick(raw, ["filename", "file", "id", "name"]) || filename || "your file",
      cls: cls, confidence: conf, probs: probs, threshold: thr != null ? thr : DEFAULTS.threshold, review: !!review,
      days: days, months: num(pick(r, ["months"])) != null ? num(pick(r, ["months"])) : days / 30.4,
      low: low, high: high, radius: radius, cap: cap, nearCap: !!nearCap,
      series: normSeries(pick(raw, ["series", "readings", "gases", "chart"])),
      actual: normActual(raw)
    };
  }
  function normSamples(raw) {
    var list = Array.isArray(raw) ? raw : (raw && (raw.samples || raw.files || raw.items)) || [];
    return list.map(function (x) { return typeof x === "string" ? x : pick(x, ["id", "name", "file", "filename"]); }).filter(Boolean);
  }

  /* ================= demo mode: a tiny stand-in for the real models ================= */
  var ALARM = { H2: 0.004, CO: 0.04, C2H4: 0.01, C2H2: 0.0008 };          // typical "worth a look" levels
  var DEMO_SAMPLES = [
    { m: [0.3, 0.4, 0.2, 0.1], t: 1, e: 12 },  { m: [0.5, 0.6, 0.3, 0.2], t: 1, e: -20 },
    { m: [2.2, 1.0, 0.4, 0.3], t: 2, e: 31 },  { m: [0.6, 1.5, 0.3, 2.4], t: 3, e: -44 },
    { m: [0.7, 1.8, 2.6, 0.2], t: 4, e: 18 },  { m: [0.2, 0.3, 0.2, 0.1], t: 1, e: 6 },
    { m: [3.0, 1.5, 0.5, 0.4], t: 2, e: -27 }, { m: [1.0, 0.9, 0.4, 1.9], t: 3, e: 52 },
    { m: [0.8, 2.8, 3.2, 0.3], t: 4, e: -12 }, { m: [0.9, 0.7, 0.5, 0.2], t: 1, e: 38 },
    { m: [1.9, 1.0, 0.4, 1.6], t: 3, e: 135 }, { m: [1.2, 2.2, 1.6, 0.2], t: 4, e: -33 },
    { m: [0.4, 0.5, 0.3, 0.1], t: 1, e: 9 },   { m: [2.5, 1.2, 0.5, 0.5], t: 2, e: 22 },
    { m: [0.6, 1.0, 0.4, 2.9], t: 3, e: -58 }, { m: [0.5, 0.4, 0.2, 0.1], t: 1, e: -7 },
    { m: [0.9, 2.4, 2.9, 0.3], t: 4, e: 40 },  { m: [1.6, 0.9, 0.3, 0.3], t: 2, e: -15 },
    { m: [0.7, 1.1, 0.4, 2.0], t: 3, e: 29 },  { m: [0.3, 0.3, 0.2, 0.1], t: 1, e: 14 }
  ];
  function demoName(i) { return "1_trans_" + i + ".csv"; }
  function seeded(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function demoSeries(i) {
    var spec = DEMO_SAMPLES[i], out = { days: [] }, k;
    for (k = 0; k < N_READINGS; k++) out.days.push(k * STEP_DAYS);
    GASES.forEach(function (g, gi) {
      var rnd = seeded(1000 + i * 17 + gi * 5), target = ALARM[g.key] * spec.m[gi], start = target * 0.25, w = 0;
      out[g.key] = out.days.map(function (_, idx) {
        var t = idx / (N_READINGS - 1);
        w = w * 0.85 + (rnd() - 0.5) * 0.09;
        var v = start + (target - start) * Math.pow(t, 1.3) / Math.pow(0.95, 1.3);
        return Number(Math.max(target * 0.02, v * (1 + w)).toFixed(7));
      });
    });
    return out;
  }
  function demoModel(series) {                     // reads only the numbers, so a downloaded example gives the same answer
    var n = {}, i;
    GASES.forEach(function (g) {
      var xs = series[g.key].slice(-40), sum = 0;
      for (i = 0; i < xs.length; i++) sum += xs[i];
      n[g.key] = sum / xs.length / ALARM[g.key];
    });
    var cand = { 2: n.H2, 3: n.C2H2, 4: n.C2H4 }, top = 2;
    [3, 4].forEach(function (c) { if (cand[c] > cand[top]) top = c; });
    var maxN = Math.max(cand[2], cand[3], cand[4]), tot = cand[2] + cand[3] + cand[4];
    var cls, conf, probs = { 1: 0, 2: 0, 3: 0, 4: 0 };
    if (maxN < 1) {
      cls = 1; conf = clamp(0.99 - 0.3 * maxN, 0.5, 0.99);
      var rest = (1 - conf) / 3;
      probs = { 1: conf, 2: rest, 3: rest, 4: rest };
    } else {
      cls = top; var share = cand[top] / tot;
      conf = clamp(0.45 + 0.54 * Math.pow(share, 1.2), 0.4, 0.99);
      var others = [2, 3, 4].filter(function (c) { return c !== cls; });
      var osum = others.reduce(function (a, c) { return a + cand[c]; }, 0) || 1;
      probs[cls] = conf; probs[1] = (1 - conf) * 0.15;
      others.forEach(function (c) { probs[c] = (1 - conf) * 0.85 * cand[c] / osum; });
    }
    var sev = clamp((n.H2 + n.CO + n.C2H4 + n.C2H2) / 4 / 3, 0, 1);
    var days = DEFAULTS.capDays - sev * (DEFAULTS.capDays - 181);
    return { cls: cls, confidence: conf, probs: probs, threshold: DEFAULTS.threshold, review: conf < DEFAULTS.threshold,
             days: days, months: days / 30.4, low: Math.max(0, days - DEFAULTS.radius), high: days + DEFAULTS.radius,
             radius: DEFAULTS.radius, cap: DEFAULTS.capDays, nearCap: days >= 0.9 * DEFAULTS.capDays };
  }
  function demoSample(i) {
    var series = demoSeries(i), a = demoModel(series);
    a.name = demoName(i); a.series = series;
    a.actual = { cls: DEMO_SAMPLES[i].t, rul: Math.max(150, Math.round(a.days + DEMO_SAMPLES[i].e)) };
    return a;
  }
  function seriesToCsv(series) {
    var lines = [GASES.map(function (g) { return g.key; }).join(",")];
    for (var i = 0; i < series.days.length; i++) lines.push(GASES.map(function (g) { return series[g.key][i]; }).join(","));
    return lines.join("\n") + "\n";
  }
  function parseCsv(text, name) {
    var lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
    if (!lines.length) throw new ApiError(422, "The file is empty.");
    var header = lines[0].split(",").map(function (x) { return x.trim().toUpperCase(); });
    var idx = GASES.map(function (g) { return header.indexOf(g.key); });
    var missing = GASES.filter(function (g, i) { return idx[i] < 0; }).map(function (g) { return g.key; });
    if (missing.length) throw new ApiError(422, "The file is missing the column" + (missing.length > 1 ? "s " : " ") + missing.join(", ") + ". It needs H2, CO, C2H4 and C2H2.");
    if (header.length > 4) throw new ApiError(422, "The file has extra columns. It should have only H2, CO, C2H4 and C2H2.");
    var rows = lines.slice(1);
    if (rows.length !== N_READINGS) throw new ApiError(422, "The file has " + rows.length + " readings, but exactly " + N_READINGS + " are needed (one every 12 hours).");
    var series = { days: [] }; GASES.forEach(function (g) { series[g.key] = []; });
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].split(",");
      for (var c = 0; c < 4; c++) {
        var raw = (cells[idx[c]] || "").trim(), v = Number(raw);
        if (raw === "" ) throw new ApiError(422, "Reading " + (r + 1) + " is missing a value for " + GASES[c].key + ".");
        if (!isFinite(v)) throw new ApiError(422, "Reading " + (r + 1) + " has a value for " + GASES[c].key + " that is not a number.");
        if (v < 0) throw new ApiError(422, "Reading " + (r + 1) + " has a negative value for " + GASES[c].key + ". Gas amounts cannot be negative.");
        series[GASES[c].key].push(v);
      }
      series.days.push(r * STEP_DAYS);
    }
    return series;
  }

  /* ================= loading examples and analysing ================= */
  var sampleIds = [];
  function fillSamples(ids) {
    sampleIds = ids;
    var sel = $("sample");
    sel.textContent = "";
    sel.appendChild(h("option", { value: "", text: ids.length ? "Choose an example…" : "No examples available" }));
    ids.forEach(function (id, i) { sel.appendChild(h("option", { value: id, text: "Example " + (i + 1) + " (" + id + ")" })); });
  }
  function setSampleLink(id) {
    var a = $("sample-csv");
    if (a.dataset.blob) { URL.revokeObjectURL(a.dataset.blob); a.dataset.blob = ""; }
    if (!id) { a.setAttribute("aria-disabled", "true"); a.removeAttribute("href"); return; }
    a.removeAttribute("aria-disabled");
    a.setAttribute("download", id);
    if (mode === "api") a.href = "/api/samples/" + encodeURIComponent(id) + "/csv";
    else {
      var url = URL.createObjectURL(new Blob([seriesToCsv(demoSeries(sampleIds.indexOf(id)))], { type: "text/csv" }));
      a.dataset.blob = url; a.href = url;
    }
  }
  function showLoading(text) {
    var out = $("out");
    out.textContent = "";
    out.appendChild(h("div", { class: "empty" }, h("div", { class: "empty-card" },
      h("h2", { text: text }),
      h("div", { class: "progress", role: "progressbar", "aria-label": "Analysing" }, h("i")))));
  }
  function showEmpty() {
    var out = $("out");
    out.textContent = "";
    out.appendChild(h("div", { class: "empty" }, h("div", { class: "empty-card" },
      h("h2", { text: "Find out what the gases say" }),
      h("p", { text: "Add a CSV or pick an example to see the likely fault and the remaining life." }))));
  }
  function showError(message) {
    var out = $("out");
    out.textContent = "";
    out.appendChild(h("div", { class: "banner bad", role: "alert" },
      h("strong", { text: "We could not analyse that file" }),
      h("p", { text: message })));
  }
  function guardReady() {
    if (ready) return true;
    showError("The models are still starting up. Try again in a minute.");
    return false;
  }
  function finish(a, id) {
    if (id !== runId) return;
    shown = a;
    renderResult(a);
    if (window.innerWidth < 960) $("out").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
    var hd = $("out").querySelector("h2"); if (hd) hd.focus({ preventScroll: true });
  }
  function fail(e, id) {
    if (id !== runId) return;
    shown = null;
    showError(e instanceof ApiError ? e.message : e && e.message === "Failed to fetch" ? "We could not reach the server. Check your connection and try again." : "The answer came back in a form we could not read.");
  }

  function analyseSample(id) {
    if (!id) { runId++; shown = null; showEmpty(); setSampleLink(""); return; }
    if (!guardReady()) return;
    var mine = ++runId; setSampleLink(id); showLoading("Analysing " + id);
    if (mode === "demo") {
      setTimeout(function () { try { finish(demoSample(sampleIds.indexOf(id)), mine); } catch (e) { fail(e, mine); } }, 450);
      return;
    }
    api("/api/samples/" + encodeURIComponent(id)).then(function (raw) { finish(normAnalysis(raw, id), mine); }, function (e) { fail(e, mine); });
  }
  function analyseFile(file) {
    if (!file || !guardReady()) return;
    $("sample").value = ""; setSampleLink("");
    var mine = ++runId;
    if (file.size > MAX_BYTES) return fail(new ApiError(413, friendly(413)), mine);
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return fail(new ApiError(422, "That is not a CSV file. Export the readings as a .csv file and try again."), mine);
    showLoading("Analysing " + file.name);
    if (mode === "demo") {
      var fr = new FileReader();
      fr.onload = function () {
        try { var series = parseCsv(String(fr.result), file.name), a = demoModel(series); a.name = file.name; a.series = series; a.actual = null; setTimeout(function () { finish(a, mine); }, 450); }
        catch (e) { fail(e, mine); }
      };
      fr.onerror = function () { fail(new ApiError(422, "We could not read that file."), mine); };
      fr.readAsText(file);
      return;
    }
    var fd = new FormData(); fd.append("file", file, file.name);
    api("/api/predict", { method: "POST", body: fd }).then(function (raw) { finish(normAnalysis(raw, file.name), mine); }, function (e) { fail(e, mine); });
  }

  /* ================= drawing: results ================= */
  function renderResult(a) {
    var out = $("out"), fault = FAULTS[a.cls];
    out.textContent = "";
    out.appendChild(h("p", { class: "file-name", text: a.name }));

    if (a.review) out.appendChild(h("div", { class: "flag", role: "note" },
      h("strong", { text: "Needs manual review" }),
      h("p", { text: a.confidence != null
        ? "The model is " + pct(a.confidence) + "% sure. We need " + pct(a.threshold) + "% to skip a check."
        : "The model is not sure enough to skip a check." })));

    /* condition */
    var conf = a.confidence != null ? a.confidence : (a.probs[a.cls] || 0);
    var probs = h("div", { class: "probs" });
    [1, 2, 3, 4].forEach(function (c) {
      var p = a.probs[c] || 0;
      probs.appendChild(h("div", { class: "prob" + (c === a.cls ? " top" : "") },
        h("span", { class: "nm" }, h("i", { class: "sw", style: "background:" + FAULTS[c].color }), FAULTS[c].name),
        h("span", { class: "pc", text: pct(p) + "%" }),
        h("span", { class: "track", role: "img", "aria-label": FAULTS[c].name + ": " + pct(p) + " percent" },
          h("i", { class: "fill", style: "display:block;width:" + clamp(p * 100, 0, 100) + "%;background:" + FAULTS[c].color }),
          h("i", { class: "tick", style: "--thr:" + clamp(a.threshold * 100, 0, 100) + "%" }))));
    });
    var faultCard = h("div", { class: "panel" },
      h("h3", { text: "Condition" }),
      h("h2", { class: "fault-name", tabindex: "-1" }, h("i", { class: "sw", style: "background:" + fault.color }), fault.name),
      h("div", { class: "conf" },
        h("span", { class: "track", role: "img", "aria-label": pct(conf) + " percent sure" },
          h("i", { class: "fill", style: "display:block;width:" + clamp(conf * 100, 0, 100) + "%;background:" + fault.color })),
        h("span", { class: "conf-n", text: pct(conf) + "% sure" })),
      h("p", { class: "cls-blurb", text: fault.blurb }),
      h("details", { class: "more" },
        h("summary", { text: "All four probabilities" }), probs,
        h("p", { class: "thr-note", text: "The tick marks " + pct(a.threshold) + "%, the level we need to skip a check." })));

    /* remaining life */
    var life = h("div", { class: "panel" },
      h("h3", { text: "Remaining life" }),
      h("p", { class: "big" }, String(Math.round(a.days)), h("small", { text: "days" })),
      h("p", { class: "months", text: "about " + Math.round(a.months) + " months" }),
      h("div", { id: "ruler-host" }),
      h("p", { class: "range-note", text: "Likely " + Math.round(a.low) + " to " + Math.round(a.high) + " days" }),
      a.nearCap ? h("p", { class: "near-cap", text: "Near the longest life seen in training. Read it as \"at least this long\"." }) : null);

    out.appendChild(h("div", { class: "pair" }, faultCard, life));

    /* gas readings */
    if (a.series) {
      out.appendChild(h("h3", { class: "gases-head", text: "Gas readings" }));
      var grid = h("div", { class: "gases" });
      GASES.forEach(function (g) {
        if (!a.series[g.key]) return;
        grid.appendChild(h("div", { class: "gas" }, h("h4", null, g.key, h("span", { class: "full", text: g.full })), h("div", { "data-gas": g.key })));
      });
      out.appendChild(grid);
    }

    /* real answers (examples only) */
    if (a.actual) {
      var rows = [];
      if (a.actual.cls != null && FAULTS[a.actual.cls]) {
        var same = a.actual.cls === a.cls;
        rows.push(h("tr", null, h("th", { scope: "row", text: "Fault" }),
          h("td", { text: "Class " + a.cls + ", " + fault.name }),
          h("td", { text: "Class " + a.actual.cls + ", " + FAULTS[a.actual.cls].name }),
          h("td", { class: same ? "ok" : "miss", text: same ? "Match" : "Different" })));
      }
      if (a.actual.rul != null) {
        var diff = Math.round(Math.abs(a.days - a.actual.rul)), inside = Math.abs(a.days - a.actual.rul) <= a.radius;
        rows.push(h("tr", null, h("th", { scope: "row", text: "Life" }),
          h("td", { text: Math.round(a.days) + " days" }),
          h("td", { text: Math.round(a.actual.rul) + " days" }),
          h("td", { class: inside ? "ok" : "miss", text: diff + " days off, " + (inside ? "inside" : "outside") + " range" })));
      }
      if (rows.length) out.appendChild(h("div", { class: "compare" }, h("h3", { text: "Real answer" }),
        h("table", null, h("thead", { class: "sr-only" }, h("tr", null, h("th", { text: "Measure" }), h("th", { text: "Model said" }), h("th", { text: "Real answer" }), h("th", { text: "Result" }))), h("tbody", null, rows))));
    }
    drawCharts();
  }

  /* ----- the remaining-life ruler ----- */
  function drawRuler(host, a) {
    var W = Math.max(260, Math.round(host.clientWidth || 440)), L = 8, R = W - 8, H = 164;
    var max = Math.max(a.cap * 1.06, a.high * 1.05, (a.actual && a.actual.rul || 0) * 1.05, 600);
    max = Math.ceil(max / 100) * 100;
    var x = function (d) { return L + (clamp(d, 0, max) / max) * (R - L); };
    var svg = s("svg", { class: "ruler", viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Scale from 0 to " + max + " days. Estimate " + Math.round(a.days) + " days, likely range " + Math.round(a.low) + " to " + Math.round(a.high) + " days." });
    var axisY = 80;
    svg.appendChild(s("rect", { x: x(a.low), y: 30, width: Math.max(2, x(a.high) - x(a.low)), height: 40, fill: "var(--ink)", opacity: 0.13 }));
    svg.appendChild(s("line", { x1: x(a.low), y1: 30, x2: x(a.low), y2: 70, stroke: "var(--ink)", "stroke-width": 1.5 }));
    svg.appendChild(s("line", { x1: x(a.high), y1: 30, x2: x(a.high), y2: 70, stroke: "var(--ink)", "stroke-width": 1.5 }));
    svg.appendChild(s("line", { x1: L, y1: axisY, x2: R, y2: axisY, stroke: "var(--ink)", "stroke-width": 1.6 }));
    var step = W < 380 ? 200 : 100;
    for (var d = 0; d <= max; d += step) {
      svg.appendChild(s("line", { x1: x(d), y1: axisY, x2: x(d), y2: axisY + 6, stroke: "var(--ink)", "stroke-width": 1.4 }));
      svg.appendChild(s("text", { x: x(d), y: axisY + 22, "text-anchor": d === 0 ? "start" : d === max ? "end" : "middle" }, d === max ? d + " days" : String(d)));
    }
    // longest life seen in training
    var cx = x(a.cap);
    svg.appendChild(s("line", { x1: cx, y1: 22, x2: cx, y2: axisY, stroke: "var(--ink-3)", "stroke-width": 1.2, "stroke-dasharray": "3 4" }));
    var capLabel = W < 380 ? "training max" : "longest in training";
    var capAnchor = cx > R - 90 ? "end" : "middle";
    svg.appendChild(s("text", { x: capAnchor === "end" ? cx + 2 : cx, y: 124, "text-anchor": capAnchor }, capLabel));
    // estimate
    var ex = x(a.days);
    svg.appendChild(s("line", { x1: ex, y1: 20, x2: ex, y2: axisY, stroke: "var(--ink)", "stroke-width": 2.4 }));
    svg.appendChild(s("circle", { cx: ex, cy: 50, r: 7, fill: "var(--ink)" }));
    var eAnchor = ex < L + 40 ? "start" : ex > R - 40 ? "end" : "middle";
    svg.appendChild(s("text", { x: eAnchor === "start" ? ex - 2 : eAnchor === "end" ? ex + 2 : ex, y: 12, "text-anchor": eAnchor, class: "lab" }, "Estimate"));
    // actual (examples only)
    if (a.actual && a.actual.rul != null) {
      var ax = x(a.actual.rul);
      svg.appendChild(s("path", { d: "M" + (ax - 7) + " " + (axisY + 1) + " L" + ax + " " + (axisY - 11) + " L" + (ax + 7) + " " + (axisY + 1) + " Z", fill: "var(--c4)", stroke: "var(--paper)", "stroke-width": 1.5 }));
      var near = Math.abs(ax - cx) < 120;
      svg.appendChild(s("text", { x: clamp(ax, 28, W - 28), y: near ? 146 : 124, "text-anchor": "middle", class: "lab", fill: "var(--c4)" }, "Actual " + Math.round(a.actual.rul)));
    }
    host.textContent = "";
    host.appendChild(svg);
    host.firstChild.setAttribute("height", H);
  }

  /* ----- small gas charts ----- */
  function drawGas(host, series, key) {
    var ys = series[key], xs = series.days;
    var W = Math.max(240, Math.round(host.clientWidth || 360)), H = 140, ML = 56, MR = 10, MT = 10, MB = 26;
    var maxY = 0, i;
    for (i = 0; i < ys.length; i++) if (ys[i] > maxY) maxY = ys[i];
    maxY = maxY * 1.08 || 1;
    var maxX = xs[xs.length - 1] || 1;
    var X = function (v) { return ML + (v / maxX) * (W - ML - MR); };
    var Y = function (v) { return H - MB - (v / maxY) * (H - MT - MB); };
    var svg = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": key + " readings, rising from " + nice(ys[0]) + " to " + nice(ys[ys.length - 1]) + " over " + Math.round(maxX) + " days." });
    [0, 0.5, 1].forEach(function (f) {
      var v = maxY * f;
      svg.appendChild(s("line", { x1: ML, y1: Y(v), x2: W - MR, y2: Y(v), stroke: "var(--grid-major)", "stroke-width": f === 0 ? 1.2 : 0.7 }));
      svg.appendChild(s("text", { x: ML - 6, y: Y(v) + 4, "text-anchor": "end" }, nice(v)));
    });
    var tickStep = W < 330 ? 100 : 50;
    for (var d = 0; d <= maxX; d += tickStep) {
      svg.appendChild(s("line", { x1: X(d), y1: H - MB, x2: X(d), y2: H - MB + 4, stroke: "var(--ink-3)" }));
      svg.appendChild(s("text", { x: X(d), y: H - 8, "text-anchor": d === 0 ? "start" : "middle" }, String(d)));
    }
    var pts = ys.map(function (v, idx) { return (idx ? "L" : "M") + X(xs[idx]).toFixed(1) + " " + Y(v).toFixed(1); }).join(" ");
    svg.appendChild(s("path", { d: pts, fill: "none", stroke: "var(--ink)", "stroke-width": 1.7, "stroke-linejoin": "round" }));
    var cross = s("g", { visibility: "hidden" },
      s("line", { x1: 0, y1: MT, x2: 0, y2: H - MB, stroke: "var(--ink-3)", "stroke-dasharray": "3 3" }),
      s("circle", { r: 4, fill: "var(--ink)", stroke: "var(--paper)", "stroke-width": 2 }));
    var tip = s("text", { class: "readout", visibility: "hidden" });
    svg.appendChild(cross); svg.appendChild(tip);
    var hit = s("rect", { x: ML, y: MT, width: W - ML - MR, height: H - MT - MB, fill: "transparent" });
    function move(ev) {
      var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
      var idx = clamp(Math.round(((px - ML) / (W - ML - MR)) * (ys.length - 1)), 0, ys.length - 1);
      var cx = X(xs[idx]), cy = Y(ys[idx]);
      cross.setAttribute("visibility", "visible"); tip.setAttribute("visibility", "visible");
      cross.firstChild.setAttribute("x1", cx); cross.firstChild.setAttribute("x2", cx);
      cross.lastChild.setAttribute("cx", cx); cross.lastChild.setAttribute("cy", cy);
      tip.textContent = "day " + Math.round(xs[idx]) + ": " + Number(ys[idx].toPrecision(3));
      var left = cx > W * 0.6;
      tip.setAttribute("text-anchor", left ? "end" : "start");
      tip.setAttribute("x", left ? cx - 8 : cx + 8); tip.setAttribute("y", MT + 12);
    }
    function leave() { cross.setAttribute("visibility", "hidden"); tip.setAttribute("visibility", "hidden"); }
    hit.addEventListener("pointermove", move); hit.addEventListener("pointerdown", move); hit.addEventListener("pointerleave", leave);
    svg.appendChild(hit);
    host.textContent = "";
    host.appendChild(svg);
  }

  function drawCharts() {
    if (!shown || $("view-analyse").hidden) return;
    var rh = $("ruler-host"); if (rh) drawRuler(rh, shown);
    if (shown.series) document.querySelectorAll("[data-gas]").forEach(function (el) { drawGas(el, shown.series, el.getAttribute("data-gas")); });
  }
  var resizeTimer;
  window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 120); });

  /* ================= performance page ================= */
  function renderPerformance() {
    var host = $("perf"), P = PERF;
    host.textContent = "";
    host.appendChild(h("div", { class: "stat-row" },
      h("div", { class: "stat" }, h("div", { class: "n", text: P.fdd.accuracy + "%" }), h("p", { class: "t", text: "of fault diagnoses right" })),
      h("div", { class: "stat" }, h("div", { class: "n", text: P.fdd.review + " of " + P.fdd.total }), h("p", { class: "t", text: "flagged for a person to check" })),
      h("div", { class: "stat" }, h("div", { class: "n", text: Math.round(P.rul.test.mae) + " days" }), h("p", { class: "t", text: "average error in remaining life" }))));
    host.appendChild(h("p", { class: "perf-note", text: P.fdd.weakest }));

    var rows = [
      { name: "Average error", what: "Days off, on average. Lower is better.", k: "mae", unit: " days", scale: 70, dec: 1 },
      { name: "Error, big misses weighted", what: "Large misses count more. Lower is better.", k: "rmse", unit: " days", scale: 70, dec: 1 },
      { name: "Pattern score", what: "0 to 1. Higher is better.", k: "r2", unit: "", scale: 1, dec: 2 },
      { name: "Inside the range", what: "Share within \u00b1" + P.rul.radius + " days.", k: "inside", unit: "%", scale: 100, dec: 0 }
    ];
    function bar(label, val, row, color) {
      return h("span", null, h("em", { style: "font-style:normal", text: label }),
        h("i", { style: "width:" + clamp((val / row.scale) * 100, 2, 100) + "%;background:" + color }),
        h("b", { text: val.toFixed(row.dec) + row.unit }));
    }
    var body = h("tbody");
    rows.forEach(function (r) {
      body.appendChild(h("tr", null,
        h("th", { scope: "row" }, r.name, h("span", { class: "what", text: r.what })),
        h("td", null, h("div", { class: "pair-bar" }, bar("Check", P.rul.validation[r.k], r, "var(--ink-3)"), bar("Test", P.rul.test[r.k], r, "var(--ink)")))));
    });
    host.appendChild(h("div", { class: "sect" }, h("h3", { text: "Remaining life" }),
      h("p", { class: "intro", text: "Check is the data held back while tuning. Test is the 900 unseen transformers." }),
      h("table", { class: "vt" }, h("thead", null, h("tr", null, h("th", { scope: "col", text: "Measure" }), h("th", { scope: "col", text: "Check and test" }))), body),
      h("p", { class: "perf-note", text: "Less precise when a long life remains (pattern score about " + P.rul.belowMaxR2 + ")." })));
  }

  /* ================= start-up ================= */
  function setMode(m) {
    mode = m;
    $("demo-badge").hidden = m !== "demo";
    if (m === "demo") setStatus("warn", "Demo mode", "Simulated results, not from the real models.");
  }
  function startDemo() {
    setMode("demo");
    var ids = DEMO_SAMPLES.map(function (_, i) { return demoName(i); });
    fillSamples(ids);
    $("file").disabled = false; ready = true;
    showEmpty();
  }
  function loadSamples() {
    return api("/api/samples").then(function (raw) { fillSamples(normSamples(raw)); }).catch(function () { fillSamples([]); });
  }
  function pollUntilReady(tries) {
    api("/api/health").then(function (b) {
      if (b && b.ready === false) throw new Error("not ready");
      ready = true; setStatus(); $("dropzone").classList.remove("disabled"); loadSamples();
    }).catch(function () {
      if (tries > 100) { setStatus("bad", "The models did not start", "Try reloading the page in a few minutes."); return; }
      setTimeout(function () { pollUntilReady(tries + 1); }, 3000);
    });
  }
  function init() {
    renderPerformance();
    route();
    showEmpty();
    $("file").addEventListener("change", function (e) { analyseFile(e.target.files[0]); e.target.value = ""; });
    $("sample").addEventListener("change", function (e) { analyseSample(e.target.value); });
    var dz = $("dropzone");
    ["dragenter", "dragover"].forEach(function (n) { dz.addEventListener(n, function (e) { e.preventDefault(); dz.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (n) { dz.addEventListener(n, function (e) { e.preventDefault(); dz.classList.remove("over"); }); });
    dz.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files.length) analyseFile(e.dataTransfer.files[0]); });
    document.addEventListener("dragover", function (e) { e.preventDefault(); });
    document.addEventListener("drop", function (e) { e.preventDefault(); });

    if (/[?&]demo\b/.test(location.search) || location.protocol === "file:") return startDemo();
    withTimeout(api("/api/health"), 5000).then(function (b) {
      setMode("api");
      if (b && b.ready === false) {
        ready = false; $("dropzone").classList.add("disabled");
        setStatus("", "The models are warming up", "This takes a minute or two. You can start when this message goes away.");
        $("sample").innerHTML = ""; $("sample").appendChild(h("option", { value: "", text: "Waiting for the models…" }));
        pollUntilReady(0);
      } else loadSamples();
    }, function () { startDemo(); });
  }
  init();
})();
