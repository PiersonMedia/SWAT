// Game State
const gameState = {
    mode: null,
    phase: 'menu', // menu, briefing, deployment, active, exfil, complete
    health: 100,
    ammo: 30,
    maxAmmo: 30,
    reserveAmmo: 120,
    equipment: {
        flashbangs: 3,
        smoke: 2,
        c2: 2,
        tearGas: 2,
        pepperSpray: 100
    },
    currentWeapon: 0,
    weapons: [
        { name: 'M4A1 CARBINE', ammo: 30, maxAmmo: 30, reserve: 120, damage: 35, fireRate: 0.1, auto: true },
        { name: 'GLOCK 17', ammo: 17, maxAmmo: 17, reserve: 51, damage: 25, fireRate: 0.15, auto: false },
    ],
    stance: 'standing', // standing, crouching, prone
    leaning: 0, // -1 left, 0 center, 1 right
    isAiming: false,
    isSprinting: false,
    isReloading: false,
    hostagesRescued: 0,
    hostagesTotal: 3,
    suspectsNeutralized: 0,
    suspectsTotal: 8,
    civiliansHarmed: 0,
    missionTime: 0,
    score: 0
};

// Three.js Setup
let scene, camera, renderer;
let player = { x: -6.0, y: 1.7, z: -15.8 };
let playerVelocity = { x: 0, y: 0, z: 0 };
let yaw = 0, pitch = 0;
let keys = {};
let mouseDown = false;
let lastShot = 0;
let entities = [];
let doors = [];
let interactables = [];
let bullets = [];
let effects = [];

// -------------------------------
// Collision (solids / blockers)
// -------------------------------
// Lightweight player-vs-AABB collision in XZ, with vertical overlap check.
const solids = []; // { obj, box: THREE.Box3, enabled: true }
const _tmpBox = new THREE.Box3();
const _tmpV3 = new THREE.Vector3();

const PLAYER_RADIUS = 0.35;
const PLAYER_HEIGHT = 1.6;

function addSolid(obj) {
    if (!obj) return;
    solids.push({ obj, box: new THREE.Box3(), enabled: true });
}

function removeSolid(obj) {
    const idx = solids.findIndex(s => s.obj === obj);
    if (idx !== -1) solids.splice(idx, 1);
}

function rebuildSolids() {
    solids.length = 0;
    // Add all static blockers: walls, cover, barriers, van body, CLOSED doors
    entities.forEach(e => {
        if (!e) return;
        if (e.userData && (e.userData.isWall || e.userData.isCover || e.userData.isBarrier || e.userData.isVan)) {
            addSolid(e);
        }
    });
    doors.forEach(d => {
        if (!d) return;
        if (d.userData && d.userData.isDoor && !d.userData.isOpen && !d.userData.isBreached) {
            addSolid(d);
        }
    });
    updateSolids();
}

function updateSolids() {
    for (const s of solids) {
        s.box.setFromObject(s.obj);
    }
}

function playerCollidesAt(nx, ny, nz) {
    // player capsule simplified to cylinder in XZ + vertical overlap
    const pMinY = ny - (PLAYER_HEIGHT * 0.5);
    const pMaxY = ny + (PLAYER_HEIGHT * 0.5);

    for (const s of solids) {
        const b = s.box;

        // Vertical overlap check
        if (pMaxY < b.min.y || pMinY > b.max.y) continue;

        // XZ circle vs expanded AABB
        const minX = b.min.x - PLAYER_RADIUS;
        const maxX = b.max.x + PLAYER_RADIUS;
        const minZ = b.min.z - PLAYER_RADIUS;
        const maxZ = b.max.z + PLAYER_RADIUS;

        if (nx >= minX && nx <= maxX && nz >= minZ && nz <= maxZ) {
            return true;
        }
    }
    return false;
}


// Ensure the player never starts inside a solid (prevents "spawn stuck")
function ensurePlayerNotStuck() {
    updateSolids();
    if (!playerCollidesAt(player.x, player.y, player.z)) return;

    const startX = player.x;
    const startZ = player.z;

    // Spiral search around the spawn to find the nearest free spot
    const maxR = 8;
    const stepR = 0.5;
    const stepA = Math.PI / 12;

    for (let r = 0; r <= maxR; r += stepR) {
        for (let a = 0; a < Math.PI * 2; a += stepA) {
            const nx = startX + Math.cos(a) * r;
            const nz = startZ + Math.sin(a) * r;
            if (!playerCollidesAt(nx, player.y, nz)) {
                player.x = nx;
                player.z = nz;
                return;
            }
        }
    }

    // If somehow still stuck, fall back to a known safe open area
    player.x = 0;
    player.z = 8;
}

// Enemy line-of-sight (prevents getting shot through walls)
const _losRaycaster = new THREE.Raycaster();
const _losDir = new THREE.Vector3();
const _losFrom = new THREE.Vector3();
const _losTo = new THREE.Vector3();

function enemyHasLineOfSight(enemy) {
    // Raycast against current solid blockers only (walls/cover/barriers/van/closed doors)
    updateSolids();
    const blockers = solids.map(s => s.obj);

    _losFrom.copy(enemy.position);
    _losFrom.y += 1.1; // enemy "eye" height

    _losTo.copy(camera.position); // player's camera = "eyes"

    _losDir.subVectors(_losTo, _losFrom);
    const dist = _losDir.length();
    if (dist < 0.001) return true;

    _losDir.normalize();
    _losRaycaster.set(_losFrom, _losDir);
    _losRaycaster.far = Math.max(0, dist - 0.25); // stop just short of player

    const hits = _losRaycaster.intersectObjects(blockers, true);
    return hits.length === 0;
}


function enemyGunHasLineOfSight(enemy) {
    // LOS from muzzle to player camera (used for "are they actively aiming at me?")
    updateSolids();
    const blockers = solids.map(s => s.obj);

    if (!enemy.userData.muzzle) return enemyHasLineOfSight(enemy);

    const muzzleWorld = new THREE.Vector3();
    enemy.userData.muzzle.getWorldPosition(muzzleWorld);

    _losFrom.copy(muzzleWorld);
    _losTo.copy(camera.position);

    _losDir.subVectors(_losTo, _losFrom);
    const dist = _losDir.length();
    if (dist < 0.001) return true;

    _losDir.normalize();
    _losRaycaster.set(_losFrom, _losDir);
    _losRaycaster.far = Math.max(0, dist - 0.2);

    const hits = _losRaycaster.intersectObjects(blockers, true);
    return hits.length === 0;
}


// Initialize
function init() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    scene.fog = new THREE.Fog(0x0a0c10, 8, 60);

    // Camera (First Person)
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(player.x, player.y, player.z);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);

    // More "game-like" output (filmic tonemapping + correct color)
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.physicallyCorrectLights = true;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    document.getElementById('game-container').appendChild(renderer.domElement);

    // Build procedural textures (for more realistic surfaces)
    buildTextures();

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
    mainLight.position.set(10, 20, 10);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    scene.add(mainLight);

    // Add some point lights for atmosphere
    const redLight = new THREE.PointLight(0xff3333, 0.5, 20);
    redLight.position.set(-5, 3, 0);
    scene.add(redLight);

    const blueLight = new THREE.PointLight(0x3333ff, 0.5, 20);
    blueLight.position.set(5, 3, 0);
    scene.add(blueLight);

    // Event Listeners
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('wheel', onWheel);
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('contextmenu', e => e.preventDefault());

    // Hide loading, show menu
    setTimeout(() => {
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('menu-screen').classList.remove('hidden');
    }, 2000);

    animate();
}


// -------------------------------
// Procedural textures (single-file)
// -------------------------------
let TEX = {};

function makeNoiseCanvas(size, fn) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const v = fn(x, y);
            img.data[i + 0] = v[0];
            img.data[i + 1] = v[1];
            img.data[i + 2] = v[2];
            img.data[i + 3] = v[3] ?? 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

function hash2(x, y) {
    // deterministic pseudo-random [0,1)
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return s - Math.floor(s);
}

function fbm(x, y) {
    // simple fractal noise (0..1)
    let v = 0;
    let a = 0.5;
    let f = 1;
    for (let o = 0; o < 4; o++) {
        v += a * hash2(Math.floor(x * f), Math.floor(y * f));
        a *= 0.5;
        f *= 2;
    }
    return Math.min(1, Math.max(0, v));
}

