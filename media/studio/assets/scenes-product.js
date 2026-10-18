window.__loomSceneFactories = window.__loomSceneFactories || [];
window.__loomSceneFactories.push(function ({ make, px, W, H, wide, M, MEASURE, fit, masked, place, textBlock, clean, T, rise, sink, fadeUp, shutter, picture, counter, imageFor, EIN, EOUT }) {
  return {
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
          // Complete the whole list early enough to read it together before the transition.
          const step = T(0.18);
          items.forEach((item, index) => {
            rise(tl, item.spans, t + index * step, 0.04, 0.75);
          });
        },
      };
    },

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

    end(shot) {
      const node = make("section", "shot");
      if (shot.tone === "field") node.classList.add("on-field");
      if (shot.tone === "surface") node.classList.add("on-surface");
      const layout = ["monument", "screen", "statement"].includes(shot.layout) ? shot.layout : "monument";
      const hasPicture = layout === "screen" && imageFor(shot.image || "shot");
      const link = place(textBlock("p", "text", clean(shot.link, 60), px(34)), { left: M, top: M });
      const author = place(textBlock("p", "text muted", clean(shot.author, 40), px(34)), { right: M, top: M, textAlign: "right" });
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
        fit(line, { min: px(36), max: px(58), maxLines: 3, width: Math.min(textWidth, MEASURE) });
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
});
