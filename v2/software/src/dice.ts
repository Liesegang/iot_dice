import * as THREE from 'three';
import type { Vec3 } from './ble';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

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

    private trail = new Line2(new LineGeometry(), new LineMaterial({color:0x46dfc5,linewidth:4,depthTest:false}));
    private origin = new THREE.Mesh(new THREE.SphereGeometry(.08), new THREE.MeshBasicMaterial({color:0xe8a030}));
    private grid = new THREE.GridHelper(20,20,0x31465e,0x182437);
    private trajectoryEnabled = false;

    private faceMaterials: THREE.Material[];

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
        this.faceMaterials=mats;
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
            this.trail.material.resolution.set(container.clientWidth,container.clientHeight);
        });
        ro.observe(container);

        this.trail.material.resolution.set(container.clientWidth,container.clientHeight);
        this.trail.renderOrder=1;
        this.scene.add(this.trail, this.origin, this.grid);
        this.trail.visible=this.origin.visible=this.grid.visible=false;
        this.animate();
    }

    /**
     * Feed the IMU body-to-world quaternion.
     * IMU world frame: X/Y horizontal, Z up, arbitrary yaw.
     * Three.js world frame: right=X, up=Y, toward-viewer=Z.
     * Mapping: imu(x,y,z,w) → three(x,z,-y,w)
     */
    setQuaternion(x: number, y: number, z: number, w: number): void {
        this.live = true;
        this.targetQuat.set(x, z, -y, w).normalize();
    }

    setTrajectoryEnabled(enabled:boolean):void {
        this.trajectoryEnabled=enabled;
        this.trail.visible=this.origin.visible=this.grid.visible=false;
        this.mesh.scale.setScalar(enabled ? .15 : 1);
        if(!enabled) {this.pivot.position.set(0,0,0);this.camera.position.set(0,0,5.5);this.camera.lookAt(0,0,0);}
        else this.setTrajectory([], {x:0,y:0,z:0});
    }

    setTrajectory(points:Vec3[], position:Vec3):void {
        if(!this.trajectoryEnabled) return;
        // Same right-handed frame conversion as the live quaternion. 1 m = 20 scene units.
        const map=(p:Vec3)=>new THREE.Vector3(p.x*20,p.z*20,-p.y*20);
        const vertices=points.map(map);
        this.trail.visible=points.length>1;this.origin.visible=points.length>0;this.grid.visible=points.length>0;
        this.mesh.scale.setScalar(points.length ? .15 : 1);
        if(!points.length) {
            this.pivot.position.set(0,0,0);this.camera.position.set(3,3,5.5);this.camera.lookAt(0,0,0);return;
        }
        const geometry=new LineGeometry();
        geometry.setPositions((vertices.length>1?vertices:[new THREE.Vector3(),new THREE.Vector3()]).flatMap(v=>[v.x,v.y,v.z]));
        this.trail.geometry.dispose();this.trail.geometry=geometry;
        this.pivot.position.copy(map(position));
        const bounds=new THREE.Box3().setFromPoints([new THREE.Vector3(),...vertices]);
        const center=bounds.getCenter(new THREE.Vector3());
        const radius=Math.max(2,bounds.getSize(new THREE.Vector3()).length()/2+.4);
        const distance=radius/Math.sin(THREE.MathUtils.degToRad(this.camera.fov/2))/Math.min(1,this.camera.aspect);
        this.camera.position.copy(center).add(new THREE.Vector3(.6,.5,1).normalize().multiplyScalar(distance));
        this.camera.far=Math.max(100,distance*4);this.camera.updateProjectionMatrix();this.camera.lookAt(center);
        this.scene.fog=null;
    }

    setMirroredFaces(mirrored:boolean):void {
        const materials=[...this.faceMaterials];
        if(mirrored) [materials[2],materials[3]]=[materials[3],materials[2]];
        this.mesh.material=materials;
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
