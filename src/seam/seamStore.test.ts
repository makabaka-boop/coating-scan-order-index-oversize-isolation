import { describe, expect, it } from 'vitest';
import { computeSeamOverlap } from './seamCore';
import { ManualScheduler, SeamStore } from './seamStore';
import { ERROR_CAP } from '../validation';
import { TEXT_MAX } from '../types';

/** 构造合法文件 JSON 文本（契约要求 readings 与 queries 同时合法） */
function fileText(readings: number[], queries: unknown[] = []): string {
  return JSON.stringify({ readings, queries });
}

/** 可手动兑现/拒绝的 Promise，用于精确控制文件读取回调的到达时机 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 交替泵出手动调度队列并排空 microtask，直到前置管线（读取→解析→校验）
 * 与其启动的匹配任务全部推进完毕。读取完成的 continuation 是 microtask，
 * 用 setTimeout(0) 宏任务保证它一定被排空（其中可能向队列排入新分片）。
 */
async function pumpUntilIdle(scheduler: ManualScheduler): Promise<void> {
  for (let round = 0; round < 1000; round++) {
    scheduler.runAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (scheduler.pending === 0) return;
  }
  throw new Error('调度队列未收敛：可能存在分片未终止的循环');
}

describe('SeamStore：双槽位状态机', () => {
  it('空闲 → 单侧已载入 → 双侧匹配中 → 接缝成立，结果字段完整', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().result).toBeNull();

    const left = [4, 1, 2, 3, 1, 2, 3];
    const right = [1, 2, 3, 9, 9, 9, 9, 9, 9, 9];
    store.readySlot('left', 'front.json', left);
    expect(store.getState().phase).toBe('one-sided');
    expect(store.getState().result).toBeNull();

    store.readySlot('right', 'back.json', right);
    expect(store.getState().phase).toBe('matching');
    expect(scheduler.pending).toBeGreaterThan(0);

    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('seam');
    expect(state.result).not.toBeNull();
    const r = state.result!;
    expect(r.leftFileName).toBe('front.json');
    expect(r.rightFileName).toBe('back.json');
    expect(r.overlap).toBe(computeSeamOverlap(left, right));
    expect(r.overlap).toBe(3);
    expect(r.mergedCount).toBe(left.length + right.length - 3);
    expect(r.leftCount).toBe(left.length);
    expect(r.rightCount).toBe(right.length);
    // 上下文：前段末尾 / 后段开头各至多 8 条（left 仅 7 条，全部展示）
    expect(r.leftTail).toEqual(left);
    expect(r.rightHead).toEqual([1, 2, 3, 9, 9, 9, 9, 9]);
    expect(r.leftTail.length).toBeLessThanOrEqual(8);
    expect(r.rightHead.length).toBeLessThanOrEqual(8);
    expect(state.taskSeq).toBe(1);
  });

  it('零重叠进入无重叠终态，去重拼接长度为两侧之和', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    store.readySlot('left', 'a.json', [1, 2, 3]);
    store.readySlot('right', 'b.json', [7, 8, 9]);
    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('no-overlap');
    expect(state.result!.overlap).toBe(0);
    expect(state.result!.mergedCount).toBe(6);
  });

  it('替换任一侧立即撤销旧结论并重算，新结果只反映新配对', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    store.readySlot('left', 'L1.json', [1, 2, 3]);
    store.readySlot('right', 'R1.json', [2, 3, 4]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('seam');
    expect(store.getState().result!.overlap).toBe(2);

    // 替换前段：结论同步撤销，立刻回到匹配中
    store.readySlot('left', 'L2.json', [8, 8, 8]);
    const mid = store.getState();
    expect(mid.result).toBeNull();
    expect(mid.phase).toBe('matching');

    scheduler.runAll();
    const done = store.getState();
    expect(done.phase).toBe('no-overlap');
    expect(done.result!.leftFileName).toBe('L2.json');
    expect(done.result!.rightFileName).toBe('R1.json');
    expect(done.result!.overlap).toBe(0);
  });

  it('单侧失败只标记该槽且保留另一侧，结论同步撤销', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    store.readySlot('left', 'L.json', [1, 2, 3]);
    store.readySlot('right', 'R.json', [2, 3, 4]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('seam');

    store.failSlot('left', 'bad.json', ['readings[0]：必须是整数']);
    const state = store.getState();
    expect(state.result).toBeNull();
    expect(state.phase).toBe('one-sided');
    expect(state.left.status).toBe('error');
    expect(state.right.status).toBe('ready');
    if (state.right.status === 'ready') {
      expect(state.right.fileName).toBe('R.json');
      expect(state.right.readings).toEqual([2, 3, 4]);
    }

    // 失败的槽位重新就绪后，与保留的另一侧重新配对
    store.readySlot('left', 'L2.json', [9, 2, 3]);
    scheduler.runAll();
    const again = store.getState();
    expect(again.phase).toBe('seam');
    expect(again.result!.leftFileName).toBe('L2.json');
    expect(again.result!.overlap).toBe(2);
  });
});

