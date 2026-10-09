/* =============================================================================
   game-shell.js — shared shell for the STK game pages.
   Load as game-shell.js?v=N (bump N whenever this file or game-shell.css changes;
   GitHub Pages caches sub-resources for ~10 minutes).

   INTERFACE
   ---------
   The page owns auth. Once it has a session it calls:

     GameShell.mount({
       sb,                 // Supabase client
       userId,             // auth user id (uuid)
       game,               // key stored in game_scores.game, e.g. "mental_maths"
       title,              // name shown in the run layer's top strip
       answerInput,        // optional: "numeric" gives the run a real <input> (see ctx.input)
       els: {
         stats,            // element: the shell renders the 4-cell stat strip here
         leaderboard,      // element: the shell renders the Leaderboard card body here
         playCard,         // element: the pre-run Play card (hidden while a result shows)
         resultCard,       // element: the shell fills and shows this after a run
         startButton,      // element: starts a run
       },
       createRun(ctx),     // REQUIRED. Called after each countdown. See RUN CONTEXT.
       renderResult(el, summary),  // REQUIRED. Fill `el` with the game-specific part of
                                   // the Result card. summary = { score, stats, rankEl,
                                   // bestEl }: rankEl ("4th of 37 runs, all-time") and
                                   // bestEl are filled by the shell after saving; place
                                   // them where they belong (appended after `el` if not).
       formatScore(n),     // optional: how a score is shown in the stat strip (Best and
                           // 7-day average), the leaderboard rows (pinned row included)
                           // and the Result card's best line. Receives the raw stored
                           // score; for the 7-day average, the unrounded mean. Default
                           // String(n), and n.toFixed(1) for the 7-day average. Display
                           // only: sorting and ranking always use the raw number.
     })

   RUN CONTEXT (argument to createRun)
     ctx.stage      element in the full-screen layer for the game's own UI (the question)
     ctx.input      the answer <input> (inputmode="numeric") when answerInput is set and
                    USE_SYSTEM_KEYBOARD is true, otherwise null. The shell creates it once
                    per run, keeps it focused and never recreates it: the game listens for
                    "input" events, and clears .value between questions.
     ctx.pad        element at the bottom of the layer (for an on-screen keypad when
                    ctx.input is null)
     ctx.isTouch    true when matchMedia('(pointer: coarse)') matches
     ctx.clock      { start(), pause(), resume(), elapsedMs(), remainingMs(totalMs), running }
                    based on performance.now(); excludes paused time. Games must use
                    this, never Date.now().
     ctx.setTimer(text, fraction)   fills the top-strip timer slot and thin bar (0..1)
     ctx.setScore(text)             fills the top-strip score slot
     ctx.finish({ score, stats })   ends the run; the shell closes the layer, saves the
                                    run and shows the Result card.
   createRun must return { onKey(key) -> boolean, tick(), destroy() }:
     onKey   receives KeyboardEvent.key while the layer is open and the run is live;
             return true if handled (the shell then calls preventDefault). Only used
             when ctx.input is null; with ctx.input the keys go into the input.
     tick    called about every 50 ms while the run is live (check the time limit here).
     destroy called when the run ends or is quit.

   FOCUS (iOS)
     iOS opens the keyboard only when focus() runs inside a user gesture, so the shell
     focuses ctx.input synchronously in the Start / "Save and play" / Resume / "Keep
     playing" handlers, keeps it focused (opacity 0, never display:none) through the
     countdown, shows "Tap to bring back the keyboard" if it loses focus mid-run, and
     refocuses only on a tap on the layer. It blurs the input when the run ends.

   LAYOUT
     While a run is open the layer is sized to window.visualViewport (height and
     offsetTop), so the timer, question and input sit above the on-screen keyboard;
     100dvh is the fallback.

   SAVING
     Finished runs only: game_scores { user_id, game, score, played_date (London date,
     YYYY-MM-DD), player_name, stats }. Quit runs are never saved.

   ACCESS RULES (not changed here)
     The tables currently use the site-wide "authenticated full access" policy. Real
     multi-user use needs row-level policies so that each user can insert only rows
     with their own user_id (and player_profiles only their own row), while everyone
     signed in can read the leaderboard.

   TEST HOOKS
     GameShell.config.countdownMs / goMs   countdown timings (default 1000 / 500)
     GameShell.config.now                  time source (default performance.now)
     GameShell.debug.tick()                run one tick immediately
   ============================================================================= */

