import { StationSchedule, StationActionMode, TimeZoneRule, isMinuteInZone, SplitConfig, createDefaultSplitConfig } from '../simulation/WorldMap';
export { isMinuteInZone };

export interface ArrivalDecision {
  mode: StationActionMode;
  requiredStopMinutes: number;
  isReverse?: boolean;
  splitConfig?: SplitConfig;
}

export interface DepartureEvaluation {
  canDepart: boolean;
  shouldReverse: boolean;
}

/** 
 * ホーム到着時、現在の時刻から「時間帯ゾーン」を評価し、初期動作モードを決定する。
 * 何も設定されていない時間帯はデフォルトで「hold（留置・発車時刻まで待機）」となる。
 */
export function resolveArrival(schedule: StationSchedule | undefined, hour: number, minute: number): ArrivalDecision {
  if (!schedule) return { mode: 'hold', requiredStopMinutes: 0 };
  const currentMin = hour * 60 + minute;

  // 駅全体の折り返し設定の有無を確認（ピンまたはゾーンのいずれかに折り返しがあれば初期折り返し候補とする）
  const hasPinReverse = !!(schedule.reverseDepartures && schedule.reverseDepartures.length > 0);
  const anyZoneReverse = (schedule.timeZones || []).some(z => z.isReverse);
  const defaultReverse = hasPinReverse || anyZoneReverse;

  // 現在時刻に合致するすべてのゾーンを抽出
  const activeZones = (schedule.timeZones || []).filter(z => isMinuteInZone(currentMin, z.startMin, z.endMin));

  // 分割（切り離し）設定の判定
  let splitConfig: SplitConfig | undefined = undefined;
  const isPinSplit = !!(schedule.splitDepartures && schedule.splitDepartures.some(sd => Math.abs(sd - currentMin) <= 15));
  const matchedSplitZone = activeZones.find(z => z.isSplit);

  if (matchedSplitZone) {
    splitConfig = createDefaultSplitConfig(
      matchedSplitZone.splitFrontCars || 2,
      matchedSplitZone.splitRearCars || 2,
      !!matchedSplitZone.splitRearReverses
    );
  } else if (isPinSplit) {
    splitConfig = schedule.splitConfig || createDefaultSplitConfig(2, 2, false);
  } else if (schedule.splitConfig && schedule.splitConfig.enabled) {
    splitConfig = schedule.splitConfig;
  }

  if (activeZones.length === 0) {
    return { mode: 'hold', requiredStopMinutes: 0, isReverse: defaultReverse, splitConfig };
  }

  // 1. 通過ゾーンがあれば通過優先
  const passZone = activeZones.find(z => z.mode === 'pass');
  if (passZone) {
    return { mode: 'pass', requiredStopMinutes: 0, isReverse: !!passZone.isReverse || defaultReverse };
  }

  // 2. パターンダイヤゾーンがあれば待機（発車分まで停車）
  const patternZones = activeZones.filter(z => z.mode === 'pattern');
  if (patternZones.length > 0) {
    const anyReverse = patternZones.some(z => z.isReverse);
    return { mode: 'wait', requiredStopMinutes: 0, isReverse: anyReverse || defaultReverse, splitConfig };
  }

  // 3. 停車時間指定ゾーン
  const stopZone = activeZones.find(z => z.mode === 'stop');
  if (stopZone) {
    return { mode: 'stop', requiredStopMinutes: stopZone.waitMinutes || 1, isReverse: !!stopZone.isReverse || defaultReverse, splitConfig };
  }

  return { mode: 'hold', requiredStopMinutes: 0, isReverse: defaultReverse, splitConfig };
}

/**
 * 対象のゲーム内時刻（0-1439分）が前フレームからの進行区間内に含まれるかを判定（日跨ぎ・フレームスキップ対応）
 */
export function isMinuteInRange(prevTotalMin: number, currentTotalMin: number, targetMin: number): boolean {
  if (prevTotalMin === currentTotalMin) {
    return targetMin === currentTotalMin;
  }
  const diff = (currentTotalMin - prevTotalMin + 1440) % 1440;
  // 1日（1440分）以上進んだ場合は全分が含まれるため常にtrue
  if (diff === 0 || diff >= 1439) {
    return true;
  }
  const targetOffset = (targetMin - prevTotalMin + 1440) % 1440;
  return targetOffset > 0 && targetOffset <= diff;
}

