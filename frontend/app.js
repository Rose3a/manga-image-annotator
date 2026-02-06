// グローバル変数
let currentImageId = null;
let currentImageSize = { width: 0, height: 0 };
let canvas = null;
let ctx = null;
let isDrawing = false;
let startX = 0;
let startY = 0;
let currentRect = null;
let annotations = [];
let loadedImage = null; // キャッシュ用画像オブジェクト

// API Base URL (動的に構築)
const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || (window.location.protocol === 'https:' ? '443' : '80')}`;

// 使用済みのキャラクターリスト
let usedCharacters = new Set();

// 認証ヘッダー取得
function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('manga_ocr_token');
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

// 認証エラーハンドリング
async function handleResponse(response) {
    if (response.status === 401) {
        // 未認証またはトークン無効
        window.location.href = '/login';
        throw new Error('認証が必要です');
    }
    return response;
}

// ユーザー権限チェック
async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/me`, {
            headers: getAuthHeaders()
        });

        if (response.status === 401) {
            // 未認証ならリダイレクト
            window.location.href = '/login';
            return;
        }

        if (response.ok) {
            const user = await response.json();
            console.log('User Role:', user.role);

            const panel = document.getElementById('adminPanel');
            const adminGuide = document.getElementById('adminGuide');
            const uploadSection = document.getElementById('uploadSection');
            const imageListSection = document.getElementById('imageListSection');

            if (user.role === 'admin') {
                if (panel) {
                    panel.style.display = 'block';
                    const port = window.location.port;
                    document.getElementById('guestUrlDisplay').textContent =
                        `http://[PCのIPアドレス]:${port}/login`;
                }
                if (adminGuide) adminGuide.style.display = 'block';
                if (uploadSection) uploadSection.style.display = 'block';
                if (imageListSection) imageListSection.style.display = 'none';
            } else {
                // Guest
                if (panel) panel.style.display = 'none';
                if (adminGuide) adminGuide.style.display = 'none';
                if (uploadSection) uploadSection.style.display = 'none';
                if (imageListSection) {
                    imageListSection.style.display = 'block';
                    loadImageList(); // ゲスト用画像リストを読み込む
                }
            }
        }
    } catch (e) {
        console.error('Auth check error:', e);
    }
}

// OTP生成削除済み

