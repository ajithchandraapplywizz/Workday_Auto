/**
 * polyfills.mjs — Server-side DOM polyfills for headless Node environments
 *
 * Node.js (v22/v24) environments on Linux/Docker/Railway lack browser-native
 * canvas/DOM objects (DOMMatrix, ImageData, Path2D, DOMPoint).
 * When libraries like pdf-parse / pdfjs-dist are loaded, they attempt to initialize
 * these objects at module evaluation time.
 */

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
      this.is2D = true;
      this.isIdentity = true;
      if (Array.isArray(init)) {
        if (init.length === 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
          this.m11 = this.a; this.m12 = this.b; this.m21 = this.c; this.m22 = this.d;
          this.m41 = this.e; this.m42 = this.f;
        } else if (init.length === 16) {
          [
            this.m11, this.m12, this.m13, this.m14,
            this.m21, this.m22, this.m23, this.m24,
            this.m31, this.m32, this.m33, this.m34,
            this.m41, this.m42, this.m43, this.m44,
          ] = init;
          this.a = this.m11; this.b = this.m12; this.c = this.m21; this.d = this.m22;
          this.e = this.m41; this.f = this.m42;
          this.is2D = false;
        }
      }
    }
    translate() { return this; }
    scale() { return this; }
    scaleNonUniform() { return this; }
    rotate() { return this; }
    rotateAxisAngle() { return this; }
    skewX() { return this; }
    skewY() { return this; }
    multiply() { return this; }
    preMultiplySelf() { return this; }
    inverse() { return this; }
    invertSelf() { return this; }
    transformPoint(point) { return point; }
    toFloat32Array() { return new Float32Array(16); }
    toFloat64Array() { return new Float64Array(16); }
  };
}

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(width, height) {
      this.width = width || 0;
      this.height = height || 0;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
  };
}

if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {
    addPath() {}
    closePath() {}
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    ellipse() {}
    rect() {}
  };
}

if (typeof globalThis.DOMPoint === 'undefined') {
  globalThis.DOMPoint = class DOMPoint {
    constructor(x = 0, y = 0, z = 0, w = 1) {
      this.x = x; this.y = y; this.z = z; this.w = w;
    }
    matrixTransform() { return this; }
  };
}
