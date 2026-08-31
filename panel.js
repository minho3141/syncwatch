"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const out = document.getElementById("out");

function op(o) { return api.runtime.sendMessage({ ns: "syncwatch", ...o }); }

async function refresh() {
  const s = await op({ op: "status" });
  if (!s) { out.textContent = "background 응답 없음"; return; }
  const f = (x) => (x == null ? "?" : Number(x).toFixed(2));
  const m = s.main, r = s.reaction;
  out.textContent = [
    `본편   ${f(m && m.time)}   ${m ? (m.paused ? "정지" : "재생") : "-"}  ×${f(m && m.rate)}  [${m ? m.host : "-"}]`,
    `리액션 ${f(r && r.time)}   ${r ? (r.paused ? "정지" : "재생") : "-"}  ×${f(r && r.rate)}  [${r ? r.host : "-"}]`,
    ``,
    `실제 차이(R-M) ${f(m && r ? r.time - m.time : null)}`,
    `설정 오프셋     ${f(s.pair.offsetMs / 1000)}`,
    `어긋남(drift)   ${f(s.drift)}`,
    `묶임            ${s.pair.linked}`,
  ].join("\n");
}

document.querySelectorAll("button").forEach((b) => {
  b.onclick = async () => {
    if (b.dataset.op === "list") {
      const r = await op({ op: "list" });
      out.textContent = JSON.stringify(r, null, 1);
    } else refresh();
  };
});

refresh();
setInterval(refresh, 1000);