// 画像リストを読み込む (ゲスト用)
async function loadImageList() {
    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations-list`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) throw new Error('Failed to load image list');

        const data = await response.json();
        const selector = document.getElementById('imageSelector');

        // 既存のオプションをクリア（最初のプレースホルダーは残す）
        selector.innerHTML = '<option value="">-- 画像を選択してください --</option>';

        if (data.images && data.images.length > 0) {
            // 数値として正しくソート (1, 2, 3, ... 10, 11 の順)
            data.images.sort((a, b) => {
                const numA = parseInt(a.id) || 0;
                const numB = parseInt(b.id) || 0;
                return numA - numB;
            });

            data.images.forEach(img => {
                const option = document.createElement('option');
                option.value = img.id;
                option.textContent = img.id + (img.is_completed ? ' ✓' : '');
                selector.appendChild(option);
            });

            // 選択イベントリスナーを追加
            selector.onchange = (e) => {
                if (e.target.value) {
                    selectImageFromList(e.target.value);
                }
            };
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '画像がありません';
            option.disabled = true;
            selector.appendChild(option);
        }
    } catch (error) {
        console.error('Image list load error:', error);
        showToast('画像リストの読み込みに失敗しました', true);
    }
}

// order番号の欠番を自動で詰める関数
async function compactOrderNumbers() {
    if (!annotations || annotations.length === 0) return;

    // orderでソート
    const sorted = [...annotations].sort((a, b) => a.order - b.order);

    // ユニークなorder値を取得
    const uniqueOrders = [...new Set(sorted.map(a => a.order))].sort((a, b) => a - b);

    // 欠番があるかチェック（1から連続しているか）
    let hasGaps = false;
    for (let i = 0; i < uniqueOrders.length; i++) {
        if (uniqueOrders[i] !== i + 1) {
            hasGaps = true;
            break;
        }
    }

    // 欠番がなければ何もしない
    if (!hasGaps) return;

    // 古いorderから新しいorderへのマッピングを作成
    const orderMap = {};
    uniqueOrders.forEach((oldOrder, index) => {
        orderMap[oldOrder] = index + 1; // 1から始まる連番
    });

    // 各アノテーションのorderを更新
    let updated = false;
    for (const anno of annotations) {
        const newOrder = orderMap[anno.order];
        if (newOrder !== anno.order) {
            anno.order = newOrder;
            // バックエンドに保存
            await fetch(`${API_BASE}/annotations/${currentImageId}/${anno.id}`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify(anno)
            });
            updated = true;
        }
    }

    // 更新があった場合はログ出力
    if (updated) {
        console.log('Order numbers compacted:', orderMap);
    }
}

// リストから画像を選択
async function selectImageFromList(imageId) {
    try {
        // アノテーションデータを取得
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${imageId}`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) throw new Error('Failed to load annotations');

        const data = await response.json();

        // グローバル変数を更新
        currentImageId = data.image_id;
        currentImageSize = data.image_size;
        annotations = data.annotations || [];

        // order番号の欠番を自動で詰める処理
        await compactOrderNumbers();

        // 画像を読み込む
        loadImage(data.image_filename);

        // UI更新
        document.getElementById('imageInfo').textContent =
            `画像ID: ${data.image_id} | サイズ: ${data.image_size.width}x${data.image_size.height}`;
        document.getElementById('placeholderText').style.display = 'none';

        // アノテーション一覧を表示
        displayAnnotations();

        // ページサマリーを表示
        document.getElementById('pageSummaryInput').value = data.page_summary || '';

        showToast(`画像 ${imageId} を読み込みました`);
    } catch (error) {
        console.error('Image selection error:', error);
        showToast('画像の読み込みに失敗しました', true);
    }
}

// 認証付きで画像を取得
async function authFetchImage(filename) {
    const response = await handleResponse(await fetch(`${API_BASE}/images/${filename}`, {
        headers: getAuthHeaders()
    }));
    if (!response.ok) throw new Error('Image load failed');
    const blob = await response.blob();
    return URL.createObjectURL(blob);
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('imageCanvas');
    ctx = canvas.getContext('2d');

    // イベントリスナーの設定
    document.getElementById('imageUpload').addEventListener('change', uploadImage);
    document.getElementById('uploadBtn').addEventListener('click', uploadImage);
    document.getElementById('saveAnnotationBtn').addEventListener('click', saveAnnotation);
    document.getElementById('clearSelectionBtn').addEventListener('click', clearSelection);
    document.getElementById('saveSummaryBtn').addEventListener('click', savePageSummary);
    document.getElementById('exportJsonBtn').addEventListener('click', exportJson);
    document.getElementById('rubyHelperBtn').addEventListener('click', insertRubyTemplate);

    // 設定関連
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('closeSettings').addEventListener('click', closeSettings);
    document.getElementById('cancelSettingsBtn').addEventListener('click', closeSettings);
    document.getElementById('saveSettingsBtn').addEventListener('click', saveGlobalSettings);
    document.getElementById('settingThreshold').addEventListener('input', (e) => {
        document.getElementById('thresholdValue').textContent = parseFloat(e.target.value).toFixed(2);
    });

    document.getElementById('manualOCRBtn').addEventListener('click', () => {
        if (currentRect) runOCR(currentRect);
    });
    document.getElementById('manualTaggerBtn').addEventListener('click', () => {
        if (currentRect) runTagger(currentRect);
    });

    // OTP生成ボタン (存在確認)
    const otpBtn = document.getElementById('generateOtpBtn');
    if (otpBtn) {
        otpBtn.addEventListener('click', generateOtp);
    }

    // 特殊文字ボタン
    document.querySelectorAll('.char-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.id === 'bracket-btn') {
                insertBrackets();
            } else if (btn.id === 'bouten-btn') {
                insertBouten();
            } else {
                insertSpecialChar(btn.dataset.char);
            }
        });
    });

    // 三点リーダー変換
    const textInput = document.getElementById('textInput');
    textInput.addEventListener('input', (e) => {
        const value = e.target.value;
        const newValue = value.replace(/\.\.\.|．．．/g, '…');
        if (value !== newValue) {
            const start = e.target.selectionStart;
            const end = e.target.selectionEnd;
            const diff = value.length - newValue.length;
            e.target.value = newValue;
            e.target.setSelectionRange(start - diff, end - diff);
        }
    });

    // Canvas イベント
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseleave', stopDrawing);

    // ドラッグ&ドロップイベント
    const imageContainer = document.getElementById('imageContainer');
    imageContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        imageContainer.classList.add('drag-over');
    });
    imageContainer.addEventListener('dragleave', () => {
        imageContainer.classList.remove('drag-over');
    });
    imageContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        imageContainer.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            uploadImage(file);
        }
    });

    // テキストタイプ変更時のサブタイプ表示制御
    const typeSelect = document.getElementById('typeSelect');
    const subtypeGroup = document.getElementById('subtypeGroup');
    typeSelect.addEventListener('change', () => {
        if (typeSelect.value === 'body_part') {
            subtypeGroup.style.display = 'block';
        } else {
            subtypeGroup.style.display = 'none';
        }
    });

    // 認証チェック
    checkAuth();
});

