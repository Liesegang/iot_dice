import type { ImpactPacket, ResultPacket, StreamSample } from './ble';

/*
 * Throw recorder — every throw yields a free labeled sample:
 * (pre-impact state → actual face). This is the training set for offline
 * physics-parameter identification, so record everything, including the
 * post-impact orientation stream (lets the fit use the whole tumble
 * trajectory, not just the 6-valued final outcome).
 */

export interface ThrowRecord {
    ts: string;                    // wall-clock ISO time
    impact: ImpactPacket;
    result: ResultPacket;
    actualFace: number;
    predictedFace: number | null;
    predictedDist: number[] | null;
    stream: StreamSample[];        // ~release → rest window
}

const DB_NAME    = 'dice-throws';
const STORE_NAME = 'throws';

export class ThrowStore {
    private db: IDBDatabase | null = null;

    async open(): Promise<void> {
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(STORE_NAME, { autoIncrement: true });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async add(rec: ThrowRecord): Promise<void> {
        if (!this.db) return;
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).add(rec);
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    async count(): Promise<number> {
        if (!this.db) return 0;
        return new Promise((resolve, reject) => {
            const req = this.db!
                .transaction(STORE_NAME, 'readonly')
                .objectStore(STORE_NAME).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async all(): Promise<ThrowRecord[]> {
        if (!this.db) return [];
        return new Promise((resolve, reject) => {
            const req = this.db!
                .transaction(STORE_NAME, 'readonly')
                .objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result as ThrowRecord[]);
            req.onerror   = () => reject(req.error);
        });
    }

    /** Download every recorded throw as a JSON file. */
    async exportJson(): Promise<void> {
        const records = await this.all();
        const blob = new Blob([JSON.stringify(records)],
                              { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dice-throws-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }
}
