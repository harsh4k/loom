// Loom studio engine: turns a film (tokens + a list of shots, written by Loom) into one GSAP
// timeline. Every scene is a fixed, well-made layout whose words, pictures, colours, faces and pace
// come from the film, so two films never look alike while each one stays well made.
// The timeline is built synchronously (HyperFrames reads its length on load); text is fitted to
// its box again once the fonts have loaded.
(function () {
  "use strict";
  const root = document.getElementById("root");
  // The film is made at any size: 1920x1080 for the posted video, 1080x1350 and 1080x1920 cuts,
  // and 1080x1350 for posters. Sizes below are written for a 1080px short edge and scaled by u.
  const W = Number(root.dataset.width) || 1080;
  const H = Number(root.dataset.height) || 1350;
  const u = Math.min(W, H) / 1080;
  const px = (n) => Math.round(n * u);
  const wide = W / H > 1.2;
  const M = px(wide ? 84 : 72);
  root.style.setProperty("--m", `${M}px`);
  document.documentElement.style.width = document.body.style.width = `${W}px`;
  document.documentElement.style.height = document.body.style.height = `${H}px`;
  // Text never runs the full width of a wide frame: a calm measure reads better.
  const MEASURE = wide ? Math.round(W * 0.66) : W - 2 * M;

  // Loom writes the film into assets/film.js before each render.
  let film = window.__LOOM_FILM || null;
  if (!film || !Array.isArray(film.shots) || !film.shots.length) {
    film = { tokens: {}, type: {}, motion: {}, shots: [{ scene: "statement", d: 3, text: "Loom studio needs a film to play." }] };
  }

  const stage = document.getElementById("stage");
  const report = { fitted: [], problems: [] };
  window.__loom = report;

  // ---- Tokens -----------------------------------------------------------------------------
  const tokens = film.tokens || {};
  // Tokens go on <html>, so body text inherits the film's ink rather than the default.
  const setVar = (name, value) => { if (value !== undefined && value !== null && value !== "") document.documentElement.style.setProperty(name, String(value)); };
  setVar("--bg", tokens.bg); setVar("--surface", tokens.surface); setVar("--ink", tokens.ink); setVar("--muted", tokens.muted);
  setVar("--accent", tokens.accent); setVar("--accent-ink", tokens.accentInk);
  setVar("--field-bg", tokens.fieldBg || tokens.ink); setVar("--field-ink", tokens.fieldInk || tokens.bg);
  const type = film.type || {};
  if (type.display) {
    setVar("--display", `"${type.display.family}", system-ui, sans-serif`);
    setVar("--display-weight", type.display.weight); setVar("--tracking", type.display.tracking);
    setVar("--leading", type.display.leading); setVar("--case", type.display.case);
  }
  if (type.text) { setVar("--text", `"${type.text.family}", system-ui, sans-serif`); setVar("--text-weight", type.text.weight); }
  document.body.style.background = tokens.bg || "";

  // ---- Motion language ----------------------------------------------------------------------
  const motion = film.motion || {};
  const tempo = Math.min(1.6, Math.max(0.6, Number(motion.tempo) || 1)); // >1 is faster
  const EASES = { sharp: ["expo.out", "expo.in"], smooth: ["power3.out", "power3.in"], soft: ["power2.out", "power2.in"], snap: ["back.out(1.4)", "power3.in"] };
  const [EIN, EOUT] = EASES[motion.ease] || EASES.sharp;
  const transition = ["cut", "mask", "wipe", "push"].includes(motion.transition) ? motion.transition : "mask";
  const T = (seconds) => seconds / tempo;
  // How words arrive, how far apart, and whether the frame drifts while a shot holds.
  const reveal = ["rise", "slide", "fade", "scale", "type"].includes(motion.reveal) ? motion.reveal : "rise";
  const spread = Math.min(2, Math.max(0.5, Number(motion.stagger) || 1));
  const drift = ["none", "push", "pan"].includes(motion.drift) ? motion.drift : "none";
  if (motion.fieldTone === "accent") { setVar("--field-bg", tokens.accent); setVar("--field-ink", tokens.accentInk); }

  // ---- Helpers ------------------------------------------------------------------------------
  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  };
  const clean = (value, limit = 200) => String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
  const images = film.images || {};
  const imageFor = (key) => (key && images[key] ? images[key] : "");

  // Wraps each word (or each letter, kept grouped by word) in a mask; returns the inner spans.
  function masked(target, text, letters) {
    target.textContent = "";
    const words = clean(text, 400).split(" ").filter(Boolean);
    words.forEach((word, index) => {
      const holder = make("span", "word");
      const parts = letters ? Array.from(word) : [word];
      for (const part of parts) { const mask = make("span", "mask"); mask.append(make("span", "", part)); holder.append(mask); }
      target.append(holder);
      if (index < words.length - 1) target.append(document.createTextNode(" "));
    });
    return Array.from(target.querySelectorAll(".mask > span"));
  }

  // Fits an element's font size between min and max so it stays inside its box within maxLines.
  const fits = [];
  function fit(el, { min, max, maxLines = 2, width, single = false }) {
    fits.push({ el, min, max, maxLines, width, single });
    el.style.fontSize = `${max}px`;
  }
  function lineCount(el) {
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.1;
    return Math.round(el.getBoundingClientRect().height / line);
  }
  function runFits() {
    for (const item of fits) {
      const { el, min, max, maxLines, single } = item;
      const width = item.width || el.getBoundingClientRect().width || W - 2 * M;
      let lo = min;
      let hi = max;
      const ok = (size) => {
        el.style.fontSize = `${size}px`;
        if (single) return el.scrollWidth <= width + 1;
        return lineCount(el) <= maxLines && el.scrollWidth <= width + 1;
      };
      if (ok(max)) { report.fitted.push(max); continue; }
      for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
      el.style.fontSize = `${Math.floor(lo)}px`;
      if (!ok(Math.floor(lo))) report.problems.push(`text too long: ${clean(el.textContent, 60)}`);
      report.fitted.push(Math.floor(lo));
    }
  }

  // Numbers like "8,192", "17th" or "100%" count up; anything else ("v0.3.4") is shown as is.
  function counter(el, value) {
    const match = /^(\D*)([\d,]+(?:\.\d+)?)(.*)$/.exec(value);
    if (!match || /\d\.\d.*\./.test(value)) return null;
    const target = Number(match[2].replace(/,/g, ""));
    if (!Number.isFinite(target)) return null;
    const decimals = (match[2].split(".")[1] || "").length;
    const grouped = match[2].includes(",");
    const proxy = { n: 0 };
    const paint = () => {
      el.textContent = `${match[1]}${proxy.n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped })}${match[3]}`;
    };
    return { proxy, target, paint };
  }

  // A picture in its box. With its size known it keeps its own shape (never cropped into a
  // tall frame), centred on the box's cross axis; "cover" fills the box instead.
  function picture(key, box, mode = "contain") {
    const src = imageFor(key);
    const size = (film.imageSizes || {})[key];
    if (mode === "contain" && size) {
      const scale = Math.min(box.w / size.w, box.h / size.h);
      const w = Math.round(size.w * scale);
      const h = Math.round(size.h * scale);
      box = { ...box, x: box.x + (box.align === "start" ? 0 : Math.round((box.w - w) / 2)), y: box.y + (box.valign === "start" ? 0 : box.valign === "end" ? box.h - h : Math.round((box.h - h) / 2)), w, h };
    }
    const frame = make("div", "frame");
    Object.assign(frame.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    frame.setAttribute("data-ui", "");
    const img = make("img");
    img.alt = "";
    img.src = src || "assets/blank.png";
    if (box.position) img.style.objectPosition = box.position;
    frame.append(img);
    return { frame, img, box };
  }

  // Rising words/letters, and their exit.
  const REVEALS = {
    rise: [{ yPercent: 112 }, { yPercent: 0 }, { yPercent: -112 }],
    slide: [{ xPercent: -105 }, { xPercent: 0 }, { xPercent: 105 }],
    fade: [{ y: 24, opacity: 0 }, { y: 0, opacity: 1 }, { opacity: 0 }],
    scale: [{ scale: 0.35, opacity: 0, transformOrigin: "50% 100%" }, { scale: 1, opacity: 1 }, { scale: 0.6, opacity: 0 }],
    type: [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }],
  };
  const [FROM, TO, OUT] = REVEALS[reveal];
  const rise = (tl, spans, t, each = 0.05, duration = 0.9) => (reveal === "type"
    ? tl.fromTo(spans, FROM, { ...TO, duration: 0.01, ease: "none", stagger: T(each * 0.9 * spread) }, t)
    : tl.fromTo(spans, FROM, { ...TO, duration: T(duration), ease: EIN, stagger: T(each * spread) }, t));
  const sink = (tl, spans, t) => tl.to(spans, { ...OUT, duration: T(0.4), ease: EOUT, stagger: T(0.02) }, t);
  const fadeUp = (tl, el, t, d = 0.7) => tl.fromTo(el, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: T(d), ease: EIN }, t);
  const shutter = (tl, frame, img, t, from = "bottom") => {
    const start = { bottom: "inset(100% 0% 0% 0%)", top: "inset(0% 0% 100% 0%)", left: "inset(0% 100% 0% 0%)", right: "inset(0% 0% 0% 100%)" }[from];
    tl.fromTo(frame, { clipPath: start }, { clipPath: "inset(0% 0% 0% 0%)", duration: T(1.1), ease: "power4.inOut" }, t);
    tl.fromTo(img, { scale: 1.14 }, { scale: 1, duration: T(1.6), ease: "power3.out" }, t);
  };

  // Places an element on the shared margin; numbers are pixels.
  function place(el, spot) {
    el.style.position = "absolute";
    for (const [key, value] of Object.entries(spot)) el.style[key] = typeof value === "number" ? `${value}px` : value;
    return el;
  }
  const textBlock = (tag, className, text, sizePx) => {
    const el = make(tag, className, text);
    if (sizePx) el.style.fontSize = `${sizePx}px`;
    return el;
  };

  // ---- Scenes -------------------------------------------------------------------------------
  // Each returns { node, enter(tl, t, d), exitSpans } and works at any frame size.
  const context = { make, px, W, H, wide, M, MEASURE, fit, masked, place, textBlock, clean, T, rise, sink, fadeUp, shutter, picture, counter, imageFor, EIN, EOUT };
  const SCENES = Object.assign({}, ...(window.__loomSceneFactories || []).map((factory) => factory(context)));

  // ---- Build --------------------------------------------------------------------------------
  const tl = gsap.timeline({ paused: true });
  const wipe = document.getElementById("wipe");
  // GSAP may parse the CSS translateY(101%) as a pixel y. Normalize that component before
  // animating yPercent, or -101% cancels the retained offset and leaves the wipe on screen.
  gsap.set(wipe, { y: 0, yPercent: 101 });
  const shots = film.shots.filter((shot) => SCENES[shot.scene]).slice(0, 12);
  let t = 0;
  const built = shots.map((shot) => {
    const scene = SCENES[shot.scene](shot);
    stage.append(scene.node);
    return { shot, scene };
  });
  built.forEach(({ shot, scene }, index) => {
    const d = Math.min(8, Math.max(1, Number(shot.d) || 2.5));
    const last = index === built.length - 1;
    const node = scene.node;
    if (index > 0 && transition === "push") tl.fromTo(node, { yPercent: 100 }, { yPercent: 0, duration: T(0.6), ease: "power4.inOut" }, t - T(0.6));
    tl.set(node, { visibility: "visible" }, index > 0 && transition === "push" ? t - T(0.6) : t);
    scene.enter(tl, t, d);
    if (drift === "push") tl.fromTo(node, { scale: 1 }, { scale: 1.03, duration: d, ease: "none" }, t);
    // A slight scale keeps the shot's own background covering the frame while it pans.
    if (drift === "pan") tl.fromTo(node, { scale: 1.025, xPercent: 1 }, { scale: 1.025, xPercent: -1, duration: d, ease: "none" }, t);
    if (!last) {
      const end = t + d;
      if (transition === "mask" && scene.exitSpans.length) sink(tl, scene.exitSpans, end - T(0.45));
      if (transition === "wipe") {
        tl.fromTo(wipe, { yPercent: 101 }, { yPercent: 0, duration: T(0.35), ease: "power3.in" }, end - T(0.35));
        tl.to(wipe, { yPercent: -101, duration: T(0.4), ease: "power3.out" }, end);
      }
      if (transition === "push") tl.to(node, { yPercent: -30, duration: T(0.6), ease: "power4.inOut" }, end - T(0.6));
      tl.set(node, { visibility: "hidden" }, end);
    }
    t += d;
  });
  tl.to({}, { duration: 0.01 }, t - 0.01);
  window.__loomTimeline = tl;

  // Fit text now with whatever faces are ready, then again once the real ones have loaded.
  runFits();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { report.fitted = []; report.problems = []; runFits(); report.fontsReady = true; });
})();