// 画像アップロード
async function uploadImage(fileOrEvent) {
    let file;
    if (fileOrEvent instanceof File) {
        file = fileOrEvent;
    } else {
        const fileInput = document.getElementById('imageUpload');
        file = fileInput.files[0];
    }

    if (!file) {
        // もしイベントから呼ばれてファイルもなければ（ボタン押しのみなど）
        if (!(fileOrEvent instanceof File)) {
            alert('画像ファイルを選択してください');
        }
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            headers: {
                'Authorization': getAuthHeaders()['Authorization']
            },
            body: formData
        }));

        if (!response.ok) {
            if (response.status === 403) throw new Error('ゲストは画像をアップロードできません');
            throw new Error('アップロードに失敗しました');
        }

        const data = await response.json();
        currentImageId = data.image_id;
        currentImageSize = data.image_size;

        // 画像を表示
        loadImage(data.image_filename);

        // UI更新
        document.getElementById('imageInfo').textContent =
            `画像ID: ${data.image_id} | サイズ: ${data.image_size.width}x${data.image_size.height}`;
        document.getElementById('placeholderText').style.display = 'none';

        // アノテーションをロード
        loadAnnotations(currentImageId); // Pass currentImageId
        showToast('画像を読み込みました');

    } catch (error) {
        showToast('エラー: ' + error.message, true);
    }
}

// 画像を読み込んでCanvasに表示
function loadImage(filename) {
    const img = new Image();
    authFetchImage(filename).then(url => {
        img.onload = () => {
            loadedImage = img; // 画像をキャッシュ
            canvas.width = img.width;
            canvas.height = img.height;
            redrawCanvas();
            canvas.style.display = 'block';
            URL.revokeObjectURL(url); // メモリ解放
        };
        img.src = url;
    }).catch(err => {
        showToast('画像の読み込みに失敗しました', true);
        console.error(err);
    });
}

// 矩形描画開始
function startDrawing(e) {
    if (!currentImageId) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;
    isDrawing = true;
}

// 矩形描画中
function draw(e) {
    if (!isDrawing) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const currentX = (e.clientX - rect.left) * scaleX;
    const currentY = (e.clientY - rect.top) * scaleY;

    // Canvasを再描画
    redrawCanvas();

    // 現在の矩形を描画
    ctx.strokeStyle = '#667eea';
    ctx.lineWidth = 3;
    ctx.strokeRect(startX, startY, currentX - startX, currentY - startY);

    // 半透明の塗りつぶし (不透明度を上げる)
    ctx.fillStyle = 'rgba(102, 126, 234, 0.7)';
    ctx.fillRect(startX, startY, currentX - startX, currentY - startY);
}

