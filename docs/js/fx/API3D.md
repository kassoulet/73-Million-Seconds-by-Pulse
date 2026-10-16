# scene3d.js API (stable)

```js
import { getScene, projectPoint, renderScene, SceneObject, Scene3D } from './scene3d.js';
```

* `getScene(ctx, name)` -> `Scene3D | null`. `name` is the **instance name of a `scene` event** (`jabole`, `kubes`, `scena`, `skeen`) or a
  loaded file name (`box3.exp`).
* `scene.getObject(name)` -> `SceneObject | null` (case-insensitive: `box01`, `Box02`, `GeoSphere01`, `aziz_2.lwo`).
  `scene.getLight(name)` (`f2.source01`, UEXP lights; `l.pos` = `[x,y,z]` world, valid after `evaluate`), `scene.getNull(name)` (UNLW nulls, `.pos`).
* `SceneObject`: `name`, `world` (Float64Array(16), column-major object->world, current frame), `bbox` `[minx,miny,minz,maxx,maxy,maxz]`
  (object space, `getBBox()`), `mesh` `{positions Float32Array(3n), normals, uv, indices Uint32Array(3t), tsurf, surfaces[]}`,
  `visible`, and
  `setMesh(positions Float32Array, indices Uint32Array, normals?, faceNormals?, {smooth})` which replaces the geometry
  (used by `marchingcubes`; positions are in object space, normals are derived when omitted).
* `scene.camera`: `{ pos: Float64Array(3) world eye, R: Float64Array(9) row-major, columns = camera right / down / forward in world space, zoom }`.
  Camera space point = `R^T (p - pos)`; screen `x = W/2 + cx*zoom/cz`, `y = H/2 + cy*zoom/cz` (y grows downwards, as in the original, error < 1e-3 px).
* `projectPoint(ctx, scene, p3 /*world [x,y,z]*/, out /*[sx,sy,camZ]*/)` -> `false` if the point is behind the near plane (z <= 1).
* `scene.evaluate(frame)` evaluates every animated entity at scene frame `frame`; the `scene` effect calls it once per displayed frame before drawing
  (`frame = seconds_since_start * speed + offset`, restarts when `frame - offset >= duration - 0.5`), so other effects that run after it in the same
  frame (volumes, flares) see the current pose.
* `scene.time`, `scene.duration`, `scene.flag` (`'i'` = beam scene), `scene.lwotr`, `scene.lwoshading`.
* `renderScene(ctx, scene, buf, beams)` draws a scene into a `Buf` (8/16/32 bpp); `Hooks.loadScene` is installed by importing the module.

Formats (`3d/formats.js`): `parseLWE`, `parseLWV`, `parseEXP` return plain data. Animation: `3d/anim.js` `evalKeys` (TCB Hermite).
