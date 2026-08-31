/**
 * SyncWatch — background.
 *
 * 두 탭을 하나의 타임라인으로 묶는 엔진.
 *
 * 규칙 하나가 전부다:   reaction.time  ==  main.time + offset
 *
 * 여기서 main/reaction 이 어떤 사이트인지는 신경 쓰지 않는다. 그건 content.js 의
 * 어댑터가 흡수한다. 이 파일은 시간만 다룬다.
 */

"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;

// ── 상태 ────────────────────────────────────────────────────────────────────

const pair = {
  main: null,       // tabId
  reaction: null,   // tabId
  offsetMs: 0,      // reaction = main + offset
  linked: false,
};

/** 최근에 영상을 보고한 탭들. popup 이 목록을 그릴 때 쓴다. */
const seen = new Map(); // tabId -> state

let syncTimer = null;
let suppressUntil = 0; // 우리가 건 seek 이 되돌아와 무한루프 도는 것 방지

// ── 유틸 ────────────────────────────────────────────────────────────────────

function send(tabId, msg) {
  return api.tabs.sendMessage(tabId, { ns: "syncwatch", ...msg }).catch(() => null);
}

async function stateOf(tabId) {
  if (tabId == null) return null;
  return send(tabId, { cmd: "state" });
}

function pairKey(a, b) {
  if (!a || !b) return null;
  return `${a.host}|${a.id}::${b.host}|${b.id}`;
}

// ── 오프셋 저장 ─────────────────────────────────────────────────────────────

async function saveOffset() {
  const [m, r] = await Promise.all([stateOf(pair.main), stateOf(pair.reaction)]);
  const key = pairKey(m, r);
  if (!key) return;
  const store = (await api.storage.local.get("offsets")).offsets || {};
  store[key] = {
    main: { host: m.host, id: m.id, title: m.title },
    reaction: { host: r.host, id: r.id, title: r.title },
    offsetMs: pair.offsetMs,
    savedAt: Date.now(),
  };
  await api.storage.local.set({ offsets: store });
}

async function loadOffset() {
  const [m, r] = await Promise.all([stateOf(pair.main), stateOf(pair.reaction)]);
  const key = pairKey(m, r);
  if (!key) return false;
  const store = (await api.storage.local.get("offsets")).offsets || {};
  if (store[key]) {
    pair.offsetMs = store[key].offsetMs;
    return true;
  }
  return false;
}

// ── 동기화 루프 ─────────────────────────────────────────────────────────────

/**
 * 어긋난 정도에 따라 세 단계로 대응한다.
 *   0.15초 미만 : 아무것도 안 한다. 사람이 못 느낀다.
 *   2초 미만    : 재생속도를 살짝 바꿔서 소리 없이 스르륵 맞춘다.
 *   2초 이상    : 그냥 강제로 seek 한다. 이땐 티가 나도 어쩔 수 없다.
 *
 * 2단계의 이득은 "몇 초 안에 오차를 닫을 것인가"로 정한다.
 * 실측(유튜브 2탭, 2026-08-31): 이득이 diff*0.05, 상한 5% 였을 때
 * 291ms 오차가 데드존까지 들어오는 데 14초 걸렸다 — 너무 느리다.
 * CLOSE_IN 초 안에 닫도록 바꾸면 같은 오차가 4초 안에 잡힌다.
 * 상한 7%는 배속 변화가 귀에 걸리기 시작하는 선 바로 아래다.
 */
const DEAD_ZONE = 0.15;
const HARD_SEEK = 2.0;
const CLOSE_IN = 4.0;   // 초
const MAX_ADJ = 0.07;   // ±7%

async function tick() {
  if (!pair.linked || pair.main == null || pair.reaction == null) return;

  const [m, r] = await Promise.all([stateOf(pair.main), stateOf(pair.reaction)]);
  if (!m || !r || m.time == null || r.time == null) return;

  // 재생/정지 상태를 본편에 맞춘다.
  if (m.paused !== r.paused) {
    if (Date.now() > suppressUntil) {
      suppressUntil = Date.now() + 500;
      await send(pair.reaction, { cmd: m.paused ? "pause" : "play" });
    }
    return;
  }
  if (m.paused) return; // 둘 다 멈춰 있으면 드리프트 볼 필요 없다

  const target = m.time + pair.offsetMs / 1000;
  const diff = r.time - target; // 양수면 리액션이 앞서 있다

  if (Math.abs(diff) < DEAD_ZONE) {
    if (Math.abs(r.rate - m.rate) > 0.001) await send(pair.reaction, { cmd: "rate", rate: m.rate });
    return;
  }

  if (Math.abs(diff) < HARD_SEEK) {
    // 앞서 있으면 느리게, 뒤처져 있으면 빠르게.
    const adj = Math.max(-MAX_ADJ, Math.min(MAX_ADJ, -diff / CLOSE_IN));
    await send(pair.reaction, { cmd: "rate", rate: m.rate * (1 + adj) });
    return;
  }

  suppressUntil = Date.now() + 800;
  await send(pair.reaction, { cmd: "rate", rate: m.rate });
  await send(pair.reaction, { cmd: "seek", time: target });
}

