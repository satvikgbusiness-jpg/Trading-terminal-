'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries, CandlestickSeries, HistogramSeries, LineSeries,
  createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import clsx from 'clsx';
import type { CandleSeries } from '@/lib/market/types';
import { bollinger, closes, ema, macd, rsi, sma } from '@/lib/analysis/indicators';

/**
 * Candlestick chart with toggleable overlays and indicator sub-panes.
 *
 * When the feed publishes one reference price per period rather than a traded
 * range (`hasRange: false`), the main pane draws a line instead of candles.
 * Drawing zero-height candles from an ECB fixing would look like a market that
 * never moved intraday, which is a claim the data does not make.
 */

export type Overlay = 'sma20' | 'sma50' | 'sma200' | 'ema21' | 'bollinger';

const OVERLAY_LABELS: Record<Overlay, string> = {
  sma20: 'SMA 20',
  sma50: 'SMA 50',
  sma200: 'SMA 200',
  ema21: 'EMA 21',
  bollinger: 'BB 20,2',
};

const COLORS = {
  up: '#17c964',
  down: '#ff4d4d',
  sma20: '#38bdf8',
  sma50: '#ffb020',
  sma200: '#a78bfa',
  ema21: '#f472b6',
  band: 'rgba(120,130,150,0.55)',
  grid: 'rgba(30,35,44,0.7)',
  text: '#6a7382',
};

const chartTheme = {
  layout: {
    background: { color: 'transparent' },
    textColor: COLORS.text,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 10,
    attributionLogo: false,
  },
  grid: {
    vertLines: { color: COLORS.grid },
    horzLines: { color: COLORS.grid },
  },
  rightPriceScale: { borderColor: '#1e232c' },
  timeScale: { borderColor: '#1e232c', rightOffset: 4 },
  crosshair: { mode: 0 as const },
} as const;

export function PriceChart({
  series,
  symbol,
  height = 380,
}: {
  series: CandleSeries;
  symbol: string;
  height?: number;
}) {
  const [overlays, setOverlays] = useState<Set<Overlay>>(new Set(['sma50', 'sma200']));
  const [showRsi, setShowRsi] = useState(true);
  const [showMacd, setShowMacd] = useState(true);

  const toggle = (overlay: Overlay) =>
    setOverlays((current) => {
      const next = new Set(current);
      if (next.has(overlay)) next.delete(overlay);
      else next.add(overlay);
      return next;
    });

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-term-border px-2 py-1">
        {(Object.keys(OVERLAY_LABELS) as Overlay[]).map((overlay) => (
          <Toggle
            key={overlay}
            active={overlays.has(overlay)}
            onClick={() => toggle(overlay)}
            color={overlay === 'bollinger' ? undefined : COLORS[overlay]}
          >
            {OVERLAY_LABELS[overlay]}
          </Toggle>
        ))}
        <span className="mx-1 h-3 w-px bg-term-border" />
        <Toggle active={showRsi} onClick={() => setShowRsi((v) => !v)}>
          RSI 14
        </Toggle>
        <Toggle active={showMacd} onClick={() => setShowMacd((v) => !v)}>
          MACD
        </Toggle>
        {!series.hasRange && (
          <span className="ml-auto text-2xs text-term-warn">
            reference-rate feed: line chart, no intraday range
          </span>
        )}
      </div>

      <MainPane series={series} symbol={symbol} overlays={overlays} height={height} />
      {series.hasVolume && <VolumePane series={series} />}
      {showRsi && <RsiPane series={series} />}
      {showMacd && <MacdPane series={series} />}
    </div>
  );
}

function Toggle({
  active,
  onClick,
  color,
  children,
}: {
  active: boolean;
  onClick: () => void;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1 border px-1.5 py-0.5 text-2xs',
        active
          ? 'border-term-border-bright bg-term-panel-2 text-term-bright'
          : 'border-transparent text-term-faint hover:text-term-dim',
      )}
    >
      {color && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: active ? color : 'transparent', border: `1px solid ${color}` }}
        />
      )}
      {children}
    </button>
  );
}

/** Shared chart lifecycle: create, size to container, dispose. */
function useChart(height: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      ...chartTheme,
      width: container.clientWidth,
      height,
    });
    chartRef.current = chart;
    setReady(true);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) chart.applyOptions({ width });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      setReady(false);
    };
  }, [height]);

  return { containerRef, chartRef, ready };
}

const toTime = (t: number): UTCTimestamp => t as UTCTimestamp;

