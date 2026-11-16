// Sliding highlights for menu bars and dropdowns, shared by the home page and
// the doc pages. Every [data-glide] container (its value: the item selector,
// relative to the container) gets two marks drawn under its items:
//   .glide-sel  the pale plate with the green bar, on the selected item
//               ([aria-current], [aria-selected="true"], .on, or the summary
//               of a [data-current] menu);
//   .glide-hov  a hatched ghost that follows the pointer, keyboard focus, the
//               active option ([data-active]) or an open menu's summary, and
//               slides back to the selected item when the pointer leaves.
// [data-glide-hover] containers draw only the ghost (the rail has its own mark).
// Marks re-measure on resize and on attribute changes, so opening a menu or
// changing the selection needs no extra call. Reduced motion: they jump.
(() => {
  const SEL = '[aria-current], [aria-selected="true"], .on, [data-current] > summary';
  const mark = (cls) => {
    const el = document.createElement("span");
    el.className = cls;
    el.setAttribute("aria-hidden", "true");
    return el;
  };

  function glide(box) {
    const q = box.dataset.glide || ":scope > *";
    const items = () => [...box.querySelectorAll(q)];
    const hov = mark("glide-hov");
    const sel = "glideHover" in box.dataset ? null : mark("glide-sel");
    box.prepend(...[sel, hov].filter(Boolean));
    box.classList.add("glide-ready");
    items().forEach((i) => i.classList.add("glide-item"));
    let pointer = null;
    let focus = null;

    const owner = (t) =>
      t && items().find((i) => i.contains(t) || (i.localName === "summary" && i.parentElement.contains(t)));
    const visible = (i) => i && i.getClientRects().length > 0;

    // Positions are in the box's own (unscaled) pixels, so a box inside a
    // section scaled to fit still lines up.
    const place = (el, item) => {
      const c = box.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      const k = box.offsetWidth ? c.width / box.offsetWidth || 1 : 1;
      const x = (r.left - c.left) / k - box.clientLeft + box.scrollLeft;
      const y = (r.top - c.top) / k - box.clientTop + box.scrollTop;
      el.style.width = `${r.width / k}px`;
      el.style.height = `${r.height / k}px`;
      el.style.transform = `translate(${x}px, ${y}px)`;
    };
    // Shown marks slide; a mark that was hidden appears in place.
    const show = (el, item, lit) => {
      if (!el) return;
      if (!visible(item)) {
        el.classList.toggle("on", false);
        el.dataset.at = "";
        return;
      }
      if (!el.dataset.at) {
        el.classList.add("jump");
        place(el, item);
        void el.offsetWidth;
        el.classList.remove("jump");
      } else place(el, item);
      el.dataset.at = "1";
      el.classList.toggle("on", lit);
    };

    const sync = () => {
      const list = items();
      const s = list.find((i) => i.matches(SEL));
      const h =
        pointer ||
        focus ||
        list.find((i) => i.hasAttribute("data-active")) ||
        list.find((i) => i.matches("[open] > summary"));
      show(sel, s, true);
      // Resting on the selected item, the ghost hides under the plate (only
      // where there is a plate), ready to slide out from there next time.
      const rest = h || s;
      show(hov, rest, !!h && (!sel || h !== s));
      if (!rest) hov.dataset.at = "";
    };

    box.addEventListener("pointerover", (e) => {
      const i = owner(e.target);
      if (i !== pointer) {
        pointer = i || null;
        sync();
      }
    });
    box.addEventListener("pointerleave", () => {
      pointer = null;
      sync();
    });
    box.addEventListener("focusin", (e) => {
      focus = e.target.matches(":focus-visible") ? owner(e.target) || null : null;
      sync();
    });
    box.addEventListener("focusout", (e) => {
      if (!box.contains(e.relatedTarget)) focus = null;
      sync();
    });
    new ResizeObserver(sync).observe(box);
    // The marks' own class changes are ignored, or syncing would loop.
    new MutationObserver((recs) => {
      if (recs.some((r) => r.target !== hov && r.target !== sel)) sync();
    }).observe(box, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current", "aria-selected", "class", "data-active", "data-current", "open", "hidden"],
    });
    addEventListener("resize", sync);
    sync();
    // The first placement jumps; after that the marks slide.
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("glide-live")));
  }

  const start = () => document.querySelectorAll("[data-glide]").forEach(glide);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
