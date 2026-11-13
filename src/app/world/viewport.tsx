"use client";

/* ------------------------------------------------------------------ *
 * SIMPLAYZ SECTOR VIEWER
 * three.js scene: streamed OSM raster draped over engine-generated
 * relief, player parcels as lock domes, structures as extruded footprints,
 * and a four-mode camera rig (bird / build / tour-fps / tour-tps).
 * ------------------------------------------------------------------ */

import * as THREE from "three";
import { useEffect, useRef } from "react";
import { SectorFrame, metersPerPixel, tileForLngLat } from "@/engine/geo";
import { BIOMES, quickSample, sampleTerrain, surveyParcel, type SurveyResult } from "@/engine/terrain";
import { KIND_MAP, effectiveHeight, footprintFor } from "@/engine/buildings";
import { hashSeed } from "@/engine/terrain";
import { CARTO_PALETTE, paintFlatColor, type MapPalette } from "@/engine/palette";
import type { MapStyle, Theme } from "@/engine/themes";
import type { ClaimDTO, WorldConfigDTO } from "@/lib/types";
import { useWorld, type HoverInfo, type Mode } from "./store";
import { useTheme } from "../theme-store";

const TILES_WIDE = 3;
const SEG = 26;
const surveyCache = new Map<string, SurveyResult>();
const texCache = new Map<string, THREE.Texture>();

function claimSurvey(claim: ClaimDTO, config: WorldConfigDTO) {
  const key = `${claim.id}:${config.terrainSeed}:${claim.sizeM}:${config.gridCells}`;
  let s = surveyCache.get(key);
  if (!s) {
    s = surveyParcel(claim.centerLng, claim.centerLat, claim.sizeM, config.gridCells, config.terrainSeed, claim.tileZ);
    surveyCache.set(key, s);
  }
  return s;
}

function facadeTexture(color: string, style: "tower" | "shed" | "shop" | "civic") {
  const hit = texCache.get(`facade:${color}:${style}`);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = color;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "rgba(0,0,0,0.28)";
    for (let i = 0; i < 128; i += 4) g.fillRect(0, i, 128, 1);
    const cols = style === "tower" ? 6 : 4;
    const rows = style === "tower" ? 8 : 3;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const lit = hashSeed(x * 13 + y * 7, rows + cols) > 0.52;
        g.fillStyle = lit ? "rgba(255,236,180,0.95)" : "rgba(10,18,24,0.85)";
        const w = 128 / cols;
        const h = 128 / rows;
        g.fillRect(x * w + w * 0.24, y * h + h * 0.26, w * 0.52, h * 0.44);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(`facade:${color}:${style}`, t);
  return t;
}

