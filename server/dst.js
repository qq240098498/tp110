// 夏令时推算：把档案里登记的"第几个星期几的几点几分"落到某一年的真实日历上，
// 算出这一年每次切换的日期、当地时刻与切换后的偏移，再按时间先后排出这一年的生效区间。
// 日历运算一律用 UTC 毫秒，避免受机器所在时区影响
const { load, WEEKDAY_NAMES, MONTH_NAMES, MIN_YEAR, MAX_YEAR } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const WEEK_LABELS = { 1: '第一个', 2: '第二个', 3: '第三个', 4: '第四个', last: '最后一个' };

const pad = (num) => String(num).padStart(2, '0');

// 规则的一段（第几个星期几）落在某一年的哪一天，按这一年的真实日历算，不借用别的年份
function ruleDayOfMonth(year, part) {
  const daysInMonth = new Date(Date.UTC(year, part.month, 0)).getUTCDate();
  if (part.week === 'last') {
    const lastWeekday = new Date(Date.UTC(year, part.month - 1, daysInMonth)).getUTCDay();
    return daysInMonth - ((lastWeekday - part.weekday + 7) % 7);
  }
  const firstWeekday = new Date(Date.UTC(year, part.month - 1, 1)).getUTCDay();
  const firstHit = 1 + ((part.weekday - firstWeekday + 7) % 7);
  return firstHit + 7 * (Number(part.week) - 1);
}

// 某一年里一段规则对应的当地时刻（以 UTC 毫秒表达当地日历时刻，仅用于排序与取日期）
function ruleMs(year, part) {
  return Date.UTC(year, part.month - 1, ruleDayOfMonth(year, part), part.hour, part.minute);
}

function ruleText(part) {
  return `${MONTH_NAMES[part.month - 1]}${WEEK_LABELS[part.week]}${WEEKDAY_NAMES[part.weekday]} ${pad(part.hour)}:${pad(part.minute)}`;
}

function msToParts(ms) {
  const at = new Date(ms);
  return {
    date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
    time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
    weekday: WEEKDAY_NAMES[at.getUTCDay()],
  };
}

// 一次切换：开始之后用夏令时偏移，结束之后回到标准偏移
function transition(zone, kind, ms) {
  const offsetBefore = kind === 'start' ? zone.offsetMinutes : zone.dstOffsetMinutes;
  const offsetAfter = kind === 'start' ? zone.dstOffsetMinutes : zone.offsetMinutes;
  return {
    kind,
    kindText: kind === 'start' ? '开始' : '结束',
    ...msToParts(ms),
    ruleText: ruleText(kind === 'start' ? zone.dstStart : zone.dstEnd),
    offsetBefore,
    offsetBeforeText: offsetText(offsetBefore),
    offsetAfter,
    offsetAfterText: offsetText(offsetAfter),
  };
}

function intervalParts(startMs, endMs) {
  const from = msToParts(startMs);
  const to = msToParts(endMs);
  return {
    startDate: from.date,
    startTime: from.time,
    startWeekday: from.weekday,
    endDate: to.date,
    endTime: to.time,
    endWeekday: to.weekday,
  };
}

// 不跨年：开始与结束都落在这一年内，年份在生效区间内就实行
function yearInRange(zone, year) {
  return year >= zone.fromYear && (zone.toYear === null || year <= zone.toYear);
}

// 跨年：一季从 startYear 跨到 startYear + 1，起止两年都要落在生效区间内这一季才算实行
function seasonInRange(zone, startYear) {
  return startYear >= zone.fromYear && (zone.toYear === null || startYear + 1 <= zone.toYear);
}

function yearRangeText(zone) {
  return zone.toYear === null ? `${zone.fromYear} 年起` : `${zone.fromYear} 至 ${zone.toYear}`;
}

// 单条档案某一年的切换时刻表与生效区间
function scheduleForZone(zone, year) {
  const base = {
    zoneId: zone.id,
    name: zone.name,
    displayName: zone.displayName,
    offsetText: offsetText(zone.offsetMinutes),
    dstOffsetText: zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    yearRangeText: yearRangeText(zone),
  };
  if (!zone.dstStart || !zone.dstEnd || zone.dstOffsetMinutes === null) {
    return {
      ...base,
      crossYear: null,
      status: 'incomplete',
      statusText: '夏令时规则不完整，无法推算',
      transitions: [],
      intervals: [],
    };
  }

  const startMs = ruleMs(year, zone.dstStart);
  const endMs = ruleMs(year, zone.dstEnd);
  // 结束时刻不比开始时刻晚，说明这一季要跨到次年才结束（南半球常见：开始月份晚于结束月份）
  const crossYear = endMs <= startMs;

  if (!crossYear) {
    if (!yearInRange(zone, year)) {
      return {
        ...base,
        crossYear,
        status: 'out-of-range',
        statusText: `这一年不在夏令时生效年份内（${base.yearRangeText}）`,
        transitions: [],
        intervals: [],
      };
    }
    return {
      ...base,
      crossYear,
      status: 'active',
      statusText: '',
      transitions: [transition(zone, 'start', startMs), transition(zone, 'end', endMs)],
      intervals: [{ ...intervalParts(startMs, endMs), scope: 'within', scopeText: '本年内的生效期' }],
    };
  }

  // 跨年：本年上半年的结束切换属于上一年开始的那一季，本年下半年的开始切换开启延续到次年的一季
  const transitions = [];
  const intervals = [];
  if (seasonInRange(zone, year - 1)) {
    transitions.push(transition(zone, 'end', endMs));
    intervals.push({
      ...intervalParts(Date.UTC(year, 0, 1, 0, 0), endMs),
      scope: 'carryover',
      scopeText: '上一年开始、延续到本年的生效期',
    });
  }
  if (seasonInRange(zone, year)) {
    // 这一季的结束日落在次年，按次年的日历另算，不能拿本年的日期顶替
    const nextEndMs = ruleMs(year + 1, zone.dstEnd);
    transitions.push(transition(zone, 'start', startMs));
    intervals.push({
      ...intervalParts(startMs, nextEndMs),
      scope: 'spills',
      scopeText: '本年开始、延续到次年的生效期',
    });
  }
  // 跨年档案在本年内一定是结束在前、开始在后，依次推入即为时间先后

  const active = transitions.length > 0;
  return {
    ...base,
    crossYear,
    status: active ? 'active' : 'out-of-range',
    statusText: active ? '' : `这一年不在夏令时生效年份内（${base.yearRangeText}）`,
    transitions,
    intervals,
  };
}

// 给定一个年份，为每条实行夏令时的档案算出这一年的切换时刻表
function dstSchedule(options) {
  const input = options && typeof options === 'object' ? options : {};
  const yearText = pickText(input.year);
  if (!yearText) throw new ApiError(400, 'YEAR_REQUIRED', '请填写要推算的年份', 'year');
  const year = Number(yearText);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `年份要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, 'year');
  }

  const data = load();
  const dstZones = data.zones
    .filter((item) => item.usesDst)
    .sort((a, b) => {
      if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
      return a.name < b.name ? -1 : 1;
    });
  const zones = dstZones.map((item) => scheduleForZone(item, year));

  return {
    year,
    dstZoneCount: dstZones.length,
    activeZoneCount: zones.filter((item) => item.status === 'active').length,
    crossYearCount: zones.filter((item) => item.crossYear === true).length,
    zones,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { dstSchedule, scheduleForZone, ruleDayOfMonth };
