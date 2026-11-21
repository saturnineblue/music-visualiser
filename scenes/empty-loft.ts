// @ts-nocheck
// Made in the Scene Studio. Open it there ("Edit in studio") to change it: the spec below is
// the whole scene, and the shared studio engine (ctx.helpers.studio) plays it.
const spec = {
  "format": "music-visualiser-studio",
  "version": 1,
  "id": "empty-loft",
  "name": "Empty Loft",
  "description": "An empty factory loft rebuilt from a photograph, seen from the photo's own angle: stained ceiling, white columns, bright windows and two walkers blurred in motion.",
  "particleCount": 110000,
  "space": {
    "color": "#060504",
    "glow": 0.5,
    "particles": "glow",
    "change": {
      "mode": "off",
      "source": {
        "kind": "feature",
        "name": "bass"
      },
      "colors": [
        "#020308",
        "#1b2a6b",
        "#6b1b5a"
      ],
      "speed": 6,
      "amount": 1,
      "smooth": 0.4,
      "lightness": 0.12
    }
  },
  "camera": {
    "distance": 20,
    "elevation": -12.37,
    "azimuth": 33.56,
    "fov": 74,
    "autoRotate": 0,
    "autoTilt": 0,
    "target": [
      3,
      2.404,
      2.721
    ]
  },
  "light": {
    "enabled": true,
    "color": "#fff4e2",
    "intensity": 0.3,
    "azimuth": -60,
    "elevation": 20,
    "ambient": 1,
    "fill": "#7fa8c8",
    "fillIntensity": 0.15
  },
  "motion": {
    "spring": 7,
    "damping": 3.5,
    "turbulence": 0.05,
    "burst": 0.4
  },
  "morph": {
    "mode": "manual",
    "every": 16,
    "blend": 2.5,
    "position": 0
  },
  "hueShift": 0,
  "brightness": 1,
  "layers": [
    {
      "id": "room",
      "name": "Loft",
      "visible": true,
      "count": 70000,
      "forms": [
        {
          "kind": "model",
          "shape": "sphere",
          "model": "loft-room",
          "scale": 21,
          "position": [
            0,
            0,
            0
          ],
          "rotation": [
            0,
            0,
            0
          ],
          "color": {
            "mode": "model",
            "a": "#d8c9b0",
            "b": "#ffffff",
            "axis": "height"
          },
          "parts": {
            "beams": {
              "source": {
                "kind": "feature",
                "name": "bass"
              },
              "lift": 0.3
            },
            "ceiling": {
              "source": {
                "kind": "feature",
                "name": "lowMid"
              },
              "glow": 0.6
            }
          }
        }
      ],
      "scale": 1,
      "lift": 0,
      "spin": 0,
      "size": 0.45,
      "brightness": 0.9,
      "explode": 0,
      "spectrum": {
        "axis": "depth",
        "lo": 40,
        "hi": 8000,
        "push": 0.12,
        "glow": 0.25,
        "size": 0,
        "tint": "#ffffff",
        "tintAmount": 0
      }
    },
    {
      "id": "cols",
      "name": "Columns and windows",
      "visible": true,
      "count": 22000,
      "forms": [
        {
          "kind": "model",
          "shape": "sphere",
          "model": "loft-columns",
          "scale": 18.2,
          "position": [
            0,
            -0.55,
            -2.33
          ],
          "rotation": [
            0,
            0,
            0
          ],
          "color": {
            "mode": "model",
            "a": "#d8c9b0",
            "b": "#ffffff",
            "axis": "height"
          },
          "parts": {
            "windows": {
              "source": {
                "kind": "band",
                "lo": 4000,
                "hi": 12000
              },
              "glow": 1.2
            },
            "columns": {
              "source": {
                "kind": "feature",
                "name": "beat"
              },
              "glow": 0.8
            }
          }
        }
      ],
      "scale": 1,
      "lift": 0,
      "spin": 0,
      "size": 0.5,
      "brightness": 1.6,
      "explode": 0,
      "spectrum": {
        "axis": "none",
        "lo": 40,
        "hi": 8000,
        "push": 0,
        "glow": 0,
        "size": 0,
        "tint": "#ffffff",
        "tintAmount": 0
      }
    },
    {
      "id": "near",
      "name": "Walker (near)",
      "visible": true,
      "count": 12000,
      "forms": [
        {
          "kind": "model",
          "shape": "sphere",
          "model": "loft-walker-near",
          "scale": 1.743,
          "position": [
            9.553,
            -2.673,
            11.245
          ],
          "rotation": [
            0,
            0,
            0
          ],
          "color": {
            "mode": "model",
            "a": "#d8c9b0",
            "b": "#ffffff",
            "axis": "height"
          },
          "parts": {}
        }
      ],
      "scale": 1,
      "lift": 0,
      "spin": 0,
      "size": 0.4,
      "brightness": 0.75,
      "explode": 0,
      "spectrum": {
        "axis": "none",
        "lo": 40,
        "hi": 8000,
        "push": 0,
        "glow": 0,
        "size": 0,
        "tint": "#ffffff",
        "tintAmount": 0
      }
    },
    {
      "id": "far",
      "name": "Walker (far)",
      "visible": true,
      "count": 6000,
      "forms": [
        {
          "kind": "model",
          "shape": "sphere",
          "model": "loft-walker-far",
          "scale": 1.713,
          "position": [
            -9.425,
            -2.703,
            3.071
          ],
          "rotation": [
            0,
            0,
            0
          ],
          "color": {
            "mode": "model",
            "a": "#d8c9b0",
            "b": "#ffffff",
            "axis": "height"
          },
          "parts": {}
        }
      ],
      "scale": 1,
      "lift": 0,
      "spin": 0,
      "size": 0.4,
      "brightness": 1.1,
      "explode": 0,
      "spectrum": {
        "axis": "none",
        "lo": 40,
        "hi": 8000,
        "push": 0,
        "glow": 0,
        "size": 0,
        "tint": "#ffffff",
        "tintAmount": 0
      }
    }
  ],
  "mappings": [
    {
      "source": {
        "kind": "feature",
        "name": "mid"
      },
      "target": "layer:near.explode",
      "amount": 0.12,
      "curve": "square",
      "attack": 0.05,
      "release": 0.6,
      "enabled": true
    },
    {
      "source": {
        "kind": "feature",
        "name": "mid"
      },
      "target": "layer:far.explode",
      "amount": 0.12,
      "curve": "square",
      "attack": 0.05,
      "release": 0.6,
      "enabled": true
    },
    {
      "source": {
        "kind": "feature",
        "name": "rms"
      },
      "target": "brightness",
      "amount": 0.25,
      "curve": "linear",
      "attack": 0.05,
      "release": 0.4,
      "enabled": true
    },
    {
      "source": {
        "kind": "feature",
        "name": "high"
      },
      "target": "space.glow",
      "amount": 0.4,
      "curve": "linear",
      "attack": 0,
      "release": 0.5,
      "enabled": true
    }
  ],
  "loops": [],
  "activeLoop": -1
};

const scene = {
  id: "empty-loft",
  name: "Empty Loft",
  description: "An empty factory loft rebuilt from a photograph, seen from the photo's own angle: stained ceiling, white columns, bright windows and two walkers blurred in motion.",
  author: 'studio',
  particleCount: 110000,
  models: ["loft-room","loft-columns","loft-walker-near","loft-walker-far"],
  bloom: 0.5,
  camera: { position: [13.8,-1.88,19], target: [3,2.404,2.721], autoRotate: 0, autoTilt: 0, fov: 74 },
  studio: spec,
  setup(ctx) { ctx.helpers.studio.setup(ctx, spec); },
  update(ctx) { ctx.helpers.studio.update(ctx, spec); },
};

export default scene;
