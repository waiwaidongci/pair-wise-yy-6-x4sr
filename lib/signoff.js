// 业务模块二：签样判定与复核
// 负责试墨生命周期、签样四要素校验、复核人回避，以及水批更正后的失效重测。
// 只操作内存对象，不直接落盘。

import { admit, consume, parseWaterMl, refreshStatus, WATER_USABLE, WATER_PENDING } from "./water.js";

export const TEST_OPEN = "试墨中";
export const TEST_DONE = "已结束";
export const SAMPLE_PENDING = "待复核";
export const SAMPLE_PASSED = "复核通过";
export const SAMPLE_REJECTED = "复核退回";
export const SAMPLE_VOID = "已失效";

export const STICK_PENDING = "待试墨";
export const STICK_TESTING = "试墨中";
export const STICK_DONE = "已试墨";
export const STICK_WATCH = "重点观察";

const REQUIRED_SAMPLE_FIELDS = [
  ["paper", "试纸"],
  ["water", "加水量"],
  ["speed", "出墨速度"],
  ["colorLayer", "墨色层次"]
];

let sequence = 0;
export function genId(prefix) {
  sequence += 1;
  return prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + sequence;
}

function now() { return new Date().toISOString(); }

function pushLog(item, step, note) {
  item.logs.push({ at: now(), step, note });
}

export function openTest(items, batches, input) {
  const item = items.find(x => x.id === input.stickId || x.code === input.stickId);
  if (!item) return { error: "item_not_found", status: 404 };
  if (!String(input.tester || "").trim()) {
    return { error: "tester_required", message: "请填写试墨人", status: 400 };
  }
  const batch = batches.find(b => b.id === input.batchId || b.code === input.batchId);
  if (!batch) return { error: "batch_not_found", message: "水批不存在", status: 404 };

  // 每锭只能有一条未结束试墨：重复或并发提交沿用首次结果
  const existing = item.tests.find(t => t.status === TEST_OPEN);
  if (existing) {
    return { ok: true, reused: true, test: existing };
  }

  // 水批准入校验：不过仅转待换水，不开试
  const verdict = admit(batch);
  if (!verdict.ok) {
    batch.status = WATER_PENDING;
    pushLog(item, "准入", "水批" + batch.code + "校验未过（" + verdict.reasons.join("、") + "），转待换水");
    return { error: "water_not_admitted", reasons: verdict.reasons, status: 409 };
  }

  const test = {
    id: genId("TM"),
    batchId: batch.id,
    tester: String(input.tester).trim(),
    startedAt: now(),
    endedAt: null,
    status: TEST_OPEN,
    samples: []
  };
  item.tests.push(test);
  pushLog(item, "开试", "水批" + batch.code + "准入通过，试墨人" + test.tester);
  return { ok: true, reused: false, test };
}

// 找某锭未结束试墨及其在 tests 中的归属
function findOpenTest(item) {
  return (item.tests || []).find(t => t.status === TEST_OPEN) || null;
}
export function findTest(items, testId) {
  for (const item of items) {
    const test = (item.tests || []).find(t => t.id === testId);
    if (test) return { item, test };
  }
  return null;
}

export function submitSample(items, batches, input) {
  const located = findTest(items, input.testId);
  if (!located) return { error: "test_not_found", message: "试墨记录不存在", status: 404 };
  const { item, test } = located;

  if (test.status !== TEST_OPEN) {
    return { error: "test_closed", message: "该试墨已结束，不能再签样", status: 409 };
  }
  if (test.samples.some(s => s.status === SAMPLE_PENDING)) {
    return { error: "sample_pending", message: "已有签样待复核，沿用在途签样", status: 409 };
  }

  for (const [key, label] of REQUIRED_SAMPLE_FIELDS) {
    if (input[key] === undefined || input[key] === null || String(input[key]).trim() === "") {
      return { error: "field_required", field: key, message: "请填写" + label, status: 400 };
    }
  }
  const waterMl = parseWaterMl(input.water);
  if (waterMl === null || waterMl <= 0) {
    return { error: "bad_water", field: "water", message: "加水量需为毫升数或“N滴”", status: 400 };
  }
  if (!String(input.reviewer || "").trim()) {
    return { error: "reviewer_required", message: "请填写复核人", status: 400 };
  }
  const reviewer = String(input.reviewer).trim();
  if (reviewer === test.tester) {
    return { error: "reviewer_conflict", message: "复核人与试墨人不得相同", status: 409 };
  }

  const batch = batches.find(b => b.id === test.batchId);
  if (!batch) return { error: "batch_not_found", message: "水批不存在", status: 404 };
  const verdict = admit(batch, waterMl);
  if (!verdict.ok) {
    batch.status = WATER_PENDING;
    pushLog(item, "准入", "签样前水批" + batch.code + "校验未过（" + verdict.reasons.join("、") + "），转待换水");
    return { error: "water_not_admitted", reasons: verdict.reasons, status: 409 };
  }

  const sample = {
    id: genId("QY"),
    paper: String(input.paper).trim(),
    water: String(input.water).trim(),
    waterMl,
    speed: String(input.speed).trim(),
    colorLayer: String(input.colorLayer).trim(),
    tester: test.tester,
    reviewer,
    submittedAt: now(),
    reviewedAt: null,
    reviewNote: input.reviewNote ? String(input.reviewNote).trim() : "",
    status: SAMPLE_PENDING
  };
  test.samples.push(sample);
  pushLog(item, "签样", "试纸" + sample.paper + "，加水" + sample.water + "，提交复核");
  return { ok: true, sample };
}