// 矩形描画終了
function stopDrawing(e) {
    if (!isDrawing) return;
    isDrawing = false;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const endX = (e.clientX - rect.left) * scaleX;
    const endY = (e.clientY - rect.top) * scaleY;

    // 矩形情報を保存
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    if (width > 5 && height > 5) {
        currentRect = { x, y, width, height };
        updateBboxDisplay();
        document.getElementById('saveAnnotationBtn').disabled = false;
        document.getElementById('manualOCRBtn').disabled = false;
        document.getElementById('manualTaggerBtn').disabled = false;

        // 矩形完成後の自動実行
        const typeSelect = document.getElementById('typeSelect');
        const selectedType = typeSelect.value;

        // face (顔), person (人物), body_part (部位), object (物体) の場合はTaggerを自動実行
        if (['face', 'person', 'body_part', 'object'].includes(selectedType)) {
            runTagger(currentRect);
        }
        else {
            // その他のテキストタイプはOCR
            runOCR(currentRect);
        }
    }
}

// OCRを実行
async function runOCR(bbox) {
    if (!currentImageId) return;

    const textInput = document.getElementById('textInput');
    const originalPlaceholder = textInput.placeholder;

    textInput.disabled = true;
    textInput.placeholder = 'OCR実行中...';
    textInput.value = '';

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/ocr`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_id: currentImageId,
                bbox_abs: bbox
            })
        }));

        if (!response.ok) throw new Error('OCRリクエストに失敗しました');

        const data = await response.json();
        textInput.value = data.text;

    } catch (error) {
        console.error('OCR Error:', error);
        textInput.placeholder = 'OCRに失敗しました。手動で入力してください。';
    } finally {
        textInput.disabled = false;
        textInput.placeholder = originalPlaceholder;
        textInput.focus();
    }
}

// Taggerを実行（顔・人物タイプ用）
async function runTagger(bbox) {
    if (!currentImageId) return;

    const textInput = document.getElementById('textInput');
    const originalPlaceholder = textInput.placeholder;

    textInput.disabled = true;
    textInput.placeholder = 'タグ生成中...';
    textInput.value = '';

    try {
        const typeSelect = document.getElementById('typeSelect');
        const selectedType = typeSelect.value;

        const response = await handleResponse(await fetch(`${API_BASE}/tagger`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_id: currentImageId,
                bbox_abs: bbox,
                threshold: 0.6,
                annotation_type: selectedType
            })
        }));

        if (!response.ok) throw new Error('タグ生成リクエストに失敗しました');

        const data = await response.json();
        textInput.value = data.text || '';

    } catch (error) {
        console.error('Tagger Error:', error);
        textInput.placeholder = 'タグ生成に失敗しました。手動で入力してください。';
    } finally {
        textInput.disabled = false;
        textInput.placeholder = originalPlaceholder;
        textInput.focus();
    }
}

// Canvasを再描画 (同期的に行う)
function redrawCanvas() {
    if (!loadedImage) return;

    // Canvasをクリア
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // キャッシュされた画像を描画
    ctx.drawImage(loadedImage, 0, 0);

    // 既存のアノテーションを描画
    annotations.forEach((anno) => {
        ctx.strokeStyle = getTypeColor(anno.type);
        ctx.lineWidth = 3;
        ctx.strokeRect(anno.bbox_abs.x, anno.bbox_abs.y, anno.bbox_abs.width, anno.bbox_abs.height);

        // 順番を表示（グループ化対応）
        // 同じorderを持つアノテーションがある場合はサブ番号を表示
        let labelText = anno.order.toString();

        // 同じorderのアノテーションを抽出してソート
        const sameOrderAnnos = annotations
            .filter(a => a.order === anno.order)
            .sort((a, b) => a.id.localeCompare(b.id));

        // 2つ以上あればサブ番号を追加
        if (sameOrderAnnos.length > 1) {
            const subIndex = sameOrderAnnos.findIndex(a => a.id === anno.id) + 1;
            labelText = `${anno.order}-${subIndex}`;
        }

        const fontSize = Math.max(24, Math.round(canvas.height / 40));
        ctx.font = `bold ${fontSize}px Arial`;

        const metrics = ctx.measureText(labelText);
        const labelWidth = metrics.width + (fontSize * 0.25);
        const labelHeight = fontSize * 1.1;

        // 透明度を設定 (60%不透明)
        ctx.globalAlpha = 0.6;

        // ラベル背景 (枠内の左上)
        ctx.fillStyle = getTypeColor(anno.type);
        ctx.fillRect(anno.bbox_abs.x, anno.bbox_abs.y, labelWidth, labelHeight);

        // ラベル文字
        ctx.fillStyle = 'white';
        ctx.fillText(labelText, anno.bbox_abs.x + (fontSize * 0.1), anno.bbox_abs.y + (fontSize * 0.9));

        // 透明度を戻す
        ctx.globalAlpha = 1.0;
    });
}

// タイプ別の色を取得
function getTypeColor(type) {
    const colors = {
        'dialogue': '#48bb78',
        'monologue': '#4299e1',
        'whisper': '#a0aec0',
        'narration': '#ecc94b',
        'sound_effect': '#f56565',
        'ruby': '#ed64a6',
        'footnote': '#9f7aea',
        'title': '#ed8936',
        'person': '#38b2ac',
        'face': '#f6ad55',
        'body_part': '#e53e3e'
    };
    return colors[type] || '#48bb78';
}

// バウンディングボックス表示を更新
function updateBboxDisplay() {
    if (!currentRect) return;

    const display = `
        X: ${Math.round(currentRect.x)}px, 
        Y: ${Math.round(currentRect.y)}px, 
        幅: ${Math.round(currentRect.width)}px, 
        高さ: ${Math.round(currentRect.height)}px
    `;
    document.getElementById('bboxDisplay').textContent = display;
}

// アノテーションを保存
async function saveAnnotation() {
    if (!currentRect || !currentImageId) return;

    const type = document.getElementById('typeSelect').value;
    let text = formatTextForSave(document.getElementById('textInput').value);

    // 擬音かつテキスト空欄なら自動補完
    if (type === 'sound_effect' && (!text || text.trim() === '')) {
        text = '(擬音)';
    }

    const subtypeEl = document.getElementById('subtypeSelect');
    const annotationData = {
        image_id: currentImageId,
        type: type,
        subtype: (type === 'body_part' && subtypeEl) ? subtypeEl.value : null,
        order: parseInt(document.getElementById('orderInput').value),
        bbox_abs: currentRect,
        text: text,
        character_id: document.getElementById('characterInput').value || null
    };

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(annotationData)
        }));

        if (!response.ok) throw new Error('保存に失敗しました');

        // フォームをクリア
        clearSelection();
        document.getElementById('textInput').value = '';
        document.getElementById('characterInput').value = '';
        document.getElementById('orderInput').value = parseInt(document.getElementById('orderInput').value) + 1;

        // アノテーションを再読み込み
        loadAnnotations();

        // キャラクターリストを更新
        if (annotationData.character_id) {
            updateCharacterList(annotationData.character_id);
        }

        showToast('保存しました');

    } catch (error) {
        showToast('エラー: ' + error.message, true);
    }
}

// アノテーション一覧を読み込み
async function loadAnnotations() {
    if (!currentImageId) return;

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) throw new Error('読み込みに失敗しました');

        const data = await response.json();
        annotations = data.annotations || [];
        const pageSummary = data.page_summary || "";

        // ページサマリーを表示
        document.getElementById('pageSummaryInput').value = pageSummary;

        displayAnnotations();
        redrawCanvas();

        // エクスポートボタンを有効化
        document.getElementById('exportJsonBtn').disabled = annotations.length === 0;

    } catch (error) {
        console.error('アノテーション読み込みエラー:', error);
    }
}

function displayAnnotations() {
    const listContainer = document.getElementById('annotationsList');

    if (annotations.length === 0) {
        listContainer.innerHTML = '<p style="color: #999;">アノテーションがありません</p>';
        return;
    }

    listContainer.innerHTML = annotations.map((anno, index) => `
        <div class="annotation-item">
            <div class="annotation-item-header">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-weight: 700; color: #f1f5f9;">#</span>
                    <input type="number" class="order-input-mini" value="${anno.order}" min="1" max="${annotations.length}" 
                        onchange="changeOrder(${index}, this.value)">
                    <span class="annotation-item-title" style="margin-left: 4px;">
                        - ${getTypeLabel(anno.type)}${anno.subtype ? ` (${getSubtypeLabel(anno.subtype)})` : ''}
                    </span>
                    <div class="reorder-btns">
                        <button class="btn-reorder" onclick="moveAnnotation(${index}, -1)" ${index === 0 ? 'disabled' : ''}>↑</button>
                        <button class="btn-reorder" onclick="moveAnnotation(${index}, 1)" ${index === annotations.length - 1 ? 'disabled' : ''}>↓</button>
                    </div>
                </div>
                <button class="btn btn-danger" onclick="deleteAnnotation('${anno.id}')">削除</button>
            </div>
            <div class="annotation-item-content">
                ${anno.character_id ? `キャラ: ${escapeHtml(anno.character_id)}<br>` : ''}
                座標: (${Math.round(anno.bbox_abs.x)}, ${Math.round(anno.bbox_abs.y)}) 
                ${Math.round(anno.bbox_abs.width)}x${Math.round(anno.bbox_abs.height)}
            </div>
            <div class="annotation-item-text" data-id="${anno.id}"></div>
        </div>
    `).join('');

    // XSS対策: テキスト内容を安全にセット
    annotations.forEach(anno => {
        const textEl = listContainer.querySelector(`.annotation-item-text[data-id="${anno.id}"]`);
        if (textEl) {
            // ルビタグを含む可能性があるのでサニタイズして設定
            textEl.innerHTML = sanitizeRuby(anno.text || '');
        }
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m];
    });
}

// サニタイズ: <ruby>, <rt> 以外のタグを除去
function sanitizeRuby(html) {
    const div = document.createElement('div');
    // まずはテキストとして入れてから、許可されたタグだけを戻すような処理は難しいので、
    // 一旦innerHTMLに入れてから不許可タグを消す（スクリプト実行を防ぐため、挿入前に簡易チェックするか、DOMParserを使う）
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;

    const allowedTags = ['RUBY', 'RT'];

    const walk = (node) => {
        const children = Array.from(node.childNodes);
        children.forEach(child => {
            if (child.nodeType === 1) { // Element node
                if (!allowedTags.includes(child.tagName)) {
                    // タグをテキストとして置き換え
                    const textNode = document.createTextNode(child.outerHTML);
                    node.replaceChild(textNode, child);
                } else {
                    walk(child);
                }
            }
        });
    };

    walk(body);
    return body.innerHTML;
}

// 順序を直接変更
async function changeOrder(index, newOrder) {
    newOrder = parseInt(newOrder);
    if (isNaN(newOrder) || newOrder < 1) {
        displayAnnotations(); // 元に戻す
        return;
    }

    const newIndex = Math.min(Math.max(newOrder - 1, 0), annotations.length - 1);
    if (index === newIndex) return;

    // 配列内で要素を移動
    const [movedItem] = annotations.splice(index, 1);
    annotations.splice(newIndex, 0, movedItem);

    // orderプロパティを一括更新（1から開始）
    annotations.forEach((anno, i) => {
        anno.order = i + 1;
    });

    await saveOrder();
}

// アノテーションを移動（順序変更）
async function moveAnnotation(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= annotations.length) return;

    // 配列内で要素を入れ替え
    const temp = annotations[index];
    annotations[index] = annotations[newIndex];
    annotations[newIndex] = temp;

    // orderプロパティを更新
    annotations.forEach((anno, i) => {
        anno.order = i + 1;
    });

    await saveOrder();
}

// 現在の順序をサーバーに保存
async function saveOrder() {
    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}/reorder`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                annotation_ids: annotations.map(a => a.id)
            })
        }));

        if (!response.ok) throw new Error('順序の保存に失敗しました');

        // 表示を更新
        displayAnnotations();
        redrawCanvas();
        showToast('順序を更新しました');

    } catch (error) {
        showToast('エラー: ' + error.message, true);
        // 失敗した場合は再読み込みして元の状態に戻す
        loadAnnotations();
    }
}