function flatTexture(color: string, kind: "road" | "field" | "panel" | "park") {
  const hit = texCache.get(`flat:${color}:${kind}`);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = color;
    g.fillRect(0, 0, 64, 64);
    if (kind === "road") {
      g.fillStyle = "rgba(226,226,226,0.7)";
      for (let i = 0; i < 64; i += 16) g.fillRect(30, i, 4, 9);
    } else if (kind === "field") {
      for (let i = 0; i < 64; i += 6) {
        g.fillStyle = i % 12 === 0 ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.10)";
        g.fillRect(0, i, 64, 3);
      }
    } else if (kind === "panel") {
      g.fillStyle = "rgba(120,190,255,0.35)";
      for (let y = 0; y < 64; y += 16) for (let x = 0; x < 64; x += 16) g.fillRect(x + 2, y + 2, 12, 12);
    } else {
      for (let i = 0; i < 90; i++) {
        const x = (i * 37) % 64;
        const y = (i * 53) % 64;
        g.fillStyle = "rgba(255,255,255,0.10)";
        g.fillRect(x, y, 2, 4);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(`flat:${color}:${kind}`, t);
  return t;
}

function labelTexture(text: string, color: string) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "rgba(4,8,11,0.72)";
    g.fillRect(0, 8, 256, 48);
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.strokeRect(1, 9, 254, 46);
    g.fillStyle = color;
    g.font = "600 24px ui-monospace, monospace";
    g.textAlign = "center";
    g.fillText(text.slice(0, 20), 128, 41);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface EngineView {
  claims: ClaimDTO[];
  config: WorldConfigDTO;
  activeClaimId: string | null;
  mode: Mode;
  selectedKind: string | null;
  rotation: number;
  tool: "build" | "demolish" | "inspect";
  timeOfDay: number;
  pilotId: string | null;
  /** active UI theme (drives the flat map ramps when mapStyle is "themed") */
  theme: Theme;
  mapStyle: MapStyle;
  /**
   * How the streamed raster stacks on the flat map:
   *   flat    engine cartography only (no network)
   *   stacked flat base + raster overlay at `tileOpacity`
   *   raster  raster at full strength (overlay opacity forced to 1)
   */
  mapLayers: MapLayers;
  tileOpacity: number;
}

export type MapLayers = "flat" | "stacked" | "raster";

interface EngineCallbacks {
  onHover: (info: HoverInfo | null) => void;
  onPlace: (cellX: number, cellY: number) => void;
  onPickBuilding: (claimId: string, buildingId: string) => void;
  onPickClaim: (claimId: string) => void;
  onTelemetry: (t: Telemetry) => void;
  onLeaveTour: () => void;
}

export class SimplayzEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun = new THREE.DirectionalLight(0xfff0d8, 1.5);
  private hemi = new THREE.HemisphereLight(0x9fd6ff, 0x2c3a30, 0.5);
  private sky!: THREE.Mesh;
  private stars!: THREE.Points;
  private water!: THREE.Mesh;
  private gridHelper!: THREE.LineSegments;
  private sectorGroup = new THREE.Group();
  private claimGroup = new THREE.Group();
  private avatarGroup = new THREE.Group();
  private ghost: THREE.Mesh | null = null;
  private pickables: THREE.Object3D[] = [];
  private tileMeshes: THREE.Mesh[] = [];
  private queue: { tx: number; ty: number }[] = [];
  private frame: SectorFrame;
  private clock = new THREE.Clock();
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2(0.5, 0.5);
  private pointerPx = new THREE.Vector2(0, 0);
  private down = { x: 0, y: 0, t: 0, button: 0, moved: false };
  private drag: "none" | "pan" | "orbit" = "none";
  private camRig = { target: new THREE.Vector3(0, 0, 0), dist: 780, yaw: 0.75, pitch: 0.85 };
  private av = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(), yaw: 0.6, pitch: 0.06, vy: 0, grounded: true, bob: 0, speed: 0 };
  private keys = new Set<string>();
  private view: EngineView | null = null;
  private viewKey = "";
  private sectorKey = "";
  private paletteKey = "";
  private tileSource = "flat-engine";
  /** streamed raster planes stacked over the flat base */
  private overlayMeshes: THREE.Mesh[] = [];
  private mapLayers: MapLayers = "stacked";
  private tileOpacity = 0.55;
  /** provenance of the most recent tile the streamer returned */
  private overlayState = "raw";
  private overlayAborts: AbortController[] = [];
  private seed = 20770418;
  /** flat map ramp currently painted (colour-as-data cartography by default) */
  private map: MapPalette = CARTO_PALETTE;
  private running = true;
  private frames = 0;
  private fpsClock = 0;
  private fps = 60;
  private tilesLoaded = 0;
  private nightFactor = 0;
  private disposed = false;
  private ro: ResizeObserver | null = null;

  constructor(private host: HTMLElement, private cb: EngineCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.85));
    this.renderer.setSize(host.clientWidth || 1280, host.clientHeight || 720);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";
    (window as unknown as { __simplayz?: SimplayzEngine }).__simplayz = this;

    this.camera = new THREE.PerspectiveCamera(52, (host.clientWidth || 1280) / (host.clientHeight || 720), 0.4, 9000);
    this.scene.add(new THREE.AmbientLight(0x8fb8d0, 0.32));
    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 50;
    this.sun.shadow.camera.far = 2600;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -700;
    sc.right = 700;
    sc.top = 700;
    sc.bottom = -700;
    this.sun.shadow.bias = -0.0009;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(this.sectorGroup);
    this.scene.add(this.claimGroup);
    this.scene.add(this.avatarGroup);

    this.frame = new SectorFrame(0, 0, 15, TILES_WIDE);
    this.buildSky();
    this.buildWater();
    this.buildStars();
    this.buildGrid();
    this.setCenter(13.4145, 52.4989);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("contextmenu", this.onContext);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("pointerlockchange", this.onLockChange);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.renderer.setAnimationLoop(this.tick);
  }

  /* ------------------------------ scene ------------------------------ */

  private buildSky() {
    const geo = new THREE.SphereGeometry(4600, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color("#0d1a24") },
        bottom: { value: new THREE.Color("#122630") },
        exponent: { value: 1.6 },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform float exponent; varying vec3 vPos;
        void main(){ float hgt = normalize(vPos).y; float f = pow(max(hgt, 0.0), exponent); vec3 col = mix(bottom, top, f); gl_FragColor = vec4(col, 1.0); }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.sky);
  }

  private buildStars() {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.random() * 0.9;
      const r = 4300;
      pos[i * 3] = Math.cos(u) * Math.sqrt(1 - v * v) * r;
      pos[i * 3 + 1] = v * r;
      pos[i * 3 + 2] = Math.sin(u) * Math.sqrt(1 - v * v) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xdfeaff, size: 7, sizeAttenuation: true, transparent: true, opacity: 0 }));
    this.scene.add(this.stars);
  }

  /**
   * 1.0.0 is a flat map: sea and lakes are painted per-vertex by the
   * palette, so there is no second water surface. The placeholder mesh is
   * kept (invisible) because parcel fills and trail colours reference its
   * transform helpers elsewhere in the tick loop.
   */
  private buildWater() {
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    this.water = new THREE.Mesh(geo, mat);
    this.water.visible = false;
    this.scene.add(this.water);
  }

  private buildGrid() {
    const span = this.frame.sizeM * TILES_WIDE;
    const step = 250;
    const pts: number[] = [];
    for (let v = -span / 2; v <= span / 2 + 1; v += step) {
      pts.push(-span / 2, 0, v, span / 2, 0, v);
      pts.push(v, 0, -span / 2, v, 0, span / 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.gridHelper = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fb8c4, transparent: true, opacity: 0.14 }));
    this.gridHelper.position.y = 1.5;
    this.scene.add(this.gridHelper);
  }

  /* ------------------------------ sector ------------------------------ */

  setCenter(lng: number, lat: number) {
    this.frame = new SectorFrame(lng, lat, 15, TILES_WIDE);
    const t = this.frame.lngLatToLocal(lng, lat);
    this.camRig.target.set(t.x, 0, t.y);
    this.av.pos.set(t.x, 0, t.y);
    const base = new THREE.Vector3(t.x, 0, t.y);
    this.camRig.target.copy(base);
    this.av.pos.copy(base);
    this.rebuildSector();
    if (this.view) this.applyView(this.view);
  }

  private rebuildSector() {
    for (const m of this.tileMeshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    // cancel in-flight overlay fetches so a fast pan cannot paint stale tiles
    for (const c of this.overlayAborts) c.abort();
    this.overlayAborts = [];
    for (const m of this.overlayMeshes) {
      m.geometry.dispose();
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    this.overlayMeshes = [];
    this.overlayState = "raw";
    this.tileSource = "flat-engine";
    this.sectorGroup.clear();
    this.tileMeshes = [];
    const center = this.tileOf();
    this.queue = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) this.queue.push({ tx: center.x + dx, ty: center.y + dy });
    }
    this.tilesLoaded = 0;
  }

  /** the tile the sector is anchored on (centre of the 3×3 window) */
  private tileOf() {
    return tileForLngLat(this.frame.centerLng, this.frame.centerLat, 15);
  }

  /**
   * Paint one sector tile as flat map geometry.
   *
   * 1.0.0 renders the world "flat": no streamed raster, no relief shading,
   * no fog. Elevation is communicated by hue instead of by light —
   * sea/lake -> blue ramp, beach -> grey ramp, mountain/land -> green ramp.
   * The ramps come from the palette module (or the active theme when the
   * pilot picks "themed" map colours), so the exact same geometry can be
   * repainted without rebuilding it.
   */
  private buildOneTile(tx: number, ty: number) {
    const size = this.frame.sizeM;
    const geo = new THREE.PlaneGeometry(size, size, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const off = this.frame.tileLocal(tx, ty);
    const ox = off.x + size / 2;
    const oy = off.y + size / 2;
    const palette = this.map;
    for (let i = 0; i < pos.count; i++) {
      const lx = ox + pos.getX(i);
      const ly = oy + pos.getZ(i);
      const ll = this.frame.localToLngLat(lx, ly);
      const s = quickSample(ll.lng, ll.lat, this.seed);
      // the surface is flat; the analytic relief is kept only for hero/impact maths
      pos.setY(i, 0);
      const rgb = paintFlatColor(palette, {
        h: s.h,
        wet: s.wet,
        forest: s.forest,
        urban: s.urban,
        river: s.river,
        biome: s.biome,
        classified: s.biome,
      });
      colors[i * 3] = rgb.r / 255;
      colors[i * 3 + 1] = rgb.g / 255;
      colors[i * 3 + 2] = rgb.b / 255;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    // Unlit on purpose: flat cartography must not be shaded by the sun.
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(off.x + size / 2, 0, off.y + size / 2);
    mesh.userData = { tile: { tx, ty }, palette: palette.mode };
    this.sectorGroup.add(mesh);
    this.tileMeshes.push(mesh);

    // the flat base is always drawn; the streamed raster stacks on top of it
    this.buildTileOverlay(tx, ty);
  }

  /**
   * STREAMED RASTER OVERLAY (stacked on the flat map)
   * ----------------------------------------------------------------
   * The flat base stays authoritative for `x-simplayz-overlay` reporting and for
   * the click-to-place raycasts. The raster arrives from the internal streamer
   * (`/api/tiles/{z}/{x}/{y}`) as a transparent-on-dark plane stacked just above
   * the cartography, so the pilot sees real ground truth *through* the engine's
   * colour language rather than instead of it.
   *
   * `fetch()` is used instead of an <img> so the response headers are readable:
   * the streamer reports provenance (`cache` / `origin` / `stale` / `generated`)
   * and whether the tile carries player-authored parcels. Both end up in the HUD.
   */
  private buildTileOverlay(tx: number, ty: number) {
    if (this.mapLayers === "flat") return;
    const size = this.frame.sizeM;
    const off = this.frame.tileLocal(tx, ty);
    const key = `15/${tx}/${ty}`;

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // the raster is a semi-transparent drape; polygons already sit above it
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    plane.position.set(off.x + size / 2, 2.5, off.y + size / 2);
    plane.userData = { tile: { tx, ty }, kind: "overlay" };
    plane.visible = false;
    this.sectorGroup.add(plane);
    this.overlayMeshes.push(plane);

    const controller = new AbortController();
    this.overlayAborts.push(controller);
    const sectorAtRequest = this.sectorKey;
    void this.loadTileTexture(key, controller.signal)
      .then((res) => {
        if (this.disposed || !res) return;
        // a fast pan can finish a fetch after its sector was torn down; the
        // plane is already detached, so painting it would leak GPU memory
        if (sectorAtRequest !== this.sectorKey || !plane.parent) {
          (res.image as unknown as { close?: () => void }).close?.();
          return;
        }
        const tex = new THREE.Texture(res.image);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        const mat = plane.material as THREE.MeshBasicMaterial;
        mat.map = tex;
        mat.opacity = this.overlayOpacity();
        mat.needsUpdate = true;
        plane.visible = this.overlayOpacity() > 0;
        plane.userData.tex = tex;
        plane.userData.source = res.source;
        this.tileSource = "streamer";
        this.overlayState = res.overlay;
        this.tilesLoaded += 1;
        this.emitTelemetry();
      })
      .catch(() => {
        /* offline or aborted: the flat base is already on screen */
      });
  }

  /** fetch a tile through the internal streamer and decode it for three.js */
  private async loadTileTexture(key: string, signal: AbortSignal) {
    const res = await fetch(`/api/tiles/${key}`, { signal, headers: { accept: "image/png" } });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return null;
    return {
      image: bitmap as unknown as HTMLImageElement,
      source: res.headers.get("x-simplayz-tile-source") ?? "streamer",
      overlay: res.headers.get("x-simplayz-overlay") ?? "raw",
    };
  }

  /** effective opacity for the stacked raster under the current mode */
  private overlayOpacity() {
    if (this.mapLayers === "flat") return 0;
    if (this.mapLayers === "raster") return 1;
    return this.tileOpacity;
  }

  /** apply a layer/opacity change without rebuilding geometry */
  private applyLayers() {
    const op = this.overlayOpacity();
    for (const plane of this.overlayMeshes) {
      const mat = plane.material as THREE.MeshBasicMaterial;
      mat.opacity = op;
      mat.needsUpdate = true;
      plane.visible = op > 0 && !!mat.map;
    }
    // Switching flat -> stacked/raster after the pilot panned in flat mode
    // leaves tiles that never got an overlay plane. Compare per tile rather
    // than "are there any overlays at all", or the un-overlaid ones stay blank.
    if (op > 0) {
      const have = new Set(
        this.overlayMeshes.map((m) => {
          const t = m.userData.tile as { tx: number; ty: number } | undefined;
          return t ? `${t.tx}/${t.ty}` : "";
        }),
      );
      for (const m of this.tileMeshes) {
        const tile = m.userData.tile as { tx: number; ty: number } | undefined;
        if (tile && !have.has(`${tile.tx}/${tile.ty}`)) this.buildTileOverlay(tile.tx, tile.ty);
      }
    }
    this.emitTelemetry();
  }

  private emitTelemetry() {
    if (this.disposed) return;
    const info = this.renderer.info;
    this.cb.onTelemetry({
      fps: this.fps,
      draws: info.render.calls,
      tris: info.render.triangles,
      tiles: `${this.tilesLoaded}/9`,
      alt: Math.round(this.camera.position.y),
      speed: Math.round(this.av.speed),
      layers: this.mapLayers,
      tileSource: this.tileSource,
      overlay: this.overlayState,
      tileOpacity: Math.round(this.overlayOpacity() * 100),
    });
  }

  /**
   * Repaint every streamed tile in place when the palette changes.
   * Cheaper than a rebuild: geometry stays, only the colour attribute and
   * the material flag are rewritten.
   */
  private repaintSector(palette: MapPalette) {
    for (const m of this.tileMeshes) {
      const geo = m.geometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const attr = geo.attributes.color as THREE.BufferAttribute;
      if (!attr) continue;
      const tile = m.userData.tile as { tx: number; ty: number } | undefined;
      if (!tile) continue;
      const off = this.frame.tileLocal(tile.tx, tile.ty);
      const size = this.frame.sizeM;
      const ox = off.x + size / 2;
      const oy = off.y + size / 2;
      for (let i = 0; i < pos.count; i++) {
        const ll = this.frame.localToLngLat(ox + pos.getX(i), oy + pos.getZ(i));
        const s = quickSample(ll.lng, ll.lat, this.seed);
        const rgb = paintFlatColor(palette, {
          h: s.h,
          wet: s.wet,
          forest: s.forest,
          urban: s.urban,
          river: s.river,
          biome: s.biome,
          classified: s.biome,
        });
        attr.setXYZ(i, rgb.r / 255, rgb.g / 255, rgb.b / 255);
      }
      attr.needsUpdate = true;
      m.userData.palette = palette.mode;
    }
  }

  /**
   * Ground height for anything that must sit on the surface. The 1.0.0
   * world is rendered flat, so this is always 0 — the analytic relief is
   * still available via the terrain module for gameplay maths (the survey
   * runs on real elevation even though the map does not show it).
   */
  private localGround(lx: number, lz: number) {
    void lx;
    void lz;
    return 0;
  }

  /* ------------------------------ claims ------------------------------ */

  private applyView(view: EngineView) {
    const first = !this.view;
    const palette = view.mapStyle === "themed" ? view.theme.map : CARTO_PALETTE;
    const sectorKey = [view.config.terrainSeed].join("|");
    const paletteKey = [palette.mode, palette.water[0], palette.water[1], palette.sand[0], palette.sand[1], palette.land[0], palette.land[1]].join("~");
    const claimsKey = [
      view.config.terrainSeed,
      view.config.claimSizeM,
      view.config.gridCells,
      view.config.reliefScale,
      view.claims.map((c) => `${c.id}:${c.buildings.length}:${c.status}:${c.ownerId ?? "n"}`).join(","),
    ].join("|");
    this.view = view;
    this.seed = view.config.terrainSeed;

    const layersChanged = view.mapLayers !== this.mapLayers || view.tileOpacity !== this.tileOpacity;
    this.mapLayers = view.mapLayers;
    this.tileOpacity = view.tileOpacity;
    if (layersChanged && !first) this.applyLayers();

    if (sectorKey !== this.sectorKey || first) {
      this.sectorKey = sectorKey;
      this.map = palette;
      this.paletteKey = paletteKey;
      this.rebuildSector();
    } else if (paletteKey !== this.paletteKey) {
      // same terrain, new colours — repaint instead of re-streaming
      this.paletteKey = paletteKey;
      this.map = palette;
      this.repaintSector(palette);
    }
    if (claimsKey === this.viewKey && !first) {
      this.touchOverlay(view);
      return;
    }
    this.viewKey = claimsKey;
    this.claimGroup.clear();
    this.pickables = [];
    this.ghost?.parent?.remove(this.ghost);
    this.ghost = null;

    for (const claim of view.claims) this.buildClaim(claim, view);
    this.buildGhost(view);
    this.avatarGroup.clear();
    if (view.mode === "tps" || view.mode === "fps") this.buildAvatar(view);
    this.touchOverlay(view);
  }

  /** cheap per-frame-ish state that does not need geometry rebuilds */
  private touchOverlay(view: EngineView) {
    for (const obj of this.claimGroup.children) {
      if (obj.userData.kind !== "fill" || !obj.userData.claimId) continue;
      const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = obj.userData.claimId === view.activeClaimId ? 0.16 : 0.07;
    }
    if (view.selectedKind && view.tool === "build" && !this.ghost) this.buildGhost(view);
    if (!view.selectedKind || view.tool !== "build") {
      this.ghost?.parent?.remove(this.ghost);
      this.ghost = null;
    }
    const showAv = view.mode === "fps" || view.mode === "tps";
    this.avatarGroup.visible = showAv;
    if (showAv && this.avatarGroup.children.length === 0) this.buildAvatar(view);
    if (!showAv) this.avatarGroup.clear();
  }

  private claimRect(claim: ClaimDTO) {
    const c = this.frame.lngLatToLocal(claim.centerLng, claim.centerLat);
    const half = claim.sizeM / 2;
    return { cx: c.x, cz: c.y, half };
  }

  private terrainRibbon(points: THREE.Vector3[], size: number, lift: number) {
    // resample the polygon so the outline hugs the generated relief
    const pts: THREE.Vector3[] = [];
    const perim = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let e = 0; e < 4; e++) {
      const a = perim[e];
      const b = perim[(e + 1) % 4];
      for (let i = 0; i < 8; i++) {
        const t = i / 8;
        const lx = points[0].x + ((a[0] + (b[0] - a[0]) * t) * size) / 2;
        const lz = points[0].z + ((a[1] + (b[1] - a[1]) * t) * size) / 2;
        pts.push(new THREE.Vector3(lx, this.localGround(lx, lz) + lift, lz));
      }
    }
    return pts;
  }

  private buildClaim(claim: ClaimDTO, view: EngineView) {
    const survey = claimSurvey(claim, view.config);
    const rect = this.claimRect(claim);
    const mine = claim.ownerId === view.pilotId;
    const ownerColor = mine ? "#7df0c0" : claim.owner?.color ?? "#ffb454";
    const locked = claim.lockedUntil ? new Date(claim.lockedUntil).getTime() > Date.now() : false;
    const size = claim.sizeM;

    // --- parcel fill, draped on the relief ---
    const fillGeo = new THREE.PlaneGeometry(size, size, 12, 12);
    fillGeo.rotateX(-Math.PI / 2);
    const fp = fillGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < fp.count; i++) {
      const lx = rect.cx + fp.getX(i);
      const lz = rect.cz + fp.getZ(i);
      fp.setY(i, this.localGround(lx, lz) + 0.9 - this.localGround(rect.cx, rect.cz));
    }
    fillGeo.computeVertexNormals();
    const fillMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(locked ? ownerColor : "#ffb454"),
      transparent: true,
      opacity: mine ? 0.13 : 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.position.set(rect.cx, this.localGround(rect.cx, rect.cz), rect.cz);
    fill.userData = { claimId: claim.id, kind: "fill" };
    this.claimGroup.add(fill);
    this.pickables.push(fill);

    // --- boundary line ---
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        this.terrainRibbon([new THREE.Vector3(rect.cx, 0, rect.cz)], size, 2.2),
      ),
      new THREE.LineBasicMaterial({ color: new THREE.Color(ownerColor), transparent: true, opacity: 0.95 }),
    );
    this.claimGroup.add(border);

    // --- lock dome ---
    if (locked) {
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(size * 0.52, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(ownerColor), transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      dome.position.set(rect.cx, this.localGround(rect.cx, rect.cz), rect.cz);
      this.claimGroup.add(dome);
    }

    // --- label ---
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(`${claim.name}${locked ? " ⏳" : " ⚔"}`, ownerColor), transparent: true, depthTest: false }));
    sprite.scale.set(240, 60, 1);
    sprite.position.set(rect.cx, this.localGround(rect.cx, rect.cz - size / 2) + size * 0.52, rect.cz);
    this.claimGroup.add(sprite);

    // --- structures ---
    const cells = view.config.gridCells;
    const cell = size / cells;
    for (const b of claim.buildings) {
      const kind = KIND_MAP[b.kind];
      if (!kind) continue;
      const [w, d] = footprintFor(kind, b.rot);
      const wm = Math.max(cell * 0.6, w * cell);
      const dm = Math.max(cell * 0.6, d * cell);
      const gx = rect.cx - size / 2 + (b.cellX + w / 2) * cell;
      const gz = rect.cz - size / 2 + (b.cellY + d / 2) * cell;
      const ground = this.localGround(gx, gz);
      const h = Math.max(0.12, effectiveHeight(kind, b.level));
      const flat = kind.roof === "none";
      const style = kind.category === "habitat" || kind.category === "civic" ? "tower" : kind.category === "commerce" ? "shop" : "shed";
      const tex = flatTexture(kind.color, kind.key === "road" || kind.key === "junction" ? "road" : kind.category === "food" ? "field" : kind.key === "park" ? "park" : "panel");
      const repeat = new THREE.Vector2(Math.max(1, Math.round(wm / 14)), Math.max(1, Math.round(dm / 14)));
      tex.repeat.copy(repeat);

      const mesh = new THREE.Mesh(
        flat ? new THREE.PlaneGeometry(wm, dm).rotateX(-Math.PI / 2) : new THREE.BoxGeometry(wm, h, dm),
        flat
          ? new THREE.MeshLambertMaterial({ map: tex, color: 0xffffff })
          : new THREE.MeshLambertMaterial({ map: tex, color: 0xdedede, emissiveMap: kind.category === "habitat" || kind.category === "commerce" || kind.category === "civic" ? facadeTexture(kind.color, style) : null, emissiveIntensity: 0.1 }),
      );
      mesh.position.set(gx, flat ? ground + 0.2 : ground + h / 2, gz);
      mesh.castShadow = !flat;
      mesh.receiveShadow = true;
      mesh.userData = { buildingId: b.id, claimId: claim.id, kind: b.kind, level: b.level };
      this.claimGroup.add(mesh);
      if (!flat) this.pickables.push(mesh);

      if (kind.roof === "pitch") {
        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(Math.max(wm, dm) * 0.72, Math.max(2.4, h * 0.24), 4),
          new THREE.MeshLambertMaterial({ color: new THREE.Color("#8a4a36") }),
        );
        roof.rotation.y = Math.PI / 4;
        roof.scale.set(1, 1, dm / Math.max(wm, dm));
        roof.position.set(gx, ground + h + Math.max(2.4, h * 0.24) / 2 - 0.1, gz);
        roof.castShadow = true;
        this.claimGroup.add(roof);
      } else if (kind.roof === "dome") {
        const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.min(wm, dm) * 0.42, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhongMaterial({ color: 0xcfe6ef, shininess: 60, transparent: true, opacity: 0.85 }));
        dome.position.set(gx, ground + h, gz);
        this.claimGroup.add(dome);
      } else if (kind.roof === "panels") {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(wm * 0.8, 0.35, dm * 0.8), new THREE.MeshPhongMaterial({ color: 0x2a4a72, shininess: 100 }));
        panel.position.set(gx, ground + h + 0.3, gz);
        panel.rotation.x = -0.22;
        this.claimGroup.add(panel);
      }

      if (kind.key === "beacon") {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 6, 320, 10, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(ownerColor), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
        beam.position.set(gx, ground + h + 160, gz);
        this.claimGroup.add(beam);
      }
    }

    // --- forest / rock scatter on surveyed cells ---
    const treeSpots: { x: number; z: number; y: number; s: number; rock: boolean }[] = [];
    for (let i = 0; i < survey.grid.length && treeSpots.length < 260; i++) {
      const c = survey.grid[i];
      const cx = i % cells;
      const cy = Math.floor(i / cells);
      if (c.b !== 6 && c.b !== 7 && c.b !== 9 && c.b !== 10) continue;
      if (hashSeed(cx * 3.7, cy * 9.1, this.seed) > 0.28) continue;
      const jx = (hashSeed(cx, cy, this.seed + 3) - 0.5) * cell * 0.7;
      const jy = (hashSeed(cx, cy, this.seed + 7) - 0.5) * cell * 0.7;
      const lx = rect.cx - size / 2 + (cx + 0.5) * cell + jx;
      const lz = rect.cz - size / 2 + (cy + 0.5) * cell + jy;
      treeSpots.push({ x: lx, z: lz, y: this.localGround(lx, lz), s: 0.7 + hashSeed(cx, cy, this.seed + 11) * 1.1, rock: c.b === 9 || c.b === 10 });
    }
    if (treeSpots.length) {
      const rockCount = treeSpots.filter((t) => t.rock).length;
      const treeCount = treeSpots.length - rockCount;
      const canopy = new THREE.InstancedMesh(new THREE.ConeGeometry(6, 16, 7), new THREE.MeshLambertMaterial({ color: 0x2f5b3c }), Math.max(1, treeCount));
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 1.2, 6, 5), new THREE.MeshLambertMaterial({ color: 0x4a3626 }), Math.max(1, treeCount));
      const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(4, 0), new THREE.MeshLambertMaterial({ color: 0x77716a, flatShading: true }), Math.max(1, rockCount));
      const m = new THREE.Matrix4();
      let ti = 0;
      let ri = 0;
      for (const s of treeSpots) {
        if (s.rock) {
          m.makeScale(s.s * 1.1, s.s * 0.8, s.s);
          m.setPosition(s.x, s.y + 2, s.z);
          rocks.setMatrixAt(ri++, m);
        } else {
          m.makeScale(s.s, s.s * (0.8 + hashSeed(s.x, s.z, this.seed) * 0.8), s.s);
          m.setPosition(s.x, s.y + 14 * s.s, s.z);
          canopy.setMatrixAt(ti, m);
          m.makeScale(s.s, s.s, s.s);
          m.setPosition(s.x, s.y + 3 * s.s, s.z);
          trunk.setMatrixAt(ti, m);
          ti++;
        }
      }
      canopy.castShadow = trunk.castShadow = rocks.castShadow = true;
      this.claimGroup.add(canopy, trunk, rocks);
    }
  }

  private buildGhost(view: EngineView) {
    if (!view.selectedKind || view.tool !== "build") return;
    const kind = KIND_MAP[view.selectedKind];
    const claim = view.claims.find((c) => c.id === view.activeClaimId);
    if (!kind || !claim) return;
    const cell = claim.sizeM / view.config.gridCells;
    const [w, d] = footprintFor(kind, view.rotation);
    const h = Math.max(1.6, effectiveHeight(kind, 1));
    const geo = kind.roof === "none" ? new THREE.PlaneGeometry(w * cell, d * cell).rotateX(-Math.PI / 2) : new THREE.BoxGeometry(w * cell, h, d * cell);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x7df0c0, transparent: true, opacity: 0.4, depthWrite: false }));
    mesh.userData = { ghost: true };
    this.claimGroup.add(mesh);
    this.ghost = mesh;
  }

  private buildAvatar(view: EngineView) {
    const color = new THREE.Color(view.pilotId ? "#7df0c0" : "#68b7ff");
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.1, 6, 12), new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.95;
    body.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.16, 0.2), new THREE.MeshBasicMaterial({ color: 0x0a1a22 }));
    visor.position.set(0, 1.62, -0.36);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.24), new THREE.MeshLambertMaterial({ color: 0x2c3b44 }));
    pack.position.set(0, 1.1, 0.36);
    const light = new THREE.PointLight(0xfff0cf, 8, 42, 2);
    light.position.set(0, 1.8, -0.6);
    const group = new THREE.Group();
    group.add(body, visor, pack, light);
    group.userData = { avatar: true };
    this.avatarGroup.add(group);
    this.avatarGroup.position.copy(this.av.pos);
  }

  /* ------------------------------ input ------------------------------ */

  private onContext = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    const el = this.renderer.domElement;
    el.setPointerCapture?.(e.pointerId);
    this.down = { x: e.clientX, y: e.clientY, t: Date.now(), button: e.button, moved: false };
    const tour = this.mode === "fps" || this.mode === "tps";
    this.drag = tour ? "none" : e.button === 2 || e.shiftKey ? "orbit" : "pan";
    if (tour && !document.pointerLockElement) void el.requestPointerLock?.();
  };

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerPx.set(e.clientX - rect.left, e.clientY - rect.top);
    const dx = e.clientX - this.down.x;
    const dy = e.clientY - this.down.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) this.down.moved = true;

    if (document.pointerLockElement === this.renderer.domElement) {
      this.av.yaw -= e.movementX * 0.0026;
      this.av.pitch = THREE.MathUtils.clamp(this.av.pitch - e.movementY * 0.0022, -1.15, 1.0);
      return;
    }

    if (this.drag === "orbit") {
      this.camRig.yaw -= (e.movementX || 0) * 0.006;
      this.camRig.pitch = THREE.MathUtils.clamp(this.camRig.pitch + (e.movementY || 0) * 0.005, 0.12, 1.45);
      return;
    }
    if (this.drag === "pan" && this.down.moved) {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0).setY(0).normalize();
      const fwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right).normalize();
      const k = this.camRig.dist * 0.0016 * (this.mode === "fps" || this.mode === "tps" ? 0.15 : 1);
      this.camRig.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
      this.clampTarget();
      this.down.x = e.clientX;
      this.down.y = e.clientY;
      return;
    }
    this.probe();
  };

  private onPointerUp = (e: PointerEvent) => {
    this.drag = "none";
    if (this.down.moved || Date.now() - this.down.t > 600) return;
    const view = this.view;
    if (!view) return;
    if (e.button !== 0) return;
    if (view.mode === "fps" || view.mode === "tps") return;
    const hit = this.pickables.length ? this.ray.intersectObjects(this.pickables, false) : [];
    if (view.tool === "demolish" && hit.length) {
      const u = hit[0].object.userData as { buildingId?: string; claimId?: string };
      if (u.buildingId && u.claimId) {
        this.cb.onPickBuilding(u.claimId, u.buildingId);
        return;
      }
    }
    if (view.selectedKind && view.tool === "build" && view.activeClaimId) {
      const cell = this.cellAtPointer();
      if (cell) {
        this.cb.onPlace(cell.x, cell.y);
        return;
      }
    }
    if (hit.length) {
      const u = hit[0].object.userData as { claimId?: string };
      if (u.claimId) {
        this.cb.onPickClaim(u.claimId);
        return;
      }
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.mode === "fps" || this.mode === "tps") return;
    this.camRig.dist = THREE.MathUtils.clamp(this.camRig.dist * (1 + Math.sign(e.deltaY) * 0.11), this.mode === "build" ? 120 : 90, 2600);
  };

  private onLockChange = () => {
    if (!document.pointerLockElement && (this.mode === "fps" || this.mode === "tps")) this.cb.onLeaveTour();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    this.keys.add(e.code);
    if (e.code === "KeyR") this.view && useWorld.getState().rotate();
    if (e.code === "Escape" && document.pointerLockElement) document.exitPointerLock();
  };

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private clampTarget() {
    const lim = (this.frame.sizeM * TILES_WIDE) / 2 - 120;
    this.camRig.target.x = THREE.MathUtils.clamp(this.camRig.target.x, -lim, lim);
    this.camRig.target.z = THREE.MathUtils.clamp(this.camRig.target.z, -lim, lim);
  }

  private cellAtPointer(): { x: number; y: number } | null {
    const view = this.view;
    if (!view?.activeClaimId) return null;
    const claim = view.claims.find((c) => c.id === view.activeClaimId);
    if (!claim) return null;
    const p = this.groundPoint();
    if (!p) return null;
    const rect = this.claimRect(claim);
    const cell = claim.sizeM / view.config.gridCells;
    const cx = Math.floor((p.x - (rect.cx - rect.half)) / cell);
    const cy = Math.floor((p.z - (rect.cz - rect.half)) / cell);
    if (cx < 0 || cy < 0 || cx >= view.config.gridCells || cy >= view.config.gridCells) return null;
    return { x: cx, y: cy };
  }

  private groundPoint(): THREE.Vector3 | null {
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObjects(this.tileMeshes, false);
    return hits.length ? hits[0].point.clone() : null;
  }

  private lastHoverEmit = 0;

  private probe() {
    const view = this.view;
    if (!view) return;
    const p = this.groundPoint();
    if (!p) {
      if (this.lastHoverEmit !== -1) {
        this.cb.onHover(null);
        this.lastHoverEmit = -1;
      }
      return;
    }
    const ll = this.frame.localToLngLat(p.x, p.z);
    const s = sampleTerrain(ll.lng, ll.lat, this.seed);
    const b = BIOMES[s.biome] ?? BIOMES[4];
    const tile = tileForLngLat(ll.lng, ll.lat, 15);
    const cell = this.cellAtPointer();
    let buildingId: string | null = null;
    let claimId: string | null = null;
    if (view.tool !== "build" && this.pickables.length) {
      const hit = this.ray.intersectObjects(this.pickables, false);
      if (hit.length) {
        const u = hit[0].object.userData as { claimId?: string; buildingId?: string };
        claimId = u.claimId ?? null;
        buildingId = u.buildingId ?? null;
      }
    }
    const now = performance.now();
    if (now - this.lastHoverEmit > 90) {
      this.lastHoverEmit = now;
      this.cb.onHover({
        lng: ll.lng,
        lat: ll.lat,
        elev: Math.round(s.h * 10) / 10,
        slope: Math.round(s.slopeDeg * 10) / 10,
        biome: b.name,
        biomeColor: b.color,
        cell: cell ? { x: cell.x, y: cell.y } : null,
        claimId,
        buildingId,
        tile,
        source: this.tileSource,
      });
    }

    // ghost placement feedback
    if (this.ghost && cell) {
      const claim = view.claims.find((c) => c.id === view.activeClaimId);
      if (claim) {
        const size = claim.sizeM;
        const c = size / view.config.gridCells;
        const kind = KIND_MAP[view.selectedKind ?? ""];
        if (kind) {
          const [w, d] = footprintFor(kind, view.rotation);
          const gx = this.claimRect(claim).cx - size / 2 + (cell.x + w / 2) * c;
          const gz = this.claimRect(claim).cz - size / 2 + (cell.y + d / 2) * c;
          const survey = claimSurvey(claim, view.config);
          let ok = true;
          for (let j = 0; j < d && ok; j++) {
            for (let i = 0; i < w && ok; i++) {
              const gc = survey.grid[(cell.y + j) * view.config.gridCells + cell.x + i];
              if (!gc || gc.ok === 0) ok = false;
              const occupied = claim.buildings.some((bn) => {
                const bk = KIND_MAP[bn.kind];
                if (!bk) return false;
                const [bw, bd] = footprintFor(bk, bn.rot);
                return cell.x + i >= bn.cellX && cell.x + i < bn.cellX + bw && cell.y + j >= bn.cellY && cell.y + j < bn.cellY + bd;
              });
              if (occupied) ok = false;
            }
          }
          const mat = this.ghost.material as THREE.MeshBasicMaterial;
          mat.color.set(ok ? 0x7df0c0 : 0xff6b6b);
          const h = Math.max(1.6, effectiveHeight(kind, 1));
          this.ghost.position.set(gx, this.localGround(gx, gz) + (kind.roof === "none" ? 0.5 : h / 2), gz);
          this.ghost.visible = true;
        }
      }
    } else if (this.ghost) this.ghost.visible = false;
  }

  private get mode(): Mode {
    return this.view?.mode ?? "bird";
  }

  /* ------------------------------ loop ------------------------------ */

  private resize() {
    const w = this.host.clientWidth || 1280;
    const h = this.host.clientHeight || 720;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tick = () => {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;

    if (this.queue.length) {
      const q = this.queue.shift();
      if (q) this.buildOneTile(q.tx, q.ty);
    }

    this.updateCamera(dt, t);
    this.updateAtmosphere(t);
    this.frames++;
    this.fpsClock += dt;
    if (this.fpsClock > 0.5) {
      this.fps = Math.round(this.frames / this.fpsClock);
      this.frames = 0;
      this.fpsClock = 0;
      this.emitTelemetry();
    }
    this.renderer.render(this.scene, this.camera);
  };

  private updateCamera(dt: number, time: number) {
    const tour = this.mode === "fps" || this.mode === "tps";
    if (tour) {
      if (this.ghost) this.ghost.visible = false;
      const locked = document.pointerLockElement === this.renderer.domElement;
      const k = this.keys;
      const speed = (k.has("ShiftLeft") || k.has("ShiftRight") ? 9.4 : 4.4) * (this.mode === "tps" ? 1.35 : 1);
      const dir = new THREE.Vector3(
        (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0),
        0,
        (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0) - (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0),
      );
      const ll = this.frame.localToLngLat(this.av.pos.x, this.av.pos.z);
      const s = sampleTerrain(ll.lng, ll.lat, this.seed);
      const walkable = BIOMES[s.biome]?.walk ?? 1;
      if (dir.lengthSq() > 0) dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.av.yaw);
      this.av.vel.lerp(dir.multiplyScalar(speed * (0.25 + walkable * 0.75)), Math.min(1, dt * 9));
      this.av.pos.addScaledVector(this.av.vel, dt);
      this.av.speed = this.av.vel.length();
      const lim = (this.frame.sizeM * TILES_WIDE) / 2 - 40;
      this.av.pos.x = THREE.MathUtils.clamp(this.av.pos.x, -lim, lim);
      this.av.pos.z = THREE.MathUtils.clamp(this.av.pos.z, -lim, lim);
      const ground = this.localGround(this.av.pos.x, this.av.pos.z);
      if (k.has("Space") && this.av.grounded) {
        this.av.vy = 6.2;
        this.av.grounded = false;
      }
      this.av.vy -= 18 * dt;
      this.av.pos.y += this.av.vy * dt;
      if (this.av.pos.y <= ground) {
        this.av.pos.y = ground;
        this.av.vy = 0;
        this.av.grounded = true;
      }
      this.av.bob += this.av.speed * dt * 2.6;

      if (locked && dir.lengthSq() === 0) this.av.vel.multiplyScalar(0.86);

      if (this.mode === "fps") {
        this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, 78, 0.08);
        this.camera.updateProjectionMatrix();
        const eye = this.av.pos.y + 1.68 + Math.sin(this.av.bob * 6) * 0.045 * Math.min(1, this.av.speed);
        this.camera.position.set(this.av.pos.x, eye, this.av.pos.z);
        const look = new THREE.Vector3(this.av.pos.x - Math.sin(this.av.yaw) * 10, eye + Math.sin(this.av.pitch) * 10, this.av.pos.z - Math.cos(this.av.yaw) * 10);
        this.camera.lookAt(look);
        this.avatarGroup.visible = false;
      } else {
        this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, 55, 0.08);
        this.camera.updateProjectionMatrix();
        const dist = 9.5;
        const desired = new THREE.Vector3(
          this.av.pos.x + Math.sin(this.av.yaw) * dist * Math.cos(this.av.pitch),
          this.av.pos.y + 3.4 + dist * Math.sin(this.av.pitch) + 1.2,
          this.av.pos.z + Math.cos(this.av.yaw) * dist * Math.cos(this.av.pitch),
        );
        const g = this.localGround(desired.x, desired.z) + 1.6;
        desired.y = Math.max(g, desired.y);
        this.camera.position.lerp(desired, 1 - Math.pow(0.0016, dt));
        this.camera.lookAt(this.av.pos.x, this.av.pos.y + 1.5, this.av.pos.z);
        this.avatarGroup.visible = true;
        this.avatarGroup.position.set(this.av.pos.x, this.av.pos.y, this.av.pos.z);
        this.avatarGroup.rotation.y = this.av.yaw + Math.PI;
      }
      void time;
      return;
    }

    this.avatarGroup.visible = false;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.mode === "build" ? 46 : 52, 0.07);
    this.camera.updateProjectionMatrix();
    const nudge = this.keys.has("KeyQ") ? 1 : this.keys.has("KeyE") ? -1 : 0;
    if (nudge) this.camRig.yaw += nudge * dt * 0.7;
    const h = Math.cos(this.camRig.pitch) * this.camRig.dist;
    const desired = new THREE.Vector3(
      this.camRig.target.x + Math.sin(this.camRig.yaw) * h,
      this.camRig.target.y + Math.sin(this.camRig.pitch) * this.camRig.dist,
      this.camRig.target.z + Math.cos(this.camRig.yaw) * h,
    );
    const min = this.localGround(desired.x, desired.z) + 12;
    desired.y = Math.max(min, desired.y);
    this.camera.position.lerp(desired, 0.16);
    this.camera.lookAt(this.camRig.target);
  }

  /**
   * 1.0.0 atmosphere: deliberately minimal.
   * No fog, no sun-coloured sky, no water shimmer — a flat map should read
   * like paper, not like dusk. What remains is a soft day/night exposure
   * shift (so the SUN slider still does something), theme-tinted sky bands
   * and the per-frame HUD animation state.
   */
  private updateAtmosphere(time: number) {
    const view = this.view;
    const tod = view?.timeOfDay ?? 17.5;
    const elev = Math.sin(((tod - 6) / 12) * Math.PI);
    this.nightFactor = THREE.MathUtils.clamp(1 - Math.max(0, elev) * 3.2, 0, 1);

    // keep the light rig consistent for structures (they are lambert-lit)
    const az = ((tod - 12) / 24) * Math.PI * 2;
    const sunDist = 1200;
    this.sun.position.set(Math.cos(az) * sunDist, Math.max(140, elev * sunDist), Math.sin(az) * sunDist);
    this.sun.target.position.set(this.camRig.target.x, 0, this.camRig.target.z);
    this.sun.target.updateMatrixWorld();
    this.sun.intensity = 0.55 + Math.max(0, elev) * 1.15;
    this.sun.color.set("#ffffff");
    this.hemi.intensity = 0.45 + Math.max(0, elev) * 0.35;

    // a flat map is brightest at noon and dims gently after dark
    const exposure = 0.92 + Math.max(0, elev) * 0.16 - this.nightFactor * 0.22;
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(this.renderer.toneMappingExposure, exposure, 0.08);

    // sky = two theme-derived bands, sampled from the active palette so the
    // horizon always belongs to the current map (never a literal blue)
    const palette = this.map;
    const top = new THREE.Color(palette.water[0]).multiplyScalar(this.nightFactor > 0.5 ? 0.42 : 0.72);
    const bottom = new THREE.Color(palette.water[1]).multiplyScalar(this.nightFactor > 0.5 ? 0.3 : 0.55).lerp(new THREE.Color(palette.sand[1]), 0.28);
    const sky = this.sky.material as THREE.ShaderMaterial;
    sky.uniforms.top.value.lerp(top, 0.08);
    sky.uniforms.bottom.value.lerp(bottom, 0.08);
    (this.stars.material as THREE.PointsMaterial).opacity = this.nightFactor * 0.55;
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);

    // flat cartography: no haze, and a clear colour that matches the void token
    if (this.scene.fog) this.scene.fog = null;
    this.renderer.setClearColor(bottom, 1);

    this.gridHelper.position.set(this.camRig.target.x, 1.5, this.camRig.target.z);

    // gameplay overlays keep their animation
    for (const obj of this.claimGroup.children) {
      if (obj.userData.kind !== "fill") continue;
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const active = obj.userData.claimId === this.view?.activeClaimId;
      mat.opacity = (active ? 0.2 : 0.1) + Math.sin(time * 1.6) * 0.025;
      mesh.scale.setScalar(1 + (active ? Math.sin(time * 2) * 0.004 : 0));
    }
    // emissive windows wake up at night
    this.claimGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshLambertMaterial;
      if (m && m.emissiveMap) {
        m.emissive.setRGB(1, 0.88, 0.6);
        m.emissiveIntensity = 0.08 + this.nightFactor * 1.5;
      }
    });
  }

  /* ------------------------------ api ------------------------------ */

  update(view: EngineView) {
    this.applyView(view);
  }

  focus(lng: number, lat: number, dist = 620) {
    this.setCenter(lng, lat);
    this.camRig.dist = dist;
    const t = this.frame.lngLatToLocal(lng, lat);
    const base = new THREE.Vector3(t.x, 0, t.y);
    base.y = this.localGround(t.x, t.y);
    this.camRig.target.copy(base);
    this.av.pos.copy(base);
    this.av.pos.y = base.y;
  }

  currentCenter() {
    const ll = this.frame.localToLngLat(this.camRig.target.x, this.camRig.target.z);
    return ll;
  }

  teleportLocal(lng: number, lat: number) {
    const t = this.frame.lngLatToLocal(lng, lat);
    this.av.pos.set(t.x, this.localGround(t.x, t.y), t.y);
    this.camRig.target.set(t.x, this.localGround(t.x, t.y), t.y);
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    this.renderer.setAnimationLoop(null);
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("wheel", this.onWheel);
    el.removeEventListener("contextmenu", this.onContext);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    this.ro?.disconnect();
    this.renderer.dispose();
    el.remove();
  }
}

