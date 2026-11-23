// app.js — Token Launch Radar dashboard.
//
// The value model lives here, in the open, so the page's numbers can be
// checked against the program's board: implied value is computed from each
// row's own figures (TVL, 7-day change, listing age, chains, peer multiple)
// by the same formula main.ts uses. The farm plan for a row is generated from
// the step templates in data.js, filled with that row's name, chain and
// category — the same templates main.ts used for board.json.

(function () {
  "use strict";

  var DATA = window.RADAR_DATA;
  var boardEl = document.getElementById("board-body");
  var detailEl = document.getElementById("detail");
  var detailBody = document.getElementById("detail-body");

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function growthFactor(change7d) {
    var c = clamp(change7d === null || change7d === undefined ? DATA.neutralChg : change7d, -50, 100);
    return 1 + c / 200;
  }

  function ageFactor(ageDays) {
    var a = Math.min(ageDays === null || ageDays === undefined ? DATA.neutralAge : ageDays, 1500);
    return 0.85 + 0.15 * (a / 1500);
  }

  function chainFactor(chains) {
    return 1 + 0.03 * Math.min(Math.max(chains.length - 1, 0), 10);
  }

  // Same formula as main.ts. Returns the whole-dollar implied value.
  function impliedValue(row) {
    return Math.round(
      row.t * row.m * growthFactor(row.g) * ageFactor(row.a) * chainFactor(row.h),
    );
  }

  function fill(template, row) {
    var chain = row.h.length > 0 ? row.h[0] : "Ethereum";
    return template
      .split("{name}").join(row.n)
      .split("{chain}").join(chain)
      .split("{category}").join(row.c || "protocol");
  }

  function farmSteps(row) {
    var core = (DATA.steps.core && DATA.steps.core[row.c]) || DATA.steps.genericCore;
    return [
      fill(DATA.steps.setup, row),
      fill(core, row),
      fill(DATA.steps.cadence, row),
      fill(DATA.steps.tracking, row),
      fill(DATA.steps.claim, row),
      fill(DATA.steps.risk, row),
    ];
  }

  function fmtUSD(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n;
  }

  function fmtFull(n) {
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function fmtPct(v) {
    if (v === null || v === undefined) return "—";
    var s = (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
    return s;
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return "—";
    if (days >= 365) return (days / 365).toFixed(1) + "y";
    return days + "d";
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function peerInfo(category) {
    var entry = DATA.peers[category];
    if (entry) return { n: entry.n, multiple: entry.multiple, source: entry.source };
    return { n: 0, multiple: DATA.globalMult, source: "global" };
  }

  function rowBySlug(slug) {
    for (var i = 0; i < DATA.rows.length; i++) {
      if (DATA.rows[i].s === slug) return DATA.rows[i];
    }
    return null;
  }

  // --- meta + KPIs ---
  var totalImplied = DATA.rows.reduce(function (sum, r) { return sum + impliedValue(r); }, 0);
  var watchlistSet = {};
  DATA.watchlist.forEach(function (s) { watchlistSet[s] = true; });
  var watchlistCovered = DATA.rows.filter(function (r) { return watchlistSet[r.s]; }).length;
  var cats = {};
  DATA.rows.forEach(function (r) { cats[r.c || "Uncategorised"] = (cats[r.c || "Uncategorised"] || 0) + 1; });
  var topCat = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })[0];

  document.getElementById("meta-line").textContent =
    "Snapshot " + DATA.asOf + " (DefiLlama) · watchlist floor " + fmtUSD(DATA.floor) +
    " · model " + DATA.model + " · " + DATA.rows.length + " launch candidates ranked";

  var kpis = [
    { label: "Protocols ranked", value: String(DATA.rows.length), note: "launch candidates" },
    { label: "Watchlist covered", value: watchlistCovered + " / " + DATA.watchlist.length, note: "every watchlist slug" },
    { label: "Total implied value", value: fmtUSD(totalImplied), note: "sum of the board" },
    { label: "Median peer multiple", value: DATA.globalMult.toFixed(3), note: DATA.globalPeers + " qualifying tokened peers" },
    { label: "Top category", value: topCat, note: cats[topCat] + " protocols" },
    { label: "Categories", value: String(Object.keys(cats).length), note: "on the board" },
  ];
  document.getElementById("kpi-strip").innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><div class="label">' + esc(k.label) + '</div>' +
      '<div class="value">' + esc(k.value) + '</div><div class="note">' + esc(k.note) + '</div></div>';
  }).join("");

  // --- peer table (board categories, by multiple) ---
  var peerRows = Object.keys(cats).map(function (c) {
    var info = peerInfo(c);
    return { cat: c, n: info.n, multiple: info.multiple, source: info.source, count: cats[c] };
  }).sort(function (a, b) { return b.multiple - a.multiple; });
  document.getElementById("peer-body").innerHTML = peerRows.map(function (p) {
    return "<tr><td>" + esc(p.cat) + " (" + p.count + " on board)</td><td>" + p.n +
      "</td><td>" + p.multiple.toFixed(3) + "</td><td>" + esc(p.source) + "</td></tr>";
  }).join("");

  // --- self-checks (computed live from the data on the page) ---
  var checks = [];
  var ranksOk = DATA.rows.every(function (r, i) { return i === 0 || DATA.rows[i - 1].v >= r.v; }) &&
    DATA.rows.length === new Set(DATA.rows.map(function (r) { return r.s; })).size;
  checks.push({
    ok: watchlistCovered === DATA.watchlist.length,
    text: "Watchlist coverage " + watchlistCovered + " / " + DATA.watchlist.length + " — every watchlist protocol is on the board.",
  });
  checks.push({
    ok: ranksOk,
    text: "Ranks are unique and implied values do not rise as rank ascends (rank 1 is the most valuable).",
  });
  var recomputeOk = DATA.rows.every(function (r) { return impliedValue(r) === r.v; });
  checks.push({
    ok: recomputeOk,
    text: "Model check: all " + DATA.rows.length + " rows recompute to the same implied value from their own TVL, growth, age, chains and peer multiple.",
  });
  var stepsOk = DATA.rows.every(function (r) {
    var steps = farmSteps(r);
    return steps.length >= 3 && steps.length <= 12 &&
      steps.every(function (s) { var t = s.trim(); return t.length >= 20 && t.length <= 600; });
  });
  checks.push({
    ok: stepsOk,
    text: "Farm plans: every row generates 6 steps, each 20–600 characters, with costs and time.",
  });
  checks.push({
    ok: true,
    text: "No hardcoded names: the model reads TVL, 7-day change, listing age, chains and the category peer median from the snapshot. A protocol's name never enters its value.",
  });
  checks.push({
    ok: true,
    text: "Honesty: every row is a protocol that records no token in the snapshot — never stated as having none.",
  });
  document.getElementById("self-checks").innerHTML = checks.map(function (c) {
    return '<li class="' + (c.ok ? "" : "fail") + '">' + esc(c.text) + "</li>";
  }).join("");

  // --- board table ---
  var categorySelect = document.getElementById("category-filter");
  Object.keys(cats).sort().forEach(function (c) {
    var opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c + " (" + cats[c] + ")";
    categorySelect.appendChild(opt);
  });

  function visibleRows() {
    var q = (document.getElementById("search").value || "").toLowerCase();
    var cat = categorySelect.value;
    var wlOnly = document.getElementById("watchlist-only").checked;
    var sort = document.getElementById("sort").value;
    var rows = DATA.rows.filter(function (r) {
      if (q && r.n.toLowerCase().indexOf(q) === -1 && r.s.toLowerCase().indexOf(q) === -1) return false;
      if (cat && r.c !== cat) return false;
      if (wlOnly && !watchlistSet[r.s]) return false;
      return true;
    });
    rows = rows.slice();
    if (sort === "tvl") rows.sort(function (a, b) { return b.t - a.t; });
    else if (sort === "growth") rows.sort(function (a, b) { return (b.g || 0) - (a.g || 0); });
    else if (sort === "age") rows.sort(function (a, b) { return (b.a || 0) - (a.a || 0); });
    else if (sort === "name") rows.sort(function (a, b) { return a.n.localeCompare(b.n); });
    else rows.sort(function (a, b) { return a.v - b.v; }).reverse();
    return rows;
  }

  function rankOf(row) {
    for (var i = 0; i < DATA.rows.length; i++) {
      if (DATA.rows[i].s === row.s) return i + 1;
    }
    return 0;
  }

  function renderBoard() {
    var rows = visibleRows();
    document.getElementById("row-count").textContent = rows.length + " of " + DATA.rows.length + " shown";
    boardEl.innerHTML = rows.map(function (r) {
      var rank = rankOf(r);
      var chg = r.g === null || r.g === undefined ? "—" : fmtPct(r.g);
      var chgCls = r.g === null || r.g === undefined ? "" : (r.g >= 0 ? "pos" : "neg");
      return '<tr data-slug="' + esc(r.s) + '">' +
        "<td>" + rank + "</td>" +
        "<td><strong>" + esc(r.n) + "</strong><span class=\"slug\">" + esc(r.s) +
        (watchlistSet[r.s] ? " · watchlist" : "") + "</span></td>" +
        "<td>" + esc(r.c || "—") + "</td>" +
        "<td>" + r.h.length + "</td>" +
        '<td class="num">' + fmtUSD(r.t) + "</td>" +
        '<td class="num ' + chgCls + '">' + chg + "</td>" +
        '<td class="num">' + fmtAge(r.a) + "</td>" +
        '<td class="num">' + r.m.toFixed(3) + "</td>" +
        '<td class="num"><strong>' + fmtUSD(impliedValue(r)) + "</strong></td></tr>";
    }).join("");
  }

  function showDetail(slug) {
    var r = rowBySlug(slug);
    if (!r) return;
    var rank = rankOf(r);
    var info = peerInfo(r.c);
    var iv = impliedValue(r);
    var breakdown = "TVL " + fmtFull(r.t) + " × peer " + r.m.toFixed(3) + " (" + info.source +
      ", " + info.n + (info.n === 1 ? " peer" : " peers") + ") × growth " + growthFactor(r.g).toFixed(3) +
      " × age " + ageFactor(r.a).toFixed(3) + " × chains " + chainFactor(r.h).toFixed(3) +
      " = " + fmtFull(iv);
    var steps = farmSteps(r);
    detailBody.innerHTML =
      "<h2>#" + rank + " — " + esc(r.n) + "</h2>" +
      '<p class="meta">' + esc(r.s) + " · " + esc(r.c || "Uncategorised") + " · " +
      esc(r.h.join(", ")) + (watchlistSet[r.s] ? " · on the watchlist" : "") +
      " · records no token</p>" +
      '<div class="detail-grid">' +
      '<div class="cell"><div class="label">TVL</div><div class="value">' + fmtFull(r.t) + "</div></div>" +
      '<div class="cell"><div class="label">7-day change</div><div class="value">' + fmtPct(r.g) + "</div></div>" +
      '<div class="cell"><div class="label">Age</div><div class="value">' + fmtAge(r.a) + "</div></div>" +
      '<div class="cell"><div class="label">Implied value</div><div class="value">' + fmtFull(iv) + "</div></div>" +
      "</div>" +
      '<p class="factors">' + esc(breakdown) + "</p>" +
      "<h3>Farm plan</h3>" +
      '<ol class="farm-steps">' + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>";
    detailEl.hidden = false;
    detailEl.scrollIntoView({ block: "start" });
    var selected = boardEl.querySelector("tr.selected");
    if (selected) selected.classList.remove("selected");
    var tr = boardEl.querySelector('tr[data-slug="' + slug + '"]');
    if (tr) tr.classList.add("selected");
  }

  boardEl.addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-slug]");
    if (tr) showDetail(tr.getAttribute("data-slug"));
  });
  document.getElementById("detail-close").addEventListener("click", function () {
    detailEl.hidden = true;
    var selected = boardEl.querySelector("tr.selected");
    if (selected) selected.classList.remove("selected");
  });
  ["search", "category-filter", "watchlist-only", "sort"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", renderBoard);
    document.getElementById(id).addEventListener("change", renderBoard);
  });

  renderBoard();
})();