// タイプラベルを取得
function getTypeLabel(type) {
    const labels = {
        'dialogue': 'セリフ',
        'monologue': 'モノローグ',
        'whisper': '小声',
        'narration': 'ナレーション',
        'sound_effect': '効果音',
        'ruby': 'ルビ',
        'footnote': '注釈 (※)',
        'title': 'タイトル',
        'person': '人物',
        'face': '顔',
        'body_part': '部位'
    };
    return labels[type] || type;
}

// サブタイプラベルを取得
function getSubtypeLabel(subtype) {
    const labels = {
        'penis': 'チンポ',
        'vagina': 'マンコ',
        'other': 'その他'
    };
    return labels[subtype] || subtype;
}

// アノテーションを削除
async function deleteAnnotation(annotationId) {
    if (!confirm('このアノテーションを削除しますか?')) return;

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}/${annotationId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        }));

        if (!response.ok) throw new Error('削除に失敗しました');

        loadAnnotations();
        showToast('削除しました');

    } catch (error) {
        showToast('エラー: ' + error.message, true);
    }
}

// 選択をクリア
function clearSelection() {
    currentRect = null;
    document.getElementById('bboxDisplay').textContent = 'マウスドラッグで範囲を選択してください';
    document.getElementById('saveAnnotationBtn').disabled = true;
    document.getElementById('manualOCRBtn').disabled = true;
    document.getElementById('manualTaggerBtn').disabled = true;
    redrawCanvas();
}

