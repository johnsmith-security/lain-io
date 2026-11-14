#!/usr/bin/env python3
"""Add a lightweight, static clown costume to the supplied Lain GLB."""
import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/models/lain.glb'
DEST = ROOT / 'assets/models/lain-clown.glb'


def read_glb(path):
    raw = path.read_bytes()
    offset = 12
    document = None
    binary = b''
    while offset < len(raw):
        length, kind = struct.unpack_from('<II', raw, offset)
        offset += 8
        chunk = raw[offset:offset + length]
        offset += length
        if kind == 0x4E4F534A:
            document = json.loads(chunk.decode('utf-8').rstrip(' \0'))
        elif kind == 0x004E4942:
            binary = chunk
    if document is None:
        raise ValueError('GLB has no JSON document')
    return document, binary


def align4(data):
    return data + bytes((-len(data)) % 4)


doc, binary = read_glb(SOURCE)
binary = bytearray(binary)
doc.setdefault('materials', [])
doc.setdefault('bufferViews', [])
doc.setdefault('accessors', [])
doc['meshes'][0]['primitives']

palette = [
    ('Clown ruffle • strawberry', [0.91, 0.12, 0.24, 1]),
    ('Clown ruffle • cream', [1.0, 0.91, 0.76, 1]),
    ('Clown collar • sunny yellow', [1.0, 0.72, 0.13, 1]),
    ('Clown hat • cobalt', [0.12, 0.27, 0.83, 1]),
    ('Clown hat • cream', [1.0, 0.91, 0.76, 1]),
    ('Clown nose • cherry', [0.95, 0.08, 0.23, 1]),
    ('Clown pom • gold', [1.0, 0.72, 0.13, 1]),
]
material_ids = []
for name, color in palette:
    material_ids.append(len(doc['materials']))
    doc['materials'].append({
        'name': name,
        'pbrMetallicRoughness': {
            'baseColorFactor': color,
            'metallicFactor': 0.0,
            'roughnessFactor': 0.82,
        },
        'doubleSided': True,
    })

geometry = []


