import http from "node:http";
import { loadArchive, persist, withWriteLock } from "./archive.js";
import { registerWater, correctWater } from "./water-service.js";
import { createStick, openTest, judgeSignoff, computeStats, stickStatusOf, STICK_STAGES } from "./signoff-service.js";

const port = Number(process.env.PORT || 3037);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是合法 JSON");
    error.status = 400;
    error.code = "bad_json";
    throw error;
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

// 列表视图与统计均由同一份档案派生：开试结果、签样状态、水批准入一荣俱荣。
function buildState(archive) {
  const waterById = new Map(archive.waters.map((w) => [w.id, w]));
  const activeSignsByWater = new Map();
  for (const stick of archive.sticks) {
    for (const test of stick.tests || []) {
      if (test.sign && test.sign.valid) {
        activeSignsByWater.set(test.waterId, (activeSignsByWater.get(test.waterId) || 0) + 1);
      }
    }
  }
  const waters = archive.waters.map((w) => ({ ...w, activeSigns: activeSignsByWater.get(w.id) || 0 }));
  const sticks = archive.sticks.map((stick) => {
    const tests = (stick.tests || []).map((test) => ({
      ...test,
      waterSource: (waterById.get(test.waterId) || {}).source || "未知水批",
      waterStatus: (waterById.get(test.waterId) || {}).status || "未知"
    }));
    const open = tests.find((t) => t.status === "待签样");
    return { ...stick, tests, status: stickStatusOf(stick), openTestId: open ? open.id : null };
  });
  const events = archive.events.slice(-30).reverse();
  return { sticks, waters, events, stats: computeStats(archive) };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>试墨用水准入与签样复核台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --amber:#9a6a1f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:18px 0 10px; font-size:16px; }
    main { display:grid; grid-template-columns:370px 1fr; gap:22px; padding:22px 28px; align-items:start; }
    .side { display:grid; gap:14px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; margin-top:12px; } button.secondary { background:#69736a; margin-top:0; } button.danger { background:var(--warn); margin-top:0; }
    .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:6px; }
    .statgroup { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; display:grid; gap:8px; grid-template-columns:repeat(auto-fit,minmax(90px,1fr)); }
    .statgroup > .gtitle { grid-column:1/-1; color:var(--muted); font-size:12px; font-weight:700; }
    .stat strong { display:block; font-size:22px; } .stat span { color:var(--muted); font-size:12px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:7px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; background:#f6f7f4; }
    .pill.ok { color:var(--accent); border-color:var(--accent); } .pill.warn { color:var(--warn); border-color:var(--warn); } .pill.amber { color:var(--amber); border-color:var(--amber); }
    .logs { border-top:1px solid var(--line); padding-top:8px; display:grid; gap:6px; max-height:220px; overflow:auto; }
    .warn { color:var(--warn); font-weight:700; } .hint { font-size:12px; color:var(--muted); margin:8px 0 0; min-height:16px; }
    .events { display:grid; gap:6px; max-height:260px; overflow:auto; }
    #toast { position:fixed; right:20px; bottom:20px; display:grid; gap:8px; z-index:10; }
    #toast div { background:#2b2f2a; color:#fff; padding:10px 14px; border-radius:8px; font-size:13px; max-width:360px; }
    #toast div.error { background:var(--warn); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>试墨用水准入与签样复核台</h1><div class="meta">水批准入校验 · 一锭一试签样复核 · 档案落盘一致</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section class="side">
      <form id="stickForm" class="panel">
        <h2>墨锭建档</h2>
        <label>墨锭编号</label><input name="code" required>
        <label>烟料来源</label><input name="smokeSource">
        <div class="row"><div><label>胶料比例</label><input name="glueRatio"></div><div><label>存放年限</label><input name="ageYears" type="number" min="0" value="0"></div></div>
        <label>存放位置</label><input name="storage">
        <button>建档</button>
      </form>
      <form id="waterForm" class="panel">
        <h2>水批登记 · 准入校验</h2>
        <label>水源</label><input name="source" required placeholder="如：桃花潭晨水">
        <label>采集日</label><input name="collectedAt" type="date" required>
        <div class="row"><div><label>余量（ml）</label><input name="remainingMl" type="number" min="0" step="1" required></div><div><label>浊度（度）</label><input name="turbidity" type="number" min="0" step="0.1" required></div></div>
        <label>备注</label><input name="note">
        <p class="hint">余量≥20ml 且浊度≤二度判为合格；余量不足或浊度超过二度仅转待换水，不予开试。</p>
        <button>登记水批</button>
      </form>
      <form id="openForm" class="panel">
        <h2>开试 · 每锭一条未结束试墨</h2>
        <label>选择墨锭</label><select name="code" id="openStick"></select>
        <label>试墨用水（仅合格水批）</label><select name="waterId" id="openWater"></select>
        <label>试墨人</label><input name="tester" required>
        <p class="hint" id="openHint"></p>
        <button>开试（重复提交沿用首次结果）</button>
      </form>
      <form id="signForm" class="panel">
        <h2>签样复核</h2>
        <label>选择待签样试墨</label><select name="code" id="signStick"></select>
        <p class="hint" id="signHint"></p>
        <label>试纸</label><input name="paper" required placeholder="如：净皮宣纸">
        <label>加水量</label><input name="waterAmount" required placeholder="如：20滴">
        <label>出墨速度</label><select name="speed"><option>快</option><option>较快</option><option>中</option><option>较慢</option><option>慢</option></select>
        <label>墨色层次</label><input name="colorLayer" required placeholder="如：浓淡四层，焦墨起甲">
        <label>复核人（不得与试墨人相同）</label><input name="reviewer" required>
        <button>提交签样复核</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部墨锭状态</option>${STICK_STAGES.map((s) => "<option>" + s + "</option>").join("")}</select>
        <input id="search" placeholder="搜索编号、烟料、试墨人或复核人">
      </div>
      <h3>水批列表 · 水批校验</h3>
      <div class="grid" id="waterCards"></div>
      <h3>墨锭与试墨档案 · 签样判定</h3>
      <div class="grid" id="stickCards"></div>
      <div class="panel" style="margin-top:14px"><h3 style="margin-top:0">最近档案轨迹</h3><div class="events" id="events"></div></div>
    </section>
  </main>
  <div id="toast"></div>
  <script>
    const stickStages = ${JSON.stringify(STICK_STAGES)};
    let state = { sticks: [], waters: [], events: [] };
    const $ = (sel) => document.querySelector(sel);

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? Object.assign({}, options, { headers: { 'Content-Type': 'application/json' } }) : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function whenTime(at) { return esc(String(at || '').replace('T', ' ').slice(0, 16)); }
    function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
    function toast(message, isError) {
      const box = document.createElement('div');
      if (isError) box.className = 'error';
      box.textContent = message;
      $('#toast').appendChild(box);
      setTimeout(() => box.remove(), 4200);
    }
    function pill(text, cls) { return '<span class="pill ' + (cls || '') + '">' + esc(text) + '</span>'; }
    function statusPill(status) {
      const cls = status === '合格' || status === '已完成' || status === '已签样' ? 'ok'
        : status === '待换水' || status === '待重测' ? 'warn'
        : status === '试墨中' || status === '待签样' ? 'amber' : '';
      return pill(status, cls);
    }

    function renderStats() {
      const s = state.stats;
      const group = (title, entries) => '<div class="statgroup"><div class="gtitle">' + title + '</div>' +
        entries.map(([k, v]) => '<div class="stat"><span>' + esc(k) + '</span><strong>' + v + '</strong></div>').join('') + '</div>';
      $('#stats').innerHTML =
        group('墨锭', Object.entries(s.stickStats)) +
        group('水批', Object.entries(s.waterStats)) +
        group('签样', Object.entries(s.signStats));
    }

    function renderSelects() {
      $('#openStick').innerHTML = state.sticks.map((stick) =>
        '<option value="' + esc(stick.code) + '">' + esc(stick.code) + ' · ' + esc(stick.smokeSource) + ' · ' + esc(stick.status) + '</option>').join('');
      $('#openWater').innerHTML = state.waters.map((water) =>
        '<option value="' + esc(water.id) + '">' + esc(water.id) + ' · ' + esc(water.source) + ' · ' + esc(water.status) +
        '（余量' + water.remainingMl + 'ml/浊度' + water.turbidity + '度）</option>').join('');
      const pending = state.sticks.filter((stick) => stick.openTestId);
      $('#signStick').innerHTML = pending.length
        ? pending.map((stick) => '<option value="' + esc(stick.code) + '">' + esc(stick.code) + ' · ' + esc(stick.openTestId) + '</option>').join('')
        : '<option value="">（暂无待签样试墨）</option>';
      syncHints();
    }

    function syncHints() {
      const openStick = state.sticks.find((stick) => stick.code === $('#openStick').value);
      $('#openHint').textContent = openStick && openStick.openTestId
        ? '该锭已有未结束试墨 ' + openStick.openTestId + '，提交将沿用首次结果，不另开新条。'
        : '一锭只允许一条未结束试墨；开试前校验水批余量与浊度。';
      const signStick = state.sticks.find((stick) => stick.code === $('#signStick').value);
      const openTest = signStick && signStick.tests.find((t) => t.id === signStick.openTestId);
      $('#signHint').textContent = openTest
        ? '试墨人 ' + openTest.tester + '，用水 ' + openTest.waterId + '（' + openTest.waterSource + '）。复核人不得与试墨人相同。'
        : '暂无待签样试墨。';
    }

    function waterCard(water) {
      const note = '<div class="meta">采集日 ' + esc(water.collectedAt) + ' · 余量 ' + water.remainingMl +
        'ml · 浊度 ' + water.turbidity + ' 度</div>';
      const signs = '<div class="meta">有效签样 ' + water.activeSigns + ' 条</div>';
      const desc = '<div class="meta">' + esc(water.note || '') + '</div>';
      const button = '<button type="button" class="secondary" data-edit-water="' + esc(water.id) + '">更正水批</button>';
      return '<article class="card" id="water-' + esc(water.id) + '"><h3 style="margin:0">' + esc(water.id) + ' · ' +
        esc(water.source) + ' ' + statusPill(water.status) + '</h3>' + note + signs + desc + button + '</article>';
    }

    function editWaterCard(water) {
      const card = $('#water-' + water.id);
      card.innerHTML = '<h3 style="margin:0">更正 ' + esc(water.id) + '</h3>' +
        '<label>水源</label><input data-f="source" value="' + esc(water.source) + '">' +
        '<label>采集日</label><input data-f="collectedAt" type="date" value="' + esc(water.collectedAt) + '">' +
        '<div class="row"><div><label>余量（ml）</label><input data-f="remainingMl" type="number" min="0" step="1" value="' + water.remainingMl + '"></div>' +
        '<div><label>浊度（度）</label><input data-f="turbidity" type="number" min="0" step="0.1" value="' + water.turbidity + '"></div></div>' +
        '<label>备注</label><input data-f="note" value="' + esc(water.note || '') + '">' +
        (water.activeSigns ? '<p class="meta warn">该批水现有 ' + water.activeSigns + ' 条有效签样，更正后立即失效，相关墨锭须重测。</p>' : '<p class="meta">无有效签样，仅重新判准入。</p>') +
        '<div style="display:flex;gap:8px"><button type="button" data-save-water="' + esc(water.id) + '">保存更正</button>' +
        '<button type="button" class="secondary" data-cancel-water="' + esc(water.id) + '">取消</button></div>';
    }

    function testBlock(test) {
      const head = '<div>' + esc(test.id) + ' ' + statusPill(test.status) +
        '<span class="meta"> · ' + esc(test.waterId) + ' ' + esc(test.waterSource) + ' · 开试 ' + whenTime(test.openedAt) + '</span></div>';
      const tester = '<div class="meta">试墨人 ' + esc(test.tester) + '</div>';
      if (test.sign) {
        const sign = '<div class="meta">签样：' + esc(test.sign.paper) + ' · 加水' + esc(test.sign.waterAmount) +
          ' · 出墨' + esc(test.sign.speed) + ' · ' + esc(test.sign.colorLayer) + '<br>复核人 ' + esc(test.sign.reviewer) +
          ' · ' + whenTime(test.sign.signedAt) + (test.sign.valid ? '' : '<span class="warn">（已失效：' + esc(test.sign.invalidReason || '水批更正') + '，须重测）</span>') + '</div>';
        return head + tester + sign;
      }
      return head + tester + '<div class="meta">待签样，签样时复核水批余量与浊度</div>';
    }

    function stickCard(stick) {
      const base = '<div class="meta">' + esc(stick.smokeSource) + ' · 胶 ' + esc(stick.glueRatio) +
        ' · 陈 ' + stick.ageYears + ' 年 · ' + esc(stick.storage) + '</div>';
      const tests = '<div class="logs">' + (stick.tests.length
        ? stick.tests.slice().reverse().map(testBlock).join('')
        : '<div class="meta">暂无试墨</div>') + '</div>';
      return '<article class="card"><h3 style="margin:0">' + esc(stick.code) + ' ' + statusPill(stick.status) + '</h3>' + base + tests + '</article>';
    }

    function renderLists() {
      $('#waterCards').innerHTML = state.waters.map(waterCard).join('') || '<div class="meta">尚未登记水批</div>';
      const filter = $('#statusFilter').value;
      const q = $('#search').value.trim();
      const visible = state.sticks.filter((stick) =>
        (!filter || stick.status === filter) &&
        (!q || JSON.stringify(stick).includes(q)));
      $('#stickCards').innerHTML = visible.map(stickCard).join('') || '<div class="meta">没有匹配的墨锭</div>';
      $('#events').innerHTML = state.events.map((event) =>
        '<div><span class="meta">' + whenTime(event.at) + '</span> ' + pill(event.type) +
        ' <span class="meta">' + esc(event.stickCode || event.waterId || '') + '</span> ' + esc(event.note || '') + '</div>').join('');
    }

    function render() {
      renderStats();
      renderSelects();
      renderLists();
    }
    async function load() { state = await api('/api/state'); render(); }

    async function submitForm(form, path, success) {
      try {
        const result = await api(path, { method: 'POST', body: JSON.stringify(formObject(form)) });
        toast(success(result));
        form.reset();
        const dateInput = form.querySelector('input[type=date]');
        if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
        await load();
      } catch (error) { toast(error.message, true); }
    }

    $('#stickForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitForm($('#stickForm'), '/api/sticks', () => '墨锭已建档');
    });
    $('#waterForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitForm($('#waterForm'), '/api/waters', (water) => '水批 ' + water.id + ' 已登记，准入判定：' + water.status);
    });
    $('#openForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitForm($('#openForm'), '/api/tests/open', (result) =>
        result.reused ? '已有未结束试墨 ' + result.test.id + '，沿用首次结果' : '已开试 ' + result.test.id);
    });
    $('#signForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitForm($('#signForm'), '/api/tests/sign', (test) => '签样已通过复核：' + test.id);
    });

    $('#waterCards').addEventListener('click', async (event) => {
      const editId = event.target.dataset.editWater;
      const cancelId = event.target.dataset.cancelWater;
      const saveId = event.target.dataset.saveWater;
      if (editId) {
        const water = state.waters.find((w) => w.id === editId);
        editWaterCard(water);
        return;
      }
      if (cancelId) { await load(); return; }
      if (saveId) {
        const card = $('#water-' + saveId);
        const payload = {};
        card.querySelectorAll('[data-f]').forEach((input) => { payload[input.dataset.f] = input.value; });
        if (payload.remainingMl !== undefined) payload.remainingMl = Number(payload.remainingMl);
        if (payload.turbidity !== undefined) payload.turbidity = Number(payload.turbidity);
        try {
          const result = await api('/api/waters/' + encodeURIComponent(saveId), { method: 'PATCH', body: JSON.stringify(payload) });
          toast('水批已更正，重新判定：' + result.water.status +
            (result.invalidated.length ? '；' + result.invalidated.length + ' 条旧签样失效，须重测' : ''));
          await load();
        } catch (error) { toast(error.message, true); }
      }
    });

    $('#statusFilter').addEventListener('change', renderLists);
    $('#search').addEventListener('input', renderLists);
    $('#openStick').addEventListener('change', syncHints);
    $('#signStick').addEventListener('change', syncHints);
    $('#reload').addEventListener('click', load);
    const todayInput = document.querySelector('#waterForm input[type=date]');
    if (todayInput) todayInput.value = new Date().toISOString().slice(0, 10);
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/state") {
      const archive = await loadArchive();
      return send(res, 200, buildState(archive));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const archive = await loadArchive();
      return send(res, 200, computeStats(archive));
    }

    if (req.method === "POST" && url.pathname === "/api/sticks") {
      const input = await readBody(req);
      const result = await withWriteLock(async () => {
        const archive = await loadArchive();
        const stick = createStick(archive, input);
        await persist(archive);
        return stick;
      });
      return send(res, 201, result);
    }

    if (req.method === "POST" && url.pathname === "/api/waters") {
      const input = await readBody(req);
      const result = await withWriteLock(async () => {
        const archive = await loadArchive();
        const water = registerWater(archive, input);
        await persist(archive);
        return water;
      });
      return send(res, 201, result);
    }

    const waterPatch = url.pathname.match(/^\/api\/waters\/([^/]+)$/);
    if (waterPatch && req.method === "PATCH") {
      const input = await readBody(req);
      const result = await withWriteLock(async () => {
        const archive = await loadArchive();
        const outcome = correctWater(archive, waterPatch[1], input);
        await persist(archive);
        return outcome;
      });
      return send(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/tests/open") {
      const input = await readBody(req);
      const result = await withWriteLock(async () => {
        const archive = await loadArchive();
        const outcome = openTest(archive, input);
        if (!outcome.reused) await persist(archive);
        return outcome;
      });
      return send(res, result.reused ? 200 : 201, result);
    }

    if (req.method === "POST" && url.pathname === "/api/tests/sign") {
      const input = await readBody(req);
      const result = await withWriteLock(async () => {
        const archive = await loadArchive();
        const test = judgeSignoff(archive, input);
        await persist(archive);
        return test;
      });
      return send(res, 200, result);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, error.status || 500, { error: error.code || "server_error", message: error.message });
  }
});

server.listen(port, () => console.log("试墨用水准入与签样复核台 listening on http://localhost:" + port));