/**
 * 基準分（baseMinute）と発車間隔（intervalMinutes）に基づくパターン発車が、
 * 前フレーム（prevTotalMin）から現在フレーム（currentTotalMin）の区間に1回以上含まれるかを判定
 */
export function isPatternIntervalInRange(
  prevTotalMin: number,
  currentTotalMin: number,
  baseMinute: number,
  intervalMinutes: number,
  anchorMinute?: number
): boolean {
  const interval = Math.max(1, intervalMinutes || 60);
  const base = anchorMinute !== undefined
    ? ((anchorMinute % 1440) + 1440) % 1440
    : ((baseMinute % 60) + 60) % 60;

  if (prevTotalMin === currentTotalMin) {
    const minFromBase = ((currentTotalMin - base) % interval + interval) % interval;
    return minFromBase === 0;
  }

  const diff = (currentTotalMin - prevTotalMin + 1440) % 1440;
  // 進行差分が間隔以上、または半日（720分）以上の場合は確実に跨いでいる
  if (diff >= interval || diff >= 720) {
    return true;
  }

  const offset = ((prevTotalMin - base) % interval + interval) % interval;
  const distToNext = (interval - offset) % interval;
  const nextTargetOffset = distToNext === 0 ? interval : distToNext;
  return nextTargetOffset <= diff;
}

/**
 * 毎時XX分（0-59分）が前フレームからの進行区間内に1回以上通過したかを判定（時跨ぎ・フレームスキップ対応）
 */
export function isPatternMinuteInRange(prevTotalMin: number, currentTotalMin: number, patternMinute: number): boolean {
  return isPatternIntervalInRange(prevTotalMin, currentTotalMin, patternMinute, 60);
}

/**
 * 時間帯ゾーン [startMin, endMin] が、前フレーム時刻 prevMin から現フレーム時刻 currentMin までの
 * 進行区間と交差（オーバーラップ）しているかを判定（日跨ぎ・フレームスキップ・極超高速対応）
 */
export function isZoneIntersectingRange(
  prevMin: number,
  currentMin: number,
  startMin: number,
  endMin: number
): boolean {
  if (prevMin === currentMin) {
    return isMinuteInZone(currentMin, startMin, endMin);
  }
  const diff = (currentMin - prevMin + 1440) % 1440;
  // 12時間（720分）以上進んだ場合は確実に全時間帯と交差する
  if (diff >= 720) return true;

  // 現在時刻か前時刻がゾーン内にある
  if (isMinuteInZone(currentMin, startMin, endMin) || isMinuteInZone(prevMin, startMin, endMin)) {
    return true;
  }
  // ゾーンの開始点または終了点をこのフレームで跨いだ
  if (isMinuteInRange(prevMin, currentMin, startMin) || isMinuteInRange(prevMin, currentMin, endMin)) {
    return true;
  }
  return false;
}

/**
 * パターンダイヤ時間帯ゾーン内の全発車時刻（分単位: 0-1439）を計算して返却
 */
export function getPatternDepartureMinutes(zone: TimeZoneRule): number[] {
  const departures: number[] = [];
  const interval = Math.max(1, zone.patternIntervalMinutes ?? 60);
  const baseMin = (zone.patternMinute ?? (zone.startMin % 60)) % 60;

  // startMin の属する hour での baseMin
  const startHour = Math.floor(zone.startMin / 60);
  let firstDep = startHour * 60 + baseMin;
  while (firstDep < zone.startMin) {
    firstDep += interval;
  }

  // ゾーンの総継続時間（最大1440分）
  const totalZoneDuration = zone.endMin >= zone.startMin
    ? (zone.endMin - zone.startMin)
    : (1440 - zone.startMin + zone.endMin);
  const maxSpan = Math.min(1440, totalZoneDuration);

  let current = firstDep;
  while (current <= firstDep + maxSpan && (current - firstDep) < 1440) {
    const wrapped = ((current % 1440) + 1440) % 1440;
    if (!isMinuteInZone(wrapped, zone.startMin, zone.endMin) && !(zone.endMin === 1440 && wrapped === 0)) {
      break;
    }
    if (departures.includes(wrapped)) {
      break;
    }
    departures.push(wrapped);
    current += interval;
  }

  return departures;
}

/**
 * 駅停車中における動的発車判定
 * 到着時の固定値だけに依存せず、現在の時刻・最新スケジュール・経過時間からリアルタイムに判定する。
 * 複数のパターンダイヤや時間帯設定が重複していても、合致する発車ルールを漏れなく全件評価する。
 * 高倍速やフレーム落ちで時刻が飛んだ場合（prevHour, prevMinuteからの区間跨ぎ）も発車時刻を漏らさず検知する。
 */