function startLoop() {
  if (syncTimer) return;
  syncTimer = setInterval(tick, 700);
}

function stopLoop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

// ── content script 로부터 오는 보고 ─────────────────────────────────────────

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.ns !== "syncwatch") return;

  // popup → background 명령
  if (msg.op) return handleOp(msg);

  // content → background 이벤트
  if (msg.evt && sender.tab) {
    const tabId = sender.tab.id;
    seen.set(tabId, { ...msg.state, tabId, at: Date.now() });

    if (!pair.linked) return;

    // 사용자가 본편을 직접 조작하면 즉시 반영한다. 루프를 기다리지 않는다.
    if (tabId === pair.main && Date.now() > suppressUntil) {
      if (msg.evt === "play")  { suppressUntil = Date.now() + 500; send(pair.reaction, { cmd: "play" }); }
      if (msg.evt === "pause") { suppressUntil = Date.now() + 500; send(pair.reaction, { cmd: "pause" }); }
      if (msg.evt === "seeked") {
        suppressUntil = Date.now() + 800;
        send(pair.reaction, { cmd: "seek", time: msg.state.time + pair.offsetMs / 1000 });
      }
    }

    // 리액션 쪽을 직접 정지하면 본편도 세운다. (한쪽만 멈추는 게 제일 짜증난다)
    if (tabId === pair.reaction && Date.now() > suppressUntil) {
      if (msg.evt === "pause") { suppressUntil = Date.now() + 500; send(pair.main, { cmd: "pause" }); }
      if (msg.evt === "play")  { suppressUntil = Date.now() + 500; send(pair.main, { cmd: "play" }); }
    }
  }
});

// ── popup 명령 ──────────────────────────────────────────────────────────────

