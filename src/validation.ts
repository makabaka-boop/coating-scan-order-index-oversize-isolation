import {
  QUERIES_MAX,
  READINGS_MAX,
  TEXT_MAX,
  VALUE_MAX,
  VALUE_MIN,
  type Query,
} from './types';

export interface ValidInput {
  readings: number[];
  queries: Query[];
}

type ValidationOutcome =
  | { ok: true; input: ValidInput; errors: [] }
  | { ok: false; input: null; errors: string[] };

/**
 * 单份被拒文件的逐条诊断上限。
 * 被拒文件只需要有界且可定位的错误摘要：达到上限后校验立即停止遍历，
 * 诊断量不再随输入长度线性增长，界面的错误渲染量也随之有界。
 */
export const ERROR_CAP = 32;

/**
 * 文件文本规模预检：size 超过 TEXT_MAX 时返回一条有界诊断，否则返回 null。
 * 用于在读取（已知字节数时）或解析（已知字符数时）之前拦截远超契约规模的文件。
 */
export function textSizeError(size: number): string | null {
  if (size <= TEXT_MAX) return null;
  return (
    `文件规模 ${size} 超出契约文本规模上限 ${TEXT_MAX}：` +
    '远超约定规模，整个文件被拒绝（未进行解析与逐元素校验）'
  );
}

/**
 * 有界错误收集器：
 * - 至多收录 ERROR_CAP 条逐条定位的诊断；
 * - 满员后 push 返回 false，调用方必须停止遍历（超限/多错文件不得再逐元素扫描）；
 * - finish() 在发生截断时追加一条汇总，明示其后诊断已被省略。
 */
class ErrorSink {
  private readonly items: string[] = [];
  private truncated = false;

  get full(): boolean {
    return this.items.length >= ERROR_CAP;
  }

  /** 追加一条定位诊断；返回 false 表示已达上限、未收录，调用方应停止遍历 */
  push(msg: string): boolean {
    if (this.full) {
      this.truncated = true;
      return false;
    }
    this.items.push(msg);
    return true;
  }

  /** 调用方在满员后仍有未扫描元素、提前退出循环时标记截断 */
  markRestSkipped(): void {
    this.truncated = true;
  }

  finish(): string[] {
    if (this.truncated) {
      return [
        ...this.items,
        `错误过多：仅列出前 ${ERROR_CAP} 条定位诊断，其后错误已省略；修复后请重新提交`,
      ];
    }
    return this.items;
  }
}

/**
 * 严格校验载入的 JSON：
 * - 顶层必须是仅含 readings（整数数组）与 queries（对象数组）的对象；
 * - readings 长度 1..200000，每个元素必须是 0..65535 的整数；
 * - queries 长度 0..100000，每个查询必须恰好含 start/end/k 三个整数键，
 *   满足 0≤start<end≤readings.length 且 1≤k≤end-start；
 * - 任何结构或边界错误都拒绝整个文件，错误按数组下标反馈；
 * - 错误摘要是有界的：数组长度超出契约上限时只记录规模错误并短路，
 *   不再逐元素扫描；逐条诊断至多 ERROR_CAP 条，满员即停止遍历并附截断汇总，
 *   诊断量与校验耗时都不随被拒输入的长度线性增长。
 */