describe('SeamStore：可控调度器交错，替换或失败不回写旧结果', () => {
  it('匹配推进到一半时替换前段：旧任务在下一调度点终止，结果只属于新配对', () => {
    const scheduler = new ManualScheduler();
    // 分片预算 2：长度 9 + 9 的匹配需要多个分片，制造交错窗口
    const store = new SeamStore(scheduler, 2);
    const left1 = [5, 5, 5, 1, 2, 3, 4, 5, 6];
    const right1 = [3, 4, 5, 6, 7, 7, 7, 7, 7];
    const left2 = [9, 9, 9, 9, 9, 9, 9, 9, 8];

    store.readySlot('left', 'L1.json', left1);
    store.readySlot('right', 'R1.json', right1);
    expect(store.getState().taskSeq).toBe(1);

    // 旧任务只推进一个分片，尚未完成
    expect(scheduler.runNext()).toBe(true);
    expect(store.getState().result).toBeNull();

    // 替换前段：旧任务作废，新任务排入队列（旧任务的后续分片仍在队列中）
    store.readySlot('left', 'L2.json', left2);
    expect(store.getState().taskSeq).toBe(2);
    expect(store.getState().result).toBeNull();

    scheduler.runAll();
    const state = store.getState();
    // 最终结果必须反映 L2 × R1，而不是 L1 × R1
    expect(state.result!.leftFileName).toBe('L2.json');
    expect(state.result!.rightFileName).toBe('R1.json');
    expect(state.result!.overlap).toBe(computeSeamOverlap(left2, right1));
    expect(state.result!.overlap).toBe(0);
    expect(state.phase).toBe('no-overlap');
    // 旧任务的结论若回写，overlap 会是 4（L1 × R1），这里显式排除
    expect(state.result!.overlap).not.toBe(computeSeamOverlap(left1, right1));
  });

  it('旧任务的完成分片晚到：队列中先于新任务执行，也不得覆盖当前状态', () => {
    const scheduler = new ManualScheduler();
    // 预算足够大：每个任务一个分片即可完成
    const store = new SeamStore(scheduler, 1000);
    store.readySlot('left', 'L1.json', [1, 2, 3, 4]);
    store.readySlot('right', 'R1.json', [2, 3, 4, 5]);
    // 旧任务的唯一分片已在队列中，但尚未执行
    expect(scheduler.pending).toBe(1);

    // 在旧分片执行前替换前段：新任务排在其后
    store.readySlot('left', 'L2.json', [7, 7, 7, 7]);
    expect(scheduler.pending).toBe(2);

    scheduler.runAll();
    const state = store.getState();
    // 若缺少身份核验，旧分片会先提交 L1×R1 的结论并阻塞新任务提交
    expect(state.result!.leftFileName).toBe('L2.json');
    expect(state.result!.overlap).toBe(computeSeamOverlap([7, 7, 7, 7], [2, 3, 4, 5]));
    expect(state.result!.overlap).toBe(0);
    expect(state.taskSeq).toBe(2);
  });

  it('匹配进行中单侧失败：结论撤销、另一侧保留，旧任务晚到分片不得回写', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 2);
    store.readySlot('left', 'L.json', [1, 2, 3, 4, 5, 6]);
    store.readySlot('right', 'R.json', [3, 4, 5, 6, 0, 0]);

    // 推进一个分片后让右侧失败
    expect(scheduler.runNext()).toBe(true);
    store.failSlot('right', 'R-bad.json', ['queries[0]：k 越界']);

    const mid = store.getState();
    expect(mid.phase).toBe('one-sided');
    expect(mid.result).toBeNull();
    expect(mid.left.status).toBe('ready');
    expect(mid.right.status).toBe('error');

    // 泵空队列：旧任务的剩余分片不得提交任何结论
    scheduler.runAll();
    const done = store.getState();
    expect(done.result).toBeNull();
    expect(done.phase).toBe('one-sided');
    expect(done.left.status).toBe('ready');
  });

  it('连续快速替换：只有最后一组配对能留下结论', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 1000);
    store.readySlot('left', 'L1.json', [1, 1, 1]);
    store.readySlot('right', 'R1.json', [1, 1, 1]);
    store.readySlot('left', 'L2.json', [2, 2, 2]);
    store.readySlot('right', 'R2.json', [3, 3, 3]);
    store.readySlot('left', 'L3.json', [4, 3, 3]);
    // 队列中积压了多个被作废任务的分片
    expect(scheduler.pending).toBeGreaterThan(1);

    scheduler.runAll();
    const state = store.getState();
    expect(state.result!.leftFileName).toBe('L3.json');
    expect(state.result!.rightFileName).toBe('R2.json');
    expect(state.result!.overlap).toBe(2);
    expect(state.phase).toBe('seam');
  });
});