function buildTextures() {
    const size = 256;

    // Concrete (walls)
    const concrete = makeNoiseCanvas(size, (x, y) => {
        const nx = x / size, ny = y / size;
        const n = fbm(nx * 12, ny * 12);
        const stains = fbm(nx * 3.5 + 10.2, ny * 3.5 + 4.7);
        const grit = fbm(nx * 40.0, ny * 40.0);
        let base = 120 + n * 40;
        base -= stains * 25;
        base += grit * 18;
        base = Math.max(60, Math.min(200, base));
        return [base, base, base, 255];
    });

    const wallTex = new THREE.CanvasTexture(concrete);
    wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
    wallTex.repeat.set(2.5, 1.5);
    wallTex.anisotropy = 8;

    const wallBump = new THREE.CanvasTexture(concrete);
    wallBump.wrapS = wallBump.wrapT = THREE.RepeatWrapping;
    wallBump.repeat.copy(wallTex.repeat);

    // Asphalt / dirty floor
    const asphalt = makeNoiseCanvas(size, (x, y) => {
        const nx = x / size, ny = y / size;
        const n = fbm(nx * 10, ny * 10);
        const speck = fbm(nx * 70, ny * 70);
        const cracks = fbm(nx * 2.2 + 3.3, ny * 2.2 + 9.1);
        let base = 40 + n * 55;
        base += speck * 35;
        base -= cracks * 10;
        base = Math.max(18, Math.min(140, base));
        return [base, base, base, 255];
    });

    const floorTex = new THREE.CanvasTexture(asphalt);
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(12, 12);
    floorTex.anisotropy = 8;

    const floorBump = new THREE.CanvasTexture(asphalt);
    floorBump.wrapS = floorBump.wrapT = THREE.RepeatWrapping;
    floorBump.repeat.copy(floorTex.repeat);

    // Subtle metal panel (props)
    const metal = makeNoiseCanvas(size, (x, y) => {
        const nx = x / size, ny = y / size;
        const n = fbm(nx * 16, ny * 16);
        const lines = (Math.sin((ny * 80) * Math.PI * 2) * 0.5 + 0.5) * 18;
        let base = 110 + n * 40 + lines;
        base = Math.max(70, Math.min(210, base));
        return [base, base, base, 255];
    });

    const metalTex = new THREE.CanvasTexture(metal);
    metalTex.wrapS = metalTex.wrapT = THREE.RepeatWrapping;
    metalTex.repeat.set(2, 2);
    metalTex.anisotropy = 8;

    TEX = { wallTex, wallBump, floorTex, floorBump, metalTex };
}
// Create Environment based on mission
function createEnvironment(missionType) {
    // Clear existing
    while(scene.children.length > 0) { 
        scene.remove(scene.children[0]); 
    }
    entities = [];
    doors = [];
    interactables = [];

    // Re-add lights
    const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
    mainLight.position.set(10, 20, 10);
    mainLight.castShadow = true;
    scene.add(mainLight);

    // Ground
    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.MeshStandardMaterial({ 
        map: TEX.floorTex,
        bumpMap: TEX.floorBump,
        bumpScale: 0.03,
        color: 0xffffff,
        roughness: 0.95,
        metalness: 0.02
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    if (missionType === 'hostage') {
        // Gas station map lives in createShootHouse() in this build
        createShootHouse();
    } else {
        // Failsafe: always load the same gas station map
        createShootHouse();
    }

    // SWAT Van at spawn
    createSWATVan();

    // Build collision blockers (walls/cover/barriers/closed doors)
    rebuildSolids();
}

// Create Building Structure
function createBuilding() {
    const wallMat = new THREE.MeshStandardMaterial({
        map: TEX.wallTex,
        bumpMap: TEX.wallBump,
        bumpScale: 0.02,
        color: 0xffffff,
        roughness: 0.88,
        metalness: 0.02
    });

    const trimMat = new THREE.MeshStandardMaterial({
        map: TEX.metalTex,
        color: 0xffffff,
        roughness: 0.55,
        metalness: 0.35
    });

    const doorFrameMat = new THREE.MeshStandardMaterial({
        color: 0x2b2b2b,
        roughness: 0.7,
        metalness: 0.15
    });

// Main building shell
    const buildingWidth = 30;
    const buildingDepth = 25;
    const wallHeight = 4;

    // Outer walls (with a real entrance opening)
    createWall(-buildingWidth/2, 0, 0, 0.5, wallHeight, buildingDepth, wallMat);
    createWall(buildingWidth/2, 0, 0, 0.5, wallHeight, buildingDepth, wallMat);
    createWall(0, 0, buildingDepth/2, buildingWidth, wallHeight, 0.5, wallMat);

    // Front wall with doorway at center (so the door actually matters)
    createWallWithDoorwayX(
        0, 0, -buildingDepth/2,
        buildingWidth, wallHeight, 0.5,
        0, 2.2, // doorway centered at x=0, width ~door+clearance
        wallMat, trimMat
    );

    // Ceiling (dark, with fixtures)
    createCeiling(0, wallHeight, 0, buildingWidth, buildingDepth);

    // Interior walls (split so doors are real openings)
    // Left/right partitions with centered doorways
    createWallWithDoorwayZ(-8, 0, 0, 0.3, wallHeight, 18, 0, 2.2, wallMat, trimMat);
    createWallWithDoorwayZ(8, 0, 0, 0.3, wallHeight, 18, 0, 2.2, wallMat, trimMat);

    // Back room divider
    createWall(0, 0, 5, 16.0, wallHeight, 0.3, wallMat); // widened to eliminate corner seam gaps

    // Doors (hinged pivots)
    createDoor(-8, 0, 0, 0);
    createDoor(8, 0, 0, 0);
    createDoor(0, 0, -buildingDepth/2 + 0.26, Math.PI);

    // Interior lighting (gives “Ready or Not” vibe: pools of light + contrast)
    createCeilingLight(-10, wallHeight - 0.2, -6);
    createCeilingLight(10, wallHeight - 0.2, -6);
    createCeilingLight(0, wallHeight - 0.2, 6);

    // Furniture/Cover
    createCover(-12, 0, -8, 2, 1, 1); // Desk
    createCover(12, 0, -8, 2, 1, 1);
    createCover(0, 0, 8, 3, 0.5, 1.5); // Table
    createCover(-5, 0, 3, 1, 1.5, 0.3); // Filing cabinet
    createCover(5, 0, 3, 1, 1.5, 0.3);

    // Hostages (for hostage rescue)
    if (gameState.mode === 'hostage') {
        createHostage(-10, 0, -10);
        createHostage(10, 0, -10);
        createHostage(0, 0, 10);
    }

    // Enemies
    createEnemy(-5, 0, -8);
    createEnemy(5, 0, -8);
    createEnemy(-10, 0, 5);
    createEnemy(10, 0, 5);
    createEnemy(0, 0, -5);
}

function createWall(x, y, z, w, h, d, material) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const wall = new THREE.Mesh(geo, material);
    wall.position.set(x, y + h/2, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    wall.userData.isWall = true;
    scene.add(wall);
    entities.push(wall);
}

// Create a wall oriented along Z (thin in X), with a doorway cut-out (gap in Z).
// V8 PATCH: add lintel/header + edge caps to eliminate "black gap" seams around doors.
function createWallWithDoorwayZ(x, y, zCenter, w, h, totalDepth, gapCenterZ, gapDepth, wallMat, trimMat) {
    const half = totalDepth / 2;
    const gHalf = gapDepth / 2;

    const z1Min = zCenter - half;
    const z1Max = gapCenterZ - gHalf;
    const z2Min = gapCenterZ + gHalf;
    const z2Max = zCenter + half;

    const seg1Depth = Math.max(0, z1Max - z1Min);
    const seg2Depth = Math.max(0, z2Max - z2Min);

    // Main wall segments (left/right of doorway opening)
    if (seg1Depth > 0.01) {
        const z = z1Min + seg1Depth / 2;
        createWall(x, y, z, w, h, seg1Depth, wallMat);
    }
    if (seg2Depth > 0.01) {
        const z = z2Min + seg2Depth / 2;
        createWall(x, y, z, w, h, seg2Depth, wallMat);
    }

    // ---- Seam killers ----
    // Lintel/header above doorway (so the opening isn't full-height visually)
    const headerH = Math.min(0.55, h * 0.22);
    const headerY = y + (h - headerH / 2);
    const headerD = gapDepth + 0.06;
    createWall(x, headerY - headerH/2, gapCenterZ, w + 0.02, headerH, headerD, trimMat || wallMat);

    // Edge caps on both sides of the opening to remove tiny "slit" artifacts
    const capD = 0.10; // thin overlap into opening edge
    if (trimMat) {
        // cap near z1Max
        if (seg1Depth > 0.01) createWall(x, y, z1Max - capD/2, w + 0.02, h, capD, trimMat);
        // cap near z2Min
        if (seg2Depth > 0.01) createWall(x, y, z2Min + capD/2, w + 0.02, h, capD, trimMat);
    }
}

// Create a wall oriented along X (thin in Z), with a doorway cut-out (gap in X).
// V8 PATCH: add lintel/header + edge caps to eliminate "black gap" seams around doors.
function createWallWithDoorwayX(xCenter, y, z, totalWidth, h, d, gapCenterX, gapWidth, wallMat, trimMat) {
    const half = totalWidth / 2;
    const gHalf = gapWidth / 2;

    const x1Min = xCenter - half;
    const x1Max = gapCenterX - gHalf;
    const x2Min = gapCenterX + gHalf;
    const x2Max = xCenter + half;

    const seg1W = Math.max(0, x1Max - x1Min);
    const seg2W = Math.max(0, x2Max - x2Min);

    // Main wall segments (left/right of doorway opening)
    if (seg1W > 0.01) {
        const x = x1Min + seg1W / 2;
        createWall(x, y, z, seg1W, h, d, wallMat);
    }
    if (seg2W > 0.01) {
        const x = x2Min + seg2W / 2;
        createWall(x, y, z, seg2W, h, d, wallMat);
    }

    // ---- Seam killers ----
    // Lintel/header above doorway
    const headerH = Math.min(0.55, h * 0.22);
    const headerY = y + (h - headerH / 2);
    const headerW = gapWidth + 0.06;
    createWall(gapCenterX, headerY - headerH/2, z, headerW, headerH, d + 0.02, trimMat || wallMat);

    // Edge caps
    const capW = 0.10;
    if (trimMat) {
        if (seg1W > 0.01) createWall(x1Max - capW/2, y, z, capW, h, d + 0.02, trimMat);
        if (seg2W > 0.01) createWall(x2Min + capW/2, y, z, capW, h, d + 0.02, trimMat);
    }
}

// Door frame/trim around openings (cheap realism)
function createDoorFrameAt(x, y, z, gapW, h, thickness, mat, axis) {
    const frameT = 0.06;
    const frameW = (axis === 'X') ? gapW : 0.35;
    const frameD = (axis === 'X') ? thickness : gapW;

    // Side posts
    const postGeo = new THREE.BoxGeometry(frameT, h, frameD + 0.05);
    const postL = new THREE.Mesh(postGeo, mat);
    const postR = new THREE.Mesh(postGeo, mat);

    if (axis === 'X') {
        postL.position.set(x - gapW / 2, y + h / 2, z);
        postR.position.set(x + gapW / 2, y + h / 2, z);
    } else {
        postL.position.set(x, y + h / 2, z - gapW / 2);
        postR.position.set(x, y + h / 2, z + gapW / 2);
        postL.rotation.y = Math.PI / 2;
        postR.rotation.y = Math.PI / 2;
    }

    postL.castShadow = postR.castShadow = true;
    postL.receiveShadow = postR.receiveShadow = true;
    scene.add(postL); scene.add(postR);
    postL.userData.isWall = true; postR.userData.isWall = true;
    entities.push(postL); entities.push(postR);

    // Header
    const headerGeo = new THREE.BoxGeometry((axis === 'X') ? (gapW + frameT * 2) : frameT, 0.12, (axis === 'X') ? (frameD + 0.05) : (gapW + frameT * 2));
    const header = new THREE.Mesh(headerGeo, mat);
    header.position.set(x, y + h + 0.06, z);
    if (axis === 'Z') header.rotation.y = Math.PI / 2;
    header.castShadow = true;
    header.receiveShadow = true;
    header.userData.isWall = true;
    scene.add(header);
    entities.push(header);
}

function createCeiling(cx, yTop, cz, w, d) {
    const ceilGeo = new THREE.PlaneGeometry(w, d);
    const ceilMat = new THREE.MeshStandardMaterial({
        color: 0x1a1b20,
        roughness: 0.95,
        metalness: 0.0
    });
    const ceil = new THREE.Mesh(ceilGeo, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, yTop + 0.01, cz);
    ceil.receiveShadow = true;
    scene.add(ceil);
}

function createCeilingLight(x, y, z) {
    // Fixture mesh
    const fixtureGeo = new THREE.BoxGeometry(1.2, 0.08, 0.4);
    const fixtureMat = new THREE.MeshStandardMaterial({
        map: TEX.metalTex,
        color: 0xffffff,
        roughness: 0.35,
        metalness: 0.6,
        emissive: 0x111111
    });
    const fixture = new THREE.Mesh(fixtureGeo, fixtureMat);
    fixture.position.set(x, y, z);
    fixture.castShadow = true;
    fixture.receiveShadow = true;
    scene.add(fixture);

    // Light
    const light = new THREE.PointLight(0xfff2d6, 35, 14, 2);
    light.position.set(x, y - 0.15, z);
    light.castShadow = true;
    light.shadow.mapSize.width = 1024;
    light.shadow.mapSize.height = 1024;
    scene.add(light);
}


function createDoor(x, y, z, rotation) {
    // Door leaf size
    const doorW = 2.05;  // wider leaf to minimize side gaps in doorways
    const doorH = 2.45;
    const doorT = 0.12;

    const doorGeo = new THREE.BoxGeometry(doorW, doorH, doorT);

    // Slightly richer material (still lightweight)
    const doorMat = new THREE.MeshStandardMaterial({
        color: 0x5a3a22,
        roughness: 0.75,
        metalness: 0.05
    });

    // Hinge pivot group so doors actually clear the doorway when opened
    const pivot = new THREE.Group();
    pivot.position.set(x, y + doorH / 2, z);
    pivot.rotation.y = rotation;

    // Door leaf is offset from pivot so pivot sits on the hinge edge
    const doorLeaf = new THREE.Mesh(doorGeo, doorMat);
    doorLeaf.position.x = doorW / 2; // hinge on left edge of leaf in pivot space
    doorLeaf.castShadow = true;
    doorLeaf.receiveShadow = true;

    pivot.add(doorLeaf);

    // Store state on pivot (interaction target)
    pivot.userData.isDoor = true;
    pivot.userData.isOpen = false;
    pivot.userData.isBreached = false;
    pivot.userData.leaf = doorLeaf;


    // Static frame/trim around this doorway to eliminate visible gaps
    // (frame does NOT rotate with the door)
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.85, metalness: 0.02 });
    const frameT = 0.06;
    const jambDepth = doorT + 0.26;

    const frameGroup = new THREE.Group();
    frameGroup.position.set(x, y + doorH / 2, z);
    frameGroup.rotation.y = rotation;

    // Left + right jambs (slightly overlap door edges)
    const jambGeo = new THREE.BoxGeometry(frameT, doorH + 0.08, jambDepth);
    const jambL = new THREE.Mesh(jambGeo, frameMat);
    const jambR = new THREE.Mesh(jambGeo, frameMat);
    jambL.position.set(-0.02, 0, 0);
    jambR.position.set(doorW + 0.02, 0, 0);

    // Header
    const headGeo = new THREE.BoxGeometry(doorW + frameT * 2 + 0.04, frameT, jambDepth);
    const headTrim = new THREE.Mesh(headGeo, frameMat);
    headTrim.position.set(doorW / 2, (doorH / 2) + (frameT / 2) + 0.02, 0);

    // Stop strip (covers the tiny daylight line when the door is closed)
    const stopGeo = new THREE.BoxGeometry(doorW + 0.08, 0.02, 0.02);
    const stop = new THREE.Mesh(stopGeo, frameMat);
    stop.position.set(doorW / 2, 0, (jambDepth / 2) - 0.01);

    [jambL, jambR, headTrim, stop].forEach(m => {
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.isWall = true;
        frameGroup.add(m);
    });

    scene.add(frameGroup);
    entities.push(frameGroup);

scene.add(pivot);
    doors.push(pivot);
    entities.push(pivot); // so raycasts can "hit" doors if needed

    interactables.push({
        mesh: pivot,
        type: 'door',
        prompt: 'Press [F] to open / [G] to breach'
    });
}

function createCover(x, y, z, w, h, d) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({ color: 0x555555 });
    const cover = new THREE.Mesh(geo, mat);
    cover.position.set(x, y + h/2, z);
    cover.castShadow = true;
    cover.receiveShadow = true;
    cover.userData.isCover = true;
    scene.add(cover);
    entities.push(cover);
}

function createHostage(x, y, z) {
    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.2, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x00ff88 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    const headGeo = new THREE.SphereGeometry(0.25, 8, 8);
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.position.y = 0.85;

    const hostage = new THREE.Group();
    hostage.add(body);
    hostage.add(head);
    hostage.position.set(x, y + 0.6, z);
    hostage.userData.isHostage = true;
    hostage.userData.isRescued = false;
    scene.add(hostage);
    entities.push(hostage);
    interactables.push({
        mesh: hostage,
        type: 'hostage',
        prompt: 'Press [F] to rescue hostage'
    });
}

