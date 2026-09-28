"""Media operations for the desktop worker; no inference imports at module load."""
import ctypes
import errno
import math
import os
import pickle
import subprocess
from pathlib import Path


def safe_path(base, *parts):
    base = Path(base).resolve()
    value = base.joinpath(*parts)
    if not value.is_relative_to(base):
        raise ValueError('Путь за пределами рабочего каталога.')
    current = base
    for part in value.relative_to(base).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Символические ссылки в результатах не поддерживаются.')
    return value


def validate_face_box(box, frame_shape, order='xyxy'):
    if box is None or len(box) != 4 or any(not math.isfinite(float(x)) for x in box):
        raise ValueError('Лицо не найдено или координаты некорректны.')
    values = tuple(int(x) for x in box)
    if order == 'xyxy':
        x1, y1, x2, y2 = values
    elif order == 'yxyx':
        y1, y2, x1, x2 = values
    else:
        raise ValueError('Неизвестный порядок координат.')
    h, w = frame_shape[:2]
    if not (0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h):
        raise ValueError('Лицо не найдено или область лица выходит за границы кадра.')
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
            raise ValueError('Не удалось прочитать изображение. Выберите корректный PNG/JPEG.') from error
    elif kind == 'video':
        output = work_dir / 'normalized.avi'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(source), '-an', '-vf', 'fps=25', '-c:v', 'ffv1', str(output)], check=True)
        if not output.is_file() or not output.stat().st_size:
            raise ValueError('Видео не содержит читаемых кадров.')
    else:
        raise ValueError('Неподдерживаемый тип исходника.')
    return output


def preview_media(source, kind, destination):
    from PIL import Image, ImageOps
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if kind == 'image':
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((256, 256))
            image.save(destination, 'JPEG')
    else:
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(source), '-frames:v', '1', '-vf', 'scale=256:256:force_original_aspect_ratio=decrease', str(destination)], check=True, timeout=30)
    if not destination.is_file() or not destination.stat().st_size or destination.stat().st_size > 512 * 1024:
        raise ValueError('Не удалось создать миниатюру.')
    return destination


def _images(folder):
    from PIL import Image
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError('Нет каталога кадров или обнаружена ссылка.')
    files = [x for x in folder.iterdir() if x.suffix.lower() in ('.png', '.jpg', '.jpeg')]
    if not files or any(not x.stem.isdigit() or x.is_symlink() for x in files) or len({int(x.stem) for x in files}) != len(files):
        raise ValueError('Нет кадров или имена кадров некорректны.')
    result = []
    for file in sorted(files, key=lambda x: int(x.stem)):
        with Image.open(file) as image:
            image.load()
            result.append((int(file.stem), image.size))
    return result


def validate_generated_avatar(output, model):
    output = Path(output)
    if output.is_symlink():
        raise ValueError('Недопустимый каталог результата.')
    required = ['coords.pkl', 'full_imgs'] + (['mask', 'mask_coords.pkl', 'latents.pt'] if model == 'musetalk' else ['face_imgs'])
    for item in required:
        file = safe_path(output, item)
        if not file.exists() or (file.is_file() and not file.stat().st_size):
            raise ValueError(f'Результат неполон: {item}')
    full = _images(output / 'full_imgs')
    other = _images(output / ('mask' if model == 'musetalk' else 'face_imgs'))
    if [i for i, _ in full] != [i for i, _ in other]:
        raise ValueError('Число и индексы лиц/масок не совпадают с кадрами.')
    with (output / 'coords.pkl').open('rb') as file:
        coordinates = pickle.load(file)  # Only our fresh worker output, never catalog discovery.
    if len(coordinates) != len(full):
        raise ValueError('Число координат не соответствует кадрам.')
    for box, (_, (w, h)) in zip(coordinates, full):
        validate_face_box(box, (h, w, 3), 'xyxy' if model == 'musetalk' else 'yxyx')
    if model == 'musetalk':
        import torch
        with (output / 'mask_coords.pkl').open('rb') as file:
            masks = pickle.load(file)
        latents = torch.load(output / 'latents.pt', map_location='cpu', weights_only=True)
        if len(masks) != len(full) or len(latents) != len(full) or any(not isinstance(x, torch.Tensor) or not x.numel() or not torch.isfinite(x).all() for x in latents):
            raise ValueError('Маски или латенты не соответствуют кадрам.')
        for box in masks:
            if len(box) != 4 or any(not math.isfinite(float(x)) for x in box) or box[0] >= box[2] or box[1] >= box[3]:
                raise ValueError('Некорректные координаты маски.')
    elif any(size != (256, 256) for _, size in other):
        raise ValueError('Размер лица Wav2Lip должен быть 256×256.')
    return len(full)


def publish_directory(staged, final):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(staged), -100, os.fsencode(final), 1):
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(code, 'Аватар с таким ID уже существует.', str(final))
        raise OSError(code, os.strerror(code), str(final))
