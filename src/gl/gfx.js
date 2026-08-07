/**
 * gfx.js — minimal WebGL2 layer: matrix maths, shader/program helpers, buffers,
 * vertex arrays, framebuffers. No dependencies, same as the rest of the project.
 */

// ---------------------------------------------------------------------------
// mat4 / vec3  (column-major, same layout WebGL expects)
// ---------------------------------------------------------------------------

export const m4 = {
  create: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),

  identity(o) { o.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); return o; },

  perspective(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    o[0]=f/aspect; o[1]=0; o[2]=0; o[3]=0;
    o[4]=0; o[5]=f; o[6]=0; o[7]=0;
    o[8]=0; o[9]=0; o[10]=(far+near)*nf; o[11]=-1;
    o[12]=0; o[13]=0; o[14]=2*far*near*nf; o[15]=0;
    return o;
  },

  lookAt(o, eye, center, up) {
    let z0=eye[0]-center[0], z1=eye[1]-center[1], z2=eye[2]-center[2];
    let l = 1/Math.hypot(z0,z1,z2); z0*=l; z1*=l; z2*=l;
    let x0=up[1]*z2-up[2]*z1, x1=up[2]*z0-up[0]*z2, x2=up[0]*z1-up[1]*z0;
    l = Math.hypot(x0,x1,x2); l = l ? 1/l : 0; x0*=l; x1*=l; x2*=l;
    const y0=z1*x2-z2*x1, y1=z2*x0-z0*x2, y2=z0*x1-z1*x0;
    o[0]=x0; o[1]=y0; o[2]=z0; o[3]=0;
    o[4]=x1; o[5]=y1; o[6]=z1; o[7]=0;
    o[8]=x2; o[9]=y2; o[10]=z2; o[11]=0;
    o[12]=-(x0*eye[0]+x1*eye[1]+x2*eye[2]);
    o[13]=-(y0*eye[0]+y1*eye[1]+y2*eye[2]);
    o[14]=-(z0*eye[0]+z1*eye[1]+z2*eye[2]);
    o[15]=1;
    return o;
  },

  multiply(o, a, b) {
    for (let i = 0; i < 4; i++) {
      const b0=b[i*4], b1=b[i*4+1], b2=b[i*4+2], b3=b[i*4+3];
      o[i*4]   = b0*a[0] + b1*a[4] + b2*a[8]  + b3*a[12];
      o[i*4+1] = b0*a[1] + b1*a[5] + b2*a[9]  + b3*a[13];
      o[i*4+2] = b0*a[2] + b1*a[6] + b2*a[10] + b3*a[14];
      o[i*4+3] = b0*a[3] + b1*a[7] + b2*a[11] + b3*a[15];
    }
    return o;
  },

  compose(o, pos, rotY, rotX, rotZ, scale) {
    const cy=Math.cos(rotY), sy=Math.sin(rotY);
    const cx=Math.cos(rotX), sx=Math.sin(rotX);
    const cz=Math.cos(rotZ), sz=Math.sin(rotZ);
    const sX = scale[0], sY = scale[1], sZ = scale[2];
    // R = Ry * Rx * Rz
    const m00 =  cy*cz + sy*sx*sz, m01 = -cy*sz + sy*sx*cz, m02 = sy*cx;
    const m10 =  cx*sz,            m11 =  cx*cz,            m12 = -sx;
    const m20 = -sy*cz + cy*sx*sz, m21 =  sy*sz + cy*sx*cz, m22 = cy*cx;
    o[0]=m00*sX; o[1]=m10*sX; o[2]=m20*sX; o[3]=0;
    o[4]=m01*sY; o[5]=m11*sY; o[6]=m21*sY; o[7]=0;
    o[8]=m02*sZ; o[9]=m12*sZ; o[10]=m22*sZ; o[11]=0;
    o[12]=pos[0]; o[13]=pos[1]; o[14]=pos[2]; o[15]=1;
    return o;
  },

  /** Inverse-transpose of the upper 3x3, for normals under non-uniform scale. */
  normalMat(o9, m) {
    const a00=m[0],a01=m[1],a02=m[2], a10=m[4],a11=m[5],a12=m[6], a20=m[8],a21=m[9],a22=m[10];
    const b01= a22*a11-a12*a21, b11=-a22*a10+a12*a20, b21= a21*a10-a11*a20;
    let det = a00*b01 + a01*b11 + a02*b21;
    if (!det) { o9.set([1,0,0,0,1,0,0,0,1]); return o9; }
    det = 1/det;
    o9[0]=b01*det; o9[1]=(-a22*a01+a02*a21)*det; o9[2]=( a12*a01-a02*a11)*det;
    o9[3]=b11*det; o9[4]=( a22*a00-a02*a20)*det; o9[5]=(-a12*a00+a02*a10)*det;
    o9[6]=b21*det; o9[7]=(-a21*a00+a01*a20)*det; o9[8]=( a11*a00-a01*a10)*det;
    return o9;
  },
};

export const v3 = {
  add: (o,a,b) => (o[0]=a[0]+b[0], o[1]=a[1]+b[1], o[2]=a[2]+b[2], o),
  scale: (o,a,s) => (o[0]=a[0]*s, o[1]=a[1]*s, o[2]=a[2]*s, o),
};

// ---------------------------------------------------------------------------
// GL helpers
// ---------------------------------------------------------------------------

export function createProgram(gl, vsSrc, fsSrc, name = 'program') {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
      throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader:\n${log}\n${numbered}`);
    }
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`[${name}] link: ${gl.getProgramInfoLog(p)}`);
  }
  // Cache uniform locations up front — getUniformLocation per frame is slow.
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const base = info.name.replace(/\[0\]$/, '');
    u[base] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, u };
}

/**
 * A mesh with interleaved [position(3), normal(3), uv(2), color(3)] vertices,
 * optionally instanced by a per-instance mat4 + colour.
 */
export function createMesh(gl, data, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const stride = 11 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 32);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, count: indices.length, vbo, ibo, instanceBuf: null, instances: 0 };
}

/** Attach a dynamic per-instance mat4 (loc 4..7) + colour (loc 8) stream. */
export function addInstancing(gl, mesh, maxInstances) {
  gl.bindVertexArray(mesh.vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, maxInstances * 20 * 4, gl.DYNAMIC_DRAW);
  const stride = 20 * 4;
  for (let i = 0; i < 4; i++) {
    gl.enableVertexAttribArray(4 + i);
    gl.vertexAttribPointer(4 + i, 4, gl.FLOAT, false, stride, i * 16);
    gl.vertexAttribDivisor(4 + i, 1);
  }
  gl.enableVertexAttribArray(8);
  gl.vertexAttribPointer(8, 4, gl.FLOAT, false, stride, 64);
  gl.vertexAttribDivisor(8, 1);
  gl.bindVertexArray(null);
  mesh.instanceBuf = buf;
  mesh.instanceData = new Float32Array(maxInstances * 20);
  return mesh;
}

export function createTarget(gl, w, h, { float = true, depth = true } = {}) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const internal = float ? gl.RGBA16F : gl.RGBA8;
  const type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  let rbo = null;
  if (depth) {
    rbo = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbo);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, rbo, w, h };
}

export function resizeTarget(gl, t, w, h, float = true) {
  t.w = w; t.h = h;
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  const internal = float ? gl.RGBA16F : gl.RGBA8;
  const type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
  if (t.rbo) {
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.rbo);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  }
}

/** Single triangle covering the screen — cheaper than a quad, no seam. */
export function createFullscreenTri(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