function createEnemy(x, y, z) {
    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.5, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xff3333 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    const headGeo = new THREE.SphereGeometry(0.25, 8, 8);
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.position.y = 1;

    // ============================
    // Visible weapon + aiming read
    // ============================
    // Gun is oriented to aim along its local +Z axis.
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.25 });
    const gunPivot = new THREE.Group();                 // pivot (pitch/yaw)
    gunPivot.position.set(0.22, 0.38, 0.10);            // shoulder-ish mount

    const gunGroup = new THREE.Group();                 // actual gun geometry
    gunGroup.position.set(0, 0, 0);

    // Receiver / main body
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.12, 0.14), gunMat);
    gunBody.position.set(0.00, 0.00, 0.12);

    // Barrel (points forward +Z)
    const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 8), gunMat);
    gunBarrel.rotation.x = Math.PI / 2;
    gunBarrel.position.set(0.00, 0.00, 0.45);

    // Stock
    const gunStock = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.14), gunMat);
    gunStock.position.set(0.00, 0.00, -0.02);

    // Foregrip / mag block (simple)
    const gunMag = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.18, 0.10), gunMat);
    gunMag.position.set(0.00, -0.12, 0.18);

    [gunBody, gunBarrel, gunStock, gunMag].forEach(m => { m.castShadow = true; m.receiveShadow = true; gunGroup.add(m); });

    // A small "muzzle" marker (invisible mesh used as a world-space reference point for LOS/aim)
    const muzzleMarker = new THREE.Object3D();
    muzzleMarker.position.set(0.00, 0.00, 0.75); // out past the barrel
    gunGroup.add(muzzleMarker);

    gunPivot.add(gunGroup);

    // A thin aim line (shows where the gun is pointing when alert)
    const aimLineGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    const aimLineMat = new THREE.LineBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.35 });
    const aimLine = new THREE.Line(aimLineGeom, aimLineMat);
    aimLine.frustumCulled = false;
    aimLine.visible = false;
    scene.add(aimLine);

    const enemy = new THREE.Group();
    enemy.add(body);
    enemy.add(head);
    enemy.add(gunPivot);

    enemy.userData.gunPivot = gunPivot;
    enemy.userData.gun = gunGroup;
    enemy.userData.muzzle = muzzleMarker;
    enemy.userData.aimLine = aimLine;

    enemy.position.set(x, y + 0.75, z);
    enemy.userData.isEnemy = true;
    enemy.userData.health = 100;
    enemy.userData.isAlive = true;
    enemy.userData.isAlert = false;
    enemy.userData.lastShot = 0;

    // Enemy perception (used for "are they actively aiming at me?")
    enemy.userData.viewDistance = 22;
    enemy.userData.fovDeg = 80;           // vision FOV (body/head)
    enemy.userData.aimFovDeg = 18;        // tighter "actively aiming" cone (gun)
    enemy.userData.aimingAtPlayer = false;

    scene.add(enemy);
    entities.push(enemy);
}

function createRiotScene() {
    // Street setup
    const streetMat = new THREE.MeshStandardMaterial({ color: 0x333333 });

    // Barriers
    for (let i = -20; i <= 20; i += 5) {
        createBarrier(i, 0, -10);
    }

    // Riot crowd (simplified)
    for (let i = 0; i < 30; i++) {
        createRioter(
            -15 + Math.random() * 30,
            0,
            -25 + Math.random() * 10
        );
    }

    // Police line position
    player.z = 5;
}

function createBarrier(x, y, z) {
    const geo = new THREE.BoxGeometry(4, 1.2, 0.5);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6600 });
    const barrier = new THREE.Mesh(geo, mat);
    barrier.position.set(x, y + 0.6, z);
    barrier.castShadow = true;
    barrier.userData.isBarrier = true;
    scene.add(barrier);
    entities.push(barrier);
}

function createRioter(x, y, z) {
    const bodyGeo = new THREE.CylinderGeometry(0.25, 0.25, 1.4, 6);
    const bodyMat = new THREE.MeshStandardMaterial({ 
        color: new THREE.Color().setHSL(Math.random(), 0.5, 0.4)
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    const headGeo = new THREE.SphereGeometry(0.2, 6, 6);
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.position.y = 0.9;

    const rioter = new THREE.Group();
    rioter.add(body);
    rioter.add(head);
    rioter.position.set(x, y + 0.7, z);
    rioter.userData.isRioter = true;
    rioter.userData.aggression = Math.random();
    scene.add(rioter);
    entities.push(rioter);
}

function createShootHouse() {
    // GAS STATION (V9): reference-inspired neon + pylon sign + richer interior/exterior dressing
    // Map-only. Does not touch controls/AI/UI/weapons/LOS logic.

    const wallExt = new THREE.MeshStandardMaterial({ color: 0x7f7f7f, roughness: 0.95, metalness: 0.02 });
    const wallInt = new THREE.MeshStandardMaterial({ color: 0x6e6e6e, roughness: 0.98, metalness: 0.01 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.7, metalness: 0.15 });

    const asphalt = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 1.0, metalness: 0.0 });
    const asphalt2 = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 1.0, metalness: 0.0 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.98, metalness: 0.0 });
    const sidewalk = new THREE.MeshStandardMaterial({ color: 0x7a7a7a, roughness: 1.0, metalness: 0.0 });

    const pumpMat = new THREE.MeshStandardMaterial({ color: 0xd6d6d6, roughness: 0.65, metalness: 0.08 });
    const pumpAccent = new THREE.MeshStandardMaterial({ color: 0x1e8bff, roughness: 0.35, metalness: 0.15 });

    const shelfMat = new THREE.MeshStandardMaterial({ color: 0x3b3b3b, roughness: 0.9, metalness: 0.05 });
    const counterMat = new THREE.MeshStandardMaterial({ color: 0x2f2a24, roughness: 0.9, metalness: 0.02 });

    const carMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.55, metalness: 0.22 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0e1a1c, transparent: true, opacity: 0.35, roughness: 0.25, metalness: 0.0 });

    // Emissive neon materials (reference vibe)
    const neonOrange = new THREE.MeshStandardMaterial({ color: 0x2a1205, emissive: 0xff5a12, emissiveIntensity: 2.2, roughness: 0.35, metalness: 0.0 });
    const neonPurple = new THREE.MeshStandardMaterial({ color: 0x12081d, emissive: 0x8b2cff, emissiveIntensity: 1.8, roughness: 0.35, metalness: 0.0 });
    const neonBlue = new THREE.MeshStandardMaterial({ color: 0x08121a, emissive: 0x2aa7ff, emissiveIntensity: 1.6, roughness: 0.35, metalness: 0.0 });
    const warmWhite = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff1cf, emissiveIntensity: 1.4, roughness: 0.7, metalness: 0.0 });

    // Helper for blockers that affect movement + LOS
    function createBarrier(x, y, z, w, h, d, material) {
        const geo = new THREE.BoxGeometry(w, h, d);
        const obj = new THREE.Mesh(geo, material);
        obj.position.set(x, y + h/2, z);
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.userData.isBarrier = true;
        scene.add(obj);
        entities.push(obj);
        return obj;
    }
    function createCoverBox(x, y, z, w, h, d, material) {
        const geo = new THREE.BoxGeometry(w, h, d);
        const obj = new THREE.Mesh(geo, material);
        obj.position.set(x, y + h/2, z);
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.userData.isCover = true;
        scene.add(obj);
        entities.push(obj);
        return obj;
    }
    function addVisualBox(x, y, z, w, h, d, material) {
        const geo = new THREE.BoxGeometry(w, h, d);
        const obj = new THREE.Mesh(geo, material);
        obj.position.set(x, y + h/2, z);
        obj.castShadow = true;
        obj.receiveShadow = true;
        scene.add(obj);
        return obj;
    }
    function addVisualPlane(x, y, z, w, h, material, ry=0) {
        const geo = new THREE.PlaneGeometry(w, h);
        const obj = new THREE.Mesh(geo, material);
        obj.position.set(x, y, z);
        obj.rotation.y = ry;
        scene.add(obj);
        return obj;
    }
    function addPointLight(x, y, z, color, intensity, distance) {
        const l = new THREE.PointLight(color, intensity, distance);
        l.position.set(x, y, z);
        scene.add(l);
        return l;
    }

    // --- Streets / intersection slabs (visual + light collision) ---
    createBarrier(0, -0.06, -18, 70, 0.1, 18, asphalt2);
    createBarrier(0, -0.061, -18, 46, 0.1, 46, asphalt);
    createBarrier(0, -0.062, 4, 34, 0.1, 22, concrete);

    // Sidewalk + curb lips (collision)
    createBarrier(0, -0.01, 12.4, 20, 0.1, 3.0, sidewalk);
    createBarrier(0, 0.0, 9.6, 22.2, 0.25, 0.6, sidewalk);
    createBarrier(0, 0.0, 1.0, 34.2, 0.25, 0.6, sidewalk);

    // Painted lane lines (visual)
    addVisualBox(0, 0.0, -18, 1.0, 0.02, 40, new THREE.MeshStandardMaterial({ color: 0xbdbdbd, roughness: 1.0 }));
    addVisualBox(-10, 0.0, -18, 1.0, 0.02, 18, new THREE.MeshStandardMaterial({ color: 0xbdbdbd, roughness: 1.0 }));
    addVisualBox( 10, 0.0, -18, 1.0, 0.02, 18, new THREE.MeshStandardMaterial({ color: 0xbdbdbd, roughness: 1.0 }));
    for (let i=0;i<10;i++){
        addVisualBox(-6 + i*1.3, 0.0, -9.5, 0.8, 0.02, 3.2, new THREE.MeshStandardMaterial({ color: 0xbdbdbd, roughness: 1.0 }));
    }

    // Streetlights / spill (reference night vibe)
    addPointLight(-18, 7.5, -5, 0xffb36b, 1.25, 55);
    addPointLight( 18, 7.5, -22, 0x6bb6ff, 1.15, 60);
    addPointLight(  0, 6.0, -8, 0xff6a2a, 0.9, 45);

    // --- Canopy + neon edge strips ---
    addVisualBox(0, 4.2, 4.3, 22.0, 0.35, 10.0, new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.95 }));

    // V16: Canopy underside ribs + darker soffit (aligned to actual canopy)
    (function(){
        const ribMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.9 });
        const soffitMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.85 });
        for (let i=-9;i<=9;i++){
            const rib=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.18,10.4), ribMat);
            rib.position.set(i*1.1, 4.02, 4.3);
            rib.castShadow=true; rib.receiveShadow=true;
            scene.add(rib);
        }
        const soffit=new THREE.Mesh(new THREE.BoxGeometry(21.6,0.08,9.8), soffitMat);
        soffit.position.set(0,3.82,4.3);
        soffit.castShadow=true; soffit.receiveShadow=true;
        scene.add(soffit);
    })();

    addVisualBox(0, 4.05, 4.3, 22.5, 0.18, 10.5, trimMat);

    // Neon strips around canopy perimeter
    addVisualBox(0, 4.13, 4.3 - 5.15, 22.6, 0.10, 0.18, neonOrange);
    addVisualBox(0, 4.13, 4.3 + 5.15, 22.6, 0.10, 0.18, neonOrange);
    addVisualBox(-11.3, 4.13, 4.3, 0.18, 0.10, 10.6, neonOrange);
    addVisualBox( 11.3, 4.13, 4.3, 0.18, 0.10, 10.6, neonOrange);

    // Under-canopy lights
    addPointLight(-4, 3.6, 3.2, 0xfff1cf, 1.6, 18);
    addPointLight( 4, 3.6, 3.2, 0xfff1cf, 1.6, 18);
    addPointLight(-4, 3.6, 5.8, 0xfff1cf, 1.6, 18);
    addPointLight( 4, 3.6, 5.8, 0xfff1cf, 1.6, 18);

    // Posts (barriers)
    function createPost(x, z) { return createBarrier(x, 0, z, 0.55, 4.2, 0.55, trimMat); }
    for (let px of [-9, 9]) for (let pz of [0.8, 7.8]) createPost(px, pz);

    // Pumps
    function createPump(x, z) {
        createBarrier(x, 0, z, 3.2, 0.35, 1.4, sidewalk);
        createBarrier(x, 0, z, 0.9, 1.9, 0.65, pumpMat);
        addVisualBox(x, 1.25, z+0.32, 0.7, 0.6, 0.08, pumpAccent);
        addVisualBox(x, 1.00, z+0.36, 0.6, 0.08, 0.06, neonBlue);
    }

    // ======================
    // V16: Pump detail realism (visual only)
    // ======================
    function addPumpDetail(x, z) {
        // Hose (curved-ish using several small cylinders)
        const hoseMat = new THREE.MeshStandardMaterial({ color: 0x0f0f0f, roughness: 0.95, metalness: 0.0 });
        const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.7, metalness: 0.25 });
        const metalMat  = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.55, metalness: 0.65 });

        // side bracket / cradle
        addVisualBox(x + 0.42, 1.45, z + 0.05, 0.10, 0.40, 0.08, metalMat);

        // hose segments (gentle curve down to island)
        for (let i=0;i<7;i++){
            const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,0.28,10), hoseMat);
            seg.rotation.z = Math.PI/2;
            seg.rotation.y = 0.35 + i*0.08;
            seg.position.set(x + 0.35 - i*0.07, 1.35 - i*0.10, z + 0.22 + i*0.05);
            seg.castShadow = true;
            seg.receiveShadow = true;
            scene.add(seg);
        }

        // nozzle silhouette
        const noz = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.06,0.32), nozzleMat);
        noz.position.set(x + 0.05, 0.72, z + 0.60);
        noz.rotation.y = 0.6;
        noz.castShadow = true;
        noz.receiveShadow = true;
        scene.add(noz);

        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.08,0.12,0.10), nozzleMat);
        handle.position.set(x + 0.12, 0.78, z + 0.52);
        handle.rotation.y = 0.6;
        scene.add(handle);

        // pump topper / signage box
        const topperMat = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.65, metalness: 0.15 });
        const topper = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.35, 0.28), topperMat);
        topper.position.set(x, 2.15, z - 0.08);
        topper.castShadow = true;
        topper.receiveShadow = true;
        scene.add(topper);

        // small emissive "brand strip"
        const brand = new THREE.Mesh(
            new THREE.BoxGeometry(0.95, 0.10, 0.02),
            new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x1e8bff, emissiveIntensity: 1.6, roughness: 0.4 })
        );
        brand.position.set(x, 2.15, z + 0.07);
        scene.add(brand);

        // island paint stripe (yellow)
        addVisualBox(x, 0.02, z, 3.0, 0.02, 0.18, new THREE.MeshStandardMaterial({ color: 0xd8b100, roughness: 1.0 }));
        addVisualBox(x, 0.02, z + 0.55, 3.0, 0.02, 0.18, new THREE.MeshStandardMaterial({ color: 0xd8b100, roughness: 1.0 }));
    }
