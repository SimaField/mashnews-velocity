// Цели Яндекс Метрики. Счётчик подключается в index.html и кладёт свой номер
// в window.metrikaId; на локальном сервере разработки его нет, и цели никуда не уходят.
// Чтобы цель считалась, в кабинете Метрики должна быть создана цель
// «JavaScript-событие» с тем же идентификатором.
export const GOALS = { start: 'mission_start', win: 'mission_win', lose: 'mission_lose' };

export function reachGoal(goal, params) {
  if (typeof window.ym === 'function' && window.metrikaId) window.ym(window.metrikaId, 'reachGoal', goal, params);
}
