/**
 * SyncWatch — content script.
 *
 * 페이지마다 하나씩 돈다. 하는 일은 두 가지다.
 *   1) 이 프레임에 재생 가능한 영상이 있는지 찾아서 background 에 등록한다.
 *   2) background 가 보내는 명령(재생·정지·탐색·볼륨)을 어댑터로 실행한다.
 *
 * 어댑터는 사이트를 안 가린다. 기본 어댑터가 <video> 엘리먼트를 직접 다루고,
 * 그게 깨지는 사이트에만 특수 어댑터를 얹는다. 지금은 넷플릭스 하나뿐이다.
 */

(() => {
  "use strict";

  if (window.__syncwatchLoaded) return;
  window.__syncwatchLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // ── 영상 찾기 ───────────────────────────────────────────────────────────────

  /** 이 프레임에서 "진짜" 영상 하나를 고른다. 광고·썸네일 프리뷰를 피하려고
   *  길이가 있고 화면에서 제일 큰 것을 쓴다. */
  function findVideo() {
    const all = [...document.querySelectorAll("video")];
    const usable = all.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const pool = usable.length ? usable : all;
    if (!pool.length) return null;
    return pool.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }

  // ── 어댑터 ─────────────────────────────────────────────────────────────────

  /** 어느 어댑터든 이 6개만 구현하면 된다. */
  function genericAdapter() {
    return {
      kind: "generic",
      ok: () => !!findVideo(),
      getTime: () => { const v = findVideo(); return v ? v.currentTime : null; },
      setTime: (s) => { const v = findVideo(); if (v) v.currentTime = s; },
      play: () => { const v = findVideo(); return v ? v.play() : null; },
      pause: () => { const v = findVideo(); if (v) v.pause(); },
      isPaused: () => { const v = findVideo(); return v ? v.paused : true; },
      getDuration: () => { const v = findVideo(); return v && isFinite(v.duration) ? v.duration : null; },
      setRate: (r) => { const v = findVideo(); if (v) v.playbackRate = r; },
      getRate: () => { const v = findVideo(); return v ? v.playbackRate : 1; },
      setVolume: (x) => { const v = findVideo(); if (v) { v.volume = Math.max(0, Math.min(1, x)); v.muted = false; } },
      getVolume: () => { const v = findVideo(); return v ? v.volume : null; },
      pip: async () => {
        const v = findVideo();
        if (!v) throw new Error("영상 없음");
        if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return "exited"; }
        await v.requestPictureInPicture();
        return "entered";
      },
    };
  }

  /**
   * 넷플릭스 특수 어댑터.
   *
   * <video>.currentTime 을 직접 쓰면 넷플릭스 내부 상태와 어긋나서 되감기거나
   * 버퍼가 꼬인다. 내부 플레이어 API 로 seek 해야 안정적이다.
   *
   * Firefox 는 content script 에서 wrappedJSObject 로 페이지 전역에 바로 닿는다.
   * (Chrome 은 script 태그 주입이 필요하다 — 이식할 때 여기만 갈아끼우면 된다.)
   */
  function netflixAdapter() {
    const base = genericAdapter();

    function player() {
      try {
        const w = window.wrappedJSObject || window;
        const app = w.netflix && w.netflix.appContext;
        if (!app) return null;
        const vp = app.state.playerApp.getAPI().videoPlayer;
        const ids = vp.getAllPlayerSessionIds();
        if (!ids || !ids.length) return null;
        return vp.getVideoPlayerBySessionId(ids[ids.length - 1]);
      } catch (e) {
        return null;
      }
    }

    return {
      ...base,
      kind: "netflix",
      ok: () => !!player() || base.ok(),
      // 읽기는 <video> 가 더 정확하고 싸다. 쓰기만 내부 API 를 쓴다.
      setTime: (s) => {
        const p = player();
        if (p) { try { p.seek(Math.round(s * 1000)); return; } catch (e) { /* fall through */ } }
        base.setTime(s);
      },
      play: () => { const p = player(); if (p) { try { p.play(); return; } catch (e) {} } return base.play(); },
      pause: () => { const p = player(); if (p) { try { p.pause(); return; } catch (e) {} } return base.pause(); },
    };
  }

  const host = location.hostname;
  const adapter = /(^|\.)netflix\.com$/.test(host) ? netflixAdapter() : genericAdapter();

  // ── 이 소스를 식별하는 안정적인 키 ──────────────────────────────────────────
  // 오프셋을 저장·공유할 때 쓴다. URL 전체를 쓰면 파라미터 때문에 매번 달라진다.

  function sourceId() {
    const u = new URL(location.href);
    if (/(^|\.)youtube\.com$/.test(host)) return u.searchParams.get("v") || u.pathname;
    if (/(^|\.)youtu\.be$/.test(host)) return u.pathname.slice(1);
    if (/(^|\.)netflix\.com$/.test(host)) {
      const m = u.pathname.match(/\/watch\/(\d+)/);
      return m ? m[1] : u.pathname;
    }
    return u.pathname; // 나머지는 경로로 충분하다
  }

  // ── 상태 보고 ──────────────────────────────────────────────────────────────

  function state() {
    return {
      hasVideo: adapter.ok(),
      kind: adapter.kind,
      host,
      id: sourceId(),
      title: document.title,
      url: location.href,
      time: adapter.getTime(),
      duration: adapter.getDuration(),
      paused: adapter.isPaused(),
      rate: adapter.getRate(),
      volume: adapter.getVolume(),
      isTop: window.top === window,
    };
  }

  // ── 명령 처리 ──────────────────────────────────────────────────────────────

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.ns !== "syncwatch") return;
    try {
      switch (msg.cmd) {
        case "state":    return Promise.resolve(state());
        case "play":     adapter.play(); break;
        case "pause":    adapter.pause(); break;
        case "seek":     adapter.setTime(msg.time); break;
        case "rate":     adapter.setRate(msg.rate); break;
        case "volume":   adapter.setVolume(msg.volume); break;
        case "pip":      return adapter.pip().then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: String(e) }));
      }
      return Promise.resolve({ ok: true });
    } catch (e) {
      return Promise.resolve({ ok: false, error: String(e) });
    }
  });

  // ── 사용자가 직접 조작했을 때 background 에 알린다 ────────────────────────
  // 넷플릭스에서 일시정지하면 리액션도 같이 멈춰야 하니까.

  let lastReport = 0;
  function report(kind) {
    const now = Date.now();
    if (kind === "timeupdate" && now - lastReport < 900) return;
    lastReport = now;
    try {
      api.runtime.sendMessage({ ns: "syncwatch", evt: kind, state: state() });
    } catch (e) { /* background 가 아직 없을 수 있다 */ }
  }

  function attach(v) {
    if (!v || v.__syncwatchBound) return;
    v.__syncwatchBound = true;
    for (const e of ["play", "pause", "seeked", "ratechange"]) {
      v.addEventListener(e, () => report(e));
    }
    v.addEventListener("timeupdate", () => report("timeupdate"));
  }

  // 영상이 나중에 생기거나 교체되는 사이트가 많다. 계속 지켜본다.
  const mo = new MutationObserver(() => attach(findVideo()));
  mo.observe(document.documentElement, { childList: true, subtree: true });
  attach(findVideo());

  // 영상이 있는 프레임만 스스로 등록한다.
  if (adapter.ok()) report("hello");
})();
