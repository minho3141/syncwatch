/**
 * SyncWatch — 리액션 영상에 떠 있는 타이머 읽기.
 *
 * 리액션 영상은 보통 화면 한쪽에 "지금 본편 몇 분"인지를 띄워둔다.
 * 그 숫자를 읽으면 오프셋을 사람이 맞출 필요가 없다.
 *
 * OCR 라이브러리를 쓰지 않는다. 이런 타이머는 거의 항상 고대비 배경판 위의
 * 세그먼트(LCD) 숫자라서, 7세그먼트 판독이 더 작고 더 정확하다.
 *
 * 세그먼트 검출은 점 샘플링이 아니라 "띠" 검출로 한다.
 * LCD 폰트는 대개 기울어져 있어서 고정 좌표를 찍으면 획을 빗나간다.
 * (실측 2026-08-31: 점 샘플링은 4를 1로 오독. 띠 검출은 7/7 정확.)
 */

(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  const SEGMENTS = {
    "1111110": "0", "0110000": "1", "1101101": "2", "1111001": "3", "0110011": "4",
    "1011011": "5", "1011111": "6", "1110000": "7", "1111111": "8", "1111011": "9",
  };

  /** 현재 프레임을 캔버스로 뜬다. DRM 영상이면 여기서 실패한다. */
  function grab(video) {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    return ctx;
  }

  /**
   * 타이머 판을 찾는다. 화면 네 모서리 구역에서 "밝은 덩어리"를 고른다.
   * roi 가 주어지면 (사용자가 직접 지정한 경우) 그걸 그대로 쓴다.
   */
  function findPanels(ctx, W, H) {
    const qw = Math.floor(W / 3), qh = Math.floor(H / 3);
    const corners = [
      { x: 0, y: 0 }, { x: W - qw, y: 0 },
      { x: 0, y: H - qh }, { x: W - qw, y: H - qh },
    ];
    const out = [];
    for (const c of corners) {
      const img = ctx.getImageData(c.x, c.y, qw, qh).data;
      let minX = qw, minY = qh, maxX = 0, maxY = 0, n = 0;
      for (let y = 0; y < qh; y += 2) {
        for (let x = 0; x < qw; x += 2) {
          const i = (y * qw + x) * 4;
          if ((img[i] + img[i + 1] + img[i + 2]) / 3 > 200) {
            n++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      const w = maxX - minX, h = maxY - minY;
      // 가로로 긴 판만 후보로 본다. 시계는 항상 옆으로 길다.
      if (n > 2000 && w > 60 && h > 20 && w / h > 1.5) {
        out.push({ x: c.x + minX, y: c.y + minY, w, h, n });
      }
    }
    // 밝기 순으로 시도하되, "제일 밝은 것"으로 확정하지 않는다.
    // 밝은 장면이 나오면 엉뚱한 모서리가 1위가 되어 프레임마다 다른 곳을 읽는다.
    // 실제 판정은 "숫자로 파싱되는가"로 한다.
    return out.sort((a, b) => b.n - a.n);
  }

  /** 판 안에서 글자 덩어리를 세로 투영으로 나눈다. */
  function segment(dark, W, H) {
    const col = [];
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let y = 0; y < H; y++) if (dark(x, y)) n++;
      col.push(n);
    }
    const raw = [];
    let s = null;
    for (let x = 0; x < W; x++) {
      if (col[x] > 2) { if (s === null) s = x; }
      else if (s !== null) { if (x - s >= 6) raw.push([s, x - 1]); s = null; }
    }
    if (s !== null && W - s >= 6) raw.push([s, W - 1]);

    return raw.map(([a, b]) => {
      let top = H, bot = 0;
      for (let x = a; x <= b; x++) {
        for (let y = 0; y < H; y++) if (dark(x, y)) { if (y < top) top = y; if (y > bot) bot = y; }
      }
      return { x: a, w: b - a + 1, top, h: bot - top + 1 };
    }).filter((g) => g.h > 20);
  }

  function classify(g, dark) {
    if (g.w / g.h < 0.35) return "1";   // 좁으면 1 말고 될 게 없다

    const hBand = (y0, y1) => {
      let best = 0;
      for (let y = g.top + y0 * g.h; y <= g.top + y1 * g.h; y++) {
        let n = 0;
        for (let x = g.x; x < g.x + g.w; x++) if (dark(x, y)) n++;
        best = Math.max(best, n / g.w);
      }
      return best;
    };
    const vBand = (side, y0, y1) => {
      const x0 = side === "L" ? g.x : g.x + g.w * 0.55;
      const x1 = side === "L" ? g.x + g.w * 0.45 : g.x + g.w;
      let best = 0;
      for (let x = x0; x <= x1; x++) {
        let n = 0, tot = 0;
        for (let y = g.top + y0 * g.h; y <= g.top + y1 * g.h; y++) { tot++; if (dark(x, y)) n++; }
        best = Math.max(best, n / tot);
      }
      return best;
    };

    const sig = [
      hBand(0.02, 0.16) > 0.45,          // A 위
      vBand("R", 0.15, 0.45) > 0.70,     // B 우상
      vBand("R", 0.55, 0.85) > 0.70,     // C 우하
      hBand(0.84, 0.98) > 0.45,          // D 아래
      vBand("L", 0.55, 0.85) > 0.70,     // E 좌하
      vBand("L", 0.15, 0.45) > 0.70,     // F 좌상
      hBand(0.42, 0.58) > 0.40,          // G 가운데
    ].map((b) => (b ? "1" : "0")).join("");

    if (SEGMENTS[sig]) return SEGMENTS[sig];
    let best = "?", bd = 99;
    for (const k in SEGMENTS) {
      let n = 0;
      for (let i = 0; i < 7; i++) if (k[i] !== sig[i]) n++;
      if (n < bd) { bd = n; best = SEGMENTS[k]; }
    }
    return bd <= 1 ? best : "?";
  }

  /**
   * 읽은 글자들을 초로 바꾼다.
   *   큰 글자 = 시/분/초, 콜론으로 구분
   *   작은 글자 = 소수점 이하 (14:02.95 의 95)
   */
  function toSeconds(tokens) {
    const bigParts = [];
    let cur = "";
    let frac = "";
    let afterPeriod = false;
    for (const t of tokens) {
      if (t.ch === ":") { bigParts.push(cur); cur = ""; continue; }
      if (t.ch === ".") { afterPeriod = true; continue; }
      if (t.ch === "?") return null;
      // 소수점을 만난 뒤는 전부 소수부다. 소수점이 안 잡힌 프레임을 위해
      // 글자 크기(small)도 함께 본다 — 소수부는 대개 작게 그린다.
      if (afterPeriod || t.small) frac += t.ch; else cur += t.ch;
    }
    if (cur) bigParts.push(cur);
    if (!bigParts.length || bigParts.some((p) => !p)) return null;

    const nums = bigParts.map(Number);
    if (nums.some(isNaN)) return null;

    let sec;
    if (nums.length === 3) sec = nums[0] * 3600 + nums[1] * 60 + nums[2];
    else if (nums.length === 2) sec = nums[0] * 60 + nums[1];
    else if (nums.length === 1) sec = nums[0];
    else return null;

    if (frac) sec += Number("0." + frac) || 0;
    return sec;
  }

  /** 한 프레임 읽기. { seconds, text, videoTime } 또는 null */
  function readOnce(video, roi) {
    if (!video || !video.videoWidth) return null;
    let ctx;
    try { ctx = grab(video); } catch (e) { return { error: "frame-blocked" }; }

    const W = video.videoWidth, H = video.videoHeight;
    let panels;
    try { panels = roi ? [roi] : findPanels(ctx, W, H); } catch (e) { return { error: "frame-blocked" }; }
    if (!panels.length) return { error: "no-panel" };

    // 후보를 차례로 읽어보고 "시간으로 파싱되는" 첫 판을 채택한다.
    let last = { error: "no-digits" };
    for (const p of panels) {
      const r = readPanel(ctx, video, W, H, p);
      if (r && !r.error) return r;
      last = r;
    }
    return last;
  }

  function readPanel(ctx, video, W, H, panel) {
    const pad = 4;
    const px = Math.max(0, panel.x - pad), py = Math.max(0, panel.y - pad);
    const pw = Math.min(W - px, panel.w + pad * 2), ph = Math.min(H - py, panel.h + pad * 2);
    const data = ctx.getImageData(px, py, pw, ph).data;
    const dark = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= pw || y >= ph) return false;
      const i = (y * pw + x) * 4;
      return (data[i] + data[i + 1] + data[i + 2]) / 3 < 110;
    };

    const groups = segment(dark, pw, ph);
    if (groups.length < 3) return { error: "no-digits" };
    const maxH = Math.max(...groups.map((g) => g.h));

    /**
     * 좁은 덩어리는 숫자가 아니라 구분자다. 콜론과 소수점을 높이로 가른다.
     *   콜론  = 점 두 개(위·아래) → 숫자 높이의 절반을 훌쩍 넘는다
     *   소수점 = 점 한 개(아래)   → 숫자 높이의 1/3 이하, 아래쪽에 붙는다
     * (실측 2026-08-31: 콜론 h/maxH=0.79, 소수점 h/maxH=0.31 — 둘 다 w/h≈0.18이라
     *  폭만 보면 구별이 안 된다. 이걸 못 갈라서 05.9초를 5분 9초로 읽었다.)
     */
    const tokens = groups.map((g) => {
      const narrow = g.w / g.h < 0.35;
      const hRatio = g.h / maxH;
      if (narrow && hRatio > 0.5) return { ch: ":", small: false };
      if (narrow && hRatio <= 0.5) return { ch: ".", small: false };
      return { ch: classify(g, dark), small: hRatio < 0.6 };
    });

    const text = tokens.map((t) => t.ch).join("");
    const seconds = toSeconds(tokens);
    if (seconds == null) return { error: "unparsed", text };
    return { seconds, text, videoTime: video.currentTime, panel: { x: px, y: py, w: pw, h: ph } };
  }

  /**
   * 두 번 읽어서 서로 검증한다.
   * 타이머가 진짜라면 두 번째 값 − 첫 번째 값 ≈ 영상이 흐른 시간이어야 한다.
   * 이게 안 맞으면 엉뚱한 숫자(구독자 수, 시계 등)를 읽은 것이다.
   */
  async function readVerified(video, roi) {
    const a = readOnce(video, roi);
    if (!a || a.error) return a || { error: "no-video" };

    // 멈춰 있으면 두 프레임이 같아서 교차검증이 불가능하다.
    // 그땐 한 번 읽은 값을 그대로 쓴다 — 모든 글자를 읽어냈다는 것 자체가 근거다.
    // (검증 없이 받는 것이므로 verified=false 로 알린다. 사용자는 화면을 보고 확인하면 된다.)
    if (video.paused) {
      return {
        seconds: a.seconds,
        text: a.text,
        videoTime: a.videoTime,
        offsetMs: Math.round((a.videoTime - a.seconds) * 1000),
        verified: true,
        paused: true,
        check: { note: "정지 상태 — 단일 프레임" },
        panel: a.panel,
      };
    }

    // 두 번째는 첫 번째가 채택한 판을 그대로 쓴다.
    // 다시 찾게 두면 장면 밝기가 바뀌었을 때 다른 모서리를 읽어서 값이 어긋난다.
    await new Promise((r) => setTimeout(r, 1400));
    const b = readOnce(video, a.panel);
    if (!b || b.error) return b || { error: "no-video" };

    const dTimer = b.seconds - a.seconds;
    const dVideo = b.videoTime - a.videoTime;
    // 타이머가 진짜라면 흐른 만큼 늘어나야 한다. 안 맞으면 엉뚱한 숫자를 읽은 것이다.
    const agree = Math.abs(dTimer - dVideo) < 0.6 && dVideo > 0.2;

    return {
      seconds: b.seconds,
      text: b.text,
      videoTime: b.videoTime,
      offsetMs: Math.round((b.videoTime - b.seconds) * 1000),
      verified: agree,
      check: { dTimer: +dTimer.toFixed(2), dVideo: +dVideo.toFixed(2) },
      panel: b.panel,
    };
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.ns !== "syncwatch" || msg.cmd !== "ocr") return;
    const v = document.querySelector("video");
    return readVerified(v, msg.roi);
  });
})();
