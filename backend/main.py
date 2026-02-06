from fastapi import FastAPI, UploadFile, File, HTTPException, Request, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.security import APIKeyHeader
from pathlib import Path
from PIL import Image
import shutil
import uuid
import json
import secrets
import time
import os
from models import (
    ImageAnnotation, Annotation, AnnotationCreate,
    ImageSize, BoundingBoxAbs, BoundingBoxRel, OCRRequest, TaggerRequest,
    AnnotationUpdate, TextUpdate, ReorderRequest, SummaryUpdate,
    StatusUpdate, TaggerSettings
)
from manga_ocr import MangaOcr
from utils import (
    absolute_to_relative, get_next_image_number,
    save_annotation_json, load_annotation_json
)

# manga-ocr の遅延初期化用
_mocr = None

def get_mocr():
    global _mocr
    if _mocr is None:
        print("Initializing Manga-OCR...")
        _mocr = MangaOcr()
        print("Manga-OCR initialized.")
    return _mocr

# WD Tagger の遅延初期化用
_tagger_model = None
_tagger_transform = None
_tagger_labels = None
_tagger_categories = None
_current_tagger_model_id = None

_current_tagger_model_id = None

SETTINGS_FILE = Path(__file__).parent / "settings.json"

def load_settings():
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "tagger_model": "SmilingWolf/wd-convnext-tagger-v3",
        "tagger_threshold": 0.6,
        "excluded_tags": ["blue skin", "colored skin", "青肌", "色付きの肌"]
    }

def save_settings(settings):
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)

TAGGER_SETTINGS = load_settings()

