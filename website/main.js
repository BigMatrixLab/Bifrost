// Bifrost website: theme switch, hero transfer demo, section highlight,
// platform-aware download links from the latest GitHub release. The live app
// frames that replace the screenshots are in live.js.
(() => {
  const REPO = "MisbahKhan0009/Relayless";
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
      toggle.title = `Switch to ${next} theme`;
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

  // ------------------------------------------------------------------ section highlight
  const links = new Map($$(".nav-links a").map((a) => [a.getAttribute("href").slice(1), a]));
  // Every top-level section is watched, so the mark clears in sections
  // that have no nav link (the hero, the download area, ...).
  const sections = $$("main > section[id]");
  if (links.size && sections.length) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          links.forEach((a, id) => a.classList.toggle("on", id === e.target.id));
        }
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    sections.forEach((s) => io.observe(s));
  }

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
    const rec = document.querySelector(`[data-dl="${platform}"]`);
    rec?.classList.add("recommended");
    const tag = rec && $("[data-rec]", rec);
    if (tag) tag.hidden = false;
  }

  // ------------------------------------------------------------------ release links
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const find = (re) => (rel.assets || []).find((a) => re.test(a.name));
      const assets = {
        macos: find(/\.dmg$/i),
        windows: find(/x64\.exe$/i),
        android: find(/android\.apk$/i),
      };
      const date = rel.published_at
        ? new Date(rel.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
        : "";
      const ver = (rel.name || rel.tag_name || "").replace(/^(Bifrost|Quanta|Relayless)\s*/i, "");
      const v = $("[data-version]");
      if (v && ver) v.textContent = `Version ${ver}${date ? `, released ${date}` : ""}`;
      const labels = {
        macos: "macOS 10.15 or newer, Apple silicon",
        windows: "Windows 10 and 11, 64-bit, no admin rights needed",
        android: "Android 7.0 and newer, one APK for every phone and tablet",
      };
      for (const key of Object.keys(assets)) {
        const asset = assets[key];
        if (!asset) continue;
        const dl = document.querySelector(`[data-dl="${key}"]`);
        if (dl) dl.href = asset.browser_download_url;
        const meta = $(`[data-meta="${key}"]`);
        if (meta) meta.textContent = `${labels[key]}. ${fmtSize(asset.size)}`;
      }
      if (platform && assets[platform]) primary.href = assets[platform].browser_download_url;
    })
    .catch(() => {
      /* Links fall back to the releases page. */
    });

  fetch(`https://api.github.com/repos/${REPO}`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((repo) => {
      const s = $("[data-stars]");
      if (s && repo.stargazers_count > 0) {
        s.textContent = repo.stargazers_count.toLocaleString();
        s.hidden = false;
      }
    })
    .catch(() => {});
})();
