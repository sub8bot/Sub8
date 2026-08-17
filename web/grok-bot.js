import * as THREE from 'three';

const _face = new THREE.Vector3();
const _right = new THREE.Vector3();
const _long = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eyeRight = new THREE.Vector3();
const _eyeLong = new THREE.Vector3();
const _basis = new THREE.Matrix4();

function heartGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.12);
  s.bezierCurveTo(-0.15, -0.012, -0.17, 0.125, 0, 0.098);
  s.bezierCurveTo(0.17, 0.125, 0.15, -0.012, 0, -0.12);
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false, curveSegments: 14 });
  geo.translate(0, 0, -0.02);
  return geo;
}

function starGeometry() {
  const s = new THREE.Shape();
  const spikes = 5;
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 === 0 ? 0.118 : 0.048;
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.036, bevelEnabled: false });
  geo.translate(0, 0, -0.018);
  return geo;
}

function taperedTube(curve, tubular, radial, r0, r1, power = 2.6) {
  const frames = curve.computeFrenetFrames(tubular, false);
  const cols = radial + 1;
  const positions = new Float32Array((tubular + 1) * cols * 3);
  const normals = new Float32Array(positions.length);
  const indices = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const u = i / tubular;
    curve.getPointAt(u, p);
    const n = frames.normals[i];
    const bn = frames.binormals[i];
    const rad = r0 + (r1 - r0) * Math.pow(u, power);
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const cx = Math.cos(v);
      const cy = Math.sin(v);
      const nx = n.x * cx + bn.x * cy;
      const ny = n.y * cx + bn.y * cy;
      const nz = n.z * cx + bn.z * cy;
      const idx = (i * cols + j) * 3;
      positions[idx] = p.x + nx * rad;
      positions[idx + 1] = p.y + ny * rad;
      positions[idx + 2] = p.z + nz * rad;
      normals[idx] = nx;
      normals[idx + 1] = ny;
      normals[idx + 2] = nz;
    }
  }
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j;
      const b = a + cols;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

const DEFAULTS = {
  radius: 1,
  color: 0xe8eaee,
  eyeColor: 0x0a0a0a,
  eyeTilt: -22,
  eyeWidth: 0.22,
  eyeHeight: 0.52,
  eyeSpacing: 0.38,
  eyeElevation: 0.1,
  eyeFlatten: 0.2,
  mouthWidth: 0.078,
  mouthHeight: 0.024,
  mouthElevation: -0.2,
};

function face(label, extra = {}) {
  return {
    tilt: -22,
    spacing: 0.4,
    elevation: 0.1,
    lTilt: 0,
    rTilt: 0,
    eyeY: 1,
    eyeX: 1,
    winkL: false,
    winkR: false,
    eye: 'stadium',
    mouth: 'none',
    blink: true,
    blush: false,
    tears: false,
    feel: 'neutral',
    label,
    ...extra,
  };
}

export const EXPRESSIONS = {
  neutral: face('😐 Neutral', { mouth: 'dash' }),
  slight: face('🙂 Slight', { tilt: -16, eyeY: 0.9, mouth: 'small', feel: 'happy' }),
  happy: face('😊 Happy', { tilt: -14, spacing: 0.33, elevation: 0.08, eyeY: 0.64, eyeX: 1.1, mouth: 'smile', blush: true, feel: 'happy' }),
  blush: face('☺️ Blush', { tilt: -10, spacing: 0.32, elevation: 0.06, eyeY: 0.46, eyeX: 1.16, mouth: 'smile', blush: true, feel: 'happy' }),
  grin: face('😁 Grin', { tilt: -12, spacing: 0.32, elevation: 0.07, eyeY: 0.42, eyeX: 1.18, mouth: 'grin', feel: 'happy' }),
  beam: face('😄 Beam', { tilt: -8, spacing: 0.35, elevation: 0.1, eyeY: 0.78, eyeX: 1.08, mouth: 'grin', feel: 'happy' }),
  laugh: face('😆 Laugh', { tilt: -6, spacing: 0.3, elevation: 0.05, eyeY: 0.24, eyeX: 1.32, mouth: 'grin', feel: 'happy' }),
  joy: face('😂 Joy', { tilt: -4, spacing: 0.3, elevation: 0.04, eyeY: 0.2, eyeX: 1.32, mouth: 'grin', tears: 2, feel: 'happy' }),
  rofl: face('🤣 ROFL', { tilt: 18, spacing: 0.28, elevation: 0.02, eyeY: 0.16, eyeX: 1.36, mouth: 'grin', feel: 'happy' }),
  party: face('🥳 Party', { tilt: -18, spacing: 0.34, elevation: 0.1, eyeY: 0.72, mouth: 'grin', feel: 'happy' }),
  hug: face('🤗 Hug', { tilt: -8, spacing: 0.38, elevation: 0.08, eyeY: 0.6, mouth: 'smile', feel: 'happy' }),

  wink: face('😉 Wink', { tilt: -18, spacing: 0.33, elevation: 0.09, winkL: true, mouth: 'smile', feel: 'wink' }),
  smirk: face('😏 Smirk', { tilt: -28, spacing: 0.32, elevation: 0.1, lTilt: -0.1, rTilt: 0.22, eyeY: 0.78, mouth: 'smirk', feel: 'smirk' }),
  love: face('😍 Love', { tilt: -6, spacing: 0.42, elevation: 0.1, eye: 'heart', mouth: 'smile', feel: 'love' }),
  hearts: face('🥰 Hearts', { tilt: -10, spacing: 0.34, elevation: 0.08, eyeY: 0.52, eyeX: 1.12, mouth: 'smile', blush: true, feel: 'love' }),
  kiss: face('😘 Kiss', { tilt: -20, spacing: 0.32, elevation: 0.09, winkL: true, mouth: 'kiss', blush: true, feel: 'wink' }),
  kissing: face('😗 Kissing', { tilt: -6, spacing: 0.34, elevation: 0.08, eyeY: 0.86, mouth: 'kiss', feel: 'neutral' }),
  star: face('🤩 Star', { tilt: 0, spacing: 0.44, elevation: 0.13, eye: 'star', mouth: 'grin', feel: 'wow' }),

  yum: face('😋 Yum', { tilt: -10, spacing: 0.32, elevation: 0.07, eyeY: 0.3, eyeX: 1.26, mouth: 'tongue', feel: 'happy' }),
  tongue: face('😛 Tongue', { tilt: -4, spacing: 0.34, elevation: 0.1, mouth: 'tongue', feel: 'happy' }),
  winkTongue: face('😜 Wink tongue', { tilt: -16, spacing: 0.32, elevation: 0.09, winkL: true, mouth: 'tongue', feel: 'wink' }),
  zany: face('🤪 Zany', {
    tilt: 12,
    spacing: 0.42,
    elevation: 0.13,
    lTilt: 0.32,
    rTilt: -0.42,
    lEyeY: 0.34,
    lEyeX: 1.55,
    rEyeY: 1.12,
    rEyeX: 0.88,
    mouth: 'tongue',
    feel: 'zany',
  }),
  squintTongue: face('😝 Squint tongue', { tilt: -2, spacing: 0.3, elevation: 0.04, eyeY: 0.18, eyeX: 1.32, mouth: 'tongue', feel: 'happy' }),

  think: face('🤔 Think', { tilt: 6, spacing: 0.36, elevation: 0.14, lTilt: 0.48, rTilt: 0.08, mouth: 'dash', feel: 'confused' }),
  raised: face('🤨 Raised', { tilt: -16, spacing: 0.34, elevation: 0.11, lTilt: 0.55, rTilt: -0.06, mouth: 'dash', feel: 'deadpan' }),
  unamused: face('😒 Unamused', { tilt: -18, spacing: 0.32, elevation: 0.07, lTilt: 0.16, eyeY: 0.58, mouth: 'dash', feel: 'deadpan' }),
  expressionless: face('😑 Flat', { tilt: -22, spacing: 0.34, elevation: 0.07, eyeY: 0.3, eyeX: 1.28, mouth: 'dash', blink: false, feel: 'deadpan' }),
  deadpan: face('😐 Deadpan', { tilt: -22, spacing: 0.34, elevation: 0.08, eyeY: 0.72, eyeX: 1.14, mouth: 'dash', feel: 'deadpan' }),
  nomouth: face('😶 No mouth'),
  eyeroll: face('🙄 Eye roll', { tilt: 10, spacing: 0.36, elevation: 0.24, eyeY: 0.48, eyeX: 1.22, mouth: 'dash', feel: 'eyeroll' }),
  grimace: face('😬 Grimace', { tilt: 4, spacing: 0.34, elevation: 0.1, eyeY: 0.7, eyeX: 1.2, mouth: 'grimace', feel: 'scared' }),
  shush: face('🤫 Shush', { tilt: -12, spacing: 0.32, elevation: 0.09, winkR: true, mouth: 'dash', feel: 'wink' }),
  oops: face('🤭 Oops', { tilt: -8, spacing: 0.32, elevation: 0.08, eyeY: 0.54, mouth: 'oh', feel: 'happy' }),
  cool: face('😎 Cool', { tilt: -26, spacing: 0.32, elevation: 0.08, eyeY: 0.2, eyeX: 1.5, mouth: 'smirk', feel: 'smirk' }),

  sleepy: face('😪 Sleepy', { tilt: -8, spacing: 0.32, elevation: 0.04, eyeY: 0.2, eyeX: 1.22, mouth: 'dash', tears: 1, blink: false, feel: 'sleepy' }),
  sleep: face('😴 Sleep', { tilt: 16, spacing: 0.3, elevation: 0.02, eyeY: 0.1, eyeX: 1.32, mouth: 'dash', blink: false, feel: 'sleepy' }),
  yawn: face('🥱 Yawn', { tilt: 14, spacing: 0.32, elevation: 0.03, eyeY: 0.14, eyeX: 1.28, mouth: 'oh', blink: false, feel: 'sleepy' }),
  relieved: face('😌 Relieved', { tilt: -10, spacing: 0.32, elevation: 0.06, eyeY: 0.34, eyeX: 1.18, mouth: 'small', feel: 'sleepy' }),
  drool: face('🤤 Drool', { tilt: 16, spacing: 0.32, elevation: 0.03, eyeY: 0.22, eyeX: 1.24, mouth: 'tongue', blink: false, feel: 'sleepy' }),

  sad: face('😢 Sad', { tilt: 16, spacing: 0.3, elevation: 0.06, lTilt: 0.14, rTilt: -0.14, eyeY: 0.86, mouth: 'frown', tears: 1, feel: 'sad' }),
  pensive: face('😔 Pensive', { tilt: 18, spacing: 0.3, elevation: 0.04, lTilt: 0.12, rTilt: -0.12, eyeY: 0.5, mouth: 'dash', feel: 'sad' }),
  disappointed: face('😞 Down', { tilt: 14, spacing: 0.32, elevation: 0.05, eyeY: 0.76, mouth: 'frown', feel: 'sad' }),
  cry: face('😭 Cry', { tilt: 12, spacing: 0.3, elevation: 0.04, eyeY: 0.22, eyeX: 1.26, mouth: 'oh', tears: 2, feel: 'sad' }),
  weary: face('😩 Weary', { tilt: 10, spacing: 0.32, elevation: 0.05, lTilt: 0.22, rTilt: -0.22, eyeY: 0.38, eyeX: 1.22, mouth: 'oh', feel: 'sad' }),
  pleading: face('🥺 Plead', { tilt: 6, spacing: 0.44, elevation: 0.15, eyeY: 0.88, eyeX: 1.5, mouth: 'small', blush: true, feel: 'sad' }),
  worried: face('😟 Worry', { tilt: 10, spacing: 0.36, elevation: 0.1, lTilt: 0.18, rTilt: -0.18, eyeY: 0.92, mouth: 'frown', feel: 'sad' }),
  confused: face('😕 Confused', { tilt: -6, spacing: 0.4, elevation: 0.2, eyeY: 0.7, lTilt: 0.38, rTilt: -0.06, mouth: 'frown', feel: 'confused' }),

  wow: face('😮 Wow', { tilt: 0, spacing: 0.4, elevation: 0.14, eyeY: 0.55, eyeX: 1.55, mouth: 'oh', blink: false, feel: 'wow' }),
  hushed: face('😯 Hushed', { tilt: 2, spacing: 0.36, elevation: 0.12, eyeY: 0.68, eyeX: 1.28, mouth: 'oh', blink: false, feel: 'wow' }),
  flushed: face('😳 Flush', { tilt: 4, spacing: 0.4, elevation: 0.14, eyeY: 0.74, eyeX: 1.42, mouth: 'oh', blush: true, blink: false, feel: 'wow' }),
  gasp: face('😲 Gasp', { tilt: -4, spacing: 0.42, elevation: 0.17, eyeY: 0.46, eyeX: 1.62, mouth: 'oh', blink: false, feel: 'wow' }),
  dizzy: face('😵 Dizzy', { tilt: 6, spacing: 0.4, elevation: 0.12, eye: 'x', mouth: 'oh', blink: false, feel: 'wow' }),
  woozy: face('🥴 Woozy', {
    tilt: 12,
    spacing: 0.4,
    elevation: 0.1,
    lTilt: 0.36,
    rTilt: 0.16,
    lEyeY: 0.42,
    rEyeY: 1.02,
    mouth: 'wavy',
    feel: 'zany',
  }),
  nauseous: face('🤢 Sick', { tilt: 16, spacing: 0.3, elevation: 0.03, eyeY: 0.4, mouth: 'wavy', feel: 'sad' }),
  hot: face('🥵 Hot', { tilt: 4, spacing: 0.34, elevation: 0.1, eyeY: 0.56, eyeX: 1.28, mouth: 'tongue', feel: 'wow' }),
  cold: face('🥶 Cold', { tilt: 8, spacing: 0.4, elevation: 0.12, eyeY: 0.72, eyeX: 1.22, mouth: 'grimace', feel: 'scared' }),

  scared: face('😨 Scared', { tilt: 6, spacing: 0.46, elevation: 0.16, lTilt: -0.14, rTilt: 0.14, eyeY: 0.76, eyeX: 1.32, mouth: 'oh', blink: false, feel: 'scared' }),
  scream: face('😱 Scream', { tilt: 4, spacing: 0.5, elevation: 0.18, eyeY: 0.58, eyeX: 1.58, mouth: 'oh', blink: false, feel: 'scared' }),

  angry: face('😠 Angry', { tilt: 0, spacing: 0.3, elevation: 0.1, lTilt: 0.44, rTilt: -0.44, eyeY: 0.9, eyeX: 1.1, mouth: 'frown', feel: 'angry' }),
  rage: face('😡 Rage', { tilt: 4, spacing: 0.28, elevation: 0.1, lTilt: 0.56, rTilt: -0.56, eyeY: 0.8, eyeX: 1.16, mouth: 'frown', feel: 'angry' }),
  steam: face('😤 Steam', { tilt: 2, spacing: 0.3, elevation: 0.08, lTilt: 0.4, rTilt: -0.4, eyeY: 0.46, eyeX: 1.18, mouth: 'dash', feel: 'angry' }),
};