describe('SeamStore：本地 JSON 入口（整文件契约验证，只取 readings）', () => {
  it('合法文件进入槽位并触发匹配；queries 为空也合法', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const p1 = store.loadFileIntoSlot('left', 'f.json', () =>
      Promise.resolve(fileText([1, 2, 3])),
    );
    await pumpUntilIdle(scheduler);
    await p1;
    expect(store.getState().left.status).toBe('ready');
    const p2 = store.loadFileIntoSlot('right', 'b.json', () =>
      Promise.resolve(fileText([2, 3, 4])),
    );
    await pumpUntilIdle(scheduler);
    await p2;
    const state = store.getState();
    expect(state.phase).toBe('seam');
    expect(state.result!.overlap).toBe(2);
  });

  it('JSON 语法错误：只标记该槽，保留另一侧', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const p1 = store.loadFileIntoSlot('left', 'ok.json', () =>
      Promise.resolve(fileText([1, 2, 3])),
    );
    await pumpUntilIdle(scheduler);
    await p1;
    const p2 = store.loadFileIntoSlot('right', 'bad.json', () => Promise.resolve('{ not json'));
    await pumpUntilIdle(scheduler);
    await p2;
    const state = store.getState();
    expect(state.left.status).toBe('ready');
    expect(state.right.status).toBe('error');
    if (state.right.status === 'error') {
      expect(state.right.errors.join('\n')).toContain('JSON 语法错误');
    }
    expect(state.phase).toBe('one-sided');
  });

  it('契约错误按下标反馈：readings 越界与 queries 非法都整体拒绝', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const p1 = store.loadFileIntoSlot('left', 'r.json', () =>
      Promise.resolve(fileText([1, 2, 65536])),
    );
    await pumpUntilIdle(scheduler);
    await p1;
    let state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors.join('\n')).toContain('readings[2]');
    }

    // readings 合法但 queries 非法：本模块虽不用 queries，契约仍整体验证
    const p2 = store.loadFileIntoSlot('left', 'q.json', () =>
      Promise.resolve(fileText([1, 2, 3], [{ start: 0, end: 3, k: 4 }])),
    );
    await pumpUntilIdle(scheduler);
    await p2;
    state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors.join('\n')).toContain('queries[0]');
    }
  });

  it('文件读取失败：只标记该槽', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const p1 = store.loadFileIntoSlot('right', 'ok.json', () =>
      Promise.resolve(fileText([5])),
    );
    await pumpUntilIdle(scheduler);
    await p1;
    // 读取失败分支不经调度分片：await 完成时槽位已是 error
    await store.loadFileIntoSlot('left', 'io.json', () =>
      Promise.reject(new Error('磁盘错误')),
    );
    const state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors.join('\n')).toContain('文件读取失败');
      expect(state.left.errors.join('\n')).toContain('磁盘错误');
    }
    expect(state.right.status).toBe('ready');
  });

  it('同一槽位的晚到读取回调不得覆盖更新的选择', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const slow = deferred<string>();

    // 第一次选择：读取挂起
    const first = store.loadFileIntoSlot('left', 'slow.json', () => slow.promise);
    expect(store.getState().left.status).toBe('loading');

    // 用户改主意，第二次选择同名槽位并立即成功
    const second = store.loadFileIntoSlot('left', 'fast.json', () =>
      Promise.resolve(fileText([7, 7, 7])),
    );
    await pumpUntilIdle(scheduler);
    await second;
    expect(store.getState().left.status).toBe('ready');

    // 迟到的第一次读取此时才兑现：其解析/校验分片必须在调度点终止
    slow.resolve(fileText([1, 1, 1]));
    await first;
    await pumpUntilIdle(scheduler);
    const state = store.getState();
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      expect(state.left.fileName).toBe('fast.json');
      expect(state.left.readings).toEqual([7, 7, 7]);
    }
  });
});