// JSONをエクスポート
async function exportJson() {
    if (!currentImageId) return;

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) throw new Error('データ取得に失敗しました');

        const data = await response.json();

        // JSONファイルとしてダウンロード
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentImageId}.json`;
        a.click();
        URL.revokeObjectURL(url);

    } catch (error) {
        alert('エラー: ' + error.message);
    }
}

// 特殊文字を挿入
function insertSpecialChar(char) {
    const textInput = document.getElementById('textInput');
    const startPos = textInput.selectionStart;
    const endPos = textInput.selectionEnd;

    const text = textInput.value;
    textInput.value = text.substring(0, startPos) + char + text.substring(endPos, text.length);

    textInput.focus();
    textInput.setSelectionRange(startPos + char.length, startPos + char.length);
}

// 括弧で囲む
function insertBrackets() {
    const textInput = document.getElementById('textInput');
    const startPos = textInput.selectionStart;
    const endPos = textInput.selectionEnd;
    const val = textInput.value;
    const selectedText = val.substring(startPos, endPos);

    const template = `（${selectedText}）`;
    textInput.value = val.substring(0, startPos) + template + val.substring(endPos, val.length);

    textInput.focus();
    if (selectedText) {
        // 括弧の後に移動
        textInput.setSelectionRange(startPos + template.length, startPos + template.length);
    } else {
        // 括弧の中に移動
        textInput.setSelectionRange(startPos + 1, startPos + 1);
    }
}

// ルビ記法を挿入 (|漢字{かんじ})
function insertRubyTemplate() {
    const textInput = document.getElementById('textInput');
    const startPos = textInput.selectionStart;
    const endPos = textInput.selectionEnd;
    const val = textInput.value;
    const selectedText = val.substring(startPos, endPos);

    // 選択範囲がある場合は |選択範囲{}
    // ない場合は |文字{るび}
    const template = selectedText ? `|${selectedText}{}` : '|文字{るび}';
    textInput.value = val.substring(0, startPos) + template + val.substring(endPos, val.length);

    textInput.focus();
    if (selectedText) {
        // {}の中にカーソルを移動 (templateの最後から1文字前)
        const newPos = startPos + template.length - 1;
        textInput.setSelectionRange(newPos, newPos);
    } else {
        // 「文字」を選択状態にする
        textInput.setSelectionRange(startPos + 1, startPos + 3);
    }
}

// 表示用に変換 (<ruby> -> {})
function formatTextForDisplay(text) {
    if (!text) return '';
    // 親文字に漢字以外が含まれる場合は | を付けて復元する
    return text.replace(/<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>/g, (match, parent, ruby) => {
        const hasNonKanji = /[^\u3400-\u9FFF\uF900-\uFAFF々〇〻]/.test(parent);
        return hasNonKanji ? `|${parent}{${ruby}}` : `${parent}{${ruby}}`;
    });
}

// 保存用に変換 ({} -> <ruby>)
function formatTextForSave(text) {
    if (!text) return '';

    // 1. パイプ記法を処理: |文字{るび} -> <ruby>文字<rt>るび</rt></ruby>
    let processed = text.replace(/[|｜]([^{}\s|｜]+)\{([^{}\s]*)\}/g, '<ruby>$1<rt>$2</rt></ruby>');

    // 2. 自動判定: 漢字の塊{るび} または 1文字{るび} -> <ruby>...<rt>...</rt></ruby>
    // [々〇〻\u3400-\u9FFF\uF900-\uFAFF] は漢字、々 など
    processed = processed.replace(/([々〇〻\u3400-\u9FFF\uF900-\uFAFF]+)\{([^{}\s]*)\}/g, '<ruby>$1<rt>$2</rt></ruby>');

    // 3. フォールバック: 残った {るび} の直前1文字をルビ対象にする
    processed = processed.replace(/(.)\{([^{}\s]*)\}/g, (match, char, ruby) => {
        if (char === '>') return match; // 既にrubyタグになっている場合はスキップ
        return `<ruby>${char}<rt>${ruby}</rt></ruby>`;
    });

    return processed;
}

// 通知を表示
function showToast(message, isError = false) {
    const notification = document.getElementById('statusNotification');
    notification.textContent = message;
    notification.style.display = 'block';

    if (isError) {
        notification.classList.add('error');
    } else {
        notification.classList.remove('error');
    }

    // 3秒後に消去
    setTimeout(() => {
        notification.style.display = 'none';
    }, 3000);
}

// キャラクター候補リストを更新
function updateCharacterList(name) {
    if (!name) return;
    usedCharacters.add(name);

    const datalist = document.getElementById('characterList');
    datalist.innerHTML = Array.from(usedCharacters).map(char =>
        `<option value="${char}">`
    ).join('');
}

// ページサマリーを保存
async function savePageSummary() {
    if (!currentImageId) return;

    const summary = document.getElementById('pageSummaryInput').value;

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}/summary`, {
            method: 'PATCH',
            headers: getAuthHeaders(),
            body: JSON.stringify({ page_summary: summary })
        }));

        if (response.ok) {
            showToast('ページ説明を保存しました');
        } else {
            showToast('保存に失敗しました', true);
        }
    } catch (error) {
        console.error('Error saving summary:', error);
        showToast('エラーが発生しました', true);
    }
}