export const ANIMATIONS = {
  none: { label: 'Still' },
  idle: { label: 'Idle' },
  bounce: { label: 'Bounce' },
  hop: { label: 'Hop' },
  float: { label: 'Float' },
  sway: { label: 'Sway' },
  wiggle: { label: 'Wiggle' },
  spin: { label: 'Spin' },
  twirl: { label: 'Twirl' },
  nod: { label: 'Nod' },
  shake: { label: 'Shake' },
  look: { label: 'Look' },
  peek: { label: 'Peek' },
  excited: { label: 'Excited' },
  cheer: { label: 'Cheer' },
  dance: { label: 'Dance' },
  talk: { label: 'Talk' },
  sleep: { label: 'Sleep' },
  stretch: { label: 'Stretch' },
  shiver: { label: 'Shiver' },
  pulse: { label: 'Pulse' },
};

const MOVED = new Set(Object.keys(ANIMATIONS).filter((id) => id !== 'none'));

export const BODIES = {
  smooth: { label: 'Smooth', kind: 'octopus' },
};

export function isOctopusBody() {
  return true;
}

const OCTO = {
  smooth: {
    hip: false,
    attach: [0.5, -0.6, 0.9],
    into: -0.58,
    r0: 0.175,
    flareR0: 0.175,
    r1: 0.042,
    flareAt: 2,
    hangAt: 2,
    knob: 0,
    cap: false,
    segs: 28,
    taper: 3.1,
    flare: [0.32, -0.16, 0.32, 0.72, -0.02, 0.72, 0.9, 0.12, 0.8],
    hang: [0.32, -0.16, 0.32, 0.72, -0.02, 0.72, 0.9, 0.12, 0.8],
    back: [0.32, -0.16, 0.32, 0.72, -0.02, 0.72, 0.9, 0.12, 0.8],
  },
};

/**
 * Procedural OctoBot — Smooth octopus body, emoji faces, looping motions.
 * Drop into any Three.js scene: `scene.add(new GrokBot())`.
 */
