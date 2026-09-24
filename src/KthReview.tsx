import { useCallback, useMemo, useRef, useState } from 'react';
import { analyze } from './analyze';
import { generateFullScale } from './sampleGenerator';
import { textSizeError } from './validation';
import type { AnalysisResult, Query } from './types';

interface LoadedPayload {
  fileName: string;
  readingsCount: number;
  queries: Query[];
  result: AnalysisResult;
}

type ViewState =
  | { status: 'idle' }
  | { status: 'busy'; fileName: string }
  | { status: 'error'; fileName: string; errors: string[] }
  | { status: 'ready'; payload: LoadedPayload };

/** 错误列表的渲染上限：校验层已保证诊断有界，这里再做一道防御性截断 */
const RENDERED_ERRORS_MAX = 50;

/**
 * 第 k 小复核台。关键不变量：
 * - 每次重新选文件/载入样本都先清空旧视图，再处理新内容；
 * - 读取以单调递增的 loadSeq 绑定身份，读取期间被更新的选择替换时，
 *   旧任务的晚到回调（含解析与分析结果）一律丢弃，不覆盖当前状态；
 * - 远超契约规模的文件在读取前 / 解析前直接拒绝，不进入同步解析；
 * - 只有全部校验通过才渲染答案，任何非法文件只显示有界错误摘要、绝不留下部分答案；
 * - 答案按 queries 原顺序一一对应展示，显式打印查询下标，杜绝相邻窗口错位。
 */
