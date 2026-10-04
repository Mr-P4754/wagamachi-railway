// プロ仕様・単色細線SVGアイコン定義集 (マスター設計書準拠)

const createSvg = (content: string, viewBox = '0 0 24 24', strokeWidth = 1.8): string =>
  `<svg class="ui-icon-svg" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;

export const UI_ICONS = {
  // ツール
  select: createSvg('<path d="M3 3l7 18 3-7 7-3L3 3z"/>', '0 0 24 24', 2),
  railStraight: createSvg('<line x1="6" y1="2" x2="6" y2="22"/><line x1="18" y1="2" x2="18" y2="22"/><line x1="6" y1="6" x2="18" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="18" x2="18" y2="18"/>'),
  railElevated: createSvg('<line x1="4" y1="8" x2="20" y2="8"/><path d="M4 8v12M20 8v12M8 8v12M16 8v12M4 14h16"/>'),
  railCurve: createSvg('<path d="M4 20c0-8.837 7.163-16 16-16"/><path d="M4 15c0-6.075 4.925-11 11-11"/>'),
  railSlope: createSvg('<path d="M3 20h18L19 7l-7 5-5-2-4 10z"/>'),
  railSlopeUnderground: createSvg('<path d="M3 7h6l12 13H3V7z"/><path d="M12 12v8M16 16v4"/>'),
  railTunnel: createSvg('<path d="M4 21V10a8 8 0 0 1 16 0v11"/><path d="M8 21v-8a4 4 0 0 1 8 0v8"/><line x1="2" y1="21" x2="22" y2="21"/>'),
  pointSwitch: createSvg('<line x1="4" y1="19" x2="20" y2="19"/><path d="M4 19c6 0 10-6 16-12"/>'),
  scissorsCrossing: createSvg('<line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="20" y2="4"/>'),
  levelCrossing: createSvg('<line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>'),
  station: createSvg('<rect x="3" y="6" width="18" height="15" rx="2"/><path d="M3 10h18M8 6v4M16 6v4"/>'),
  stationElevated: createSvg('<rect x="4" y="4" width="16" height="10" rx="2"/><line x1="6" y1="14" x2="6" y2="21"/><line x1="18" y1="14" x2="18" y2="21"/><line x1="4" y1="9" x2="20" y2="9"/>'),
  road: createSvg('<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="12" y1="6" x2="12" y2="8"/><line x1="12" y1="11" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="18"/>'),
  buildingRes: createSvg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  buildingCom: createSvg('<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="10" y2="6"/><line x1="14" y1="6" x2="16" y2="6"/><line x1="8" y1="11" x2="10" y2="11"/><line x1="14" y1="11" x2="16" y2="11"/><line x1="8" y1="16" x2="10" y2="16"/><line x1="14" y1="16" x2="16" y2="16"/>'),
  nature: createSvg('<path d="M12 2L6 10h3l-4 7h14l-4-7h3L12 2z"/><line x1="12" y1="17" x2="12" y2="22"/>'),
  demolish: createSvg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', '0 0 24 24', 2),
  train: createSvg('<rect x="4" y="3" width="16" height="15" rx="2"/><path d="M4 11h16"/><circle cx="8" cy="15" r="1.5"/><circle cx="16" cy="15" r="1.5"/><path d="M7 18l-2 3M17 18l2 3"/>'),
  zoneRes: createSvg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 21V12h8v9"/>'),
  zoneCom: createSvg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="13" x2="17" y2="13"/>'),
  zoneInd: createSvg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 17V9l4 3V9l4 3V9l2 2v6H7z"/>'),
  zoneClear: createSvg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/>'),
  cargoYard: createSvg('<rect x="3" y="8" width="18" height="12" rx="1"/><line x1="3" y1="13" x2="21" y2="13"/><line x1="9" y1="8" x2="9" y2="20"/><line x1="15" y1="8" x2="15" y2="20"/>'),
  // 状態・コントロール
  sun: createSvg('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'),
  sunset: createSvg('<path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="9" x2="12" y2="2"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/>'),
  moon: createSvg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  volumeHigh: createSvg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
  volumeMute: createSvg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
  undo: createSvg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>')
} as const;
