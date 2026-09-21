// 业务模块二：签样判定
// 每锭墨只允许一条未结束试墨；重复或并发提交沿用首次结果。
// 签样须填试纸、加水量、出墨速度、墨色层次，复核人与试墨人不得相同；签样前再校验水批。
import { fail } from "./errors.js";
import { nextId, recordEvent } from "./archive.js";
import { requireUsableWater } from "./water-service.js";

const OPEN_STATUSES = ["待签样"]; // 未结束试墨
export const STICK_STAGES = ["待试墨", "试墨中", "已完成", "待重测"];

function findStick(archive, code) {
  const stick = archive.sticks.find((s) => s.code === code);
  if (!stick) throw fail(404, "stick_not_found", "墨锭不存在");
  return stick;
}

export function stickStatusOf(stick) {
  const tests = stick.tests || [];
  if (tests.some((t) => t.status === "待重测")) return "待重测";
  if (tests.some((t) => t.status === "待签样")) return "试墨中";
  if (tests.some((t) => t.status === "已签样" && t.sign && t.sign.valid)) return "已完成";
  return "待试墨";
}

function openTestOf(stick) {
  return (stick.tests || []).find((t) => OPEN_STATUSES.includes(t.status));
}

export function createStick(archive, input) {
  const code = String(input.code || "").trim();
  if (!code) throw fail(400, "code_required", "须填写墨锭编号");
  if (archive.sticks.some((s) => s.code === code)) throw fail(409, "code_duplicate", "墨锭编号已存在");
  const stick = {
    code,
    smokeSource: String(input.smokeSource || "").trim(),
    glueRatio: String(input.glueRatio || "").trim(),
    ageYears: Number(input.ageYears) || 0,
    storage: String(input.storage || "").trim(),
    tests: []
  };
  archive.sticks.unshift(stick);
  recordEvent(archive, { type: "墨锭建档", stickCode: code, note: `${stick.smokeSource}，存放于${stick.storage || "未登记"}` });
  return stick;
}

// 开试：一锭一条未结束试墨，重复/并发提交沿用首次结果（不另开新条、不另记轨迹）。
export function openTest(archive, input) {
  const code = String(input.code || "").trim();
  const waterId = String(input.waterId || "").trim();
  const tester = String(input.tester || "").trim();
  if (!code) throw fail(400, "code_required", "须选择墨锭");
  if (!waterId) throw fail(400, "water_required", "须选择试墨用水");
  if (!tester) throw fail(400, "tester_required", "须填写试墨人");
  const stick = findStick(archive, code);
  const existing = openTestOf(stick);
  if (existing) {
    return { test: existing, reused: true };
  }
  requireUsableWater(archive, waterId);
  const test = {
    id: nextId(archive.sticks.flatMap((s) => s.tests || []), "T"),
    waterId,
    tester,
    openedAt: new Date().toISOString(),
    status: "待签样"
  };
  stick.tests.push(test);
  recordEvent(archive, {
    type: "开试",
    stickCode: code,
    testId: test.id,
    waterId,
    note: `试墨人 ${tester}，用水 ${waterId}`
  });
  return { test, reused: false };
}

// 签样复核：四项必填、复核人不得与试墨人相同、水批按余量与浊度再校验。
export function judgeSignoff(archive, input) {
  const code = String(input.code || "").trim();
  const stick = findStick(archive, code);
  const test = openTestOf(stick);
  if (!test) throw fail(409, "no_open_test", "该墨锭没有未结束试墨，请先开试");

  const paper = String(input.paper || "").trim();
  const waterAmount = String(input.waterAmount || "").trim();
  const speed = String(input.speed || "").trim();
  const colorLayer = String(input.colorLayer || "").trim();
  const reviewer = String(input.reviewer || "").trim();
  if (!paper) throw fail(400, "paper_required", "签样须填试纸");
  if (!waterAmount) throw fail(400, "water_amount_required", "签样须填加水量");
  if (!speed) throw fail(400, "speed_required", "签样须填出墨速度");
  if (!colorLayer) throw fail(400, "color_layer_required", "签样须填墨色层次");
  if (!reviewer) throw fail(400, "reviewer_required", "须填写复核人");
  if (reviewer === test.tester) throw fail(409, "reviewer_conflict", "复核人与试墨人不得相同");
  requireUsableWater(archive, test.waterId);

  test.sign = {
    paper,
    waterAmount,
    speed,
    colorLayer,
    reviewer,
    signedAt: new Date().toISOString(),
    valid: true
  };
  test.status = "已签样";
  recordEvent(archive, {
    type: "签样通过",
    stickCode: code,
    testId: test.id,
    waterId: test.waterId,
    note: `${paper}，加水${waterAmount}，出墨${speed}；复核人 ${reviewer}`
  });
  return test;
}

export function computeStats(archive) {
  const sticks = archive.sticks.map(stickStatusOf);
  const stickStats = Object.fromEntries(STICK_STAGES.map((s) => [s, 0]));
  for (const status of sticks) stickStats[status] += 1;

  const waterStats = { 合格: 0, 待换水: 0 };
  for (const water of archive.waters) waterStats[water.status] = (waterStats[water.status] || 0) + 1;

  const allTests = archive.sticks.flatMap((s) => s.tests || []);
  const signStats = {
    有效签样: allTests.filter((t) => t.sign && t.sign.valid).length,
    已失效签样: allTests.filter((t) => t.sign && !t.sign.valid).length,
    待签样: allTests.filter((t) => t.status === "待签样").length
  };
  return { stickStats, waterStats, signStats };
}