describe('SeamStore：前置管线的分片调度与任务身份', () => {
  it('解析/校验分片经调度器推进：队列深度与槽位状态逐点可核对', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const p = store.loadFileIntoSlot('left', 'f.json', () =>
      Promise.resolve(fileText([1, 2, 3])),
    );

    // 读取的 continuation 还是 microtask：尚无分片入队，槽位处于读取中
    expect(scheduler.pending).toBe(0);
    expect(store.getState().left.status).toBe('loading');

    await Promise.resolve(); // 读取完成 → 解析分片入队
    expect(scheduler.pending).toBe(1);
    expect(store.getState().left.status).toBe('loading');

    expect(scheduler.runNext()).toBe(true); // 解析分片完成 → 校验分片入队
    expect(scheduler.pending).toBe(1);
    expect(store.getState().left.status).toBe('loading');

    expect(scheduler.runNext()).toBe(true); // 校验分片完成 → 槽位就绪
    expect(scheduler.pending).toBe(0);
    const readySlot = store.getState().left;
    expect(readySlot.status).toBe('ready');
    if (readySlot.status === 'ready') {
      expect(readySlot.readings).toEqual([1, 2, 3]);
    }
    await p;
  });

  it('读取刚完成、解析分片未执行时被替换：旧分片入队即作废，新文件不受延迟', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const slow = deferred<string>();

    // 误选的大文件：读取挂起
    const first = store.loadFileIntoSlot('left', 'mistake.json', () => slow.promise);
    expect(store.getState().left.status).toBe('loading');

    // 旧文件读取刚完成：解析分片已入队，但尚未执行
    slow.resolve(fileText([9, 9, 9]));
    await Promise.resolve();
    expect(scheduler.pending).toBe(1);

    // 此时质检员立即改选正确文件
    const second = store.loadFileIntoSlot('left', 'correct.json', () =>
      Promise.resolve(fileText([7, 7, 7])),
    );
    await Promise.resolve();
    // 队列里同时有旧解析分片与新解析分片
    expect(scheduler.pending).toBe(2);

    // 旧分片先执行但在入口自行终止；新文件走完全部解析/校验流程
    scheduler.runAll();
    await first;
    await second;
    expect(scheduler.pending).toBe(0);
    const state = store.getState();
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      expect(state.left.fileName).toBe('correct.json');
      expect(state.left.readings).toEqual([7, 7, 7]);
    }
  });

  it('旧文件已解析、校验分片入队后被替换：旧文件的整体校验不得再运行', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);

    // 旧文件：读取与解析完成，校验分片已入队
    const oldRead = deferred<string>();
    const first = store.loadFileIntoSlot('left', 'old-bad.json', () => oldRead.promise);
    oldRead.resolve(fileText([9, 9, 9]));
    await Promise.resolve(); // 解析分片入队
    expect(scheduler.runNext()).toBe(true); // 执行解析分片 → 校验分片入队
    expect(scheduler.pending).toBe(1);
    expect(store.getState().left.status).toBe('loading');

    // 校验分片尚未执行时改选正确文件
    const second = store.loadFileIntoSlot('left', 'correct.json', () =>
      Promise.resolve(fileText([7, 7, 7])),
    );
    await Promise.resolve();
    // 队列：旧校验分片（入口即终止）+ 新解析分片
    expect(scheduler.pending).toBe(2);
    scheduler.runAll();
    await first;
    await second;

    const state = store.getState();
    expect(scheduler.pending).toBe(0);
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      // 若旧校验分片运行并提交，槽位会是 old-bad.json / [9,9,9]
      expect(state.left.fileName).toBe('correct.json');
      expect(state.left.readings).toEqual([7, 7, 7]);
    }
  });

  it('双侧已产出接缝结论后误选再改选：旧任务不触碰另一槽位与最近合法结果', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 1000);

    // 先建立合法接缝结论 S1：L1 × R1
    store.readySlot('left', 'L1.json', [1, 2, 3]);
    store.readySlot('right', 'R1.json', [2, 3, 4]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('seam');
    expect(store.getState().result!.overlap).toBe(2);

    // 误选大文件（读取挂起）：旧结论按契约立即撤销，右槽保留
    const mistaken = deferred<string>();
    const mistakeLoad = store.loadFileIntoSlot('left', 'mistake.json', () => mistaken.promise);
    expect(store.getState().result).toBeNull();
    expect(store.getState().left.status).toBe('loading');
    expect(store.getState().right.status).toBe('ready');

    // 立即改选正确文件：新结论 S2 产出
    const correct = store.loadFileIntoSlot('left', 'L2.json', () =>
      Promise.resolve(fileText([8, 2, 3])),
    );
    await pumpUntilIdle(scheduler);
    await correct;
    const stateWithS2 = store.getState();
    expect(stateWithS2.phase).toBe('seam');
    expect(stateWithS2.result).not.toBeNull();
    expect(stateWithS2.result!.leftFileName).toBe('L2.json');
    expect(stateWithS2.result!.overlap).toBe(2);

    // 误选文件的读取此刻才完成，其分片即使执行也必须静默终止
    mistaken.resolve(fileText([1, 1, 1]));
    await mistakeLoad;
    await pumpUntilIdle(scheduler);

    const after = store.getState();
    // 当前槽位仍是正确文件
    expect(after.left.status).toBe('ready');
    const leftSlot = after.left;
    if (leftSlot.status === 'ready') {
      expect(leftSlot.fileName).toBe('L2.json');
      expect(leftSlot.readings).toEqual([8, 2, 3]);
    }
    // 另一槽位从未被触碰
    expect(after.right.status).toBe('ready');
    const rightSlot = after.right;
    if (rightSlot.status === 'ready') {
      expect(rightSlot.fileName).toBe('R1.json');
      expect(rightSlot.readings).toEqual([2, 3, 4]);
    }
    // 最近合法结果 S2 原样保留（旧任务不得改写或撤销）
    expect(after.result).toBe(stateWithS2.result);
  });
});

