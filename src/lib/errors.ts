/**
 * Error codes raised by SQL (`RAISE … USING ERRCODE = 'BKxxx'`), by the Edge
 * Functions, or by the platform. Each one gets a sentence a customer can act
 * on, and the raw code is kept for support.
 */

export const ERROR_MESSAGES: Record<string, string> = {
  BK001: 'Это время уже занято. Выберите другое окно — список обновлён.',
  BK002: 'До этого времени слишком мало осталось. Выберите более позднее окно.',
  BK003: 'Это время слишком далеко. Выберите дату ближе к сегодняшнему дню.',
  BK004: 'Услуга больше не оказывается. Выберите другую услугу.',
  BK005: 'Студия недоступна. Попробуйте позже или позвоните.',
  BK006: 'Запись не найдена. Проверьте ссылку из подтверждения.',
  BK007: 'Эту запись уже нельзя изменить. Позвоните в студию.',
  BK008: 'Запрос повторился с другими данными. Отправьте форму заново.',
  BK009: 'Этот пост не может выполнить выбранную услугу.',
  BK010: 'Проверьте имя и телефон — они заполнены не полностью.',
  BK011: 'Слишком много запросов. Подождите минуту и попробуйте снова.',
  RATE_LIMITED: 'Слишком много запросов. Подождите минуту и попробуйте снова.',
  AI_DISABLED: 'Помощник выключен для этой студии. Запись работает как обычно.',
  AI_BUDGET_EXHAUSTED: 'Бюджет помощника на сегодня исчерпан. Запись работает как обычно.',
  AI_UNAVAILABLE: 'Помощник недоступен. Можно записаться вручную — это займёт минуту.',
  LLM_NOT_CONFIGURED: 'Помощник не подключён: не заданы LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.',
  TOKEN_REQUIRED: 'Нужна ссылка из подтверждения записи.',
  TOKEN_INVALID: 'Ссылка недействительна. Запросите новую в студии.',
  NOT_A_MEMBER: 'У этой учётной записи нет доступа к студии.',
  BACKEND_NOT_CONFIGURED: 'Приложение не подключено к базе данных.',
  NETWORK: 'Нет связи с сервером. Проверьте интернет и повторите.',
  UNKNOWN: 'Не получилось выполнить действие. Попробуйте ещё раз.',
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** Human sentence, falling back to the server message, then to a generic one. */
  get friendly(): string {
    return ERROR_MESSAGES[this.code] ?? this.message ?? ERROR_MESSAGES.UNKNOWN!;
  }
}

/** Best-effort extraction of a stable code from whatever the platform threw. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const message = error instanceof Error ? error.message : String(error ?? '');

  // SQL error codes arrive either as `BK001: …` or inside a PostgREST message.
  const codeMatch = /\b(BK\d{3})\b/.exec(message);
  if (codeMatch?.[1]) {
    return new ApiError(codeMatch[1], message);
  }

  if (/Failed to fetch|NetworkError|network/i.test(message)) {
    return new ApiError('NETWORK', message);
  }
  if (/not a member|42501/.test(message)) {
    return new ApiError('NOT_A_MEMBER', message, 403);
  }

  return new ApiError('UNKNOWN', message);
}
