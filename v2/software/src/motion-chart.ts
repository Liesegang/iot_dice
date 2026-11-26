import type { StreamSample, Vec3 } from './ble';

const WINDOW_MS = 10_000;
const MAX_SAMPLES = 1_600;
const FRAME_MS = 1000 / 15;
const GAP_MS = 350;
const CHART_HEIGHT = 132;
const AXES = ['x', 'y', 'z'] as const;
const COLORS = ['#ff8a85', '#75dfb1', '#83baff'] as const;
const GRAVITY = 9.80665;
type ChartField = 'w' | 'a' | 'aLow' | 'aHigh';

interface Point {
    time: number;
    segment: number;
    w: Vec3;
    a: Vec3;
    aLow?: Vec3;
    aHigh?: Vec3;
}

interface Chart {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    values: HTMLOutputElement[];
    field: ChartField;
    minimum: number;
    scale: number;
}

function finiteVec(v: Vec3): boolean {
    return AXES.every(axis => Number.isFinite(v[axis]));
}

function axisLimit(peak: number, minimum: number): number {
    const wanted = Math.max(minimum, peak * 1.12);
    const magnitude = 10 ** Math.floor(Math.log10(wanted));
    const fraction = wanted / magnitude;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
}

function tickLabel(value: number): string {
    return value === 0 ? '0' : Math.abs(value) >= 1000
        ? value.toPrecision(2).replace('e+', 'e')
        : Number(value.toPrecision(3)).toString();
}

/** A bounded, live view of the device's signed IMU measurements. */
export class MotionCharts {
    private readonly root: HTMLDivElement;
    private readonly charts: Chart[];
    private readonly observer: ResizeObserver;
    private readonly status: HTMLSpanElement;
    private samples: Point[] = [];
    private rawTime: number | null = null;
    private time = 0;
    private segment = 0;
    private receivedAt = 0;
    private renderedAt = -Infinity;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    constructor(container: HTMLElement) {
        this.root = document.createElement('div');
        this.root.className = 'motion-charts';
        Object.assign(this.root.style, {
            width: '100%', minWidth: '0', padding: '12px', borderRadius: '10px',
            background: '#111827ed', border: '1px solid #2d4260', color: '#d8e2ed',
            fontFamily: 'inherit', boxSizing: 'border-box',
        });

        const header = document.createElement('div');
        Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' });
        const title = document.createElement('strong');
        title.textContent = 'IMU波形';
        title.style.fontSize = '12px';
        this.status = document.createElement('span');
        this.status.textContent = 'データ待ち';
        Object.assign(this.status.style, { fontSize: '10px', color: '#8ba0b7', alignSelf: 'center' });
        header.append(title, this.status);
        this.root.appendChild(header);
        this.charts = [
            this.createChart('角速度', 'w', 'rad/s', 1),
            this.createChart('低g加速度（±16g）', 'aLow', 'g', 2, 1 / GRAVITY),
            this.createChart('高g加速度（±320g）', 'aHigh', 'g', 2, 1 / GRAVITY),
            this.createChart('線形加速度', 'a', 'm/s²', 2),
        ];
        const note = document.createElement('p');
        note.textContent = 'IMU座標のX/Y/Z。低g・高gは重力を含む値、線形加速度は重力除去後。高gは通知間で最大の大きさだった実測ベクトルを表示。1g = 9.80665 m/s²。';
        Object.assign(note.style, { fontSize: '9px', lineHeight: '1.5', color: '#8295aa', marginTop: '4px' });
        this.root.appendChild(note);
        container.appendChild(this.root);
        this.observer = new ResizeObserver(() => this.schedule());
        this.observer.observe(container);
        this.schedule();
    }

    /** Device timestamps define the horizontal axis; reconnects never bridge gaps. */
    add(sample: StreamSample): void {
        if (this.disposed || !Number.isFinite(sample.t) || !finiteVec(sample.w) || !finiteVec(sample.a)) return;
        const raw = sample.t >>> 0;
        const now = performance.now();
        if (this.rawTime !== null) {
            const delta = (raw - this.rawTime) >>> 0;
            const hostDelta = now - this.receivedAt;
            if (delta === 0) return;
            if (delta >= 0x8000_0000) {
                // A reboot/backward clock gets a fresh segment, with host time as the gap.
                this.time += Math.max(1, hostDelta);
                this.segment++;
            } else {
                this.time += delta;
                if (raw < this.rawTime || delta > GAP_MS || hostDelta > GAP_MS) this.segment++;
            }
        }
        this.rawTime = raw;
        this.receivedAt = now;
        this.samples.push({
            time: this.time, segment: this.segment,
            w: { ...sample.w }, a: { ...sample.a },
            aLow: sample.aLow && finiteVec(sample.aLow) ? { ...sample.aLow } : undefined,
            aHigh: sample.aHighPeak && finiteVec(sample.aHighPeak) ? { ...sample.aHighPeak }
                : sample.aHigh && finiteVec(sample.aHigh) ? { ...sample.aHigh } : undefined,
        });
        const cutoff = this.time - WINDOW_MS;
        let remove = 0;
        while (remove < this.samples.length && this.samples[remove].time < cutoff) remove++;
        remove = Math.max(remove, this.samples.length - MAX_SAMPLES);
        if (remove > 0) this.samples.splice(0, remove);
        this.schedule();
    }

