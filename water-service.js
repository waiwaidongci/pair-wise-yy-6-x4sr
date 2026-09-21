// 业务模块一：水批校验
// 水批登记（采集日、余量、浊度）与准入判定；余量不足或浊度超过二度时仅转待换水。
// 水批更正后，凡引用该批水的旧签样立即失效，对应墨锭须重测。
import { fail } from "./errors.js";
import { nextId, recordEvent } from "./archive.js";

export const MIN_REMAINING_ML = 20; // 准入试墨最低余量
export const MAX_TURBIDITY = 2;     // 浊度二度为上限，超过即待换水

export function waterStatusOf(water) {
  return water.remainingMl < MIN_REMAINING_ML || water.turbidity > MAX_TURBIDITY
    ? "待换水"
    : "合格";
}

function readWaterInput(input) {
  const source = String(input.source || "").trim();
  const collectedAt = String(input.collectedAt || "").trim();
  const remainingMl = Number(input.remainingMl);
  const turbidity = Number(input.turbidity);
  if (!source) throw fail(400, "source_required", "须填写水源");
  if (!collectedAt) throw fail(400, "collected_at_required", "须登记采集日");
  if (!Number.isFinite(remainingMl) || remainingMl < 0) throw fail(400, "remaining_invalid", "余量须为不小于0的数值（ml）");
  if (!Number.isFinite(turbidity) || turbidity < 0) throw fail(400, "turbidity_invalid", "浊度须为不小于0的数值（度）");
  return { source, collectedAt, remainingMl, turbidity, note: String(input.note || "").trim() };
}

export function registerWater(archive, input) {
  const data = readWaterInput(input);
  const water = {
    id: nextId(archive.waters, "WB"),
    ...data,
    status: waterStatusOf({ remainingMl: data.remainingMl, turbidity: data.turbidity })
  };
  archive.waters.push(water);
  recordEvent(archive, {
    type: "水批登记",
    waterId: water.id,
    note: `${water.source}，采集日${water.collectedAt}，余量${water.remainingMl}ml，浊度${water.turbidity}度 → ${water.status}`
  });
  return water;
}

export function correctWater(archive, id, input) {
  const water = archive.waters.find((w) => w.id === id);
  if (!water) throw fail(404, "water_not_found", "水批不存在");
  const before = {
    source: water.source,
    collectedAt: water.collectedAt,
    remainingMl: water.remainingMl,
    turbidity: water.turbidity
  };
  const data = readWaterInput({ note: water.note, ...input });
  Object.assign(water, data);
  water.status = waterStatusOf(water);

  // 旧签样立即失效：引用该批水且仍有效的签样全部作废，墨锭回到待重测。
  const invalidated = [];
  for (const stick of archive.sticks) {
    for (const test of stick.tests || []) {
      if (test.waterId !== id || !test.sign || !test.sign.valid) continue;
      test.sign.valid = false;
      test.sign.invalidatedAt = new Date().toISOString();
      test.sign.invalidReason = "水批更正";
      test.status = "待重测";
      invalidated.push({ stickCode: stick.code, testId: test.id });
      recordEvent(archive, {
        type: "签样失效",
        stickCode: stick.code,
        testId: test.id,
        waterId: id,
        note: `水批 ${id} 更正（余量${before.remainingMl}ml/浊度${before.turbidity}度 → 余量${water.remainingMl}ml/浊度${water.turbidity}度），旧签样立即失效，须重测`
      });
    }
  }
  recordEvent(archive, {
    type: "水批更正",
    waterId: id,
    note: `采集日${water.collectedAt}，余量${water.remainingMl}ml，浊度${water.turbidity}度 → ${water.status}` +
      (invalidated.length ? `；${invalidated.length} 条旧签样失效` : "；无有效签样受影响")
  });
  return { water, invalidated };
}

export function requireUsableWater(archive, waterId) {
  const water = archive.waters.find((w) => w.id === waterId);
  if (!water) throw fail(404, "water_not_found", "水批不存在");
  if (water.remainingMl < MIN_REMAINING_ML) {
    throw fail(409, "water_insufficient", `水批余量不足（${water.remainingMl}ml < ${MIN_REMAINING_ML}ml），仅转待换水`);
  }
  if (water.turbidity > MAX_TURBIDITY) {
    throw fail(409, "water_turbid", `水批浊度超过二度（${water.turbidity}度），仅转待换水`);
  }
  return water;
}