export function validateInput(data: unknown): ValidationOutcome {
  const sink = new ErrorSink();

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      ok: false,
      input: null,
      errors: ['顶层结构错误：文件必须是 JSON 对象，形如 {"readings": [...], "queries": [...]}'],
    };
  }

  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'readings' && key !== 'queries') {
      if (!sink.push(`顶层存在无法识别的键 "${key}"：只允许 readings 与 queries`)) break;
    }
  }

  const rawReadings = obj.readings;
  let readingsLength = 0;
  // 仅当 readings 是长度合规的数组时，才以其长度作为查询区间边界判定依据
  let lengthUsable = false;

  if (!Array.isArray(rawReadings)) {
    sink.push('readings 必须是整数数组');
  } else {
    readingsLength = rawReadings.length;
    if (readingsLength < 1) {
      sink.push('readings[*]：数组至少包含 1 条读数，当前长度为 0');
    } else if (readingsLength > READINGS_MAX) {
      // 超出契约规模：只记录规模错误并短路，不再逐元素扫描
      sink.push(
        `readings[*]：数组长度 ${readingsLength} 超出上限 ${READINGS_MAX}，逐元素校验已跳过`,
      );
    } else {
      lengthUsable = true;
      // 规模合规才逐元素校验；诊断满员即停止遍历
      for (let i = 0; i < rawReadings.length; i++) {
        const v = rawReadings[i];
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          if (!sink.push(`readings[${i}]：必须是整数，当前为 ${describeValue(v)}`)) break;
        } else if (v < VALUE_MIN || v > VALUE_MAX) {
          if (!sink.push(`readings[${i}]：值 ${v} 越界，允许范围为 ${VALUE_MIN}..${VALUE_MAX}`)) {
            break;
          }
        }
      }
    }
  }

  const rawQueries = obj.queries;
  // 诊断已满员时跳过后续阶段，保证被拒文件的校验耗时同样有界
  if (sink.full) {
    // 仍可能产生诊断的未扫描内容（缺失/非空 queries）被整体跳过：标记截断
    if (!Array.isArray(rawQueries) || rawQueries.length > 0) {
      sink.markRestSkipped();
    }
  } else if (!Array.isArray(rawQueries)) {
    sink.push('queries 必须是查询对象数组');
  } else if (rawQueries.length > QUERIES_MAX) {
    // 超出契约规模：只记录规模错误并短路，不再逐元素扫描
    sink.push(
      `queries[*]：数组长度 ${rawQueries.length} 超出上限 ${QUERIES_MAX}，逐元素校验已跳过`,
    );
  } else {
    for (let i = 0; i < rawQueries.length; i++) {
      if (sink.full) {
        // 还有未扫描的查询元素：标记截断后停止
        sink.markRestSkipped();
        break;
      }
      const q = rawQueries[i];
      if (typeof q !== 'object' || q === null || Array.isArray(q)) {
        sink.push(
          `queries[${i}]：必须是对象，形如 {"start":0,"end":10,"k":1}，当前为 ${describeValue(q)}`,
        );
        continue;
      }

      const qo = q as Record<string, unknown>;
      for (const key of Object.keys(qo)) {
        if (key !== 'start' && key !== 'end' && key !== 'k') {
          if (!sink.push(`queries[${i}]：存在无法识别的键 "${key}"，只允许 start、end、k`)) {
            break;
          }
        }
      }

      const start = integerField(qo, 'start', i, sink);
      const end = integerField(qo, 'end', i, sink);
      const k = integerField(qo, 'k', i, sink);

      // 字段缺失/非整数时不做派生边界检查，避免噪声错误；
      // 读数本身的值非法不影响以其数组长度作为区间边界
      if (start === null || end === null || k === null || !lengthUsable) {
        continue;
      }

      let intervalValid = true;
      if (start < 0 || start >= readingsLength) {
        sink.push(
          `queries[${i}]：start=${start} 越界，要求 0≤start<readings.length(${readingsLength})`,
        );
        intervalValid = false;
      }
      if (end <= 0 || end > readingsLength) {
        sink.push(
          `queries[${i}]：end=${end} 越界，要求 0<end≤readings.length(${readingsLength})`,
        );
        intervalValid = false;
      }
      if (intervalValid && start >= end) {
        sink.push(`queries[${i}]：start=${start} 必须小于 end=${end}（半开区间 [start,end)）`);
        intervalValid = false;
      }
      if (intervalValid && (k < 1 || k > end - start)) {
        sink.push(`queries[${i}]：k=${k} 越界，要求 1≤k≤end-start(${end - start})`);
      }
    }
  }

  const errors = sink.finish();
  if (errors.length > 0) {
    return { ok: false, input: null, errors };
  }

  return {
    ok: true,
    input: {
      readings: rawReadings as number[],
      queries: (rawQueries as unknown[]).map((q) => {
        const qo = q as Record<string, unknown>;
        return { start: qo.start as number, end: qo.end as number, k: qo.k as number };
      }),
    },
    errors: [],
  };
}

function integerField(
  qo: Record<string, unknown>,
  name: 'start' | 'end' | 'k',
  index: number,
  sink: ErrorSink,
): number | null {
  if (!(name in qo)) {
    sink.push(`queries[${index}]：缺少字段 "${name}"`);
    return null;
  }
  const v = qo[name];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    sink.push(`queries[${index}]：字段 "${name}" 必须是整数，当前为 ${describeValue(v)}`);
    return null;
  }
  return v;
}

function describeValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') return `数值 ${v}`;
  if (typeof v === 'string') {
    return `字符串 "${v.length > 20 ? v.slice(0, 20) + '…' : v}"`;
  }
  if (Array.isArray(v)) return `数组(长度 ${v.length})`;
  if (typeof v === 'object') return '对象';
  return String(v);
}