export function evaluateStationDeparture(
  schedule: StationSchedule | undefined,
  currentHour: number,
  currentMinute: number,
  stopElapsedMinutes: number,
  initialMode: StationActionMode = 'hold',
  initialRequiredStopMinutes: number = 0,
  initialReverse: boolean = false,
  prevHour?: number,
  prevMinute?: number
): DepartureEvaluation {
  if (!schedule) return { canDepart: false, shouldReverse: false };

  const currentMin = ((currentHour % 24) * 60 + currentMinute) % 1440;
  const prevMin = (prevHour !== undefined && prevMinute !== undefined && prevHour >= 0 && prevMinute >= 0)
    ? ((prevHour % 24) * 60 + prevMinute) % 1440
    : currentMin;

  // 1. 発車時刻指定ピン（departures）のチェック（最優先）
  if (schedule.departures && schedule.departures.length > 0) {
    const matchedDep = schedule.departures.find(dep => isMinuteInRange(prevMin, currentMin, dep));
    if (matchedDep !== undefined) {
      const isRev = !!(schedule.reverseDepartures && schedule.reverseDepartures.some(rd => isMinuteInRange(prevMin, currentMin, rd)));
      return { canDepart: true, shouldReverse: isRev || initialReverse };
    }
  }

  // 2. 現在時刻（または通過区間）に一致する全時間帯ゾーンを収集（極超高速でのゾーン跨ぎに対応）
  const activeZones = (schedule.timeZones || []).filter(z =>
    isZoneIntersectingRange(prevMin, currentMin, z.startMin, z.endMin)
  );

  if (activeZones.length > 0) {
    // 2-a. 通過ゾーン: 即座に発車
    const passZone = activeZones.find(z => z.mode === 'pass');
    if (passZone) {
      return { canDepart: true, shouldReverse: !!passZone.isReverse || initialReverse };
    }

    // 2-b. パターンダイヤゾーン: タイムライン描画（getPatternDepartureMinutes）と完全に同一の基準で発車判定
    const matchedPattern = activeZones.find(z => {
      if (z.mode !== 'pattern') return false;
      const deps = getPatternDepartureMinutes(z);
      return deps.some(dep => isMinuteInRange(prevMin, currentMin, dep));
    });
    if (matchedPattern) {
      return { canDepart: true, shouldReverse: !!matchedPattern.isReverse || initialReverse };
    }

    // 2-c. 〇分停車ゾーン: 指定停車時間（waitMinutes）が経過していれば発車
    const readyStopZone = activeZones.find(z => z.mode === 'stop' && stopElapsedMinutes >= (z.waitMinutes || 1));
    if (readyStopZone) {
      return { canDepart: true, shouldReverse: !!readyStopZone.isReverse || initialReverse };
    }

    // activeZones にパターンダイヤや未完了のstopゾーンが含まれている場合は、その発車タイミングまで待機
    const hasPattern = activeZones.some(z => z.mode === 'pattern');
    const hasStop = activeZones.some(z => z.mode === 'stop');
    if (hasPattern || hasStop) {
      return { canDepart: false, shouldReverse: initialReverse };
    }
  }

  // 3. 到着時モードに基づくフォールバック判定
  if (initialMode === 'stop') {
    if (stopElapsedMinutes >= initialRequiredStopMinutes) {
      return { canDepart: true, shouldReverse: initialReverse };
    }
  }

  if (initialMode === 'reverse') {
    const delay = getReverseDelayMinutes(schedule);
    if (stopElapsedMinutes >= delay) {
      return { canDepart: true, shouldReverse: true };
    }
  }

  // 発車条件未達の場合でも、駅進入時に決定されていた初期折り返しフラグ（initialReverse）を保持
  return { canDepart: false, shouldReverse: initialReverse };
}

/**
 * 毎フレーム発車可能か判定する（後方互換用関数）
 */
export function canDepart(
  schedule: StationSchedule | undefined,
  mode: StationActionMode,
  hour: number,
  minute: number,
  elapsedMinutes: number,
  requiredStopMinutes: number
): boolean {
  return evaluateStationDeparture(schedule, hour, minute, elapsedMinutes, mode, requiredStopMinutes).canDepart;
}

export function getReverseDelayMinutes(schedule: StationSchedule | undefined): number {
  return Math.max(0, Math.round(schedule?.reverseDelayMinutes ?? 3));
}
