import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = await readFile(new URL('../src/ble.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { DiceBle } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function packet(size, sign = 1) {
    // Nonzero byteOffset also checks decoding of characteristic DataView slices.
    const dv = new DataView(new ArrayBuffer(size + 8), 8, size);
    dv.setUint8(0, 1);
    dv.setUint8(1, 2);
    dv.setUint32(2, 123456, true);
    [sign * 0.5, 0, 0, 0.8660254].forEach((v, i) => dv.setFloat32(6 + 4*i, v, true));
    if (size >= 46) [-1, 2, -3, -4, 5, -6].forEach((v, i) => dv.setFloat32(22 + 4*i, v, true));
    if (size >= 58) [7, -8, 9].forEach((v, i) => dv.setFloat32(46 + 4*i, v, true));
    if (size >= 100) {
        [-9, 10, -11].forEach((v, i) => dv.setFloat32(58 + 4*i, v, true));
        [12, -13, 14].forEach((v, i) => dv.setFloat32(70 + 4*i, v, true));
        dv.setUint8(82, 7);
        dv.setUint8(83, 3);
        [1000, -1500, 2000].forEach((v, i) => dv.setFloat32(84 + 4*i, v, true));
        dv.setUint32(96, 123450, true);
    }
    return dv;
}

function receive(dv) {
    const ble = new DiceBle();
    let result;
    ble.onSample = sample => { result = sample; };
    ble.onValueChanged({ target: { value: dv } });
    return result;
}

test('normal 46-byte packets preserve opposite signed tilts and carry IMU motion', () => {
    for (const sign of [-1, 1]) {
        const sample = receive(packet(46, sign));
        assert.equal(sample.t, 123456);
        assert.equal(sample.state, 'rest');
        assert.equal(sample.q.x, sign * 0.5);
        assert.deepEqual(sample.w, { x: -1, y: 2, z: -3 });
        assert.deepEqual(sample.a, { x: -4, y: 5, z: -6 });
        assert.deepEqual(sample.v, { x: 0, y: 0, z: 0 });
        assert.equal(sample.aLow, undefined);
        assert.equal(sample.aHigh, undefined);
    }
});

test('58-byte simulation packets include state and velocity', () => {
    const sample = receive(packet(58));
    assert.equal(sample.state, 'freefall');
    assert.deepEqual(sample.v, { x: 7, y: -8, z: 9 });
    assert.equal(sample.aHighPeak, undefined);
});

test('v3 sensor packets preserve signed low-g, high-g and notification-interval peaks', () => {
    const sample = receive(packet(100));
    assert.equal(sample.state, 'freefall');
    assert.deepEqual(sample.a, { x: -4, y: 5, z: -6 });
    assert.deepEqual(sample.aLow, { x: -9, y: 10, z: -11 });
    assert.deepEqual(sample.aHigh, { x: 12, y: -13, z: 14 });
    assert.deepEqual(sample.aHighPeak, { x: 1000, y: -1500, z: 2000 });
    assert.equal(sample.highPeakT, 123450);
    assert.equal(sample.highGSaturated, true);
    assert.deepEqual(sample.v, { x: 7, y: -8, z: 9 });
});

test('sensor validity flags leave unavailable readings undefined, never zero-filled', () => {
    for (const flags of [0, 1, 4]) {
        const dv = packet(100); dv.setUint8(82, flags);
        const sample = receive(dv);
        assert.deepEqual(sample.aLow, { x: -9, y: 10, z: -11 });
        assert.equal(sample.aHigh !== undefined, Boolean(flags & 1));
        assert.equal(sample.aHighPeak !== undefined, Boolean(flags & 4));
        assert.equal(sample.highPeakT !== undefined, Boolean(flags & 4));
        assert.equal(sample.highGSaturated, flags & 1 ? false : undefined);
    }
});

test('truncated or unrecognized sensor extensions do not fabricate high-g measurements', () => {
    for (const size of [82, 99, 100]) {
        const dv = packet(size);
        if (size === 100) dv.setUint8(83, 4);
        const sample = receive(dv);
        assert.deepEqual(sample.w, { x: -1, y: 2, z: -3 });
        assert.equal(sample.aLow, undefined);
        assert.equal(sample.aHigh, undefined);
        assert.equal(sample.aHighPeak, undefined);
        assert.equal(sample.highPeakT, undefined);
    }
});

test('22-byte legacy pose packets remain supported', () => {
    const sample = receive(packet(22, -1));
    assert.equal(sample.q.x, -0.5);
    assert.deepEqual(sample.w, { x: 0, y: 0, z: 0 });
    assert.deepEqual(sample.a, { x: 0, y: 0, z: 0 });
});

test('short notifications are ignored', () => {
    const dv = new DataView(new ArrayBuffer(21));
    dv.setUint8(0, 1);
    assert.equal(receive(dv), undefined);
});

test('first-impact v2 timestamps and throw identifiers decode without breaking legacy packets',()=>{
    for(const size of [50,58]) {
        const dv=packet(size);dv.setUint8(0,2);dv.setUint16(46,125,true);dv.setUint8(48,1);dv.setUint8(49,2);
        if(size===58) {dv.setUint32(50,123439,true);dv.setUint32(54,17,true);}
        const ble=new DiceBle();let value;ble.onImpact=v=>value=v;
        ble.onValueChanged({target:{value:dv}});
        assert.equal(value.q.x,.5);assert.deepEqual(value.w,{x:-1,y:2,z:-3});
        assert.deepEqual(value.v,{x:-4,y:5,z:-6});assert.equal(value.fallMs,125);
        assert.equal(value.preT,size===58?123439:undefined);assert.equal(value.throwId,size===58?17:undefined);
        assert.equal(value.aHighPeak, undefined);assert.equal(value.highPeakT, undefined);assert.equal(value.highGSaturated, undefined);
    }
});
test('result packets match the first impact via throw identifiers; legacy results still decode',()=>{
    for(const size of [32,36]) {
        const dv=packet(size);dv.setUint8(0,3);dv.setFloat32(22,12,true);dv.setFloat32(26,40,true);
        dv.setUint8(30,0);dv.setUint8(31,1);if(size===36) dv.setUint32(32,17,true);
        const ble=new DiceBle();let value;ble.onResult=v=>value=v;ble.onValueChanged({target:{value:dv}});
        assert.equal(value.maxW,12);assert.equal(value.maxA,40);assert.equal(value.throwId,size===36?17:undefined);
        assert.equal(value.maxHighG, undefined);assert.equal(value.highGSat, undefined);
    }
});

test('v3 impact peaks and result high-g diagnostics decode alongside unchanged pre-impact inputs', () => {
    const dv = packet(76); dv.setUint8(0, 2); dv.setUint8(1, 3);
    dv.setUint16(46, 125, true); dv.setUint8(48, 1); dv.setUint8(49, 2);
    dv.setUint32(50, 123439, true); dv.setUint32(54, 17, true);
    [1000, -1500, 2000].forEach((v, i) => dv.setFloat32(58 + 4*i, v, true));
    dv.setUint32(70, 123453, true); dv.setUint8(74, 1);
    const ble = new DiceBle(); let impact; ble.onImpact = v => { impact = v; };
    ble.onValueChanged({ target: { value: dv } });
    assert.deepEqual(impact.w, { x: -1, y: 2, z: -3 });
    assert.deepEqual(impact.v, { x: -4, y: 5, z: -6 });
    assert.deepEqual(impact.aHighPeak, { x: 1000, y: -1500, z: 2000 });
    assert.equal(impact.highPeakT, 123453); assert.equal(impact.highGSaturated, true);
    assert.equal(impact.preT, 123439); assert.equal(impact.throwId, 17);
    const resultDv = packet(44); resultDv.setUint8(0, 3); resultDv.setUint8(1, 3);
    resultDv.setFloat32(22, 12, true); resultDv.setFloat32(26, 40, true);
    resultDv.setUint8(30, 0); resultDv.setUint8(31, 1); resultDv.setUint32(32, 17, true);
    resultDv.setFloat32(36, 2900, true); resultDv.setUint8(40, 4);
    let result; ble.onResult = v => { result = v; };
    ble.onValueChanged({ target: { value: resultDv } });
    assert.equal(result.maxA, 40); assert.equal(result.maxHighG, 2900);
    assert.equal(result.highGSat, 4); assert.equal(result.throwId, 17);
    dv.setUint8(1, 2); ble.onValueChanged({ target: { value: dv } });
    assert.equal(impact.aHighPeak, undefined);
    resultDv.setUint8(1, 2); ble.onValueChanged({ target: { value: resultDv } });
    assert.equal(result.maxHighG, undefined);
});

test('IMU charts display missing sensors honestly and retain the signed high-g interval peak', async () => {
    const chartSource = await readFile(new URL('../src/motion-chart.ts', import.meta.url), 'utf8');
    const chartModule = ts.transpileModule(chartSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    const { MotionCharts } = await import(`data:text/javascript;base64,${Buffer.from(chartModule.outputText).toString('base64')}`);
    class Element {
        style = {}; children = []; textContent = ''; width = 0; height = 0;
        constructor() {
            this.contextCalls = [];
            this.context = new Proxy({}, { get: (target, key) => target[key] ?? ((...args) => this.contextCalls.push([key, ...args])) });
        }
        append(...children) { this.children.push(...children); }
        appendChild(child) { this.children.push(child); return child; }
        setAttribute() {}
        getContext() { return this.context; }
        getBoundingClientRect() { return { width: 294 }; }
        remove() {}
    }
    const previous = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
    globalThis.document = { createElement: () => new Element() };
    globalThis.window = { devicePixelRatio: 1 };
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    let charts;
    try {
        charts = new MotionCharts(new Element());
        assert.equal(charts.charts.length, 4);
        charts.add(receive(packet(58)));
        charts.render();
        for (const chart of charts.charts.filter(c => c.field === 'aLow' || c.field === 'aHigh')) {
            assert.deepEqual(chart.values.map(v => v.textContent), ['未受信', '未受信', '未受信']);
            assert.equal(chart.canvas.contextCalls.filter(c => c[0] === 'arc').length, 0);
        }
        const sample = receive(packet(100)); sample.t++;
        charts.add(sample); charts.render();
        const high = charts.charts.find(c => c.field === 'aHigh');
        assert.deepEqual(charts.samples.at(-1).aHigh, sample.aHighPeak);
        assert.deepEqual(high.values.map(v => v.textContent), [1000, -1500, 2000].map(v => (v / 9.80665).toFixed(2)));
        assert.equal(high.canvas.contextCalls.filter(c => c[0] === 'arc').length, 3);
        const legacy = receive(packet(58)); legacy.t += 2;
        charts.add(legacy); charts.render();
        assert.deepEqual(high.values.map(v => v.textContent), ['未受信', '未受信', '未受信']);
    } finally {
        charts?.dispose();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
});
