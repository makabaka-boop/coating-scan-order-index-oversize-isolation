/** 读数值域：0..65535（16 位无符号整数） */
export const VALUE_MIN = 0;
export const VALUE_MAX = 65535;
export const READINGS_MAX = 200_000;
export const QUERIES_MAX = 100_000;

/**
 * 文件文本规模的宽松上界（字节数 / UTF-16 字符数共用同一阈值）。
 * 合法满规模文件（200000 读数 + 100000 查询）的紧凑 JSON 约 5 MB；
 * 取 32 MB 既能放行带正常排版空白的合法文件，又能在读取 / 解析之前
 * 拦截远超契约规模的病态文件，避免巨型文本的同步解析长时间占用主线程。
 */
export const TEXT_MAX = 32 * 1024 * 1024;

/** 单个查询，区间按半开 [start, end) 解释 */
export interface Query {
  start: number;
  end: number;
  k: number;
}

export interface AnalysisResult {
  ok: boolean;
  /** 读入时的查询总数（失败时为 0） */
  queryCount: number;
  /** 与原 queries 顺序一一对应的第 k 小值；失败时为空数组 */
  answers: number[];
  /** 校验/解析错误，按数组下标反馈；成功时为空 */
  errors: string[];
  /** 统计摘要，便于质检员核对与回归断言 */
  timingMs: number;
  sum: number;
  /** FNV-1a 风格 32 位摘要（取模），对完整答案序列敏感 */
  digest: number;
}
