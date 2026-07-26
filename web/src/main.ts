import { DiceBle, type ImpactPacket, type StreamSample } from './ble';
import { DiceScene } from './dice';
import { FaceMap } from './faces';
import { DicePredictor, type Prediction } from './predict';
import { ThrowStore } from './record';

/* ── DOM ────────────────────────────────────────────────────────────────── */

const container  = document.getElementById('app')!;
const btnConnect = document.getElementById('connect-btn') as HTMLButtonElement;
const btnSimulation = document.getElementById('simulation-btn') as HTMLButtonElement;
const btnCalib   = document.getElementById('calib-btn') as HTMLButtonElement;
const btnExport  = document.getElementById('export-btn') as HTMLButtonElement;
const elStatus   = document.getElementById('status')!;
const elState    = document.getElementById('state')!;
const elOmega    = document.getElementById('omega')!;
const elStats    = document.getElementById('stats')!;
const elPred     = document.getElementById('prediction')!;
const elPredFace = document.getElementById('pred-face')!;
const elPredLabel = document.getElementById('pred-label')!;
const elDist     = document.getElementById('dist')!;
const calibPanel = document.getElementById('calib-panel')!;
const calibFaces = document.getElementById('calib-faces')!;
const btnCalibReset = document.getElementById('calib-reset') as HTMLButtonElement;

/* ── instances ──────────────────────────────────────────────────────────── */

const ble       = new DiceBle();
const scene     = new DiceScene(container);
const faceMap   = new FaceMap();
const predictor = new DicePredictor();
const store     = new ThrowStore();

store.open().then(() => refreshStats());

/* ── per-throw working state ────────────────────────────────────────────── */

const STREAM_BUF_MS = 8000;
let streamBuf: StreamSample[] = [];
let latest: StreamSample | null = null;
let pendingImpact: ImpactPacket | null = null;
let pendingPrediction: Prediction | null = null;
let simulationEnabled = false;
let predictorReady = false;

const STATE_LABEL: Record<string, string> = {
    rest: '静止', moving: '移動', freefall: '落下', tumbling: '転がり',
};

/* ── accuracy bookkeeping (persisted) ───────────────────────────────────── */

const ACC_KEY = 'dice-pred-accuracy-v1';
let acc = { hit: 0, total: 0 };
try { acc = { ...acc, ...JSON.parse(localStorage.getItem(ACC_KEY) ?? '{}') }; }
catch { /* keep defaults */ }

async function refreshStats(): Promise<void> {
    const n = await store.count();
    const rate = acc.total > 0 ? ` 的中 ${acc.hit}/${acc.total}` : '';
    elStats.textContent = `記録 ${n}投${rate}`;
}

/* ── distribution bars ──────────────────────────────────────────────────── */

const distBars: HTMLDivElement[] = [];
for (let f = 1; f <= 6; f++) {
    const col = document.createElement('div');
    col.className = 'dist-col';
    const bar = document.createElement('div');
    bar.className = 'dist-bar';
    const num = document.createElement('div');
    num.className = 'dist-num';
    num.textContent = String(f);
    col.append(bar, num);
    elDist.appendChild(col);
    distBars.push(bar);
}

function showDist(dist: number[] | null): void {
    for (let i = 0; i < 6; i++) {
        distBars[i].style.height = dist ? `${Math.round(dist[i] * 44) + 1}px` : '1px';
    }
}

function showPrediction(pred: Prediction): void {
    elPredFace.textContent = String(pred.face);
    elPredFace.className = pred.degraded ? 'degraded' : 'uncertain';
    const pct = Math.round(pred.probability * 100);
    elPredLabel.textContent = pred.degraded
        ? `予測 (${pct}%) ⚠ジャイロ飽和`
        : `予測 (${pct}%)`;
    showDist(pred.dist);
    elPred.classList.add('visible');
}

function showActual(face: number, hit: boolean | null): void {
    elPredFace.textContent = String(face);
    elPredFace.classList.remove('locked');
    void (elPredFace as HTMLElement).offsetWidth;  // restart pop animation
    elPredFace.className = 'locked';
    elPredLabel.textContent =
        hit === null ? '確定' : hit ? '確定 — 的中!' : '確定 — はずれ';
    elPred.classList.add('visible');
}

/* ── BLE → scene / buffers ──────────────────────────────────────────────── */

ble.onSample = (s) => {
    latest = s;
    scene.setQuaternion(s.q.x, s.q.y, s.q.z, s.q.w);

    if (simulationEnabled) {
        streamBuf.push(s);
        const cutoff = s.t - STREAM_BUF_MS;
        while (streamBuf.length > 1 && streamBuf[0].t < cutoff) streamBuf.shift();
    }

    const omega = Math.hypot(s.w.x, s.w.y, s.w.z);
    elOmega.textContent = omega > 0.1 ? `ω ${omega.toFixed(2)} rad/s` : '';
    elState.textContent = STATE_LABEL[s.state] ?? s.state;
};