export class GrokBot extends THREE.Group {
  constructor(options = {}) {
    super();
    this.name = 'GrokBot';

    const opts = { ...DEFAULTS, ...options };
    this.radius = opts.radius;
    this.autoIdle = false;
    this.autoMouth = false;
    this.autoBlink = true;
    this.expression = 'neutral';
    this._feel = 'neutral';
    this.animation = 'none';
    this.bodyType = 'smooth';

    this._blink = 1;
    this._blinkTo = 1;
    this._blinkTimer = 2.4 + Math.random() * 2;
    this._doubleBlink = false;
    this._mouth = 0;
    this._mouthTo = 0;
    this._mouthHold = false;
    this._mouthTimer = 0;
    this._mouthShape = 'none';
    this._elapsed = 0;
    this._flatten = opts.eyeFlatten;
    this._winkL = false;
    this._winkR = false;
    this._eyeBase = {
      l: { x: 1, y: 1, z: this._flatten },
      r: { x: 1, y: 1, z: this._flatten },
    };
    this._talk = 0;

    this.bodyMaterial = new THREE.MeshPhysicalMaterial({
      color: opts.color,
      roughness: 0.3,
      metalness: 0,
      clearcoat: 0.32,
      clearcoatRoughness: 0.22,
      sheen: 0.12,
      sheenColor: 0xffffff,
      envMapIntensity: 0.85,
    });

    this.eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x111111 });
    this.whiteMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.pupilMaterial = new THREE.MeshBasicMaterial({ color: 0x111111 });
    this.accentMaterial = new THREE.MeshBasicMaterial({ color: 0xff2d55, side: THREE.DoubleSide });
    this.starMaterial = new THREE.MeshBasicMaterial({ color: 0xffcc00, side: THREE.DoubleSide });
    this.tearMaterial = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    this.blushMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6b8a,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.fillMaterial = new THREE.MeshBasicMaterial({ color: 0xfffaf3 });

    this.body = new THREE.Mesh(
      new THREE.SphereGeometry(opts.radius, 64, 48),
      this.bodyMaterial,
    );
    this.body.name = 'GrokBot_Head';
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.add(this.body);

    this.eyes = new THREE.Group();
    this.eyes.name = 'GrokBot_Eyes';
    this.add(this.eyes);
    this._buildEyes(opts);
    this._buildCheeks(opts);
    this._buildMouths(opts);
    this.tentacles = null;
    this._tentacleProfile = null;
    this._arms = [];
    this.setExpression('neutral');
    this.setBody('smooth');

    this.userData.parts = {
      body: this.body,
      eyes: this.eyes,
      eyeL: this.eyeL,
      eyeR: this.eyeR,
      mouths: this.mouths,
      tentacles: this.tentacles,
    };
  }

  _buildEyes(opts) {
    const r = opts.radius;
    const eyeRadius = r * opts.eyeWidth * 0.5;
    const eyeLength = Math.max(0.001, r * opts.eyeHeight - eyeRadius * 2);
    this._eyeGeometry = new THREE.CapsuleGeometry(eyeRadius, eyeLength, 8, 20);
    this._eyeGeos = {
      stadium: this._eyeGeometry,
      round: new THREE.SphereGeometry(r * 0.095, 16, 12),
      crescent: new THREE.TubeGeometry(
        new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(-0.085, 0.026, 0),
          new THREE.Vector3(0, -0.062, 0),
          new THREE.Vector3(0.085, 0.026, 0),
        ),
        14,
        0.024,
        8,
        false,
      ),
      line: new THREE.CapsuleGeometry(r * 0.018, r * 0.12, 4, 8),
      heart: heartGeometry(),
      star: starGeometry(),
      x: new THREE.CapsuleGeometry(r * 0.016, r * 0.12, 4, 8),
      dot: new THREE.SphereGeometry(r * 0.05, 12, 10),
      spiral: new THREE.TorusGeometry(r * 0.05, r * 0.016, 8, 18),
      wide: new THREE.SphereGeometry(r * 0.11, 16, 12),
      pupil: new THREE.SphereGeometry(r * 0.044, 12, 10),
    };
    this.eyeL = this._makeEye('L');
    this.eyeR = this._makeEye('R');
    this.eyes.add(this.eyeL, this.eyeR);
  }

  _makeEye(side) {
    const g = new THREE.Group();
    g.name = `GrokBot_Eye${side}`;
    const styles = {};
    styles.stadium = new THREE.Mesh(this._eyeGeos.stadium, this.eyeMaterial);
    styles.round = new THREE.Mesh(this._eyeGeos.round, this.eyeMaterial);
    styles.crescent = new THREE.Mesh(this._eyeGeos.crescent, this.eyeMaterial);
    styles.line = new THREE.Mesh(this._eyeGeos.line, this.eyeMaterial);
    styles.heart = new THREE.Mesh(this._eyeGeos.heart, this.accentMaterial);
    styles.star = new THREE.Mesh(this._eyeGeos.star, this.starMaterial);
    styles.dot = new THREE.Mesh(this._eyeGeos.dot, this.eyeMaterial);
    styles.spiral = new THREE.Mesh(this._eyeGeos.spiral, this.eyeMaterial);
    const x = new THREE.Group();
    const xa = new THREE.Mesh(this._eyeGeos.x, this.eyeMaterial);
    const xb = new THREE.Mesh(this._eyeGeos.x, this.eyeMaterial);
    xa.rotation.z = 0.72;
    xb.rotation.z = -0.72;
    x.add(xa, xb);
    styles.x = x;
    const wide = new THREE.Group();
    wide.add(new THREE.Mesh(this._eyeGeos.wide, this.whiteMaterial));
    const pupil = new THREE.Mesh(this._eyeGeos.pupil, this.pupilMaterial);
    pupil.position.set(0, 0.008, 0.055);
    wide.add(pupil);
    styles.wide = wide;
    for (const [key, mesh] of Object.entries(styles)) {
      mesh.visible = key === 'stadium';
      mesh.castShadow = true;
      g.add(mesh);
    }
    g.userData.styles = styles;
    return g;
  }

  _setEyeStyle(group, style) {
    const name = group.userData.styles[style] ? style : 'stadium';
    for (const [key, mesh] of Object.entries(group.userData.styles)) {
      mesh.visible = key === name;
    }
  }

  _buildCheeks(opts) {
    const r = opts.radius;
    this.blush = new THREE.Group();
    this.blush.name = 'GrokBot_Blush';
    const blushGeo = new THREE.SphereGeometry(r * 0.12, 14, 10);
    this._eyeGeos.blush = blushGeo;
    this.blushL = new THREE.Mesh(blushGeo, this.blushMaterial);
    this.blushR = new THREE.Mesh(blushGeo, this.blushMaterial);
    this.blushL.scale.set(1.15, 0.72, 0.32);
    this.blushR.scale.set(1.15, 0.72, 0.32);
    this.blush.add(this.blushL, this.blushR);
    this.add(this.blush);

    this.tears = new THREE.Group();
    this.tears.name = 'GrokBot_Tears';
    const tearGeo = new THREE.SphereGeometry(r * 0.038, 10, 8);
    this._eyeGeos.tear = tearGeo;
    this.tearL = new THREE.Mesh(tearGeo, this.tearMaterial);
    this.tearR = new THREE.Mesh(tearGeo, this.tearMaterial);
    this.tearL.scale.set(0.75, 1.35, 0.6);
    this.tearR.scale.set(0.75, 1.35, 0.6);
    this.tears.add(this.tearL, this.tearR);
    this.add(this.tears);
    this._placeCheeks();
    this.blush.visible = false;
    this.tears.visible = false;
  }

  _placeCheeks() {
    const r = this.radius;
    const put = (mesh, x, y) => {
      const dir = new THREE.Vector3(x, y, 1).normalize();
      mesh.position.copy(dir).multiplyScalar(r + r * 0.012);
      mesh.lookAt(dir.clone().multiplyScalar(2));
    };
    put(this.blushL, -0.46, -0.1);
    put(this.blushR, 0.46, -0.1);
    put(this.tearL, -0.32, -0.04);
    put(this.tearR, 0.32, -0.04);
  }

  _buildMouths(opts) {
    this.mouths = new THREE.Group();
    this.mouths.name = 'GrokBot_Mouths';
    this.add(this.mouths);

    const r = opts.radius;
    const dashR = r * 0.022;
    const dashLen = Math.max(0.001, r * 0.14 - dashR * 2);
    this._geos = {
      dash: new THREE.CapsuleGeometry(dashR, dashLen, 6, 16),
      smile: new THREE.TubeGeometry(
        new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(-0.16, 0.026, 0),
          new THREE.Vector3(0, -0.11, 0),
          new THREE.Vector3(0.16, 0.026, 0),
        ),
        20,
        0.022,
        8,
        false,
      ),
      frown: new THREE.TubeGeometry(
        new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(-0.15, -0.024, 0),
          new THREE.Vector3(0, 0.11, 0),
          new THREE.Vector3(0.15, -0.024, 0),
        ),
        20,
        0.022,
        8,
        false,
      ),
      smirk: new THREE.TubeGeometry(
        new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(-0.03, 0.014, 0),
          new THREE.Vector3(0.07, -0.065, 0),
          new THREE.Vector3(0.16, 0.04, 0),
        ),
        16,
        0.016,
        8,
        false,
      ),
      oh: new THREE.SphereGeometry(0.07, 16, 12),
      grin: new THREE.TubeGeometry(
        new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(-0.2, 0.036, 0),
          new THREE.Vector3(0, -0.14, 0),
          new THREE.Vector3(0.2, 0.036, 0),
        ),
        22,
        0.024,
        8,
        false,
      ),
      grimace: new THREE.CapsuleGeometry(0.024, 0.22, 6, 16),
      tongue: new THREE.CapsuleGeometry(0.036, 0.07, 6, 12),
      kiss: new THREE.SphereGeometry(0.04, 12, 10),
      openFill: new THREE.SphereGeometry(0.1, 16, 12),
      small: new THREE.TubeGeometry(
        new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(-0.1, 0.016, 0),
          new THREE.Vector3(0, -0.058, 0),
          new THREE.Vector3(0.1, 0.016, 0),
        ),
        14,
        0.016,
        8,
        false,
      ),
      teeth: new THREE.BoxGeometry(0.17, 0.038, 0.024),
      wavy: new THREE.TubeGeometry(
        new THREE.CubicBezierCurve3(
          new THREE.Vector3(-0.14, 0.026, 0),
          new THREE.Vector3(-0.04, -0.07, 0),
          new THREE.Vector3(0.04, 0.07, 0),
          new THREE.Vector3(0.14, -0.026, 0),
        ),
        22,
        0.018,
        8,
        false,
      ),
    };

    this.mouthDash = new THREE.Mesh(this._geos.dash, this.eyeMaterial);
    this.mouthSmile = new THREE.Mesh(this._geos.smile, this.eyeMaterial);
    this.mouthFrown = new THREE.Mesh(this._geos.frown, this.eyeMaterial);
    this.mouthSmirk = new THREE.Mesh(this._geos.smirk, this.eyeMaterial);
    this.mouthOh = new THREE.Mesh(this._geos.oh, this.eyeMaterial);
    this.mouthGrin = new THREE.Mesh(this._geos.grin, this.eyeMaterial);
    this.mouthGrimace = new THREE.Mesh(this._geos.grimace, this.eyeMaterial);
    this.mouthTongue = new THREE.Mesh(this._geos.tongue, this.accentMaterial);
    this.mouthKiss = new THREE.Mesh(this._geos.kiss, this.eyeMaterial);
    this.mouthOpenFill = new THREE.Mesh(this._geos.openFill, this.fillMaterial);
    this.mouthSmall = new THREE.Mesh(this._geos.small, this.eyeMaterial);
    this.mouthWavy = new THREE.Mesh(this._geos.wavy, this.eyeMaterial);
    this.mouthTeeth = new THREE.Mesh(this._geos.teeth, this.fillMaterial);
    for (const m of [
      this.mouthDash,
      this.mouthSmile,
      this.mouthFrown,
      this.mouthSmirk,
      this.mouthOh,
      this.mouthGrin,
      this.mouthGrimace,
      this.mouthTongue,
      this.mouthKiss,
      this.mouthOpenFill,
      this.mouthSmall,
      this.mouthWavy,
      this.mouthTeeth,
    ]) {
      m.castShadow = true;
      m.visible = false;
      this.mouths.add(m);
    }

    this._seatMouthMesh(this.mouthDash, -0.16, 'dash');
    this._seatMouthMesh(this.mouthSmile, -0.14, 'curve');
    this._seatMouthMesh(this.mouthFrown, -0.15, 'curve');
    this._seatMouthMesh(this.mouthSmirk, -0.14, 'curve');
    this._seatMouthMesh(this.mouthOh, -0.15, 'oh');
    this._seatMouthMesh(this.mouthGrin, -0.13, 'curve');
    this._seatMouthMesh(this.mouthGrimace, -0.16, 'dash');
    this._seatMouthMesh(this.mouthTongue, -0.22, 'oh');
    this._seatMouthMesh(this.mouthKiss, -0.15, 'oh');
    this._seatMouthMesh(this.mouthOpenFill, -0.155, 'oh');
    this._seatMouthMesh(this.mouthSmall, -0.145, 'curve');
    this._seatMouthMesh(this.mouthWavy, -0.15, 'curve');
    this._seatMouthMesh(this.mouthTeeth, -0.145, 'oh');
    this.mouth = this.mouthDash;
  }

  _pts(r, sx, cz, t) {
    return [
      new THREE.Vector3(sx * t[0] * r, t[1] * r, cz * t[2] * r),
      new THREE.Vector3(sx * t[3] * r, t[4] * r, cz * t[5] * r),
      new THREE.Vector3(sx * t[6] * r, t[7] * r, cz * t[8] * r),
    ];
  }

  _clearTentacles() {
    if (!this.tentacles) return;
    this.remove(this.tentacles);
    if (this._tentacleGeos) {
      for (const g of this._tentacleGeos) g.dispose();
    }
    this._tentacleGeos = [];
    this._arms = [];
    this.tentacles = null;
    this._tentacleProfile = null;
  }

  _buildTentacles(profileName) {
    const spec = OCTO[profileName] || OCTO.smooth;
    this.tentacles = new THREE.Group();
    this.tentacles.name = 'GrokBot_Tentacles';
    this.add(this.tentacles);
    this._tentacleProfile = profileName;
    if (this.userData.parts) this.userData.parts.tentacles = this.tentacles;

    const r = this.radius;
    this._tentacleGeos = [];
    this._tipGeo = new THREE.SphereGeometry(r * (spec.r1 + 0.016), 14, 12);
    this._rootGeo = new THREE.SphereGeometry(r * 0.2, 16, 12);
    this._tentacleGeos.push(this._tipGeo, this._rootGeo);
    this._arms = [];

    if (spec.hip) {
      const hip = new THREE.Mesh(new THREE.SphereGeometry(r * spec.hip[0], 28, 18), this.bodyMaterial);
      hip.name = 'GrokBot_Hip';
      hip.position.y = r * spec.hip[1];
      hip.scale.set(spec.hip[2], spec.hip[3], spec.hip[4]);
      hip.castShadow = true;
      this.tentacles.add(hip);
      this._tentacleGeos.push(hip.geometry);
    }

    const segs = spec.segs || 18;
    const taper = spec.taper || 2.6;
    const list = spec.layout || this._evenArms(spec);
    for (let i = 0; i < list.length; i++) {
      const arm = list[i];
      const angle = arm.angle;
      const sx = Math.sin(angle);
      const cz = Math.cos(angle);
      const kind = arm.kind || 'back';
      const ring = arm.ring ?? spec.attach[0];
      const y = arm.y ?? spec.attach[1];
      const on = arm.on ?? spec.attach[2];
      const attach = new THREE.Vector3(sx * ring, y, cz * ring).normalize().multiplyScalar(r * on);
      const root = new THREE.Group();
      root.position.copy(attach);

      const into = attach.clone().multiplyScalar(spec.into);
      const [p1, p2, p3] = this._pts(r, sx, cz, arm.curve || spec[kind]);
      const curve = new THREE.CubicBezierCurve3(into, p1, p2, p3);
      const r0 = r * (arm.r0 ?? (kind === 'flare' ? spec.flareR0 : spec.r0));
      const r1 = r * (arm.r1 ?? spec.r1);
      const armGeo = taperedTube(curve, segs, 10, r0, r1, taper);
      this._tentacleGeos.push(armGeo);

      if (spec.knob) {
        const knob = new THREE.Mesh(this._rootGeo, this.bodyMaterial);
        knob.position.copy(into).multiplyScalar(0.25);
        knob.scale.setScalar(spec.knob);
        knob.castShadow = true;
        root.add(knob);
      }

      const shaft = new THREE.Mesh(armGeo, this.bodyMaterial);
      shaft.castShadow = true;
      root.add(shaft);

      if (spec.cap !== false) {
        const cap = new THREE.Mesh(this._tipGeo, this.bodyMaterial);
        cap.position.copy(p3);
        cap.scale.setScalar(r1 / (this.radius * (spec.r1 + 0.016)) || 1);
        cap.castShadow = true;
        root.add(cap);
      }

      this.tentacles.add(root);
      this._arms.push({ root, index: i, angle, kind, sx, cz });
    }
  }

  _evenArms(spec) {
    const count = spec.arms || 8;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const sx = Math.sin(angle);
      const cz = Math.cos(angle);
      if (cz > 0.82) continue;
      let kind = 'back';
      if (Math.abs(sx) > spec.flareAt) kind = 'flare';
      else if (cz > spec.hangAt) kind = 'hang';
      rows.push({ angle, kind });
    }
    return rows;
  }

  setBody() {
    this.bodyType = 'smooth';
    if (this._tentacleProfile !== 'smooth') {
      this._clearTentacles();
      this._buildTentacles('smooth');
    }
    if (this.tentacles) this.tentacles.visible = true;
    return this.bodyType;
  }

  _seatMouthMesh(mesh, elevation, kind) {
    const r = this.radius;
    const face = _face.set(0, elevation, 1).normalize();
    _normal.copy(face);
    _long.set(0, 1, 0).addScaledVector(_normal, -_long.dot(_normal)).normalize();
    _right.crossVectors(_long, _normal).normalize();
    _long.crossVectors(_normal, _right).normalize();
    mesh.position.copy(face).multiplyScalar(r + r * 0.01);

    if (kind === 'dash') {
      _eyeLong.copy(_long).negate();
      _basis.makeBasis(_eyeLong, _right, _normal);
    } else if (kind === 'oh') {
      _basis.makeBasis(_right, _long, _normal);
    } else {
      _basis.makeBasis(_right, _long, _normal);
    }
    mesh.quaternion.setFromRotationMatrix(_basis);
  }

  placeEyes({ tilt = -22, spacing = 0.34, elevation = 0.1, lTilt = 0, rTilt = 0 } = {}) {
    const r = this.radius;
    const face = _face.set(0, elevation, 1).normalize();
    const tiltRad = THREE.MathUtils.degToRad(tilt);

    _normal.copy(face);
    _long.set(0, 1, 0).addScaledVector(_normal, -_long.dot(_normal)).normalize();
    _long.applyAxisAngle(_normal, tiltRad);
    _right.crossVectors(_long, _normal).normalize();
    _long.crossVectors(_normal, _right).normalize();

    const half = spacing * r * 0.5;
    this._seatEye(this.eyeL, face, -half, r, lTilt);
    this._seatEye(this.eyeR, face, half, r, rTilt);
  }

  _seatEye(mesh, face, offset, radius, extraTilt = 0) {
    _dir.copy(face).addScaledVector(_right, offset / radius).normalize();
    mesh.position.copy(_dir).multiplyScalar(radius + radius * 0.006);

    _normal.copy(_dir);
    _eyeLong.copy(_long).addScaledVector(_normal, -_long.dot(_normal)).normalize();
    if (extraTilt) _eyeLong.applyAxisAngle(_normal, extraTilt);
    _eyeRight.crossVectors(_eyeLong, _normal).normalize();
    _eyeLong.crossVectors(_normal, _eyeRight).normalize();

    _basis.makeBasis(_eyeRight, _eyeLong, _normal);
    mesh.quaternion.setFromRotationMatrix(_basis);
  }

  setExpression(name) {
    const exp = EXPRESSIONS[name] || EXPRESSIONS.neutral;
    this.expression = EXPRESSIONS[name] ? name : 'neutral';
    this._feel = exp.feel || this.expression;
    this.placeEyes({
      tilt: exp.tilt,
      spacing: exp.spacing,
      elevation: exp.elevation,
      lTilt: exp.lTilt || 0,
      rTilt: exp.rTilt || 0,
    });
    this._eyeBase.l = { x: exp.lEyeX ?? exp.eyeX, y: exp.lEyeY ?? exp.eyeY, z: this._flatten };
    this._eyeBase.r = { x: exp.rEyeX ?? exp.eyeX, y: exp.rEyeY ?? exp.eyeY, z: this._flatten };
    this._winkL = !!exp.winkL;
    this._winkR = !!exp.winkR;
    this.eyes.rotation.set(0, 0, 0);
    this.autoBlink = exp.blink !== false;
    this.autoMouth = false;
    this.setMouthShape(exp.mouth || 'none');
    this._setEyeStyle(this.eyeL, exp.lEye || exp.eye || 'stadium');
    this._setEyeStyle(this.eyeR, exp.rEye || exp.eye || 'stadium');
    if (this.blush) this.blush.visible = !!exp.blush;
    if (this.tears) {
      const n = exp.tears === true ? 2 : Number(exp.tears) || 0;
      this.tears.visible = n > 0;
      if (this.tearL) this.tearL.visible = n >= 1;
      if (this.tearR) this.tearR.visible = n >= 2;
    }
    this._applyEyeScale();
    return this.expression;
  }

  setMouthShape(shape) {
    this._mouthShape = shape;
    const show = shape !== 'none';
    this._mouthTo = show ? 1 : 0;
    this._mouthHold = show;
    this._mouth = show ? 1 : 0;
    this._syncMouthMeshes();
  }

  _syncMouthMeshes() {
    const map = {
      dash: this.mouthDash,
      smile: this.mouthSmile,
      frown: this.mouthFrown,
      smirk: this.mouthSmirk,
      oh: this.mouthOh,
      grin: this.mouthGrin,
      grimace: this.mouthGrimace,
      tongue: this.mouthTongue,
      kiss: this.mouthKiss,
      small: this.mouthSmall,
      wavy: this.mouthWavy,
    };
    const active = map[this._mouthShape] || null;
    this.mouth = active || this.mouthDash;
    const s = this._mouth;
    for (const [key, mesh] of Object.entries(map)) {
      const on = mesh === active && s > 0.02;
      mesh.visible = on;
      if (!on) continue;
      if (key === 'oh' || key === 'kiss') mesh.scale.set(s * 1.35, s * 1.35, this._flatten * s * 1.5);
      else if (key === 'dash' || key === 'grimace') mesh.scale.set(s, s, this._flatten * s);
      else if (key === 'tongue') mesh.scale.set(s * 0.9, s * 1.15, this._flatten * s);
      else mesh.scale.set(s, s, s);
    }
    if (this._mouthShape === 'tongue' && s > 0.02) {
      this.mouthSmile.visible = true;
      this.mouthSmile.scale.set(s * 0.85, s * 0.85, s * 0.85);
    }
  }

  blink() {
    this._blinkTo = 0.08;
    this._blinkTimer = 0.09;
  }

  showMouth(hold = Infinity) {
    if (this._mouthShape === 'none') this.setMouthShape('dash');
    this._mouthTo = 1;
    this._mouthHold = true;
    this._mouthTimer = hold;
  }

  hideMouth() {
    this._mouthTo = 0;
    this._mouthHold = false;
    this._mouthTimer = 0;
  }

  setMouth(visible, hold) {
    if (visible) this.showMouth(hold);
    else this.hideMouth();
  }

  playAnimation(name) {
    this.animation = ANIMATIONS[name] ? name : 'none';
    this.eyes.rotation.set(0, 0, 0);
    if (this.animation === 'sleep') this.setExpression('sleepy');
    if (this.animation === 'talk' && this._mouthShape === 'none') this.setMouthShape('dash');
    if (this.animation === 'none') {
      this.position.set(0, 0, 0);
      this.rotation.set(0, 0, 0);
      this.scale.set(1, 1, 1);
    }
    return this.animation;
  }

  _applyEyeScale() {
    const bL = this._eyeBase.l;
    const bR = this._eyeBase.r;
    const lY = this._winkL ? 0.1 : this._blink;
    const rY = this._winkR ? 0.1 : this._blink;
    // Closing lids squash into dashes so a blink reads as an eyelid, not a shrinking pill.
    const lX = bL.x * (1 + (1 - lY) * 0.42);
    const rX = bR.x * (1 + (1 - rY) * 0.42);
    this.eyeL.scale.set(lX, bL.y * lY, bL.z);
    this.eyeR.scale.set(rX, bR.y * rY, bR.z);
  }

  update(delta, time) {
    this._elapsed += delta;
    const t = time ?? this._elapsed;

    // Always start from rest so expression offsets cannot accumulate.
    this.position.set(0, 0, 0);
    this.rotation.set(0, 0, 0);
    this.scale.set(1, 1, 1);
    this.eyes.rotation.set(0, 0, 0);

    this._updateAnim(delta, t);
    if (this._feel === 'confused') {
      // Searching "huh?": hold a tilt, then snap the other way — not a sine rock.
      const phase = (t * 0.46) % 1;
      let glance = -1;
      if (phase < 0.28) glance = -1;
      else if (phase < 0.36) glance = THREE.MathUtils.lerp(-1, 1, (phase - 0.28) / 0.08);
      else if (phase < 0.66) glance = 1;
      else if (phase < 0.74) glance = THREE.MathUtils.lerp(1, -0.35, (phase - 0.66) / 0.08);
      else glance = -0.35;
      this._confusedGlance = glance;
      this.rotation.z += 0.1 + glance * 0.07;
      this.rotation.y += glance * 0.14;
      this.rotation.x += -0.03 + Math.abs(glance) * 0.03;
      this.eyes.rotation.y = glance * 0.16;
      this.eyes.rotation.z = 0.04 + glance * 0.03;
    }
    if (this._feel === 'scared') {
      this.rotation.z += Math.sin(t * 42) * 0.02;
      this.rotation.x += Math.sin(t * 36) * 0.012;
      this.position.y += Math.sin(t * 48) * this.radius * 0.008;
      // Panic glance: hold a look, then snap the other way.
      const dart = (t * 1.65) % 1;
      let look = -0.15;
      if (dart < 0.26) look = -0.17;
      else if (dart < 0.33) look = THREE.MathUtils.lerp(-0.17, 0.2, (dart - 0.26) / 0.07);
      else if (dart < 0.58) look = 0.2;
      else if (dart < 0.65) look = THREE.MathUtils.lerp(0.2, -0.06, (dart - 0.58) / 0.07);
      else look = -0.06;
      this.eyes.rotation.y = look;
      // Gulp: hold the scream, swallow, then the O pops back.
      const phase = (t * 0.72) % 1;
      let gulp = 0;
      if (phase > 0.6 && phase < 0.72) gulp = Math.sin(((phase - 0.6) / 0.12) * Math.PI);
      else if (phase >= 0.72 && phase < 0.84) gulp = 0.32 * Math.sin(((phase - 0.72) / 0.12) * Math.PI);
      this._scaredGulp = gulp;
      this.scale.y *= 1 - gulp * 0.09;
      this.scale.x *= 1 + gulp * 0.06;
      this.scale.z *= 1 + gulp * 0.06;
      this.position.y += this.radius * (-gulp * 0.03);
      this.rotation.x += gulp * 0.05;
    }
    if (this._feel === 'sad') {
      // Slow sigh: lift on the inhale, then sink heavier through the exhale.
      const phase = (t * 0.36) % 1;
      let sigh = 0;
      if (phase < 0.32) sigh = Math.sin((phase / 0.32) * Math.PI * 0.5);
      else if (phase < 0.44) sigh = 1;
      else sigh = Math.cos(((phase - 0.44) / 0.56) * Math.PI * 0.5);
      this._sadSigh = sigh;
      this.rotation.x += 0.1 + (1 - sigh) * 0.07;
      this.position.y += this.radius * (-0.03 + sigh * 0.03);
    }
    if (this._feel === 'angry') {
      this.rotation.z += Math.sin(t * 18) * 0.028;
      this.rotation.x += 0.06 + Math.sin(t * 14) * 0.012;
      // Tense huff: squash down, hold, then a sharp lift like a growl.
      const phase = (t * 1.25) % 1;
      let huff = 0;
      if (phase < 0.22) huff = Math.sin((phase / 0.22) * Math.PI * 0.5);
      else if (phase < 0.34) huff = 1;
      else if (phase < 0.48) huff = Math.cos(((phase - 0.34) / 0.14) * Math.PI * 0.5);
      this._angryHuff = huff;
      this.scale.y *= 1 - huff * 0.07;
      this.scale.x *= 1 + huff * 0.045;
      this.scale.z *= 1 + huff * 0.045;
      this.position.y += this.radius * (-huff * 0.022);
      this.rotation.x += huff * 0.04;
    }
    if (this._feel === 'wow') {
      // Gasp: hold the O, snatch a breath, then pop back open.
      const phase = (t * 0.68) % 1;
      let gasp = 1;
      if (phase < 0.5) gasp = 1;
      else if (phase < 0.6) gasp = THREE.MathUtils.lerp(1, 0.4, (phase - 0.5) / 0.1);
      else if (phase < 0.68) gasp = THREE.MathUtils.lerp(0.4, 1.14, (phase - 0.6) / 0.08);
      else gasp = THREE.MathUtils.lerp(1.14, 1, (phase - 0.68) / 0.32);
      this._wowGasp = gasp;
      this.rotation.x += -0.06 - gasp * 0.055;
      this.position.y += this.radius * (0.016 + gasp * 0.022);
    }
    if (this._feel === 'happy') {
      // Rise, hold, two giggle bursts, settle — not a sine bob.
      const phase = (t * 0.62) % 1;
      let lift = 0;
      let giggle = 0;
      let tilt = 0;
      if (phase < 0.18) {
        lift = Math.sin((phase / 0.18) * Math.PI * 0.5);
      } else if (phase < 0.34) {
        lift = 1;
        giggle = Math.sin(((phase - 0.18) / 0.16) * Math.PI);
        tilt = 1;
      } else if (phase < 0.42) {
        lift = 1;
      } else if (phase < 0.56) {
        lift = 1;
        giggle = 0.72 * Math.sin(((phase - 0.42) / 0.14) * Math.PI);
        tilt = -0.7;
      } else if (phase < 0.7) {
        lift = 1;
      } else {
        lift = Math.cos(((phase - 0.7) / 0.3) * Math.PI * 0.5);
      }
      this._happyGiggle = giggle;
      this.position.y += this.radius * (0.014 + lift * 0.028 - giggle * 0.014);
      this.rotation.x += -0.03 - lift * 0.022;
      this.rotation.z += tilt * giggle * 0.04;
      this.scale.y *= 1 - giggle * 0.055;
      this.scale.x *= 1 + giggle * 0.034;
      this.scale.z *= 1 + giggle * 0.034;
    }
    if (this._feel === 'wink') {
      // Held wink: left lid stays shut. Brief re-wink, never a long open stare.
      const phase = (t * 0.38) % 1;
      let lid = 0.1;
      let tease = 1;
      if (phase > 0.78 && phase < 0.86) {
        const u = (phase - 0.78) / 0.08;
        lid = THREE.MathUtils.lerp(0.1, 0.85, u);
        tease = 1 - u;
      } else if (phase >= 0.86 && phase < 0.94) {
        const u = (phase - 0.86) / 0.08;
        lid = THREE.MathUtils.lerp(0.85, 0.1, u);
        tease = u;
      }
      this._winkLid = lid;
      this.rotation.z += 0.055 + tease * 0.075;
      this.rotation.y += 0.025 + tease * 0.045;
      this.scale.y *= 1 - tease * 0.038;
      this.scale.x *= 1 + tease * 0.024;
      this.scale.z *= 1 + tease * 0.024;
    }
    if (this._feel === 'smirk') {
      // Hold a sly aside, then a tiny "gotcha" twitch.
      const phase = (t * 0.4) % 1;
      let sly = 1;
      let twitch = 0;
      if (phase < 0.58) sly = 1;
      else if (phase < 0.68) {
        sly = 1;
        twitch = Math.sin(((phase - 0.58) / 0.1) * Math.PI);
      } else sly = 0.82 + 0.18 * Math.sin((phase - 0.68) * 5);
      this._smirkTwitch = twitch;
      this.rotation.z += -0.1 - sly * 0.03 - twitch * 0.025;
      this.rotation.y += 0.12 + sly * 0.03;
      this.eyes.rotation.y = 0.16 + sly * 0.04 + twitch * 0.03;
    }
    if (this._feel === 'deadpan') {
      // Bored slump: almost still, just heavy enough to read unimpressed.
      this.rotation.x += 0.05;
      this.position.y += Math.sin(t * 0.5) * this.radius * 0.005 - this.radius * 0.014;
      // Slow side-eye: hold a look, then drag it the other way.
      const phase = (t * 0.28) % 1;
      let look = -0.08;
      let hold = 0;
      if (phase < 0.24) { look = -0.18; hold = 1; }
      else if (phase < 0.36) look = THREE.MathUtils.lerp(-0.18, 0.16, (phase - 0.24) / 0.12);
      else if (phase < 0.64) { look = 0.16; hold = 1; }
      else if (phase < 0.78) look = THREE.MathUtils.lerp(0.16, -0.08, (phase - 0.64) / 0.14);
      this.eyes.rotation.y = look;
      // Tiny "hmph" on the hold — flatten, don't bounce.
      this._deadpanHold = hold;
      this._deadpanLook = look;
      this.scale.y *= 1 - hold * 0.028;
      this.scale.x *= 1 + hold * 0.02;
      this.scale.z *= 1 + hold * 0.02;
    }
    if (this._feel === 'love') {
      // Swoon hold, then flop the other way — not a sine rock.
      const beat = this._heartPulse(t) - 1;
      const sway = (t * 0.22) % 1;
      let swoon = -0.05;
      if (sway < 0.36) swoon = -0.07;
      else if (sway < 0.46) swoon = THREE.MathUtils.lerp(-0.07, 0.06, (sway - 0.36) / 0.1);
      else if (sway < 0.82) swoon = 0.06;
      else if (sway < 0.92) swoon = THREE.MathUtils.lerp(0.06, -0.05, (sway - 0.82) / 0.1);
      this.position.y += this.radius * (0.022 + beat * 0.7);
      this.rotation.z += swoon + beat * 0.8;
      this.rotation.x += -0.03 - beat * 0.35;
      this.scale.y *= 1 + beat * 2.4;
      this.scale.x *= 1 - beat * 1.5;
      this.scale.z *= 1 - beat * 1.5;
      const exp = EXPRESSIONS[this.expression] || EXPRESSIONS.love;
      if ((exp.eye || 'stadium') !== 'heart') {
        const pinch = (exp.lTilt || 0.38) + beat * 3.2;
        this.placeEyes({
          tilt: exp.tilt,
          spacing: exp.spacing - beat * 0.6,
          elevation: exp.elevation + beat * 0.2,
          lTilt: pinch,
          rTilt: -pinch,
        });
      }
    }
    if (this._feel === 'sleepy') {
      // Droop off, then a catch-yourself snap — not a sine-wave nod.
      const phase = (t * 0.34) % 1;
      let droop = 0;
      if (phase < 0.58) {
        const u = phase / 0.58;
        droop = u * u;
      } else if (phase < 0.66) {
        droop = 1 - (phase - 0.58) / 0.08;
      } else {
        droop = 0.06 + 0.06 * Math.sin((phase - 0.66) * 7);
      }
      this._sleepyDroop = droop;
      this.rotation.x += 0.05 + droop * 0.16;
      this.rotation.z += Math.sin(t * 0.38) * 0.03 + droop * 0.025;
      this.position.y += -this.radius * (0.01 + droop * 0.02);
    }
    if (this._feel === 'neutral') {
      // Tiny look-around so the default face isn't a mannequin.
      const hold = Math.sin(t * 0.37);
      const flick = Math.sin(t * 2.05) * Math.sin(t * 0.23);
      this.rotation.y += hold * 0.048 + flick * 0.018;
      this.rotation.x += Math.sin(t * 0.29) * 0.016;
      // Eyes lead, then a saccade — idle shouldn't be a locked stare.
      const saccade = (t * 0.31) % 1;
      let look = hold * 0.05;
      if (saccade < 0.2) look = -0.09;
      else if (saccade < 0.26) look = THREE.MathUtils.lerp(-0.09, 0.11, (saccade - 0.2) / 0.06);
      else if (saccade < 0.5) look = 0.11;
      else if (saccade < 0.56) look = THREE.MathUtils.lerp(0.11, -0.04, (saccade - 0.5) / 0.06);
      else look = -0.04 + flick * 0.03;
      this.eyes.rotation.y = look;
      this.eyes.rotation.x = Math.sin(t * 0.41) * 0.02;
    }
    if (this._feel === 'eyeroll') {
      const phase = (t * 0.55) % 1;
      let look = 0.22;
      if (phase < 0.35) look = 0.28;
      else if (phase < 0.48) look = THREE.MathUtils.lerp(0.28, -0.22, (phase - 0.35) / 0.13);
      else if (phase < 0.78) look = -0.22;
      else look = THREE.MathUtils.lerp(-0.22, 0.22, (phase - 0.78) / 0.22);
      this.eyes.rotation.x = 0.38;
      this.eyes.rotation.y = look;
      this.rotation.x += -0.04;
    }
    if (this._feel === 'zany') {
      this.rotation.z += Math.sin(t * 6.2) * 0.06;
      this.rotation.y += Math.sin(t * 3.4) * 0.05;
      this.scale.y *= 1 + Math.sin(t * 8) * 0.02;
    }

    if (this.autoBlink) {
      this._blinkTimer -= delta;
      if (this._blinkTo < 1) {
        const close = this._feel === 'deadpan' ? 9 : 28;
        this._blink = THREE.MathUtils.damp(this._blink, this._blinkTo, close, delta);
        if (this._blink < 0.12) this._blinkTo = 1;
      } else {
        const rest = this._feel === 'deadpan' ? 0.76 : 1;
        this._blink = THREE.MathUtils.damp(this._blink, rest, 16, delta);
        if (this._blinkTimer <= 0) {
          this.blink();
          if (this._feel === 'deadpan') {
            this._doubleBlink = false;
            this._blinkTimer = 5.8 + Math.random() * 4.2;
          } else if (this._doubleBlink) {
            this._doubleBlink = false;
            this._blinkTimer = 2.6 + Math.random() * 3.4;
          } else if (Math.random() < 0.3) {
            this._doubleBlink = true;
            this._blinkTimer = 0.14;
          } else {
            this._blinkTimer = 2.6 + Math.random() * 3.4;
          }
        }
      }
    } else if (this._feel === 'sleepy') {
      // Lids ride the snore when sleeping; otherwise they sink with the nod-off.
      const air = this.animation === 'sleep' ? (this._snore || 0) : (1 - (this._sleepyDroop ?? 0));
      const lid = this.animation === 'sleep' ? 0.4 + 0.5 * air : 0.18 + 0.72 * air;
      this._blink = THREE.MathUtils.damp(this._blink, lid, 4.2, delta);
    } else {
      this._blink = THREE.MathUtils.damp(this._blink, 1, 10, delta);
    }
    this._applyEyeScale();
    if (this._feel === 'sad') {
      // Lids heavier on the exhale so the sigh lives on the face.
      const sigh = this._sadSigh || 0;
      const droop = 1 - (1 - sigh) * 0.24;
      this.eyeL.scale.y *= droop;
      this.eyeR.scale.y *= droop;
      this.eyeL.scale.x *= 1 + (1 - sigh) * 0.1;
      this.eyeR.scale.x *= 1 + (1 - sigh) * 0.1;
    }
    if (this._feel === 'confused') {
      // Lopsided lids follow the glance: far one heavier, near one a bit open.
      const glance = this._confusedGlance ?? 0;
      const u = 0.5 + 0.5 * glance;
      this.eyeL.scale.y *= 0.86 + u * 0.12;
      this.eyeR.scale.y *= 1.06 - u * 0.1;
      this.eyeL.scale.x *= 1.04;
    }
    if (this._feel === 'angry') {
      const huff = this._angryHuff || 0;
      const squint = 1 - 0.14 * huff;
      this.eyeL.scale.y *= squint;
      this.eyeR.scale.y *= squint;
      this.eyeL.scale.x *= 1 + 0.1 * huff;
      this.eyeR.scale.x *= 1 + 0.1 * huff;
    }
    if (this._feel === 'wow') {
      const gasp = this._wowGasp ?? 1;
      this.eyeL.scale.x *= 0.9 + gasp * 0.2;
      this.eyeR.scale.x *= 0.9 + gasp * 0.2;
      this.eyeL.scale.y *= 0.95 + gasp * 0.1;
      this.eyeR.scale.y *= 0.95 + gasp * 0.1;
    }
    if (this._feel === 'happy') {
      const giggle = this._happyGiggle ?? 0;
      const crinkle = 1 - 0.06 - giggle * 0.1;
      this.eyeL.scale.y *= crinkle;
      this.eyeR.scale.y *= crinkle;
    }
    if (this._feel === 'wink') {
      const lid = this._winkLid ?? 0.1;
      const bL = this._eyeBase.l;
      this.eyeL.scale.y = bL.y * lid;
      this.eyeL.scale.x = bL.x * (1 + (1 - lid) * 0.42);
      this.eyeR.scale.y *= 0.86;
      this.eyeR.scale.x *= 1.08;
    }
    if (this._feel === 'smirk') {
      const twitch = this._smirkTwitch ?? 0;
      const know = 0.78 + twitch * 0.08;
      this.eyeL.scale.y *= know;
      this.eyeL.scale.x *= 1.08;
      this.eyeR.scale.y *= 0.94;
    }
    if (this._feel === 'love') {
      const squeeze = 1 - (this._heartPulse(t) - 1) * 1.4;
      this.eyeL.scale.y *= squeeze;
      this.eyeR.scale.y *= squeeze;
    }
    if (this._feel === 'scared') {
      const gulp = this._scaredGulp ?? 0;
      this.eyeL.scale.y *= 1 - gulp * 0.12;
      this.eyeR.scale.y *= 1 - gulp * 0.12;
      this.eyeL.scale.x *= 1 + gulp * 0.08;
      this.eyeR.scale.x *= 1 + gulp * 0.08;
    }
    if (this._feel === 'deadpan') {
      const look = this._deadpanLook ?? 0;
      const hold = this._deadpanHold ?? 0;
      const heavy = 0.86 - hold * 0.08;
      if (look > 0.04) {
        this.eyeR.scale.y *= heavy;
        this.eyeL.scale.y *= 0.96;
      } else if (look < -0.04) {
        this.eyeL.scale.y *= heavy;
        this.eyeR.scale.y *= 0.96;
      } else {
        this.eyeL.scale.y *= 0.94;
        this.eyeR.scale.y *= 0.94;
      }
    }

    let mouthTarget = this._mouthTo;
    if (this.animation === 'talk') {
      const phrase = (t * 0.22) % 1;
      if (phrase > 0.78) {
        mouthTarget = 0.08;
      } else {
        const a = Math.abs(Math.sin(t * 13.2));
        const b = Math.abs(Math.sin(t * 8.1 + 0.7));
        const c = Math.abs(Math.sin(t * 21.5 + 1.3));
        const burst = a * a * (0.55 + 0.45 * b);
        mouthTarget = 0.18 + burst * 0.82 + c * 0.08;
      }
    } else if (this.animation === 'sleep') {
      mouthTarget = 0.1 + (this._snore || 0) * 0.78;
    } else if (this._feel === 'wow') {
      mouthTarget = 0.36 + (this._wowGasp ?? 1) * 0.64;
    } else if (this._feel === 'happy') {
      mouthTarget = 0.78 + (this._happyGiggle ?? 0) * 0.22;
    } else if (this._feel === 'smirk') {
      mouthTarget = 0.82 + (this._smirkTwitch ?? 0) * 0.2;
    } else if (this._feel === 'scared') {
      const gulp = this._scaredGulp ?? 0;
      const tremble = 0.05 * Math.abs(Math.sin(t * 38));
      mouthTarget = 0.92 + tremble - gulp * 0.55;
    } else if (this._feel === 'love') {
      // Smile blooms on the heartbeat so the mouth isn't a static sticker.
      const beat = this._heartPulse(t) - 1;
      mouthTarget = 0.76 + beat * 5.8;
    } else if (this._feel === 'deadpan') {
      mouthTarget = 0.7 + (this._deadpanHold ?? 0) * 0.18;
    } else if (this._feel === 'sad') {
      // Frown deepens on the exhale so the sigh isn't only in the lids.
      mouthTarget = 0.7 + (1 - (this._sadSigh ?? 0)) * 0.3;
    } else if (this._feel === 'angry') {
      mouthTarget = 0.78 + (this._angryHuff ?? 0) * 0.22;
    } else if (this._feel === 'wink') {
      mouthTarget = 0.72 + (1 - (this._winkLid ?? 0.1)) * 0.28;
    }
    this._mouth = THREE.MathUtils.damp(this._mouth, mouthTarget, 14, delta);
    this._syncMouthMeshes();
    if (this._feel === 'deadpan' && this.mouthDash.visible) {
      const hold = this._deadpanHold ?? 0;
      const s = this._mouth;
      this.mouthDash.scale.set(s * (1 + hold * 0.22), s * (1 - hold * 0.28), this._flatten * s);
    }
    if (this._feel === 'confused' && this.mouthFrown.visible) {
      const glance = this._confusedGlance ?? 0;
      const s = this._mouth;
      this._seatMouthMesh(this.mouthFrown, -0.32, 'curve');
      this.mouthFrown.scale.set(s * 0.92, s * 0.72, s);
      this.mouthFrown.rotateOnAxis(_normal, glance * 0.18);
    }
    if (this._feel === 'sad' && this.mouthFrown.visible) {
      const sink = 1 - (this._sadSigh ?? 0);
      const s = this._mouth;
      this.mouthFrown.scale.set(s * (1 - sink * 0.08), s * (1 + sink * 0.24), s);
    }
    if (this._feel === 'angry' && this.mouthFrown.visible) {
      const huff = this._angryHuff ?? 0;
      const s = this._mouth;
      // Growl: flatten and widen — grit, not a sadder curve.
      this.mouthFrown.scale.set(s * (1 + huff * 0.28), s * (1 - huff * 0.32), s);
    }
    if (this._feel === 'wink' && this.mouthSmile.visible) {
      const shut = 1 - (this._winkLid ?? 0.1);
      const s = this._mouth;
      // Tease: smile curls deeper while the wink is held.
      this.mouthSmile.scale.set(s * (1 + shut * 0.08), s * (1 + shut * 0.26), s);
    }

    const lift = isOctopusBody(this.bodyType) ? 0.1 : 0;
    if (lift) this.position.y += this.radius * lift;
    this._updateTentacles(t, lift);
  }

  _updateTentacles(t, lift = 0) {
    if (!isOctopusBody(this.bodyType) || !this._arms) return;
    const anim = this.animation;
    const hop = this.position.y / this.radius - lift;
    const squash = Math.max(0, 1 - this.scale.y);

    for (const arm of this._arms) {
      const phase = t * 1.7 + arm.index * 0.7;
      const wave = Math.sin(phase);
      let splay = 0.04;
      let wiggle = wave * 0.06;
      let tip = 0;
      let droop = 0;

      if (anim === 'none') {
        wiggle = 0;
      } else if (anim === 'sleep') {
        droop = 0.14;
        wiggle = Math.sin(t * 0.24 + arm.index) * 0.03;
      } else if (anim === 'bounce' || anim === 'excited' || anim === 'hop' || anim === 'cheer') {
        const up = Math.max(0, hop);
        splay = 0.08 + squash * 0.32 + up * 0.2;
        tip = up * 0.4 - squash * 0.28;
        wiggle = wave * 0.06;
      } else if (anim === 'dance' || anim === 'wiggle') {
        splay = 0.16 + Math.sin(phase * 1.6) * 0.14;
        tip = Math.sin(phase * 1.8) * 0.28;
        wiggle = Math.sin(phase * 1.4) * 0.18;
      } else if (anim === 'spin' || anim === 'twirl') {
        splay = 0.28;
        tip = -0.22;
        wiggle = 0.14;
      } else if (anim === 'shake' || anim === 'shiver') {
        wiggle = Math.sin(t * (anim === 'shiver' ? 18 : 10) + arm.index) * 0.18;
      } else if (anim === 'float' || anim === 'sway' || anim === 'idle') {
        splay = 0.08 + Math.sin(t * 0.4 + arm.index * 0.4) * 0.06;
        tip = wave * 0.12;
      } else if (anim === 'stretch') {
        droop = -0.12;
        splay = 0.2;
        tip = 0.16;
      } else if (anim === 'peek') {
        wiggle = wave * 0.08;
        splay = 0.1;
      } else if (anim === 'pulse') {
        splay = 0.06 + squash * 0.2;
      }

      const out = splay * (arm.kind === 'hang' ? 0.45 : 0.75);
      arm.root.rotation.set(
        -droop + (arm.kind === 'hang' ? -splay * 0.22 : splay * 0.08) + wave * 0.03 + tip * 0.08,
        arm.sx * wiggle * 0.22,
        arm.sx * out * 0.32 + wiggle * 0.18,
      );
    }
  }

  _heartPulse(t) {
    const phase = (t * 1.35) % 1;
    let p = 0;
    if (phase < 0.11) p = Math.sin((phase / 0.11) * Math.PI);
    else if (phase > 0.16 && phase < 0.28) p = 0.65 * Math.sin(((phase - 0.16) / 0.12) * Math.PI);
    return 1 + p * 0.055;
  }

  _updateAnim(delta, t) {
    const damp = (v, to) => THREE.MathUtils.damp(v, to, 6, delta);
    if (!MOVED.has(this.animation)) {
      const pulse = this._feel === 'love' ? this._heartPulse(t) : 1;
      this.scale.x = damp(this.scale.x, pulse);
      this.scale.y = damp(this.scale.y, pulse);
      this.scale.z = damp(this.scale.z, pulse);
    }
    if (this.animation === 'none') {
      return;
    }
    if (this.animation === 'idle') {
      // Breath: slow inhale, tiny hold, longer exhale — not a sine pump.
      const cycle = (t * 0.32) % 1;
      let air = 0;
      if (cycle < 0.34) air = Math.sin((cycle / 0.34) * Math.PI * 0.5);
      else if (cycle < 0.44) air = 1;
      else air = Math.cos(((cycle - 0.44) / 0.56) * Math.PI * 0.5);
      const deep = ((t * 0.32) % 4) < 1 ? 1.35 : 1;
      const breath = air * deep;
      const sy = 1 + breath * 0.026;
      const sxz = 1 - breath * 0.015;
      const pulse = this._feel === 'love' ? this._heartPulse(t) : 1;
      this.scale.set(sxz * pulse, sy * pulse, sxz * pulse);
      this.position.y = this.radius * (sy - 1) * 0.85;
      // Soft weight shift, not a pendulum.
      const sway = (t * 0.18) % 1;
      let yaw = -0.03;
      if (sway < 0.3) yaw = -0.08;
      else if (sway < 0.4) yaw = THREE.MathUtils.lerp(-0.08, 0.07, (sway - 0.3) / 0.1);
      else if (sway < 0.72) yaw = 0.07;
      else if (sway < 0.82) yaw = THREE.MathUtils.lerp(0.07, -0.03, (sway - 0.72) / 0.1);
      this.rotation.y = yaw;
      this.rotation.x = 0.015 + (1 - air) * 0.012;
      this.rotation.z = damp(this.rotation.z, 0);
      return;
    }
    if (this.animation === 'bounce') {
      // Crouch, pop, hang, land squash — not a metronome sine.
      const phase = (t * 1.12) % 1;
      let hop = 0;
      let squash = 0;
      if (phase < 0.18) {
        squash = Math.sin((phase / 0.18) * Math.PI * 0.5);
        hop = -0.1 * squash;
      } else if (phase < 0.26) {
        squash = 1;
        hop = -0.1;
      } else if (phase < 0.5) {
        const u = (phase - 0.26) / 0.24;
        hop = -0.1 + 1.1 * Math.sin(u * Math.PI * 0.5);
        squash = hop < 0 ? -hop : -0.38 * hop;
      } else if (phase < 0.64) {
        hop = 1;
        squash = -0.38;
      } else if (phase < 0.82) {
        const u = (phase - 0.64) / 0.18;
        hop = Math.cos(u * Math.PI * 0.5);
        squash = -0.38 * hop;
      } else {
        squash = Math.sin(((phase - 0.82) / 0.18) * Math.PI) * 0.28;
        hop = 0;
      }
      const sy = 1 - squash * 0.22;
      const sxz = 1 + squash * 0.15;
      this.scale.set(sxz, sy, sxz);
      this.position.y = Math.max(0, hop) * this.radius * 0.28 + this.radius * (sy - 1);
      this.rotation.x = hop < 0 ? -hop * 0.14 : hop * 0.035;
      this.rotation.y = damp(this.rotation.y, 0);
      this.rotation.z = damp(this.rotation.z, 0);
      return;
    }
    if (this.animation === 'spin') {
      // Dizzy top: lean into the turn, flare out, tiny precession wobble.
      this.rotation.y += delta * 2.8;
      const precess = t * 3.2;
      this.rotation.x = 0.09 + Math.sin(precess) * 0.05;
      this.rotation.z = Math.cos(precess) * 0.055;
      const flare = 0.075 + 0.018 * Math.sin(t * 9.4);
      this.scale.set(1 + flare, 1 - flare * 0.68, 1 + flare);
      this.position.y = this.radius * (this.scale.y - 1) * 0.45;
      this.eyes.rotation.z = Math.sin(precess) * 0.04;
      return;
    }
    if (this.animation === 'nod') {
      // Fast dip, slower lift — a yes, not a metronome.
      const phase = (t * 1.55) % 1;
      let dip = 0;
      if (phase < 0.22) dip = Math.sin((phase / 0.22) * Math.PI * 0.5);
      else if (phase < 0.32) dip = 1;
      else if (phase < 0.72) dip = Math.cos(((phase - 0.32) / 0.4) * Math.PI * 0.5);
      const squash = dip * 0.08;
      this.rotation.x = 0.04 + dip * 0.22;
      this.scale.set(1 + squash * 0.55, 1 - squash, 1 + squash * 0.55);
      this.position.y = this.radius * (-squash * 0.35);
      this.rotation.y = damp(this.rotation.y, 0);
      this.rotation.z = damp(this.rotation.z, 0);
      return;
    }
    if (this.animation === 'shake') {
      // Anticipate, whip, overshoot, recoil — a no with weight.
      const phase = (t * 2.15) % 1;
      let look = -0.32;
      let lead = 0;
      let dip = 0;
      let squash = 0;
      if (phase < 0.2) {
        look = -0.32;
      } else if (phase < 0.28) {
        const u = (phase - 0.2) / 0.08;
        look = -0.32 - u * 0.06;
        lead = -u * 0.04;
        dip = u * 0.03;
      } else if (phase < 0.4) {
        const u = (phase - 0.28) / 0.12;
        look = THREE.MathUtils.lerp(-0.38, 0.4, u);
        lead = THREE.MathUtils.lerp(-0.04, 0.08, u);
        dip = Math.sin(u * Math.PI) * 0.06;
        squash = Math.sin(u * Math.PI) * 0.055;
      } else if (phase < 0.5) {
        const u = (phase - 0.4) / 0.1;
        look = THREE.MathUtils.lerp(0.4, 0.32, u);
        lead = THREE.MathUtils.lerp(0.08, 0, u);
        dip = (1 - u) * 0.02;
        squash = (1 - u) * 0.03;
      } else if (phase < 0.68) {
        look = 0.32;
      } else if (phase < 0.76) {
        const u = (phase - 0.68) / 0.08;
        look = 0.32 + u * 0.06;
        lead = u * 0.04;
        dip = u * 0.03;
      } else if (phase < 0.88) {
        const u = (phase - 0.76) / 0.12;
        look = THREE.MathUtils.lerp(0.38, -0.4, u);
        lead = THREE.MathUtils.lerp(0.04, -0.08, u);
        dip = Math.sin(u * Math.PI) * 0.06;
        squash = Math.sin(u * Math.PI) * 0.055;
      } else {
        const u = (phase - 0.88) / 0.12;
        look = THREE.MathUtils.lerp(-0.4, -0.32, u);
        lead = THREE.MathUtils.lerp(-0.08, 0, u);
        dip = (1 - u) * 0.02;
        squash = (1 - u) * 0.025;
      }
      const sy = 1 - squash;
      this.scale.set(1 + squash * 0.7, sy, 1 + squash * 0.7);
      this.rotation.y = look;
      this.rotation.x = dip;
      this.rotation.z = -look * 0.08;
      this.eyes.rotation.y = -lead;
      this.position.y = this.radius * (sy - 1) * 0.45;
      return;
    }
    if (this.animation === 'look') {
      // Eyes dart first, head follows, then a settle squash.
      const phase = (t * 0.42) % 1;
      let yaw = 0;
      let pitch = 0.04;
      let lead = 0;
      let squash = 0;
      if (phase < 0.16) {
        yaw = -0.55; pitch = 0.08;
      } else if (phase < 0.22) {
        const u = (phase - 0.16) / 0.06;
        yaw = -0.55; pitch = 0.08;
        lead = u * 0.22;
      } else if (phase < 0.3) {
        const u = (phase - 0.22) / 0.08;
        yaw = THREE.MathUtils.lerp(-0.55, 0, u);
        pitch = THREE.MathUtils.lerp(0.08, 0.02, u);
        lead = THREE.MathUtils.lerp(0.22, -0.04, u);
        squash = Math.sin(u * Math.PI) * 0.045;
      } else if (phase < 0.42) {
        yaw = 0; pitch = 0.02;
        lead = phase < 0.36 ? THREE.MathUtils.lerp(-0.04, 0, (phase - 0.3) / 0.06) : 0;
      } else if (phase < 0.48) {
        const u = (phase - 0.42) / 0.06;
        yaw = 0; pitch = 0.02;
        lead = u * 0.24;
      } else if (phase < 0.56) {
        const u = (phase - 0.48) / 0.08;
        yaw = THREE.MathUtils.lerp(0, 0.58, u);
        pitch = THREE.MathUtils.lerp(0.02, -0.06, u);
        lead = THREE.MathUtils.lerp(0.24, -0.05, u);
        squash = Math.sin(u * Math.PI) * 0.045;
      } else if (phase < 0.72) {
        yaw = 0.58; pitch = -0.06;
        lead = phase < 0.62 ? THREE.MathUtils.lerp(-0.05, 0, (phase - 0.56) / 0.06) : 0;
      } else if (phase < 0.78) {
        const u = (phase - 0.72) / 0.06;
        yaw = 0.58; pitch = -0.06;
        lead = -u * 0.22;
      } else if (phase < 0.86) {
        const u = (phase - 0.78) / 0.08;
        yaw = THREE.MathUtils.lerp(0.58, 0, u);
        pitch = THREE.MathUtils.lerp(-0.06, 0.04, u);
        lead = THREE.MathUtils.lerp(-0.22, 0.04, u);
        squash = Math.sin(u * Math.PI) * 0.04;
      } else {
        yaw = 0; pitch = 0.04;
        lead = phase < 0.92 ? THREE.MathUtils.lerp(0.04, 0, (phase - 0.86) / 0.06) : 0;
      }
      const sy = 1 - squash;
      this.scale.set(1 + squash * 0.55, sy, 1 + squash * 0.55);
      this.rotation.y = yaw;
      this.rotation.x = pitch;
      this.rotation.z = yaw * 0.06;
      this.eyes.rotation.y = lead;
      this.eyes.rotation.x = -pitch * 0.12;
      this.position.y = this.radius * (sy - 1) * 0.5;
      return;
    }
    if (this.animation === 'excited') {
      // Crouch, three sided hops with hang and land, then rest.
      const phase = (t * 0.88) % 1;
      let hop = 0;
      let lean = 0;
      let yaw = 0;
      if (phase < 0.14) {
        const u = phase / 0.14;
        hop = -0.24 * Math.sin(u * Math.PI * 0.5);
        lean = -0.03 * u;
      } else if (phase < 0.76) {
        const u = (phase - 0.14) / 0.62;
        const hopI = Math.min(2, Math.floor(u * 3));
        const local = u * 3 - hopI;
        const sides = [-0.16, 0.18, -0.1];
        yaw = sides[hopI];
        lean = sides[hopI] * 0.85;
        if (local < 0.28) hop = Math.sin((local / 0.28) * Math.PI * 0.5);
        else if (local < 0.5) hop = 1;
        else hop = Math.cos(((local - 0.5) / 0.5) * Math.PI * 0.5);
      } else {
        const u = (phase - 0.76) / 0.24;
        hop = u < 0.45 ? 0.1 * Math.sin((u / 0.45) * Math.PI) : 0;
      }
      const land = hop < 0 ? 0 : 1 - hop;
      const squash = hop < 0 ? -hop : land * 0.16 - hop * 0.09;
      const sy = 1 - squash;
      const sxz = 1 + squash * 0.7;
      this.scale.set(sxz, sy, sxz);
      this.position.y = Math.max(0, hop) * this.radius * 0.3 + this.radius * (sy - 1);
      this.rotation.z = lean;
      this.rotation.y = yaw;
      this.rotation.x = hop < 0 ? -hop * 0.15 : hop * 0.04;
      return;
    }
    if (this.animation === 'sleep') {
      // Snore: slow inhale, tiny hold, then a longer collapsing exhale.
      const phase = (t * 0.3) % 1;
      let air = 0;
      if (phase < 0.36) air = Math.sin((phase / 0.36) * Math.PI * 0.5);
      else if (phase < 0.44) air = 1;
      else air = Math.cos(((phase - 0.44) / 0.56) * Math.PI * 0.5);
      this._snore = air;
      const rumble = phase > 0.44 ? Math.sin(t * 26) * (1 - air) * 0.014 : 0;
      const inflate = air * 0.055;
      const sag = (1 - air) * 0.028;
      this.scale.set(1 + inflate - sag * 0.35, 1 - inflate * 0.32 + sag, 1 + inflate - sag * 0.35);
      this.position.y = this.radius * (this.scale.y - 1) * 0.5;
      // Heavy roll: hold a side, then flop the other way — not a pendulum.
      const rollPhase = (t * 0.09) % 1;
      let roll = -0.06;
      if (rollPhase < 0.38) roll = -0.08;
      else if (rollPhase < 0.48) roll = THREE.MathUtils.lerp(-0.08, 0.07, (rollPhase - 0.38) / 0.1);
      else if (rollPhase < 0.86) roll = 0.07;
      else if (rollPhase < 0.96) roll = THREE.MathUtils.lerp(0.07, -0.06, (rollPhase - 0.86) / 0.1);
      this.rotation.z = roll + rumble;
      this.rotation.x = 0.09 + (1 - air) * 0.05;
      this.rotation.y = damp(this.rotation.y, 0);
      return;
    }
    if (this.animation === 'talk') {
      // Word-stress pops, then a think-pause swallow — not a sine nod.
      const phrase = (t * 0.22) % 1;
      let dip = 0;
      let yaw = 0;
      let squash = 0;
      if (phrase < 0.12) {
        dip = Math.sin((phrase / 0.12) * Math.PI) * 0.65;
        yaw = -0.055;
      } else if (phrase < 0.28) {
        dip = Math.sin(((phrase - 0.12) / 0.16) * Math.PI);
        yaw = 0.05;
      } else if (phrase < 0.4) {
        dip = Math.sin(((phrase - 0.28) / 0.12) * Math.PI) * 0.5;
        yaw = -0.04;
      } else if (phrase < 0.56) {
        dip = Math.sin(((phrase - 0.4) / 0.16) * Math.PI) * 1.12;
        yaw = 0.08;
        squash = dip * 0.035;
      } else if (phrase < 0.78) {
        const u = (phrase - 0.56) / 0.22;
        dip = 0.16 * Math.sin(u * Math.PI * 2);
        yaw = THREE.MathUtils.lerp(0.08, -0.03, u);
      } else {
        const u = (phrase - 0.78) / 0.22;
        dip = u < 0.4 ? Math.sin((u / 0.4) * Math.PI) * 0.28 : 0.04;
        yaw = -0.045;
        squash = u < 0.4 ? dip * 0.1 : 0;
      }
      const sy = 1 - squash;
      this.scale.set(1 + squash * 0.65, sy, 1 + squash * 0.65);
      this.rotation.x = 0.02 + dip * 0.085;
      this.rotation.y = yaw;
      this.rotation.z = phrase > 0.78 ? -0.028 : 0;
      this.position.y = this.radius * (sy - 1) * 0.45 + dip * this.radius * 0.01;
      return;
    }
    if (this.animation === 'dance') {
      // Two-step: hop hop, hold a lean, then the other side.
      const phase = (t * 0.82) % 1;
      let hop = 0;
      let lean = 0;
      let yaw = 0;
      const step = (u) => Math.sin(Math.min(1, Math.max(0, u)) * Math.PI);
      if (phase < 0.12) {
        hop = step(phase / 0.12);
        lean = -0.14;
        yaw = -0.2;
      } else if (phase < 0.24) {
        hop = step((phase - 0.12) / 0.12);
        lean = -0.2;
        yaw = -0.3;
      } else if (phase < 0.48) {
        hop = 0.1 * (0.45 + 0.55 * Math.sin((phase - 0.24) * 16));
        lean = -0.24;
        yaw = -0.34;
      } else if (phase < 0.6) {
        hop = step((phase - 0.48) / 0.12);
        lean = 0.14;
        yaw = 0.2;
      } else if (phase < 0.72) {
        hop = step((phase - 0.6) / 0.12);
        lean = 0.2;
        yaw = 0.3;
      } else {
        hop = 0.1 * (0.45 + 0.55 * Math.sin((phase - 0.72) * 16));
        lean = 0.24;
        yaw = 0.34;
      }
      const land = 1 - hop;
      const sy = 1 - land * 0.15 + hop * 0.06;
      const sxz = 1 + land * 0.11 - hop * 0.04;
      this.scale.set(sxz, sy, sxz);
      this.position.y = hop * this.radius * 0.16 + this.radius * (sy - 1);
      this.rotation.z = lean;
      this.rotation.y = yaw;
      this.rotation.x = hop * 0.05;
      return;
    }
    if (this.animation === 'float') {
      const air = 0.5 + 0.5 * Math.sin(t * 1.1);
      this.position.y = this.radius * (0.08 + air * 0.1);
      this.rotation.z = Math.sin(t * 0.7) * 0.08;
      this.rotation.x = Math.sin(t * 0.55) * 0.04;
      this.scale.set(1 - air * 0.02, 1 + air * 0.03, 1 - air * 0.02);
      return;
    }
    if (this.animation === 'sway') {
      const phase = (t * 0.55) % 1;
      let lean = -0.18;
      if (phase < 0.4) lean = -0.2;
      else if (phase < 0.5) lean = THREE.MathUtils.lerp(-0.2, 0.2, (phase - 0.4) / 0.1);
      else if (phase < 0.9) lean = 0.2;
      else lean = THREE.MathUtils.lerp(0.2, -0.18, (phase - 0.9) / 0.1);
      this.rotation.z = lean;
      this.rotation.y = lean * 0.45;
      this.position.y = this.radius * Math.abs(lean) * 0.08;
      this.scale.set(1 + Math.abs(lean) * 0.06, 1 - Math.abs(lean) * 0.04, 1 + Math.abs(lean) * 0.04);
      return;
    }
    if (this.animation === 'wiggle') {
      this.rotation.z = Math.sin(t * 7.2) * 0.1;
      this.rotation.y = Math.sin(t * 5.4) * 0.12;
      this.rotation.x = Math.sin(t * 6.1) * 0.05;
      this.scale.set(1 + Math.sin(t * 8) * 0.04, 1 - Math.sin(t * 8) * 0.03, 1 + Math.sin(t * 8) * 0.03);
      this.position.y = this.radius * 0.02;
      return;
    }
    if (this.animation === 'hop') {
      const phase = (t * 1.8) % 1;
      let hop = 0;
      let squash = 0;
      if (phase < 0.16) squash = Math.sin((phase / 0.16) * Math.PI);
      else if (phase < 0.55) hop = Math.sin(((phase - 0.16) / 0.39) * Math.PI);
      else squash = 0.45 * Math.sin(((phase - 0.55) / 0.18) * Math.PI);
      const sy = 1 - squash * 0.18 + hop * 0.06;
      this.scale.set(1 + squash * 0.14 - hop * 0.04, sy, 1 + squash * 0.14 - hop * 0.04);
      this.position.y = hop * this.radius * 0.22 + this.radius * (sy - 1);
      this.rotation.x = hop * 0.05 - squash * 0.08;
      return;
    }
    if (this.animation === 'cheer') {
      const phase = (t * 1.05) % 1;
      let hop = 0;
      if (phase < 0.18) hop = -0.2 * Math.sin((phase / 0.18) * Math.PI * 0.5);
      else if (phase < 0.72) hop = Math.sin(((phase - 0.18) / 0.54) * Math.PI);
      const squash = hop < 0 ? -hop : (1 - hop) * 0.12;
      const sy = 1 - squash;
      this.scale.set(1 + squash * 0.5, sy, 1 + squash * 0.5);
      this.position.y = Math.max(0, hop) * this.radius * 0.34 + this.radius * (sy - 1);
      this.rotation.z = Math.sin(t * 8) * hop * 0.08;
      return;
    }
    if (this.animation === 'shiver') {
      this.rotation.z = Math.sin(t * 22) * 0.045;
      this.rotation.x = 0.06 + Math.sin(t * 18) * 0.02;
      this.position.x = Math.sin(t * 26) * this.radius * 0.012;
      this.scale.set(1.03, 0.97, 1.03);
      return;
    }
    if (this.animation === 'stretch') {
      const phase = (t * 0.45) % 1;
      let tall = 0;
      if (phase < 0.28) tall = Math.sin((phase / 0.28) * Math.PI * 0.5);
      else if (phase < 0.55) tall = 1;
      else tall = Math.cos(((phase - 0.55) / 0.45) * Math.PI * 0.5);
      this.scale.set(1 - tall * 0.08, 1 + tall * 0.16, 1 - tall * 0.08);
      this.position.y = this.radius * tall * 0.08;
      this.rotation.x = -tall * 0.06;
      return;
    }
    if (this.animation === 'peek') {
      const phase = (t * 0.38) % 1;
      let yaw = 0;
      let lean = 0;
      if (phase < 0.22) { yaw = -0.7; lean = -0.12; }
      else if (phase < 0.32) {
        const u = (phase - 0.22) / 0.1;
        yaw = THREE.MathUtils.lerp(-0.7, 0.7, u);
        lean = THREE.MathUtils.lerp(-0.12, 0.12, u);
      } else if (phase < 0.54) { yaw = 0.7; lean = 0.12; }
      else if (phase < 0.64) {
        const u = (phase - 0.54) / 0.1;
        yaw = THREE.MathUtils.lerp(0.7, 0, u);
        lean = THREE.MathUtils.lerp(0.12, 0, u);
      }
      this.rotation.y = yaw;
      this.rotation.z = lean;
      this.rotation.x = 0.05;
      this.eyes.rotation.y = yaw * 0.25;
      return;
    }
    if (this.animation === 'pulse') {
      const beat = this._heartPulse(t * 1.15) - 1;
      this.scale.set(1 - beat * 1.8, 1 + beat * 2.6, 1 - beat * 1.8);
      this.position.y = this.radius * beat * 0.8;
      return;
    }
    if (this.animation === 'twirl') {
      this.rotation.y += delta * 5.2;
      const bounce = Math.abs(Math.sin(t * 6.4));
      this.position.y = bounce * this.radius * 0.12;
      this.scale.set(1 + bounce * 0.04, 1 - bounce * 0.05, 1 + bounce * 0.04);
      this.rotation.z = Math.sin(t * 8) * 0.08;
    }
  }

  dispose() {
    this.body.geometry.dispose();
    if (this._eyeGeos) {
      const seen = new Set();
      for (const g of Object.values(this._eyeGeos)) {
        if (g && !seen.has(g)) {
          seen.add(g);
          g.dispose();
        }
      }
    }
    for (const g of Object.values(this._geos)) g.dispose();
    this._clearTentacles();
    this.bodyMaterial.dispose();
    this.eyeMaterial.dispose();
    this.whiteMaterial?.dispose();
    this.pupilMaterial?.dispose();
    this.accentMaterial?.dispose();
    this.starMaterial?.dispose();
    this.tearMaterial?.dispose();
    this.blushMaterial?.dispose();
    this.fillMaterial?.dispose();
    this.bellyMaterial?.dispose();
    this.suckerMaterial?.dispose();
  }
}

export function createGrokBot(options) {
  return new GrokBot(options);
}