createPump(-4.0, 3.2);
    createPump( 4.0, 3.2);
    createPump(-4.0, 5.8);
    createPump( 4.0, 5.8);
    addPumpDetail(-4.0, 3.2);
    addPumpDetail( 4.0, 3.2);
    addPumpDetail(-4.0, 5.8);
    addPumpDetail( 4.0, 5.8);


    // Bollards
    const bollardMat = new THREE.MeshStandardMaterial({ color: 0xd0b100, roughness: 0.8, metalness: 0.05 });
    function bollard(x, z) {
        const geo = new THREE.CylinderGeometry(0.18, 0.18, 1.1, 16);
        const o = new THREE.Mesh(geo, bollardMat);
        o.position.set(x, 0.55, z);
        o.castShadow = true;
        o.receiveShadow = true;
        o.userData.isBarrier = true;
        scene.add(o);
        entities.push(o);
    }
    bollard(-1.2, 11.5);
    bollard( 0.0, 11.5);
    bollard( 1.2, 11.5);

    // Trash + box
    createCoverBox(-7.6, 0, 11.2, 0.9, 1.1, 0.9, new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.9 }));
    createCoverBox(-8.8, 0, 11.0, 0.9, 1.1, 0.7, new THREE.MeshStandardMaterial({ color: 0x7a1111, roughness: 0.8 }));

    // --- Pylon sign ---
    createBarrier(15.5, 0, -2.0, 0.8, 10.0, 0.8, trimMat);
    createBarrier(15.5, 7.6, -2.0, 3.6, 2.2, 1.0, new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8 }));
    addVisualBox(15.5, 7.6, -2.0, 3.7, 0.18, 1.05, neonPurple);
    addVisualPlane(15.5, 8.0, -1.45, 3.0, 1.0, neonOrange, 0);
    for (let i=0;i<4;i++){
        const y = 6.0 - i*1.0;
        createBarrier(15.5, y, -2.0, 3.2, 0.75, 0.9, new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 }));
        addVisualBox(15.5, y, -1.55, 3.05, 0.10, 0.08, neonBlue);
    }
    addPointLight(15.5, 7.0, -1.5, 0xff5a12, 1.25, 35);
    addPointLight(15.5, 5.0, -1.5, 0x2aa7ff, 0.9, 28);

    // --- Cars ---
    function createCar(x, z, heading) {
        const body = createCoverBox(x, 0, z, 3.8, 1.0, 1.8, carMat);
        body.rotation.y = heading;
        const cab = createCoverBox(x, 0, z, 2.2, 0.7, 1.5, new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.55, metalness: 0.15 }));
        cab.position.y = 1.05;
        cab.rotation.y = heading;
        const win = addVisualBox(x, 1.05, z, 2.0, 0.55, 1.35, new THREE.MeshStandardMaterial({ color: 0x0b0f14, transparent: true, opacity: 0.35, roughness: 0.25 }));
        win.rotation.y = heading;
    }
    createCar(-12, -10, Math.PI/2);
    createCar( 10,   7, Math.PI);

    // --- Store building ---
    const cx = 0, cz = 14;
    const w = 16, d = 10;
    const t = 0.55, h = 3.2;
    const over = 0.12;

    createWall(cx, 0, cz - d/2, w + over, h, t + over, wallExt);
    createWall(cx, 0, cz + d/2, w + over, h, t + over, wallExt);
    createWall(cx - w/2, 0, cz, t + over, h, d + over, wallExt);
    createWall(cx + w/2, 0, cz, t + over, h, d + over, wallExt);

    // Facade bands
    addVisualBox(0, 0.55, cz - d/2 + 0.25, 16.6, 1.1, 0.35, new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness: 0.95 }));
    addVisualBox(0, 2.8,  cz - d/2 + 0.28, 16.8, 0.18, 0.40, trimMat);

    // Glass + mullions
    addVisualBox(0, 1.3, cz - d/2 + 0.33, 10.0, 2.6, 0.08, glassMat);
    addVisualBox(-6.0, 1.3, cz - d/2 + 0.33, 2.6, 2.6, 0.08, glassMat);
    addVisualBox( 6.0, 1.3, cz - d/2 + 0.33, 2.6, 2.6, 0.08, glassMat);
    addVisualBox(-3.0, 1.3, cz - d/2 + 0.37, 0.08, 2.6, 0.12, trimMat);
    addVisualBox( 3.0, 1.3, cz - d/2 + 0.37, 0.08, 2.6, 0.12, trimMat);
    addVisualBox( 0.0, 1.3, cz - d/2 + 0.37, 0.08, 2.6, 0.12, trimMat);


    // ======================
    // V16: Store entrance + vestibule (visual + obvious colliders only)
    // ======================
    // Recessed vestibule: create a shallow "inset" entrance bay so it reads like a real storefront.
    const frontZ = cz - d/2 + 0.10; // near existing threshold
    const vestDepth = 1.15;
    const vestW = 3.4;
    const vestH = 2.8;

    // Side returns (walls)
    createWall(-vestW/2 + 0.10, 0, frontZ + vestDepth/2, 0.35, vestH, vestDepth + 0.35, wallExt);
    createWall( vestW/2 - 0.10, 0, frontZ + vestDepth/2, 0.35, vestH, vestDepth + 0.35, wallExt);

    // Overhead lintel
    createWall(0, vestH - 0.10, frontZ + vestDepth/2, vestW + 0.35, 0.30, vestDepth + 0.35, trimMat);

    // Recessed floor pad
    createBarrier(0, -0.01, frontZ + vestDepth/2, vestW + 0.2, 0.06, vestDepth + 0.2, sidewalk);

    // Double glass doors (visual)
    const doorGlass = new THREE.MeshStandardMaterial({ color: 0x111111, transparent:true, opacity:0.55, roughness:0.12, metalness:0.0 });
    const doorFrame = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness:0.7, metalness:0.25 });

    // frames
    addVisualBox(-0.85, 1.35, frontZ + vestDepth - 0.45, 1.55, 2.5, 0.10, doorFrame);
    addVisualBox( 0.85, 1.35, frontZ + vestDepth - 0.45, 1.55, 2.5, 0.10, doorFrame);

    // glass panes
    addVisualBox(-0.85, 1.35, frontZ + vestDepth - 0.40, 1.35, 2.2, 0.04, doorGlass);
    addVisualBox( 0.85, 1.35, frontZ + vestDepth - 0.40, 1.35, 2.2, 0.04, doorGlass);

    // door handles (simple)
    addVisualBox(-0.25, 1.25, frontZ + vestDepth - 0.33, 0.06, 0.35, 0.04, new THREE.MeshStandardMaterial({ color:0x777777, roughness:0.35, metalness:0.8 }));
    addVisualBox( 0.25, 1.25, frontZ + vestDepth - 0.33, 0.06, 0.35, 0.04, new THREE.MeshStandardMaterial({ color:0x777777, roughness:0.35, metalness:0.8 }));

    // Warm entry downlight
    addPointLight(0, 2.6, frontZ + vestDepth/2, 0xffcf9b, 0.95, 10.0);

    // Obvious physical colliders: door jamb posts (prevents corner gaps / weird clipping)
    createBarrier(-vestW/2 + 0.25, 0, frontZ + vestDepth - 0.45, 0.18, 2.6, 0.55, trimMat);
    createBarrier( vestW/2 - 0.25, 0, frontZ + vestDepth - 0.45, 0.18, 2.6, 0.55, trimMat);
