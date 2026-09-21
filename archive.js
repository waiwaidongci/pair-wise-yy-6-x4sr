// 业务模块三：档案落盘
// 负责 JSON 档案的初始化、旧档案迁移、写入锁、操作轨迹登记与编号生成。
// 列表与统计都从这里读出的同一份 archive 派生，刷新后一致。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.INK_DB_PATH || join(__dirname, "data", "ink-stick-testing.json");

const seed = {
  version: 2,
  sticks: [
    {
      code: "IS-001",
      smokeSource: "黄山松烟",
      glueRatio: "7.5%",
      ageYears: 8,
      storage: "恒湿柜B",
      tests: [
        {
          id: "T-0001",
          waterId: "WB-0001",
          tester: "松风",
          openedAt: "2026-06-11T09:00:00.000Z",
          status: "已签样",
          sign: {
            paper: "净皮宣纸",
            waterAmount: "20滴",
            speed: "快",
            colorLayer: "浓淡四层，焦墨起甲",
            reviewer: "墨庄",
            signedAt: "2026-06-11T09:20:00.000Z",
            valid: true
          }
        }
      ]
    },
    {
      code: "IS-002",
      smokeSource: "桐油烟",
      glueRatio: "8%",
      ageYears: 3,
      storage: "试样盒C",
      tests: []
    }
  ],
  waters: [
    {
      id: "WB-0001",
      source: "桃花潭晨水",
      collectedAt: "2026-06-10",
      remainingMl: 120,
      turbidity: 1,
      status: "合格",
      note: "试墨首用水批"
    },
    {
      id: "WB-0002",
      source: "后院井水",
      collectedAt: "2026-06-18",
      remainingMl: 60,
      turbidity: 3,
      status: "待换水",
      note: "雨后采集，偏浑"
    }
  ],
  events: [
    { at: "2026-06-10T08:00:00.000Z", type: "水批登记", waterId: "WB-0001", note: "桃花潭晨水，余量120ml，浊度1度 → 合格" },
    { at: "2026-06-11T09:00:00.000Z", type: "开试", stickCode: "IS-001", testId: "T-0001", waterId: "WB-0001", note: "试墨人 松风" },
    { at: "2026-06-11T09:20:00.000Z", type: "签样通过", stickCode: "IS-001", testId: "T-0001", waterId: "WB-0001", note: "复核人 墨庄" },
    { at: "2026-06-18T08:30:00.000Z", type: "水批登记", waterId: "WB-0002", note: "后院井水，余量60ml，浊度3度 → 仅转待换水" }
  ]
};

function migrate(raw) {
  // 旧版「墨锭试磨室」档案迁移：旧试磨记录仅作档案备注，新流程须重开试墨。
  const archive = {
    version: 2,
    sticks: (raw.items || []).map((item) => ({
      code: item.code,
      smokeSource: item.smokeSource || "",
      glueRatio: item.glueRatio || "",
      ageYears: Number(item.ageYears) || 0,
      storage: item.storage || "",
      tests: [],
      legacyLogs: item.logs || []
    })),
    waters: [],
    events: [{ at: new Date().toISOString(), type: "档案迁移", note: "由墨锭试磨室旧档案迁入，旧试磨记录转档案备注，需重开试墨" }]
  };
  return archive;
}

async function loadArchive() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  if (raw.version === 2) return raw;
  const migrated = migrate(raw);
  await persist(migrated);
  return migrated;
}

async function persist(archive) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(archive, null, 2));
  await rename(tmp, dbPath);
}

// 并发提交串行化：同一时刻只有一笔业务在改动档案，避免重复开试。
let chain = Promise.resolve();
function withWriteLock(task) {
  const run = chain.then(() => task());
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function recordEvent(archive, event) {
  archive.events.push({ at: new Date().toISOString(), ...event });
  return archive.events[archive.events.length - 1];
}

function nextId(records, prefix) {
  let max = 0;
  for (const record of records || []) {
    const match = String(record.id || "").match(new RegExp("^" + prefix + "-(\\d+)$"));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

export { loadArchive, persist, withWriteLock, recordEvent, nextId };
