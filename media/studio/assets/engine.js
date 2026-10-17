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
  const SCENES = {
    // The name as architecture: as wide as the frame, letters rising from their baseline.
    monument(shot) {
      const node = make("section", "shot");
      const name = make("h1", "display");
      name.style.whiteSpace = "nowrap";
      const letters = masked(name, shot.name, true);
      const bleed = shot.variant === "bleed";
      const top = shot.variant === "top";
      place(name, { left: bleed ? -px(6) : M, [top ? "top" : "bottom"]: top ? M - px(24) : M - px(34) });
      fit(name, { min: px(90), max: px(wide ? 460 : 520), single: true, width: bleed ? W + px(12) : W - 2 * M });
      node.append(name);
      let line = null;
      if (shot.line) {
        line = place(textBlock("p", "text", clean(shot.line, 120), px(40)), { left: M, maxWidth: px(760), [top ? "bottom" : "top"]: M });
        node.append(line);
      }
      return {
        node, exitSpans: letters,
        enter(tl, t, d) {
          rise(tl, letters, t, 0.035, 1.0);
          if (line) fadeUp(tl, line, t + T(0.45));
          tl.fromTo(name, { scale: 1 }, { scale: 1.035, transformOrigin: top ? "0% 0%" : "0% 100%", duration: d, ease: "none" }, t);
        },
      };
    },

    // One sentence set large on the margin.
    statement(shot) {
      const node = make("section", "shot");
      if (shot.variant === "field") node.classList.add("on-field");
      const text = make("p", "display");
      const spot = shot.variant === "top" ? { top: M } : shot.variant === "middle" ? { top: "50%", transform: "translateY(-50%)" } : { bottom: M };
      place(text, { left: M, width: MEASURE, ...spot });
      const words = masked(text, clean(shot.text, 140));
      fit(text, { min: px(60), max: px(wide ? 150 : 132), maxLines: wide ? 3 : 4, width: MEASURE });
      node.append(text);
      return { node, exitSpans: words, enter(tl, t) { rise(tl, words, t, 0.045, 0.85); } };
    },

    // A real number, counted up, with what it means underneath.
    number(shot) {
      const node = make("section", "shot");
      if (shot.variant === "field") node.classList.add("on-field");
      const value = make("div", "display num", clean(shot.value, 16));
      value.style.whiteSpace = "nowrap";
      place(value, wide ? { left: M, top: "50%", transform: "translateY(-58%)" } : { left: M, top: Math.round(H * 0.2) });
      fit(value, { min: px(150), max: px(wide ? 460 : 420), single: true, width: wide ? Math.round(W * 0.52) : W - 2 * M });
      const label = make("p", "text");
      place(label, wide ? { right: M, bottom: M, width: Math.round(W * 0.34) } : { left: M, right: M, bottom: M });
      const words = masked(label, clean(shot.label, 90));
      fit(label, { min: px(42), max: px(64), maxLines: 3, width: wide ? Math.round(W * 0.34) : W - 2 * M });
      node.append(value, label);
      const count = counter(value, clean(shot.value, 16));
      return {
        node, exitSpans: words,
        enter(tl, t) {
          tl.fromTo(value, { yPercent: 24, opacity: 0 }, { yPercent: 0, opacity: 1, duration: T(0.8), ease: EIN }, t);
          if (count) tl.fromTo(count.proxy, { n: 0 }, { n: count.target, duration: T(1.1), ease: "power3.out", onUpdate: count.paint }, t);
          rise(tl, words, t + T(0.35), 0.05, 0.75);
        },
      };
    },

    // A real screenshot of the product, opened like a shutter.
    screen(shot) {
      const node = make("section", "shot");
      const full = shot.variant === "full";
      const captionH = shot.caption ? px(wide ? 150 : 210) : 0;
      const box = full ? { x: 0, y: 0, w: W, h: H - captionH } : { x: M, y: M, w: W - 2 * M, h: H - 2 * M - captionH };
      const shown = picture(shot.image || "shot", box, full ? "cover" : "contain");
      const { frame, img } = shown;
      node.append(frame);
      let words = [];
      if (shot.caption) {
        const caption = make("p", "text");
        if (full) place(caption, { left: M, width: MEASURE, bottom: Math.round(captionH / 2 - px(28)) });
        else place(caption, { left: M, width: MEASURE, top: shown.box.y + shown.box.h + px(40) });
        words = masked(caption, clean(shot.caption, 110));
        fit(caption, { min: px(34), max: px(46), maxLines: wide ? 1 : 2, width: MEASURE });
        node.append(caption);
      }
      return {
        node, exitSpans: words,
        enter(tl, t, d) {
          shutter(tl, frame, img, t, shot.from || "bottom");
          tl.to(img, { scale: 1.05, duration: Math.max(0.1, d - T(1.6)), ease: "none" }, t + T(1.6));
          if (words.length) rise(tl, words, t + T(0.6), 0.04, 0.7);
        },
      };
    },

    // Picture on one side, the words on a surface on the other.
    split(shot) {
      const node = make("section", "shot on-surface");
      const pictureBox = wide ? { x: Math.round(W * 0.46), y: 0, w: Math.round(W * 0.54), h: H } : { x: 0, y: 0, w: W, h: Math.round(H * 0.56) };
      const { frame, img } = picture(shot.image || "shot", pictureBox, "cover");
      const textWidth = wide ? Math.round(W * 0.46) - 2 * M : W - 2 * M;
      const title = make("h2", "display");
      place(title, { left: M, width: textWidth, bottom: shot.text ? px(wide ? 330 : 250) : M });
      const titleWords = masked(title, clean(shot.title, 60));
      fit(title, { min: px(60), max: px(116), maxLines: 2, width: textWidth });
      node.append(frame, title);
      let body = null;
      if (shot.text) {
        body = place(make("p", "text muted", clean(shot.text, 140)), { left: M, width: textWidth, bottom: M });
        fit(body, { min: px(30), max: px(40), maxLines: 4, width: textWidth });
        node.append(body);
      }
      return {
        node, exitSpans: titleWords,
        enter(tl, t) {
          shutter(tl, frame, img, t, wide ? "right" : "top");
          rise(tl, titleWords, t + T(0.35), 0.05, 0.85);
          if (body) fadeUp(tl, body, t + T(0.7));
        },
      };
    },

    // A real command typed into a real terminal: the one place monospace belongs.
    terminal(shot) {
      const node = make("section", "shot");
      const term = make("div", "term");
      term.setAttribute("data-ui", "");
      Object.assign(term.style, { fontSize: `${px(wide ? 44 : 34)}px`, padding: `${px(56)}px ${px(56)}px ${px(64)}px`, borderRadius: `${px(18)}px`, left: wide ? `${Math.round(W * 0.16)}px` : `${M}px`, right: wide ? `${Math.round(W * 0.16)}px` : `${M}px` });
      const commandLine = make("div");
      const typed = make("span", "", "");
      commandLine.append(make("span", "prompt", "$ "), typed, make("span", "cursor"));
      term.append(commandLine);
      const outputs = (Array.isArray(shot.lines) ? shot.lines : []).slice(0, 6).map((line) => {
        const out = make("div", "out", clean(line, 60));
        term.append(out);
        return out;
      });
      node.append(term);
      const command = clean(shot.command, 48);
      const typing = Math.max(0.4, command.length * 0.045);
      return {
        node, exitSpans: [],
        enter(tl, t) {
          tl.fromTo(term, { y: px(24), opacity: 0 }, { y: 0, opacity: 1, duration: T(0.6), ease: EIN }, t);
          const state = { n: 0 };
          tl.fromTo(state, { n: 0 }, { n: command.length, duration: typing, ease: "none", onUpdate() { typed.textContent = command.slice(0, Math.round(state.n)); } }, t + T(0.4));
          tl.set(outputs, { opacity: 0 }, t);
          outputs.forEach((out, index) => tl.set(out, { opacity: 1 }, t + T(0.4) + typing + 0.2 + index * 0.16));
        },
      };
    },

    // Three or four things it does, each taking the stage in turn.
    list(shot) {
      const node = make("section", "shot");
      const title = shot.title ? place(textBlock("p", "text muted", clean(shot.title, 80), px(38)), { left: M, top: M, width: MEASURE }) : null;
      if (title) node.append(title);
      const box = place(make("div"), { left: M, bottom: M, width: MEASURE });
      const items = (Array.isArray(shot.items) ? shot.items : []).slice(0, 4).map((item) => {
        const row = make("div", "display");
        row.style.marginTop = `${px(26)}px`;
        const spans = masked(row, clean(item, 60));
        box.append(row);
        fit(row, { min: px(48), max: px(wide ? 84 : 92), maxLines: 2, width: MEASURE });
        return { row, spans };
      });
      node.append(box);
      return {
        node, exitSpans: items.flatMap((item) => item.spans),
        enter(tl, t, d) {
          if (title) fadeUp(tl, title, t);
          const step = Math.max(0.45, (d - 1) / Math.max(1, items.length));
          items.forEach((item, index) => {
            rise(tl, item.spans, t + index * step, 0.04, 0.75);
            if (index > 0) tl.to(items.slice(0, index).map((prev) => prev.row), { opacity: 0.3, duration: T(0.4), ease: EIN }, t + index * step);
          });
        },
      };
    },

    // The tools it is made with, flashed one after another like a type specimen.
    stack(shot) {
      const node = make("section", "shot");
      const items = (Array.isArray(shot.items) ? shot.items : []).slice(0, 8).map((item) => clean(item, 30)).filter(Boolean);
      const big = place(make("div", "display"), { left: M, top: "50%", transform: "translateY(-50%)" });
      big.style.whiteSpace = "nowrap";
      node.append(big);
      big.textContent = items.reduce((a, b) => (b.length > a.length ? b : a), "");
      fit(big, { min: px(80), max: px(240), single: true, width: W - 2 * M });
      let line = null;
      if (shot.line) { line = place(textBlock("p", "text muted", clean(shot.line, 100), px(40)), { left: M, bottom: M, width: MEASURE }); node.append(line); }
      return {
        node, exitSpans: [],
        enter(tl, t, d) {
          const each = Math.max(0.28, Math.min(0.6, (d - 0.8) / Math.max(1, items.length)));
          items.forEach((item, index) => {
            tl.call(() => { big.textContent = item; }, null, t + index * each);
            tl.fromTo(big, { yPercent: -40, opacity: 0 }, { yPercent: -50, opacity: 1, duration: Math.min(each, T(0.35)), ease: EIN, immediateRender: false }, t + index * each);
          });
          if (line) fadeUp(tl, line, t + T(0.3));
        },
      };
    },

    // A flat field of colour carrying a few words: a chapter break.
    field(shot) {
      const node = make("section", "shot on-field");
      const text = make("h2", "display");
      place(text, { left: M, width: MEASURE, top: "50%", transform: "translateY(-50%)" });
      const words = masked(text, clean(shot.text, 60));
      fit(text, { min: px(90), max: px(220), maxLines: 2, width: MEASURE });
      node.append(text);
      return {
        node, exitSpans: words,
        enter(tl, t) {
          tl.fromTo(node, { clipPath: "inset(100% 0% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: T(0.7), ease: "power4.inOut" }, t);
          rise(tl, words, t + T(0.3), 0.06, 0.8);
        },
      };
    },

    // One phrase running past the edges in two rows.
    marquee(shot) {
      const node = make("section", "shot");
      const phrase = clean(shot.text, 60);
      const rows = [0, 1].map((index) => {
        const row = place(make("div", "display", Array(4).fill(phrase).join(" — ")), { left: 0, top: Math.round(H * (index ? 0.52 : 0.24)) });
        row.style.whiteSpace = "nowrap";
        row.style.fontSize = `${px(180)}px`;
        if (index) row.classList.add("muted");
        node.append(row);
        return row;
      });
      return {
        node, exitSpans: [],
        enter(tl, t, d) {
          tl.fromTo(rows[0], { x: 0 }, { x: -px(900), duration: d, ease: "none" }, t);
          tl.fromTo(rows[1], { x: -px(900) }, { x: 0, duration: d, ease: "none" }, t);
        },
      };
    },

    // The end card, which is also the still image. Holds so it can be read.
    end(shot) {
      const node = make("section", "shot");
      if (shot.tone === "field") node.classList.add("on-field");
      if (shot.tone === "surface") node.classList.add("on-surface");
      const layout = ["monument", "screen", "statement"].includes(shot.layout) ? shot.layout : "monument";
      const hasPicture = layout === "screen" && imageFor(shot.image || "shot");
      const link = place(textBlock("p", "text", clean(shot.link, 60), px(28)), { left: M, top: M });
      const author = place(textBlock("p", "text muted", clean(shot.author, 40), px(28)), { right: M, top: M, textAlign: "right" });
      node.append(link, author);
      let pic = null;
      const textWidth = hasPicture && wide ? Math.round(W * 0.4) - M : W - 2 * M;
      if (hasPicture) {
        pic = picture(shot.image || "shot", wide ? { x: Math.round(W * 0.42), y: M + px(70), w: Math.round(W * 0.58) - M, h: H - 2 * M - px(70) } : { x: M, y: M + px(80), w: W - 2 * M, h: H - 2 * M - px(80) - px(470) });
        node.append(pic.frame);
      }
      const name = make("h1", "display");
      name.style.whiteSpace = "nowrap";
      const nameSpans = masked(name, clean(shot.name, 40), true);
      const line = make("p", "text muted", clean(shot.line, 140));
      if (layout === "statement") {
        line.className = "display";
        place(line, { left: M, top: M + px(110), width: MEASURE });
        fit(line, { min: px(60), max: px(112), maxLines: 4, width: MEASURE });
        place(name, { left: M, bottom: M });
        fit(name, { min: px(80), max: px(200), single: true, width: W - 2 * M });
      } else {
        place(name, { left: M, bottom: M });
        fit(name, { min: px(80), max: px(layout === "monument" ? 380 : 170), single: true, width: textWidth });
        // The line sits clear of the name at its largest size (descenders included).
        place(line, { left: M, width: Math.min(textWidth, MEASURE), bottom: M + px(layout === "monument" ? 410 : 190) });
        fit(line, { min: px(32), max: px(46), maxLines: 3, width: Math.min(textWidth, MEASURE) });
      }
      node.append(line, name);
      return {
        node, exitSpans: [],
        enter(tl, t) {
          if (pic) shutter(tl, pic.frame, pic.img, t, "bottom");
          rise(tl, nameSpans, t + T(pic ? 0.4 : 0), 0.035, 1.0);
          fadeUp(tl, line, t + T(0.5));
          fadeUp(tl, link, t + T(0.8), 0.6);
          fadeUp(tl, author, t + T(0.88), 0.6);
        },
      };
    },
  };

  // ---- Build --------------------------------------------------------------------------------
  const tl = gsap.timeline({ paused: true });
  const wipe = document.getElementById("wipe");
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