// Threshold + spill
    createBarrier(0, -0.01, cz - d/2 + 0.05, 2.4, 0.12, 0.60, sidewalk);
    addVisualBox(0, 0.12, cz - d/2 + 0.25, 2.2, 0.18, 0.12, trimMat);
    addPointLight(0, 2.4, cz - d/2 + 1.0, 0xffd7a8, 1.6, 16);

    // Neon store sign
    addVisualBox(0, 3.05, cz - d/2 + 0.55, 6.5, 0.55, 0.18, new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.8 }));
    addVisualPlane(0, 3.05, cz - d/2 + 0.65, 6.0, 0.45, neonOrange, 0);

    // Ceiling panels + warm lights
    for (let i=0;i<4;i++){
        const z = cz - 1.5 + i*2.2;
        addVisualBox(0, 3.05, z, 12.0, 0.08, 1.2, warmWhite);
        addPointLight(0, 2.9, z, 0xfff1cf, 1.35, 18);
    }

    // Aisles
    for (let i = 0; i < 3; i++) {
        createCoverBox(-4.2, 0, cz + (i*2.3) - 1.8, 0.55, 2.0, 5.5, shelfMat);
        createCoverBox( 4.2, 0, cz + (i*2.3) - 1.8, 0.55, 2.0, 5.5, shelfMat);
    }
    createCoverBox(0, 0, cz + 1.2, 1.0, 2.0, 6.5, shelfMat);

    // Product boxes (visual)
    function addBoxesRow(x, z, count, colorHex) {
        const m = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.9, metalness: 0.0 });
        for (let i=0;i<count;i++){
            addVisualBox(x, 1.0, z + i*0.35, 0.22, 0.16, 0.28, m);
        }
    }
    addBoxesRow(-5.2, cz - 2.0, 12, 0xb55a2a);
    addBoxesRow( 5.2, cz - 2.0, 12, 0x2a7ab5);
    addBoxesRow(-5.2, cz + 2.0, 12, 0xb5aa2a);
    addBoxesRow( 5.2, cz + 2.0, 12, 0x6a2ab5);

    // Counter + sign
    createCoverBox(-3.2, 0, 11.0, 4.4, 1.1, 1.2, counterMat);
    addVisualPlane(-3.2, 2.2, 10.2, 4.2, 0.9, neonBlue, 0);

    // Backroom partition + doorway caps
    const partZ = cz + 3.2;
    createWall(-3.0, 0, partZ, 10.0 + over, h, 0.45 + over, wallInt);
    createBarrier(5.2, 0, partZ, 1.8, 0.25, 0.65, trimMat);
    createBarrier(4.4, 0, partZ, 0.18, h, 0.65, trimMat);
    createBarrier(6.0, 0, partZ, 0.18, h, 0.65, trimMat);

    // Backroom props + light
    createCoverBox(2.5, 0, cz + 7.2, 2.0, 1.5, 1.2, new THREE.MeshStandardMaterial({ color: 0x4a3b2f, roughness: 0.95 }));
    createCoverBox(-4.8, 0, cz + 7.6, 2.2, 2.0, 0.8, new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 }));
    addPointLight(0, 2.8, cz + 7.0, 0xbfd7ff, 1.1, 16);

    // Restroom nook + light
    const rrX = -6.1, rrZ = cz + 6.8;
    createWall(rrX, 0, rrZ, 3.6 + over, h, 0.45 + over, wallInt);
    createWall(rrX-1.8, 0, rrZ+1.6, 0.45 + over, h, 3.2 + over, wallInt);
    createWall(rrX+1.8, 0, rrZ+1.6, 0.45 + over, h, 3.2 + over, wallInt);
    createWall(rrX, 0, rrZ+3.2, 3.6 + over, h, 0.45 + over, wallInt);
    addPointLight(rrX, 2.6, rrZ+1.6, 0xfff1cf, 0.9, 10);

    // Alley + purple glow
    createCoverBox(-11.5, 0, 16.0, 2.4, 1.3, 1.2, new THREE.MeshStandardMaterial({ color: 0x1f5a35, roughness: 0.95 }));
    createWall(-13.5, 0, 16.0, 0.6 + over, 2.6, 10.0 + over, new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.98 }));
    addPointLight(-11.8, 1.8, 16.0, 0x8b2cff, 0.7, 18);

    // Utility shed
    createCoverBox(10.8, 0, 9.5, 3.0, 2.4, 2.0, new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.95 }));
    addPointLight(10.8, 2.0, 9.5, 0xfff1cf, 0.6, 10);

    // NOTE: collision solids will be rebuilt after scene creation by createEnvironment()

    // ======================
    // V17: DETAIL PASS (visual fidelity) — pumps, interior dressing, parking lot
    // ======================

    // --- Simple canvas label helper (decals, price panels, pump labels) ---
    function makeLabelTexture(text, opts = {}) {
        const w = opts.w || 512;
        const h = opts.h || 256;
        const bg = opts.bg || "#0b0b0b";
        const fg = opts.fg || "#ffffff";
        const accent = opts.accent || "#00ff9a";
        const font = opts.font || "bold 70px Arial";
        const sub = opts.sub || "";
        const subFont = opts.subFont || "bold 44px Arial";
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 10;
        ctx.strokeRect(10, 10, w-20, h-20);
        ctx.fillStyle = fg;
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, w/2, h/2 - (sub ? 35 : 0));
        if (sub) {
            ctx.fillStyle = accent;
            ctx.font = subFont;
            ctx.fillText(sub, w/2, h/2 + 55);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        return tex;
    }

    function addDecalPlane(x,y,z, w,h, rotY, texture, emissiveHex=0x000000, emissiveIntensity=0.0, surfaceNudge=0.012) {
        const mat = new THREE.MeshStandardMaterial({
            map: texture,
            transparent: true,
            roughness: 0.6,
            metalness: 0.0,
            emissive: new THREE.Color(emissiveHex),
            emissiveIntensity: emissiveIntensity,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2
        });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w,h), mat);
        plane.rotation.y = rotY;

        // Nudge slightly along the plane's forward normal so it "sticks" to the surface
        const nx = Math.sin(rotY);
        const nz = Math.cos(rotY);
        plane.position.set(x + nx*surfaceNudge, y, z + nz*surfaceNudge);

        // Keep it visually stable (no shadow artifacts)
        plane.castShadow = false;
        plane.receiveShadow = false;
        plane.renderOrder = 5;
        scene.add(plane);
        return plane;
    }

    // --- Pump islands            // --- Pump islands: card readers + price decals + REGULAR/PREMIUM labels ---
    (function(){
        const readerMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.55, metalness: 0.25 });
        const screenMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.25, metalness: 0.05, emissive: 0x103040, emissiveIntensity: 0.6 });

        const priceTex = makeLabelTexture("4.69", { bg:"#101010", fg:"#ffffff", accent:"#ffb300", font:"bold 92px Arial", sub:"REG" });
        const premTex  = makeLabelTexture("5.23", { bg:"#101010", fg:"#ffffff", accent:"#00ff9a", font:"bold 92px Arial", sub:"PREM" });
        const regTex   = makeLabelTexture("REGULAR", { bg:"#0f0f0f", fg:"#ffffff", accent:"#ffb300", font:"bold 64px Arial" });
        const premLbl  = makeLabelTexture("PREMIUM", { bg:"#0f0f0f", fg:"#ffffff", accent:"#00ff9a", font:"bold 64px Arial" });

        // These centers match the existing pump layout under canopy
        const pumps = [
            {x:-4.0, z:3.2},
            {x: 4.0, z:3.2},
            {x:-4.0, z:5.8},
            {x: 4.0, z:5.8},
        ];

        // Pump geometry assumptions (kept tiny + safe)
        // Pump body roughly centered; topper face is near +/-Z from center.
        const topperFaceOffsetZ = 0.155;  // sits on topper front/back face (no floating)
        const islandLabelSideOffsetX = 1.38;

        pumps.forEach(p => {
            // Card reader + screen mounted on pump side (right side)
            const reader = new THREE.Mesh(new THREE.BoxGeometry(0.22,0.36,0.10), readerMat);
            reader.position.set(p.x + 0.40, 1.35, p.z + 0.02);
            reader.castShadow = true; reader.receiveShadow = true;
            scene.add(reader);

            const screen = new THREE.Mesh(new THREE.BoxGeometry(0.18,0.22,0.02), screenMat);
            screen.position.set(p.x + 0.42, 1.42, p.z + 0.075);
            scene.add(screen);

            // Price decals flush on topper faces (front/back)
            addDecalPlane(p.x, 2.15, p.z + topperFaceOffsetZ, 0.72, 0.33, 0.0, priceTex, 0x402a00, 0.25, 0.006);
            addDecalPlane(p.x, 2.15, p.z - topperFaceOffsetZ, 0.72, 0.33, Math.PI, priceTex, 0x402a00, 0.25, 0.006);

            // Regular/Premium island labels on OUTER ends (flush to side faces)
            addDecalPlane(p.x - islandLabelSideOffsetX, 0.25, p.z + 0.28, 0.82, 0.23, Math.PI/2, regTex, 0x331d00, 0.12, 0.006);
            addDecalPlane(p.x + islandLabelSideOffsetX, 0.25, p.z + 0.28, 0.82, 0.23, -Math.PI/2, premLbl, 0x003320, 0.12, 0.006);

            // Premium price small panel on pump rear face (low clutter, flush)
            addDecalPlane(p.x, 0.40, p.z + 0.33, 0.52, 0.26, 0.0, premTex, 0x003020, 0.18, 0.006);
        });
    })();

    // --- Store interior            // --- Store interior: shelving rows + checkout counter dressing ---
    (function(){
        const _storeW = (typeof storeW !== "undefined") ? storeW : 14.0;
        const _storeD = (typeof storeD !== "undefined") ? storeD : 12.0;
        const _cx = (typeof cx !== "undefined") ? cx : 0.0;
        const _cz = (typeof cz !== "undefined") ? cz : 0.0;

        const frontZ = _cz - _storeD/2 + 0.9;
        const backZ  = _cz + _storeD/2 - 0.9;

        const shelfMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.85, metalness: 0.05 });
        const shelfTop = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.75, metalness: 0.08 });
        const productMatA = new THREE.MeshStandardMaterial({ color: 0xb85b2a, roughness: 0.9 });
        const productMatB = new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.9 });
        const productMatC = new THREE.MeshStandardMaterial({ color: 0xd6c22f, roughness: 0.9 });

        function addShelfRow(x, zStart, zEnd) {
            const len = Math.abs(zEnd - zStart);
            const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.10, len), shelfMat);
            base.position.set(x, 0.55, (zStart+zEnd)/2);
            scene.add(base);

            const up1 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, len), shelfMat);
            up1.position.set(x-0.56, 1.35, (zStart+zEnd)/2);
            scene.add(up1);

            const up2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, len), shelfMat);
            up2.position.set(x+0.56, 1.35, (zStart+zEnd)/2);
            scene.add(up2);

            for (let i=0;i<4;i++){
                const sh = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.06, len), shelfTop);
                sh.position.set(x, 0.8 + i*0.38, (zStart+zEnd)/2);
                scene.add(sh);
            }

            const mats=[productMatA, productMatB, productMatC];
            for (let i=0;i<60;i++){
                const w = 0.10 + Math.random()*0.20;
                const h = 0.08 + Math.random()*0.18;
                const d = 0.10 + Math.random()*0.18;
                const box = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mats[i%3]);
                const shelfLevel = 0.92 + (Math.floor(Math.random()*4))*0.38;
                box.position.set(
                    x + (-0.4 + Math.random()*0.8),
                    shelfLevel + h/2,
                    (zStart+0.2) + Math.random()*(len-0.4)
                );
                scene.add(box);
            }
        }

        addShelfRow(_cx - 3.0, frontZ + 1.2, backZ - 1.0);
        addShelfRow(_cx + 3.0, frontZ + 1.2, backZ - 1.0);

        const counterMat = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.7, metalness: 0.15 });
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 0.85, metalness: 0.05 });

        const counter = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.1, 1.2), counterMat);
        counter.position.set(_cx + 3.8, 0.55, frontZ + 0.8);
        scene.add(counter);

        const counterTop = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.08, 1.25), woodMat);
        counterTop.position.set(_cx + 3.8, 1.12, frontZ + 0.8);
        scene.add(counterTop);

        const regMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.35, metalness: 0.35 });
        const register = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.35, 0.45), regMat);
        register.position.set(_cx + 4.6, 1.30, frontZ + 0.6);
        scene.add(register);

        const lotto = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.25), regMat);
        lotto.position.set(_cx + 5.1, 0.80, frontZ + 1.2);
        scene.add(lotto);

        const checkoutTex = makeLabelTexture("CHECKOUT", { bg:"#121212", fg:"#ffffff", accent:"#00ff9a", font:"bold 88px Arial" });
        addDecalPlane(_cx + 3.8, 2.4, frontZ + 1.45, 2.0, 0.55, 0.0, checkoutTex, 0x003322, 0.35);
    })();

    // --- Parking lot: better car silhouettes + curb cuts + signage ---
    (function(){
        const curbMat = new THREE.MeshStandardMaterial({ color: 0x9e9e9e, roughness: 0.95 });
        const signPostMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8, metalness: 0.15 });
        const paintMat = new THREE.MeshStandardMaterial({ color: 0xd9d9d9, roughness: 0.9, metalness: 0.0 });
        const yellowPaintMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.85, metalness: 0.0 });

        function addCar(x,z, rot=0.0, color=0x2f6fd6) {
            const bodyMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.55, metalness: 0.15 });
            const glassMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.25, metalness: 0.0, transparent:true, opacity:0.62 });

            const group = new THREE.Group();

            // More layered silhouette (still low-poly)
            const body = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.74, 1.75), bodyMat);
            body.position.set(0, 0.41, 0);
            group.add(body);

            const bumperF = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.28, 1.72), bodyMat);
            bumperF.position.set(2.05, 0.30, 0);
            group.add(bumperF);

            const bumperR = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.28, 1.72), bodyMat);
            bumperR.position.set(-2.05, 0.30, 0);
            group.add(bumperR);

            const hood = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.36, 1.70), bodyMat);
            hood.position.set(1.15, 0.66, 0);
            group.add(hood);

            const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.62, 1.58), bodyMat);
            cabin.position.set(-0.35, 0.92, 0);
            group.add(cabin);

            const glass = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.52, 1.48), glassMat);
            glass.position.set(-0.35, 0.98, 0);
            group.add(glass);

            // Headlights / taillights (emissive hint)
            const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.4 });
            const tailMat = new THREE.MeshStandardMaterial({ color: 0xff3333, emissive: 0xff3333, emissiveIntensity: 0.25, roughness: 0.5 });
            const hl1 = new THREE.Mesh(new THREE.BoxGeometry(0.10,0.10,0.35), headMat); hl1.position.set(2.20,0.42, 0.55); group.add(hl1);
            const hl2 = new THREE.Mesh(new THREE.BoxGeometry(0.10,0.10,0.35), headMat); hl2.position.set(2.20,0.42,-0.55); group.add(hl2);
            const tl1 = new THREE.Mesh(new THREE.BoxGeometry(0.10,0.10,0.35), tailMat); tl1.position.set(-2.20,0.42, 0.55); group.add(tl1);
            const tl2 = new THREE.Mesh(new THREE.BoxGeometry(0.10,0.10,0.35), tailMat); tl2.position.set(-2.20,0.42,-0.55); group.add(tl2);

            // wheels
            const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0f0f0f, roughness: 0.95, metalness: 0.0 });
            const rimMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.7, metalness: 0.25 });
            function wheel(wx,wz){
                const w = new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.34,0.24,16), wheelMat);
                w.rotation.z = Math.PI/2;
                w.position.set(wx, 0.24, wz);
                group.add(w);
                const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.22,0.245,16), rimMat);
                rim.rotation.z = Math.PI/2;
                rim.position.set(wx, 0.24, wz);
                group.add(rim);
            }
            wheel( 1.42,  0.82);
            wheel( 1.42, -0.82);
            wheel(-1.42,  0.82);
            wheel(-1.42, -0.82);

            group.position.set(x, 0.0, z);
            group.rotation.y = rot;
            group.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true; } });
            scene.add(group);

            // collider — conservative
            if (typeof createBarrier === "function") {
                createBarrier(x, 0.38, z, 4.1, 0.85, 2.05, bodyMat);
            }
        }

        // --- Parking layout (to the right of storefront), aligned and grounded ---
        // These coordinates assume the store frontage is along negative Z, pumps centered near (0, ~4.5).
        // Parking bays are placed near the front sidewalk zone.
        const bayZ = -1.8;
        addCar( 9.2, bayZ, Math.PI, 0xb8b8b8);   // sedan parked facing store
        addCar( 13.6, bayZ, Math.PI, 0x2f6fd6);  // truck-ish

        // Paint parking lines
        function addLine(x,z, w,d, mat){
            const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), mat);
            line.position.set(x, 0.006, z);
            line.receiveShadow = true;
            scene.add(line);
        }
        // Four bays
        for (let i=0;i<5;i++){
            const x = 7.0 + i*2.2;
            addLine(x, bayZ, 0.06, 4.6, paintMat);
        }
        // Stop bar / curb edge
        addLine(11.2, bayZ - 2.35, 9.0, 0.08, yellowPaintMat);

        // Wheel stops (small concrete blocks)
        for (let i=0;i<4;i++){
            const stop = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.16, 0.35), curbMat);
            stop.position.set(8.1 + i*2.2, 0.08, bayZ - 2.15);
            stop.receiveShadow = true;
            scene.add(stop);
        }

        // Curb cut / ramp near storefront — seated
        const curbBase = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.20, 0.6), curbMat);
        curbBase.position.set(2.0, 0.10, -4.2);
        scene.add(curbBase);

        const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 1.0), curbMat);
        ramp.position.set(2.0, 0.08, -3.7);
        ramp.rotation.x = -0.20;
        scene.add(ramp);

        // Signage: ATM + No Parking
        const atmTex = makeLabelTexture("ATM", { bg:"#101010", fg:"#ffffff", accent:"#00ff9a", font:"bold 110px Arial" });
        const noParkTex = makeLabelTexture("NO PARKING", { bg:"#101010", fg:"#ffffff", accent:"#ff2a2a", font:"bold 72px Arial", sub:"FIRE LANE" });

        const post1 = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,2.4,10), signPostMat);
        post1.position.set(1.4, 1.2, -3.4);
        scene.add(post1);
        addDecalPlane(1.4, 2.1, -3.32, 1.0, 0.5, 0.0, atmTex, 0x003322, 0.35, 0.006);

        const post2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,2.4,10), signPostMat);
        post2.position.set(0.2, 1.2, -3.4);
        scene.add(post2);
        addDecalPlane(0.2, 2.1, -3.32, 1.35, 0.55, 0.0, noParkTex, 0x330000, 0.22, 0.006);
    })();

    // ======================
    // V19: STORE FRONT + ATMOSPHERE PASS (reduce "minecraft" feel)
    // - Storefront glass/windows + mullions + trim band
    // - Sidewalk/curb, simple intersection markings
    // - Streetlight atmosphere + fog + subtle sky gradient
    // ======================
    (function(){
        // If fog not already present, add subtle night haze
        if (!scene.fog) {
            scene.fog = new THREE.FogExp2(0x05060a, 0.012);
        }

        // Sky gradient dome (cheap, improves spatial sense)
        const skyCanvas = document.createElement("canvas");
        skyCanvas.width = 64; skyCanvas.height = 512;
        const sctx = skyCanvas.getContext("2d");
        const grad = sctx.createLinearGradient(0,0,0,512);
        grad.addColorStop(0.00, "#02030a");
        grad.addColorStop(0.35, "#05081a");
        grad.addColorStop(1.00, "#0b0f22");
        sctx.fillStyle = grad;
        sctx.fillRect(0,0,64,512);
        const skyTex = new THREE.CanvasTexture(skyCanvas);
        const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide });
        const sky = new THREE.Mesh(new THREE.SphereGeometry(220, 24, 16), skyMat);
        sky.position.set(0, 0, 0);
        scene.add(sky);

        // Store dimensions if available
        const _storeW = (typeof storeW !== "undefined") ? storeW : 14.0;
        const _storeD = (typeof storeD !== "undefined") ? storeD : 12.0;
        const _cx = (typeof cx !== "undefined") ? cx : 0.0;
        const _cz = (typeof cz !== "undefined") ? cz : 0.0;

        const frontZ = _cz - _storeD/2; // store front plane
        const sidewalkZ = frontZ - 1.2;

        // Sidewalk slab + curb edge
        const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x8e8e8e, roughness: 0.95, metalness: 0.0 });
        const curbMat = new THREE.MeshStandardMaterial({ color: 0xa1a1a1, roughness: 0.95, metalness: 0.0 });
        const sidewalk = new THREE.Mesh(new THREE.BoxGeometry(_storeW + 6.0, 0.16, 2.4), sidewalkMat);
        sidewalk.position.set(_cx, 0.08, sidewalkZ);
        sidewalk.receiveShadow = true;
        scene.add(sidewalk);

        const curb = new THREE.Mesh(new THREE.BoxGeometry(_storeW + 6.0, 0.22, 0.22), curbMat);
        curb.position.set(_cx, 0.11, sidewalkZ - 1.15);
        curb.receiveShadow = true;
        scene.add(curb);

        // Storefront trim band (like fascia)
        const trimMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7, metalness: 0.12 });
        const trim = new THREE.Mesh(new THREE.BoxGeometry(_storeW + 0.6, 0.55, 0.35), trimMat);
        trim.position.set(_cx, 3.15, frontZ - 0.12);
        scene.add(trim);

        // Glowing store sign strip
        const signTex = makeLabelTexture("CONVENIENCE", { bg:"#0f1116", fg:"#ffffff", accent:"#00ff9a", font:"bold 86px Arial" });
        addDecalPlane(_cx, 3.15, frontZ - 0.30, 6.5, 0.65, 0.0, signTex, 0x00ff9a, 0.22, 0.004);

        // Storefront glass + mullions
        const glassMat = new THREE.MeshStandardMaterial({
            color: 0x0a0a0a,
            roughness: 0.18,
            metalness: 0.0,
            transparent: true,
            opacity: 0.45,
            emissive: 0x111111,
            emissiveIntensity: 0.15
        });
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.75, metalness: 0.1 });

        // Window bank parameters
        const winY = 1.55;
        const winH = 2.2;
        const winZ = frontZ - 0.18;

        const bankW = _storeW - 2.0;
        const leftX = _cx - bankW/2;
        const segments = 6;
        const segW = bankW / segments;

        for (let i=0;i<segments;i++){
            const x = leftX + segW*(i+0.5);
            const glass = new THREE.Mesh(new THREE.PlaneGeometry(segW-0.12, winH), glassMat);
            glass.position.set(x, winY, winZ);
            scene.add(glass);

            // vertical mullion
            const mull = new THREE.Mesh(new THREE.BoxGeometry(0.06, winH+0.1, 0.08), frameMat);
            mull.position.set(leftX + segW*i, winY, winZ+0.02);
            scene.add(mull);
        }
        // outer frames
        const topFrame = new THREE.Mesh(new THREE.BoxGeometry(bankW+0.10, 0.06, 0.08), frameMat);
        topFrame.position.set(_cx, winY + winH/2, winZ+0.02);
        scene.add(topFrame);
        const botFrame = new THREE.Mesh(new THREE.BoxGeometry(bankW+0.10, 0.06, 0.08), frameMat);
        botFrame.position.set(_cx, winY - winH/2, winZ+0.02);
        scene.add(botFrame);

        // Entry door + vestibule hint (double glass)
        const doorW = 1.25;
        const door = new THREE.Mesh(new THREE.PlaneGeometry(doorW, 2.35), glassMat);
        door.position.set(_cx + bankW/2 + 0.85, 1.55, winZ);
        scene.add(door);
        const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(doorW+0.12, 2.45, 0.10), frameMat);
        doorFrame.position.set(_cx + bankW/2 + 0.85, 1.55, winZ+0.03);
        scene.add(doorFrame);

        // Warm interior spill (helps realism)
        const spill = new THREE.PointLight(0xffd3a1, 0.9, 18, 1.6);
        spill.position.set(_cx + 2.0, 2.1, frontZ + 1.2);
        spill.castShadow = false;
        scene.add(spill);

        // Streetlights (warm/cool mix pools)
        function addStreetLight(x,z, warm=true){
            const poleMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.85, metalness: 0.2 });
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.10,6.5,10), poleMat);
            pole.position.set(x, 3.25, z);
            pole.castShadow = true;
            scene.add(pole);

            const arm = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.10, 0.10), poleMat);
            arm.position.set(x+0.55, 6.0, z);
            scene.add(arm);

            const head = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.16, 0.55), poleMat);
            head.position.set(x+1.05, 5.9, z);
            scene.add(head);

            const l = new THREE.SpotLight(warm ? 0xffd0a0 : 0xbdd7ff, warm ? 1.2 : 1.0, 40, Math.PI/5, 0.35, 1.2);
            l.position.set(x+1.05, 5.85, z);
            l.target.position.set(x+1.05, 0.0, z);
            scene.add(l);
            scene.add(l.target);

            // fake pool highlight
            const pool = new THREE.Mesh(new THREE.CircleGeometry(3.5, 24), new THREE.MeshStandardMaterial({
                color: warm ? 0x3a2a16 : 0x182538,
                roughness: 1.0,
                metalness: 0.0,
                transparent: true,
                opacity: 0.25
            }));
            pool.rotation.x = -Math.PI/2;
            pool.position.set(x+1.05, 0.01, z);
            scene.add(pool);
        }
        addStreetLight(-16,  6, false);
        addStreetLight( 18, -2, true);

        // Simple intersection markings for orientation (crosswalk + center lines)
        const lineMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.9 });
        const yellowMat = new THREE.MeshStandardMaterial({ color: 0xf0c000, roughness: 0.85 });
        function groundMark(x,z,w,d, mat){
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), mat);
            m.position.set(x, 0.006, z);
            scene.add(m);
        }
        // center dashed on main road (approx)
        for (let i=0;i<10;i++){
            groundMark(-12 + i*3.0, 10.5, 1.2, 0.12, yellowMat);
        }
        // crosswalk near corner
        for (let i=0;i<6;i++){
            groundMark(-6.5 + i*0.65, 7.8, 0.45, 2.4, lineMat);
        }

        // Store window "posters"/stickers (adds life)
        const hoursTex = makeLabelTexture("OPEN 24H", { bg:"#101010", fg:"#ffffff", accent:"#00ff9a", font:"bold 84px Arial" });
        addDecalPlane(_cx - 2.0, 1.35, winZ-0.02, 1.25, 0.55, 0.0, hoursTex, 0x00ff9a, 0.18, 0.003);
        const cardsTex = makeLabelTexture("CASH • CARD", { bg:"#101010", fg:"#ffffff", accent:"#ffb300", font:"bold 60px Arial" });
        addDecalPlane(_cx + 0.2, 1.05, winZ-0.02, 1.55, 0.50, 0.0, cardsTex, 0x402a00, 0.12, 0.003);
    })();
}

