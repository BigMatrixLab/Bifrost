// Bifrost website: theme switch, hero transfer demo, full-screen sections
// (fit to the viewport, arrival animation), the section rail, and
// platform-aware download links from the latest GitHub release. The live app
// frames that replace the screenshots are in live.js.
(() => {
  const THEME_KEY = "bifrost-site-theme";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const SVG = "http://www.w3.org/2000/svg";

  const fmt = (b) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${Math.round(b / MB)} MB`);

  const fmtSize = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);

  // ------------------------------------------------------------------ theme
  const root = document.documentElement;
  const toggle = $("[data-theme-toggle]");
  const themeMeta = $('meta[name="theme-color"]');
  const saved = () => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === "light" || t === "dark" ? t : null;
    } catch {
      return null;
    }
  };
  const applyTheme = (t) => {
    root.dataset.theme = t;
    if (themeMeta) themeMeta.content = t === "light" ? "#f6f6f4" : "#050506";
    if (toggle) {
      const next = t === "light" ? "dark" : "light";
      toggle.setAttribute("aria-label", `Switch to ${next} theme`);
      const label = $("[data-theme-label]", toggle);
      if (label) label.textContent = `${next[0].toUpperCase()}${next.slice(1)} theme`;
    }
  };
  applyTheme(root.dataset.theme === "light" ? "light" : "dark");
  toggle?.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
  });
  // Follow the system theme until the visitor picks one here.
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", (e) => {
    if (!saved()) applyTheme(e.matches ? "light" : "dark");
  });

  // ------------------------------------------------------------------ demo
  const card = $(".demo-card");
  if (card) {
    const el = {
      segs: $("[data-segs]", card),
      ticks: $("[data-ticks]", card),
      pct: $("[data-pct]", card),
      ringLabel: $("[data-ring-label]", card),
      savedText: $("[data-saved-text]", card),
      status: $("[data-status]", card),
      speed: $("[data-speed]", card),
      eta: $("[data-eta]", card),
      blocks: $("[data-blocks]", card),
      route: $("[data-route]", card),
      toggle: $("[data-toggle]", card),
      drop: $("[data-drop]", card),
      log: $("[data-log]", card),
      receipt: $("[data-receipt]", card),
    };

    // Chunk ring: 96 segments, each 1/96 of the file, like the app's.
    const SEGS = 96;
    const segs = [];
    const polar = (r, a) => [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
    for (let i = 0; i < SEGS; i++) {
      const a = ((i + 0.5) / SEGS) * Math.PI * 2;
      const [x1, y1] = polar(80, a);
      const [x2, y2] = polar(92, a);
      const line = document.createElementNS(SVG, "line");
      line.setAttribute("x1", x1.toFixed(2));
      line.setAttribute("y1", y1.toFixed(2));
      line.setAttribute("x2", x2.toFixed(2));
      line.setAttribute("y2", y2.toFixed(2));
      el.segs.append(line);
      segs.push(line);
    }
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const major = i % 15 === 0;
      const [x1, y1] = polar(major ? 66 : 69, a);
      const [x2, y2] = polar(73, a);
      const line = document.createElementNS(SVG, "line");
      line.setAttribute("x1", x1.toFixed(2));
      line.setAttribute("y1", y1.toFixed(2));
      line.setAttribute("x2", x2.toFixed(2));
      line.setAttribute("y2", y2.toFixed(2));
      if (major) line.setAttribute("class", "major");
      el.ticks.append(line);
    }
    let shownV = -1;
    let shownF = -1;
    const paintRing = (verified, arrived) => {
      const v = Math.floor(verified * SEGS);
      const f = Math.min(SEGS, Math.max(v + (state === "running" ? 1 : 0), Math.floor(arrived * SEGS)));
      if (v === shownV && f === shownF) return;
      shownV = v;
      shownF = f;
      segs.forEach((s, i) => s.setAttribute("class", i < v ? "v" : i < f ? "f" : ""));
    };

    const SIZE = 4.2 * GB;
    const COMMIT_MS = 2000; // progress is flushed and recorded every 2 s, as in the engine
    let received = 1.62 * GB;
    let saved = received;
    let state = "running"; // running | paused | reconnecting | verifying | done
    let speed = 0;
    let lastCommit = performance.now();
    let last = performance.now();
    let visible = true;
    let timer = null;
    const t0 = performance.now();

    const setState = (s) => {
      state = s;
      card.dataset.state = s;
    };
    const stamp = () => {
      const s = Math.floor((performance.now() - t0) / 1000);
      return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    const log = (text, tone = "") => {
      const li = document.createElement("li");
      if (tone) li.className = tone;
      const t = document.createElement("time");
      t.textContent = stamp();
      li.append(t, document.createTextNode(text));
      el.log.prepend(li);
      while (el.log.children.length > 4) el.log.lastChild.remove();
    };
    const commit = () => {
      saved = Math.floor(received / MB) * MB;
      lastCommit = performance.now();
    };

    const render = () => {
      const pSaved = saved / SIZE;
      el.pct.textContent = (pSaved * 100).toFixed(1);
      el.savedText.textContent = `${fmt(saved)} / ${fmt(SIZE)}`;
      el.blocks.textContent = Math.round(saved / MB).toLocaleString("en-US");
      el.speed.textContent = state === "running" ? `${speed.toFixed(1)} MB/s` : "0 MB/s";
      if (state === "running" && speed > 1) {
        const s = Math.round((SIZE - received) / (speed * MB));
        el.eta.textContent = s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
      } else {
        el.eta.textContent = state === "done" ? "Done" : "–";
      }
      paintRing(pSaved, received / SIZE);
    };

    const tick = (now) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (state === "running") {
        const target = 46 + Math.sin(now / 1300) * 4 + Math.sin(now / 370) * 1.5;
        speed += (target - speed) * Math.min(1, dt * 3);
        received = Math.min(SIZE, received + speed * MB * dt);
        if (now - lastCommit > COMMIT_MS) commit();
        if (received >= SIZE) {
          received = SIZE;
          commit();
          setState("verifying");
          el.ringLabel.textContent = "Checking";
          el.status.textContent = "Verifying · whole file";
          log("All blocks received. Checking the whole file…");
          el.toggle.disabled = true;
          el.drop.disabled = true;
          timer = setTimeout(() => {
            setState("done");
            el.ringLabel.textContent = "Verified";
            el.status.textContent = "Complete · from Dhaka-Edit-Bay";
            log("Verified 4.20 GB. Saved to Downloads/Bifrost.", "good");
            el.receipt.hidden = false;
            render();
            timer = setTimeout(restart, 7000);
          }, 1600);
        }
      }
      render();
      if (visible) requestAnimationFrame(tick);
    };

    const restart = () => {
      received = 0;
      saved = 0;
      speed = 0;
      setState("running");
      el.toggle.disabled = false;
      el.drop.disabled = false;
      el.toggle.textContent = "Pause";
      el.receipt.hidden = true;
      el.status.textContent = "Receiving · from Dhaka-Edit-Bay";
      el.route.textContent = "Direct · 176 ms";
      log("Starting the next download.");
    };

    el.toggle.addEventListener("click", () => {
      if (state === "running") {
        commit();
        received = saved;
        setState("paused");
        el.toggle.textContent = "Resume";
        el.status.textContent = "Paused · by you";
        log(`Paused. ${fmt(saved)} is verified on disk.`);
      } else if (state === "paused") {
        setState("running");
        speed = 8;
        el.toggle.textContent = "Pause";
        el.status.textContent = "Receiving · from Dhaka-Edit-Bay";
        log(`Resumed from ${fmt(saved)}. Nothing downloaded twice.`, "good");
      }
      render();
    });

    el.drop.addEventListener("click", () => {
      if (state !== "running" && state !== "paused") return;
      const wasPaused = state === "paused";
      commit();
      received = saved;
      setState("reconnecting");
      el.toggle.disabled = true;
      el.drop.disabled = true;
      el.status.textContent = "Reconnecting · to Dhaka-Edit-Bay";
      el.route.textContent = "No path";
      log(`Connection lost. ${fmt(saved)} is safe on disk.`, "warn");
      render();
      clearTimeout(timer);
      timer = setTimeout(() => {
        el.toggle.disabled = false;
        el.drop.disabled = false;
        el.route.textContent = "Direct · 181 ms";
        if (wasPaused) {
          setState("paused");
          el.status.textContent = "Paused · by you";
          log("Back online. Still paused.");
        } else {
          setState("running");
          speed = 6;
          el.status.textContent = "Receiving · from Dhaka-Edit-Bay";
          log(`Reconnected. Continuing from ${fmt(saved)}.`, "good");
        }
        render();
      }, 2600);
    });

    log("Downloading over a direct, encrypted connection.");
    render();
    // Only animate while the card is on screen.
    new IntersectionObserver((entries) => {
      const v = entries.some((e) => e.isIntersecting);
      if (v && !visible) {
        visible = true;
        last = performance.now();
        requestAnimationFrame(tick);
      } else if (!v) {
        visible = false;
      }
    }).observe(card);
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ screens
  // Each .screen, and each carousel page (.slide), is one viewport tall.
  // Content taller than the viewport is scaled down to fit (never below
  // MIN_FIT; then it runs taller). Screens marked data-nofit (the FAQ) keep
  // their size. Phones don't scale screens, only carousel pages, which are
  // pinned and can't scroll on their own.
  const screens = $$(".screen");
  const slidesAll = $$(".slide");
  const phoneMq = matchMedia("(max-width: 760px)");
  const MIN_FIT = 0.6;
  const MIN_FIT_PHONE_PAGE = 0.55;
  const fitOne = (box) => {
    const fit = box.querySelector(":scope > .fit");
    if (!fit) return;
    let s = 1;
    const isPage = box.classList.contains("slide");
    if (!box.hasAttribute("data-nofit") && (isPage || !phoneMq.matches)) {
      const cs = getComputedStyle(box);
      const avail = innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const h = fit.offsetHeight; // layout height: unaffected by the transform
      if (h > avail) s = Math.max(isPage && phoneMq.matches ? MIN_FIT_PHONE_PAGE : MIN_FIT, avail / h);
    }
    fit.style.setProperty("--fit", s.toFixed(4));
    fit.style.setProperty("--fit-gap", `${(fit.offsetHeight * (1 - s)).toFixed(1)}px`);
  };
  const fitAll = () => [...screens, ...slidesAll].forEach(fitOne);
  let fitQueued = false;
  const queueFit = () => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      fitAll();
    });
  };
  fitAll();
  // Changes after the first layout (fonts, the demo's receipt) ease to the
  // new scale instead of jumping.
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("fit-live")));
  const fitWatch = new ResizeObserver(queueFit);
  [...screens, ...slidesAll].forEach((box) => {
    const fit = box.querySelector(":scope > .fit");
    if (fit) fitWatch.observe(fit);
  });
  addEventListener("resize", queueFit);
  phoneMq.addEventListener?.("change", queueFit);

  // Arrival: the parts of a screen rise in, in reading order, and its corner
  // marks draw out. Only the outermost matching element of a group moves.
  const RV =
    ".lab, h1, h2, .lede, .section-lede, .cta-row, .fineprint, .panel, .feature-copy > *, .phones figure, .band-desktop, .band-phone, .hero-hint, .device-link, .sec-list li, .faq-list details, .tiles li";
  for (const box of [...screens, ...slidesAll]) {
    let i = 0;
    for (const el of box.querySelectorAll(RV)) {
      const outer = el.parentElement.closest(RV);
      if (outer && box.contains(outer)) continue;
      el.classList.add("rv");
      el.style.setProperty("--i", String(Math.min(i++, 10)));
    }
  }
  const arrive = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.15) e.target.classList.add("in");
        // Reset once it is fully out of view, so it arrives again next time.
        else if (!e.isIntersecting) e.target.classList.remove("in");
      }
    },
    { threshold: [0, 0.15] },
  );
  screens.forEach((sc) => arrive.observe(sc));

  // FAQ: one answer open at a time. `details name="faq"` does this natively;
  // this covers browsers without it.
  const faqs = $$(".faq-list details");
  for (const d of faqs) {
    d.addEventListener("toggle", () => {
      if (d.open) for (const o of faqs) if (o !== d && o.open) o.open = false;
    });
  }

  // ------------------------------------------------------------------ features carousel
  // The section is one screen tall per page, with a snap stop per page, and
  // its view is pinned (position: sticky). Scrolling through it moves the
  // strip sideways, so every scroll step brings the next page in from the side.
  const car = $("[data-carousel]");
  if (car) {
    const strip = $("[data-car-strip]", car);
    const pages = $$(".slide", car);
    const dashes = $$("[data-car-dash]", car);
    const nameEl = $("[data-car-name]", car);
    const idxEl = $("[data-car-i]", car);
    const prevBtn = $("[data-car-prev]", car);
    const nextBtn = $("[data-car-next]", car);
    const n = pages.length;
    let lastK = -1;
    let queued = false;
    const progress = () => {
      const r = car.getBoundingClientRect();
      const step = car.offsetHeight / n;
      return { r, step, p: Math.min(n - 1, Math.max(0, -r.top / step)) };
    };
    const update = () => {
      queued = false;
      const { r, p } = progress();
      strip.style.setProperty("--p", p.toFixed(4));
      const inView = r.bottom > 1 && r.top < innerHeight - 1;
      pages.forEach((pg, k) => {
        const dist = Math.abs(k - p);
        const d = Math.min(1, dist);
        pg.style.setProperty("--o", (1 - d * 0.7).toFixed(3));
        pg.style.setProperty("--s", (1 - d * 0.06).toFixed(4));
        if (inView && dist < 0.7) pg.classList.add("in");
        else if (!inView || dist >= 1) pg.classList.remove("in");
        // Pages off to the side can't be reached by Tab.
        const away = dist > 0.5;
        if (pg.inert !== away) pg.inert = away;
      });
      dashes.forEach((b, k) => b.style.setProperty("--fill", Math.min(1, Math.max(0, p - k + 1)).toFixed(3)));
      const k = Math.round(p);
      if (k !== lastK) {
        lastK = k;
        dashes.forEach((b, j) => {
          b.classList.toggle("on", j === k);
          if (j === k) b.setAttribute("aria-current", "step");
          else b.removeAttribute("aria-current");
        });
        if (idxEl) idxEl.textContent = String(k + 1).padStart(2, "0");
        if (nameEl) nameEl.textContent = dashes[k]?.getAttribute("aria-label") ?? "";
        prevBtn?.setAttribute("aria-label", k === 0 ? "Previous section" : "Previous feature");
        nextBtn?.setAttribute("aria-label", k === n - 1 ? "Next section" : "Next feature");
      }
    };
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    };
    const motion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
    const goTo = (k) => {
      const { r, step } = progress();
      if (k < 0) {
        const prev = car.previousElementSibling;
        if (prev) scrollTo({ top: scrollY + prev.getBoundingClientRect().top, behavior: motion() });
        return;
      }
      if (k >= n) {
        const next = car.nextElementSibling;
        if (next) scrollTo({ top: scrollY + next.getBoundingClientRect().top, behavior: motion() });
        return;
      }
      scrollTo({ top: scrollY + r.top + k * step, behavior: motion() });
    };
    dashes.forEach((b, k) => b.addEventListener("click", () => goTo(k)));
    prevBtn?.addEventListener("click", () => goTo(Math.round(progress().p) - 1));
    nextBtn?.addEventListener("click", () => goTo(Math.round(progress().p) + 1));
    // Left and right arrows page through it while it fills the screen.
    // Past the first/last slide they leave the carousel for the neighbouring section.
    addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.target.closest?.("input, textarea, select")) return;
      const { r, p } = progress();
      if (r.top > 1 || r.bottom < innerHeight - 1) return;
      e.preventDefault();
      goTo(Math.round(p) + (e.key === "ArrowRight" ? 1 : -1));
    });
    addEventListener("scroll", queue, { passive: true });
    addEventListener("resize", queue);
    update();
  }

  // ------------------------------------------------------------------ rail
  // The item for the section under the middle of the viewport is marked; the
  // mark slides between items.
  const railList = $("[data-rail-list]");
  const railMark = $("[data-rail-mark]");
  const railItems = $$(".rail-item[data-nav]");
  let current = null;
  const navOf = (el) => el.dataset.nav || (el.matches("section[id]") ? el.id : el.closest("section[id]")?.id) || null;
  const placeMark = () => {
    const a = railItems.find((x) => x.dataset.nav === current);
    if (!railMark) return;
    if (!a) {
      railMark.classList.remove("on");
      return;
    }
    railMark.style.height = `${a.offsetHeight}px`;
    railMark.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
    railMark.classList.add("on");
  };
  const setCurrent = (id) => {
    if (!id || id === current) return;
    current = id;
    for (const a of railItems) {
      const on = a.dataset.nav === id;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
    placeMark();
    // Phone dock: keep the marked icon in view.
    const a = railItems.find((x) => x.dataset.nav === id);
    if (a && railList && railList.scrollWidth > railList.clientWidth + 1) {
      railList.scrollTo({ left: a.offsetLeft - (railList.clientWidth - a.offsetWidth) / 2, behavior: "smooth" });
    }
  };
  const middle = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) setCurrent(navOf(e.target));
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  [...screens, ...(car ? [car] : [])].forEach((el) => middle.observe(el));
  // The mark jumps into place the first time, then slides.
  requestAnimationFrame(() => requestAnimationFrame(() => railMark?.classList.add("slide")));
  addEventListener("resize", placeMark);
  phoneMq.addEventListener?.("change", placeMark);

  // ------------------------------------------------------------------ wheel paging
  // Mandatory snapping picks the stop nearest to where a scroll would end, so
  // a short wheel or trackpad flick springs back to the same section. Here
  // one wheel gesture moves exactly one stop (a screen, a carousel page or
  // the footer). Inside a section taller than the screen the wheel scrolls
  // normally until its edge. Keyboard, scrollbar and touch stay native.
  const stopsY = () => {
    const ys = $$(".screen, .car-stop").map((e) => Math.round(e.getBoundingClientRect().top + scrollY));
    ys.push(Math.max(0, document.documentElement.scrollHeight - innerHeight));
    return [...new Set(ys)].sort((a, b) => a - b);
  };
  let paging = false;
  let lastWheel = 0;
  const settle = () =>
    new Promise((res) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        removeEventListener("scrollend", finish);
        res();
      };
      addEventListener("scrollend", finish);
      setTimeout(finish, 1000);
    });
  addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX) || e.deltaY === 0) return;
      lastWheel = performance.now();
      if (paging) {
        e.preventDefault();
        return;
      }
      const y = scrollY;
      const vh = innerHeight;
      const ys = stopsY();
      const down = e.deltaY > 0;
      const target = down ? ys.find((s) => s > y + 2) : [...ys].reverse().find((s) => s < y - 2);
      if (target === undefined) return;
      // More of a tall section to see before its edge: scroll it normally.
      if (Math.abs(target - y) > vh + 2) return;
      e.preventDefault();
      paging = true;
      scrollTo({ top: target, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      settle().then(function wait() {
        // Swallow the rest of the gesture (trackpad momentum) before the next step.
        if (performance.now() - lastWheel < 180) setTimeout(wait, 60);
        else paging = false;
      });
    },
    { passive: false },
  );

  // ------------------------------------------------------------------ overlay scrollbar
  // Native bar is hidden. A thin thumb (no track) shows while you scroll and fades out after.
  const sb = document.createElement("div");
  sb.className = "sb";
  sb.setAttribute("aria-hidden", "true");
  const sbThumb = document.createElement("i");
  sb.append(sbThumb);
  document.body.append(sb);
  let sbHide = 0;
  let sbDrag = false;
  const sbMetrics = () => {
    const h = document.documentElement.scrollHeight;
    const vh = innerHeight;
    const max = Math.max(1, h - vh);
    const th = Math.max(40, (vh / h) * vh);
    return { max, th, range: Math.max(1, vh - 16 - th) };
  };
  const sbSync = () => {
    const h = document.documentElement.scrollHeight;
    const vh = innerHeight;
    if (h <= vh + 1) {
      sb.hidden = true;
      return;
    }
    sb.hidden = false;
    const { max, th, range } = sbMetrics();
    sbThumb.style.height = `${th}px`;
    sbThumb.style.transform = `translateY(${(scrollY / max) * range}px)`;
  };
  const sbShow = () => {
    sbSync();
    if (sb.hidden) return;
    sb.classList.add("on");
    clearTimeout(sbHide);
    if (!sbDrag) sbHide = setTimeout(() => {
      if (!sbDrag && !sb.matches(":hover")) sb.classList.remove("on");
    }, 900);
  };
  addEventListener("scroll", sbShow, { passive: true });
  addEventListener("resize", sbSync);
  sb.addEventListener("pointerenter", () => clearTimeout(sbHide));
  sb.addEventListener("pointerleave", () => {
    if (!sbDrag) sbHide = setTimeout(() => sb.classList.remove("on"), 500);
  });
  sbThumb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sbDrag = true;
    sb.classList.add("on", "drag");
    sbThumb.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startScroll = scrollY;
    const { max, range } = sbMetrics();
    const move = (ev) => scrollTo({ top: startScroll + ((ev.clientY - startY) / range) * max });
    const up = () => {
      sbDrag = false;
      sb.classList.remove("drag");
      sbThumb.removeEventListener("pointermove", move);
      sbThumb.removeEventListener("pointerup", up);
      sbThumb.removeEventListener("pointercancel", up);
      sbShow();
    };
    sbThumb.addEventListener("pointermove", move);
    sbThumb.addEventListener("pointerup", up);
    sbThumb.addEventListener("pointercancel", up);
  });
  sbSync();

  // ------------------------------------------------------------------ platform
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const platform = /Android/i.test(ua)
    ? "android"
    : isIOS
      ? null
      : /Macintosh|Mac OS X/i.test(ua)
        ? "macos"
        : /Windows/i.test(ua)
          ? "windows"
          : null;
  const NAMES = { macos: "macOS", windows: "Windows", android: "Android" };
  const primary = $("[data-primary-dl]");
  const primaryLabel = $("[data-primary-label]");
  if (platform) {
    primaryLabel.textContent = `Download for ${NAMES[platform]}`;
    // Straight to the installer: the function answers with an attachment, so
    // the download starts on click and the page stays put. No `download`
    // attribute: with one, a "not published yet" redirect would be saved too.
    primary.href = `download/${platform}`;
    const rec = document.querySelector(`[data-dl="${platform}"]`);
    rec?.classList.add("recommended");
    const tag = rec && $("[data-rec]", rec);
    if (tag) tag.hidden = false;
  }

  // ------------------------------------------------------------------ release info
  // The buttons already point at download/<platform>, which the Cloudflare
  // function (functions/download/) streams from R2. latest.json only adds the
  // version, date and file sizes to the page, and greys out any platform that
  // has no build in the bucket yet instead of linking to a missing file.
  const ALL = ["macos", "windows", "android"];
  const markMissing = (key) => {
    const card = document.querySelector(`[data-dl="${key}"]`);
    if (!card) return;
    card.classList.add("unavailable");
    card.removeAttribute("href");
    card.setAttribute("aria-disabled", "true");
    const btn = $(".btn", card);
    if (btn) btn.textContent = "Not published yet";
    if (key === platform) primary.href = "#download";
  };
  // The function sends ?unavailable=<platform> when it had nothing to serve.
  if (new URLSearchParams(location.search).has("unavailable")) {
    history.replaceState(null, "", location.pathname + location.hash);
  }
  fetch("download/latest.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const files = rel.files || {};
      const date = rel.published
        ? new Date(rel.published).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
        : "";
      const ver = (rel.name || rel.version || "").replace(/^(Bifrost|Quanta|Relayless)\s*/i, "");
      const v = $("[data-version]");
      if (v && ver) v.textContent = `Version ${ver}${date ? `, released ${date}` : ""}`;
      const labels = {
        macos: "macOS 10.15 or newer, Apple silicon",
        windows: "Windows 10 and 11, 64-bit, no admin rights needed",
        android: "Android 7.0 and newer, one APK for every phone and tablet",
      };
      for (const key of Object.keys(labels)) {
        const file = files[key];
        if (!file) {
          markMissing(key);
          continue;
        }
        const meta = $(`[data-meta="${key}"]`);
        if (meta) meta.textContent = `${labels[key]}. ${fmtSize(file.size)}`;
      }
    })
    .catch((status) => {
      // 404: nothing published yet. Anything else (offline, a local preview
      // without the function): leave the buttons as they are.
      if (status === 404) ALL.forEach(markMissing);
    });
})();
