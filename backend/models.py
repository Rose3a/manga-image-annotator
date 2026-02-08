from pydantic import BaseModel
from typing import Optional, List, Literal


class BoundingBoxAbs(BaseModel):
    """絶対座標でのバウンディングボックス（ピクセル単位）"""
    x: float
    y: float
    width: float
    height: float


class BoundingBoxRel(BaseModel):
    """相対座標でのバウンディングボックス（0.0-1.0）"""
    x: float
    y: float
    width: float
    height: float


class Annotation(BaseModel):
    """個別のアノテーション情報"""
    id: str
    type: Literal["dialogue", "monologue", "whisper", "narration", "ruby", "sound_effect", "title", "footnote", "person", "face", "body_part", "object", "panel"]
    order: int  # コマの読み順
    bbox_abs: BoundingBoxAbs
    bbox_rel: BoundingBoxRel
    text: str
    character_id: Optional[str] = None
    subtype: Optional[str] = None


class ImageSize(BaseModel):
    """画像サイズ"""
    width: int
    height: int


class ImageAnnotation(BaseModel):
    """画像全体のアノテーションデータ"""
    image_id: str
    image_filename: str
    image_size: ImageSize
    page_summary: Optional[str] = None
    is_completed: bool = False  # 作業完了フラグ
    annotations: List[Annotation] = []


class AnnotationCreate(BaseModel):
    """アノテーション作成用のリクエストモデル"""
    image_id: str
    type: Literal["dialogue", "monologue", "whisper", "narration", "ruby", "sound_effect", "title", "footnote", "person", "face", "body_part", "object", "panel"]
    order: Optional[int] = None
    bbox_abs: BoundingBoxAbs
    text: str
    character_id: Optional[str] = None
    subtype: Optional[str] = None


class AnnotationUpdate(BaseModel):
    """アノテーション更新用のリクエストモデル"""
    type: Optional[Literal["dialogue", "monologue", "whisper", "narration", "ruby", "sound_effect", "title", "footnote", "person", "face", "body_part", "object", "panel"]] = None
    order: Optional[int] = None
    bbox_abs: Optional[BoundingBoxAbs] = None
    text: Optional[str] = None
    character_id: Optional[str] = None
    subtype: Optional[str] = None


class TextUpdate(BaseModel):
    """テキスト更新のみのリクエストモデル"""
    text: str


class StatusUpdate(BaseModel):
    """完了ステータス更新用のリクエストモデル"""
    is_completed: bool


class OCRRequest(BaseModel):
    """OCR実行用のリクエストモデル"""
    image_id: str
    bbox_abs: BoundingBoxAbs


class TaggerRequest(BaseModel):
    """Tagger実行用のリクエストモデル"""
    image_id: str
    bbox_abs: BoundingBoxAbs
    threshold: Optional[float] = 0.6  # デフォルト0.6
    annotation_type: Optional[str] = None  # アノテーションタイプ (face, person, etc.)


class ReorderRequest(BaseModel):
    """アノテーションの読み順を一括更新するためのリクエストモデル"""
    annotation_ids: List[str]


class SummaryUpdate(BaseModel):
    """ページサマリー更新用のリクエストモデル"""
    page_summary: str


class TaggerSettings(BaseModel):
    """タガー設定情報のモデル"""
    tagger_model: str
    tagger_threshold: float
    excluded_tags: List[str]
