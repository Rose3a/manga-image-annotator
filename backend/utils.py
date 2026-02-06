import json
from pathlib import Path
from models import BoundingBoxAbs, BoundingBoxRel

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_IMAGES_DIR = BASE_DIR / "data" / "images"
DEFAULT_ANNO_DIR = BASE_DIR / "data" / "annotations"


def absolute_to_relative(bbox_abs: BoundingBoxAbs, image_width: int, image_height: int) -> BoundingBoxRel:
    """絶対座標を相対座標に変換"""
    return BoundingBoxRel(
        x=bbox_abs.x / image_width,
        y=bbox_abs.y / image_height,
        width=bbox_abs.width / image_width,
        height=bbox_abs.height / image_height
    )


def relative_to_absolute(bbox_rel: BoundingBoxRel, image_width: int, image_height: int) -> BoundingBoxAbs:
    """相対座標を絶対座標に変換"""
    return BoundingBoxAbs(
        x=bbox_rel.x * image_width,
        y=bbox_rel.y * image_height,
        width=bbox_rel.width * image_width,
        height=bbox_rel.height * image_height
    )


def get_next_image_number(image_dir: Path = None, anno_dir: Path = None) -> str:
    """次の画像番号を取得（5桁の連番）
    画像ディレクトリとアノテーションディレクトリの両方を確認し、最大の番号+1を返します。
    """
    if image_dir is None:
        image_dir = DEFAULT_IMAGES_DIR
    if anno_dir is None:
        anno_dir = DEFAULT_ANNO_DIR

    image_dir.mkdir(parents=True, exist_ok=True)
    anno_dir.mkdir(parents=True, exist_ok=True)
    
    # 画像ファイルとJSONファイルの両方をスキャン
    files = []
    # すべてのファイルを取得して、拡張子でフィルタリングする方が確実
    for file in image_dir.iterdir():
        if file.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp']:
            files.append(file)
            
    for file in anno_dir.iterdir():
        if file.suffix.lower() == '.json':
            files.append(file)
    
    print(f"DEBUG: Scanned files: {[f.name for f in files]}")
    
    if not files:
        return "00001"
    
    # ファイル名から番号を抽出
    numbers = []
    for file in files:
        stem = file.stem
        try:
            num = int(stem)
            numbers.append(num)
        except ValueError:
            continue
    
    print(f"DEBUG: Found numbers: {numbers}")
    
    if not numbers:
        return "00001"
    
    next_num = max(numbers) + 1
    result = f"{next_num:05d}"
    print(f"DEBUG: Next number: {result}")
    return result


def save_annotation_json(annotation_data: dict, image_id: str, data_dir: Path = DEFAULT_ANNO_DIR):
    """アノテーションデータをJSONファイルに保存"""
    data_dir.mkdir(parents=True, exist_ok=True)
    
    json_path = Path(data_dir) / f"{image_id}.json"
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(annotation_data, f, ensure_ascii=False, indent=2)
    
    return str(json_path)


def load_annotation_json(image_id: str, data_dir: Path = DEFAULT_ANNO_DIR) -> dict:
    """アノテーションデータをJSONファイルから読み込み"""
    json_path = Path(data_dir) / f"{image_id}.json"
    
    if not json_path.exists():
        return None
    
    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)