/* ------------------------------ react wrapper ------------------------------ */

export interface Telemetry {
  fps: number;
  draws: number;
  tris: number;
  tiles: string;
  alt: number;
  speed: number;
  /** which layer the pilot is looking at */
  layers: MapLayers;
  /** provenance reported by the streamer for the newest tile */
  tileSource: string;
  /** `raw` or `player-authored:<n>parcel/<n>structures` */
  overlay: string;
  /** effective raster opacity, 0-100 */
  tileOpacity: number;
}

export default function WorldViewport({ onTelemetry }: { onTelemetry?: (t: Telemetry) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SimplayzEngine | null>(null);
  const telemetryRef = useRef(onTelemetry);
  telemetryRef.current = onTelemetry;

  const claims = useWorld((s) => s.claims);
  const config = useWorld((s) => s.config);
  const activeClaimId = useWorld((s) => s.activeClaimId);
  const mode = useWorld((s) => s.mode);
  const selectedKind = useWorld((s) => s.selectedKind);
  const rotation = useWorld((s) => s.rotation);
  const tool = useWorld((s) => s.tool);
  const timeOfDay = useWorld((s) => s.timeOfDay);
  const pilotId = useWorld((s) => s.pilotId);
  const center = useWorld((s) => s.center);
  const theme = useTheme((s) => s.theme);
  const mapStyle = useTheme((s) => s.mapStyle);
  const mapLayers = useWorld((s) => s.mapLayers);
  const tileOpacity = useWorld((s) => s.tileOpacity);
  const mounted = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new SimplayzEngine(host, {
      onHover: (h) => useWorld.getState().setHover(h),
      onPlace: (cx, cy) => {
        const s = useWorld.getState();
        if (s.activeClaimId && s.selectedKind) void s.placeBuilding(s.activeClaimId, s.selectedKind, cx, cy, s.rotation);
      },
      onPickBuilding: (claimId, buildingId) => {
        const s = useWorld.getState();
        if (s.tool === "demolish") void s.demolish(claimId, buildingId);
      },
      onPickClaim: (claimId) => useWorld.getState().setActiveClaim(claimId),
      onTelemetry: (t) => telemetryRef.current?.(t),
      onLeaveTour: () => useWorld.getState().setMode("bird"),
    });
    engineRef.current = engine;
    mounted.current = true;
    return () => {
      engine.dispose();
      engineRef.current = null;
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.focus(center.lng, center.lat, 700);
  }, [center.lng, center.lat]);

  useEffect(() => {
    if (!mounted.current) return;
    engineRef.current?.update({ claims, config, activeClaimId, mode, selectedKind, rotation, tool, timeOfDay, pilotId, theme, mapStyle, mapLayers, tileOpacity });
  }, [claims, config, activeClaimId, mode, selectedKind, rotation, tool, timeOfDay, pilotId, theme, mapStyle, mapLayers, tileOpacity]);

  return <div ref={hostRef} className="absolute inset-0 cursor-crosshair" />;
}

/** imperative helpers for the HUD (fly-to / teleport) */
export function engineFocus(lng: number, lat: number, dist?: number) {
  const engine = (window as unknown as { __simplayz?: SimplayzEngine }).__simplayz;
  engine?.focus(lng, lat, dist);
}

export function engineTeleport(lng: number, lat: number) {
  const engine = (window as unknown as { __simplayz?: SimplayzEngine }).__simplayz;
  engine?.teleportLocal(lng, lat);
}