// --- 設定管理 ---

async function openSettings() {
    try {
        const response = await handleResponse(await fetch(`${API_BASE}/settings`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) throw new Error('設定の取得に失敗しました');

        const settings = await response.json();

        document.getElementById('settingModel').value = settings.tagger_model;
        document.getElementById('settingThreshold').value = settings.tagger_threshold;
        document.getElementById('thresholdValue').textContent = settings.tagger_threshold.toFixed(2);
        document.getElementById('settingExcludedTags').value = settings.excluded_tags.join(', ');

        document.getElementById('settingsModal').style.display = 'block';
    } catch (error) {
        console.error('Settings open error:', error);
        showToast('設定の読み込みに失敗しました', true);
    }
}

function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

async function saveGlobalSettings() {
    const model = document.getElementById('settingModel').value;
    const threshold = parseFloat(document.getElementById('settingThreshold').value);
    const excludedTagsStr = document.getElementById('settingExcludedTags').value;
    const excludedTags = excludedTagsStr
        .split(',')
        .map(t => t.trim())
        .filter(t => t !== '');

    const settings = {
        tagger_model: model,
        tagger_threshold: threshold,
        excluded_tags: excludedTags
    };

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/settings`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(settings)
        }));

        if (!response.ok) throw new Error('設定の保存に失敗しました');

        showToast('設定を保存しました');
        closeSettings();

    } catch (error) {
        console.error('Settings save error:', error);
        showToast('設定の保存に失敗しました', true);
    }
}
