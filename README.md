# 漫画アノテーションツール

Qwen3-VLのファインチューニング用に、漫画画像からアノテーションデータを作成するWebツールです。

## 機能

- 📤 画像アップロード（自動連番リネーム: 00001.jpg, 00002.jpg...）
- 🖱️ マウスドラッグによる矩形選択
- ✏️ アノテーション入力
  - コマ読み順
  - テキストタイプ（セリフ/モノローグ/ナレーション/ルビ）
  - テキスト内容
  - キャラクターID（オプション）
- 📊 絶対座標・相対座標の両方を保存
- 💾 JSON形式でエクスポート
- ✅ アノテーションの編集・削除

## セットアップ

### 1. 依存関係のインストール

```bash
cd backend
pip install -r requirements.txt
```

### 2. 環境設定

`backend/.env.example` を `backend/.env` にコピーし、必要に応じて設定を変更してください。

```bash
cp backend/.env.example backend/.env
```

### 3. サーバーの起動

```bash
cd backend
python main.py
```

サーバーは `http://localhost:8000` で起動します。

### 4. ブラウザでアクセス

ブラウザで `http://localhost:8000` を開いてください。
※外部ネットワーク（非localhost）からアクセスする場合は、設定した `GUEST_PASSWORD` によるログインが必要です。

## 使い方

1. **画像をアップロード**: 「画像をアップロード」ボタンをクリックして漫画画像を選択
2. **範囲を選択**: マウスドラッグで矩形を描画
3. **アノテーション入力**: 
   - コマ読み順（1, 2, 3...）
   - テキストタイプを選択
   - テキスト内容を入力
   - 必要に応じてキャラクターIDを入力
4. **保存**: 「アノテーションを保存」ボタンをクリック
5. **繰り返し**: 同じ画像の他の部分をアノテーション
6. **エクスポート**: 「JSONをエクスポート」ボタンでデータをダウンロード

## データ構造

```json
{
  "image_id": "00001",
  "image_filename": "00001.jpg",
  "image_size": {
    "width": 1920,
    "height": 1080
  },
  "annotations": [
    {
      "id": "anno_abc123",
      "type": "dialogue",
      "order": 1,
      "bbox_abs": {
        "x": 100,
        "y": 50,
        "width": 300,
        "height": 150
      },
      "bbox_rel": {
        "x": 0.052,
        "y": 0.046,
        "width": 0.156,
        "height": 0.139
      },
      "text": "おはよう!",
      "character_id": "char_001"
    }
  ]
}
```

## ルビの入力方法

ルビはHTML形式で入力してください:

```html
<ruby>漫画<rt>まんが</rt></ruby>
```

## ディレクトリ構造

```
manga-ocr/
├── backend/
│   ├── main.py              # FastAPI アプリ
│   ├── models.py            # データモデル
│   ├── utils.py             # ユーティリティ
│   ├── selected_tags_ja.csv # タグリスト
│   ├── .env.example         # 環境変数テンプレート
│   └── requirements.txt
├── frontend/
│   ├── index.html           # エディター画面
│   ├── viewer.html          # ビューアー画面
│   ├── style.css
│   ├── app.js
│   └── viewer.js
├── tools/                   # ユーティリティスクリプト
│   └── analyze_tags.py
├── data/                    # アノテーションデータ（gitignore対象）
│   ├── images/              # 画像ファイル
│   └── annotations/         # JSONファイル
├── LICENSE                  # MIT License
└── README.md
```

## WD-Tagger 日本語翻訳データ

[backend/selected_tags_ja.csv](backend/selected_tags_ja.csv) は、Danbooruのタグセットを日本語に翻訳したデータです。WD-Tagger 等の出力結果（英語タグ）を日本語に変換する用途などで活用いただけます。

### 日本語変換サンプルコード (Python)

```python
import pandas as pd

# 翻訳データの読み込み
tags_df = pd.read_csv('backend/selected_tags_ja.csv')
tag_map = dict(zip(tags_df['tag'], tags_df['name_ja']))

# 変換例
english_tags = ['1girl', 'solo', 'long_hair']
japanese_tags = [tag_map.get(tag, tag) for tag in english_tags]

print(japanese_tags) # ['1人', 'ソロ', 'ロングヘア']
```

## 技術スタック

- **Backend**: FastAPI, Python 3.8+
- **Frontend**: Vanilla JavaScript, HTML5 Canvas
- **Data Format**: JSON

## ライセンス

[MIT License](LICENSE)

---
Developed with [Antigravity](https://github.com/google-deepmind/antigravity) by Google DeepMind.