function createTarget(x, y, z, isHostile) {
    const geo = new THREE.BoxGeometry(0.8, 1.8, 0.1);
    const mat = new THREE.MeshStandardMaterial({ 
        color: isHostile ? 0xff0000 : 0x00ff00 
    });
    const target = new THREE.Mesh(geo, mat);
    target.position.set(x, y + 0.9, z);
    target.userData.isTarget = true;
    target.userData.isHostile = isHostile;
    target.userData.isHit = false;
    scene.add(target);
    entities.push(target);
}

function createBreachingCourse() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x888888 });

    // Series of doors to breach
    for (let i = 0; i < 5; i++) {
        createWall(0, 0, -i * 8, 8, 3, 0.3, wallMat);
        createDoor(0, 0, -i * 8 + 0.2, 0);
    }
}


function createSWATVan() {
    // V11: Hollow SWAT truck with open rear so the player can START inside and deploy out.
    // Map-only geometry. Does not touch controls/AI/weapons/LOS logic.
    const vanMat = new THREE.MeshStandardMaterial({ color: 0x121826, roughness: 0.85, metalness: 0.15 });
    const vanTrim = new THREE.MeshStandardMaterial({ color: 0x0b0f19, roughness: 0.9, metalness: 0.1 });
    const vanLight = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0x2aa7ff, emissiveIntensity: 1.0, roughness: 0.6 });

    // Truck placement: intersection outside the station
    const cx = -6.0;
    const cz = -18.0;
    const w = 3.2;
    const h = 2.6;
    const d = 6.4;
    const t = 0.18;   // wall thickness

    function addVanPiece(x,y,z, ww,hh,dd, mat) {
        const geo = new THREE.BoxGeometry(ww, hh, dd);
        const obj = new THREE.Mesh(geo, mat);
        obj.position.set(x, y + hh/2, z);
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.userData.isVan = true;
        scene.add(obj);
        entities.push(obj);
        return obj;
    }

    // Floor + roof
    addVanPiece(cx, 0.00, cz, w, 0.22, d, vanTrim);
    addVanPiece(cx, 0.00, cz, w, 0.18, d, vanTrim).position.y = 2.42; // roof slab shifted up

    // Side walls
    addVanPiece(cx - (w/2 - t/2), 0.00, cz, t, h, d, vanMat);
    addVanPiece(cx + (w/2 - t/2), 0.00, cz, t, h, d, vanMat);

    // Front wall (cab divider) - keep rear OPEN
    addVanPiece(cx, 0.00, cz - (d/2 - t/2), w, h, t, vanMat);

    // Small interior bench/gear block (cover-ish but still inside)
    const bench = addVanPiece(cx - 0.55, 0.00, cz + 0.6, 0.9, 0.55, 1.2, vanTrim);
    bench.userData.isCover = true;

    // Exterior bumper + wheel blocks (simple silhouette)
    const bumper = addVanPiece(cx, 0.00, cz + (d/2 - 0.2), w, 0.35, 0.4, vanTrim);
    bumper.userData.isCover = true;

    // Rear door "open" panels (VISUAL ONLY - no collision) so you can walk out
    const doorGeo = new THREE.BoxGeometry(1.45, 2.2, 0.08);
    const doorL = new THREE.Mesh(doorGeo, vanMat);
    const doorR = new THREE.Mesh(doorGeo, vanMat);
    doorL.position.set(cx - 0.9, 1.1, cz + d/2 - 0.12);
    doorR.position.set(cx + 0.9, 1.1, cz + d/2 - 0.12);
    doorL.rotation.y = Math.PI/2 * 0.9;
    doorR.rotation.y = -Math.PI/2 * 0.9;
    doorL.castShadow = doorR.castShadow = true;
    doorL.receiveShadow = doorR.receiveShadow = true;
    scene.add(doorL);
    scene.add(doorR);

    // Interior blue light strip (visual + mood)
    const lightGeo = new THREE.BoxGeometry(0.10, 0.08, 2.8);
    const strip = new THREE.Mesh(lightGeo, vanLight);
    strip.position.set(cx - (w/2 - 0.12), 2.1, cz);
    scene.add(strip);

    // A subtle point light inside the truck so it doesn't feel like a black void
    const inner = new THREE.PointLight(0x8bc8ff, 0.55, 8);
    inner.position.set(cx, 1.9, cz + 0.8);
    scene.add(inner);
}