// false (current): answers come from document key events plus the game's own drawn
// on-screen number pad on touch devices (ctx.input is null), and the layer is a plain
// 100dvh sheet. This is the behaviour of commit 4e50d7e.
// true: a real <input inputmode="numeric"> so phones show their system number pad.
// Tried in 8810084 and rejected on iPhone: iOS adds its accessory bar (arrows and a
// tick) above the keypad and the page behind showed through. Kept for reference only.
const USE_SYSTEM_KEYBOARD = false;

(function () {
  "use strict";

  const TZ = "Europe/London";
  const config = { countdownMs: 1000, goMs: 500, now: () => performance.now() };

  // ---------------------------------------------------------------- utilities
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }
  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + "th";
    return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  }

  // London dates and midnights, computed with Intl (never the browser's own zone).
  const partsFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function londonParts(ms) {
    const p = {};
    for (const x of partsFmt.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
    return p; // year, month, day, hour, minute, second
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  function londonDate(ms) { const p = londonParts(ms); return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`; }
  // UTC instant of 00:00 London time on the given calendar day (handles BST/GMT).
  function londonMidnight(y, m, d) {
    const guess = Date.UTC(y, m - 1, d);
    let ms = guess;
    for (let i = 0; i < 3; i++) {
      const p = londonParts(ms);
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      ms = guess - (asUtc - Math.floor(ms / 1000) * 1000);
    }
    return ms;
  }
  function addDaysYMD(y, m, d, n) { const t = new Date(Date.UTC(y, m - 1, d + n)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; }
  function rangeBounds(kind, nowMs) {
    const p = londonParts(nowMs);
    if (kind === "month") {
      const next = p.month === 12 ? [p.year + 1, 1] : [p.year, p.month + 1];
      return { from: new Date(londonMidnight(p.year, p.month, 1)).toISOString(), to: new Date(londonMidnight(next[0], next[1], 1)).toISOString() };
    }
    return null;
  }
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function whenLabel(iso, nowMs) {
    const ms = Date.parse(iso);
    const p = londonParts(ms);
    const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
    const day = londonDate(ms);
    const n = londonParts(nowMs);
    const today = londonDate(nowMs);
    const y = addDaysYMD(n.year, n.month, n.day, -1);
    const yesterday = `${y[0]}-${pad2(y[1])}-${pad2(y[2])}`;
    if (day === today) return `Today · ${time}`;
    if (day === yesterday) return `Yesterday · ${time}`;
    const wd = WD[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
    return `${wd} ${p.day} ${MON[p.month - 1]}${p.year !== n.year ? ` ${p.year}` : ""} · ${time}`;
  }
  const wallNow = () => Date.now(); // wall clock, only for dates and leaderboard ranges

  // --------------------------------------------------------------- run clock
  function makeClock() {
    let startedAt = null, pausedAt = null, pausedTotal = 0;
    return {
      get running() { return startedAt !== null && pausedAt === null; },
      start() { startedAt = config.now(); pausedAt = null; pausedTotal = 0; },
      pause() { if (startedAt !== null && pausedAt === null) pausedAt = config.now(); },
      resume() { if (pausedAt !== null) { pausedTotal += config.now() - pausedAt; pausedAt = null; } },
      elapsedMs() {
        if (startedAt === null) return 0;
        const end = pausedAt !== null ? pausedAt : config.now();
        return Math.max(0, end - startedAt - pausedTotal);
      },
      remainingMs(total) { return Math.max(0, total - this.elapsedMs()); },
    };
  }

  // ---------------------------------------------------------------- the shell
  let opts = null, layer = null, run = null, tickTimer = null;
  let profileName = null, profileState = "unknown"; // unknown | loading | have | none | error
  let lbTab = "all", lbSeq = 0;
  const isTouch = () => window.matchMedia("(pointer: coarse)").matches;
  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wantsInput = () => USE_SYSTEM_KEYBOARD && opts && opts.answerInput === "numeric";

  function mount(o) {
    opts = o;
    o.els.startButton.addEventListener("click", onStartTap);
    loadProfile();
    refreshStats();
    renderLeaderboardFrame();
    loadLeaderboard();
  }
  const fmtScore = (n) => (opts.formatScore ? opts.formatScore(n) : String(n));

  // ---- stat strip ----
  async function refreshStats() {
    const box = opts.els.stats;
    const cells = [["Best", "best"], ["Plays", "plays"], ["Today", "today"], ["7-day average", "avg7"]];
    if (!box.firstChild) box.append(...cells.map(([label, key]) => el("div", { class: "gs-stat" }, el("div", { class: "gs-stat-label", text: label }), el("div", { class: "gs-stat-num", "data-stat": key, text: "–" }))));
    const set = (k, v) => { const c = box.querySelector(`[data-stat="${k}"]`); if (c) c.textContent = v; };
    const { sb, userId, game } = opts;
    const now = wallNow();
    const n = londonParts(now);
    const todayStart = new Date(londonMidnight(n.year, n.month, n.day)).toISOString();
    const w = addDaysYMD(n.year, n.month, n.day, -6);
    const weekStart = new Date(londonMidnight(w[0], w[1], w[2])).toISOString();
    try {
      const mine = () => sb.from("game_scores").select("id", { count: "exact", head: true }).eq("game", game).eq("user_id", userId);
      const [best, plays, today, week] = await Promise.all([
        sb.from("game_scores").select("score").eq("game", game).eq("user_id", userId).order("score", { ascending: false }).limit(1),
        mine(),
        mine().gte("created_at", todayStart),
        sb.from("game_scores").select("score").eq("game", game).eq("user_id", userId).gte("created_at", weekStart),
      ]);
      if (best.error || plays.error || today.error || week.error) throw best.error || plays.error || today.error || week.error;
      set("best", best.data && best.data.length ? fmtScore(best.data[0].score) : "–");
      set("plays", String(plays.count ?? 0));
      set("today", String(today.count ?? 0));
      const scores = (week.data || []).map((r) => r.score);
      const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      set("avg7", mean !== null ? (opts.formatScore ? opts.formatScore(mean) : mean.toFixed(1)) : "–");
      return { best: best.data && best.data.length ? best.data[0].score : null };
    } catch (err) {
      console.error("[game-shell] stats failed", err);
      return { best: null };
    }
  }

  // ---- leaderboard ----
  function renderLeaderboardFrame() {
    const box = opts.els.leaderboard;
    box.replaceChildren(
      el("div", { class: "gs-lb-head" },
        el("h2", { class: "gs-card-title", text: "Leaderboard" }),
        el("div", { class: "gs-tabs", role: "group", "aria-label": "Leaderboard range" },
          el("button", { type: "button", class: "gs-tab", "data-tab": "all", "aria-pressed": "true", text: "All-time", onclick: () => setTab("all") }),
          el("button", { type: "button", class: "gs-tab", "data-tab": "month", "aria-pressed": "false", text: "This month", onclick: () => setTab("month") }))),
      el("div", { class: "gs-lb-body" }));
  }
  function setTab(t) {
    lbTab = t;
    for (const b of opts.els.leaderboard.querySelectorAll(".gs-tab")) b.setAttribute("aria-pressed", b.dataset.tab === t ? "true" : "false");
    loadLeaderboard();
  }
  async function loadLeaderboard() {
    const seq = ++lbSeq;
    const body = opts.els.leaderboard.querySelector(".gs-lb-body");
    body.replaceChildren(el("div", { class: "gs-muted", role: "status", text: "Loading the leaderboard…" }));
    const { sb, userId, game } = opts;
    const range = rangeBounds(lbTab, wallNow());
    const inRange = (q) => (range ? q.gte("created_at", range.from).lt("created_at", range.to) : q);
    try {
      const [top, latest] = await Promise.all([
        inRange(sb.from("game_scores").select("id, score, player_name, created_at").eq("game", game))
          .order("score", { ascending: false }).order("created_at", { ascending: true }).limit(20),
        sb.from("game_scores").select("id, score, created_at, player_name").eq("game", game).eq("user_id", userId).order("created_at", { ascending: false }).limit(1),
      ]);
      if (top.error || latest.error) throw top.error || latest.error;
      let pinned = null;
      const mine = latest.data && latest.data[0];
      const rows = top.data || [];
      const latestInRange = mine && (!range || (mine.created_at >= range.from && mine.created_at < range.to));
      if (mine && latestInRange && !rows.some((r) => r.id === mine.id)) {
        const higher = await inRange(sb.from("game_scores").select("id", { count: "exact", head: true }).eq("game", game).gt("score", mine.score));
        if (higher.error) throw higher.error;
        pinned = { ...mine, rank: (higher.count || 0) + 1 };
      }
      if (seq !== lbSeq) return;
      renderBoard(body, rows, mine && latestInRange ? mine.id : null, pinned);
    } catch (err) {
      console.error("[game-shell] leaderboard failed", err);
      if (seq !== lbSeq) return;
      body.replaceChildren(el("div", { class: "gs-error" }, el("span", { text: "Couldn't load the leaderboard." }),
        el("button", { type: "button", class: "gs-btn-secondary", text: "Retry", onclick: loadLeaderboard })));
    }
  }
  function boardRow(r, rank, isLatest) {
    const badge = rank <= 3 ? el("span", { class: `gs-rank gs-rank-badge gs-rank-${rank}`, text: ordinal(rank) }) : el("span", { class: "gs-rank", text: `#${rank}` });
    return el("li", { class: "gs-row" + (isLatest ? " gs-row-latest" : "") },
      el("div", { class: "gs-row-line" }, badge, el("span", { class: "gs-name", text: r.player_name || "Anonymous" }),
        isLatest ? el("span", { class: "gs-latest-tag", text: "latest" }) : null,
        el("span", { class: "gs-score", text: fmtScore(r.score) })),
      el("div", { class: "gs-row-when", text: whenLabel(r.created_at, wallNow()) }));
  }
  function renderBoard(body, rows, latestId, pinned) {
    if (!rows.length) { body.replaceChildren(el("div", { class: "gs-muted", text: "No runs yet. Play one to start the board." })); return; }
    const list = el("ol", { class: "gs-board" });
    rows.forEach((r) => {
      const firstSame = rows.findIndex((x) => x.score === r.score);
      list.append(boardRow(r, firstSame + 1, r.id === latestId));
    });
    body.replaceChildren(list);
    if (pinned) {
      body.append(el("div", { class: "gs-pinned" },
        el("div", { class: "gs-pinned-label", text: "Your latest run" }),
        el("div", { class: "gs-row gs-row-latest" },
          el("div", { class: "gs-row-line" }, el("span", { class: "gs-rank", text: ordinal(pinned.rank) }), el("span", { class: "gs-name", text: pinned.player_name || "Anonymous" }),
            el("span", { class: "gs-score", text: fmtScore(pinned.score) })),
          el("div", { class: "gs-row-when", text: whenLabel(pinned.created_at, wallNow()) }))));
    }
  }

  // ---- leaderboard name (profile) ----
  // Fetched at mount, so a Start tap normally knows synchronously whether to ask for a
  // name, and can open the layer and focus the input inside the same gesture.
  async function loadProfile() {
    profileState = "loading";
    const { sb, userId } = opts;
    try {
      const { data, error } = await sb.from("player_profiles").select("display_name").eq("user_id", userId).limit(1);
      if (error) throw error;
      if (data && data.length && data[0].display_name) { profileName = data[0].display_name; profileState = "have"; }
      else profileState = "none";
    } catch (err) {
      console.error("[game-shell] profile lookup failed", err);
      profileState = "error";
    }
    return profileState;
  }
  function startMessage(text) {
    let msg = opts.els.startButton.parentNode.querySelector(".gs-start-msg");
    if (!text) { if (msg) msg.remove(); return; }
    if (!msg) { msg = el("div", { class: "gs-start-msg", role: "alert" }); opts.els.startButton.after(msg); }
    msg.textContent = text;
  }
  // Start and Play again: everything up to opening the layer and focusing the input is
  // synchronous, so iOS treats the focus() as part of the tap and opens the keyboard.
  function onStartTap() {
    if (layer || document.querySelector(".gs-backdrop")) return;
    if (profileState === "have") { startMessage(null); openLayer(); return; }
    if (profileState === "none") { startMessage(null); showNameDialog(); return; }
    // Profile not known yet (slow network or an earlier failure): fall back to async.
    const btns = [opts.els.startButton, ...document.querySelectorAll("[data-gs-play-again]")];
    btns.forEach((b) => (b.disabled = true));
    loadProfile().then((state) => {
      btns.forEach((b) => (b.disabled = false));
      if (state === "have") { startMessage(null); openLayer(); }
      else if (state === "none") { startMessage(null); showNameDialog(); }
      else startMessage("Couldn't check your leaderboard name. Try again.");
    });
  }
  function showNameDialog() {
    const input = el("input", { type: "text", class: "gs-input", id: "gs-name-input", maxlength: "20", placeholder: "Your name", autocomplete: "nickname" });
    const msg = el("div", { class: "gs-dialog-msg", role: "alert" });
    const save = el("button", { type: "submit", class: "gs-btn", text: "Save and play" });
    const cancel = el("button", { type: "button", class: "gs-btn-secondary", text: "Cancel" });
    const form = el("form", { class: "gs-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "gs-name-title" },
      el("h2", { id: "gs-name-title", class: "gs-card-title", text: "What name should appear on the leaderboard?" }),
      el("label", { for: "gs-name-input", class: "gs-visually-hidden", text: "Leaderboard name" }), input, msg,
      el("div", { class: "gs-dialog-actions" }, cancel, save));
    const backdrop = el("div", { class: "gs-backdrop" }, form);
    document.body.append(backdrop);
    input.focus();
    cancel.addEventListener("click", () => backdrop.remove());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name.length < 2 || name.length > 20) { msg.textContent = "Use 2 to 20 characters."; return; }
      save.disabled = true; msg.textContent = "";
      // Input mode only: still inside the tap, open the layer and focus its input now
      // (iOS needs that); the countdown starts once the name is saved.
      const early = wantsInput();
      if (early) openLayer({ holdCountdown: true });
      const { error: err } = await opts.sb.from("player_profiles").insert({ user_id: opts.userId, display_name: name });
      if (err) {
        console.error("[game-shell] profile save failed", err);
        if (early) closeLayer();
        msg.textContent = "Couldn't save the name. Try again.";
        save.disabled = false;
        return;
      }
      profileName = name; profileState = "have";
      backdrop.remove();
      if (early) countdown(); else openLayer();
    });
  }

  // ---- run layer ----
  function lockScroll() {
    const y = window.scrollY;
    document.documentElement.classList.add("gs-locked");
    document.body.style.top = `-${y}px`;
    document.body.dataset.gsScrollY = String(y);
    document.addEventListener("touchmove", blockTouchMove, { passive: false });
  }
  function unlockScroll() {
    document.documentElement.classList.remove("gs-locked");
    const y = Number(document.body.dataset.gsScrollY || 0);
    document.body.style.top = "";
    delete document.body.dataset.gsScrollY;
    document.removeEventListener("touchmove", blockTouchMove, { passive: false });
    window.scrollTo(0, y);
  }
  function blockTouchMove(e) { if (!e.target.closest || !e.target.closest("[data-gs-scroll]")) e.preventDefault(); }

  // Size the layer to the visible area (above the on-screen keyboard).
  function fitToViewport() {
    const vv = window.visualViewport;
    if (!layer || !vv) return;
    layer.root.style.height = `${vv.height}px`;
    layer.root.style.top = `${vv.offsetTop}px`;
  }
  function watchViewport(on) {
    const vv = window.visualViewport;
    if (!vv) return;
    const m = on ? "addEventListener" : "removeEventListener";
    vv[m]("resize", fitToViewport);
    vv[m]("scroll", fitToViewport);
  }

  function buildLayer() {
    const timerText = el("span", { class: "gs-timer-text" });
    const bar = el("div", { class: "gs-timer-bar" }, el("div", { class: "gs-timer-fill" }));
    const scoreSlot = el("span", { class: "gs-score-slot" });
    const stage = el("div", { class: "gs-stage" });
    const input = wantsInput() ? el("input", {
      type: "text", inputmode: "numeric", pattern: "[0-9]*", autocomplete: "off", autocorrect: "off",
      autocapitalize: "off", spellcheck: "false", enterkeyhint: "done", "aria-label": "Answer", class: "gs-answer",
    }) : null;
    const hint = input ? el("button", { type: "button", class: "gs-hint", hidden: true, text: "Tap to bring back the keyboard" }) : null;
    const play = el("div", { class: "gs-play" }, stage, input, hint);
    const overlay = el("div", { class: "gs-overlay", hidden: true });
    const body = el("div", { class: "gs-body" }, play, overlay);
    const padSlot = el("div", { class: "gs-pad-slot" });
    const quitBtn = el("button", { type: "button", class: "gs-x", "aria-label": "Quit this run", text: "×", onclick: openConfirm });
    const root = el("div", { class: "gs-layer " + (input ? "gs-mode-input" : "gs-mode-pad") + (prefersReducedMotion() ? " gs-reduced" : ""), role: "dialog", "aria-modal": "true", "aria-label": opts.title },
      el("div", { class: "gs-strip" }, quitBtn, el("div", { class: "gs-strip-title", text: opts.title }), el("div", { class: "gs-strip-slots" }, timerText, scoreSlot)),
      bar, body, padSlot);
    return { root, stage, play, input, hint, overlay, padSlot, timerText, bar, scoreSlot, frozen: "" };
  }

  function focusInput() {
    if (layer && layer.input) { layer.input.focus({ preventScroll: true }); layer.hint.hidden = true; } // no-op in pad mode
  }
  function canType() { return run && run.state === "live"; }
  function wireInput() {
    const input = layer.input;
    if (!input) return;
    // Registered before the game's own listener: outside live play, undo any typing.
    input.addEventListener("input", (e) => {
      if (!canType()) { input.value = layer.frozen; e.stopImmediatePropagation(); }
    });
    input.addEventListener("blur", () => {
      if (layer && run && (run.state === "live" || run.state === "countdown")) layer.hint.hidden = false;
    });
    input.addEventListener("focus", () => { if (layer) layer.hint.hidden = true; });
    // A tap anywhere on the layer (except X and the overlay's own buttons) refocuses:
    // that tap is a user gesture, so iOS reopens the keyboard.
    layer.root.addEventListener("click", (e) => {
      if (e.target.closest(".gs-x") || e.target.closest(".gs-overlay button")) return;
      if (run && (run.state === "live" || run.state === "countdown")) focusInput();
    });
  }

  function openLayer(o) {
    document.dispatchEvent(new MouseEvent("click", { bubbles: true })); // closes any open nav dropdown
    layer = buildLayer();
    run = { clock: makeClock(), state: "countdown", game: null, finished: false };
    document.body.append(layer.root);
    lockScroll();
    if (layer.input) {
      wireInput();
      fitToViewport();      // input mode only: follow the visible area above the keyboard
      watchViewport(true);
      focusInput();         // synchronous, inside the tap that opened the layer
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    if (!(o && o.holdCountdown)) countdown();
  }
  function closeLayer() {
    if (!layer) return;
    clearCountdown();
    clearInterval(tickTimer); tickTimer = null;
    if (run && run.game) { try { run.game.destroy(); } catch (e) { console.error(e); } }
    run = null;
    if (layer.input) layer.input.blur(); // closes the keyboard
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    if (layer.input) watchViewport(false);
    layer.root.remove();
    layer = null;
    unlockScroll();
  }

  let countdownTimers = [];
  function clearCountdown() { countdownTimers.forEach(clearTimeout); countdownTimers = []; }
  // Overlays sit on top of the play area, which is faded out (opacity 0) rather than
  // hidden, so the answer input keeps its focus and the keyboard stays open.
  // Pad mode (as in 4e50d7e): the stage and pad are hidden while an overlay shows.
  function showOverlay(children, cls) {
    if (layer.input) layer.frozen = layer.input.value;
    layer.overlay.className = "gs-overlay" + (cls ? " " + cls : "");
    layer.overlay.replaceChildren(...children);
    layer.overlay.hidden = false;
    if (layer.input) { layer.play.classList.add("gs-dim"); layer.padSlot.classList.add("gs-dim"); }
    else { layer.stage.classList.add("gs-hidden"); layer.padSlot.classList.add("gs-hidden"); }
  }
  function hideOverlay() {
    layer.overlay.hidden = true;
    layer.overlay.replaceChildren();
    if (layer.input) { layer.play.classList.remove("gs-dim"); layer.padSlot.classList.remove("gs-dim"); }
    else { layer.stage.classList.remove("gs-hidden"); layer.padSlot.classList.remove("gs-hidden"); }
  }
  // Countdown: 3-2-1-Go before the game starts, 3-2-1 when resuming it.
  function countdown() {
    if (!run) return;
    clearCountdown();
    const first = !run.game;
    const steps = first ? ["3", "2", "1", "Go"] : ["3", "2", "1"];
    let t = 0;
    steps.forEach((s) => {
      countdownTimers.push(setTimeout(() => {
        if (!layer) return;
        showOverlay([el("div", { class: "gs-count", "aria-live": "assertive", text: s })], "gs-overlay-count");
      }, t));
      t += s === "Go" ? config.goMs : config.countdownMs;
    });
    countdownTimers.push(setTimeout(() => {
      if (!layer) return;
      hideOverlay();
      if (first) beginRun(); else { run.clock.resume(); run.state = "live"; }
    }, t));
    run.state = "countdown";
  }
  function beginRun() {
    const clock = run.clock;
    run.state = "live";
    if (layer.input) { layer.input.value = ""; layer.frozen = ""; }
    const ctx = {
      stage: layer.stage, input: layer.input, pad: layer.padSlot, isTouch: isTouch(), clock,
      setTimer(text, fraction) { layer.timerText.textContent = text; layer.bar.firstChild.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`; },
      setScore(text) { layer.scoreSlot.textContent = text; },
      finish(result) { finishRun(result); },
    };
    clock.start();
    run.game = opts.createRun(ctx);
    tickTimer = setInterval(tick, 50);
  }
  function tick() { if (run && run.state === "live" && run.game) run.game.tick(); }

  function pauseRun() {
    if (!run || !layer) return;
    if (run.state === "paused" || run.state === "confirm") return;
    clearCountdown();
    run.clock.pause();
    run.state = "paused";
    showOverlay([
      el("div", { class: "gs-overlay-title", text: "Paused" }),
      el("button", { type: "button", class: "gs-btn", text: "Resume", onclick: () => { if (layer.input) focusInput(); countdown(); } }),
    ], "gs-overlay-panel");
  }
  function onVisibility() { if (document.visibilityState === "hidden") pauseRun(); }
  function onBlur() { if (!isTouch()) pauseRun(); }

  let confirmPrev = null;
  function openConfirm() {
    if (!layer || !run) return;
    if (run.state === "confirm") return;
    confirmPrev = run.state;
    clearCountdown();
    run.clock.pause();
    run.state = "confirm";
    const keep = el("button", { type: "button", class: "gs-btn", text: "Keep playing", onclick: () => { if (layer.input) focusInput(); closeConfirm(); } });
    showOverlay([
      el("div", { class: "gs-overlay-title", text: "Quit this run? It won't be saved." }),
      el("div", { class: "gs-dialog-actions" }, keep, el("button", { type: "button", class: "gs-btn-secondary", text: "Quit", onclick: closeLayer })),
    ], "gs-overlay-panel");
  }
  function closeConfirm() {
    if (!run || run.state !== "confirm") return;
    if (confirmPrev === "paused") { run.state = "confirm-closed"; pauseRun(); return; }
    if (confirmPrev === "countdown") { countdown(); return; }
    hideOverlay();
    run.clock.resume();
    run.state = "live";
  }
  function onKeyDown(e) {
    if (!layer) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (run && run.state === "confirm") { if (layer.input) focusInput(); closeConfirm(); } else openConfirm();
      return;
    }
    if (layer.input) {
      // A hardware key is a user gesture: if the input lost focus mid-run, take it back
      // so the key lands in it. Outside live play, typed characters are swallowed.
      if (!canType()) { if (e.key.length === 1) e.preventDefault(); return; }
      if (document.activeElement !== layer.input) focusInput();
      return;
    }
    if (run && run.state === "live" && run.game && run.game.onKey(e.key)) e.preventDefault();
  }

  // ---- finishing and saving ----
  async function finishRun(result) {
    if (!run || run.finished) return;
    run.finished = true;
    closeLayer();
    const card = opts.els.resultCard;
    const gamePart = el("div", { class: "gs-result-game" });
    const rankLine = el("div", { class: "gs-result-rank", text: "Working out your rank…" });
    const bestLine = el("div", { class: "gs-result-best" });
    const status = el("div", { class: "gs-save-status", role: "status", text: "Saving…" });
    const retry = el("button", { type: "button", class: "gs-btn-secondary", text: "Retry", hidden: true });
    const again = el("button", { type: "button", class: "gs-btn gs-btn-wide", "data-gs-play-again": "", text: "Play again", onclick: onStartTap });
    card.replaceChildren(el("h2", { class: "gs-card-title", text: "Result" }), gamePart, el("div", { class: "gs-save-row" }, status, retry), again);
    opts.renderResult(gamePart, { score: result.score, stats: result.stats, rankEl: rankLine, bestEl: bestLine });
    if (!rankLine.isConnected) gamePart.after(rankLine, bestLine);
    opts.els.playCard.hidden = true;
    card.classList.add("gs-result");
    card.hidden = false;
    // Scroll once the card has been rendered and laid out (two frames), so the
    // target position is final. scroll-margin-top keeps it clear of the sticky nav.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    }));

    const row = { user_id: opts.userId, game: opts.game, score: result.score, played_date: londonDate(wallNow()), player_name: profileName, stats: result.stats };
    let saved = false, saving = false;
    const attempt = async () => {
      if (saved || saving) return;
      saving = true; retry.disabled = true; retry.hidden = true; status.textContent = "Saving…";
      const { error } = await opts.sb.from("game_scores").insert(row);
      saving = false;
      if (error) {
        console.error("[game-shell] save failed", error);
        status.textContent = "Couldn't save this run";
        retry.hidden = false; retry.disabled = false;
        return;
      }
      saved = true;
      status.textContent = "Saved";
      afterSave(result.score, rankLine, bestLine);
    };
    retry.addEventListener("click", attempt);
    attempt();
  }
  async function afterSave(score, rankLine, bestLine) {
    const { sb, game } = opts;
    try {
      const [higher, total] = await Promise.all([
        sb.from("game_scores").select("id", { count: "exact", head: true }).eq("game", game).gt("score", score),
        sb.from("game_scores").select("id", { count: "exact", head: true }).eq("game", game),
      ]);
      if (higher.error || total.error) throw higher.error || total.error;
      rankLine.textContent = `${ordinal((higher.count || 0) + 1)} of ${total.count || 0} runs, all-time`;
    } catch (err) { console.error("[game-shell] rank failed", err); rankLine.textContent = ""; }
    const s = await refreshStats();
    bestLine.textContent = s.best !== null ? `Your best: ${fmtScore(s.best)}` : "";
    loadLeaderboard();
  }

  window.GameShell = {
    mount, config, USE_SYSTEM_KEYBOARD,
    debug: { tick: () => tick(), get run() { return run; }, get layer() { return layer; }, ordinal, londonMidnight, londonDate, rangeBounds, whenLabel },
  };
})();
