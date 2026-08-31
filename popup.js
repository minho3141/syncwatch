"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const $ = (id) => document.getElementById(id);

function op(o) { return api.runtime.sendMessage({ ns: "syncwatch", ...o }); }

let linked = false;

function say(text, cls) {
  $("msg").textContent = text;
  $("msg").className = cls || "";
}

// ── 메인 버튼: 이거 하나로 끝난다 ──────────────────────────────────────────

$("big").onclick = async () => {
  if (linked) { await op({ op: "link", value: false }); refresh(); return; }

  say("맞추는 중…");
  const r = await op({ op: "auto" });

  if (r && r.ok) { refresh(); return; }

  if (r && r.reason === "few") {
    say(`영상 탭이 ${r.count}개야. 두 개를 각각 재생해줘`, "bad");
  } else if (r && r.reason === "many") {
    say(`영상 탭이 ${r.count}개라 못 고르겠어. 아래 [직접 고르기]에서 지정해줘`, "bad");
    $("tabs").closest("details").open = true;
    renderTabs();
  } else {
    say("실패했어", "bad");
  }
};

// ── 상태 ───────────────────────────────────────────────────────────────────

async function refresh() {
  const s = await op({ op: "status" });
  if (!s) return;
  linked = s.pair.linked;

  $("big").textContent = linked ? "묶임 — 풀기" : "맞추기";
  $("big").classList.toggle("on", linked);
  $("offset").value = s.pair.offsetMs;

  if (!linked) { if (!$("msg").className) say("—"); return; }

  if (s.drift == null) { say("확인 중…"); return; }
  const ms = Math.abs(s.drift * 1000);
  if (ms < 150) say("맞음 ✓", "good");
  else if (ms < 2000) say("맞추는 중… " + Math.round(ms) + "ms", "");
  else say("크게 어긋남 — 맞추는 중", "bad");
}

// ── 미세조정 ───────────────────────────────────────────────────────────────
// 라벨은 "리액션이 빨라/느려" — 사용자가 화면에서 보는 그대로다.

$("back").onclick = async () => { await op({ op: "nudge", deltaMs: -500 }); refresh(); };
$("fwd").onclick  = async () => { await op({ op: "nudge", deltaMs:  500 }); refresh(); };

$("volMain").oninput  = (e) => op({ op: "volume", role: "main",     value: Number(e.target.value) });
$("volReact").oninput = (e) => op({ op: "volume", role: "reaction", value: Number(e.target.value) });

// ── 자세히 ─────────────────────────────────────────────────────────────────

$("unlink").onclick = async () => { await op({ op: "link", value: false }); refresh(); };

$("offset").onchange = async (e) => {
  await op({ op: "setOffset", offsetMs: Number(e.target.value) || 0 });
  refresh();
};

async function renderTabs() {
  const res = await op({ op: "list" });
  if (!res) return;
  const box = $("tabs");
  box.innerHTML = "";
  for (const t of res.tabs) {
    const el = document.createElement("div");
    el.className = "tab";
    el.innerHTML = `<span class="name" title="${t.title.replace(/"/g, "&quot;")}">${t.title}</span>
      <button class="sm" data-role="main" data-tab="${t.tabId}">본편</button>
      <button class="sm" data-role="reaction" data-tab="${t.tabId}">반응</button>`;
    for (const b of el.querySelectorAll("button")) {
      const role = b.dataset.role, tabId = Number(b.dataset.tab);
      if (res.pair[role] === tabId) b.classList.add("on");
      b.onclick = async () => { await op({ op: "assign", role, tabId }); renderTabs(); refresh(); };
    }
    box.appendChild(el);
  }
}

$("export").onclick = async () => {
  const r = await op({ op: "export" });
  $("profile").value = r && r.ok ? JSON.stringify(r.profile) : "본편·반응을 먼저 지정해줘";
  $("profile").select();
};

$("import").onclick = async () => {
  const r = await op({ op: "import", json: $("profile").value });
  if (r && r.ok) refresh(); else $("profile").value = "형식이 안 맞아";
};

document.querySelector("details").addEventListener("toggle", (e) => {
  if (e.target.open) renderTabs();
});

refresh();
setInterval(refresh, 800);
