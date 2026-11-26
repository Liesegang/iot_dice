import * as THREE from 'three';

/* Standard dice: opposite faces sum to 7 */
const FACE_NUMBERS: number[] = [3, 4, 1, 6, 2, 5]; // +X,-X,+Y,-Y,+Z,-Z

const DOT_POS: Record<number, [number, number][]> = {
    1: [[0.5, 0.5]],
    2: [[0.27, 0.27], [0.73, 0.73]],
    3: [[0.27, 0.27], [0.50, 0.50], [0.73, 0.73]],
    4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
    5: [[0.27, 0.27], [0.73, 0.27], [0.50, 0.50], [0.27, 0.73], [0.73, 0.73]],
    6: [[0.27, 0.22], [0.73, 0.22], [0.27, 0.50], [0.73, 0.50], [0.27, 0.78], [0.73, 0.78]],
};

function buildFaceTexture(n: number): THREE.CanvasTexture {
    const SIZE = 256;
    const R    = 28; // corner radius

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;

    /* ivory background with rounded corners */
    ctx.fillStyle = '#f4f0e8';
    ctx.beginPath();
    ctx.moveTo(R, 0);
    ctx.lineTo(SIZE - R, 0); ctx.quadraticCurveTo(SIZE, 0, SIZE, R);
    ctx.lineTo(SIZE, SIZE - R); ctx.quadraticCurveTo(SIZE, SIZE, SIZE - R, SIZE);
    ctx.lineTo(R, SIZE); ctx.quadraticCurveTo(0, SIZE, 0, SIZE - R);
    ctx.lineTo(0, R); ctx.quadraticCurveTo(0, 0, R, 0);
    ctx.closePath();
    ctx.fill();

    /* subtle border */
    ctx.strokeStyle = '#d8d0c0';
    ctx.lineWidth = 4;
    ctx.stroke();

    /* dots */
    const dotR = SIZE * 0.082;
    ctx.fillStyle = '#18183a';
    for (const [fx, fy] of DOT_POS[n]) {
        ctx.beginPath();
        ctx.arc(fx * SIZE, fy * SIZE, dotR, 0, Math.PI * 2);
        ctx.fill();
    }

    return new THREE.CanvasTexture(canvas);
}

export class DiceScene {
    private renderer: THREE.WebGLRenderer;
    private scene:    THREE.Scene;
    private camera:   THREE.PerspectiveCamera;
    private pivot:    THREE.Group;  // carries sensor quaternion
    private mesh:     THREE.Mesh;

    private targetQuat = new THREE.Quaternion();
    private live       = false;
    private idleT      = 0;

    constructor(container: HTMLElement) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(devicePixelRatio);
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0d0d1a);
        this.scene.fog        = new THREE.FogExp2(0x0d0d1a, 0.055);

        this.camera = new THREE.PerspectiveCamera(
            45, container.clientWidth / container.clientHeight, 0.1, 100,
        );
        this.camera.position.set(0, 0, 5.5);

        this.addLights();
        this.addFloor();

        const mats = FACE_NUMBERS.map(n =>
            new THREE.MeshLambertMaterial({ map: buildFaceTexture(n) }));
        this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
        this.mesh.castShadow = true;
        /* Fixed 180° Y offset: swaps +Z (front) and -Z (back) faces
           without affecting how sensor rotation tracks the mesh. */
        this.mesh.rotation.y = Math.PI;

        this.pivot = new THREE.Group();
        this.pivot.add(this.mesh);
        this.scene.add(this.pivot);

        const ro = new ResizeObserver(() => {
            this.camera.aspect = container.clientWidth / container.clientHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(container.clientWidth, container.clientHeight);
        });
        ro.observe(container);

        this.animate();
    }

    /**
     * Feed a raw quaternion from the BNO085.
     * BNO085 ROTATION_VECTOR world frame: ENU (East=X, North=Y, Up=Z).
     * Three.js world frame: right=X, up=Y, toward-viewer=Z.
     * Mapping: bno(x,y,z,w) → three(x,z,-y,w)
     */
    setQuaternion(x: number, y: number, z: number, w: number): void {
        this.live = true;
        this.targetQuat.set(x, z, -y, w).normalize();
    }

    private addLights(): void {
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));

        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(5, 8, 5);
        key.castShadow = true;
        this.scene.add(key);

        const fill = new THREE.DirectionalLight(0x3366cc, 0.45);
        fill.position.set(-4, 2, 3);
        this.scene.add(fill);
    }

    private addFloor(): void {
        const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(20, 20),
            new THREE.ShadowMaterial({ opacity: 0.18 }),
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -2.2;
        floor.receiveShadow = true;
        this.scene.add(floor);
    }

    private animate = (): void => {
        requestAnimationFrame(this.animate);

        if (this.live) {
            this.pivot.quaternion.slerp(this.targetQuat, 0.12);
        } else {
            this.idleT += 0.005;
            this.pivot.rotation.set(
                Math.sin(this.idleT * 0.7)  * 0.35,
                this.idleT,
                Math.cos(this.idleT * 0.53) * 0.28,
            );
        }

        this.renderer.render(this.scene, this.camera);
    };
}