    clear(): void {
        this.samples = [];
        this.rawTime = null;
        this.time = 0;
        this.segment = 0;
        this.receivedAt = 0;
        this.schedule();
    }

    dispose(): void {
        this.disposed = true;
        clearTimeout(this.timer);
        this.observer.disconnect();
        this.root.remove();
    }

    private createChart(title: string, field: ChartField, unit: string, minimum: number, scale = 1): Chart {
        const figure = document.createElement('figure');
        figure.style.margin = '0';
        const caption = document.createElement('figcaption');
        caption.textContent = `${title} (${unit})`;
        Object.assign(caption.style, { fontSize: '11px', fontWeight: '600', marginBottom: '4px' });
        const legend = document.createElement('div');
        Object.assign(legend.style, { display: 'flex', justifyContent: 'space-between', gap: '6px', fontSize: '10px', marginBottom: '2px' });
        const values = AXES.map((axis, index) => {
            const entry = document.createElement('span');
            entry.style.color = COLORS[index];
            entry.append(`${axis.toUpperCase()} `);
            const value = document.createElement('output');
            value.textContent = '—';
            entry.appendChild(value);
            legend.appendChild(entry);
            return value;
        });
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${title}のX、Y、Z、直近10秒のグラフ。単位${unit}`);
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = `${CHART_HEIGHT}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('IMU波形のCanvasを初期化できませんでした');
        figure.append(caption, legend, canvas);
        this.root.appendChild(figure);
        return { canvas, context, values, field, minimum, scale };
    }

    private schedule(): void {
        if (this.disposed || this.timer !== undefined) return;
        const delay = Math.max(0, FRAME_MS - (performance.now() - this.renderedAt));
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.renderedAt = performance.now();
            this.render();
        }, delay);
    }

    private render(): void {
        const latest = this.samples[this.samples.length - 1];
        this.status.textContent = latest ? '直近10秒' : 'データ待ち';
        for (const chart of this.charts) {
            const vector = latest?.[chart.field];
            chart.values.forEach((value, axis) => {
                value.textContent = vector ? (vector[AXES[axis]] * chart.scale).toFixed(2)
                    : latest ? '未受信' : '—';
            });
            this.draw(chart);
        }
    }

    private draw(chart: Chart): void {
        const { canvas, context: ctx } = chart;
        const width = Math.max(1, canvas.getBoundingClientRect().width || 294);
        const height = CHART_HEIGHT;
        const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        const pixelsWide = Math.round(width * dpr), pixelsHigh = Math.round(height * dpr);
        if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
            canvas.width = pixelsWide;
            canvas.height = pixelsHigh;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const left = 39, top = 8, right = width - 8, bottom = height - 24;
        if (right <= left) return;
        let peak = 0;
        let received = false;
        for (const sample of this.samples) {
            const vector = sample[chart.field];
            if (!vector) continue;
            received = true;
            for (const axis of AXES) peak = Math.max(peak, Math.abs(vector[axis] * chart.scale));
        }
        const limit = axisLimit(peak, chart.minimum);
        const x = (time: number) => left + (time - (this.time - WINDOW_MS)) / WINDOW_MS * (right - left);
        const y = (value: number) => top + (1 - value / limit) * (bottom - top) / 2;
        ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
        ctx.lineWidth = 1;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const fraction of [-1, -0.5, 0, 0.5, 1]) {
            const value = limit * fraction, py = y(value);
            ctx.strokeStyle = fraction === 0 ? '#4b627b' : '#263347';
            ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
            ctx.fillStyle = '#94a7bc';
            ctx.fillText(tickLabel(value), left - 5, py);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const seconds of [-10, -7.5, -5, -2.5, 0]) {
            const px = x(this.time + seconds * 1000);
            ctx.strokeStyle = '#263347';
            ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
            ctx.fillStyle = '#94a7bc';
            ctx.fillText(`${seconds}${seconds === 0 ? 's' : ''}`, px, bottom + 7);
        }
        if (!received) {
            ctx.fillStyle = '#94a7bc';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(this.samples.length ? '未受信' : 'データ待ち', (left + right) / 2, (top + bottom) / 2);
            return;
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
        AXES.forEach((axis, index) => {
            ctx.strokeStyle = COLORS[index];
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            let previousSegment: number | null = null;
            for (const sample of this.samples) {
                const vector = sample[chart.field];
                if (!vector) { previousSegment = null; continue; }
                const px = x(sample.time), py = y(vector[axis] * chart.scale);
                if (sample.segment !== previousSegment) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
                previousSegment = sample.segment;
            }
            ctx.stroke();
            const latest = this.samples[this.samples.length - 1];
            const vector = latest?.[chart.field];
            if (latest && vector) {
                ctx.fillStyle = COLORS[index];
                ctx.beginPath(); ctx.arc(x(latest.time), y(vector[axis] * chart.scale), 2, 0, Math.PI * 2); ctx.fill();
            }
        });
        ctx.restore();
    }
}