async function handleOp(msg) {
  switch (msg.op) {
    case "list": {
      // 열려 있는 탭을 전부 훑어서 영상이 있는 것만 고른다. 사이트를 안 가린다.
      const tabs = await api.tabs.query({});
      const out = [];
      await Promise.all(tabs.map(async (t) => {
        if (!/^https?:|^file:/.test(t.url || "")) return;
        const s = await stateOf(t.id);
        if (s && s.hasVideo) out.push({ ...s, tabId: t.id, tabTitle: t.title });
      }));
      return { tabs: out, pair: { ...pair } };
    }

    case "assign": {
      pair[msg.role] = msg.tabId;
      const found = await loadOffset();
      return { pair: { ...pair }, offsetLoaded: found };
    }

    /**
     * 버튼 하나로 끝내는 경로.
     * 영상 탭이 정확히 둘이면 고를 게 없다 — 지금 보고 있는 쪽이 본편, 나머지가 반응이다.
     * 그 상태로 바로 묶는다. 사용자는 [맞추기] 한 번만 누르면 된다.
     */
    case "auto": {
      const tabs = await api.tabs.query({});
      const vids = [];
      await Promise.all(tabs.map(async (t) => {
        if (!/^https?:|^file:/.test(t.url || "")) return;
        const s = await stateOf(t.id);
        if (s && s.hasVideo) vids.push({ ...s, tabId: t.id, active: t.active });
      }));

      if (vids.length < 2) return { ok: false, reason: "few", count: vids.length };
      if (vids.length > 2) return { ok: false, reason: "many", count: vids.length, tabs: vids };

      const active = vids.find((v) => v.active);
      pair.main = active ? active.tabId : vids[0].tabId;
      pair.reaction = vids.find((v) => v.tabId !== pair.main).tabId;

      if (!(await loadOffset())) {
        const [m, r] = await Promise.all([stateOf(pair.main), stateOf(pair.reaction)]);
        if (m && r && m.time != null && r.time != null) {
          pair.offsetMs = Math.round((r.time - m.time) * 1000);
        }
      }
      pair.linked = true;
      startLoop();
      return { ok: true, pair: { ...pair } };
    }

    case "link": {
      pair.linked = !!msg.value;
      if (pair.linked) {
        // 묶는 순간의 두 위치 차이를 오프셋으로 삼는다. 저장된 값이 있으면 그게 이긴다.
        if (!(await loadOffset())) {
          const [m, r] = await Promise.all([stateOf(pair.main), stateOf(pair.reaction)]);
          if (m && r && m.time != null && r.time != null) {
            pair.offsetMs = Math.round((r.time - m.time) * 1000);
          }
        }
        startLoop();
      } else {
        stopLoop();
        if (pair.reaction != null) await send(pair.reaction, { cmd: "rate", rate: 1 });
      }
      return { pair: { ...pair } };
    }

    case "nudge": {
      pair.offsetMs += msg.deltaMs;
      if (pair.linked) {
        const m = await stateOf(pair.main);
        if (m && m.time != null) {
          suppressUntil = Date.now() + 800;
          await send(pair.reaction, { cmd: "seek", time: m.time + pair.offsetMs / 1000 });
        }
      }
      await saveOffset();
      return { pair: { ...pair } };
    }

    /**
     * 리액션 영상에 떠 있는 타이머를 읽어서 오프셋을 자동으로 정한다.
     * 사람이 맞출 필요가 없어진다 — 오프셋이 55분이든 3초든 똑같이 한 번에 잡힌다.
     */
    case "autosync": {
      if (pair.reaction == null) return { ok: false, error: "반응 영상을 먼저 지정해줘" };
      const r = await send(pair.reaction, { cmd: "ocr" });
      if (!r) return { ok: false, error: "반응 탭에 닿지 못했어" };
      if (r.error) return { ok: false, error: r.error };
      if (!r.verified) {
        return { ok: false, error: "unverified", text: r.text, check: r.check };
      }
      pair.offsetMs = r.offsetMs;
      await saveOffset();
      if (!pair.linked) { pair.linked = true; startLoop(); }
      return { ok: true, read: r.text, offsetMs: r.offsetMs, pair: { ...pair } };
    }

    case "setOffset": {
      pair.offsetMs = msg.offsetMs;
      await saveOffset();
      return { pair: { ...pair } };
    }

    case "volume":
      await send(msg.role === "main" ? pair.main : pair.reaction, { cmd: "volume", volume: msg.value });
      return { ok: true };

    case "pip":
      return send(pair.reaction, { cmd: "pip" });

    case "toggle": {
      const m = await stateOf(pair.main);
      if (!m) return { ok: false };
      const cmd = m.paused ? "play" : "pause";
      suppressUntil = Date.now() + 500;
      await Promise.all([send(pair.main, { cmd }), send(pair.reaction, { cmd })]);
      return { ok: true };
    }

    case "export": {
      const [m, r] = await Promise.all([stateOf(pair.main), stateOf(pair.reaction)]);
      if (!m || !r) return { ok: false };
      return {
        ok: true,
        profile: {
          main: { host: m.host, id: m.id, title: m.title },
          reaction: { host: r.host, id: r.id, title: r.title },
          offsetMs: pair.offsetMs,
        },
      };
    }

    case "import": {
      try {
        const p = typeof msg.json === "string" ? JSON.parse(msg.json) : msg.json;
        if (typeof p.offsetMs !== "number") throw new Error("offsetMs 없음");
        pair.offsetMs = p.offsetMs;
        const store = (await api.storage.local.get("offsets")).offsets || {};
        const key = `${p.main.host}|${p.main.id}::${p.reaction.host}|${p.reaction.id}`;
        store[key] = { ...p, savedAt: Date.now() };
        await api.storage.local.set({ offsets: store });
        return { ok: true, pair: { ...pair } };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    case "status": {
      const [m, r] = await Promise.all([stateOf(pair.main), stateOf(pair.reaction)]);
      let drift = null;
      if (m && r && m.time != null && r.time != null) {
        drift = r.time - (m.time + pair.offsetMs / 1000);
      }
      return { pair: { ...pair }, main: m, reaction: r, drift };
    }
  }
}

// ── 단축키 ──────────────────────────────────────────────────────────────────

async function toggleBar() {
  const [t] = await api.tabs.query({ active: true, currentWindow: true });
  if (t) await api.tabs.sendMessage(t.id, { ns: "syncwatch", cmd: "bar" }).catch(() => null);
}

// 툴바 아이콘은 팝업을 열지 않는다. 화면 위 조작바를 켜고 끈다.
// 오프셋은 영상을 보면서 맞춰야 해서, 클릭하면 닫히는 팝업이 맞지 않는다.
api.action.onClicked.addListener(toggleBar);

api.commands.onCommand.addListener((cmd) => {
  if (cmd === "toggle-bar") toggleBar();
  if (cmd === "toggle-play") handleOp({ op: "toggle" });
  if (cmd === "offset-back") handleOp({ op: "nudge", deltaMs: -500 });
  if (cmd === "offset-forward") handleOp({ op: "nudge", deltaMs: 500 });
});

// 탭이 닫히면 짝을 푼다.
api.tabs.onRemoved.addListener((tabId) => {
  seen.delete(tabId);
  if (tabId === pair.main || tabId === pair.reaction) {
    pair.linked = false;
    if (tabId === pair.main) pair.main = null;
    if (tabId === pair.reaction) pair.reaction = null;
    stopLoop();
  }
});