// Create weapon model
function createWeaponModel() {
    const weaponGroup = new THREE.Group();

    // M4 style rifle
    const bodyGeo = new THREE.BoxGeometry(0.08, 0.12, 0.8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    const stockGeo = new THREE.BoxGeometry(0.06, 0.08, 0.3);
    const stock = new THREE.Mesh(stockGeo, bodyMat);
    stock.position.z = 0.5;

    const barrelGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.4, 8);
    const barrel = new THREE.Mesh(barrelGeo, bodyMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.55;

    const magGeo = new THREE.BoxGeometry(0.04, 0.15, 0.08);
    const mag = new THREE.Mesh(magGeo, bodyMat);
    mag.position.set(0, -0.12, 0.1);

    // Red dot sight
    const sightGeo = new THREE.BoxGeometry(0.04, 0.06, 0.08);
    const sightMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const sight = new THREE.Mesh(sightGeo, sightMat);
    sight.position.set(0, 0.09, -0.1);

    // Red dot
    const dotGeo = new THREE.SphereGeometry(0.005, 8, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.set(0, 0.09, -0.14);

    // Grip
    const gripGeo = new THREE.BoxGeometry(0.04, 0.1, 0.04);
    const grip = new THREE.Mesh(gripGeo, bodyMat);
    grip.position.set(0, -0.1, -0.15);
    grip.rotation.x = 0.3;

    weaponGroup.add(body);
    weaponGroup.add(stock);
    weaponGroup.add(barrel);
    weaponGroup.add(mag);
    weaponGroup.add(sight);
    weaponGroup.add(dot);
    weaponGroup.add(grip);

    return weaponGroup;
}

let weaponModel;

function setupWeapon() {
    weaponModel = createWeaponModel();
    weaponModel.position.set(0.3, -0.25, -0.5);
    camera.add(weaponModel);
    scene.add(camera);
}

// Input handlers
function onKeyDown(e) {
    keys[e.code] = true;

    if (gameState.phase !== 'active') return;

    // Weapon switching
    if (e.code === 'Digit1') switchWeapon(0);
    if (e.code === 'Digit2') switchWeapon(1);

    // Reload
    if (e.code === 'KeyR') reload();

    // Crouch
    if (e.code === 'KeyC') toggleCrouch();

    // Prone
    if (e.code === 'ControlLeft') toggleProne();

    // Lean
    if (e.code === 'KeyQ') gameState.leaning = -1;
    if (e.code === 'KeyE') gameState.leaning = 1;

    // Interact
    if (e.code === 'KeyF') interact();

    // Breach door if near one, otherwise throw flashbang
    if (e.code === 'KeyG') {
        const door = getNearestDoor(3);
        if (door) {
            breachDoor(door);
        } else {
            throwGrenade();
        }
    }

    // Team orders
    if (e.code === 'KeyT') {
        document.getElementById('order-wheel').classList.toggle('show');
    }

    // Sprint
    if (e.code === 'ShiftLeft') gameState.isSprinting = true;
}

function onKeyUp(e) {
    keys[e.code] = false;

    // Stop leaning
    if (e.code === 'KeyQ' && gameState.leaning === -1) gameState.leaning = 0;
    if (e.code === 'KeyE' && gameState.leaning === 1) gameState.leaning = 0;

    // Stop sprinting
    if (e.code === 'ShiftLeft') gameState.isSprinting = false;

    // Close order wheel
    if (e.code === 'KeyT') {
        document.getElementById('order-wheel').classList.remove('show');
    }
}

function onMouseDown(e) {
    if (gameState.phase !== 'active') return;

    if (e.button === 0) {
        mouseDown = true;
        shoot();
    } else if (e.button === 2) {
        gameState.isAiming = true;
        updateAimState();
    }
}

function onMouseUp(e) {
    if (e.button === 0) {
        mouseDown = false;
    } else if (e.button === 2) {
        gameState.isAiming = false;
        updateAimState();
    }
}

function onMouseMove(e) {
    if (gameState.phase !== 'active') return;
    if (document.pointerLockElement !== renderer.domElement) return;

    const sensitivity = gameState.isAiming ? 0.001 : 0.002;
    yaw -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;
    pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch));
}