def add_surface(name, material, vertices, faces):
    """Append a flat shaded triangle surface as an independent GLTF primitive."""
    positions, normals, indices = [], [], []
    for face in faces:
        a, b, c = (vertices[i] for i in face)
        ab = [b[i] - a[i] for i in range(3)]
        ac = [c[i] - a[i] for i in range(3)]
        normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
        length = math.sqrt(sum(v * v for v in normal)) or 1
        normal = [v / length for v in normal]
        for point in (a, b, c):
            indices.append(len(positions))
            positions.extend(point)
            normals.extend(normal)
    positions = [float(v) for v in positions]
    start = len(binary)
    binary.extend(struct.pack('<%sf' % len(positions), *positions))
    binary[:] = align4(binary)
    pos_view = len(doc['bufferViews'])
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': start, 'byteLength': len(positions) * 4, 'target': 34962})
    pos_accessor = len(doc['accessors'])
    xs, ys, zs = positions[0::3], positions[1::3], positions[2::3]
    doc['accessors'].append({'bufferView': pos_view, 'componentType': 5126, 'count': len(positions) // 3, 'type': 'VEC3', 'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)]})
    start = len(binary)
    binary.extend(struct.pack('<%sf' % len(normals), *normals))
    binary[:] = align4(binary)
    norm_view = len(doc['bufferViews'])
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': start, 'byteLength': len(normals) * 4, 'target': 34962})
    norm_accessor = len(doc['accessors'])
    doc['accessors'].append({'bufferView': norm_view, 'componentType': 5126, 'count': len(normals) // 3, 'type': 'VEC3'})
    doc['meshes'][0]['primitives'].append({'attributes': {'POSITION': pos_accessor, 'NORMAL': norm_accessor}, 'material': material, 'mode': 4})
    geometry.append(name)


def ruffled_skirt(y_top, y_bottom, radius_top, radius_bottom, depth_top, depth_bottom, amplitude, material, phase=0):
    around, levels = 96, 8
    vertices = []
    for row in range(levels + 1):
        t = row / levels
        y = y_top + (y_bottom - y_top) * t
        rx = radius_top + (radius_bottom - radius_top) * t
        rz = depth_top + (depth_bottom - depth_top) * t
        for col in range(around):
            theta = 2 * math.pi * col / around
            pleat = amplitude * math.cos(12 * theta + phase) * (0.45 + 0.55 * t)
            vertices.append(((rx + pleat) * math.cos(theta), y, (rz + pleat * 0.7) * math.sin(theta)))
    faces = []
    for row in range(levels):
        for col in range(around):
            a = row * around + col
            b = row * around + (col + 1) % around
            c = (row + 1) * around + col
            d = (row + 1) * around + (col + 1) % around
            faces.extend(((a, c, b), (b, c, d)))
    add_surface('layered scallop skirt', material, vertices, faces)


def ruffle_collar(y, base_radius, tube, material):
    around, tube_segments = 144, 12
    vertices = []
    for i in range(around):
        theta = 2 * math.pi * i / around
        ruffle = 0.012 * math.cos(18 * theta)
        for j in range(tube_segments):
            phi = 2 * math.pi * j / tube_segments
            radius = base_radius + ruffle + tube * math.cos(phi)
            vertices.append((radius * math.cos(theta), y + tube * math.sin(phi), radius * 0.86 * math.sin(theta)))
    faces = []
    for i in range(around):
        for j in range(tube_segments):
            a = i * tube_segments + j
            b = i * tube_segments + (j + 1) % tube_segments
            c = ((i + 1) % around) * tube_segments + j
            d = ((i + 1) % around) * tube_segments + (j + 1) % tube_segments
            faces.extend(((a, b, c), (b, d, c)))
    add_surface('ruffled clown collar', material, vertices, faces)


def ring_mesh(y0, y1, r0, r1, depth, material, name, around=80):
    vertices = []
    for y, r in ((y0, r0), (y1, r1)):
        for i in range(around):
            a = 2 * math.pi * i / around
            vertices.append((r * math.cos(a), y, depth * math.sin(a)))
    faces = []
    for i in range(around):
        n = (i + 1) % around
        faces.extend(((i, n, around + i), (n, around + n, around + i)))
    add_surface(name, material, vertices, faces)


def ellipsoid(center, scale, material, name, rings=12, segments=20):
    vertices = []
    for row in range(rings + 1):
        phi = math.pi * row / rings
        for col in range(segments):
            theta = 2 * math.pi * col / segments
            vertices.append((center[0] + scale[0] * math.sin(phi) * math.cos(theta), center[1] + scale[1] * math.cos(phi), center[2] + scale[2] * math.sin(phi) * math.sin(theta)))
    faces = []
    for row in range(rings):
        for col in range(segments):
            a = row * segments + col
            b = row * segments + (col + 1) % segments
            c = (row + 1) * segments + col
            d = (row + 1) * segments + (col + 1) % segments
            faces.extend(((a, b, c), (b, d, c)))
    add_surface(name, material, vertices, faces)


# A crisp, tiered carnival skirt overlays her existing skirt and remains within the phone-scale model.
ruffled_skirt(0.91, 0.71, 0.145, 0.235, 0.12, 0.17, 0.012, material_ids[0], 0.0)
ruffled_skirt(0.77, 0.54, 0.205, 0.285, 0.15, 0.19, 0.015, material_ids[1], 0.18)
ruffled_skirt(0.60, 0.37, 0.25, 0.31, 0.17, 0.205, 0.018, material_ids[0], 0.0)
ruffled_skirt(0.43, 0.25, 0.285, 0.325, 0.19, 0.215, 0.018, material_ids[1], 0.18)
ruffle_collar(1.235, 0.09, 0.031, material_ids[2])

# A small two-tone cone hat, brim, red nose, and golden costume buttons.
ring_mesh(1.585, 1.61, 0.16, 0.16, 0.105, material_ids[4], 'cream hat brim')
ring_mesh(1.605, 1.79, 0.14, 0.012, 0.105, material_ids[3], 'cobalt jester cap')
ellipsoid((0.0, 1.385, 0.135), (0.038, 0.038, 0.032), material_ids[5], 'cherry clown nose')
for y in (1.12, 1.045, 0.97):
    ellipsoid((0.0, y, 0.132), (0.022, 0.022, 0.012), material_ids[6], 'gold costume button', 8, 12)

doc['buffers'][0]['byteLength'] = len(binary)
encoded_json = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
json_chunk = encoded_json + b' ' * ((-len(encoded_json)) % 4)
binary_chunk = bytes(binary) + bytes((-len(binary)) % 4)
total = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
with DEST.open('wb') as out:
    out.write(struct.pack('<III', 0x46546C67, 2, total))
    out.write(struct.pack('<II', len(json_chunk), 0x4E4F534A))
    out.write(json_chunk)
    out.write(struct.pack('<II', len(binary_chunk), 0x004E4942))
    out.write(binary_chunk)
print(f'Created {DEST} with {len(geometry)} clown costume pieces')