export function reviewSample(items, batches, input) {
  const located = findTest(items, input.testId);
  if (!located) return { error: "test_not_found", message: "试墨记录不存在", status: 404 };
  const { item, test } = located;
  const sample = test.samples.find(s => s.id === input.sampleId);
  if (!sample) return { error: "sample_not_found", message: "签样不存在", status: 404 };
  if (sample.status !== SAMPLE_PENDING) {
    return { error: "sample_closed", message: "该签样已" + sample.status, status: 409 };
  }

  const verdictText = String(input.verdict || "").trim();
  if (verdictText !== SAMPLE_PASSED && verdictText !== SAMPLE_REJECTED) {
    return { error: "bad_verdict", message: "请给出复核结论（复核通过/复核退回）", status: 400 };
  }
  const reviewer = String(input.reviewer || sample.reviewer).trim();
  if (!reviewer) return { error: "reviewer_required", message: "请填写复核人", status: 400 };
  if (reviewer === sample.tester) {
    return { error: "reviewer_conflict", message: "复核人与试墨人不得相同", status: 409 };
  }

  sample.reviewer = reviewer;
  sample.reviewedAt = now();
  if (input.reviewNote) sample.reviewNote = String(input.reviewNote).trim();

  if (verdictText === SAMPLE_REJECTED) {
    sample.status = SAMPLE_REJECTED;
    pushLog(item, "复核", "签样" + sample.id + "退回：" + (sample.reviewNote || "需重测签样"));
    return { ok: true, sample, test };
  }

  // 通过前再做一次水批准入，通过则扣减余量并结束试墨
  const batch = batches.find(b => b.id === test.batchId);
  if (!batch) return { error: "batch_not_found", message: "水批不存在", status: 404 };
  const verdict = admit(batch, sample.waterMl);
  if (!verdict.ok) {
    batch.status = WATER_PENDING;
    pushLog(item, "准入", "复核时水批" + batch.code + "校验未过（" + verdict.reasons.join("、") + "），转待换水");
    return { error: "water_not_admitted", reasons: verdict.reasons, status: 409 };
  }

  consume(batch, sample.waterMl);
  sample.status = SAMPLE_PASSED;
  test.status = TEST_DONE;
  test.endedAt = now();
  pushLog(item, "复核", "签样" + sample.id + "通过，复核人" + reviewer + "，扣水" + sample.waterMl + "ml");
  return { ok: true, sample, test, batch };
}

// 水批更正：旧签样立即失效并重测
// 更正后重新校验（可能恢复可用），但所有已用该批签样一律失效；
// 已结束试墨重开为“试墨中”，待重新签样复核。
export function correctBatch(items, batch, patch) {
  const before = {
    collectedAt: batch.collectedAt,
    residueMl: batch.residueMl,
    turbidity: batch.turbidity
  };
  if (patch.collectedAt !== undefined) batch.collectedAt = String(patch.collectedAt);
  if (patch.residueMl !== undefined) batch.residueMl = patch.residueMl;
  if (patch.turbidity !== undefined) batch.turbidity = patch.turbidity;
  refreshStatus(batch);

  let reopened = 0;
  let voided = 0;
  for (const item of items) {
    for (const test of item.tests || []) {
      if (test.batchId !== batch.id) continue;
      const liveSamples = test.samples.filter(s =>
        s.status === SAMPLE_PASSED || s.status === SAMPLE_PENDING
      );
      if (!liveSamples.length) continue;
      for (const s of liveSamples) {
        s.status = SAMPLE_VOID;
        s.voidedAt = now();
        s.voidReason = "水批" + batch.code + "已更正";
        voided += 1;
      }
      let wasReopened = false;
      if (test.status === TEST_DONE) {
        test.status = TEST_OPEN;
        test.endedAt = null;
        test.reopenedAt = now();
        reopened += 1;
        wasReopened = true;
      }
      pushLog(item, "更正", "水批" + batch.code + "更正，旧签样失效" + (wasReopened ? "并重测" : ""));
    }
  }
  return { batch, before, after: { collectedAt: batch.collectedAt, residueMl: batch.residueMl, turbidity: batch.turbidity, status: batch.status }, voided, reopened };
}

export function latestValidSample(test) {
  return [...(test.samples || [])].reverse().find(s => s.status === SAMPLE_PASSED) || null;
}

// 墨锭状态：未开试→待试墨；存在未结束试墨→试墨中；
// 最近一条结束试墨无通过签样→重点观察；否则→已试墨
export function stickStatus(item) {
  const tests = item.tests || [];
  if (tests.some(t => t.status === TEST_OPEN)) return STICK_TESTING;
  if (!tests.length) return STICK_PENDING;
  const last = tests[tests.length - 1];
  return latestValidSample(last) ? STICK_DONE : STICK_WATCH;
}
