// 业务模块一：试墨用水准入（水批登记与校验）
// 只做纯校验与状态判定，不负责读写档案。

export const TURBIDITY_LIMIT = 2;          // 浊度上限：二度
export const MIN_RESIDUE_ML = 10;          // 一次试墨最少备水（毫升）
export const WATER_USABLE = "可用";
export const WATER_PENDING = "待换水";

// “加水量”解析：数字按毫升计；“20滴”按 0.05ml/滴 折算为 1ml
export function parseWaterMl(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const drops = text.match(/^(\d+(?:\.\d+)?)\s*滴$/);
  if (drops) return Number(drops[1]) * 0.05;
  const ml = text.match(/^(\d+(?:\.\d+)?)\s*(?:ml|毫升|毫)$/i);
  if (ml) return Number(ml[1]);
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

// 校验单个字段，返回 { field, message } 或 null
export function validateWaterFields(fields) {
  const { collectedAt, residueMl, turbidity } = fields;
  if (collectedAt === undefined || collectedAt === null || String(collectedAt).trim() === "") {
    return { field: "collectedAt", message: "请填写采集日" };
  }
  const date = new Date(collectedAt);
  if (Number.isNaN(date.getTime())) {
    return { field: "collectedAt", message: "采集日格式不正确" };
  }
  if (parseWaterMl(residueMl) === null || parseWaterMl(residueMl) < 0) {
    return { field: "residueMl", message: "请填写正确的余量（毫升）" };
  }
  const turb = Number(turbidity);
  if (!Number.isFinite(turb) || turb < 0) {
    return { field: "turbidity", message: "请填写正确的浊度" };
  }
  return null;
}

// 水批校验：余量不足或浊度超过二度，仅转“待换水”，不抛出业务外结果
// 返回 { ok, reasons, status }
export function evaluate(batch) {
  const reasons = [];
  const residue = parseWaterMl(batch.residueMl);
  const turbidity = Number(batch.turbidity);
  if (residue === null || residue < MIN_RESIDUE_ML) reasons.push("余量不足");
  if (!Number.isFinite(turbidity) || turbidity > TURBIDITY_LIMIT) reasons.push("浊度超过二度");
  const ok = reasons.length === 0;
  return { ok, reasons, status: ok ? WATER_USABLE : WATER_PENDING };
}

// 准入判定：可用且余量够本次试墨
export function admit(batch, waterMl = MIN_RESIDUE_ML) {
  const verdict = evaluate(batch);
  if (!verdict.ok) return verdict;
  const residue = parseWaterMl(batch.residueMl);
  if (residue < waterMl) {
    return { ok: false, reasons: ["余量不足"], status: WATER_PENDING };
  }
  return verdict;
}

// 按校验结果刷新水批状态
export function refreshStatus(batch) {
  batch.status = evaluate(batch).status;
  return batch;
}

// 试墨结束后扣减余量，扣完后重新校验（可能转待换水）
export function consume(batch, waterMl) {
  const residue = parseWaterMl(batch.residueMl) || 0;
  batch.residueMl = Math.max(0, Number((residue - waterMl).toFixed(3)));
  refreshStatus(batch);
  return batch;
}