/* ── impact → run Monte Carlo prediction ────────────────────────────────── */

ble.onImpact = (impact) => {
    if (!simulationEnabled || !predictorReady) return;
    pendingImpact = impact;
    pendingPrediction = predictor.predict(impact, faceMap);
    if (pendingPrediction) {
        console.info(
            `[predict] face=${pendingPrediction.face}`
            + ` p=${pendingPrediction.probability.toFixed(2)}`
            + ` sim=${pendingPrediction.simMs.toFixed(0)}ms`
            + ` fall=${impact.fallMs}ms sat=${impact.gyroSat}/${impact.accSat}`,
        );
        showPrediction(pendingPrediction);
    }
};

/* ── result → label, score, record ──────────────────────────────────────── */

ble.onResult = async (result) => {
    if (!simulationEnabled) return;
    const actual = faceMap.faceFromQuat(result.q);

    let hit: boolean | null = null;
    if (pendingPrediction) {
        hit = pendingPrediction.face === actual;
        acc.total++;
        if (hit) acc.hit++;
        localStorage.setItem(ACC_KEY, JSON.stringify(acc));
    }
    showActual(actual, hit);

    if (pendingImpact) {
        // keep the window from just before release through rest
        const from = pendingImpact.t - 2000;
        await store.add({
            ts: new Date().toISOString(),
            impact: pendingImpact,
            result,
            actualFace: actual,
            predictedFace: pendingPrediction?.face ?? null,
            predictedDist: pendingPrediction?.dist ?? null,
            stream: streamBuf.filter(s => s.t >= from),
        });
    }
    pendingImpact = null;
    pendingPrediction = null;
    refreshStats();

    setTimeout(() => {
        elPred.classList.remove('visible');
        showDist(null);
    }, 4000);
};

/* ── connection ─────────────────────────────────────────────────────────── */

ble.onStatusChange = (status) => {
    elStatus.textContent   = status;
    btnConnect.textContent = ble.connected ? '切断' : '🎲 サイコロを接続';
    btnConnect.disabled    = false;
};

btnConnect.addEventListener('click', async () => {
    if (ble.connected) {
        ble.disconnect();
        return;
    }
    btnConnect.disabled  = true;
    elStatus.textContent = 'スキャン中...';
    try {
        await ble.connect();
        await ble.setSimulationEnabled(simulationEnabled);
        elStatus.textContent = simulationEnabled
            ? '接続中（シミュレーション）'
            : '接続中（姿勢のみ・50 Hz）';
    } catch (e) {
        elStatus.textContent = `エラー: ${(e as Error).message}`;
        btnConnect.disabled  = false;
    }
});

btnSimulation.addEventListener('click', async () => {
    simulationEnabled = !simulationEnabled;
    btnSimulation.textContent =
        `シミュレーション ${simulationEnabled ? 'ON' : 'OFF'}`;
    btnSimulation.classList.toggle('done', simulationEnabled);

    if (simulationEnabled && !predictorReady) {
        elStatus.textContent = 'シミュレーションを準備中...';
        await predictor.init();
        predictorReady = true;
    }

    streamBuf = [];
    pendingImpact = null;
    pendingPrediction = null;
    elPred.classList.remove('visible');
    await ble.setSimulationEnabled(simulationEnabled);
    elStatus.textContent = ble.connected
        ? (simulationEnabled ? '接続中（シミュレーション）' : '接続中（姿勢のみ・50 Hz）')
        : (simulationEnabled ? '未接続（シミュレーション）' : '未接続');
});

/* ── face calibration UI ────────────────────────────────────────────────── */

const calibDone = new Set<number>();
for (let f = 1; f <= 6; f++) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = String(f);
    b.addEventListener('click', () => {
        if (!latest) return;
        faceMap.calibrate(f, latest.q);
        calibDone.add(f);
        b.classList.add('done');
        if (calibDone.size === 6) elStatus.textContent = '面校正 完了';
    });
    calibFaces.appendChild(b);
}

btnCalib.addEventListener('click', () => calibPanel.classList.toggle('open'));

btnCalibReset.addEventListener('click', () => {
    faceMap.resetCalibration();
    calibDone.clear();
    calibFaces.querySelectorAll('button').forEach(b => b.classList.remove('done'));
});

/* ── export ─────────────────────────────────────────────────────────────── */

btnExport.addEventListener('click', () => store.exportJson());
