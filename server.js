import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Archive } from "./lib/archive.js";
import {
  validateWaterFields,
  evaluate,
  WATER_USABLE,
  WATER_PENDING
} from "./lib/water.js";
import {
  genId,
  openTest,
  submitSample,
  reviewSample,
  correctBatch,
  stickStatus,
  STICK_PENDING,
  STICK_TESTING,
  STICK_DONE,
  STICK_WATCH,
  SAMPLE_PENDING,
  SAMPLE_PASSED,
  SAMPLE_REJECTED,
  SAMPLE_VOID,
  TEST_OPEN
} from "./lib/signoff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const archive = new Archive(join(__dirname, "data"));
const port = Number(process.env.PORT || 3037);

const stages = [STICK_PENDING, STICK_TESTING, STICK_DONE, STICK_WATCH];
const statLabels = stages;
const itemFields = [
  ["code", "墨锭编号", "text"],
  ["smokeSource", "烟料来源", "text"],
  ["glueRatio", "胶料比例", "text"],
  ["ageYears", "存放年限", "number"],
  ["storage", "存放位置", "text"]
];

// ---- 工具 ----
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function fail(res, result) {
  send(res, result.status || 400, { error: result.error, message: result.message, reasons: result.reasons, field: result.field });
}

// 所有写操作串行化：并发开试/签样/更正按序进入临界区，库内状态为唯一裁决依据
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

function batchOf(db, idOrCode) {
  return db.batches.find(b => b.id === idOrCode || b.code === idOrCode) || null;
}

// 列表/统计/详情共用同一投影，保证三处口径一致、刷新后不漂移
function projectItem(db, item) {
  const status = stickStatus(item);
  const tests = (item.tests || []).map(t => {
    const batch = db.batches.find(b => b.id === t.batchId);
    const samples = (t.samples || []).map(s => ({ ...s }));
    return {
      id: t.id,
      batchId: t.batchId,
      batchCode: batch ? batch.code : "",
      batchStatus: batch ? batch.status : "",
      tester: t.tester,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      reopenedAt: t.reopenedAt || null,
      status: t.status,
      pendingSample: samples.some(s => s.status === SAMPLE_PENDING),
      samples
    };
  });
  const openTest = tests.find(t => t.status === TEST_OPEN) || null;
  return {
    id: item.id,
    code: item.code,
    smokeSource: item.smokeSource,
    glueRatio: item.glueRatio,
    ageYears: item.ageYears,
    storage: item.storage,
    status,
    openTestId: openTest ? openTest.id : null,
    testCount: tests.length,
    pendingSamples: tests.reduce((n, t) => n + t.samples.filter(s => s.status === SAMPLE_PENDING).length, 0),
    tests,
    logs: (item.logs || []).slice(-30)
  };
}