function MainPane({
  series,
  symbol,
  overlays,
  height,
}: {
  series: CandleSeries;
  symbol: string;
  overlays: Set<Overlay>;
  height: number;
}) {
  const { containerRef, chartRef, ready } = useChart(height);
  const overlayRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  const bars = series.bars;
  const prices = useMemo(() => closes(bars), [bars]);

  // Price series: candles when the feed has a real range, a line when it does not.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || bars.length === 0) return;

    if (series.hasRange) {
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: COLORS.up,
        downColor: COLORS.down,
        wickUpColor: COLORS.up,
        wickDownColor: COLORS.down,
        borderVisible: false,
      });
      candles.setData(
        bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })),
      );
      chart.timeScale().fitContent();
      return () => {
        chart.removeSeries(candles);
      };
    }

    const line = chart.addSeries(AreaSeries, {
      lineColor: COLORS.sma20,
      topColor: 'rgba(56,189,248,0.20)',
      bottomColor: 'rgba(56,189,248,0.01)',
      lineWidth: 2,
    });
    line.setData(bars.map((b) => ({ time: toTime(b.t), value: b.c })));
    chart.timeScale().fitContent();
    return () => {
      chart.removeSeries(line);
    };
  }, [chartRef, ready, bars, series.hasRange, symbol]);

  // Overlays are added and removed individually so toggling one does not
  // rebuild the whole chart.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || prices.length === 0) return;
    const active = overlayRefs.current;

    const wanted = new Map<string, { color: string; values: Array<number | null>; width: 1 | 2 }>();
    if (overlays.has('sma20')) wanted.set('sma20', { color: COLORS.sma20, values: sma(prices, 20), width: 1 });
    if (overlays.has('sma50')) wanted.set('sma50', { color: COLORS.sma50, values: sma(prices, 50), width: 1 });
    if (overlays.has('sma200')) wanted.set('sma200', { color: COLORS.sma200, values: sma(prices, 200), width: 2 });
    if (overlays.has('ema21')) wanted.set('ema21', { color: COLORS.ema21, values: ema(prices, 21), width: 1 });
    if (overlays.has('bollinger')) {
      const bands = bollinger(prices, 20, 2);
      wanted.set('bb-upper', { color: COLORS.band, values: bands.upper, width: 1 });
      wanted.set('bb-lower', { color: COLORS.band, values: bands.lower, width: 1 });
    }

    for (const [key, line] of active) {
      if (!wanted.has(key)) {
        chart.removeSeries(line);
        active.delete(key);
      }
    }

    for (const [key, spec] of wanted) {
      if (active.has(key)) continue;
      const line = chart.addSeries(LineSeries, {
        color: spec.color,
        lineWidth: spec.width,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      // Null warm-up values are dropped rather than plotted as zero.
      line.setData(
        spec.values
          .map((value, index) => ({ time: toTime(bars[index]!.t), value }))
          .filter((point): point is { time: UTCTimestamp; value: number } => point.value !== null),
      );
      active.set(key, line);
    }
  }, [chartRef, ready, overlays, prices, bars]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}

function SubPane({
  title,
  height,
  children,
}: {
  title: string;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <div className="relative border-t border-term-border">
      <span className="label absolute left-2 top-1 z-10">{title}</span>
      <div style={{ height }}>{children}</div>
    </div>
  );
}

function VolumePane({ series }: { series: CandleSeries }) {
  const height = 90;
  const { containerRef, chartRef, ready } = useChart(height);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    const histogram = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } });
    histogram.setData(
      series.bars
        .filter((b) => b.v !== null)
        .map((b, index, arr) => {
          const previous = arr[index - 1];
          const rising = previous ? b.c >= previous.c : true;
          return {
            time: toTime(b.t),
            value: b.v as number,
            color: rising ? 'rgba(23,201,100,0.5)' : 'rgba(255,77,77,0.5)',
          };
        }),
    );
    chart.timeScale().fitContent();
    return () => {
      chart.removeSeries(histogram);
    };
  }, [chartRef, ready, series.bars]);

  return (
    <SubPane title="Volume" height={height}>
      <div ref={containerRef} className="w-full" style={{ height }} />
    </SubPane>
  );
}

function RsiPane({ series }: { series: CandleSeries }) {
  const height = 110;
  const { containerRef, chartRef, ready } = useChart(height);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    const prices = closes(series.bars);
    const values = rsi(prices, 14);

    const line = chart.addSeries(LineSeries, { color: COLORS.sma20, lineWidth: 1 });
    line.setData(
      values
        .map((value, index) => ({ time: toTime(series.bars[index]!.t), value }))
        .filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null),
    );
    // The 30/70 bands are what make an RSI pane readable at a glance.
    for (const level of [30, 70]) {
      line.createPriceLine({
        price: level,
        color: level === 70 ? 'rgba(255,77,77,0.4)' : 'rgba(23,201,100,0.4)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: '',
      });
    }
    chart.priceScale('right').applyOptions({ autoScale: false });
    line.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    chart.timeScale().fitContent();

    return () => {
      chart.removeSeries(line);
    };
  }, [chartRef, ready, series.bars]);

  return (
    <SubPane title="RSI(14)" height={height}>
      <div ref={containerRef} className="w-full" style={{ height }} />
    </SubPane>
  );
}

function MacdPane({ series }: { series: CandleSeries }) {
  const height = 110;
  const { containerRef, chartRef, ready } = useChart(height);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    const prices = closes(series.bars);
    const { macd: line, signal, histogram } = macd(prices);
    const at = (index: number) => toTime(series.bars[index]!.t);

    const bars = chart.addSeries(HistogramSeries, {});
    bars.setData(
      histogram
        .map((value, index) => ({
          time: at(index),
          value,
          color: (value ?? 0) >= 0 ? 'rgba(23,201,100,0.5)' : 'rgba(255,77,77,0.5)',
        }))
        .filter((p): p is { time: UTCTimestamp; value: number; color: string } => p.value !== null),
    );

    const macdLine = chart.addSeries(LineSeries, { color: COLORS.sma20, lineWidth: 1 });
    macdLine.setData(
      line
        .map((value, index) => ({ time: at(index), value }))
        .filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null),
    );

    const signalLine = chart.addSeries(LineSeries, { color: COLORS.sma50, lineWidth: 1 });
    signalLine.setData(
      signal
        .map((value, index) => ({ time: at(index), value }))
        .filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null),
    );

    chart.timeScale().fitContent();
    return () => {
      chart.removeSeries(bars);
      chart.removeSeries(macdLine);
      chart.removeSeries(signalLine);
    };
  }, [chartRef, ready, series.bars]);

  return (
    <SubPane title="MACD(12,26,9)" height={height}>
      <div ref={containerRef} className="w-full" style={{ height }} />
    </SubPane>
  );
}
