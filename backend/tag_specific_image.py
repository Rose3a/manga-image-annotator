import torch
from PIL import Image
from pathlib import Path
import timm
from timm.data import resolve_data_config, create_transform
from huggingface_hub import hf_hub_download
import csv
import os

# WD Tagger の設定
TAGGER_THRESHOLD = 0.6
MODEL_ID = "SmilingWolf/wd-vit-large-tagger-v3"

def initialize_tagger():
    print("Initializing WD Tagger...")
    
    # モデルロード
    model = timm.create_model(f"hf_hub:{MODEL_ID}", pretrained=True)
    model.eval()
    
    # GPU利用可能ならGPUへ
    if torch.cuda.is_available():
        model = model.cuda()
        print("WD Tagger: Using CUDA")
    else:
        print("WD Tagger: Using CPU")
    
    # 前処理用transform
    config = resolve_data_config(model.pretrained_cfg)
    transform = create_transform(**config)
    
    # ラベルファイル取得 (ローカルの日本語版があれば優先)
    backend_dir = Path(__file__).parent
    local_label_path = backend_dir / "selected_tags_ja.csv"
    
    orig_labels = None
    
    if local_label_path.exists():
        print(f"Loading local Japanese tag labels from {local_label_path}")
        with open(local_label_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            labels = [row["name"] for row in rows]
            categories = [int(row.get("category", 0)) for row in rows]
            if "original_en" in rows[0]:
                orig_labels = [row["original_en"] for row in rows]
    else:
        print(f"Downloading labels from Hugging Face...")
        label_path = hf_hub_download(repo_id=MODEL_ID, filename="selected_tags.csv")
        with open(label_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            labels = [row["name"] for row in rows]
            categories = [int(row.get("category", 0)) for row in rows]
    
    return model, transform, labels, categories, orig_labels

def main():
    # 画像パス
    image_path = Path(__file__).parent / "debug_crops" / "2019047188429688834_crop.png"
    
    if not image_path.exists():
        print(f"Error: Image not found at {image_path}")
        return

    # Taggerの初期化
    model, transform, labels, categories, orig_labels = initialize_tagger()
    
    # 画像の読み込みと変換
    img = Image.open(image_path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    
    # 前処理
    input_tensor = transform(img).unsqueeze(0)
    if torch.cuda.is_available():
        input_tensor = input_tensor.cuda()
    
    # 推論
    print(f"Tagging image: {image_path.name}")
    with torch.no_grad():
        outputs = model(input_tensor)
        probs = torch.sigmoid(outputs).cpu().numpy()[0]
    
    # タグの抽出
    detected_tags = []
    for i, prob in enumerate(probs):
        if prob >= TAGGER_THRESHOLD:
            tag_name = labels[i]
            filtering_name = orig_labels[i] if orig_labels else tag_name
            category = categories[i] if categories else 0
            
            # キャラクタータグ（カテゴリ4）を除外
            if category == 4:
                continue
                
            detected_tags.append({
                "tag": tag_name,
                "confidence": float(prob),
                "category": category,
                "orig_tag": filtering_name
            })
    
    # ソート (Rating優先, その他信頼度順)
    priority_tags = {'1girl', '1boy', 'solo', 'monochrome', 'greyscale'}
    def sort_key(x):
        is_rating = (x["category"] == 9)
        is_priority = (x.get("orig_tag", x["tag"]) in priority_tags)
        k1 = 0 if is_rating else 1
        k2 = 0 if is_priority else 1
        k3 = -x["confidence"]
        return (k1, k2, k3)
    
    detected_tags.sort(key=sort_key)
    
    # 結果の表示
    print("\n--- Detected Tags ---")
    for t in detected_tags:
        print(f"{t['tag']} (Confidence: {t['confidence']:.4f}, Category: {t['category']})")

if __name__ == "__main__":
    main()
