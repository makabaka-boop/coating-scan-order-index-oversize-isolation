import { describe, expect, it } from 'vitest';
import { WaveletMatrix } from './waveletMatrix';
import { kthBySort } from './oracle';
import { ERROR_CAP, textSizeError, validateInput } from './validation';
import { analyze } from './analyze';
import { TEXT_MAX } from './types';

/** 对所有合法 [start,end) 与所有 1≤k≤len 的小数据穷举比对 */
function exhaustivelyCompare(readings: number[]) {
  const wm = new WaveletMatrix(readings);
  const n = readings.length;
  for (let start = 0; start < n; start++) {
    for (let end = start + 1; end <= n; end++) {
      for (let k = 1; k <= end - start; k++) {
        const got = wm.kth(start, end, k);
        const want = kthBySort(readings, start, end, k);
        if (got !== want) {
          throw new Error(
            `readings=${JSON.stringify(readings)} [${start},${end}) k=${k}: got ${got}, want ${want}`,
          );
        }
      }
    }
  }
}

describe('WaveletMatrix 对直接排序预言机', () => {
  it('单元素：k 唯一端点', () => {
    exhaustivelyCompare([0]);
    exhaustivelyCompare([65535]);
  });

  it('全相等：任意窗口任意 k 都等于该值', () => {
    exhaustivelyCompare([7, 7, 7, 7, 7]);
    exhaustivelyCompare(new Array(30).fill(42000));
  });

  it('重复值混合：含 0、65535 与交错重复', () => {
    exhaustivelyCompare([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]);
    exhaustivelyCompare([65535, 0, 0, 65535, 1, 0, 65535]);
    exhaustivelyCompare([2, 2, 1, 1, 2, 2, 1, 1]);
  });

  it('首尾窗口及 k 的两端（小数据全窗口穷举）', () => {
    exhaustivelyCompare([10, 50, 20, 40, 30, 60, 0, 65535]);
  });

  it('随机小样本：全部子区间与全部 k 穷举', () => {
    let seed = 1234;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rng() * 18);
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        // 刻意收窄取值制造重复
        vals.push(Math.floor(rng() * 6));
      }
      exhaustivelyCompare(vals);
    }
  });
});

describe('analyze：顺序、摘要与空查询', () => {
  it('按原查询顺序返回精确答案', () => {
    const readings = [5, 1, 4, 2, 8, 3, 7, 6];
    const queries = [
      { start: 0, end: 8, k: 1 },
      { start: 0, end: 8, k: 8 },
      { start: 2, end: 5, k: 2 },
      { start: 0, end: 1, k: 1 },
      { start: 7, end: 8, k: 1 },
      { start: 0, end: 3, k: 1 },
      { start: 1, end: 4, k: 3 },
    ];
    const result = analyze({ readings, queries });
    expect(result.ok).toBe(true);
    expect(result.answers).toEqual([1, 8, 4, 5, 6, 1, 4]);
    expect(result.queryCount).toBe(7);
    expect(result.timingMs).toBeGreaterThanOrEqual(0);
    expect(result.digest).toBeGreaterThan(0);
  });

  it('queries 为空也是合法文件', () => {
    const result = analyze({ readings: [1, 2, 3], queries: [] });
    expect(result.ok).toBe(true);
    expect(result.answers).toEqual([]);
    expect(result.queryCount).toBe(0);
    expect(result.sum).toBe(0);
  });
});

