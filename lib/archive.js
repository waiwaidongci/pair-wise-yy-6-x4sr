// 业务模块三：档案落盘
// 负责整库原子写入，以及关键业务动作追加事件流水（append-only 审计档）。
// 另含历史数据迁移：旧版“试磨”记录迁移为水批 + 试墨 + 签样结构。

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { WATER_USABLE } from "./water.js";
import { TEST_DONE, SAMPLE_PASSED } from "./signoff.js";

export class Archive {
  constructor(dataDir, file = "ink-stick-testing.json", journal = "ink-stick-testing.events.log") {
    this.dataDir = dataDir;
    this.file = join(dataDir, file);
    this.journal = join(dataDir, journal);
  }

  async load() {
    if (!existsSync(this.file)) {
      await mkdir(this.dataDir, { recursive: true });
      const db = { items: [], batches: [] };
      await this.persist(db);
      return db;
    }
    const raw = JSON.parse(await readFile(this.file, "utf8"));
    return migrate(raw);
  }

  // 原子落盘：先写临时文件再 rename，保证刷新后列表/统计读到的永远是完整库
  async persist(db) {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = join(this.dataDir, ".ink-stick-testing." + process.pid + "." + Date.now() + ".tmp");
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await renameOver(tmp, this.file);
  }

  async record(event) {
    await mkdir(this.dataDir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    try {
      await appendFile(this.journal, line, "utf8");
    } catch {
      // 审计档写入失败不阻断主业务；主库已原子落盘
    }
  }
}

async function renameOver(tmp, target) {
  const { rename } = await import("node:fs/promises");
  try {
    await rename(tmp, target);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      await writeFile(target, await readFile(tmp));
      const { unlink } = await import("node:fs/promises");
      await unlink(tmp);
    } else {
      throw error;
    }
  }
}

function migrate(db) {
  db.items ||= [];
  db.batches ||= [];
  let changed = false;

  for (const item of db.items) {
    if (!item.id) { item.id = item.code || ("IS-LEGACY-" + Math.abs(hashCode(item.code || item.smokeSource || ""))); changed = true; }
    item.logs ||= [];

    if (Array.isArray(item.tests)) {
      for (const test of item.tests) {
        if (!test.id) { test.id = "TM-LEGACY-" + Math.abs(hashCode(item.id + test.at)); changed = true; }
        test.samples ||= [];
        test.status = test.status || (test.samples.some(s => s.status === SAMPLE_PASSED) ? TEST_DONE : "试墨中");
      }
      continue;
    }

    // 旧版：tests 缺失但 logs/tests[旧] 里有试磨数据 → 建一条已结束试墨
    const legacy = item.tests;
    if (!legacy && item.logs.some(l => l.step === "试磨")) {
      const log = [...item.logs].reverse().find(l => l.step === "试磨");
      const code = "WB-OLD-" + item.code;
      let batch = db.batches.find(b => b.code === code);
      if (!batch) {
        batch = {
          id: "WB-LEGACY-" + Math.abs(hashCode(code)),
          code,
          source: "历史试磨用水",
          collectedAt: String(log.at || "").slice(0, 10) || "2026-06-01",
          residueMl: 500,
          turbidity: 1,
          status: WATER_USABLE,
          createdAt: log.at || new Date().toISOString()
        };
        db.batches.push(batch);
      }
      item.tests = [{
        id: "TM-LEGACY-" + Math.abs(hashCode(item.id + log.at)),
        batchId: batch.id,
        tester: "历史试墨人",
        startedAt: log.at,
        endedAt: log.at,
        status: TEST_DONE,
        samples: [{
          id: "QY-LEGACY-" + Math.abs(hashCode(item.id + log.at)),
          paper: "历史试纸",
          water: "10ml",
          waterMl: 10,
          speed: "历史记录",
          colorLayer: "历史记录",
          tester: "历史试墨人",
          reviewer: "历史复核人",
          submittedAt: log.at,
          reviewedAt: log.at,
          reviewNote: "由旧版试磨记录迁移",
          status: SAMPLE_PASSED
        }]
      }];
      changed = true;
    } else if (!item.tests) {
      item.tests = [];
      changed = true;
    }
  }
  db._migrated = changed;
  return db;
}

function hashCode(text) {
  let h = 0;
  for (const ch of String(text)) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return h;
}
