// Live app embeds. Every product view on this page is the real Bifrost
// interface, built from src/ with the demo backend in mock/ (npm run
// build:demo, output in website/demo/), running in a scaled iframe. Scripts
// drive it like a person would: a cursor moves to real elements, clicks
// them, types an invitation code, hovers the calendar. The screenshot under
// each frame shows until the app is ready, and stays as the fallback without
// JavaScript or when the demo build is missing.
(() => {
  const DEMO = "demo/index.html";
  const APP_THEME_KEY = "relayless-theme"; // the app's own key (src/theme.ts)
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const narrowMq = matchMedia("(max-width: 640px)");
  const siteTheme = () => (root.dataset.theme === "light" ? "light" : "dark");
  const saveAppTheme = () => {
    try {
      localStorage.setItem(APP_THEME_KEY, siteTheme());
    } catch {
      /* the embeds then start dark and are switched after loading */
    }
  };
  saveAppTheme();

  class Stop extends Error {}
  class Missing extends Error {}

  const DESKTOP = [1280, 800];
  const PHONE = [390, 844];

  // ------------------------------------------------------------------ driver
  // Moves the cursor and sends events into one embedded app.
  class Driver {
    constructor(live) {
      this.live = live;
      this.cancels = new Set();
      this.hovered = null;
      this.pos = null;
    }
    get win() {
      return this.live.frame?.contentWindow ?? null;
    }
    get doc() {
      return this.live.frame?.contentDocument ?? null;
    }
    get scale() {
      return this.live.scale;
    }
    cancel() {
      for (const c of this.cancels) c();
      this.cancels.clear();
    }
    wait(ms) {
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          this.cancels.delete(c);
          res();
        }, ms);
        const c = () => {
          clearTimeout(t);
          rej(new Stop());
        };
        this.cancels.add(c);
      });
    }

    // ---- finding things
    visible(el) {
      return el.getClientRects().length > 0;
    }
    pick(sel, text, exact) {
      const doc = this.doc;
      if (!doc) return null;
      for (const el of doc.querySelectorAll(sel)) {
        if (!this.visible(el)) continue;
        if (text != null) {
          const t = el.textContent.replace(/\s+/g, " ").trim();
          if (exact ? t !== text : !t.includes(text)) continue;
        }
        return el;
      }
      return null;
    }
    async find(sel, text, { exact = false, timeout = 4000 } = {}) {
      const end = performance.now() + timeout;
      for (;;) {
        const el = this.pick(sel, text, exact);
        if (el) return el;
        if (performance.now() > end) throw new Missing(`${sel}${text != null ? ` "${text}"` : ""}`);
        await this.wait(120);
      }
    }
    has(sel, text) {
      return !!this.pick(sel, text, false);
    }
    all(sel) {
      return [...(this.doc?.querySelectorAll(sel) ?? [])].filter((el) => this.visible(el));
    }
    /** The `sel` closest to the element showing `text` (e.g. the Pause button on that file's row). */
    nearNow(text, sel) {
      const doc = this.doc;
      if (!doc) return null;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.data.includes(text) || !this.visible(n.parentElement)) continue;
        // Climb to the row: the first ancestor holding any control, and look only there.
        for (let p = n.parentElement; p && p !== doc.body; p = p.parentElement) {
          if (!p.querySelector("button, input, [role=checkbox]")) continue;
          const hit = [...p.querySelectorAll(sel)].find((el) => this.visible(el));
          if (hit) return hit;
          break;
        }
      }
      return null;
    }
    async near(text, sel, timeout = 4000) {
      const end = performance.now() + timeout;
      for (;;) {
        const el = this.nearNow(text, sel);
        if (el) return el;
        if (performance.now() > end) throw new Missing(`${sel} near "${text}"`);
        await this.wait(120);
      }
    }

    // ---- cursor
    point(el, ax = 0.5, ay = 0.5) {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width * ax, cy: r.top + r.height * ay };
    }
    async moveTo(cx, cy, dur) {
      const c = this.live.cursor;
      const s = this.scale;
      const x = cx * s;
      const y = cy * s;
      const from = this.pos ?? { x: x + 60, y: y + 80 };
      const dist = Math.hypot(x - from.x, y - from.y);
      const ms = reduce.matches ? 0 : (dur ?? Math.max(320, Math.min(900, dist * 1.4)));
      c.classList.add("on");
      c.style.transition = this.pos && ms ? `transform ${ms}ms cubic-bezier(0.3, 0.7, 0.2, 1)` : "none";
      c.style.transform = `translate(${x}px, ${y}px)`;
      this.pos = { x, y };
      if (ms) await this.wait(ms);
    }
    async to(el, ax, ay) {
      await this.reveal(el);
      const { cx, cy } = this.point(el, ax, ay);
      await this.moveTo(cx, cy);
      return { cx, cy };
    }
    /** Scrolls the app's own scroll container (never this page) to bring `el` into view. */
    async reveal(el) {
      const win = this.win;
      let p = el.parentElement;
      while (p && p !== this.doc.body) {
        const st = win.getComputedStyle(p);
        if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 2) break;
        p = p.parentElement;
      }
      if (!p || p === this.doc.body) return;
      const r = el.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      if (r.top >= pr.top + 8 && r.bottom <= pr.bottom - 8) return;
      const top = p.scrollTop + (r.top - pr.top) - Math.max(16, (pr.height - r.height) / 2);
      p.scrollTo({ top, behavior: reduce.matches ? "auto" : "smooth" });
      await this.wait(reduce.matches ? 50 : 650);
    }
    async top() {
      const c = this.doc?.querySelector(".content");
      if (c && c.scrollTop > 0) {
        c.scrollTo({ top: 0, behavior: reduce.matches ? "auto" : "smooth" });
        await this.wait(reduce.matches ? 50 : 500);
      }
    }

    // ---- events
    fire(el, type, cx, cy, extra = {}) {
      const W = this.win;
      if (!W) return;
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: W,
        clientX: cx,
        clientY: cy,
        pointerType: "mouse",
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: /down$/.test(type) ? 1 : 0,
        ...extra,
      };
      const Ctor = type.startsWith("pointer") ? W.PointerEvent || W.MouseEvent : W.MouseEvent;
      el.dispatchEvent(new Ctor(type, init));
    }
    out(el, next) {
      if (!el || !el.isConnected) return;
      const related = next ?? this.doc.body;
      this.fire(el, "pointerout", 0, 0, { relatedTarget: related });
      this.fire(el, "mouseout", 0, 0, { relatedTarget: related });
      this.fire(el, "pointerleave", 0, 0, { bubbles: false, relatedTarget: related });
    }
    async hover(el, ax, ay) {
      const { cx, cy } = await this.to(el, ax, ay);
      if (this.hovered && this.hovered !== el) this.out(this.hovered, el);
      if (this.hovered !== el) {
        this.fire(el, "pointerover", cx, cy, { relatedTarget: null });
        this.fire(el, "mouseover", cx, cy, { relatedTarget: null });
      }
      this.fire(el, "pointermove", cx, cy);
      this.hovered = el;
    }
    unhover() {
      this.out(this.hovered);
      this.hovered = null;
    }
    async click(el, ax, ay) {
      await this.hover(el, ax, ay);
      const { cx, cy } = this.point(el, ax, ay);
      const c = this.live.cursor;
      c.classList.remove("down");
      void c.offsetWidth;
      c.classList.add("down");
      this.fire(el, "pointerdown", cx, cy);
      this.fire(el, "mousedown", cx, cy);
      await this.wait(110);
      this.fire(el, "pointerup", cx, cy);
      this.fire(el, "mouseup", cx, cy);
      el.click();
      await this.wait(160);
    }
    /** Drags the pointer across `el` from ax0 to ax1, like reading a graph. */
    async sweep(el, ax0, ax1, ay, ms) {
      await this.hover(el, ax0, ay);
      const steps = reduce.matches ? 1 : Math.round(ms / 50);
      const c = this.live.cursor;
      c.style.transition = "none";
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const { cx, cy } = this.point(el, ax0 + (ax1 - ax0) * ease, ay);
        this.fire(el, "pointermove", cx, cy);
        c.style.transform = `translate(${cx * this.scale}px, ${cy * this.scale}px)`;
        this.pos = { x: cx * this.scale, y: cy * this.scale };
        await this.wait(50);
      }
    }
    async type(el, text, per = 110) {
      await this.click(el);
      const setter = Object.getOwnPropertyDescriptor(this.win.HTMLInputElement.prototype, "value").set;
      for (const ch of text) {
        setter.call(el, el.value + ch);
        el.dispatchEvent(new this.win.Event("input", { bubbles: true }));
        await this.wait(reduce.matches ? 0 : per);
      }
    }
    key(k) {
      this.win?.dispatchEvent(new this.win.KeyboardEvent("keydown", { key: k, bubbles: true }));
    }

    // ---- app navigation
    /** Closes dialogs and menus so every script starts from the same place. */
    async reset() {
      this.unhover();
      for (let i = 0; i < 3 && this.has(".modal, .perm-menu"); i++) {
        this.key("Escape");
        await this.wait(250);
      }
    }
    /** Opens a page through the app's own navigation (sidebar, or the phone tab bar). */
    async go(id) {
      const tab = this.pick(`.nav-item.nav-${id}`);
      if (!tab) return; // not in this layout's navigation: the page was opened by the URL
      if (!tab.classList.contains("active")) {
        await this.click(tab);
        await this.wait(500);
      }
      await this.top();
    }
  }

  // ------------------------------------------------------------------ scripts
  // Each runs once from a clean state and is repeated while its frame is on screen.
  const SEL = (name) => `[aria-label="Select ${name}"]`;
  const scripts = {
    async overview(d) {
      await d.go("overview");
      await d.wait(700);
      await d.hover(await d.find(".focus .ring, .focus"), 0.5, 0.5);
      await d.wait(1400);
      const plot = await d.find(".flow-plot");
      await d.sweep(plot, 0.08, 0.96, 0.42, 3600);
      await d.wait(900);
      d.unhover();
      await d.hover(await d.find(".netp"), 0.5, 0.42);
      await d.wait(1600);
    },

    async invite(d) {
      await d.go("shares");
      await d.wait(700);
      await d.click(await d.find(".share-tile .btn", "Invite", { exact: true }));
      await d.wait(900);
      await d.click(await d.find(".modal .segmented button", "Both", { exact: true }));
      await d.wait(700);
      await d.click(await d.find(".modal .btn", "Create invitation"));
      await d.wait(1200);
      await d.hover(await d.find(".modal .qr-scan"));
      await d.wait(1600);
      await d.hover(await d.find(".modal .inv-code"), 0.4, 0.25);
      await d.wait(1800);
      await d.click(await d.find(".modal .btn", "Done", { exact: true }));
      await d.wait(500);
    },

    async connect(d) {
      await d.go("devices");
      await d.wait(700);
      await d.click(await d.find(".btn", "Connect with code"));
      await d.wait(600);
      await d.type(await d.find(".modal input.ce-input"), "K7QM9XRT4HWDP2NA", 95);
      await d.wait(400);
      await d.click(await d.find(".modal .btn", "Connect", { exact: true }));
      await d.wait(2400);
      await d.hover(await d.find(".modal .words-block"), 0.35, 0.5);
      await d.wait(1600);
      await d.click(await d.find(".modal .hero-tile", "Film masters"));
      await d.wait(1300);
      await d.click(await d.find(SEL("feature-film-master-4k.mov")));
      await d.wait(450);
      await d.click(await d.find(SEL("scene-001-take-1.mov")));
      await d.wait(450);
      await d.click(await d.find(SEL("scene-002-take-2.mov")));
      await d.wait(1800);
      await d.hover(await d.find(".selection-bar"), 0.3, 0.5);
      await d.wait(1200);
      await d.click(await d.find(".selection-bar .btn", "Clear"));
      await d.wait(400);
    },

    async browse(d) {
      if (!d.has(SEL("scene-001-take-1.mov"))) {
        await d.go("devices");
        await d.wait(600);
        await d.click(await d.find(".btn", "Browse", { exact: true }));
        await d.wait(1300);
      }
      await d.click(await d.find(SEL("scene-001-take-1.mov")));
      await d.wait(500);
      await d.click(await d.find(SEL("scene-002-take-2.mov")));
      await d.wait(500);
      await d.click(await d.find(SEL("README.md")));
      await d.wait(2400);
      await d.click(await d.find(".selection-bar .btn", "Clear"));
      await d.wait(1600);
    },

    async transfers(d) {
      await d.go("transfers");
      await d.wait(700);
      await d.click(await d.find(".tab", "Sending"));
      await d.wait(900);
      const file = "scene-014-take-2.mov";
      // A run cut short may have left it paused: resume first in that case.
      if (!d.nearNow(file, 'button[aria-label="Resume"]')) {
        await d.click(await d.near(file, 'button[aria-label="Pause"]'));
        await d.wait(1700);
      }
      await d.click(await d.near(file, 'button[aria-label="Resume"]'));
      await d.wait(1500);
      await d.click(await d.find(".tab", "Receiving"));
      await d.wait(1600);
      await d.click(await d.find(".tab", "All"));
      await d.wait(1200);
    },

    async access(d) {
      await d.go("shares");
      await d.wait(800);
      await d.click(await d.near("Lena", ".perm-pick"));
      await d.wait(700);
      for (const opt of d.all(".perm-opt")) {
        await d.hover(opt, 0.3, 0.5);
        await d.wait(650);
      }
      d.key("Escape");
      d.unhover();
      await d.wait(600);
      await d.hover(await d.find(".share-col .lab", "Invitations"));
      await d.wait(900);
      await d.hover(await d.find(".code-cells, .inv-code, .share-col:last-child .num"), 0.4, 0.5);
      await d.wait(1600);
    },

    async history(d) {
      await d.go("history");
      await d.wait(700);
      const days = d.all(".cal-day.has");
      const pickDays = [days.length - 8, days.length - 4, days.length - 1].filter((i) => i >= 0).map((i) => days[i]);
      for (const day of pickDays) {
        await d.hover(day);
        await d.wait(1200);
      }
      d.unhover();
      const row = await d.find(".hrow-main");
      await d.click(row);
      await d.wait(700);
      const receipt = await d.find(".hrow.open .receipt");
      await d.hover(receipt, 0.3, 0.3);
      await d.wait(2600);
      await d.click(await d.find(".hrow.open .hrow-main"));
      await d.wait(500);
      await d.top();
      await d.wait(600);
    },
  };

  // The large frame under the hero walks through the main flows one after another.
  scripts.showcase = async (d) => {
    for (const s of [scripts.overview, scripts.invite, scripts.connect, scripts.transfers, scripts.history]) {
      await d.reset();
      await s(d);
      await d.wait(1200);
    }
  };

  // ------------------------------------------------------------------ live frame
  const lives = [];

  class Live {
    constructor(fig) {
      this.fig = fig;
      this.screen = fig.querySelector(".live-screen");
      this.page = fig.dataset.live || "overview";
      this.narrowPage = fig.dataset.narrow || null;
      this.phoneOnly = fig.hasAttribute("data-phone");
      this.script = scripts[fig.dataset.script] || null;
      this.frame = null;
      this.ready = false;
      this.visible = false;
      this.running = false;
      this.driver = new Driver(this);
      this.cursor = document.createElement("span");
      this.cursor.className = "live-cursor";
      this.cursor.setAttribute("aria-hidden", "true");
      this.cursor.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 2.5v17.2l4.6-4.3 3 6.6 2.9-1.3-3-6.5h6.3z" /></svg>';
      this.screen.append(this.cursor);
      new ResizeObserver(() => this.fit()).observe(this.screen);
    }
    canPlay() {
      // Under reduced motion the frames show the app without the scripted cursor.
      if (reduce.matches) return false;
      return !!this.script && this.ready && this.visible && !document.hidden;
    }
    mount() {
      if (this.frame) return;
      const narrow = this.phoneOnly || (this.narrowPage && narrowMq.matches);
      this.size = narrow ? PHONE : DESKTOP;
      this.fig.classList.toggle("is-narrow", !!narrow && !this.phoneOnly);
      const page = narrow && this.narrowPage ? this.narrowPage : this.page;
      saveAppTheme();
      const f = document.createElement("iframe");
      f.src = `${DEMO}#${page}`;
      f.title = "";
      f.tabIndex = -1;
      f.setAttribute("aria-hidden", "true");
      f.inert = true;
      f.style.width = `${this.size[0]}px`;
      f.style.height = `${this.size[1]}px`;
      f.addEventListener("load", () => this.onLoad(f), { once: true });
      this.screen.prepend(f);
      this.frame = f;
      this.fit();
    }
    async onLoad(f) {
      // The demo build may be missing (local preview without `npm run build:demo`):
      // then the screenshot stays.
      const doc = f.contentDocument;
      if (!doc || !doc.getElementById("root")) return this.unmount();
      const end = performance.now() + 8000;
      while (f === this.frame && !doc.querySelector(".nav-item") && performance.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (f !== this.frame) return;
      this.syncTheme();
      await new Promise((r) => setTimeout(r, 350));
      if (f !== this.frame) return;
      this.ready = true;
      this.fig.classList.add("live-on");
      this.play();
    }
    unmount() {
      this.stop();
      this.ready = false;
      this.fig.classList.remove("live-on");
      this.frame?.remove();
      this.frame = null;
      this.driver.pos = null;
    }
    fit() {
      if (!this.frame) return;
      this.scale = this.screen.clientWidth / this.size[0];
      this.frame.style.transform = `scale(${this.scale})`;
    }
    syncTheme() {
      const doc = this.frame?.contentDocument;
      if (!doc) return;
      const want = siteTheme();
      if (doc.documentElement.dataset.theme === want) return;
      // Prefer the app's own switch, so its icon matches.
      const t = doc.querySelector(".theme-toggle");
      if (t) t.click();
      if (doc.documentElement.dataset.theme !== want) doc.documentElement.dataset.theme = want;
    }
    play() {
      this.want = true;
      if (this.running || !this.canPlay()) return;
      this.run();
    }
    async run() {
      this.running = true;
      this.want = false;
      const d = this.driver;
      while (this.canPlay()) {
        try {
          await d.reset();
          await this.script(d, this);
        } catch (e) {
          if (e instanceof Stop) break;
          console.warn("[bifrost demo]", e.message);
          try {
            await d.wait(1500);
          } catch {
            break;
          }
        }
      }
      this.running = false;
      // Asked to play again while the last run was unwinding (scrolled away and back).
      if (this.want && this.canPlay()) this.run();
    }
    stop() {
      this.want = false;
      this.driver.cancel();
      this.driver.unhover();
      this.cursor.classList.remove("on");
    }
  }

  // ------------------------------------------------------------------ wiring
  for (const fig of document.querySelectorAll("[data-live]")) lives.push(new Live(fig));

  // Load a frame shortly before it scrolls into view and drop it once it is
  // far away, so only a few run at a time.
  const near = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const live = lives.find((l) => l.fig === e.target);
        if (e.isIntersecting) live.mount();
      }
    },
    { rootMargin: "50% 0px" },
  );
  const far = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const live = lives.find((l) => l.fig === e.target);
        if (!e.isIntersecting) live.unmount();
      }
    },
    { rootMargin: "150% 0px" },
  );
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const live = lives.find((l) => l.fig === e.target);
        live.visible = e.isIntersecting;
        if (live.visible) live.play();
        else live.stop();
      }
    },
    { threshold: 0.35 },
  );
  for (const l of lives) {
    near.observe(l.fig);
    far.observe(l.fig);
    seen.observe(l.fig);
  }

  document.addEventListener("visibilitychange", () => {
    for (const l of lives) document.hidden ? l.stop() : l.play();
  });
  // Follow the page's theme switch.
  new MutationObserver(() => {
    saveAppTheme();
    for (const l of lives) if (l.ready) l.syncTheme();
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  // Crossing the phone breakpoint changes which layout a frame should show.
  narrowMq.addEventListener?.("change", () => {
    for (const l of lives) {
      if (l.narrowPage && l.frame) {
        l.unmount();
        l.mount();
      }
    }
  });
})();
