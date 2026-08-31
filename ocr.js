/**
 * SyncWatch — 리액션 영상의 타이머 읽기 (content 쪽).
 *
 * 여기서는 그림만 만든다. 글자 판독은 background 의 Tesseract 가 한다.
 * (content script 는 그 페이지의 CSP 를 따르므로 WASM 이 사이트마다 막힌다.)
 *
 * 읽을 영역은 두 가지로 정한다.
 *   1) 사용자가 타이머 위에 끌어놓은 박스 — 있으면 무조건 이걸 쓴다
 *   2) 없으면 화면 모서리에서 고대비 판을 찾아본다 (편의 기능일 뿐, 신뢰하지 않는다)
 *
 * 그리고 항상 두 번 읽어 서로 검증한다. 타이머가 진짜라면 두 값의 차이가
 * 영상이 흐른 시간과 같아야 한다. 이 검사만이 폰트·배치와 무관하게 오독을 잡는다.
 */

(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  function grab(video) {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0);
    return c;
  }

  /** 모서리에서 가로로 긴 고대비 판을 찾는다. 실패해도 괜찮다 — 사용자가 지정하면 된다. */
  function guessPanel(canvas) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const qw = Math.floor(W / 3), qh = Math.floor(H / 3);
    const corners = [
      { x: 0, y: 0 }, { x: W - qw, y: 0 },
      { x: 0, y: H - qh }, { x: W - qw, y: H - qh },
    ];
    let best = null;
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
      if (n > 2000 && w > 60 && h > 20 && w / h > 1.5) {
        if (!best || n > best.n) best = { x: c.x + minX, y: c.y + minY, w, h, n };
      }
    }
    return best;
  }

  /**
   * 영역을 잘라 OCR 하기 좋게 다듬는다.
   *   - 4배 확대 (작은 글자를 Tesseract 가 잘 못 읽는다)
   *   - 회색조 + 대비 강화 후 검은 글자/흰 배경으로 정규화
   */
  function cropForOcr(canvas, roi) {
    const pad = 6;
    const x = Math.max(0, Math.round(roi.x) - pad);
    const y = Math.max(0, Math.round(roi.y) - pad);
    const w = Math.min(canvas.width - x, Math.round(roi.w) + pad * 2);
    const h = Math.min(canvas.height - y, Math.round(roi.h) + pad * 2);
    if (w < 8 || h < 8) return null;

    const S = 4;
    const out = document.createElement("canvas");
    out.width = w * S; out.height = h * S;
    const o = out.getContext("2d", { willReadFrequently: true });
    o.imageSmoothingEnabled = true;
    o.imageSmoothingQuality = "high";
    o.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);

    const img = o.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    // 평균 밝기로 글자/배경 방향을 정한다. 흰 글자 위 검은 판이어도 뒤집어 준다.
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    const mean = sum / (d.length / 4);
    for (let i = 0; i < d.length; i += 4) {
      let g = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (mean < 128) g = 255 - g;                 // 어두운 판이면 반전
      g = g < 110 ? 0 : g > 170 ? 255 : (g - 110) * (255 / 60);
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
    o.putImageData(img, 0, 0);
    return out.toDataURL("image/png");
  }

  function findVideo() {
    const all = [...document.querySelectorAll("video")];
    const vis = all.filter((v) => { const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const pool = vis.length ? vis : all;
    if (!pool.length) return null;
    return pool.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  }

  async function readOnce(video, roi) {
    let canvas;
    try { canvas = grab(video); } catch (e) { return { error: "frame-blocked" }; }

    let area = roi;
    if (!area) {
      try { area = guessPanel(canvas); } catch (e) { return { error: "frame-blocked" }; }
    }
    if (!area) return { error: "no-panel" };

    let dataUrl;
    try { dataUrl = cropForOcr(canvas, area); } catch (e) { return { error: "frame-blocked" }; }
    if (!dataUrl) return { error: "no-panel" };

    const res = await api.runtime.sendMessage({ ns: "syncwatch", op: "ocrImage", dataUrl });
    if (!res || res.error) return { error: res ? res.error : "ocr-failed" };
    if (res.seconds == null) return { error: "unparsed", text: res.text };
    return { seconds: res.seconds, text: res.text, videoTime: video.currentTime, roi: area };
  }

  async function readVerified(roi) {
    const video = findVideo();
    if (!video || !video.videoWidth) return { error: "no-video" };

    const a = await readOnce(video, roi);
    if (a.error) return a;

    // 멈춰 있으면 두 프레임이 같아서 교차검증이 불가능하다. 한 번 읽은 값을 그대로 쓴다.
    if (video.paused) {
      return {
        seconds: a.seconds, text: a.text, videoTime: a.videoTime,
        offsetMs: Math.round((a.videoTime - a.seconds) * 1000),
        verified: true, paused: true, roi: a.roi,
      };
    }

    await new Promise((r) => setTimeout(r, 1500));
    const b = await readOnce(video, a.roi);   // 같은 영역을 다시 본다
    if (b.error) return b;

    const dTimer = b.seconds - a.seconds;
    const dVideo = b.videoTime - a.videoTime;
    const agree = Math.abs(dTimer - dVideo) < 0.7 && dVideo > 0.2;

    return {
      seconds: b.seconds, text: b.text, videoTime: b.videoTime,
      offsetMs: Math.round((b.videoTime - b.seconds) * 1000),
      verified: agree,
      check: { a: a.text, b: b.text, dTimer: +dTimer.toFixed(2), dVideo: +dVideo.toFixed(2) },
      roi: a.roi,
    };
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.ns !== "syncwatch" || msg.cmd !== "ocr") return;
    return readVerified(msg.roi);
  });
})();