export function KthReview() {
  const [view, setView] = useState<ViewState>({ status: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 当前选择序号：每次选文件 / 载入样本单调递增，旧加载任务以此作废 */
  const loadSeq = useRef(0);

  const consumeObject = useCallback((obj: unknown, fileName: string) => {
    // analyze 内部保证：失败时 answers 为空，调用方据此清除旧结果
    const result = analyze(obj);
    if (!result.ok) {
      setView({ status: 'error', fileName, errors: result.errors });
      return;
    }
    const data = obj as { readings: number[]; queries: Query[] };
    setView({
      status: 'ready',
      payload: {
        fileName,
        readingsCount: data.readings.length,
        queries: data.queries,
        result,
      },
    });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      const seq = ++loadSeq.current;
      // 先清除旧结果（含上一份成功答案），再进入新文件处理
      setView({ status: 'busy', fileName: file.name });
      // 规模预检：远超契约规模的文件不读取即整体拒绝（诊断恰好一条）
      const oversize = textSizeError(file.size);
      if (oversize) {
        setView({ status: 'error', fileName: file.name, errors: [oversize] });
        return;
      }
      try {
        const text = await file.text();
        // 读取期间用户可能已改选：旧任务的晚到结果不得覆盖当前状态
        if (seq !== loadSeq.current) return;
        // 字符数预检：在同步 JSON.parse 之前拦截巨型文本
        const oversizeText = textSizeError(text.length);
        if (oversizeText) {
          setView({ status: 'error', fileName: file.name, errors: [oversizeText] });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          if (seq !== loadSeq.current) return;
          const msg = e instanceof Error ? e.message : String(e);
          setView({
            status: 'error',
            fileName: file.name,
            errors: [`JSON 语法错误，整个文件被拒绝：${msg}`],
          });
          return;
        }
        if (seq !== loadSeq.current) return;
        consumeObject(parsed, file.name);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setView({ status: 'error', fileName: file.name, errors: [`文件读取失败：${msg}`] });
      }
    },
    [consumeObject],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      // 允许再次选择同名文件时重新触发 change
      e.target.value = '';
    },
    [handleFile],
  );

  const loadFullScaleSample = useCallback(() => {
    const seq = ++loadSeq.current;
    setView({ status: 'busy', fileName: '内置满规模样本（200000 读数 / 100000 查询）' });
    // 让 busy 有机会绘制后再做重计算
    setTimeout(() => {
      if (seq !== loadSeq.current) return; // 等待期间已被文件选择替换
      const sample = generateFullScale();
      consumeObject(sample, '内置满规模样本（200000 读数 / 100000 查询）');
    }, 16);
  }, [consumeObject]);

  return (
    <>
      <section className="loader">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={onInputChange}
          style={{ display: 'none' }}
        />
        <button className="primary" onClick={() => fileInputRef.current?.click()}>
          选择 JSON 文件
        </button>
        <button onClick={loadFullScaleSample}>载入内置满规模样本</button>
        <span className="hint">文件全程仅在本机浏览器中读取与计算</span>
      </section>

      {view.status === 'busy' && (
        <section className="panel busy">正在解析与复核「{view.fileName}」……</section>
      )}

      {view.status === 'error' && (
        <section className="panel error" role="alert">
          <h2>文件被整体拒绝：{view.fileName}</h2>
          <p className="error-lead">
            以下结构或边界错误导致整个文件被拒，未产生任何查询答案；如之前有旧结果也已清除。
          </p>
          <ul className="error-list">
            {view.errors.slice(0, RENDERED_ERRORS_MAX).map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
          {view.errors.length > RENDERED_ERRORS_MAX && (
            <p className="hint">
              错误过多：仅展示前 {RENDERED_ERRORS_MAX} 条（共 {view.errors.length} 条）
            </p>
          )}
        </section>
      )}

      {view.status === 'ready' && (
        <ResultsTable payload={view.payload} />
      )}

      {view.status === 'idle' && (
        <section className="panel idle">
          尚未载入文件。选择 JSON 文件，或直接载入内置的确定性满规模样本进行验收。
        </section>
      )}
    </>
  );
}

function ResultsTable({ payload }: { payload: LoadedPayload }) {
  const { fileName, readingsCount, queries, result } = payload;
  return (
    <section className="panel ready">
      <div className="summary">
        <h2>复核完成：{fileName}</h2>
        <dl className="metrics">
          <div><dt>读数条数</dt><dd>{readingsCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>查询条数</dt><dd>{result.queryCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>计算耗时</dt><dd>{result.timingMs.toFixed(1)} ms</dd></div>
          <div><dt>答案总和</dt><dd>{result.sum.toLocaleString('zh-CN')}</dd></div>
          <div><dt>摘要 FNV-1a</dt><dd>{result.digest.toString(16).padStart(8, '0')}</dd></div>
        </dl>
      </div>

      {result.queryCount === 0 ? (
        <p className="empty-queries">queries 为空：文件合法，但没有需要复核的查询。</p>
      ) : (
        <VirtualTable queries={queries} answers={result.answers} />
      )}
    </section>
  );
}

const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 560;
const OVERSCAN = 12;

/**
 * 仅渲染视口附近约 30 行，支撑 10 万行结果不卡顿；
 * 行的查询下标直接来自数组下标，首尾相邻窗口不会出现任何错位。
 */
function VirtualTable({ queries, answers }: { queries: Query[]; answers: number[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const total = queries.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);

  const rows = useMemo(() => {
    const items: Array<{ i: number; q: Query; a: number }> = [];
    for (let i = startIndex; i < endIndex; i++) {
      items.push({ i, q: queries[i], a: answers[i] });
    }
    return items;
  }, [startIndex, endIndex, queries, answers]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const jump = useCallback((target: number) => {
    const el = scrollRef.current;
    if (el) {
      const clamped = Math.max(0, Math.min(target, total - 1)) * ROW_HEIGHT;
      el.scrollTop = clamped;
      setScrollTop(clamped);
    }
  }, [total]);

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <button onClick={() => jump(0)}>首行 (#0)</button>
        <button onClick={() => jump(total - 1)}>末行 (#{(total - 1).toLocaleString('zh-CN')})</button>
        <span className="hint">
          当前可见 #{startIndex.toLocaleString('zh-CN')} – #{(endIndex - 1).toLocaleString('zh-CN')}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="viewport"
        onScroll={onScroll}
        style={{ height: VIEWPORT_HEIGHT }}
      >
        <div className="spacer" style={{ height: total * ROW_HEIGHT }}>
          <table className="results" style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
            <thead>
              <tr>
                <th className="col-idx">查询下标</th>
                <th>start</th>
                <th>end</th>
                <th>k</th>
                <th>窗口长度</th>
                <th className="col-ans">第 k 小值（精确）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ i, q, a }) => (
                <tr key={i}>
                  <td className="col-idx mono">#{i}</td>
                  <td className="mono">{q.start}</td>
                  <td className="mono">{q.end}</td>
                  <td className="mono">{q.k}</td>
                  <td className="mono">{q.end - q.start}</td>
                  <td className="col-ans mono strong">{a}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