function computeStats(db) {
  const items = db.items.map(x => projectItem(db, x));
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) stats[item.status] += 1;
  stats.水批可用 = db.batches.filter(b => b.status === WATER_USABLE).length;
  stats.待换水 = db.batches.filter(b => b.status === WATER_PENDING).length;
  stats.待复核签样 = items.reduce((n, i) => n + i.pendingSamples, 0);
  stats.试墨中 = items.filter(i => i.status === STICK_TESTING).length;
  return stats;
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") return html(res, page());

    if (req.method === "GET" && path === "/api/items") {
      const db = await archive.load();
      return send(res, 200, db.items.map(x => projectItem(db, x)));
    }
    if (req.method === "GET" && path === "/api/stats") {
      const db = await archive.load();
      return send(res, 200, computeStats(db));
    }
    if (req.method === "GET" && path === "/api/batches") {
      const db = await archive.load();
      return send(res, 200, db.batches);
    }

    const itemDetail = path.match(/^\/api\/items\/([^/]+)$/);
    if (itemDetail && req.method === "GET") {
      const db = await archive.load();
      const item = db.items.find(x => x.id === itemDetail[1] || x.code === itemDetail[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, projectItem(db, item));
    }

    if (req.method === "POST" && path === "/api/items") {
      return withWriteLock(async () => {
        const db = await archive.load();
        const input = await readBody(req);
        if (!String(input.code || "").trim()) return send(res, 400, { error: "code_required", message: "请填写墨锭编号" });
        if (db.items.some(x => x.code === String(input.code).trim())) {
          return send(res, 409, { error: "code_duplicated", message: "墨锭编号已存在" });
        }
        const item = {
          id: genId("IS"),
          code: String(input.code).trim(),
          smokeSource: String(input.smokeSource || "").trim(),
          glueRatio: String(input.glueRatio || "").trim(),
          ageYears: input.ageYears === "" || input.ageYears === undefined ? null : Number(input.ageYears),
          storage: String(input.storage || "").trim(),
          tests: [],
          logs: [{ at: new Date().toISOString(), step: "建档", note: "墨锭建档，状态：待试墨" }]
        };
        db.items.unshift(item);
        await archive.persist(db);
        await archive.record({ action: "item_create", code: item.code, id: item.id });
        return send(res, 201, projectItem(db, item));
      });
    }

    if (req.method === "POST" && path === "/api/batches") {
      return withWriteLock(async () => {
        const db = await archive.load();
        const input = await readBody(req);
        const code = String(input.code || "").trim();
        if (!code) return send(res, 400, { error: "code_required", message: "请填写水批编号" });
        if (db.batches.some(b => b.code === code)) return send(res, 409, { error: "code_duplicated", message: "水批编号已存在" });
        const fields = { collectedAt: input.collectedAt, residueMl: input.residueMl, turbidity: input.turbidity };
        const bad = validateWaterFields(fields);
        if (bad) return send(res, 400, { error: "field_invalid", ...bad });
        const batch = {
          id: genId("WB"),
          code,
          source: String(input.source || "").trim(),
          collectedAt: String(input.collectedAt),
          residueMl: Number(fields.residueMl),
          turbidity: Number(fields.turbidity),
          status: "",
          createdAt: new Date().toISOString()
        };
        batch.status = evaluate(batch).status;
        db.batches.unshift(batch);
        await archive.persist(db);
        await archive.record({ action: "batch_register", code: batch.code, status: batch.status });
        return send(res, 201, batch);
      });
    }

    const batchPatch = path.match(/^\/api\/batches\/([^/]+)$/);
    if (batchPatch && req.method === "PATCH") {
      return withWriteLock(async () => {
        const db = await archive.load();
        const batch = batchOf(db, batchPatch[1]);
        if (!batch) return send(res, 404, { error: "batch_not_found" });
        const patch = await readBody(req);
        const merged = {
          collectedAt: patch.collectedAt !== undefined ? patch.collectedAt : batch.collectedAt,
          residueMl: patch.residueMl !== undefined ? patch.residueMl : batch.residueMl,
          turbidity: patch.turbidity !== undefined ? patch.turbidity : batch.turbidity
        };
        const bad = validateWaterFields(merged);
        if (bad) return send(res, 400, { error: "field_invalid", ...bad });
        const result = correctBatch(db.items, batch, patch);
        await archive.persist(db);
        await archive.record({
          action: "batch_correct",
          code: batch.code,
          status: batch.status,
          voided: result.voided,
          reopened: result.reopened
        });
        return send(res, 200, { ...result, message: "水批已更正，旧签样立即失效" + (result.reopened ? "，" + result.reopened + "锭重测" : "") });
      });
    }

    if (req.method === "POST" && path === "/api/tests") {
      return withWriteLock(async () => {
        const db = await archive.load();
        const input = await readBody(req);
        const result = openTest(db.items, db.batches, input);
        if (result.error) return fail(res, result);
        await archive.persist(db);
        await archive.record({
          action: "test_start",
          stickId: input.stickId,
          batchId: input.batchId,
          testId: result.test.id,
          reused: result.reused
        });
        const item = db.items.find(x => x.id === input.stickId || x.code === input.stickId);
        return send(res, result.reused ? 200 : 201, {
          ...projectItem(db, item),
          reused: result.reused,
          message: result.reused ? "该锭已有未结束试墨，沿用首次结果" : "试墨已开始"
        });
      });
    }

    const sampleSubmit = path.match(/^\/api\/tests\/([^/]+)\/samples$/);
    if (sampleSubmit && req.method === "POST") {
      return withWriteLock(async () => {
        const db = await archive.load();
        const input = { ...(await readBody(req)), testId: sampleSubmit[1] };
        const result = submitSample(db.items, db.batches, input);
        if (result.error) return fail(res, result);
        await archive.persist(db);
        await archive.record({ action: "sample_submit", testId: input.testId, sampleId: result.sample.id });
        const item = db.items.find(x => (x.tests || []).some(t => t.id === input.testId));
        return send(res, 201, projectItem(db, item));
      });
    }

    const review = path.match(/^\/api\/tests\/([^/]+)\/samples\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      return withWriteLock(async () => {
        const db = await archive.load();
        const input = {
          ...(await readBody(req)),
          testId: review[1],
          sampleId: review[2]
        };
        const result = reviewSample(db.items, db.batches, input);
        if (result.error) return fail(res, result);
        await archive.persist(db);
        await archive.record({
          action: "sample_review",
          testId: input.testId,
          sampleId: input.sampleId,
          verdict: result.sample.status
        });
        const item = db.items.find(x => (x.tests || []).some(t => t.id === input.testId));
        return send(res, 200, projectItem(db, item));
      });
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log("试墨用水准入与签样复核台 listening on http://localhost:" + port));

// ---- 页面 ----
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>试墨用水准入与签样复核台</title>
  <style>
    :root { --bg:#eef1ea; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --water:#34597a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:25px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:16px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
    .left { display:grid; gap:14px; position:sticky; top:14px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:10px; }
    button.water { background:var(--water); } button.danger { background:var(--warn); } button.ghost { background:#69736a; } button.mini { padding:5px 9px; font-size:12px; margin-top:6px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:23px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin:0 0 14px; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; }
    .card { display:grid; gap:6px; } .meta { color:var(--muted); font-size:12.5px; line-height:1.6; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .pill.ok { background:#e7f0df; border-color:#aec79c; color:#3c5a2a; } .pill.bad { background:#f6e3dd; border-color:#d8a394; color:#8a3d2c; }
    .pill.watch { background:#fbf3d8; border-color:#e0c876; color:#7a5d10; } .pill.run { background:#e3ecf4; border-color:#9db8d2; color:#2c4a68; }
    .sample { border:1px dashed var(--line); border-radius:6px; padding:8px 10px; margin-top:6px; font-size:12.5px; }
    .logs { border-top:1px solid var(--line); padding-top:7px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .toast { position:fixed; right:20px; bottom:20px; background:#20241f; color:#fff; padding:12px 16px; border-radius:8px; max-width:360px; display:none; font-size:13px; z-index:9; }
    .batchrow { display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:8px; }
    .inline { display:grid; grid-template-columns:1fr 1fr; gap:6px; } .inline label { margin:4px 0 2px; } .inline input { padding:6px; }
    @media (max-width:960px){ header{display:block;padding:16px;} main{grid-template-columns:1fr;padding:14px;} .left{position:static;} }
  </style>
</head>
<body>
  <header>
    <div><h1>试墨用水准入与签样复核台</h1><div class="meta">水批准入 · 每锭一条未结束试墨 · 签样四要素复核 · 水批更正旧签样失效重测</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section class="left">
      <form id="createForm">
        <h2>① 墨锭建档</h2><div id="itemFields"></div><button>保存墨锭</button>
      </form>
      <form id="batchForm">
        <h2>② 水批登记（采集日 / 余量 / 浊度）</h2>
        <div id="batchFields"></div>
        <button class="water">登记水批</button>
        <div class="meta">浊度超过二度或余量不足，仅转“待换水”，不允许开试。</div>
      </form>
      <form id="startForm">
        <h2>③ 开始试墨</h2><div id="startFields"></div>
        <button>提交开试</button>
        <div class="meta">每锭仅一条未结束试墨，重复或并发提交沿用首次结果。</div>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px">
        <h2>水批台账</h2><div id="batches"></div>
      </div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>' + s + '</option>').join('')}</select>
        <input id="search" placeholder="搜索编号 / 烟料 / 试墨人 / 复核人">
      </div>
      <div class="grid" id="cards"></div>
    </section>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const stages = ["待试墨","试墨中","已试墨","重点观察"];
    const itemFields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const S_PENDING = "待复核", S_PASSED = "复核通过", S_REJECTED = "复核退回", S_VOID = "已失效";
    let items = [], batches = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.message || data.error || "请求失败"), { data });
      return data;
    }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;" }[c])); }
    function toast(msg, bad) { const t = document.querySelector("#toast"); t.textContent = msg; t.style.background = bad ? "#8a3d2c" : "#20241f"; t.style.display = "block"; clearTimeout(t._timer); t._timer = setTimeout(() => t.style.display = "none", 3200); }
    function today() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }

    function renderStaticForms() {
      document.querySelector("#itemFields").innerHTML = itemFields.map(function(f){ return "<label>" + f[1] + "</label><input name='" + f[0] + "' type='" + f[2] + "'" + (f[0]==="code"?" required":"") + ">"; }).join("");
      document.querySelector("#batchFields").innerHTML =
        "<label>水批编号</label><input name='code' required>" +
        "<label>水源说明</label><input name='source' placeholder='如：虎跑泉水 / 自来水'>" +
        "<label>采集日</label><input name='collectedAt' type='date' value='" + today() + "' required>" +
        "<div class='inline'><div><label>余量（ml）</label><input name='residueMl' type='number' min='0' step='0.1' required></div>" +
        "<div><label>浊度（度）</label><input name='turbidity' type='number' min='0' step='0.1' required></div></div>";
    }

    function renderStartForm() {
      const usable = batches.filter(b => b.status === "可用");
      let html = "<label>选择墨锭</label><select name='stickId' required>" +
        items.map(function(i){ return "<option value='" + esc(i.id) + "'>" + esc(i.code) + " · " + esc(i.status) + (i.openTestId ? "（未结束试墨中）" : "") + "</option>"; }).join("") + "</select>";
      html += "<label>选择水批</label><select name='batchId' required>" +
        (usable.length ? usable.map(function(b){ return "<option value='" + esc(b.id) + "'>" + esc(b.code) + " · 余" + esc(b.residueMl) + "ml · 浊度" + esc(b.turbidity) + "</option>"; }).join("")
          : "<option value=''>暂无可用水批，请先登记或更正</option>") + "</select>";
      html += "<label>试墨人</label><input name='tester' required>";
      document.querySelector("#startFields").innerHTML = html;
    }

    function statusPill(status) {
      const cls = status === "已试墨" || status === "可用" ? "ok" :
        status === "重点观察" || status === "待换水" ? "bad" :
        status === "试墨中" ? "run" : status === "复核通过" ? "ok" :
        status === "复核退回" || status === "已失效" ? "watch" : "";
      return "<span class='pill " + cls + "'>" + esc(status) + "</span>";
    }

    function sampleHtml(test, s) {
      let out = "<div class='sample'>" + statusPill(s.status) +
        " <b>签样 " + esc(s.id.slice(-5)) + "</b><div class='meta'>试纸：" + esc(s.paper) +
        " ｜ 加水：" + esc(s.water) + "（" + esc(s.waterMl) + "ml）<br>出墨速度：" + esc(s.speed) +
        " ｜ 墨色层次：" + esc(s.colorLayer) + "<br>试墨人：" + esc(s.tester) + " ｜ 复核人：" + esc(s.reviewer) +
        (s.reviewNote ? "<br>复核意见：" + esc(s.reviewNote) : "") +
        (s.voidReason ? "<br><span class='warn'>" + esc(s.voidReason) + "</span>" : "") + "</div>";
      if (s.status === S_PENDING) {
        out += "<div class='inline' style='margin-top:6px'><input placeholder='复核人（不得与试墨人相同）' data-reviewer data-test='" + esc(test.id) + "' data-sample='" + esc(s.id) + "'>" +
          "<input placeholder='复核意见（可选）' data-note data-test='" + esc(test.id) + "' data-sample='" + esc(s.id) + "'></div>" +
          "<button class='mini' data-act='pass' data-test='" + esc(test.id) + "' data-sample='" + esc(s.id) + "'>复核通过</button> " +
          "<button class='mini ghost' data-act='reject' data-test='" + esc(test.id) + "' data-sample='" + esc(s.id) + "'>复核退回</button>";
      }
      return out + "</div>";
    }

    function cardHtml(item) {
      const main = itemFields.slice(0,4).map(function(f){ return "<div class='meta'><b>" + f[1] + "</b>：" + esc(item[f[0]]) + "</div>"; }).join("");
      const tests = (item.tests || []).slice().reverse().map(function(t){
        const head = "<div class='meta'>试墨 " + esc(t.id.slice(-6)) + " · 水批 " + esc(t.batchCode) + " · " + esc(t.tester) +
          (t.reopenedAt ? " · <span class='warn'>水批更正后重测</span>" : "") + " " + statusPill(t.status) + "</div>";
        const samples = (t.samples || []).slice().reverse().map(s => sampleHtml(t, s)).join("");
        let form = "";
        if (t.status === "试墨中" && !t.pendingSample) {
          form = "<form data-act='sample' data-test='" + esc(t.id) + "' class='sample'>" +
            "<label>试纸</label><input name='paper' required>" +
            "<label>加水量（ml，也可填“20滴”）</label><input name='water' required>" +
            "<label>出墨速度</label><input name='speed' required>" +
            "<label>墨色层次</label><input name='colorLayer' required>" +
            "<label>复核人（须与试墨人 “" + esc(t.tester) + "” 不同）</label><input name='reviewer' required>" +
            "<button class='mini water'>提交签样复核</button></form>";
        }
        return "<div style='border-top:1px dashed var(--line);padding-top:6px;margin-top:6px'>" + head + samples + form + "</div>";
      }).join("");
      const logs = (item.logs || []).slice(-5).reverse().map(l => "<div>· " + esc(l.step) + "：" + esc(l.note) + "</div>").join("");
      return "<article class='card'><div class='batchrow'><h3>" + esc(item.code) + "</h3>" + statusPill(item.status) + "</div>" +
        main + (item.smokeSource ? "" : "") + tests +
        "<div class='logs meta'>" + (logs || "暂无记录") + "</div></article>";
    }

    function batchCard(b) {
      return "<div class='sample' style='border-style:solid'><div class='batchrow'><b>" + esc(b.code) + "</b> " + statusPill(b.status) + "</div>" +
        "<div class='meta'>" + esc(b.source || "—") + " ｜ 采集日 " + esc(b.collectedAt) + " ｜ 余量 " + esc(b.residueMl) + "ml ｜ 浊度 " + esc(b.turbidity) + " 度</div>" +
        "<form data-act='batchfix' data-batch='" + esc(b.id) + "'><div class='inline'>" +
        "<div><label>采集日更正</label><input name='collectedAt' type='date' value='" + esc(b.collectedAt) + "'></div>" +
        "<div><label>余量更正（ml）</label><input name='residueMl' type='number' step='0.1' value='" + esc(b.residueMl) + "'></div>" +
        "</div><label>浊度更正（度）</label><input name='turbidity' type='number' step='0.1' value='" + esc(b.turbidity) + "'>" +
        "<button class='mini danger'>保存更正（旧签样立即失效并重测）</button></form></div>";
    }

    function renderStats(data) {
      const order = ["待试墨","试墨中","已试墨","重点观察","水批可用","待换水","待复核签样"];
      document.querySelector("#stats").innerHTML = order.map(function(k){
        return "<div class='stat'><span>" + k + "</span><strong>" + (data[k] || 0) + "</strong></div>";
      }).join("");
    }

    function render() {
      renderStartForm();
      renderStats(clientStats());
      document.querySelector("#batches").innerHTML = batches.length ? batches.map(batchCard).join("") : "<div class='meta'>暂无水批</div>";
      const status = document.querySelector("#statusFilter").value;
      const q = document.querySelector("#search").value.trim();
      const visible = items.filter(function(item){
        const hit = !q || JSON.stringify(item).includes(q);
        return (!status || item.status === status) && hit;
      });
      document.querySelector("#cards").innerHTML = visible.map(cardHtml).join("");
    }

    function clientStats() {
      const s = { "待试墨":0,"试墨中":0,"已试墨":0,"重点观察":0,"水批可用":0,"待换水":0,"待复核签样":0 };
      items.forEach(function(i){ s[i.status] = (s[i.status]||0)+1; s["待复核签样"] += i.pendingSamples; });
      batches.forEach(function(b){ if (b.status === "可用") s["水批可用"]++; else if (b.status === "待换水") s["待换水"]++; });
      return s;
    }

    async function load() {
      const [list, stats, bs] = await Promise.all([api("/api/items"), api("/api/stats"), api("/api/batches")]);
      items = list; batches = bs;
      render();
      renderStats(stats); // 服务端统计为准，与列表同库同源
    }

    function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }

    document.querySelector("#createForm").onsubmit = async function(e) {
      e.preventDefault();
      try { await api("/api/items", { method: "POST", body: JSON.stringify(formObject(this)) }); this.reset(); toast("墨锭已建档"); await load(); }
      catch (err) { toast(err.message, true); }
    };
    document.querySelector("#batchForm").onsubmit = async function(e) {
      e.preventDefault();
      try { const b = await api("/api/batches", { method: "POST", body: JSON.stringify(formObject(this)) }); toast("水批已登记，校验结果：" + b.status); this.reset(); await load(); }
      catch (err) { toast(err.message, true); }
    };
    document.querySelector("#startForm").onsubmit = async function(e) {
      e.preventDefault();
      try { const r = await api("/api/tests", { method: "POST", body: JSON.stringify(formObject(this)) }); toast(r.message || "试墨已开始"); await load(); }
      catch (err) { toast((err.data && err.data.reasons || []).join("、") || err.message, true); await load(); }
    };

    document.addEventListener("click", async function(e) {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act, testId = btn.dataset.test, sampleId = btn.dataset.sample;
      try {
        if (act === "pass" || act === "reject") {
          const reviewer = document.querySelector("[data-reviewer][data-test='" + testId + "'][data-sample='" + sampleId + "']").value.trim();
          const note = document.querySelector("[data-note][data-test='" + testId + "'][data-sample='" + sampleId + "']").value.trim();
          if (!reviewer) return toast("请填写复核人", true);
          const payload = { reviewer: reviewer, reviewNote: note, verdict: act === "pass" ? S_PASSED : S_REJECTED };
          await api("/api/tests/" + encodeURIComponent(testId) + "/samples/" + encodeURIComponent(sampleId) + "/review", { method: "POST", body: JSON.stringify(payload) });
          toast(act === "pass" ? "复核通过，试墨结束并已扣减余量" : "已退回，沿用同一条试墨重新签样");
        }
        await load();
      } catch (err) { toast((err.data && err.data.reasons || []).join("、") || err.message, true); await load(); }
    });

    document.addEventListener("submit", async function(e) {
      const form = e.target;
      if (!form.dataset.act) return;
      e.preventDefault();
      try {
        if (form.dataset.act === "sample") {
          await api("/api/tests/" + encodeURIComponent(form.dataset.test) + "/samples", { method: "POST", body: JSON.stringify(formObject(form)) });
          toast("签样已提交待复核");
        } else if (form.dataset.act === "batchfix") {
          if (!confirm("水批更正后，该批旧签样立即失效，已结束试墨将重开。确认？")) return;
          const r = await api("/api/batches/" + encodeURIComponent(form.dataset.batch), { method: "PATCH", body: JSON.stringify(formObject(form)) });
          toast(r.message || "水批已更正");
        }
        await load();
      } catch (err) { toast((err.data && err.data.reasons || []).join("、") || err.message, true); await load(); }
    });

    document.querySelector("#statusFilter").onchange = render;
    document.querySelector("#search").oninput = render;
    document.querySelector("#reload").onclick = load;
    renderStaticForms();
    load();
  </script>
</body>
</html>`;
}
