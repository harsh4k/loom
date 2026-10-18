// Reusable editorial compositions. Abstract marks carry rhythm; only sourced text claims facts.
window.__loomSceneFactories = window.__loomSceneFactories || [];
window.__loomSceneFactories.push(function ({ make, place, fit, masked, px, W, H, wide, M, T, rise, fadeUp, picture, imageFor, clean }) {
  function motif(kind, box) {
    const mark = place(make('div', 'signal-mark'), box);
    mark.setAttribute('aria-hidden', 'true');
    kind = ['orbit', 'bars', 'tiles'].includes(kind) ? kind : 'orbit';
    mark.dataset.motif = kind;
    const heights = [42, 68, 100, 82, 56, 88, 38];
    const parts = Array.from({ length: 7 }, (_, i) => {
      const band = make('i', 'signal-band');
      if (kind === 'bars') {
        Object.assign(band.style, { left: `${i * 14}%`, top: `${(100 - heights[i]) / 2}%`, width: '9%', height: `${heights[i]}%`, background: 'currentColor', border: 'none' });
      } else if (kind === 'tiles') {
        Object.assign(band.style, { left: `${i * 8}%`, top: `${i * 8}%`, width: '50%', height: '50%', borderWidth: `${px(5)}px`, background: i === 6 ? 'currentColor' : 'none' });
      } else {
        Object.assign(band.style, { inset: `${i * 6}%`, borderRadius: '50%', borderWidth: `${px(5)}px` });
      }
      mark.append(band);
      return band;
    });
    return { mark, parts };
  }
  return {
    signal(shot) {
      const node = make('section', 'shot');
      const side = wide ? Math.min(W * 0.42, H * 0.7) : Math.min(W - 2 * M, H * 0.43);
      const glyph = motif(shot.motif, wide ? { right: M, top: (H - side) / 2, width: side, height: side } : { left: (W - side) / 2, top: M, width: side, height: side });
      const text = place(make('h2', 'display'), { left: M, bottom: M, width: wide ? W * 0.43 : W - M * 2 });
      const spans = masked(text, clean(shot.text, 140));
      fit(text, { min: px(54), max: px(112), maxLines: 4, width: wide ? W * 0.43 : W - M * 2 });
      node.append(glyph.mark, text);
      return { node, exitSpans: [], enter(tl, t) {
        tl.fromTo(glyph.parts, { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, stagger: T(0.055), duration: T(0.7), ease: 'power3.out' }, t);
        rise(tl, spans, t + T(0.15), 0.035, 0.7);
      } };
    },
    kinetic(shot) {
      const node = make('section', 'shot kinetic-shot');
      const phrase = clean(shot.text, 90);
      const title = place(make('h2', 'display'), { left: M, top: H * 0.34, width: W - 2 * M });
      const spans = masked(title, phrase);
      fit(title, { min: px(66), max: px(180), maxLines: 3, width: W - 2 * M });
      const rule = place(make('div', 'kinetic-rule'), { left: M, top: H * 0.25, width: W - 2 * M, height: px(8) });
      const signature = place(make('p', 'text'), { left: M, bottom: M, fontSize: px(30) });
      signature.textContent = clean(shot.name, 60);
      node.append(rule, title, signature);
      return { node, exitSpans: [], enter(tl, t) {
        tl.fromTo(title, { scale: 0.86, transformOrigin: '0% 50%' }, { scale: 1, duration: T(0.8), ease: 'expo.out' }, t);
        tl.fromTo(rule, { scaleX: 0, transformOrigin: '0% 50%' }, { scaleX: 1, duration: T(0.65), ease: 'expo.out' }, t);
        rise(tl, spans, t + T(0.1), 0.035, 0.75);
        fadeUp(tl, signature, t + T(0.6));
      } };
    },
    poster(shot) {
      // One hero claim, the project name as a kicker, and the product itself shown big enough to
      // read on a phone. Without a screenshot, the motif becomes the picture.
      const node = make('section', 'shot editorial-poster');
      if (shot.tone === 'field') node.classList.add('on-field');
      if (shot.tone === 'surface') node.classList.add('on-surface');
      const image = imageFor(shot.image);
      let layout = ['monument', 'statement', 'screen'].includes(shot.layout) ? shot.layout : 'monument';
      if (layout === 'screen' && !image) layout = 'monument';
      const width = W - 2 * M;
      const visuals = [];
      // Text that leads the poster flows in one column, so a short line never leaves a gap and a
      // long one never runs into the next.
      const head = place(make('div', 'poster-head'), { left: M, top: M, width });
      const big = layout === 'monument' && !image;
      const name = make('h1', `display ${big ? 'poster-name' : 'poster-kicker'}`, clean(shot.name, 60));
      fit(name, big ? { min: px(72), max: px(176), maxLines: 1, single: true, width } : { min: px(30), max: px(40), maxLines: 1, single: true, width });
      const line = make('h2', 'display poster-line', clean(shot.line, 140));
      // Short claims grow to fill the line; long ones shrink to fit.
      const lineMax = { screen: 100, monument: image ? 96 : 64, statement: image ? 112 : 120 }[layout];
      fit(line, { min: px(44), max: px(lineMax), maxLines: big ? 3 : 4, width });
      head.append(name, line);
      const evidence = (shot.evidence || []).slice(0, big ? 2 : 1).map((text) => {
        const row = make('p', 'text poster-evidence', clean(text, 130));
        fit(row, { min: px(26), max: px(32), maxLines: 2, width: big ? W * 0.42 : width });
        return row;
      });
      // A monument poster without a screenshot keeps its facts in a column beside the motif.
      if (!big) head.append(...evidence);
      node.append(head);

      const foot = place(make('p', 'text poster-foot', [shot.author, shot.link].filter(Boolean).join('  /  ')), { left: M, bottom: M * 0.6, width });
      fit(foot, { min: px(18), max: px(22), maxLines: 1, width });

      if (image) {
        // The words and the screenshot share one column, so the picture takes whatever room the
        // words leave. It bleeds off the right edge on an accent plate. Wide terminal captures are
        // cropped from their top-left corner, where the content starts; pages keep their centre.
        const body = place(make('div', 'poster-body'), { left: 0, top: M, width: W, bottom: px(132) });
        Object.assign(head.style, { position: 'relative', left: '', top: '', marginLeft: `${M}px` });
        const media = make('div', 'poster-media');
        body.append(head, media);
        node.append(body);
        const size = ((window.__LOOM_FILM || {}).imageSizes || {})[shot.image];
        const left = layout === 'screen' ? M : Math.round(W * 0.24);
        const lift = px(22);
        const bleed = px(40);
        if (layout !== 'screen') {
          const glyph = motif(shot.motif, { left: M * 0.5, top: px(100), width: W * 0.42, bottom: px(60) });
          glyph.mark.classList.add('poster-mark');
          media.append(glyph.mark); visuals.push(glyph.mark);
        }
        const plate = place(make('div', 'poster-plate'), { left: left - lift, top: 0, right: lift - bleed, bottom: lift });
        const shown = picture(shot.image, { x: 0, y: 0, w: 1, h: 1, position: size && size.w / size.h > 1.6 ? '0% 0%' : '50% 30%' }, 'cover');
        Object.assign(shown.frame.style, { left: `${left}px`, top: `${lift}px`, right: `${-bleed}px`, bottom: '0px', width: '', height: '' });
        shown.frame.classList.add('poster-shot');
        media.append(plate, shown.frame); visuals.push(plate, shown.frame);
      } else if (layout === 'statement') {
        // A wide band of the motif under a large statement; rings stay round and bleed off the corner.
        const ring = shot.motif === 'orbit';
        const side = Math.round(W * 0.78);
        const glyph = motif(shot.motif, ring ? { left: W - side + px(120), top: H - side + px(120), width: side, height: side } : { left: M, top: H * 0.6, width: W - M, height: H * 0.26 });
        glyph.mark.classList.add('poster-mark');
        node.append(glyph.mark); visuals.push(glyph.mark);
      } else {
        // The motif at monument scale, bleeding off the bottom right; facts sit in the left column.
        // It sits right of the fact column, so it never runs under text.
        const left = Math.round(M + W * 0.42 + px(48));
        const side = W - left + px(60);
        const tall = shot.motif === 'bars';
        const glyph = motif(shot.motif, { left, top: tall ? Math.round(H * 0.36) : H - side + px(30), width: side, height: tall ? Math.round(H * 0.64) + px(60) : side });
        glyph.mark.classList.add('poster-mark');
        node.append(glyph.mark); visuals.push(glyph.mark);
        const column = place(make('div', 'poster-facts'), { left: M, bottom: M * 0.6 + px(64), width: W * 0.42 });
        column.append(...evidence);
        node.append(column);
      }
      node.append(foot);
      return { node, exitSpans: [], enter(tl, t) {
        // Posters settle early and hold; a snapshot is never dependent on a final type animation.
        [name, line, ...evidence, ...visuals, foot].forEach((el, i) => fadeUp(tl, el, t + i * 0.06, 0.5));
      } };
    },
  };
});