describe('validateInput：任何结构或边界错误都整体拒绝', () => {
  const validReadings = [1, 2, 3, 4, 5];

  function reject(data: unknown, messageFragment?: string) {
    const verdict = validateInput(data);
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.errors.length).toBeGreaterThan(0);
      if (messageFragment) {
        expect(verdict.errors.join('\n')).toContain(messageFragment);
      }
    }
  }

  it('拒绝非对象顶层（数组、null、原始值）', () => {
    reject([1, 2, 3]);
    reject(null);
    reject('x');
    reject(42);
  });

  it('拒绝顶层多余键与缺失键', () => {
    reject({ readings: validReadings, queries: [], extra: 1 }, 'extra');
    reject({ readings: validReadings }, 'queries');
    reject({ queries: [] }, 'readings');
  });

  it('拒绝空 readings 与超长 readings', () => {
    reject({ readings: [], queries: [] }, '至少包含 1 条');
    reject({ readings: new Array(200_001).fill(0), queries: [] }, '超出上限');
  });

  it('拒绝非整数、小数与越界读数，并按数组下标反馈', () => {
    reject({ readings: [1, '2', 3], queries: [] }, 'readings[1]');
    reject({ readings: [1, 2.5, 3], queries: [] }, 'readings[1]');
    reject({ readings: [-1, 2, 3], queries: [] }, 'readings[0]');
    reject({ readings: [1, 65536, 3], queries: [] }, 'readings[1]');
    reject({ readings: [1, null, 3], queries: [] }, 'readings[1]');
  });

  it('拒绝超长 queries 与非对象查询', () => {
    reject({ readings: validReadings, queries: new Array(100_001).fill({ start: 0, end: 1, k: 1 }) }, '超出上限');
    reject({ readings: validReadings, queries: [42] }, 'queries[0]');
    reject({ readings: validReadings, queries: [null] }, 'queries[0]');
  });

  it('拒绝缺字段、多字段、非整数字段', () => {
    reject({ readings: validReadings, queries: [{ start: 0, end: 1 }] }, 'queries[0]：缺少字段 "k"');
    reject({ readings: validReadings, queries: [{ start: 0, end: 1, k: 1, x: 2 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: '0', end: 1, k: 1 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 0.5, end: 1, k: 1 }] }, 'queries[0]');
  });

  it('拒绝 start/end 越界与 start≥end（半开区间）', () => {
    reject({ readings: validReadings, queries: [{ start: -1, end: 1, k: 1 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 0, end: 6, k: 1 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 2, end: 2, k: 1 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 3, end: 2, k: 1 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 5, end: 5, k: 1 }] }, 'queries[0]');
  });

  it('拒绝 k 的两端之外', () => {
    reject({ readings: validReadings, queries: [{ start: 0, end: 5, k: 0 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 0, end: 5, k: 6 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 2, end: 4, k: 3 }] }, 'queries[0]');
    reject({ readings: validReadings, queries: [{ start: 4, end: 5, k: 2 }] }, 'queries[0]');
  });

  it('多个错误同时存在时全部按下标反馈（不止报第一个）', () => {
    const verdict = validateInput({
      readings: [0, -1, 65536],
      queries: [
        { start: 0, end: 1, k: 1 },
        { start: 0, end: 9, k: 1 },
        { start: 0, end: 1, k: 2 },
      ],
    });
    if (verdict.ok === false) {
      const text = verdict.errors.join('\n');
      expect(text).toContain('readings[1]');
      expect(text).toContain('readings[2]');
      expect(text).toContain('queries[1]');
      expect(text).toContain('queries[2]');
      // readings 非法导致整体拒绝；合法的 queries[0] 也不会单独放行
      expect(verdict.input).toBeNull();
    } else {
      throw new Error('应当整体拒绝');
    }
  });

  it('analyze 失败时不留下任何部分答案', () => {
    const result = analyze({
      readings: validReadings,
      queries: [{ start: 0, end: 2, k: 1 }, { start: 0, end: 9, k: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.answers).toEqual([]);
    expect(result.queryCount).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('validateInput：被拒文件的错误摘要有界且可定位', () => {
  it('readings 超长：即使每个元素都非法也只报 1 条规模错误（短路，不逐元素扫描）', () => {
    // 50 万个越界值：修复前会产生 50 万条诊断并遍历全部元素
    const verdict = validateInput({ readings: new Array(500_000).fill(-1), queries: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.errors).toHaveLength(1);
      expect(verdict.errors[0]).toContain('超出上限');
      expect(verdict.errors[0]).toContain('逐元素校验已跳过');
    }
  });

  it('queries 超长：只报 1 条规模错误（短路，不逐元素扫描）', () => {
    const verdict = validateInput({
      readings: [1, 2, 3],
      queries: new Array(300_000).fill(null),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.errors).toHaveLength(1);
      expect(verdict.errors[0]).toContain('超出上限');
      expect(verdict.errors[0]).toContain('逐元素校验已跳过');
    }
  });

  it('readings 与 queries 同时超长：总共只有 2 条诊断', () => {
    const verdict = validateInput({
      readings: new Array(500_000).fill(-1),
      queries: new Array(300_000).fill({ start: 0, end: 1, k: 1 }),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.errors).toHaveLength(2);
      expect(verdict.errors.join('\n')).toContain('readings[*]');
      expect(verdict.errors.join('\n')).toContain('queries[*]');
    }
  });

  it('规模合规但大量非法读数：诊断封顶为 ERROR_CAP 条定位 + 1 条截断汇总', () => {
    const verdict = validateInput({ readings: new Array(100_000).fill(-1), queries: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.errors).toHaveLength(ERROR_CAP + 1);
      // 逐条诊断仍可按下标定位：前 32 条分别对应 readings[0]..readings[31]
      expect(verdict.errors[0]).toContain('readings[0]');
      expect(verdict.errors[ERROR_CAP - 1]).toContain(`readings[${ERROR_CAP - 1}]`);
      // 第 33 条是截断汇总，而不是 readings[32]
      expect(verdict.errors[ERROR_CAP]).toContain('错误过多');
      expect(verdict.errors[ERROR_CAP]).not.toContain('readings[32]');
    }
  });

  it('大量非法查询同样封顶，且每条保留 queries[i] 定位', () => {
    const queries = new Array(100_000).fill(null);
    const verdict = validateInput({ readings: [1, 2, 3], queries });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.errors).toHaveLength(ERROR_CAP + 1);
      expect(verdict.errors[0]).toContain('queries[0]');
      expect(verdict.errors[ERROR_CAP - 1]).toContain(`queries[${ERROR_CAP - 1}]`);
      expect(verdict.errors[ERROR_CAP]).toContain('错误过多');
    }
  });

  it('诊断量与输入长度无关：10 万与 199999 条非法读数产生相同的有界摘要', () => {
    const a = validateInput({ readings: new Array(100_000).fill(65536), queries: [] });
    const b = validateInput({ readings: new Array(199_999).fill(65536), queries: [] });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (a.ok === false && b.ok === false) {
      expect(a.errors.length).toBe(ERROR_CAP + 1);
      expect(b.errors.length).toBe(ERROR_CAP + 1);
    }
  });

  it('规模合规且错误数不超过上限时行为不变：全部错误仍逐条列出', () => {
    const verdict = validateInput({
      readings: [0, -1, 65536],
      queries: [
        { start: 0, end: 1, k: 1 },
        { start: 0, end: 9, k: 1 },
        { start: 0, end: 1, k: 2 },
      ],
    });
    if (verdict.ok === false) {
      expect(verdict.errors).toHaveLength(4);
      const text = verdict.errors.join('\n');
      expect(text).toContain('readings[1]');
      expect(text).toContain('readings[2]');
      expect(text).toContain('queries[1]');
      expect(text).toContain('queries[2]');
    } else {
      throw new Error('应当整体拒绝');
    }
  });

  it('文本规模预检：超过 TEXT_MAX 返回一条诊断，边界值恰好放行', () => {
    expect(textSizeError(TEXT_MAX)).toBeNull();
    expect(textSizeError(0)).toBeNull();
    const msg = textSizeError(TEXT_MAX + 1);
    expect(msg).not.toBeNull();
    expect(msg).toContain('超出契约文本规模上限');
  });
});
