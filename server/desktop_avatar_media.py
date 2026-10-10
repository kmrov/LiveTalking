"""Media operations for the desktop worker; no inference imports at module load."""
import ctypes
import errno
import json
import math
import os
import pickle
import subprocess
from pathlib import Path


def safe_path(base, *parts):
    base = Path(base).resolve()
    value = base.joinpath(*parts)
    if not value.is_relative_to(base):
        raise ValueError('Path is outside the working directory.')
    current = base
    for part in value.relative_to(base).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Symbolic links are not supported in results.')
    return value


def validate_face_box(box, frame_shape, order='xyxy'):
    if box is None or len(box) != 4 or any(not math.isfinite(float(x)) for x in box):
        raise ValueError('Face not found or coordinates are invalid.')
    values = tuple(int(x) for x in box)
    if order == 'xyxy':
        x1, y1, x2, y2 = values
    elif order == 'yxyx':
        y1, y2, x1, x2 = values
    else:
        raise ValueError('Unknown coordinate order.')
    h, w = frame_shape[:2]
    if not (0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h):
        raise ValueError('Face not found or face area extends outside the frame.')
    return values


def normalize_media(source, kind, work_dir):
    from PIL import Image, ImageOps
    source, work_dir = Path(source), Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    if kind == 'image':
        output = work_dir / '00000000.png'
        try:
            with Image.open(source) as image:
                ImageOps.exif_transpose(image).convert('RGB').save(output)
        except (OSError, ValueError) as error:
            raise ValueError('Could not read the image. Select a valid PNG/JPEG.') from error
    elif kind == 'video':
        output = work_dir / 'normalized.avi'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(source), '-an', '-vf', 'fps=25', '-c:v', 'ffv1', str(output)], check=True)
        if not output.is_file() or not output.stat().st_size:
            raise ValueError('Video has no readable frames.')
    else:
        raise ValueError('Unsupported source type.')
    return output


def preview_media(source, kind, destination):
    from PIL import Image, ImageOps
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if kind == 'image':
        with Image.open(source) as image:
            if max(image.size)>16384 or image.width*image.height>32_000_000:
                raise ValueError('Too many pixels for a thumbnail.')
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((256, 256))
            image.save(destination, 'JPEG')
    else:
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '1', '-i', str(source), '-frames:v', '1', '-filter_threads', '1', '-vf', 'scale=256:256:force_original_aspect_ratio=decrease', '-threads', '1', str(destination)], check=True, timeout=30)
    if not destination.is_file() or not destination.stat().st_size or destination.stat().st_size > 512 * 1024:
        raise ValueError('Could not create thumbnail.')
    return destination


def _images(folder):
    from PIL import Image
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError('Frame directory is missing or contains a symbolic link.')
    files = [x for x in folder.iterdir() if x.suffix.lower() in ('.png', '.jpg', '.jpeg')]
    if not files or any(not x.stem.isdigit() or x.is_symlink() for x in files) or len({int(x.stem) for x in files}) != len(files):
        raise ValueError('Frames are missing or frame names are invalid.')
    result = []
    for file in sorted(files, key=lambda x: int(x.stem)):
        with Image.open(file) as image:
            image.load()
            result.append((int(file.stem), image.size))
    return result


def validate_generated_avatar(output, model):
    output = Path(output)
    if output.is_symlink():
        raise ValueError('Invalid result directory.')
    if model in ('ditto','soulx','avtr1'):
        marker=safe_path(output,'generative-avatar.json')
        if not marker.is_file() or not 0 < marker.stat().st_size <= 65536:
            raise ValueError('Missing or invalid generative avatar marker.')
        declaration=json.loads(marker.read_text())
        if not isinstance(declaration,dict) or type(declaration.get('version')) is not int or declaration['version'] != 1 or declaration.get('model') != model:
            raise ValueError('Generative avatar marker does not match the selected model.')
        if any((output/name).exists() or (output/name).is_symlink() for name in ('coords.pkl','face_imgs','latents.pt','mask','mask_coords.pkl','ultralight.pth')):
            raise ValueError('Conflicting files from different models.')
        full=_images(safe_path(output,'full_imgs'))
        if len(full)!=1 or not safe_path(output,'full_imgs','00000000.png').is_file():
            raise ValueError('Generative avatars require one reference image: full_imgs/00000000.png.')
        return 1
    if model not in ('musetalk','wav2lip'):
        raise ValueError('Unsupported avatar model.')
    required = ['coords.pkl', 'full_imgs'] + (['mask', 'mask_coords.pkl', 'latents.pt'] if model == 'musetalk' else ['face_imgs'])
    for item in required:
        file = safe_path(output, item)
        if not file.exists() or (file.is_file() and not file.stat().st_size):
            raise ValueError(f'Incomplete result: {item}')
    full = _images(output / 'full_imgs')
    other = _images(output / ('mask' if model == 'musetalk' else 'face_imgs'))
    if [i for i, _ in full] != [i for i, _ in other]:
        raise ValueError('Face/mask counts and indices do not match frames.')
    with (output / 'coords.pkl').open('rb') as file:
        coordinates = pickle.load(file)  # Only our fresh worker output, never catalog discovery.
    if len(coordinates) != len(full):
        raise ValueError('Coordinate count does not match frames.')
    for box, (_, (w, h)) in zip(coordinates, full):
        validate_face_box(box, (h, w, 3), 'xyxy' if model == 'musetalk' else 'yxyx')
    if model == 'musetalk':
        import torch
        with (output / 'mask_coords.pkl').open('rb') as file:
            masks = pickle.load(file)
        latents = torch.load(output / 'latents.pt', map_location='cpu', weights_only=True)
        if len(masks) != len(full) or len(latents) != len(full) or any(not isinstance(x, torch.Tensor) or not x.numel() or not torch.isfinite(x).all() for x in latents):
            raise ValueError('Masks or latents do not match frames.')
        for box in masks:
            if len(box) != 4 or any(not math.isfinite(float(x)) for x in box) or box[0] >= box[2] or box[1] >= box[3]:
                raise ValueError('Invalid mask coordinates.')
    elif any(size != (256, 256) for _, size in other):
        raise ValueError('Wav2Lip face size must be 256×256.')
    return len(full)


def publish_directory(staged, final):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(staged), -100, os.fsencode(final), 1):
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(code, 'An avatar with this ID already exists.', str(final))
        raise OSError(code, os.strerror(code), str(final))
