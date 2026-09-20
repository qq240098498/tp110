// 夏令时切换推算：把“第几个星期几的几点几分”这类规则落到指定年份的真实日历上，
// 算出这一年的两次切换时刻，并按时间先后排出夏令时生效区间。
// 南半球开始月份晚于结束月份时夏令时跨年，区间会延续到次年或自上一年延续而来。
const { load, WEEKDAY_NAMES, MONTH_NAMES, MIN_YEAR, MAX_YEAR } = require('./store');
const { ApiError } = require('./errors');
const { offsetText } = require('./zones');

const pad = (num) => String(num).padStart(2, '0');

// 校验要推算的年份，口径与档案生效年份一致
function validateScheduleYear(value) {
  if (value === undefined || value === null || value === '') {
    throw new ApiError(400, 'YEAR_REQUIRED', '请填写要推算的年份', 'year');
  }
  const year = Number(value);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `年份要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, 'year');
  }
  return year;
}

// 某年某月“第几个星期几”落在哪一天。week 取一到四或 last，weekday 零到六，零是周日
function weekdayOfMonth(year, month, week, weekday) {
  if (week === 'last') {
    // 从月末往回找，第一个匹配的星期几就是当月最后一个
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = daysInMonth; day >= 1; day -= 1) {
      if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday) return day;
    }
    return daysInMonth;
  }
  const ordinal = Number(week);
  // 一号是星期几，先定位当月第一个目标星期几，再往后数
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  let day = 1 + ((weekday - firstWeekday + 7) % 7);
  day += (ordinal - 1) * 7;
  return day;
}

// 把规则的一段落成某年具体的当地切换时刻，同时给出按切换前偏移折算的 UTC 瞬间
function resolveTransition(zone, part, year, offsetMinutesBefore) {
  const day = weekdayOfMonth(year, part.month, part.week, part.weekday);
  const localMs = Date.UTC(year, part.month - 1, day, part.hour, part.minute, 0);
  const utcMs = localMs - offsetMinutesBefore * 60000;
  return {
    kind: '',
    year,
    month: part.month,
    day,
    weekday: WEEKDAY_NAMES[new Date(localMs).getUTCDay()],
    localTime: `${pad(part.hour)}:${pad(part.minute)}`,
    localDate: `${year}-${pad(part.month)}-${pad(day)}`,
    offsetMinutesBefore,
    offsetMinutesAfter: 0,
    localMs,
    utcMs,
  };
}

function ordinalText(week) {
  return week === 'last' ? '最后一个' : `第${['一', '二', '三', '四'][Number(week) - 1]}个`;
}

// 规则一段的人话描述，例如“三月第二个周日 02:00”
function rulePartText(part) {
  return `${MONTH_NAMES[part.month - 1]}${ordinalText(part.week)}${WEEKDAY_NAMES[part.weekday]} ${pad(part.hour)}:${pad(part.minute)}`;
}

// 区间端点的统一展示：年月日、星期、当地几点、此刻起采用的偏移
function endpointView(point, offsetMinutes) {
  return {
    date: point.localDate,
    time: point.localTime,
    weekday: point.weekday,
    offsetMinutes,
    offsetText: offsetText(offsetMinutes),
    utc: new Date(point.utcMs).toISOString().replace('.000Z', 'Z'),
  };
}

// 区间属于所查年份的部分：同在一年写年内，跨年时标出延续到次年或自上一年延续
function segmentView(segment, year) {
  const beginYear = Number(segment.begin.localDate.slice(0, 4));
  const endYear = Number(segment.end.localDate.slice(0, 4));
  let withinYear = true;
  let carryFromPrevious = false;
  let carryToNext = false;
  if (beginYear < year) {
    withinYear = false;
    carryFromPrevious = true;
  }
  if (endYear > year) {
    withinYear = false;
    carryToNext = true;
  }
  let scopeText;
  if (withinYear) {
    scopeText = '整段都在本年';
  } else if (carryFromPrevious && carryToNext) {
    scopeText = '全年都处在夏令时（自上一年延续，到次年才结束）';
  } else if (carryFromPrevious) {
    scopeText = `自上一年延续而来，本年 ${segment.end.localDate} 结束`;
  } else {
    scopeText = `本年 ${segment.begin.localDate} 开始，延续到次年 ${segment.end.localDate}`;
  }
  return {
    begin: endpointView(segment.begin, segment.offsetMinutesAfter),
    end: endpointView(segment.end, segment.offsetMinutesBeforeEnd),
    offsetMinutes: segment.offsetMinutesAfter,
    offsetText: offsetText(segment.offsetMinutesAfter),
    withinYear,
    carryFromPrevious,
    carryToNext,
    scopeText,
  };
}

// 北半球：开始与结束都在同一年，夏令时夹在两次切换之间
function scheduleNorthern(zone, year) {
  const start = resolveTransition(zone, zone.dstStart, year, zone.offsetMinutes);
  start.kind = 'start';
  start.offsetMinutesAfter = zone.dstOffsetMinutes;
  const end = resolveTransition(zone, zone.dstEnd, year, zone.dstOffsetMinutes);
  end.kind = 'end';
  end.offsetMinutesAfter = zone.offsetMinutes;

  let segments = [];
  if (start.utcMs < end.utcMs) {
    segments = [{
      begin: start,
      end,
      offsetMinutesAfter: zone.dstOffsetMinutes,
      offsetMinutesBeforeEnd: zone.offsetMinutes,
    }];
  }
  return { transitions: [start, end], segments };
}

// 南半球：夏令时跨年。本年的生效期由两段拼成——上一年开始后延续过来的尾巴，
// 以及本年开始后延续到次年结束的开头；中间（本年结束之后、本年开始之前）是标准时间
function scheduleSouthern(zone, year) {
  const prevStart = resolveTransition(zone, zone.dstStart, year - 1, zone.offsetMinutes);
  prevStart.kind = 'start';
  prevStart.offsetMinutesAfter = zone.dstOffsetMinutes;
  const end = resolveTransition(zone, zone.dstEnd, year, zone.dstOffsetMinutes);
  end.kind = 'end';
  end.offsetMinutesAfter = zone.offsetMinutes;
  const start = resolveTransition(zone, zone.dstStart, year, zone.offsetMinutes);
  start.kind = 'start';
  start.offsetMinutesAfter = zone.dstOffsetMinutes;
  const nextEnd = resolveTransition(zone, zone.dstEnd, year + 1, zone.dstOffsetMinutes);
  nextEnd.kind = 'end';
  nextEnd.offsetMinutesAfter = zone.offsetMinutes;

  const segments = [
    { begin: prevStart, end, offsetMinutesAfter: zone.dstOffsetMinutes, offsetMinutesBeforeEnd: zone.offsetMinutes },
    { begin: start, end: nextEnd, offsetMinutesAfter: zone.dstOffsetMinutes, offsetMinutesBeforeEnd: zone.offsetMinutes },
  ].filter((segment) => segment.begin.utcMs < segment.end.utcMs);

  return { transitions: [end, start], segments };
}

// 单条档案在某年的完整推算：两次切换按时间先后，生效区间也按开始先后排
function buildZoneSchedule(zone, year) {
  const crossesYear = zone.dstStart.month > zone.dstEnd.month;
  const { transitions, segments } = crossesYear ? scheduleSouthern(zone, year) : scheduleNorthern(zone, year);

  transitions.sort((a, b) => a.utcMs - b.utcMs || (a.kind === 'end' ? -1 : 1));
  segments.sort((a, b) => a.begin.utcMs - b.begin.utcMs);

  const active = year >= zone.fromYear && (zone.toYear === null || year <= zone.toYear);

  const transitionView = (item) => ({
    kind: item.kind,
    kindText: item.kind === 'start' ? '夏令时开始' : '夏令时结束',
    rule: rulePartText(item.kind === 'start' ? zone.dstStart : zone.dstEnd),
    date: item.localDate,
    time: item.localTime,
    weekday: item.weekday,
    offsetMinutesBefore: item.offsetMinutesBefore,
    offsetMinutesAfter: item.offsetMinutesAfter,
    offsetTextBefore: offsetText(item.offsetMinutesBefore),
    offsetTextAfter: offsetText(item.offsetMinutesAfter),
    utc: new Date(item.utcMs).toISOString().replace('.000Z', 'Z'),
  });

  return {
    zoneId: zone.id,
    name: zone.name,
    displayName: zone.displayName,
    standardOffsetMinutes: zone.offsetMinutes,
    standardOffsetText: offsetText(zone.offsetMinutes),
    dstOffsetMinutes: zone.dstOffsetMinutes,
    dstOffsetText: offsetText(zone.dstOffsetMinutes),
    crossesYear,
    crossesYearText: crossesYear ? '开始月份晚于结束月份，夏令时跨年' : '开始与结束同在一年',
    startRule: rulePartText(zone.dstStart),
    endRule: rulePartText(zone.dstEnd),
    fromYear: zone.fromYear,
    toYear: zone.toYear,
    activeInYear: active,
    activeText: active ? '该年按规则实行' : (year < zone.fromYear ? '该年档案尚未生效' : '该年起已停止实行'),
    transitions: transitions.map(transitionView),
    intervals: segments.map((segment) => segmentView(segment, year)),
  };
}

// 推算一批档案：只算实行夏令时的；指定 zoneId 时只算这一条
function listDstSchedules(options) {
  const input = options && typeof options === 'object' ? options : {};
  const year = validateScheduleYear(input.year);
  const zoneId = typeof input.zoneId === 'string' ? input.zoneId.trim() : '';

  const data = load();
  let list = data.zones.filter((item) => item.usesDst && item.dstStart && item.dstEnd);
  if (zoneId) {
    list = list.filter((item) => item.id === zoneId);
    if (list.length === 0) {
      const exists = data.zones.some((item) => item.id === zoneId);
      if (!exists) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', 'zoneId');
      throw new ApiError(404, 'DST_NOT_APPLIED', '这条档案不实行夏令时，没有切换可推算', 'zoneId');
    }
  }
  list = list.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const schedules = list.map((zone) => buildZoneSchedule(zone, year));
  return {
    year,
    zonesInScope: data.zones.length,
    dstZoneCount: data.zones.filter((item) => item.usesDst).length,
    scheduledCount: schedules.length,
    activeCount: schedules.filter((item) => item.activeInYear).length,
    schedules,
  };
}

module.exports = {
  listDstSchedules,
  buildZoneSchedule,
  weekdayOfMonth,
  validateScheduleYear,
  rulePartText,
};
