window.__loomSceneFactories = window.__loomSceneFactories || [];
window.__loomSceneFactories.push(function ({ make, px, W, H, wide, M, MEASURE, fit, masked, place, textBlock, clean, T, rise, sink, fadeUp, shutter, picture, counter, imageFor, EIN, EOUT }) {
  return {
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

  };
});
