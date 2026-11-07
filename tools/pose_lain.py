import bpy, sys, math
from mathutils import Matrix, Vector
args=sys.argv[sys.argv.index('--')+1:]; angle=float(args[0]); out=args[1]; glb=args[2] if len(args)>2 else None
sc=bpy.context.scene; a=bpy.data.objects['ps_lain_arm']
def lower(name, ang):
    pb=a.pose.bones[name]; bpy.context.view_layer.update()
    h=a.matrix_world @ pb.head
    R=Matrix.Translation(h) @ Matrix.Rotation(ang,4,'Y') @ Matrix.Translation(-h)
    pb.matrix = a.matrix_world.inverted() @ R @ a.matrix_world @ pb.matrix
    bpy.context.view_layer.update()
def bend(name, ang):  # small elbow bend toward the body front
    pb=a.pose.bones[name]; bpy.context.view_layer.update()
    h=a.matrix_world @ pb.head
    R=Matrix.Translation(h) @ Matrix.Rotation(ang,4,'X') @ Matrix.Translation(-h)
    pb.matrix = a.matrix_world.inverted() @ R @ a.matrix_world @ pb.matrix
    bpy.context.view_layer.update()
t=math.radians(angle)
if angle:
    lower('腕.L', t); lower('腕.R', -t)
    bend('ひじ.L', math.radians(-12)); bend('ひじ.R', math.radians(-12))
# render
cam=bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam)
cam.data.type='ORTHO'; cam.data.ortho_scale=1.8; cam.location=(0,-4,0.82); cam.rotation_euler=(math.pi/2,0,0); sc.camera=cam
sc.render.engine='BLENDER_WORKBENCH'; sc.display.shading.color_type='MATERIAL'
sc.render.resolution_x=500; sc.render.resolution_y=800; sc.render.filepath=out
bpy.ops.render.render(write_still=True)
if glb:
    for o in bpy.data.objects: o.select_set(False)
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', export_image_format='NONE', use_visible=True,
        export_skins=True, export_animations=False, export_morph=False, export_rest_position_armature=False)
