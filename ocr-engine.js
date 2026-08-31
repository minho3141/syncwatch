/**
 * SyncWatch — OCR 엔진 (background 에서 돈다).
 *
 * 왜 배경에서 도는가: Tesseract 는 WASM 을 쓰는데, content script 는 그 페이지의
 * CSP 를 따르므로 사이트마다 막힌다. 확장 페이지는 우리가 CSP 를 정할 수 있다.
 *
 * 왜 손으로 짠 7세그먼트 판독을 버렸는가:
 * 리액션 영상마다 타이머 폰트·배치가 전부 다르다. 특정 폰트에 맞춘 판독기는
 * 그 영상 하나에서만 동작한다. 실제로 그렇게 만들었다가 같은 영상 안에서도
 * 프레임에 따라 깨졌다 — 기울어진 LCD 폰트에서 '1'이 옆 글자와 붙어버려서
 * 세로 투영으로 글자를 나눌 수가 없었다.
 */

"use strict";

// background.js 보다 먼저 로드되므로 거기 있는 api 상수에 기대지 않는다.
const RT = typeof browser !== "undefined" ? browser : chrome;

let workerPromise = null;

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const w = await Tesseract.createWorker("eng", 1, {
      workerPath: RT.runtime.getURL("vendor/worker.min.js"),
      corePath: RT.runtime.getURL("vendor/"),
      langPath: RT.runtime.getURL("vendor/"),
      gzip: false,
      cacheMethod: "none",
    });
    // 시계에 나올 수 있는 글자만 허용한다. 오독이 크게 줄어든다.
    await w.setParameters({
      tessedit_char_whitelist: "0123456789:.",
      tessedit_pageseg_mode: "7", // 한 줄로 취급
    });
    return w;
  })();
  return workerPromise;
}

/** "1:23:45.6" / "12:34" / "83.4" 를 초로 바꾼다. 못 읽으면 null. */
function parseClock(raw) {
  const s = (raw || "").replace(/[^\d:.]/g, "").trim();
  if (!s) return null;

  // 소수부는 마지막 점 뒤에 오되, 점이 구분자로 쓰인 경우(12.34.56)는 콜론으로 본다
  const dots = (s.match(/\./g) || []).length;
  let body = s, frac = "";
  if (dots === 1 && /\.\d{1,3}$/.test(s)) {
    const i = s.lastIndexOf(".");
    body = s.slice(0, i);
    frac = s.slice(i + 1);
  } else if (dots > 0) {
    body = s.replace(/\./g, ":");
  }

  const parts = body.split(":").filter((p) => p !== "");
  if (!parts.length || parts.length > 3) return null;
  if (parts.some((p) => !/^\d{1,2}$/.test(p))) return null;

  const n = parts.map(Number);
  let sec;
  if (n.length === 3) sec = n[0] * 3600 + n[1] * 60 + n[2];
  else if (n.length === 2) sec = n[0] * 60 + n[1];
  else sec = n[0];
  if (frac) sec += Number("0." + frac) || 0;
  if (!isFinite(sec) || sec < 0) return null;
  return sec;
}

/** dataURL 한 장을 읽어 { text, seconds } 로 돌려준다. */
async function ocrImage(dataUrl) {
  const w = await getWorker();
  const { data } = await w.recognize(dataUrl);
  const text = (data.text || "").replace(/\s+/g, "");
  return { text, seconds: parseClock(text) };
}
