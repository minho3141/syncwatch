/**
 * SyncWatch — 화면 위 조작바.
 *
 * 팝업이 아니라 페이지 위에 떠 있는 이유:
 * 오프셋을 맞추려면 영상을 보면서 조절해야 한다. 팝업은 클릭하면 닫히니까
 * 조절 → 확인 → 조절을 반복할 수 없다. 그래서 조작을 화면에 붙여둔다.
 *
 * 사이트 CSS 와 섞이지 않게 Shadow DOM 안에 만든다.
 */

(() => {
  "use strict";

  if (window.top !== window) return;      // 최상위 프레임에만
  if (window.__syncwatchBar) return;
  window.__syncwatchBar = true;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const send = (o) => api.runtime.sendMessage({ ns: "syncwatch", ...o });

  let host, root, bar, poll = null, collapsed = false;

  const CSS = `
  :host { all: initial; }
  .bar {
    position: fixed; z-index: 2147483647; left: 20px; bottom: 20px;
    background: rgba(20,21,25,.96); color: #e6e7ea;
    font: 13px/1.4 system-ui, "Noto Sans KR", sans-serif;
    border: 1px solid #33363f; border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,.5);
    user-select: none; width: 300px; overflow: hidden;
  }
  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 10px; cursor: move; background: #1c1e23;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #6f7681; flex: none; }
  .dot.good { background: #4ade80; } .dot.wait { background: #fbbf24; } .dot.bad { background: #f87171; }
  .stat { flex: 1; font-size: 12px; color: #c9ced6; }
  .head button {
    background: none; border: 0; color: #7f8794; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 4px;
  }
  .head button:hover { background: #2c2f37; color: #e6e7ea; }

  .body { padding: 10px; }
  .body.hidden { display: none; }

  .big {
    width: 100%; padding: 11px; font-size: 15px; font-weight: 700; cursor: pointer;
    background: #2f6df6; color: #fff; border: 0; border-radius: 9px; margin-bottom: 10px;
  }
  .big.on { background: #1d7a3d; }
  .big:hover { filter: brightness(1.12); }

  .lbl { font-size: 11px; color: #6f7681; margin: 0 0 5px; }
  .off { display: flex; gap: 4px; align-items: center; }
  .off button {
    flex: 1; padding: 9px 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    background: #2c2f37; color: #e6e7ea; border: 0; border-radius: 7px;
  }
  .off button:hover { background: #3d424e; }
  .val {
    flex: 1.5; text-align: center; font-variant-numeric: tabular-nums;
    font-size: 13px; font-weight: 700; color: #c9ced6;
  }
  .pick { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
  .pick label { width: 42px; font-size: 11px; color: #9aa0aa; flex: none; }
  .pick select {
    flex: 1; min-width: 0; background: #1f2026; color: #e6e7ea;
    border: 1px solid #33363f; border-radius: 7px; padding: 7px 6px;
    font: inherit; font-size: 12px; cursor: pointer;
  }
  .auto {
    width: 100%; padding: 8px; cursor: pointer; font: inherit; font-size: 12px;
    background: #2c2f37; color: #9aa0aa; border: 0; border-radius: 8px; margin: 10px 0 12px;
  }
  .auto:hover { background: #383c46; color: #e6e7ea; }
  .shown {
    flex: 2; background: #1f2026; border: 1px solid #4b5570; color: #e6e7ea;
    border-radius: 7px; padding: 9px 6px; font: inherit; font-size: 14px;
    text-align: center; font-variant-numeric: tabular-nums; min-width: 0;
  }
  .applyShown { background: #2f6df6 !important; color: #fff; font-weight: 700; }
  .valin {
    flex: 2; background: #1f2026; border: 1px solid #33363f; color: #e6e7ea;
    border-radius: 7px; padding: 8px 6px; font: inherit; font-size: 12px;
    text-align: center; font-variant-numeric: tabular-nums; min-width: 0;
  }
  .hint { font-size: 10px; color: #6f7681; text-align: center; margin-top: 4px; }
  .more {
    width: 100%; padding: 6px; margin-top: 10px; cursor: pointer;
    background: none; border: 0; color: #6f7681; font: inherit; font-size: 11px;
  }
  .more:hover { color: #c9ced6; }
  .extra.hidden { display: none; }

  .vol { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
  .vol span { width: 30px; font-size: 11px; color: #9aa0aa; }
  .vol input { flex: 1; }
  `;

  const HTML = `
  <div class="bar" part="bar">
    <div class="head">
      <div class="dot"></div>
      <div class="stat">SyncWatch</div>
      <button class="min" title="접기">–</button>
      <button class="cls" title="닫기">×</button>
    </div>
    <div class="body">
      <div class="pick">
        <label>본편</label><select class="selMain"></select>
      </div>
      <div class="pick">
        <label>리액션</label><select class="selReact"></select>
      </div>

      <button class="big">맞추기</button>

      <p class="lbl">리액션 화면에 뜬 숫자</p>
      <div class="off">
        <input class="shown" type="text" placeholder="03:35">
        <button class="applyShown" style="flex:.8">적용</button>
      </div>
      <p class="hint">이거 하나면 끝. 본편 위치는 안 봐도 됨</p>

      <div class="off" style="margin-top:8px">
        <button data-d="-1000">−1s</button>
        <button data-d="-200">−.2</button>
        <button data-d="200">+.2</button>
        <button data-d="1000">+1s</button>
      </div>
      <p class="hint">− 리액션이 빠를 때 &nbsp;·&nbsp; + 느릴 때</p>

      <button class="more">＋ 더보기</button>

      <div class="extra hidden">
        <div class="off">
          <button data-d="-60000">−1분</button>
          <button data-d="-10000">−10s</button>
          <button data-d="10000">+10s</button>
          <button data-d="60000">+1분</button>
        </div>
        <div class="off" style="margin-top:5px">
          <input class="valin" type="text" placeholder="오프셋 0:00.0">
          <button class="setv" style="flex:.7">적용</button>
        </div>

        <p class="lbl" style="margin-top:10px">소리</p>
        <div class="vol"><span>본편</span><input class="vm" type="range" min="0" max="1" step="0.01" value="1"></div>
        <div class="vol"><span>반응</span><input class="vr" type="range" min="0" max="1" step="0.01" value="1"></div>

        <button class="auto">타이머 자동 읽기 (아직 미구현)</button>
      </div>
    </div>
  </div>`;

  // ── 만들기 ────────────────────────────────────────────────────────────────

  function build() {
    host = document.createElement("div");
    host.id = "syncwatch-bar-host";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);
    const wrap = document.createElement("div");
    wrap.innerHTML = HTML;
    root.append(wrap.firstElementChild);
    document.documentElement.append(host);
    bar = root.querySelector(".bar");

    wire();
    restorePos();
    startPoll();
  }

  function wire() {
    const q = (s) => root.querySelector(s);

    q(".big").onclick = async () => {
      const s = await send({ op: "status" });
      if (s && s.pair.linked) { await send({ op: "link", value: false }); return tick(); }
      if (s.pair.main == null || s.pair.reaction == null) {
        setStat("위에서 본편·리액션을 골라줘", "bad");
        return;
      }
      if (s.pair.main === s.pair.reaction) {
        setStat("서로 다른 탭을 골라줘", "bad");
        return;
      }
      setStat("맞추는 중…", "wait");
      await send({ op: "link", value: true });
      tick();
    };

    for (const [sel, role] of [[".selMain", "main"], [".selReact", "reaction"]]) {
      const el = q(sel);
      // 여는 동안 목록이 갱신돼서 선택이 튕기는 걸 막는다
      el.addEventListener("focus", () => { el.dataset.open = "1"; });
      el.addEventListener("blur", () => { el.dataset.open = "0"; });
      el.onchange = async () => {
        el.dataset.open = "0";
        if (!el.value) return;
        await send({ op: "assign", role, tabId: Number(el.value) });
        tick();
      };
    }

    for (const b of root.querySelectorAll(".off button[data-d]")) {
      b.onclick = async () => { await send({ op: "nudge", deltaMs: Number(b.dataset.d) }); tick(); };
    }

    /** "3:35" / "03:35.08" / "215" 전부 받는다. */
    function toSec(raw) {
      const s = (raw || "").trim();
      if (!s) return null;
      const parts = s.split(":").map((p) => Number(p));
      if (parts.some((n) => isNaN(n))) return null;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 1) return parts[0];
      return null;
    }

    const applyShown = async () => {
      const sec = toSec(q(".shown").value);
      if (sec == null) return setStat("숫자 형식이 이상해 (예: 3:35)", "bad");
      const s0 = await send({ op: "status" });
      if (!s0 || s0.pair.reaction == null) return setStat("먼저 리액션 탭을 골라줘", "bad");
      const r = await send({ op: "fromShown", shownSec: sec });
      if (!r || !r.ok) return setStat((r && r.error) || "실패", "bad");
      q(".shown").value = "";
      tick();
    };
    q(".applyShown").onclick = applyShown;
    q(".shown").addEventListener("keydown", (e) => { if (e.key === "Enter") applyShown(); });

    q(".auto").onclick = async () => {
      setStat("타이머 읽는 중…", "wait");
      const s = await send({ op: "status" });
      if (!s || s.pair.reaction == null) { await send({ op: "auto" }); }
      const r = await send({ op: "autosync" });
      if (r && r.ok) { setStat("읽음: " + r.read, "good"); return tick(); }
      const why = {
        "frame-blocked": "DRM 영상이라 화면을 못 읽어",
        "no-panel": "타이머를 못 찾았어",
        "no-digits": "숫자를 못 찾았어",
        "unparsed": "숫자를 못 읽었어",
        "unverified": "읽었는데 검증에 실패했어 (" + (r && r.text) + ")",
        "engine-missing": "자동 읽기는 아직 안 들어있어. 위 칸에 숫자를 넣어줘",
      }[r && r.error] || (r && r.error) || "실패";
      setStat(why, "bad");
    };

    // "1:23.4" 또는 "83.4" 둘 다 받는다
    q(".setv").onclick = async () => {
      const raw = q(".valin").value.trim();
      if (!raw) return;
      const neg = raw.startsWith("-");
      const parts = raw.replace(/^-/, "").split(":").map(Number);
      if (parts.some(isNaN)) return setStat("형식이 이상해", "bad");
      let sec = 0;
      if (parts.length === 3) sec = parts[0]*3600 + parts[1]*60 + parts[2];
      else if (parts.length === 2) sec = parts[0]*60 + parts[1];
      else sec = parts[0];
      await send({ op: "setOffset", offsetMs: Math.round((neg ? -sec : sec) * 1000) });
      q(".valin").value = "";
      tick();
    };

    q(".vm").oninput = (e) => send({ op: "volume", role: "main", value: Number(e.target.value) });
    q(".vr").oninput = (e) => send({ op: "volume", role: "reaction", value: Number(e.target.value) });

    q(".more").onclick = () => {
      const ex = q(".extra");
      const open = ex.classList.toggle("hidden") === false;
      q(".more").textContent = open ? "－ 접기" : "＋ 더보기";
    };

    q(".min").onclick = () => {
      collapsed = !collapsed;
      q(".body").classList.toggle("hidden", collapsed);
      q(".min").textContent = collapsed ? "+" : "–";
    };
    q(".cls").onclick = () => { stopPoll(); host.remove(); window.__syncwatchBar = false; };

    dragify(q(".head"));
  }

  // ── 드래그 ────────────────────────────────────────────────────────────────

  function dragify(handle) {
    let sx, sy, ox, oy, moving = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      moving = true;
      const r = bar.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!moving) return;
      const x = Math.max(0, Math.min(innerWidth - 60, ox + e.clientX - sx));
      const y = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy));
      bar.style.left = x + "px"; bar.style.top = y + "px";
      bar.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (!moving) return;
      moving = false;
      const r = bar.getBoundingClientRect();
      api.storage.local.set({ barPos: { left: r.left, top: r.top } });
    });
  }

  async function restorePos() {
    const { barPos } = await api.storage.local.get("barPos");
    if (barPos) {
      bar.style.left = Math.min(barPos.left, innerWidth - 60) + "px";
      bar.style.top = Math.min(barPos.top, innerHeight - 40) + "px";
      bar.style.bottom = "auto";
    }
  }

  // ── 상태 갱신 ─────────────────────────────────────────────────────────────

  function setStat(text, cls) {
    root.querySelector(".stat").textContent = text;
    root.querySelector(".dot").className = "dot " + (cls || "");
  }

  /** 드롭다운을 채운다. 사용자가 여는 중이면 건드리지 않는다. */
  async function fillPickers(pair) {
    const res = await send({ op: "list" });
    if (!res || !res.tabs) return;
    for (const [sel, role] of [[".selMain", "main"], [".selReact", "reaction"]]) {
      const el = root.querySelector(sel);
      if (el.dataset.open === "1") continue;
      const sig = res.tabs.map((t) => t.tabId).join(",") + "|" + pair[role];
      if (el.dataset.sig === sig) continue;
      el.dataset.sig = sig;
      el.innerHTML = '<option value="">— 고르기 —</option>' +
        res.tabs.map((t) => {
          // iframe 안의 영상이면 t.title 은 플레이어 프레임 제목이라 쓸모없다. 탭 제목이 맞다.
          const name = (t.tabTitle || t.title || t.host).replace(/ - YouTube$/, "").slice(0, 42);
          return `<option value="${t.tabId}">${name.replace(/</g, "&lt;")}</option>`;
        }).join("");
      el.value = pair[role] == null ? "" : String(pair[role]);
    }
  }

  async function tick() {
    const s = await send({ op: "status" });
    if (!s) return;
    fillPickers(s.pair);
    const big = root.querySelector(".big");
    big.textContent = s.pair.linked ? "풀기" : "맞추기";
    big.classList.toggle("on", s.pair.linked);
    const el = root.querySelector(".valin");
    if (el && document.activeElement !== host) {
      const sec = s.pair.offsetMs / 1000;
      const sign = sec < 0 ? "-" : "";
      const a = Math.abs(sec);
      el.placeholder = a >= 60
        ? `${sign}${Math.floor(a / 60)}:${(a % 60).toFixed(1).padStart(4, "0")}`
        : `${sign}${a.toFixed(2)}s`;
    }

    if (s.main && s.main.volume != null) root.querySelector(".vm").value = s.main.volume;
    if (s.reaction && s.reaction.volume != null) root.querySelector(".vr").value = s.reaction.volume;

    if (!s.pair.linked) return setStat("SyncWatch", "");
    if (s.drift == null) return setStat("확인 중…", "wait");
    const ms = Math.abs(s.drift * 1000);
    if (ms < 150) setStat("맞음", "good");
    else if (ms < 2000) setStat("맞추는 중 " + Math.round(ms) + "ms", "wait");
    else setStat("크게 어긋남", "bad");
  }

  function startPoll() { if (!poll) poll = setInterval(tick, 700); tick(); }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  // ── 팝업/단축키에서 켜고 끄기 ─────────────────────────────────────────────

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.ns !== "syncwatch" || msg.cmd !== "bar") return;
    if (host && document.contains(host)) { stopPoll(); host.remove(); window.__syncwatchBar = false; }
    else build();
    return Promise.resolve({ ok: true });
  });
})();
