/*
 * Frame Loop — content script (isolated world)
 * Discovers the active <video> (piercing open/coerced shadow roots), detects
 * frame rate, and loops a frame-accurate A–B segment. UI lives in its own
 * shadow root so the host page's styles can't reach it.
 */
(() => {
  if (window.__frameLoopLoaded) return;
  window.__frameLoopLoaded = true;

  const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  const store = (chrome && chrome.storage && chrome.storage.local) || null;

  const state = {
    video: null,
    a: null,            // seconds (frame-snapped)
    b: null,            // seconds (frame-snapped)
    looping: false,
    detectedFps: null,  // measured
    manualFps: null,    // user override, wins when set
    pos: null,          // {left, top} or null for default corner
    hidden: false,
    minimized: false,
  };

  // ---- helpers -------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const effFps = () => state.manualFps || state.detectedFps || 30;
  const t2f = (t, fps = effFps()) => Math.round(t * fps);
  const f2t = (f, fps = effFps()) => f / fps;
  const snap = (t) => f2t(t2f(t));

  function fmtTime(t) {
    if (!isFinite(t)) return "--:--.---";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const ms = Math.floor((t - Math.floor(t)) * 1000);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }
  function snapFps(est) {
    let best = est, bd = Infinity;
    for (const f of COMMON_FPS) {
      const d = Math.abs(f - est);
      if (d < bd) { bd = d; best = f; }
    }
    return bd < 0.6 ? best : Math.round(est * 100) / 100;
  }

  // ---- video discovery (light DOM + open shadow roots) ---------------------
  function collect(root, out, seen) {
    if (!root || seen.has(root)) return;
    seen.add(root);
    let vids, all;
    try { vids = root.querySelectorAll("video"); } catch (e) { return; }
    vids.forEach((v) => out.add(v));
    try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
    for (const el of all) if (el.shadowRoot) collect(el.shadowRoot, out, seen);
  }
  function getVideos() {
    const out = new Set();
    collect(document, out, new Set());
    return [...out].filter((v) => v instanceof HTMLVideoElement);
  }
  function pickTarget(requireInView = false) {
    const vids = getVideos();
    if (!vids.length) return null;
    const playing = vids.filter((v) => !v.paused && !v.ended && v.readyState > 2);
    const pool = playing.length ? playing : vids;
    let best = null, score = 0;
    for (const v of pool) {
      const r = v.getBoundingClientRect();
      const visible = r.width >= 20 && r.height >= 20;
      if (!visible) continue;
      const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      if (requireInView && !inView) continue;
      const s = r.width * r.height * (inView ? 1 : 0.3);
      if (s > score) { score = s; best = v; }
    }
    return best;
  }

  // ---- target binding ------------------------------------------------------
  let boundVideo = null;
  const onTimeUpdate = () => {
    const v = state.video;
    if (state.looping && state.a != null && state.b != null && state.b > state.a
        && v && v.currentTime >= state.b - 1e-3) {
      try { v.currentTime = state.a; } catch (e) {}
    }
  };
  const onMeta = () => refresh();

  // Generation tokens: each (re)arm bumps the token so any older, still-pending
  // rVFC callback exits on its next fire and only the newest chain survives.
  let frameGen = 0, fpsGen = 0, onPlayArm = null;

  function armFrameLoop(v) {
    if (!v.requestVideoFrameCallback) return;
    const my = ++frameGen;
    const cb = (now, meta) => {
      if (v !== boundVideo || my !== frameGen) return;
      if (state.looping && state.a != null && state.b != null && state.b > state.a
          && meta && meta.mediaTime >= state.b - 1e-4) {
        try { v.currentTime = state.a; } catch (e) {}
      }
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }

  const fpsHistory = [];
  function armFpsProbe(v) {
    if (!v.requestVideoFrameCallback) return;
    const my = ++fpsGen;
    let last = null;
    const cb = (now, meta) => {
      if (v !== boundVideo || my !== fpsGen) return;
      if (last) {
        const df = meta.presentedFrames - last.presentedFrames;
        const dt = meta.mediaTime - last.mediaTime;
        if (dt > 0.25 && df > 0) {
          fpsHistory.push(df / dt);
          if (fpsHistory.length > 5) fpsHistory.shift();
          const avg = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;
          state.detectedFps = snapFps(avg);
        }
      }
      last = meta;
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }

  let uiBuilt = false;
  function setTarget(v) {
    if (!v || v === boundVideo) return;
    if (!uiBuilt) { buildUI(); uiBuilt = true; }
    if (boundVideo) {
      boundVideo.removeEventListener("timeupdate", onTimeUpdate);
      boundVideo.removeEventListener("loadedmetadata", onMeta);
      if (onPlayArm) boundVideo.removeEventListener("play", onPlayArm);
    }
    boundVideo = v;
    state.video = v;
    state.detectedFps = null;
    fpsHistory.length = 0;
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("loadedmetadata", onMeta);
    // Re-arm on play so probes/loop keep running after any pause or seek.
    onPlayArm = () => { armFrameLoop(v); armFpsProbe(v); };
    v.addEventListener("play", onPlayArm);
    armFrameLoop(v);
    armFpsProbe(v);
    startRaf();
    refresh();
  }

  // Switch control to whatever the user just played.
  document.addEventListener("play", (e) => {
    const target = (e.composedPath && e.composedPath()[0]) || e.target;
    if (target instanceof HTMLVideoElement) setTarget(target);
  }, true);



  // ---- actions -------------------------------------------------------------
  function setA() {
    const v = state.video; if (!v) return flash("No video detected");
    const t = snap(v.currentTime);
    if (state.b != null && t >= state.b) state.b = null;
    state.a = t; save(); refresh();
  }
  function setB() {
    const v = state.video; if (!v) return flash("No video detected");
    const t = snap(v.currentTime);
    if (state.a != null && t <= state.a) return flash("B must come after A");
    state.b = t; save(); refresh();
  }
  function nudge(which, dir) {
    const v = state.video; if (!v) return;
    const dur = isFinite(v.duration) ? v.duration : 1e9;
    let base = which === "a" ? state.a : state.b;
    if (base == null) base = v.currentTime;
    const t = clamp(f2t(t2f(base) + dir), 0, dur);
    if (which === "a") {
      if (state.b != null && t >= state.b) return flash("A must stay before B");
      state.a = t;
    } else {
      if (state.a != null && t <= state.a) return flash("B must stay after A");
      state.b = t;
    }
    save(); refresh();
  }
  function stepFrame(dir) {
    const v = state.video; if (!v) return;
    v.pause();
    const dur = isFinite(v.duration) ? v.duration : 1e9;
    const t = clamp(f2t(t2f(v.currentTime) + dir), 0, dur);
    try { v.currentTime = t; } catch (e) {}
    refresh();
  }
  function seekTo(which) {
    const v = state.video; if (!v) return;
    const t = which === "a" ? state.a : state.b;
    if (t == null) return;
    try { v.currentTime = t; } catch (e) {}
    refresh();
  }
  function toggleLoop() {
    if (state.a == null || state.b == null || state.b <= state.a) return flash("Set A and B first");
    state.looping = !state.looping;
    if (state.looping) {
      const v = state.video;
      if (v && (v.currentTime < state.a || v.currentTime >= state.b)) {
        try { v.currentTime = state.a; } catch (e) {}
      }
    }
    save(); refresh();
  }
  function clearAB() {
    state.a = state.b = null; state.looping = false; save(); refresh();
  }

  // ---- persistence ---------------------------------------------------------
  function save() {
    if (!store) return;
    try { store.set({ fl_pos: state.pos, fl_fps: state.manualFps, fl_hidden: state.hidden }); } catch (e) {}
  }
  function load() {
    return new Promise((res) => {
      if (!store) return res();
      try {
        store.get(["fl_pos", "fl_fps", "fl_hidden"], (d) => {
          if (d) {
            state.pos = d.fl_pos ?? null;
            state.manualFps = d.fl_fps ?? null;
            state.hidden = !!d.fl_hidden;
          }
          res();
        });
      } catch (e) { res(); }
    });
  }
  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.fl_hidden) {
        const isHidden = !!ch.fl_hidden.newValue;
        setHidden(isHidden);
        if (!isHidden && (!state.video || !document.contains(state.video))) {
          const t = pickTarget();
          if (t) setTarget(t);
        }
        startRaf(); // re-eval raf state
      }
      if (ch.fl_fps) { state.manualFps = ch.fl_fps.newValue ?? null; refresh(); }
    });
  }

  // ---- UI ------------------------------------------------------------------
  let ui = {}; // element refs
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel, .pill {
    position: fixed; z-index: 2147483647;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #E6EAF0;
  }
  .panel {
    right: 16px; bottom: 16px; width: 320px;
    background: rgba(20,24,31,.92);
    border: 1px solid #2C3442; border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.5);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    overflow: hidden; user-select: none;
  }
  button { transition: all 0.1s ease; margin: 0; padding: 0; }
  button:active:not(.dim):not(.disabled) { transform: scale(0.95); }
  .hd {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; cursor: grab;
    background: linear-gradient(180deg, rgba(255,255,255,.04), transparent);
    border-bottom: 1px solid #232A36;
  }
  .hd.drag { cursor: grabbing; }
  .glyph { width: 14px; height: 14px; border-radius: 4px; flex: none;
    background:
      radial-gradient(circle at 30% 70%, #F5A623 0 3px, transparent 3.5px),
      radial-gradient(circle at 70% 70%, #2DD4BF 0 3px, transparent 3.5px),
      #14181F;
    border: 1px solid #2C3442; }
  .title { font-size: 12px; font-weight: 650; letter-spacing: .02em; flex: 1; }
  .hbtn { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    border: 1px solid #2C3442; border-radius: 6px; background: #1A1F29;
    color: #A9B2C2; cursor: pointer; }
  .hbtn:hover { background: #232A36; color: #E6EAF0; }
  .body { padding: 12px; display: grid; gap: 12px; }
  .panel.min .body { display: none; }

  .target { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #8A94A6; }
  .target b { color: #C6CEDA; font-weight: 600; }
  .target .use { margin-left: auto; }
  .use { font-size: 11px; font-weight: 500; padding: 4px 8px; border-radius: 6px;
    border: 1px solid #2C3442; background: #1A1F29; color: #A9B2C2; cursor: pointer; }
  .use:hover { background: #232A36; color: #E6EAF0; }

  .readout { display: flex; align-items: baseline; gap: 10px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .cur { font-size: 20px; font-weight: 600; letter-spacing: .01em; }
  .cur .f { color: #E6EAF0; } .cur .tc { color: #8A94A6; font-size: 13px; margin-left: 6px; }
  .dur { margin-left: auto; font-size: 11px; color: #6B7688; }

  .track { position: relative; height: 26px; border-radius: 7px;
    background: #10141B; border: 1px solid #232A36; cursor: pointer; overflow: hidden; }
  .region { position: absolute; top: 0; bottom: 0; left: 0; width: 0;
    background: rgba(74,222,128,.16); }
  .region.off { background: rgba(255,255,255,.05); }
  .mk { position: absolute; top: -2px; bottom: -2px; width: 2px; z-index: 2; box-shadow: 0 0 4px rgba(0,0,0,.5); }
  .mk.a { background: #F5A623; } .mk.b { background: #2DD4BF; }
  .mk .cap { position: absolute; top: 0; left: -6px; width: 14px; height: 12px;
    font-size: 8px; font-weight: 700; text-align: center; line-height: 12px;
    border-radius: 3px; color: #0B0E13; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
  .mk.a .cap { background: #F5A623; } .mk.b .cap { background: #2DD4BF; }
  .head { position: absolute; top: 0; bottom: 0; width: 2px; background: #E6EAF0; box-shadow: 0 0 6px rgba(255,255,255,.6); z-index: 3; pointer-events: none; }

  .ab { display: grid; gap: 8px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .chip { width: 20px; height: 20px; border-radius: 6px; flex: none; display: flex;
    align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: #0B0E13; }
  .chip.a { background: #F5A623; } .chip.b { background: #2DD4BF; }
  .set { flex: none; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 6px;
    border: 1px solid #2C3442; background: #1A1F29; color: #E6EAF0; cursor: pointer; height: 24px; }
  .set:hover { background: #232A36; }
  .val { flex: 1; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #C6CEDA;
    text-align: right; padding-right: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .val.empty { color: #58616F; }
  .nb, .go { width: 24px; height: 24px; flex: none; display: flex; align-items: center; justify-content: center;
    border: 1px solid #2C3442; border-radius: 6px; background: #1A1F29; color: #A9B2C2; cursor: pointer; }
  .nb:hover, .go:hover { background: #232A36; color: #E6EAF0; }
  .nb.dim, .go.dim { opacity: .35; pointer-events: none; }
  
  .loop { width: 100%; padding: 8px; border-radius: 8px; cursor: pointer; font-size: 13px;
    font-weight: 600; letter-spacing: .02em; color: #E6EAF0;
    border: 1px solid #2C3442; background: #1A1F29; }
  .loop:hover { background: #232A36; }
  .loop.on { background: #123524; border-color: #1E5137; color: #7BF3B0; }
  .loop.disabled { opacity: .45; pointer-events: none; }

  .foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #6B7688; }
  .fps { display: flex; align-items: center; gap: 6px; }
  .fps label { color: #8A94A6; font-weight: 500; }
  .fps input { width: 54px; height: 22px; font-family: ui-monospace, monospace; font-size: 12px;
    padding: 0 6px; border-radius: 6px; border: 1px solid #2C3442;
    background: #10141B; color: #E6EAF0; text-align: center; }
  .fps .auto { padding: 3px 6px; height: 22px; border-radius: 6px; border: 1px solid #2C3442;
    background: #1A1F29; color: #8A94A6; cursor: pointer; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .fps .auto.on { color: #7BF3B0; border-color: #1E5137; }
  .clear { margin-left: auto; color: #8A94A6; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .clear:hover { color: #E6EAF0; }
  .status { min-height: 14px; font-size: 11px; color: #F5A623; text-align: center; }

  .keys { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: #6B7688; }
  .keys kbd { font-family: ui-monospace, monospace; background: #10141B; border: 1px solid #2C3442;
    border-radius: 4px; padding: 2px 4px; color: #A9B2C2; font-size: 9.5px; }

  .pill { right: 16px; bottom: 16px; width: 40px; height: 40px; border-radius: 12px;
    display: none; place-items: center; cursor: pointer; background: rgba(20,24,31,.92);
    border: 1px solid #2C3442; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
  .pill .glyph { width: 18px; height: 18px; }

  button:focus-visible, .track:focus-visible, input:focus-visible { outline: 2px solid #4C8CF5; outline-offset: 1px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;

  function buildUI() {
    const host = document.createElement("div");
    host.id = "frame-loop-host";
    (document.documentElement || document.body).appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="pill" title="Open Frame Loop"><span class="glyph"></span></div>
      <div class="panel">
        <div class="hd">
          <span class="glyph"></span>
          <span class="title">Frame Loop</span>
          <button class="hbtn min" title="Minimize"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
          <button class="hbtn close" title="Hide"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="body">
          <div class="target">Controlling <b class="tgt">no video</b>
            <button class="use" title="Target the largest visible video">Use largest</button>
          </div>
          <div class="readout">
            <span class="cur"><span class="f">frame –</span><span class="tc">--:--.---</span></span>
            <span class="dur">/ –</span>
          </div>
          <div class="track" tabindex="0" title="Click to seek">
            <div class="region off"></div>
            <div class="mk a" style="left:-10px"><span class="cap">A</span></div>
            <div class="mk b" style="left:-10px"><span class="cap">B</span></div>
            <div class="head" style="left:0"></div>
          </div>
          <div class="ab">
            <div class="row">
              <span class="chip a">A</span>
              <button class="set setA">Set A</button>
              <button class="nb dim aMinus" title="A −1 frame"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
              <button class="nb dim aPlus" title="A +1 frame"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button>
              <button class="go dim aGo" title="Seek to A"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>
              <span class="val empty aVal">—</span>
            </div>
            <div class="row">
              <span class="chip b">B</span>
              <button class="set setB">Set B</button>
              <button class="nb dim bMinus" title="B −1 frame"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
              <button class="nb dim bPlus" title="B +1 frame"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button>
              <button class="go dim bGo" title="Seek to B"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>
              <span class="val empty bVal">—</span>
            </div>
          </div>
          <button class="loop disabled loopBtn">Loop A–B</button>
          <div class="foot">
            <span class="fps">
              <label>fps</label>
              <input class="fpsIn" type="number" step="0.001" min="1" max="240" />
              <button class="auto on autoBtn" title="Auto-detect frame rate">auto</button>
            </span>
            <span class="clear clearBtn">clear A/B</span>
          </div>
          <div class="status statusLine"></div>
          <div class="keys">
            <span><kbd>[</kbd> set A</span>
            <span><kbd>]</kbd> set B</span>
            <span><kbd>\\</kbd> loop</span>
            <span><kbd>,</kbd> / <kbd>.</kbd> step frame</span>
          </div>
        </div>
      </div>`;

    const q = (s) => root.querySelector(s);
    ui = {
      root, host,
      pill: q(".pill"), panel: q(".panel"), hd: q(".hd"),
      min: q(".min"), close: q(".close"),
      tgt: q(".tgt"), use: q(".use"),
      curF: q(".cur .f"), curTc: q(".cur .tc"), dur: q(".dur"),
      track: q(".track"), region: q(".region"), mkA: q(".mk.a"), mkB: q(".mk.b"), head: q(".head"),
      setA: q(".setA"), setB: q(".setB"),
      aMinus: q(".aMinus"), aPlus: q(".aPlus"), aGo: q(".aGo"), aVal: q(".aVal"),
      bMinus: q(".bMinus"), bPlus: q(".bPlus"), bGo: q(".bGo"), bVal: q(".bVal"),
      loopBtn: q(".loopBtn"), fpsIn: q(".fpsIn"), autoBtn: q(".autoBtn"),
      clearBtn: q(".clearBtn"), status: q(".statusLine"),
    };

    // wire events
    ui.setA.onclick = setA;
    ui.setB.onclick = setB;
    ui.aMinus.onclick = () => nudge("a", -1);
    ui.aPlus.onclick = () => nudge("a", 1);
    ui.bMinus.onclick = () => nudge("b", -1);
    ui.bPlus.onclick = () => nudge("b", 1);
    ui.aGo.onclick = () => seekTo("a");
    ui.bGo.onclick = () => seekTo("b");
    ui.loopBtn.onclick = toggleLoop;
    ui.clearBtn.onclick = clearAB;
    ui.use.onclick = () => { const t = pickTarget(); if (t) { setTarget(t); flash("Targeted largest video"); } else flash("No video found"); };
    ui.min.onclick = () => { state.minimized = !state.minimized; ui.panel.classList.toggle("min", state.minimized); ui.min.textContent = state.minimized ? "+" : "–"; if (!state.minimized) startRaf(); };
    ui.close.onclick = () => setHidden(true);
    ui.pill.onclick = () => { setHidden(false); startRaf(); };

    ui.autoBtn.onclick = () => {
      if (state.manualFps) { state.manualFps = null; }      // back to auto
      else { state.manualFps = Math.round(effFps() * 1000) / 1000; } // pin current
      save(); refresh();
    };
    ui.fpsIn.onchange = () => {
      const v = parseFloat(ui.fpsIn.value);
      if (v > 0) { state.manualFps = v; save(); refresh(); }
    };
    ui.fpsIn.onkeydown = (e) => e.stopPropagation();

    // seek by clicking timeline
    ui.track.addEventListener("click", (e) => {
      const v = state.video; if (!v || !isFinite(v.duration)) return;
      const r = ui.track.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      try { v.currentTime = frac * v.duration; } catch (err) {}
      refresh();
    });

    // dragging
    let drag = null;
    ui.hd.addEventListener("mousedown", (e) => {
      if (e.target.closest(".hbtn")) return;
      const r = ui.panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      ui.hd.classList.add("drag");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const w = ui.panel.offsetWidth, h = ui.panel.offsetHeight;
      const left = clamp(e.clientX - drag.dx, 0, innerWidth - w);
      const top = clamp(e.clientY - drag.dy, 0, innerHeight - h);
      state.pos = { left, top };
      applyPos();
    });
    window.addEventListener("mouseup", () => { if (drag) { drag = null; ui.hd.classList.remove("drag"); save(); } });

    applyPos();
    setHidden(state.hidden);
    refresh();
  }

  function applyPos() {
    if (!ui.panel) return;
    if (state.pos) {
      ui.panel.style.left = state.pos.left + "px";
      ui.panel.style.top = state.pos.top + "px";
      ui.panel.style.right = "auto";
      ui.panel.style.bottom = "auto";
    }
  }
  function setHidden(h) {
    state.hidden = h;
    if (ui.panel) ui.panel.style.display = h ? "none" : "block";
    if (ui.pill) ui.pill.style.display = h ? "grid" : "none";
    save();
  }

  let statusTimer = null;
  function flash(msg) {
    if (!ui.status) return;
    ui.status.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { if (ui.status) ui.status.textContent = ""; }, 2200);
  }

  function refresh() {
    if (!ui.panel) return;
    const v = state.video;
    const fps = effFps();

    // target label
    if (v) {
      const vw = v.videoWidth, vh = v.videoHeight;
      ui.tgt.textContent = vw ? `${vw}×${vh} video` : "video";
    } else {
      ui.tgt.textContent = "no video";
    }

    // readout
    if (v) {
      ui.curF.textContent = `frame ${t2f(v.currentTime, fps)}`;
      ui.curTc.textContent = fmtTime(v.currentTime);
      ui.dur.textContent = isFinite(v.duration) ? `/ ${t2f(v.duration, fps)} · ${fmtTime(v.duration)}` : "/ live";
    } else {
      ui.curF.textContent = "frame –"; ui.curTc.textContent = "--:--.---"; ui.dur.textContent = "/ –";
    }

    // A/B values
    const showVal = (el, t) => {
      if (t == null) { el.textContent = "—"; el.classList.add("empty"); }
      else { el.textContent = `f${t2f(t, fps)} · ${fmtTime(t)}`; el.classList.remove("empty"); }
    };
    showVal(ui.aVal, state.a);
    showVal(ui.bVal, state.b);

    // enable/dim nudge + go
    ui.aGo.classList.toggle("dim", state.a == null);
    ui.bGo.classList.toggle("dim", state.b == null);
    ui.aMinus.classList.toggle("dim", !v);
    ui.aPlus.classList.toggle("dim", !v);
    ui.bMinus.classList.toggle("dim", !v);
    ui.bPlus.classList.toggle("dim", !v);

    // timeline
    const dur = v && isFinite(v.duration) ? v.duration : 0;
    const pct = (t) => dur ? clamp((t / dur) * 100, 0, 100) : 0;
    if (dur && state.a != null) { ui.mkA.style.left = `calc(${pct(state.a)}% - 1px)`; ui.mkA.style.display = "block"; }
    else ui.mkA.style.display = "none";
    if (dur && state.b != null) { ui.mkB.style.left = `calc(${pct(state.b)}% - 1px)`; ui.mkB.style.display = "block"; }
    else ui.mkB.style.display = "none";
    if (dur && state.a != null && state.b != null && state.b > state.a) {
      ui.region.style.left = pct(state.a) + "%";
      ui.region.style.width = (pct(state.b) - pct(state.a)) + "%";
      ui.region.classList.toggle("off", !state.looping);
    } else {
      ui.region.style.width = "0%";
    }
    if (v) ui.head.style.left = `calc(${pct(v.currentTime)}% - 1px)`;

    // loop button
    const valid = state.a != null && state.b != null && state.b > state.a;
    ui.loopBtn.classList.toggle("disabled", !valid);
    ui.loopBtn.classList.toggle("on", state.looping && valid);
    ui.loopBtn.textContent = state.looping && valid ? "◼ Looping A–B" : "Loop A–B";

    // fps controls
    const manual = state.manualFps != null;
    if (document.activeElement !== ui.fpsIn) {
      ui.fpsIn.value = String(Math.round(fps * 1000) / 1000);
    }
    ui.autoBtn.classList.toggle("on", !manual);
    ui.autoBtn.textContent = manual ? "manual" : "auto";
  }

  // ---- keyboard ------------------------------------------------------------
  function typing(e) {
    const t = e.target;
    const tag = (t && t.tagName || "").toLowerCase();
    return (t && t.isContentEditable) || tag === "input" || tag === "textarea" || tag === "select";
  }
  window.addEventListener("keydown", (e) => {
    if (state.hidden || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case "[": setA(); break;
      case "]": setB(); break;
      case "\\": toggleLoop(); break;
      case ",": stepFrame(-1); break;
      case ".": stepFrame(1); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---- boot ----------------------------------------------------------------
  let rafId = null;
  function startRaf() {
    if (!rafId && ui.panel && !state.hidden && !state.minimized && state.video) {
      rafId = requestAnimationFrame(raf);
    }
  }
  function raf() {
    if (ui.panel && !state.hidden && !state.minimized && state.video) {
      refresh();
      rafId = requestAnimationFrame(raf);
    } else {
      rafId = null;
    }
  }

  load().then(() => {
    // Wait for user interaction or play events to target a video
  });
})();