def get_tagger():
    global _tagger_model, _tagger_transform, _tagger_labels, _tagger_categories, _current_tagger_model_id
    
    model_id = TAGGER_SETTINGS["tagger_model"]
    
    if _tagger_model is None or _current_tagger_model_id != model_id:
        print(f"Initializing WD Tagger with model: {model_id}...")
        import timm
        from timm.data import resolve_data_config, create_transform
        import torch
        from huggingface_hub import hf_hub_download
        import csv
        
        # モデルロード (既存モデルがあればメモリ解放を検討すべきだが、一旦上書き)
        _tagger_model = timm.create_model(f"hf_hub:{model_id}", pretrained=True)
        _tagger_model.eval()
        _current_tagger_model_id = model_id
        
        # GPU利用可能ならGPUへ
        if torch.cuda.is_available():
            _tagger_model = _tagger_model.cuda()
            print("WD Tagger: Using CUDA")
        else:
            print("WD Tagger: Using CPU")
        
        # 前処理用transform
        config = resolve_data_config(_tagger_model.pretrained_cfg)
        _tagger_transform = create_transform(**config)
        
        # ラベルファイル取得 (ローカルの日本語版があれば優先)
        local_label_path = Path(__file__).parent / "selected_tags_ja.csv"
        
        global _tagger_orig_labels
        _tagger_orig_labels = None
        
        if local_label_path.exists():
            print(f"Loading local Japanese tag labels from {local_label_path}")
            with open(local_label_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
                _tagger_labels = [row["name"] for row in rows]
                _tagger_categories = [int(row.get("category", 0)) for row in rows]
                # 日本語版には original_en カラムがある前提
                if "original_en" in rows[0]:
                    _tagger_orig_labels = [row["original_en"] for row in rows]
        else:
            label_path = hf_hub_download(repo_id=model_id, filename="selected_tags.csv")
            with open(label_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
                _tagger_labels = [row["name"] for row in rows]
                _tagger_categories = [int(row.get("category", 0)) for row in rows]
        
        print(f"WD Tagger initialized. {len(_tagger_labels)} labels loaded.")
    
    return _tagger_model, _tagger_transform, _tagger_labels, _tagger_categories, globals().get("_tagger_orig_labels")

    return _tagger_model, _tagger_transform, _tagger_labels, _tagger_categories, globals().get("_tagger_orig_labels")

app = FastAPI(
    title="Manga Annotation Tool",
    docs_url=None,    # Disable Swagger UI
    redoc_url=None,   # Disable Redoc
    openapi_url=None  # Hide OpenAPI schema
)

# CORS設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load .env
ENV_FILE = Path(__file__).parent / ".env"
GUEST_PASSWORD = "guest"  # Default

if ENV_FILE.exists():
    with open(ENV_FILE, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                parts = line.strip().split("=", 1)
                if len(parts) == 2:
                    key, val = parts
                    if key.strip() == "GUEST_PASSWORD":
                        GUEST_PASSWORD = val.strip()

# InMemory State
class State:
    def __init__(self):
        self.guest_sessions = set() # valid tokens

state = State()

# GPU状態確認エンドポイント
@app.get("/gpu-status")
async def get_gpu_status():
    try:
        import torch
        cuda_available = torch.cuda.is_available()
        device_count = torch.cuda.device_count() if cuda_available else 0
        device_name = torch.cuda.get_device_name(0) if cuda_available and device_count > 0 else None
        
        return {
            "cuda_available": cuda_available,
            "device_count": device_count,
            "device_name": device_name,
            "pytorch_version": torch.__version__
        }
    except Exception as e:
        return {
            "error": str(e),
            "cuda_available": False
        }

# バリデーションエラーハンドラー
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    print(f"Validation error on {request.method} {request.url}")
    print(f"Request body: {await request.body()}")
    print(f"Errors: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )

# ディレクトリ設定
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
FRONTEND_DIR = BASE_DIR / "frontend"

# データディレクトリの作成
(DATA_DIR / "images").mkdir(parents=True, exist_ok=True)
(DATA_DIR / "annotations").mkdir(parents=True, exist_ok=True)
(DATA_DIR / "guest_images").mkdir(parents=True, exist_ok=True)
(DATA_DIR / "guest_annotations").mkdir(parents=True, exist_ok=True)


# --- ゲストモード関連 ---

API_KEY_HEADER = APIKeyHeader(name="Authorization", auto_error=False)

def is_local_request(request: Request):
    client_host = request.client.host
    return client_host in ("127.0.0.1", "localhost", "::1")

async def get_current_user(request: Request, token: str = Depends(API_KEY_HEADER)):
    is_local = is_local_request(request)
    
    if is_local:
        # print(f"Local access from {request.client.host}") # Verbose
        return {"role": "admin"}
    
    print(f"Remote access attempt from {request.client.host}")
    
    # リモートアクセスの場合はトークンチェック
    # まずCookieをチェック
    cookie_token = request.cookies.get("manga_ocr_token")
    
    # CookieまたはAuthorizationヘッダーからトークンを取得
    auth_token = cookie_token or token
    
    if not auth_token:
        print(f"Auth failed: Remote IP {request.client.host} with no token")
        # トークンがない場合は未認証
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    # "Bearer " プレフィックスの処理 (ヘッダーの場合)
    if auth_token and auth_token.startswith("Bearer "):
        auth_token = auth_token.split(" ")[1]

    if auth_token in state.guest_sessions:
        return {"role": "guest"}
    
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid token",
    )

def get_dirs(user):
    """ユーザーロールに基づいてディレクトリを返す"""
    if user["role"] == "guest":
        return DATA_DIR / "guest_images", DATA_DIR / "guest_annotations"
    else:
        return DATA_DIR / "images", DATA_DIR / "annotations"

# --- 設定関連 ---

@app.get("/settings")
async def get_settings(user: dict = Depends(get_current_user)):
    return TAGGER_SETTINGS

@app.post("/settings")
async def update_settings(settings: TaggerSettings, user: dict = Depends(get_current_user)):
    global TAGGER_SETTINGS
    TAGGER_SETTINGS = settings.model_dump()
    save_settings(TAGGER_SETTINGS)
    return TAGGER_SETTINGS

# --- エンドポイント ---

# 静的ファイルの配信 (認証不要だが、HTML側でAPI制限に対応する)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

@app.get("/")
async def root(user: dict = Depends(get_current_user)):
    """フロントエンドのHTMLを返す (認証必須)"""
    return FileResponse(str(FRONTEND_DIR / "index.html"))

@app.get("/viewer")
async def viewer_page(user: dict = Depends(get_current_user)):
    """ビューアーページを返す (認証必須)"""
    return FileResponse(str(FRONTEND_DIR / "viewer.html"))

@app.get("/login")
async def login_page():
    return FileResponse(str(FRONTEND_DIR / "login.html"))

@app.get("/me")
async def get_my_role(user: dict = Depends(get_current_user)):
    """現在のユーザー情報を返す"""
    return user

# ゲスト用: ログイン
@app.post("/guest/login")
async def guest_login(body: dict):
    """パスワード(OTPフィールドで受信)を検証してトークンを発行"""
    input_pass = body.get("otp")  # Keep field name for now
    
    # Static password check
    if input_pass == GUEST_PASSWORD:
         token = secrets.token_urlsafe(32)
         state.guest_sessions.add(token)
         
         # JSONレスポンスを作成してCookieを設定
         response = JSONResponse(content={"token": token})
         response.set_cookie(
             key="manga_ocr_token",
             value=token,
             httponly=True,  # JavaScriptからアクセス不可（セキュリティ向上）
             max_age=86400 * 7,  # 7日間有効
             samesite="lax"  # CSRF保護
         )
         return response
    
    raise HTTPException(status_code=401, detail="Invalid password")

@app.get("/annotations-list")
async def list_annotated_images(user: dict = Depends(get_current_user)):
    """アノテーションが存在する画像の一覧を取得"""
    img_dir, anno_dir = get_dirs(user)
    
    # ゲストの場合：guest_imagesにある全画像を表示候補とする
    # 未アノテーションのものも含めるため、画像フォルダをスキャン
    
    files_list = []
    
    # 画像ファイルのスキャン
    if img_dir.exists():
        for file in img_dir.iterdir():
            if file.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp']:
                image_id = file.stem
                
                # 対応するアノテーションがあるか確認
                json_path = anno_dir / f"{image_id}.json"
                
                is_completed = False
                has_annotation = False
                
                if json_path.exists():
                    try:
                        with open(json_path, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                            has_annotation = True
                            is_completed = data.get("is_completed", False)
                    except:
                        pass
                
                files_list.append({
                    "id": image_id,
                    "has_annotation": has_annotation,
                    "is_completed": is_completed
                })
    
    # ID順にソート
    files_list.sort(key=lambda x: x["id"], reverse=False)
    
    return {"images": files_list}


@app.get("/next-image-number")
async def next_image_number(user: dict = Depends(get_current_user)):
    """次の画像番号を取得"""
    # ゲストはアップロードしない前提だが、一応ディレクトリを分けて対応
    img_dir, anno_dir = get_dirs(user)
    # get_next_image_number は引数を取るように utils.py 側も修正が必要だが、
    # モデルの依存関係が複雑なので今回は簡易的に既存関数をラップするか、または
    # guest環境では使わせない機能とする。
    # ここでは既存機能はホスト(admin)向けとして動作させる。
    if user["role"] == "guest":
        return {"next_number": 0} # ゲストはアップロード不可

    # utils.pyの関数は引数なしでデフォルトディレクトリを見る仕様か確認が必要。
    # 今のutils.pyの実装(main.pyの前半にあった)を見ると引数を取るようになっている
    next_num = get_next_image_number(img_dir, anno_dir)
    return {"next_number": next_num}


@app.post("/upload")
async def upload_image(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """画像をアップロードして連番でリネーム保存"""
    img_dir, anno_dir = get_dirs(user)
    
    if user["role"] == "guest":
         raise HTTPException(status_code=403, detail="ゲストは画像をアップロードできません")

    try:
        # 次の画像番号を取得
        image_id = get_next_image_number(img_dir, anno_dir)
        
        # ファイル拡張子を取得
        file_ext = Path(file.filename).suffix.lower()
        if file_ext not in ['.jpg', '.jpeg', '.png', '.webp']:
            raise HTTPException(status_code=400, detail="サポートされていないファイル形式です")
        
        # 画像を保存
        image_filename = f"{image_id}{file_ext}"
        image_path = img_dir / image_filename
        
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        # 画像サイズを取得
        with Image.open(image_path) as img:
            width, height = img.size
        
        # 初期アノテーションデータを作成
        annotation_data = ImageAnnotation(
            image_id=image_id,
            image_filename=image_filename,
            image_size=ImageSize(width=width, height=height),
            page_summary="",
            annotations=[]
        )
        
        # JSONファイルに保存 (ディレクトリ指定版が必要)
        # utils.save_annotation_json は内部で DATA_DIR を使っている可能性があるため
        # ここでは直接保存するか、utilsを修正する。安全のため直接保存を実装。
        with open(anno_dir / f"{image_id}.json", 'w', encoding='utf-8') as f:
            json.dump(annotation_data.model_dump(), f, ensure_ascii=False, indent=2)
        
        return {
            "image_id": image_id,
            "image_filename": image_filename,
            "image_size": {"width": width, "height": height}
        }
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/images/{filename}")
async def get_image(filename: str, user: dict = Depends(get_current_user)):
    """画像ファイルを取得"""
    # ディレクトリ・トラバーサル対策: ファイル名のみを取得
    safe_filename = Path(filename).name
    img_dir, _ = get_dirs(user)
    image_path = img_dir / safe_filename
    
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="画像が見つかりません")
    return FileResponse(str(image_path))


@app.get("/annotations/{image_id}")
async def get_annotations(image_id: str, user: dict = Depends(get_current_user)):
    """特定の画像のアノテーションを取得"""
    img_dir, anno_dir = get_dirs(user)
    json_path = anno_dir / f"{image_id}.json"
    
    if json_path.exists():
        try:
             with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data
        except Exception as e:
            print(f"Error loading json: {e}")
            pass # JSONがない、または壊れている場合は下へ
    
    # JSONが存在しない場合、画像があるか確認して初期データを返す（ゲスト用）
    # 画像拡張子を探索
    image_path = None
    image_filename = None
    for ext in ['.jpg', '.jpeg', '.png', '.webp']:
        p = img_dir / f"{image_id}{ext}"
        if p.exists():
            image_path = p
            image_filename = f"{image_id}{ext}"
            break
            
    if image_path:
        # 画像はあるがアノテーションがない -> 初期データを返す
        with Image.open(image_path) as img:
            width, height = img.size
            
        return ImageAnnotation(
            image_id=image_id,
            image_filename=image_filename,
            image_size=ImageSize(width=width, height=height),
            page_summary="",
            annotations=[]
        ).model_dump()

    raise HTTPException(status_code=404, detail="画像が見つかりません")


@app.post("/annotations")
async def create_annotation(annotation: AnnotationCreate, user: dict = Depends(get_current_user)):
    """新しいアノテーションを作成"""
    img_dir, anno_dir = get_dirs(user)
    try:
        # 既存データを読み込み（なければ初期化）
        json_path = anno_dir / f"{annotation.image_id}.json"
        
        annotation_data = None
        if json_path.exists():
             with open(json_path, 'r', encoding='utf-8') as f:
                annotation_data = json.load(f)
        else:
            # 新規作成ロジック（画像情報の取得が必要）
            # get_annotationsと同様のロジック
            # (簡略化のため、get_annotations が勝手にやってくれるのを期待したいが内部呼び出しはしにくい)
             # 画像拡張子を探索
            image_path = None
            filename = None
            for ext in ['.jpg', '.jpeg', '.png', '.webp']:
                p = img_dir / f"{annotation.image_id}{ext}"
                if p.exists():
                    image_path = p
                    filename = f"{annotation.image_id}{ext}"
                    break
            
            if not image_path:
                raise HTTPException(status_code=404, detail="画像が見つかりません")

            with Image.open(image_path) as img:
                width, height = img.size
            
            annotation_data = ImageAnnotation(
                image_id=annotation.image_id,
                image_filename=filename,
                image_size=ImageSize(width=width, height=height),
                annotations=[]
            ).model_dump()

        
        image_annotation = ImageAnnotation(**annotation_data)
        
        # 相対座標を計算
        bbox_rel = absolute_to_relative(
            annotation.bbox_abs,
            image_annotation.image_size.width,
            image_annotation.image_size.height
        )
        
        # 新しいアノテーションを作成
        new_annotation = Annotation(
            id=f"anno_{uuid.uuid4().hex[:8]}",
            type=annotation.type,
            order=annotation.order,
            bbox_abs=annotation.bbox_abs,
            bbox_rel=bbox_rel,
            text=annotation.text,
            character_id=annotation.character_id,
            subtype=annotation.subtype
        )
        
        # 重複order許可のルール
        def can_share_order(anno1: Annotation, anno2: Annotation) -> bool:
            """2つのアノテーションが同じorder番号を共有できるかどうかを判定"""
            # sound_effectは両方がsound_effectの場合のみ重複を許可
            if anno1.type == 'sound_effect' and anno2.type == 'sound_effect':
                return True
            
            # face, person, body_part, object は両方が該当タイプで、同一character_idなら許可
            groupable_types = {'face', 'person', 'body_part', 'object'}
            if anno1.type in groupable_types and anno2.type in groupable_types:
                if anno1.character_id and anno2.character_id and anno1.character_id == anno2.character_id:
                    return True
            
            # それ以外は重複不可
            return False
        
        # アノテーションリストに追加
        target_order = annotation.order
        if target_order is not None:
            # 同じorderを持つアノテーションがあるか確認
            existing_with_same_order = [
                anno for anno in image_annotation.annotations 
                if anno.order == target_order
            ]
            
            # 重複許可チェック
            if existing_with_same_order:
                # 全ての既存アノテーションが新しいアノテーションと重複を許可できるか確認
                can_duplicate = all(
                    can_share_order(new_annotation, existing) 
                    for existing in existing_with_same_order
                )
                
                if can_duplicate:
                    # 重複許可 - そのまま追加
                    image_annotation.annotations.append(new_annotation)
                else:
                    # 重複不可 - 既存のorderをずらす
                    sorted_annos = sorted(image_annotation.annotations, key=lambda x: x.order)
                    for anno in sorted_annos:
                        if anno.order >= target_order:
                            anno.order += 1
                    sorted_annos.append(new_annotation)
                    image_annotation.annotations = sorted(sorted_annos, key=lambda x: x.order)
            else:
                # 同じorderが存在しない場合は単純に追加
                image_annotation.annotations.append(new_annotation)
        else:
            # orderが指定されていない場合は末尾に追加
            new_annotation.order = len(image_annotation.annotations) + 1
            image_annotation.annotations.append(new_annotation)
        
        # JSONファイルに保存
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(image_annotation.model_dump(), f, ensure_ascii=False, indent=2)
        
        return new_annotation
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/annotations/{image_id}/{annotation_id}")
async def delete_annotation(image_id: str, annotation_id: str, user: dict = Depends(get_current_user)):
    """アノテーションを削除"""
    img_dir, anno_dir = get_dirs(user)
    json_path = anno_dir / f"{image_id}.json"
    
    try:
        if not json_path.exists():
            raise HTTPException(status_code=404, detail="データが見つかりません")
            
        with open(json_path, 'r', encoding='utf-8') as f:
            annotation_data = json.load(f)
        
        image_annotation = ImageAnnotation(**annotation_data)
        
        # アノテーションを削除
        image_annotation.annotations = [
            anno for anno in image_annotation.annotations
            if anno.id != annotation_id
        ]
        
        # JSONファイルに保存
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(image_annotation.model_dump(), f, ensure_ascii=False, indent=2)
        
        return {"message": "削除しました"}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/annotations/{image_id}/reorder")
async def reorder_annotations(image_id: str, request: ReorderRequest, user: dict = Depends(get_current_user)):
    """アノテーションの順番を一括更新"""
    img_dir, anno_dir = get_dirs(user)
    json_path = anno_dir / f"{image_id}.json"
    
    try:
        if not json_path.exists():
            raise HTTPException(status_code=404, detail="データが見つかりません")
        
        with open(json_path, 'r', encoding='utf-8') as f:
            annotation_data = json.load(f)
        
        image_annotation = ImageAnnotation(**annotation_data)
        
        anno_dict = {anno.id: anno for anno in image_annotation.annotations}
        new_annotations = []
        for i, anno_id in enumerate(request.annotation_ids):
            if anno_id in anno_dict:
                anno = anno_dict[anno_id]
                anno.order = i + 1
                new_annotations.append(anno)
        
        request_ids_set = set(request.annotation_ids)
        for anno in image_annotation.annotations:
            if anno.id not in request_ids_set:
                anno.order = len(new_annotations) + 1
                new_annotations.append(anno)
        
        image_annotation.annotations = new_annotations
        
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(image_annotation.model_dump(), f, ensure_ascii=False, indent=2)
        
        return {"message": "順番を更新しました", "count": len(new_annotations)}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/annotations/{image_id}/{annotation_id}")
async def update_annotation(image_id: str, annotation_id: str, updated_data: AnnotationCreate, user: dict = Depends(get_current_user)):
    """アノテーションを更新"""
    img_dir, anno_dir = get_dirs(user)
    json_path = anno_dir / f"{image_id}.json"
    
    try:
        if not json_path.exists():
            raise HTTPException(status_code=404, detail="データが見つかりません")
            
        with open(json_path, 'r', encoding='utf-8') as f:
            annotation_data = json.load(f)
        
        image_annotation = ImageAnnotation(**annotation_data)
        
        target_annotation = None
        for anno in image_annotation.annotations:
            if anno.id == annotation_id:
                target_annotation = anno
                break
        
        if target_annotation is None:
            raise HTTPException(status_code=404, detail="アノテーションが見つかりません")
        
        bbox_rel = absolute_to_relative(
            updated_data.bbox_abs,
            image_annotation.image_size.width,
            image_annotation.image_size.height
        )
        
        target_annotation.type = updated_data.type
        target_annotation.order = updated_data.order
        target_annotation.bbox_abs = updated_data.bbox_abs
        target_annotation.bbox_rel = bbox_rel
        target_annotation.text = updated_data.text
        target_annotation.character_id = updated_data.character_id
        target_annotation.subtype = updated_data.subtype
        
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(image_annotation.model_dump(), f, ensure_ascii=False, indent=2)
        
        return target_annotation
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/annotations/{image_id}/summary")
async def update_page_summary(image_id: str, update: SummaryUpdate, user: dict = Depends(get_current_user)):
    """ページ全体の状況説明を更新"""
    img_dir, anno_dir = get_dirs(user)
    json_path = anno_dir / f"{image_id}.json"
    
    try:
        annotation_data = None
        if json_path.exists():
            with open(json_path, 'r', encoding='utf-8') as f:
                annotation_data = json.load(f)
        else:
            # ファイルがない場合は初期データを作成
            image_path = None
            image_filename = None
            for ext in ['.jpg', '.jpeg', '.png', '.webp']:
                p = img_dir / f"{image_id}{ext}"
                if p.exists():
                    image_path = p
                    image_filename = f"{image_id}{ext}"
                    break
            
            if not image_path:
                raise HTTPException(status_code=404, detail="画像が見つかりません")
            
            with Image.open(image_path) as img:
                width, height = img.size
                
            annotation_data = ImageAnnotation(
                image_id=image_id,
                image_filename=image_filename,
                image_size=ImageSize(width=width, height=height),
                page_summary="",
                annotations=[]
            ).model_dump()

        image_annotation = ImageAnnotation(**annotation_data)
        image_annotation.page_summary = update.page_summary
        
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(image_annotation.model_dump(), f, ensure_ascii=False, indent=2)
        
        return {"page_summary": image_annotation.page_summary}
    
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/annotations/{image_id}/status")
async def update_completion_status(image_id: str, update: StatusUpdate, user: dict = Depends(get_current_user)):
    """完了ステータスを更新"""
    img_dir, anno_dir = get_dirs(user)
    json_path = anno_dir / f"{image_id}.json"
    
    try:
        annotation_data = None
        if json_path.exists():
            with open(json_path, 'r', encoding='utf-8') as f:
                annotation_data = json.load(f)
        else:
            # ファイルがない場合は初期データを作成
            image_path = None
            image_filename = None
            for ext in ['.jpg', '.jpeg', '.png', '.webp']:
                p = img_dir / f"{image_id}{ext}"
                if p.exists():
                    image_path = p
                    image_filename = f"{image_id}{ext}"
                    break
            
            if not image_path:
                raise HTTPException(status_code=404, detail="画像が見つかりません")
            
            with Image.open(image_path) as img:
                width, height = img.size
                
            annotation_data = ImageAnnotation(
                image_id=image_id,
                image_filename=image_filename,
                image_size=ImageSize(width=width, height=height),
                page_summary="",
                annotations=[]
            ).model_dump()

        image_annotation = ImageAnnotation(**annotation_data)
        image_annotation.is_completed = update.is_completed
        
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(image_annotation.model_dump(), f, ensure_ascii=False, indent=2)
        
        return {"is_completed": image_annotation.is_completed}
    
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ocr")
async def perform_ocr(request: OCRRequest, user: dict = Depends(get_current_user)):
    """指定された範囲の画像を切り抜いてOCRを実行"""
    img_dir, _ = get_dirs(user)
    try:
        image_id = request.image_id
        
        image_path = None
        for ext in ['.jpg', '.jpeg', '.png', '.webp']:
            p = img_dir / f"{image_id}{ext}"
            if p.exists():
                image_path = p
                break
        
        if not image_path:
            raise HTTPException(status_code=404, detail="画像が見つかりません")
        
        with Image.open(image_path) as img:
            left = request.bbox_abs.x
            top = request.bbox_abs.y
            right = left + request.bbox_abs.width
            bottom = top + request.bbox_abs.height
            
            crop_img = img.crop((left, top, right, bottom))
            
            ocr_engine = get_mocr()
            text = ocr_engine(crop_img)
            
            return {"text": text}
            
    except Exception as e:
        print(f"OCR Error: {e}")
        raise HTTPException(status_code=500, detail=f"OCR実行中にエラーが発生しました: {str(e)}")


@app.post("/tagger")
async def perform_tagger(request: TaggerRequest, user: dict = Depends(get_current_user)):
    """指定された範囲の画像を切り抜いてWD Taggerでタグ付け"""
    img_dir, _ = get_dirs(user)
    try:
        import torch
        
        image_id = request.image_id
        
        image_path = None
        for ext in ['.jpg', '.jpeg', '.png', '.webp']:
            p = img_dir / f"{image_id}{ext}"
            if p.exists():
                image_path = p
                break
        
        if not image_path:
            raise HTTPException(status_code=404, detail="画像が見つかりません")
        
        with Image.open(image_path) as img:
            # RGB以外のモードをRGBに変換（RGBA、グレースケールなど）
            if img.mode != "RGB":
                img = img.convert("RGB")
            
            left = request.bbox_abs.x
            top = request.bbox_abs.y
            right = left + request.bbox_abs.width
            bottom = top + request.bbox_abs.height
            
            crop_img = img.crop((left, top, right, bottom))
            
            # デバッグ: 切り取った画像を保存（色合い確認用）
            debug_dir = Path(__file__).parent / "debug_crops"
            debug_dir.mkdir(exist_ok=True)
            crop_img.save(debug_dir / f"{image_id}_crop.png")
            
            # Tagger実行
            model, transform, labels, categories, orig_labels = get_tagger()
            
            # 前処理
            input_tensor = transform(crop_img).unsqueeze(0)
            if torch.cuda.is_available():
                input_tensor = input_tensor.cuda()
            
            # 推論
            with torch.no_grad():
                outputs = model(input_tensor)
                probs = torch.sigmoid(outputs).cpu().numpy()[0]
            
            # リクエストの閾値でフィルタしてタグ取得（デフォルトは設定値）
            threshold = request.threshold if request.threshold is not None else TAGGER_SETTINGS["tagger_threshold"]
            excluded_tags = [t.lower() for t in TAGGER_SETTINGS.get("excluded_tags", [])]
            
            # 表情関連タグのホワイトリストパターン (faceタイプ用)
            # Danbooruの表情・顔パーツタグリストに基づく
            expression_patterns = [
                # 1. 感情・表情 (Emotions & Expressions)
                # ポジティブ
                'smile', 'grin', 'laughing', 'happy', 'smug', 'doyagao', 'gentle_smile', 'excited', 'triumphant',
                # ネガティブ
                'angry', 'annoyed', 'frown', 'sad', 'crying', 'sobbing', 'tears', 'streaming_tears',
                'scared', 'terror', 'screaming', 'nervous', 'worried', 'depressed', 'gloom', 'despair',
                'serious', 'glare', 'scorn', 'disgust', 'pain',
                # ニュートラル・その他
                'expressionless', 'blank_stare', 'bored', 'sleepy', 'confused', 'surprised', 'shy',
                'embarrassed', 'flustered', 'drunk', 'crazy', 'insane', 'aroused', 'ahegao', 'torogao',
                'yandere', 'tsundere', 'kuudere',
                
                # 2. 顔の状態・漫符 (Face States & Effects)
                # 顔色・演出
                'blush', 'heavy_blush', 'light_blush', 'blush_stickers', 'blue_face', 'turned_pale',
                'shadowed_face', 'blood_on_face',
                # 漫符・記号
                'sweat', 'sweatdrop', 'flying_sweatdrops', 'anger_vein', 'popping_vein',
                'gloom_(expression)', 'sparkles', 'breath_puff', 'nose_bubble',
                # 分泌物・その他
                'drooling', 'saliva', 'nosebleed', 'tear_drop', 'bags_under_eyes',
                'cheek_press', 'makeup', 'facepaint',
                
                # 3. 目の状態 (Eye States)
                # 開閉・形状
                'closed_eyes', 'half-closed_eyes', 'squinting', 'narrowed_eyes', 'wide_eyed', 'wink',
                'one_eye_closed', 'forced_shut_eyes', 'tsurime', 'tareme', 'jitome', 'sanpaku',
                # 瞳孔・ハイライト
                'empty_eyes', 'hollow_eyes', 'button_eyes', 'constricted_pupils', 'dilated_pupils',
                'slit_pupils', 'heart-shaped_pupils', 'star-shaped_pupils', 'symbol-shaped_pupils',
                'mismatched_pupils', 'heterochromia', 'rolling_eyes', 'cross-eyed', 'no_pupils',
                # 視線
                'looking_at_viewer', 'looking_away', 'looking_back', 'looking_down', 'looking_up',
                'looking_to_the_side', 'eye_contact',
                
                # 4. 口の状態 (Mouth States)
                # 開閉・基本
                'open_mouth', 'closed_mouth', 'parted_lips', 'wide_mouth', 'pout', 'puffy_cheeks',
                'grimace', 'lip_biting', 'holding_breath',
                # 歯・舌
                'clenched_teeth', 'showing_teeth', 'skin_fang', 'fang', 'sharp_teeth', 'shark_teeth',
                'buck_teeth', 'tongue', 'tongue_out', 'licking_lips', 'forked_tongue',
                # 形状・記号
                'cat_mouth', ':3', 'triangle_mouth', 'wavy_mouth', 'dot_mouth', 'shark_mouth',
                
                # 5. 顔文字・アスキーアートタグ (Kaomoji)
                '^_^', '>_<', '@_@', '+_+', '=_=', 'o_o', '3_3', ';)', ':d', ':p', ':o',

                # 6. 性的な表情・状態 (NSFW / Sexual Expressions & States)
                'ahegao', 'torogao', 'orgasm_face', 'ecstasy', 'aroused',
                'cum_on_face', 'ejaculated_on_face', 'cum_in_mouth', 'cum_on_tongue', 'facial', 'bukkake',
                'cum_strings', 'cum_drip', 'saliva_strings',
                'fellatio', 'deep_throat', 'blowjob', 'oral',
                'gag', 'gagged', 'bit_gag', 'ball_gag', 'cleave_gag', 'ring_gag', 'spider_gag', 'tape_gag', 'hair_gag',
                'collar', 'leash', 'neck_bell', 'neck_bolt', 'blindfold', 'eye_mask', 'nose_hook', 'mouth_mask',
                'nuzzle', 'kiss', 'kissing', 'hickey', 'neck_kiss', 'cum_in_eye', 'cum_on_hair',
            ]
            
            def is_expression_tag(tag_name):
                tag_lower = tag_name.lower()
                return any(pattern in tag_lower for pattern in expression_patterns)
            
            raw_tags = []
            for i, prob in enumerate(probs):
                if prob >= threshold:
                    tag_name = labels[i]
                    # フィルタリング判定には元の英名を使用する（あれば）
                    filtering_name = orig_labels[i] if orig_labels else tag_name
                    category = categories[i] if categories else 0
                    
                    # 除外タグリストにあるかチェック
                    if filtering_name.lower() in excluded_tags or tag_name.lower() in excluded_tags:
                        continue

                    # キャラクタータグ（カテゴリ4）を除外
                    if category == 4:
                        continue
                    
                    # faceタイプの場合：表情関連タグのみ許可（ホワイトリスト方式）
                    if request.annotation_type == 'face':
                        if not is_expression_tag(filtering_name):
                            continue
            
                    raw_tags.append({
                        "tag": tag_name, # 表示・保存用（日本語または元の名前）
                        "confidence": float(prob),
                        "category": category,
                        "orig_tag": filtering_name # 内部参照用（英名）
                    })
            
            # ソートロジック
            # 1. カテゴリ9 (Rating: general/sensitive) を最優先
            # 2. 1girl/solo/monochrome などの基本構造タグ (Generalカテゴリだが重要)
            # 3. その他は信頼度順
            
            priority_tags = {'1girl', '1boy', 'solo', 'monochrome', 'greyscale'}
            
            def sort_key(x):
                # Rating category (9) is usually highest priority for "Large tags"
                is_rating = (x["category"] == 9)
                # orig_tag（英名）で判定する
                is_priority = (x.get("orig_tag", x["tag"]) in priority_tags)
                
                # キーのタプルを作成 (Rating優先, Priority優先, その後信頼度)
                # Trueは1, Falseは0なので、降順(-1)にするには注意
                # sortは昇順なので、優先したいものを小さくする
                
                k1 = 0 if is_rating else 1
                k2 = 0 if is_priority else 1
                k3 = -x["confidence"] # 信頼度が高い順
                
                return (k1, k2, k3)

            raw_tags.sort(key=sort_key)
            
            # 重複タグの排除（同じ日本語名のタグは、信頼度が高い方のみ残す）
            seen_tags = {}
            deduplicated_tags = []
            for t in raw_tags:
                tag_name = t["tag"]
                if tag_name not in seen_tags:
                    seen_tags[tag_name] = t
                    deduplicated_tags.append(t)
                else:
                    # 既に存在する場合、信頼度が高い方を保持
                    if t["confidence"] > seen_tags[tag_name]["confidence"]:
                        # 既存のものを削除して新しいものを追加
                        deduplicated_tags.remove(seen_tags[tag_name])
                        seen_tags[tag_name] = t
                        deduplicated_tags.append(t)
            
            # タグ名をカンマ区切りで結合（text用）
            tag_text = ", ".join([t["tag"] for t in deduplicated_tags])
            
            # レスポンス用には不要なフィールドを除く（必要なら）
            # ここではそのまま返す
            tags_response = [{"tag": t["tag"], "confidence": t["confidence"]} for t in deduplicated_tags]
            
            return {
                "text": tag_text,
                "tags": tags_response
            }
            
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Tagger Error: {e}")
        raise HTTPException(status_code=500, detail=f"Tagger実行中にエラーが発生しました: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
