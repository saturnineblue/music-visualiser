"""
Runs inside headless Blender (blender --background --python server/blender_worker.py).

Reads one JSON command per line from stdin and answers with one line on stdout,
prefixed with MARK so it can be told apart from Blender's own log output:

  {"cmd": "exec", "code": "..."}            run Python (bpy, bmesh, mathutils, math, random preloaded)
  {"cmd": "info"}                           summary of the scene's mesh objects
  {"cmd": "render", "paths": [a, b], "size": 640}   two preview renders (front-left, back-right)
  {"cmd": "export", "glb": path, "blend": path}     export meshes to .glb (+ save a .blend copy)
  {"cmd": "quit"}

Objects whose names start with "_" are helpers: ignored by info and export.
"""
import bpy, bmesh, mathutils, math, random, sys, json, io, traceback, contextlib

MARK = "@@VIS@@"
out = sys.__stdout__


def reply(obj):
    out.write(MARK + json.dumps(obj) + "\n")
    out.flush()


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def meshes():
    bpy.context.view_layer.update()  # make transforms / dimensions current after scripted changes
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.name.startswith("_")]


def tri_count(o):
    return sum(max(0, len(p.vertices) - 2) for p in o.data.polygons)


def info():
    objs = []
    for o in meshes():
        mats = [m.name for m in o.data.materials if m]
        objs.append({
            "name": o.name,
            "dims": [round(x, 3) for x in o.dimensions],
            "location": [round(x, 3) for x in o.location],
            "tris": tri_count(o),
            "materials": mats,
            "modifiers": [m.type for m in o.modifiers],
        })
    return {"objects": objs, "total_tris": sum(x["tris"] for x in objs)}


def world_bbox(objs):
    lo = mathutils.Vector((1e9, 1e9, 1e9))
    hi = mathutils.Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            lo = mathutils.Vector(map(min, lo, w))
            hi = mathutils.Vector(map(max, hi, w))
    return lo, hi


def render(paths, size):
    objs = meshes()
    if not objs:
        raise RuntimeError("Nothing to render: the scene has no mesh objects.")
    scene = bpy.context.scene
    lo, hi = world_bbox(objs)
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.01)

    cam_data = bpy.data.cameras.new("_preview_cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("_preview_cam", cam_data)
    scene.collection.objects.link(cam)
    prev_cam = scene.camera
    scene.camera = cam

    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_shadows = True
    shading.show_cavity = True
    scene.render.resolution_x = size
    scene.render.resolution_y = int(size * 0.75)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    # Material viewport colours follow the Principled base colour, so the preview shows real colours.
    for m in bpy.data.materials:
        if m.use_nodes and m.node_tree:
            b = m.node_tree.nodes.get("Principled BSDF")
            if b:
                m.diffuse_color = b.inputs["Base Color"].default_value[:]

    fov = 2 * math.atan(36 / (2 * cam_data.lens))  # sensor width 36mm
    dist = radius / math.sin(fov / 2 * 0.75) * 1.05
    try:
        for path, az in zip(paths, (-35, 145)):
            a, el = math.radians(az), math.radians(22)
            # azimuth measured from -Y (Blender's front view)
            d = mathutils.Vector((math.sin(a) * math.cos(el), -math.cos(a) * math.cos(el), math.sin(el)))
            cam.location = centre + d * dist
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
            cam_data.clip_end = dist * 4
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
    finally:
        scene.camera = prev_cam
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
    return {"paths": paths, "bbox": [[round(x, 3) for x in lo], [round(x, 3) for x in hi]]}


def export(glb, blend):
    objs = meshes()
    if not objs:
        raise RuntimeError("Nothing to export: the scene has no mesh objects.")
    for o in bpy.context.view_layer.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_apply=True, export_yup=True)
    if blend:
        bpy.ops.wm.save_as_mainfile(filepath=blend, copy=True)
    return {"glb": glb, "objects": [o.name for o in objs]}


namespace = {"bpy": bpy, "bmesh": bmesh, "mathutils": mathutils, "math": math, "random": random}

reset()
reply({"ok": True, "ready": True, "version": bpy.app.version_string})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        cmd = json.loads(line)
        kind = cmd.get("cmd")
        if kind == "quit":
            reply({"ok": True})
            break
        if kind == "exec":
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf):
                    exec(compile(cmd["code"], "<claude>", "exec"), namespace)
                reply({"ok": True, "output": buf.getvalue()})
            except Exception as e:
                # Skip the worker's own frame so the traceback starts in Claude's code.
                tb = e.__traceback__.tb_next if e.__traceback__ else None
                err = "".join(traceback.format_exception(type(e), e, tb, limit=6))
                reply({"ok": False, "output": buf.getvalue(), "error": err})
        elif kind == "info":
            reply({"ok": True, **info()})
        elif kind == "render":
            reply({"ok": True, **render(cmd["paths"], int(cmd.get("size", 640)))})
        elif kind == "export":
            reply({"ok": True, **export(cmd["glb"], cmd.get("blend"))})
        else:
            reply({"ok": False, "error": f"unknown command {kind!r}"})
    except Exception:
        reply({"ok": False, "error": traceback.format_exc(limit=6)})