describe('SeamStore：超长与多错误文件只产生有界诊断', () => {
  it('字节数预检：远超契约规模的文件不读取、不解析即拒绝，不占用调度队列', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    let readCalled = false;
    await store.loadFileIntoSlot(
      'left',
      'huge.json',
      () => {
        readCalled = true;
        return Promise.resolve(fileText([1]));
      },
      { byteSize: TEXT_MAX + 1 },
    );
    expect(readCalled).toBe(false);
    expect(scheduler.pending).toBe(0);
    const state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors).toHaveLength(1);
      expect(state.left.errors[0]).toContain('超出契约文本规模上限');
    }
    // 另一槽位不受影响
    expect(state.right.status).toBe('empty');
  });

  it('字符数预检：读取后、JSON.parse 前拒绝超长文本', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    // 合法 JSON（一个字符串），但文本规模远超阈值：必须命中预检，
    // 而不是走到「顶层必须是对象」的契约错误
    const big = `"${'x'.repeat(TEXT_MAX + 1)}"`;
    const p = store.loadFileIntoSlot('left', 'big.json', () => Promise.resolve(big));
    await pumpUntilIdle(scheduler);
    await p;
    const state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors).toHaveLength(1);
      expect(state.left.errors[0]).toContain('超出契约文本规模上限');
    }
  });

  it('readings 远超上限：30 万条只产生 1 条规模诊断（短路，不逐元素扫描）', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const tooMany = new Array<number>(300_000).fill(0);
    const p = store.loadFileIntoSlot('left', 'overflow.json', () =>
      Promise.resolve(fileText(tooMany)),
    );
    await pumpUntilIdle(scheduler);
    await p;
    const state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors).toHaveLength(1);
      expect(state.left.errors[0]).toContain('超出上限');
      expect(state.left.errors[0]).toContain('逐元素校验已跳过');
    }
  });

  it('规模合规但 10 万条读数全部越界：诊断封顶且可定位，另一槽位保留', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    store.readySlot('right', 'R.json', [1, 2, 3]);
    const badReadings = new Array<number>(100_000).fill(-1);
    const p = store.loadFileIntoSlot('left', 'corrupt.json', () =>
      Promise.resolve(fileText(badReadings)),
    );
    await pumpUntilIdle(scheduler);
    await p;
    const state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors).toHaveLength(ERROR_CAP + 1);
      expect(state.left.errors[0]).toContain('readings[0]');
      expect(state.left.errors[ERROR_CAP - 1]).toContain(`readings[${ERROR_CAP - 1}]`);
      expect(state.left.errors[ERROR_CAP]).toContain('错误过多');
    }
    // 单侧失败只标记本槽，另一侧原样保留
    expect(state.right.status).toBe('ready');
    if (state.right.status === 'ready') {
      expect(state.right.fileName).toBe('R.json');
      expect(state.right.readings).toEqual([1, 2, 3]);
    }
    expect(state.result).toBeNull();
  });
});