function onWheel(e) {
    // Weapon scroll
    if (e.deltaY > 0) {
        switchWeapon((gameState.currentWeapon + 1) % gameState.weapons.length);
    } else {
        switchWeapon((gameState.currentWeapon - 1 + gameState.weapons.length) % gameState.weapons.length);
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Game functions
function switchWeapon(index) {
    gameState.currentWeapon = index;
    const weapon = gameState.weapons[index];
    document.getElementById('weapon-name').textContent = weapon.name;
    updateAmmoDisplay();

    // Update equipment slots
    document.querySelectorAll('.equip-slot').forEach((slot, i) => {
        slot.classList.toggle('active', i === index);
    });
}

function shoot() {
    if (gameState.isReloading) return;

    const weapon = gameState.weapons[gameState.currentWeapon];
    const now = Date.now();

    if (now - lastShot < weapon.fireRate * 1000) return;
    if (weapon.ammo <= 0) {
        reload();
        return;
    }

    lastShot = now;
    weapon.ammo--;
    updateAmmoDisplay();

    // Weapon recoil animation
    if (weaponModel) {
        weaponModel.position.z += 0.05;
        weaponModel.rotation.x -= 0.05;
        setTimeout(() => {
            weaponModel.position.z = gameState.isAiming ? -0.35 : -0.5;
            weaponModel.rotation.x = 0;
        }, 50);
    }

    // Muzzle flash effect
    createMuzzleFlash();

    // Raycast for hit detection
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    const intersects = raycaster.intersectObjects(entities, true);

    if (intersects.length > 0) {
        const hit = intersects[0];

        // Check what we hit
        let hitObject = hit.object;
        while (hitObject.parent && !hitObject.userData.isEnemy && !hitObject.userData.isTarget) {
            hitObject = hitObject.parent;
        }

        if (hitObject.userData.isEnemy && hitObject.userData.isAlive) {
            hitObject.userData.health -= weapon.damage;
            showHitMarker();

            if (hitObject.userData.health <= 0) {
                hitObject.userData.isAlive = false;
                hitObject.position.y = 0.3;
                hitObject.rotation.x = Math.PI / 2;
                gameState.suspectsNeutralized++;
                showNotification('SUSPECT NEUTRALIZED');
            }
        } else if (hitObject.userData.isTarget && !hitObject.userData.isHit) {
            hitObject.userData.isHit = true;
            hitObject.material.opacity = 0.3;

            if (hitObject.userData.isHostile) {
                gameState.score += 100;
                showNotification('+100 HOSTILE TARGET');
            } else {
                gameState.score -= 500;
                gameState.civiliansHarmed++;
                showNotification('-500 CIVILIAN!', '#ff3333');
            }
        } else if (hitObject.userData.isHostage) {
            gameState.civiliansHarmed++;
            showNotification('HOSTAGE HIT! MISSION FAILED', '#ff3333');
        }

        // Impact effect
        createImpactEffect(hit.point);
    }

    // Auto fire
    if (weapon.auto && mouseDown) {
        setTimeout(shoot, weapon.fireRate * 1000);
    }
}

function reload() {
    if (gameState.isReloading) return;

    const weapon = gameState.weapons[gameState.currentWeapon];
    if (weapon.ammo === weapon.maxAmmo || weapon.reserve <= 0) return;

    gameState.isReloading = true;
    showNotification('RELOADING...');

    // Reload animation
    if (weaponModel) {
        weaponModel.rotation.x = 0.3;
    }

    setTimeout(() => {
        const needed = weapon.maxAmmo - weapon.ammo;
        const available = Math.min(needed, weapon.reserve);
        weapon.ammo += available;
        weapon.reserve -= available;
        updateAmmoDisplay();
        gameState.isReloading = false;

        if (weaponModel) {
            weaponModel.rotation.x = 0;
        }
    }, 2000);
}

function toggleCrouch() {
    if (gameState.stance === 'crouching') {
        gameState.stance = 'standing';
        player.y = 1.7;
    } else {
        gameState.stance = 'crouching';
        player.y = 1.0;
    }
    updateStanceDisplay();
}

function toggleProne() {
    if (gameState.stance === 'prone') {
        gameState.stance = 'standing';
        player.y = 1.7;
    } else {
        gameState.stance = 'prone';
        player.y = 0.4;
    }
    updateStanceDisplay();
}

function updateAimState() {
    if (weaponModel) {
        if (gameState.isAiming) {
            weaponModel.position.set(0, -0.15, -0.35);
            camera.fov = 50;
        } else {
            weaponModel.position.set(0.3, -0.25, -0.5);
            camera.fov = 75;
        }
        camera.updateProjectionMatrix();
    }
}


// Nearest door helper (for context-sensitive breach with G)
function getNearestDoor(maxDist = 3) {
    let best = null;
    let bestDist = Infinity;

    for (const it of interactables) {
        if (it.type !== 'door') continue;
        const d = camera.position.distanceTo(it.mesh.position);
        if (d < maxDist && d < bestDist) {
            best = it.mesh;
            bestDist = d;
        }
    }
    return best;
}

function breachDoor(door) {
    if (!door) return;
    if (door.userData.isBreached) return;

    // Consume C2 if available
    if (gameState.equipment.c2 <= 0) {
        showNotification('NO C2 REMAINING', '#ff3333');
        return;
    }

    gameState.equipment.c2--;

    // Update HUD count for C2 slot (5th slot)
    const c2CountEl = document.querySelector('.equip-slot:nth-child(5) .count');
    if (c2CountEl) c2CountEl.textContent = 'x' + gameState.equipment.c2;

    door.userData.isBreached = true;
    door.userData.isOpen = true;

    // Remove collision so doorway is passable
    removeSolid(door);

    // Clear doorway: hide the leaf
    if (door.userData.leaf) door.userData.leaf.visible = false;

    // Remove door from interactables so prompt doesn't keep showing
    interactables = interactables.filter(it => it.mesh !== door);

    // Breach effect
    createImpactEffect(door.position.clone().add(new THREE.Vector3(0, 1.0, 0)));
    showNotification('DOOR BREACHED');
}

function interact() {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    for (const interactable of interactables) {
        const distance = camera.position.distanceTo(interactable.mesh.position);
        if (distance < 3) {
            if (interactable.type === 'door') {
                openDoor(interactable.mesh);
            } else if (interactable.type === 'hostage') {
                rescueHostage(interactable.mesh);
            }
            break;
        }
    }
}

function openDoor(door) {
    if (door.userData.isOpen || door.userData.isBreached) return;

    door.userData.isOpen = true;

    // Once opening starts, remove door from collision so you can flow through the doorway
    removeSolid(door);

    // Hinge open (swing clear of the doorway)
    const startRot = door.rotation.y;
    const targetRot = startRot + Math.PI / 2;

    const startTime = performance.now();
    const duration = 180; // ms

    function step(now) {
        const t = Math.min((now - startTime) / duration, 1);
        // easeOutCubic
        const e = 1 - Math.pow(1 - t, 3);
        door.rotation.y = startRot + (targetRot - startRot) * e;

        if (t < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
    showNotification('DOOR OPENED');
}

function rescueHostage(hostage) {
    if (hostage.userData.isRescued) return;

    hostage.userData.isRescued = true;
    gameState.hostagesRescued++;
    hostage.children.forEach(child => {
        child.material.color.setHex(0x00ff00);
    });
    showNotification('HOSTAGE SECURED! ' + gameState.hostagesRescued + '/' + gameState.hostagesTotal);
    gameState.score += 500;

    checkMissionComplete();
}

function throwGrenade() {
    if (gameState.equipment.flashbangs <= 0) return;

    gameState.equipment.flashbangs--;
    showNotification('FLASHBANG OUT!');

    // Create grenade projectile
    const grenadeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x444444 });
    const grenade = new THREE.Mesh(grenadeGeo, grenadeMat);

    grenade.position.copy(camera.position);
    const direction = new THREE.Vector3(0, 0, -1);
    direction.applyQuaternion(camera.quaternion);

    grenade.userData.velocity = direction.multiplyScalar(15);
    grenade.userData.velocity.y = 3;
    grenade.userData.isGrenade = true;
    grenade.userData.timer = 2;

    scene.add(grenade);
    effects.push(grenade);

    // Update equipment display
    document.querySelector('.equip-slot:nth-child(3) .count').textContent = 'x' + gameState.equipment.flashbangs;
}

function createMuzzleFlash() {
    const flashGeo = new THREE.SphereGeometry(0.1, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({ 
        color: 0xffff00,
        transparent: true,
        opacity: 1
    });
    const flash = new THREE.Mesh(flashGeo, flashMat);

    const worldPos = new THREE.Vector3();
    weaponModel.getWorldPosition(worldPos);

    const direction = new THREE.Vector3(0, 0, -1);
    direction.applyQuaternion(camera.quaternion);

    flash.position.copy(worldPos).add(direction.multiplyScalar(0.5));
    scene.add(flash);

    setTimeout(() => scene.remove(flash), 50);
}

function createImpactEffect(position) {
    const sparkGeo = new THREE.SphereGeometry(0.05, 4, 4);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    for (let i = 0; i < 5; i++) {
        const spark = new THREE.Mesh(sparkGeo, sparkMat);
        spark.position.copy(position);
        spark.userData.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 2,
            Math.random() * 2,
            (Math.random() - 0.5) * 2
        );
        spark.userData.life = 0.3;
        scene.add(spark);
        effects.push(spark);
    }
}

function showHitMarker() {
    const marker = document.getElementById('hit-marker');
    marker.classList.remove('show');
    void marker.offsetWidth; // Trigger reflow
    marker.classList.add('show');
}

function showNotification(text, color = '#ffaa00') {
    const notif = document.getElementById('notification');
    notif.textContent = text;
    notif.style.color = color;
    notif.classList.add('show');
    setTimeout(() => notif.classList.remove('show'), 2000);
}

function updateAmmoDisplay() {
    const weapon = gameState.weapons[gameState.currentWeapon];
    document.getElementById('ammo-count').innerHTML = 
        weapon.ammo + ' <span>/ ' + weapon.reserve + '</span>';
}

function updateHealthDisplay() {
    document.getElementById('health-fill').style.width = gameState.health + '%';
    document.getElementById('health-text').textContent = Math.round(gameState.health);
}

function updateStanceDisplay() {
    const indicator = document.getElementById('stance-indicator');
    if (gameState.stance === 'standing') {
        indicator.innerHTML = '<div class="stance-icon">🧍</div><div>STANDING</div>';
    } else if (gameState.stance === 'crouching') {
        indicator.innerHTML = '<div class="stance-icon">🧎</div><div>CROUCHING</div>';
    } else {
        indicator.innerHTML = '<div class="stance-icon">🏊</div><div>PRONE</div>';
    }
}

function updateLeanDisplay() {
    const indicator = document.getElementById('lean-indicator');
    indicator.classList.remove('left', 'right');
    if (gameState.leaning === -1) {
        indicator.classList.add('left');
        indicator.textContent = '◄ LEAN';
    } else if (gameState.leaning === 1) {
        indicator.classList.add('right');
        indicator.textContent = 'LEAN ►';
    }
}

function giveOrder(order) {
    document.getElementById('order-wheel').classList.remove('show');

    const orders = {
        'stack': 'ALPHA TEAM: STACK UP',
        'breach': 'ALPHA TEAM: BREACH AND CLEAR',
        'hold': 'ALPHA TEAM: HOLD POSITION',
        'flash': 'ALPHA TEAM: FLASH AND CLEAR',
        'cover': 'ALPHA TEAM: COVER ME',
        'move': 'ALPHA TEAM: MOVE UP',
        'fall_back': 'ALPHA TEAM: FALL BACK',
        'restrain': 'ALPHA TEAM: RESTRAIN SUSPECT'
    };

    showNotification(orders[order] || order.toUpperCase());
}

function checkMissionComplete() {
    if (gameState.mode === 'hostage') {
        if (gameState.hostagesRescued >= gameState.hostagesTotal) {
            showNotification('ALL HOSTAGES RESCUED! HEAD TO EXFIL', '#00ff88');
            gameState.phase = 'exfil';
        }
    }
}

function takeDamage(amount) {
    gameState.health -= amount;
    updateHealthDisplay();

    const overlay = document.getElementById('damage-overlay');
    overlay.classList.add('hit');
    setTimeout(() => overlay.classList.remove('hit'), 200);

    if (gameState.health <= 0) {
        gameState.phase = 'complete';
        showNotification('MISSION FAILED - OPERATOR DOWN', '#ff3333');
    }
}

// AI Update
function updateAI(delta) {
    // Cache blockers once per frame for aim-line raycasts
    updateSolids();
    const blockers = solids.map(s => s.obj);

    const toPlayer = new THREE.Vector3();
    const flatDir = new THREE.Vector3();
    const enemyForward = new THREE.Vector3(0, 0, 1);
    const muzzleWorld = new THREE.Vector3();
    const gunForward = new THREE.Vector3();

    entities.forEach(entity => {
        if (entity.userData.isEnemy && entity.userData.isAlive) {
            toPlayer.subVectors(camera.position, entity.position);
            const distance = toPlayer.length();

            // BODY/HEAD "vision" check (FOV + distance + LOS)
            flatDir.copy(toPlayer);
            flatDir.y = 0;
            const flatLen = flatDir.length();
            if (flatLen > 0.0001) flatDir.multiplyScalar(1 / flatLen);

            // Enemy forward based on current yaw
            enemyForward.set(0, 0, 1).applyQuaternion(entity.quaternion);
            enemyForward.y = 0;
            const fLen = enemyForward.length();
            if (fLen > 0.0001) enemyForward.multiplyScalar(1 / fLen);

            const fovRad = THREE.MathUtils.degToRad(entity.userData.fovDeg || 80);
            const halfFov = fovRad * 0.5;
            const angleToPlayer = Math.acos(THREE.MathUtils.clamp(enemyForward.dot(flatDir), -1, 1));

            const withinVision = (distance < (entity.userData.viewDistance || 22)) && (angleToPlayer <= halfFov);

            if (withinVision && enemyHasLineOfSight(entity)) {
                entity.userData.isAlert = true;
            }

            // Rotate body (yaw only) toward player once alerted (keeps posture stable)
            if (entity.userData.isAlert && flatLen > 0.0001) {
                const desiredYaw = Math.atan2(flatDir.x, flatDir.z);
                entity.rotation.y = desiredYaw;
            }

            // Weapon posture + aiming
            if (entity.userData.gunPivot && entity.userData.gun) {
                if (entity.userData.isAlert) {
                    // Aim pivot at player (matches where the gun points)
                    const aimTarget = new THREE.Vector3(camera.position.x, camera.position.y - 0.15, camera.position.z);
                    entity.userData.gunPivot.lookAt(aimTarget);

                    // Slight ergonomic offsets so it looks like a shouldered rifle
                    entity.userData.gunPivot.rotation.x = THREE.MathUtils.clamp(entity.userData.gunPivot.rotation.x, -0.6, 0.35);
                    entity.userData.gunPivot.rotation.y = THREE.MathUtils.clamp(entity.userData.gunPivot.rotation.y, -1.2, 1.2);
                    entity.userData.gunPivot.rotation.z = 0;

                    // Raise the gun a touch (visual)
                    entity.userData.gunPivot.position.y = 0.40;
                } else {
                    // Not alert: lower the weapon
                    entity.userData.gunPivot.rotation.set(-0.55, 0, 0);
                    entity.userData.gunPivot.position.y = 0.34;
                }
            }

            // Determine if they're ACTIVELY AIMING at the player (tight cone + muzzle LOS)
            entity.userData.aimingAtPlayer = false;
            if (entity.userData.isAlert && entity.userData.muzzle) {
                entity.userData.muzzle.getWorldPosition(muzzleWorld);

                // Gun forward = +Z in muzzle local space -> world space
                gunForward.set(0, 0, 1);
                if (entity.userData.gunPivot) {
                    gunForward.applyQuaternion(entity.userData.gunPivot.getWorldQuaternion(new THREE.Quaternion()));
                } else {
                    gunForward.applyQuaternion(entity.quaternion);
                }
                gunForward.normalize();

                const muzzleToPlayer = new THREE.Vector3().subVectors(camera.position, muzzleWorld).normalize();
                const aimConeRad = THREE.MathUtils.degToRad(entity.userData.aimFovDeg || 18) * 0.5;
                const aimAngle = Math.acos(THREE.MathUtils.clamp(gunForward.dot(muzzleToPlayer), -1, 1));

                if (aimAngle <= aimConeRad && enemyGunHasLineOfSight(entity)) {
                    entity.userData.aimingAtPlayer = true;
                }
            }

            // Aim line: show where the gun is pointing when alert (matches weapon direction)
            if (entity.userData.aimLine && entity.userData.muzzle) {
                if (!entity.userData.isAlert) {
                    entity.userData.aimLine.visible = false;
                } else {
                    entity.userData.aimLine.visible = true;

                    // Start at muzzle
                    entity.userData.muzzle.getWorldPosition(_losFrom);

                    // Direction = gun forward
                    gunForward.set(0, 0, 1);
                    if (entity.userData.gunPivot) {
                        gunForward.applyQuaternion(entity.userData.gunPivot.getWorldQuaternion(new THREE.Quaternion()));
                    } else {
                        gunForward.applyQuaternion(entity.quaternion);
                    }
                    gunForward.normalize();
                    _losDir.copy(gunForward);

                    // Raycast forward so the line stops on the first wall/door/cover (realistic read)
                    _losRaycaster.set(_losFrom, _losDir);
                    _losRaycaster.far = 28;

                    const hits = _losRaycaster.intersectObjects(blockers, true);
                    if (hits.length > 0) {
                        _losTo.copy(hits[0].point);
                    } else {
                        _losTo.copy(_losFrom).add(_losDir.multiplyScalar(28));
                    }

                    // Update line geometry
                    const pts = entity.userData.aimLine.geometry.attributes.position.array;
                    pts[0] = _losFrom.x; pts[1] = _losFrom.y; pts[2] = _losFrom.z;
                    pts[3] = _losTo.x;   pts[4] = _losTo.y;   pts[5] = _losTo.z;
                    entity.userData.aimLine.geometry.attributes.position.needsUpdate = true;

                    // Subtle: brighten line if they're actively aiming at YOU
                    entity.userData.aimLine.material.opacity = entity.userData.aimingAtPlayer ? 0.65 : 0.28;
                }
            }

            // Shooting (keeps your existing behavior, but now uses true LOS and alert state)
            if (entity.userData.isAlert) {
                const now = Date.now();
                if (now - entity.userData.lastShot > 2000 && distance < 15) {
                    entity.userData.lastShot = now;
                    // Enemy shoots at player (requires line-of-sight; no shooting through walls)
                    if (Math.random() < 0.3 && enemyHasLineOfSight(entity)) {
                        takeDamage(10);
                    }
                }
            }
        }

        if (entity.userData.isRioter) {
            // Riot AI - random movement
            entity.position.x += (Math.random() - 0.5) * 0.02;
            entity.position.z += (Math.random() - 0.5) * 0.02;
        }
    });
}

// Effects Update
function updateEffects(delta) {
    effects = effects.filter(effect => {
        if (effect.userData.velocity) {
            effect.position.add(effect.userData.velocity.clone().multiplyScalar(delta));
            effect.userData.velocity.y -= 9.8 * delta;

            if (effect.userData.life !== undefined) {
                effect.userData.life -= delta;
                if (effect.userData.life <= 0) {
                    scene.remove(effect);
                    return false;
                }
            }

            // Grenade explosion
            if (effect.userData.isGrenade) {
                effect.userData.timer -= delta;
                if (effect.userData.timer <= 0 || effect.position.y < 0) {
                    // Flash effect
                    showNotification('BANG!');
                    scene.remove(effect);
                    return false;
                }
            }
        }
        return true;
    });
}

// Player Movement
function updatePlayer(delta) {
    const speed = gameState.isSprinting ? 8 : (gameState.stance === 'crouching' ? 2 : 
                 gameState.stance === 'prone' ? 1 : 4);

    const moveX = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
    const moveZ = (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0);

    // No movement input
    if (moveX === 0 && moveZ === 0) {
        // Still update camera orientation & lean
        camera.position.set(player.x, player.y, player.z);
        camera.rotation.order = 'YXZ';
        camera.rotation.y = yaw;
        camera.rotation.x = pitch;
        camera.rotation.z = gameState.leaning * 0.2;
        updateLeanDisplay();
        return;
    }

    const forward = new THREE.Vector3(0, 0, moveZ);
    const right = new THREE.Vector3(moveX, 0, 0);

    forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    right.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

    const movement = forward.add(right).normalize().multiplyScalar(speed * delta);

    // --- Collision: sweep X then Z ---
    // Update solid boxes occasionally (doors can animate)
    updateSolids();

    const ny = player.y;

    // X axis
    const nx = player.x + movement.x;
    if (!playerCollidesAt(nx, ny, player.z)) {
        player.x = nx;
    }

    // Z axis
    const nz = player.z + movement.z;
    if (!playerCollidesAt(player.x, ny, nz)) {
        player.z = nz;
    }

    // Update camera transform
    camera.position.set(player.x, player.y, player.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    // Apply lean
    camera.rotation.z = gameState.leaning * 0.2;
    updateLeanDisplay();
}

// Check Interactions
function checkInteractions() {
    let nearestInteractable = null;
    let nearestDistance = Infinity;

    for (const interactable of interactables) {
        const distance = camera.position.distanceTo(interactable.mesh.position);
        if (distance < 3 && distance < nearestDistance) {
            nearestDistance = distance;
            nearestInteractable = interactable;
        }
    }

    const prompt = document.getElementById('interaction-prompt');
    if (nearestInteractable) {
        prompt.innerHTML = nearestInteractable.prompt
            .replace('[F]', '<span>[F]</span>')
            .replace('[G]', '<span>[G]</span>');
        prompt.style.display = 'block';
    } else {
        prompt.style.display = 'none';
    }
}

// Mission Timer
let missionStartTime;

function updateMissionTimer() {
    if (gameState.phase !== 'active') return;

    const elapsed = (Date.now() - missionStartTime) / 1000;
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    document.getElementById('mission-timer').textContent = 
        String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

// Start Mission
function startMission(type) {
    if (type !== 'hostage') type = 'hostage';
    gameState.mode = type;
    gameState.phase = 'active';
    gameState.health = 100;
    gameState.hostagesRescued = 0;
    gameState.suspectsNeutralized = 0;
    gameState.civiliansHarmed = 0;
    gameState.score = 0;

    // Reset weapons
    gameState.weapons.forEach(w => {
        w.ammo = w.maxAmmo;
    });
    gameState.equipment.flashbangs = 3;
    gameState.equipment.smoke = 2;
    gameState.equipment.c2 = 2;

    // Set mission title
    const titles = {
        'hostage': 'OPERATION NIGHTFALL',
        'raid': 'OPERATION IRON FIST',
        'active_shooter': 'ACTIVE THREAT RESPONSE',
        'riot': 'CIVIL UNREST CONTROL',
        'shoot_house': 'SHOOT HOUSE TRAINING',
        'breaching': 'BREACHING COURSE'
    };

    const objectives = {
        'hostage': 'Rescue all hostages and neutralize threats',
        'raid': 'Secure the building and arrest all suspects',
        'active_shooter': 'Locate and neutralize active threat',
        'riot': 'Maintain line and protect property',
        'shoot_house': 'Clear all hostile targets, avoid civilians',
        'breaching': 'Practice door breaching techniques'
    };

    document.getElementById('mission-title').textContent = titles[type];
    document.getElementById('mission-objective').textContent = objectives[type];

    // Hide menu, show HUD
    document.getElementById('menu-screen').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('minimap').classList.remove('hidden');

    // Create environment
    createEnvironment(type);
    setupWeapon();

    // Reset player position (spawn INSIDE the SWAT truck, intersection outside the station)
    player.x = -6.0;
    player.y = 1.7;
    player.z = -16.6;
    ensurePlayerNotStuck();
    yaw = Math.PI; // face toward the storefront (+Z)
    pitch = 0;

    // Request pointer lock
    renderer.domElement.requestPointerLock();

    missionStartTime = Date.now();

    // Update displays
    updateAmmoDisplay();
    updateHealthDisplay();
    updateStanceDisplay();
}

// Animation Loop
let lastTime = 0;

function animate(time) {
    requestAnimationFrame(animate);

    const delta = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    if (gameState.phase === 'active') {
        updatePlayer(delta);
        updateAI(delta);
        updateEffects(delta);
        checkInteractions();
        updateMissionTimer();
    }

    renderer.render(scene, camera);
}

// Initialize
init();
