// グローバル変数
let currentImageId = null;
let currentAnnotations = [];
let loadedImage = null;
let canvas = null;
let ctx = null;
let currentScale = 1.0;
let lastFocusedTextArea = null;

// 新規描画用
let isDrawingNew = false;
let startX = 0;
let startY = 0;
let currentNewRect = null;
let isAddNewMode = false;

// ボックス編集用
let selectedAnnotationId = null;
let isEditingBox = false;
let editMode = null; // 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | 'resize-n' | 'resize-s' | 'resize-e' | 'resize-w'
let editStartX = 0;
let editStartY = 0;
let editOriginalBox = null;
const HANDLE_SIZE = 16;

// 設定値
let taggerThreshold = 0.6;

// API Base URL (動的に構築)
const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || (window.location.protocol === 'https:' ? '443' : '80')}`;

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
        window.location.href = '/login';
        throw new Error('認証が必要です');
    }
    return response;
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
    canvas = document.getElementById('viewerCanvas');
    ctx = canvas.getContext('2d');

    // スケーリング関連のイベント
    document.getElementById('zoomSlider').addEventListener('input', (e) => {
        updateScale(parseFloat(e.target.value));
    });
    document.getElementById('btnFitWidth').addEventListener('click', fitToWidth);
    document.getElementById('btnFitHeight').addEventListener('click', fitToHeight);
    document.getElementById('btnActualSize').addEventListener('click', () => updateScale(1.0));

    // 特殊文字ボタン
    document.querySelectorAll('.v-char-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (lastFocusedTextArea) {
                if (btn.dataset.template) {
                    insertRubyNotation(lastFocusedTextArea);
                } else if (btn.id === 'v-bracket-btn') {
                    insertBracketsAtCursor(lastFocusedTextArea);
                } else if (btn.id === 'v-bouten-btn') {
                    insertBoutenAtCursor(lastFocusedTextArea);
                } else {
                    insertTextAtCursor(lastFocusedTextArea, btn.dataset.char);
                }
            } else {
                showToast('編集ボックスを選択してください', true);
            }
        });
    });

    loadImagesList();
    loadTaggerSettings();

    // 新規アノテーション関連のイベント
    document.getElementById('btnAddNew').addEventListener('click', toggleAddNewMode);
    document.getElementById('btnAddNewPanel').addEventListener('click', () => {
        toggleAddNewMode();
        if (isAddNewMode) {
            document.getElementById('newTypeSelect').value = 'panel';
            // コマの場合は1番に挿入することが多いためデフォルトを設定
            if (!document.getElementById('newOrderInput').value) {
                document.getElementById('newOrderInput').value = '1';
            }
            updateNewTypeUI();
        }
    });
    document.getElementById('btnSaveNew').addEventListener('click', saveNewAnnotation);
    document.getElementById('btnCancelNew').addEventListener('click', cancelAddNew);
    document.getElementById('newTypeSelect').addEventListener('change', (e) => {
        updateNewTypeUI();
        const newType = e.target.value;
        // person/body_part/object に変更時は自動でTagger実行
        if (['person', 'body_part', 'object'].includes(newType) && currentNewRect) {
            performNewBoxTagger();
        }
    });
    document.getElementById('btnNewOCR').addEventListener('click', performNewBoxOCR);
    document.getElementById('btnNewTagger').addEventListener('click', performNewBoxTagger);

    // 完了ステータス切り替えボタン
    const toggleCompleteBtn = document.getElementById('btnToggleComplete');
    if (toggleCompleteBtn) {
        toggleCompleteBtn.addEventListener('click', toggleCompletionStatus);
    }

    // 認証チェック
    checkAuth();

    // Canvas描画イベント
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', () => { if (isDrawingNew) handleMouseUp(); });

    // タグ閾値スライダー
    const thresholdSlider = document.getElementById('taggerThreshold');
    const thresholdValue = document.getElementById('thresholdValue');
    if (thresholdSlider) {
        thresholdSlider.addEventListener('input', (e) => {
            taggerThreshold = parseFloat(e.target.value);
            thresholdValue.textContent = taggerThreshold.toFixed(2);
        });
    }

    // ページサマリー保存ボタン
    const saveSummaryBtn = document.getElementById('savePageSummaryBtn');
    if (saveSummaryBtn) {
        saveSummaryBtn.addEventListener('click', savePageSummary);
    }

    // 表示オプション
    document.getElementById('checkShowArrows')?.addEventListener('change', redrawCanvas);
    document.getElementById('checkCenterLabels')?.addEventListener('change', redrawCanvas);
});

// ユーザー権限チェック
async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/me`, {
            headers: getAuthHeaders()
        });
        if (response.status === 401) {
            window.location.href = '/login';
        }
    } catch (e) {
        console.error('Auth check error:', e);
    }
}

// 画像一覧を読み込み
async function loadImagesList() {
    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations-list`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) throw new Error('一覧の取得に失敗しました');

        const data = await response.json();
        const listContainer = document.getElementById('imageList');

        // files_list (backend main.py returns {"images": [...]}) NOT image_ids
        // Backend changes: return {"images": [{"id":..., "has_annotation":..., "is_completed":...}]}

        if (!data.images || data.images.length === 0) {
            listContainer.innerHTML = '<p style="text-align:center; color:#64748b;">アノテーションされた画像がありません</p>';
            return;
        }

        // 既存の内容をクリアして生成
        listContainer.innerHTML = '';

        // 数値として正しくソート (1, 2, 3, ... 10, 11 の順)
        data.images.sort((a, b) => {
            const numA = parseInt(a.id) || 0;
            const numB = parseInt(b.id) || 0;
            return numA - numB;
        });

        data.images.forEach(imgData => {
            const item = document.createElement('div');
            item.className = 'image-item';
            if (imgData.is_completed) item.classList.add('completed');
            item.id = `item-${imgData.id}`;

            // 完了アイコン
            const statusIcon = imgData.is_completed ? '✅ ' : '⬜ ';
            item.textContent = statusIcon + imgData.id;

            item.addEventListener('click', () => selectImage(imgData.id));
            listContainer.appendChild(item);
        });

        // URLパラメータから画像IDを取得
        const urlParams = new URLSearchParams(window.location.search);
        const imageParam = urlParams.get('image');

        // URLパラメータで指定された画像があれば、それを選択
        if (imageParam && data.images.some(img => img.id === imageParam)) {
            setTimeout(() => {
                selectImage(imageParam);
            }, 100);
        }
        // なければ最初の画像を選択（もしあれば）
        else if (data.images.length > 0) {
            setTimeout(() => {
                selectImage(data.images[0].id);
            }, 100);
        }
    } catch (error) {
        console.error('List load error:', error);
        document.getElementById('imageList').innerHTML = '<p style="text-align:center; color:#ef4444;">読み込みエラーが発生しました</p>';
    }
}

// 画像を選択

// order番号の欠番を自動で詰める関数
async function compactOrderNumbers() {
    if (!currentAnnotations || currentAnnotations.length === 0) return;

    // orderでソート
    const sorted = [...currentAnnotations].sort((a, b) => a.order - b.order);

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
    for (const anno of currentAnnotations) {
        const newOrder = orderMap[anno.order];
        if (newOrder !== anno.order) {
            anno.order = newOrder;
            await saveAnnotation(anno.id);
            updated = true;
        }
    }

    // 更新があった場合はログ出力
    if (updated) {
        console.log('Order numbers compacted:', orderMap);
    }
}

async function selectImage(imageId, preserveZoom = false) {
    if (!imageId) return;

    // UI更新（アクティブ状態の切り替え）
    document.querySelectorAll('.image-item').forEach(el => el.classList.remove('active'));
    const targetItem = document.getElementById(`item-${imageId}`);
    if (targetItem) {
        targetItem.classList.add('active');
    }

    currentImageId = imageId;

    try {
        // アノテーションを読み込み
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${imageId}`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) throw new Error('アノテーションの取得に失敗しました');

        const data = await response.json();
        currentAnnotations = data.annotations || [];

        // order番号の欠番を自動で詰める処理
        await compactOrderNumbers();

        // ページサマリーを表示
        const summaryInput = document.getElementById('pageSummaryText');
        if (summaryInput) {
            summaryInput.value = data.page_summary || "";
        }

        // 完了ボタンの状態更新 (ボタンがあれば)
        const completeBtn = document.getElementById('btnToggleComplete');
        if (completeBtn) {
            completeBtn.textContent = data.is_completed ? '完了済み (解除)' : '完了にする';
            completeBtn.classList.toggle('btn-success', data.is_completed);
            completeBtn.classList.toggle('btn-secondary', !data.is_completed);
        }

        currentAnnotations = currentAnnotations.sort((a, b) => a.order - b.order);

        // 画像を表示
        loadImage(data.image_filename);

        // 編集リストを表示
        displayEditList();

        // キャラクタータグを更新
        updateCharacterTags();

        // 読み込み直後にフィットさせる（preserveZoomがfalseの場合のみ）
        if (!preserveZoom) {
            setTimeout(fitToHeight, 200);
        }

    } catch (error) {
        console.error('Image select error:', error);
        showToast('エラー: ' + error.message, true);
    }
}

// 画像を読み込んでCanvasに表示
function loadImage(filename) {
    if (!filename) return;

    const img = new Image();
    authFetchImage(filename).then(url => {
        img.onload = () => {
            loadedImage = img;
            canvas.width = img.width;
            canvas.height = img.height;
            applyScale(); // 現在のスケールを適用
            redrawCanvas();

            // スクロールをトップに戻す（中央キャンバス）
            document.querySelector('.viewer-main').scrollTop = 0;
            URL.revokeObjectURL(url);
        };
        img.src = url;
    }).catch(err => {
        showToast('画像の読み込みに失敗しました: ' + filename, true);
        console.error(err);
    });
}

// Canvasを再描画
function redrawCanvas() {
    if (!loadedImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(loadedImage, 0, 0);

    // アノテーションと矢印を描画
    drawAnnotations();

    // 選択中のボックスにハンドルを描画
    if (selectedAnnotationId && !isAddNewMode) {
        const anno = currentAnnotations.find(a => a.id === selectedAnnotationId);
        if (anno) {
            drawSelectionHandles(anno.bbox_abs);
        }
    }

    // 新規描画中の矩形を描画
    if (currentNewRect) {
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(currentNewRect.x, currentNewRect.y, currentNewRect.width, currentNewRect.height);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(79, 70, 229, 0.2)';
        ctx.fillRect(currentNewRect.x, currentNewRect.y, currentNewRect.width, currentNewRect.height);
    }
}

// 選択ハンドルを描画
function drawSelectionHandles(box) {
    const { x, y, width, height } = box;

    // 外枠を強調
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);

    // ハンドル位置 (8点)
    const handles = [
        { x: x, y: y, cursor: 'nw-resize', type: 'resize-nw' },                           // 左上
        { x: x + width / 2, y: y, cursor: 'n-resize', type: 'resize-n' },                 // 上中央
        { x: x + width, y: y, cursor: 'ne-resize', type: 'resize-ne' },                    // 右上
        { x: x + width, y: y + height / 2, cursor: 'e-resize', type: 'resize-e' },        // 右中央
        { x: x + width, y: y + height, cursor: 'se-resize', type: 'resize-se' },          // 右下
        { x: x + width / 2, y: y + height, cursor: 's-resize', type: 'resize-s' },        // 下中央
        { x: x, y: y + height, cursor: 'sw-resize', type: 'resize-sw' },                   // 左下
        { x: x, y: y + height / 2, cursor: 'w-resize', type: 'resize-w' }                 // 左中央
    ];

    ctx.fillStyle = '#4f46e5';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;

    handles.forEach(h => {
        ctx.beginPath();
        ctx.rect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.fill();
        ctx.stroke();
    });
}

// マウス位置がどのハンドル上か判定
function getHandleAtPosition(mouseX, mouseY, box) {
    if (!box) return null;

    const { x, y, width, height } = box;
    const handles = [
        { x: x, y: y, type: 'resize-nw' },
        { x: x + width / 2, y: y, type: 'resize-n' },
        { x: x + width, y: y, type: 'resize-ne' },
        { x: x + width, y: y + height / 2, type: 'resize-e' },
        { x: x + width, y: y + height, type: 'resize-se' },
        { x: x + width / 2, y: y + height, type: 'resize-s' },
        { x: x, y: y + height, type: 'resize-sw' },
        { x: x, y: y + height / 2, type: 'resize-w' }
    ];

    for (const h of handles) {
        if (Math.abs(mouseX - h.x) <= HANDLE_SIZE && Math.abs(mouseY - h.y) <= HANDLE_SIZE) {
            return h.type;
        }
    }

    // ボックス内なら移動モード
    if (mouseX >= x && mouseX <= x + width && mouseY >= y && mouseY <= y + height) {
        return 'move';
    }

    return null;
}

// スケールを更新
function updateScale(scale) {
    currentScale = Math.max(0.1, Math.min(5.0, scale));
    document.getElementById('zoomSlider').value = currentScale;
    document.getElementById('zoomPercent').textContent = `${Math.round(currentScale * 100)}%`;
    applyScale();
}

// スケールをCSSに適用
function applyScale() {
    if (!loadedImage) return;
    canvas.style.width = `${loadedImage.width * currentScale}px`;
    canvas.style.height = `${loadedImage.height * currentScale}px`;
}

// 幅に合わせる
function fitToWidth() {
    if (!loadedImage) return;
    const container = document.querySelector('.viewer-main');
    const padding = 40;
    const scale = (container.clientWidth - padding) / loadedImage.width;
    updateScale(scale);
}

// 高さに合わせる
function fitToHeight() {
    if (!loadedImage) return;
    const container = document.querySelector('.viewer-main');
    const padding = 40;
    const scale = (container.clientHeight - padding) / loadedImage.height;
    updateScale(scale);
}

// アノテーションと矢印を描画
function drawAnnotations() {
    if (currentAnnotations.length === 0) return;

    // 1. 各アノテーションの枠を描画
    currentAnnotations.forEach((anno) => {
        const { x, y, width, height } = anno.bbox_abs;
        const color = getTypeColor(anno.type);

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, width, height);

        // 半透明の背景 (色に合わせる)
        ctx.fillStyle = hexToRgba(color, 0.15);
        ctx.fillRect(x, y, width, height);

        // 順番ラベル（グループ化対応）
        // 同じorderを持つアノテーションがある場合はサブ番号を表示
        let labelText = anno.order.toString();

        // 同じorderのアノテーションを抽出してソート
        const sameOrderAnnos = currentAnnotations
            .filter(a => a.order === anno.order)
            .sort((a, b) => {
                // IDでソートして一貫性を保つ
                return a.id.localeCompare(b.id);
            });

        // 複数ある場合はサブ番号を付ける
        if (sameOrderAnnos.length > 1) {
            const subIndex = sameOrderAnnos.findIndex(a => a.id === anno.id) + 1;
            labelText = `${anno.order}-${subIndex}`;
        }

        const isCenter = document.getElementById('checkCenterLabels').checked;
        const fontSize = Math.max(24, Math.round(canvas.height / 40));
        ctx.font = `bold ${fontSize}px Arial`;

        const metrics = ctx.measureText(labelText);
        const labelWidth = metrics.width + (fontSize * 0.4);
        const labelHeight = fontSize * 1.1;

        // 配置位置の計算
        let labelX, labelY;
        if (isCenter) {
            labelX = x + (width - labelWidth) / 2;
            labelY = y + (height - labelHeight) / 2;
        } else {
            labelX = x;
            labelY = y;
        }

        // 透明度を設定 (60%不透明)
        ctx.globalAlpha = 0.6;

        ctx.fillStyle = color;
        ctx.fillRect(labelX, labelY, labelWidth, labelHeight);

        ctx.fillStyle = 'white';
        ctx.fillText(labelText, labelX + (fontSize * 0.2), labelY + (fontSize * 0.9));

        // 透明度を戻す
        ctx.globalAlpha = 1.0;
    });

    // 2. 矢印を描画
    const showArrows = document.getElementById('checkShowArrows').checked;
    if (!showArrows) {
        ctx.shadowBlur = 0;
        return;
    }

    ctx.lineCap = 'round';
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';

    for (let i = 0; i < currentAnnotations.length - 1; i++) {
        const fromAnno = currentAnnotations[i];
        const toAnno = currentAnnotations[i + 1];
        const from = fromAnno.bbox_abs;
        const to = toAnno.bbox_abs;

        // 次のアノテーションが選択中、もしくは現在のアノテーションが選択中の場合、強調表示
        const isActive = selectedAnnotationId === fromAnno.id || selectedAnnotationId === toAnno.id;

        ctx.strokeStyle = isActive ? '#fbbf24' : 'rgba(129, 140, 248, 0.4)'; // Active: Gold, Passive: Faded Indigo
        ctx.fillStyle = isActive ? '#fbbf24' : 'rgba(129, 140, 248, 0.4)';
        ctx.lineWidth = isActive ? 5 : 2;

        if (!isActive) {
            ctx.setLineDash([10, 8]); // 点線
        } else {
            ctx.setLineDash([]); // 実線
        }

        // ボックスの中心点を計算
        const fromCX = from.x + from.width / 2;
        const fromCY = from.y + from.height / 2;
        const toCX = to.x + to.width / 2;
        const toCY = to.y + to.height / 2;

        const dirX = toCX - fromCX;
        const dirY = toCY - fromCY;
        const dist = Math.sqrt(dirX * dirX + dirY * dirY);

        if (dist < 10) continue;

        const normX = dirX / dist;
        const normY = dirY / dist;

        // 内包チェック: toがfromの中に完全に入っているか、逆にfromがtoの中か
        const isNested = (to.x >= from.x && to.y >= from.y && to.x + to.width <= from.x + from.width && to.y + to.height <= from.y + from.height) ||
            (from.x >= to.x && from.y >= to.y && from.x + from.width <= to.x + to.width && from.y + from.height <= to.y + to.height);

        // ボックスの辺と交差する点を計算
        let fromX, fromY, toX, toY;

        if (isNested) {
            // 内包されている場合は、中心から少しずらした位置から開始/終了（重なりすぎを避ける）
            fromX = fromCX + normX * 20;
            fromY = fromCY + normY * 20;
            toX = toCX - normX * 40;
            toY = toCY - normY * 40;
        } else {
            // fromボックスの出口
            if (Math.abs(normX) * from.height > Math.abs(normY) * from.width) {
                if (normX > 0) { fromX = from.x + from.width; fromY = fromCY + normY * (from.width / 2 / Math.abs(normX)); }
                else { fromX = from.x; fromY = fromCY - normY * (from.width / 2 / Math.abs(normX)); }
            } else {
                if (normY > 0) { fromY = from.y + from.height; fromX = fromCX + normX * (from.height / 2 / Math.abs(normY)); }
                else { fromY = from.y; fromX = fromCX - normX * (from.height / 2 / Math.abs(normY)); }
            }

            // toボックスの入口
            if (Math.abs(normX) * to.height > Math.abs(normY) * to.width) {
                if (normX > 0) { toX = to.x; toY = toCY - normY * (to.width / 2 / Math.abs(normX)); }
                else { toX = to.x + to.width; toY = toCY + normY * (to.width / 2 / Math.abs(normX)); }
            } else {
                if (normY > 0) { toY = to.y; toX = toCX - normX * (to.height / 2 / Math.abs(normY)); }
                else { toY = to.y + to.height; toX = toCX + normX * (to.height / 2 / Math.abs(normY)); }
            }
        }

        drawArrow(fromX, fromY, toX, toY, isActive);
    }

    ctx.setLineDash([]); // ダッシュ設定を戻す
    ctx.shadowBlur = 0;
}

// 矢印を描画するヘルパー関数
function drawArrow(fromx, fromy, tox, toy, isActive = false) {
    const headlen = isActive ? 24 : 14; // 矢印の頭の長さ
    const dx = tox - fromx;
    const dy = toy - fromy;
    const angle = Math.atan2(dy, dx);

    // 線を描く
    ctx.beginPath();
    ctx.moveTo(fromx, fromy);
    ctx.lineTo(tox, toy);
    ctx.stroke();

    // 矢印の頭を描く
    ctx.beginPath();
    ctx.moveTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.stroke(); // 縁取りを追加して見やすくする
}

// 新規描画モードの切り替え
function toggleAddNewMode() {
    isAddNewMode = !isAddNewMode;
    const btn = document.getElementById('btnAddNew');
    const form = document.getElementById('newAnnoForm');

    if (isAddNewMode) {
        btn.textContent = '描画中... (クリックで停止)';
        btn.classList.replace('btn-primary', 'btn-danger');
        form.style.display = 'block';
        canvas.style.cursor = 'crosshair';
        showToast('画像上をドラッグして範囲を選択してください');
    } else {
        cancelAddNew();
    }
}

function cancelAddNew() {
    isAddNewMode = false;
    isDrawingNew = false;
    currentNewRect = null;
    const btn = document.getElementById('btnAddNew');
    const form = document.getElementById('newAnnoForm');
    btn.textContent = '描画開始';
    btn.classList.replace('btn-danger', 'btn-primary');
    form.style.display = 'none';
    canvas.style.cursor = 'default';
    document.getElementById('btnSaveNew').disabled = true;
    document.getElementById('btnNewOCR').disabled = true;
    document.getElementById('btnNewTagger').disabled = true;
    document.getElementById('newBBoxInfo').textContent = '範囲を選択してください';
    redrawCanvas();
}

// 新規アノテーションフォームのTypeに連動したUI更新
function updateNewTypeUI() {
    const type = document.getElementById('newTypeSelect').value;
    const subtypeGroup = document.getElementById('newSubtypeGroup');
    const textInput = document.getElementById('newTextInput');

    if (subtypeGroup) {
        subtypeGroup.style.display = type === 'body_part' ? 'block' : 'none';
    }

    if (textInput) {
        if (type === 'panel') {
            textInput.placeholder = 'コマの簡略内容 (例: キャラ動作、背景、感情等)...';
        } else if (type === 'sound_effect') {
            textInput.placeholder = '擬音の内容...';
        } else {
            textInput.placeholder = 'テキスト内容...';
        }
    }
}

// Canvasイベントハンドラ
function handleMouseDown(e) {
    if (!loadedImage) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // 新規描画モードの場合
    if (isAddNewMode) {
        startX = mouseX;
        startY = mouseY;
        isDrawingNew = true;
        return;
    }

    // 選択中のボックスがある場合、ハンドルをチェック
    if (selectedAnnotationId) {
        const anno = currentAnnotations.find(a => a.id === selectedAnnotationId);
        if (anno) {
            const mode = getHandleAtPosition(mouseX, mouseY, anno.bbox_abs);
            if (mode) {
                isEditingBox = true;
                editMode = mode;
                editStartX = mouseX;
                editStartY = mouseY;
                editOriginalBox = { ...anno.bbox_abs };
                return;
            }
        }
    }

    // クリックされた位置のアノテーションを探す
    let clicked = null;
    for (const anno of currentAnnotations) {
        const { x, y, width, height } = anno.bbox_abs;
        if (mouseX >= x && mouseX <= x + width && mouseY >= y && mouseY <= y + height) {
            clicked = anno;
        }
    }

    if (clicked) {
        selectedAnnotationId = clicked.id;
        // スクロールして該当の編集アイテムを表示
        const editItem = document.querySelector(`.edit-item:has([data-id="${clicked.id}"])`);
        if (editItem) {
            editItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            editItem.style.outline = '2px solid #4f46e5';
            setTimeout(() => editItem.style.outline = '', 1500);
        }
    } else {
        selectedAnnotationId = null;
    }

    redrawCanvas();
}

function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // 新規描画中
    if (isDrawingNew) {
        currentNewRect = {
            x: Math.min(startX, mouseX),
            y: Math.min(startY, mouseY),
            width: Math.abs(mouseX - startX),
            height: Math.abs(mouseY - startY)
        };
        redrawCanvas();
        return;
    }

    // ボックス編集中
    if (isEditingBox && editOriginalBox) {
        const dx = mouseX - editStartX;
        const dy = mouseY - editStartY;
        const anno = currentAnnotations.find(a => a.id === selectedAnnotationId);

        if (anno) {
            let newBox = { ...editOriginalBox };

            if (editMode === 'move') {
                newBox.x = editOriginalBox.x + dx;
                newBox.y = editOriginalBox.y + dy;
            } else if (editMode.startsWith('resize')) {
                // リサイズ処理
                // 方向部分を抽出 (例: 'resize-nw' -> 'nw')
                const direction = editMode.replace('resize-', '');

                // 元のボックスの右端・下端の位置を計算（固定点として使用）
                const originalRight = editOriginalBox.x + editOriginalBox.width;
                const originalBottom = editOriginalBox.y + editOriginalBox.height;

                // 北（上）- 下端を固定して上端を動かす
                if (direction.includes('n')) {
                    const newY = editOriginalBox.y + dy;
                    const newHeight = originalBottom - newY;
                    if (newHeight >= 20) {
                        newBox.y = newY;
                        newBox.height = newHeight;
                    } else {
                        newBox.y = originalBottom - 20;
                        newBox.height = 20;
                    }
                }
                // 南（下）- 上端を固定して下端を動かす
                if (direction.includes('s')) {
                    const newHeight = editOriginalBox.height + dy;
                    newBox.height = Math.max(20, newHeight);
                }
                // 西（左）- 右端を固定して左端を動かす
                if (direction.includes('w')) {
                    const newX = editOriginalBox.x + dx;
                    const newWidth = originalRight - newX;
                    if (newWidth >= 20) {
                        newBox.x = newX;
                        newBox.width = newWidth;
                    } else {
                        newBox.x = originalRight - 20;
                        newBox.width = 20;
                    }
                }
                // 東（右）- 左端を固定して右端を動かす
                if (direction.includes('e')) {
                    const newWidth = editOriginalBox.width + dx;
                    newBox.width = Math.max(20, newWidth);
                }

                // デバッグ出力
                console.log(`Resize ${editMode} (dir=${direction}): dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}`);
                console.log(`  Right edge: orig=${originalRight.toFixed(1)}, new=${(newBox.x + newBox.width).toFixed(1)}`);
                console.log(`  Bottom edge: orig=${originalBottom.toFixed(1)}, new=${(newBox.y + newBox.height).toFixed(1)}`);
            }

            anno.bbox_abs = newBox;
            redrawCanvas();
        }
        return;
    }

    // カーソル変更 (選択中のボックスに対するホバー)
    if (selectedAnnotationId && !isAddNewMode) {
        const anno = currentAnnotations.find(a => a.id === selectedAnnotationId);
        if (anno) {
            const mode = getHandleAtPosition(mouseX, mouseY, anno.bbox_abs);
            if (mode === 'move') {
                canvas.style.cursor = 'move';
            } else if (mode && mode.startsWith('resize')) {
                const cursorMap = {
                    'resize-nw': 'nwse-resize',
                    'resize-se': 'nwse-resize',
                    'resize-ne': 'nesw-resize',
                    'resize-sw': 'nesw-resize',
                    'resize-n': 'ns-resize',
                    'resize-s': 'ns-resize',
                    'resize-e': 'ew-resize',
                    'resize-w': 'ew-resize'
                };
                canvas.style.cursor = cursorMap[mode] || 'default';
            } else {
                canvas.style.cursor = 'default';
            }
        }
    } else if (!isAddNewMode) {
        canvas.style.cursor = 'default';
    }
}

function handleMouseUp() {
    // 新規描画終了
    if (isDrawingNew) {
        isDrawingNew = false;
        if (currentNewRect && currentNewRect.width > 5 && currentNewRect.height > 5) {
            document.getElementById('btnSaveNew').disabled = false;
            document.getElementById('btnNewOCR').disabled = false;
            document.getElementById('btnNewTagger').disabled = false;
            document.getElementById('newBBoxInfo').textContent =
                `範囲: ${Math.round(currentNewRect.width)}x${Math.round(currentNewRect.height)}`;
        } else {
            currentNewRect = null;
            document.getElementById('btnSaveNew').disabled = true;
            document.getElementById('btnNewOCR').disabled = true;
            document.getElementById('btnNewTagger').disabled = true;
            document.getElementById('newBBoxInfo').textContent = '範囲が狭すぎます';
            redrawCanvas();
        }
        return;
    }

    // ボックス編集終了
    if (isEditingBox) {
        isEditingBox = false;
        editMode = null;
        editOriginalBox = null;

        // 自動保存
        if (selectedAnnotationId) {
            saveBoxChange(selectedAnnotationId);
        }
    }
}

// ボックス変更を保存
async function saveBoxChange(annotationId) {
    const anno = currentAnnotations.find(a => a.id === annotationId);
    if (!anno) return;

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}/${annotationId}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_id: currentImageId,
                type: anno.type,
                subtype: anno.subtype || null,
                order: anno.order,
                bbox_abs: anno.bbox_abs,
                text: anno.text,
                character_id: anno.character_id
            })
        }));

        if (!response.ok) throw new Error('保存に失敗しました');
        showToast('ボックスを更新しました');

    } catch (error) {
        console.error('Box save error:', error);
        showToast('エラー: ' + error.message, true);
        // 失敗時は再読み込み
        await selectImage(currentImageId);
    }
}

// 新規保存
async function saveNewAnnotation() {
    if (!currentNewRect || !currentImageId) return;

    const type = document.getElementById('newTypeSelect').value;
    const subtype = type === 'body_part' ? document.getElementById('newSubtypeSelect').value : null;
    const characterId = document.getElementById('newCharacterInput').value || null;
    let text = formatTextForSave(document.getElementById('newTextInput').value);

    // 擬音かつテキスト空欄なら自動補完
    if (type === 'sound_effect' && (!text || text.trim() === '')) {
        text = '(擬音)';
    }
    const orderInput = document.getElementById('newOrderInput').value;

    // 順番指定があればそれを使用、なければ null (backend側で末尾に追加)
    const order = orderInput ? parseInt(orderInput) : null;

    const annotationData = {
        image_id: currentImageId,
        type: type,
        subtype: subtype,
        order: order,
        bbox_abs: currentNewRect,
        text: text,
        character_id: characterId
    };

    const saveBtn = document.getElementById('btnSaveNew');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(annotationData)
        }));

        if (!response.ok) throw new Error('保存に失敗しました');

        showToast('新規アノテーションを追加しました');

        // リセットして再読込（ズーム倍率は保持）
        cancelAddNew();
        document.getElementById('newTextInput').value = '';
        document.getElementById('newCharacterInput').value = '';
        document.getElementById('newOrderInput').value = '';
        currentNewRect = null;
        await selectImage(currentImageId, true); // preserveZoom = true

    } catch (error) {
        console.error('Save error:', error);
        showToast('エラー: ' + error.message, true);
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
    }
}

// 編集用リストを表示
function displayEditList() {
    const container = document.getElementById('editList');

    if (!currentAnnotations || currentAnnotations.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#64748b;">アノテーションがありません</p>';
        return;
    }

    container.innerHTML = '';
    currentAnnotations.forEach((anno, index) => {
        const editItem = document.createElement('div');
        editItem.className = 'edit-item';

        const isFirst = index === 0;
        const isLast = index === currentAnnotations.length - 1;

        // グループ化対応: 同じorderのアノテーションをカウント
        const sameOrderAnnos = currentAnnotations
            .filter(a => a.order === anno.order)
            .sort((a, b) => a.id.localeCompare(b.id));

        let orderLabel = anno.order.toString();
        if (sameOrderAnnos.length > 1) {
            const subIndex = sameOrderAnnos.findIndex(a => a.id === anno.id) + 1;
            orderLabel = `${anno.order}-${subIndex}`;
        }

        editItem.innerHTML = `
            <div class="edit-header">
                <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <input type="number" class="edit-order-input" 
                               data-id="${anno.id}" 
                               value="${anno.order}" 
                               min="1" 
                               max="${currentAnnotations.length}"
                               title="順番を入力 (1-${currentAnnotations.length})">
                        ${sameOrderAnnos.length > 1 ? `<span style="font-size: 10px; color: #94a3b8; font-family: monospace;">${orderLabel}</span>` : ''}
                    </div>
                    
                    <select class="edit-type-select" data-id="${anno.id}" style="padding: 4px; background: #334155; color: white; border: 1px solid #475569; border-radius: 4px; font-size: 12px;">
                        <option value="dialogue" ${anno.type === 'dialogue' ? 'selected' : ''}>セリフ</option>
                        <option value="monologue" ${anno.type === 'monologue' ? 'selected' : ''}>モノローグ</option>
                        <option value="whisper" ${anno.type === 'whisper' ? 'selected' : ''}>小声</option>
                        <option value="narration" ${anno.type === 'narration' ? 'selected' : ''}>ナレーション</option>
                        <option value="sound_effect" ${anno.type === 'sound_effect' ? 'selected' : ''}>効果音</option>
                        <option value="ruby" ${anno.type === 'ruby' ? 'selected' : ''}>ルビ</option>
                        <option value="footnote" ${anno.type === 'footnote' ? 'selected' : ''}>注釈</option>
                        <option value="title" ${anno.type === 'title' ? 'selected' : ''}>タイトル</option>
                        <option value="person" ${anno.type === 'person' ? 'selected' : ''}>人物</option>
                        <option value="face" ${anno.type === 'face' ? 'selected' : ''}>顔</option>
                        <option value="body_part" ${anno.type === 'body_part' ? 'selected' : ''}>部位</option>
                        <option value="object" ${anno.type === 'object' ? 'selected' : ''}>物体</option>
                        <option value="panel" ${anno.type === 'panel' ? 'selected' : ''}>コマ</option>
                    </select>

                    <div class="edit-subtype-container" id="subtype-container-${anno.id}" style="display: ${anno.type === 'body_part' ? 'block' : 'none'};">
                        <select class="edit-subtype-select" data-id="${anno.id}" style="padding: 4px; background: #334155; color: white; border: 1px solid #475569; border-radius: 4px; font-size: 12px;">
                            <option value="penis" ${anno.subtype === 'penis' ? 'selected' : ''}>チンポ</option>
                            <option value="vagina" ${anno.subtype === 'vagina' ? 'selected' : ''}>マンコ</option>
                            <option value="nipple" ${anno.subtype === 'nipple' ? 'selected' : ''}>乳首</option>
                            <option value="vaginal_interior" ${anno.subtype === 'vaginal_interior' ? 'selected' : ''}>膣内</option>
                            <option value="anal" ${anno.subtype === 'anal' ? 'selected' : ''}>アナル</option>
                            <option value="other" ${anno.subtype === 'other' ? 'selected' : ''}>その他</option>
                        </select>
                    </div>

                    <input type="text" class="edit-character-input" 
                           data-id="${anno.id}" 
                           value="${anno.character_id || ''}" 
                           placeholder="キャラID"
                           list="characterSuggestions"
                           style="padding: 4px 8px; background: #334155; color: white; border: 1px solid #475569; border-radius: 4px; font-size: 11px; width: 80px;">

                    <div class="reorder-buttons">
                        <button class="reorder-btn" data-id="${anno.id}" data-direction="up" ${isFirst ? 'disabled' : ''} title="上に移動">▲</button>
                        <button class="reorder-btn" data-id="${anno.id}" data-direction="down" ${isLast ? 'disabled' : ''} title="下に移動">▼</button>
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 4px; margin-bottom: 8px;">
                <button class="btn btn-secondary ocr-btn" data-id="${anno.id}" style="padding: 4px 8px; font-size: 11px;" title="OCRでテキスト認識">📝 OCR</button>
                <button class="btn btn-secondary tagger-btn" data-id="${anno.id}" style="padding: 4px 8px; font-size: 11px;" title="タグ自動取得">🏷️ Tag</button>
            </div>
            <div class="ruby-preview" id="preview-${anno.id}" 
                 style="background: #1e293b; padding: 12px; border-radius: 8px; margin-bottom: 10px; border: 1px dashed #475569; min-height: 1.5em; line-height: 1.8; font-size: 18px; color: #f8fafc;">
                ${anno.text || ''}
            </div>
            <textarea class="edit-textarea" id="text-${anno.id}" rows="5" data-id="${anno.id}" style="font-size: 14px; line-height: 1.5; padding: 8px;">${formatTextForDisplay(anno.text || '')}</textarea>
            <button class="btn btn-success save-btn" data-id="${anno.id}">保存</button>
        `;

        const saveBtn = editItem.querySelector('.save-btn');
        saveBtn.addEventListener('click', () => saveAnnotation(anno.id));

        const textarea = editItem.querySelector('.edit-textarea');
        textarea.addEventListener('focus', () => {
            lastFocusedTextArea = textarea;
            selectedAnnotationId = anno.id;
            redrawCanvas();
        });

        // 全体クリックでも選択状態にする
        editItem.addEventListener('click', (e) => {
            if (selectedAnnotationId !== anno.id) {
                selectedAnnotationId = anno.id;
                redrawCanvas();
            }
        });

        // 三点リーダー変換 & プレビュー更新
        textarea.addEventListener('input', (e) => {
            let value = e.target.value;

            // 1. 三点リーダー変換
            const newValue = value.replace(/\.\.\.|．．．/g, '…');
            if (value !== newValue) {
                const start = e.target.selectionStart;
                const end = e.target.selectionEnd;
                const diff = value.length - newValue.length;
                e.target.value = newValue;
                e.target.setSelectionRange(start - diff, end - diff);
                value = newValue;
            }

            // 2. プレビュー更新
            const preview = document.getElementById(`preview-${anno.id}`);
            if (preview) {
                const rawText = formatTextForSave(value);
                // XSS対策: 基本はtextContentだが、特定のタグのみ許容する簡易サニタイズ
                preview.innerHTML = sanitizeRuby(rawText);
            }
        });

        // OCRボタン
        const ocrBtn = editItem.querySelector('.ocr-btn');
        ocrBtn.addEventListener('click', () => performOCRForAnnotation(anno.id));

        // Taggerボタン
        const taggerBtn = editItem.querySelector('.tagger-btn');
        taggerBtn.addEventListener('click', () => performTaggerForAnnotation(anno.id));

        // 上下移動ボタンのイベントリスナー
        const moveUpBtn = editItem.querySelector('.reorder-btn[data-direction="up"]');
        const moveDownBtn = editItem.querySelector('.reorder-btn[data-direction="down"]');

        if (moveUpBtn) {
            moveUpBtn.addEventListener('click', () => moveAnnotation(anno.id, 'up'));
        }
        if (moveDownBtn) {
            moveDownBtn.addEventListener('click', () => moveAnnotation(anno.id, 'down'));
        }

        // 順番入力フィールドのイベントリスナー
        const orderInput = editItem.querySelector('.edit-order-input');
        if (orderInput) {
            orderInput.addEventListener('change', async (e) => {
                const newOrder = parseInt(e.target.value);
                const oldOrder = anno.order;
                // currentAnnotations.length は現在のリストの数。
                // 新しいアノテーションが追加される可能性を考慮して +1 するか、
                // 既存の最大order値 + 1 を使うのがより正確。
                // ここでは既存の最大order値 + 1 を使用。
                const maxOrder = Math.max(...currentAnnotations.map(a => a.order)) + 1;

                if (newOrder && newOrder >= 1 && newOrder <= maxOrder && newOrder !== oldOrder) {
                    try {
                        // 1. 対象のアノテーションのorder番号を変更
                        anno.order = newOrder;
                        await saveAnnotation(anno.id);

                        // 2. oldOrderより後ろのアノテーションを全て-1して詰める
                        // これにより、欠番が発生しても順番が詰まる
                        const toUpdate = currentAnnotations.filter(a =>
                            a.id !== anno.id && a.order > oldOrder
                        );

                        if (toUpdate.length > 0) {
                            // orderでソートしてから順に-1
                            toUpdate.sort((a, b) => a.order - b.order);
                            for (const a of toUpdate) {
                                a.order = a.order - 1;
                                await saveAnnotation(a.id);
                            }
                        }

                        // 3. 画像を再読み込みして最新の状態を表示
                        await selectImage(currentImageId);
                        showToast('順番を更新しました');
                    } catch (error) {
                        console.error('Order update error:', error);
                        showToast('順番の更新に失敗しました', true);
                        // エラー時は再読み込み
                        await selectImage(currentImageId);
                    }
                } else {
                    // 無効な値の場合は元に戻す
                    e.target.value = anno.order;
                }
            });

            // Enterキーでも確定
            orderInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.target.blur(); // changeイベントをトリガー
                }
            });
        }

        // タイプ変更によるサブタイプ表示制御 + 自動Tagger
        const typeSelect = editItem.querySelector('.edit-type-select');
        const subtypeCont = editItem.querySelector('.edit-subtype-container');
        typeSelect.addEventListener('change', (e) => {
            const newType = e.target.value;
            subtypeCont.style.display = newType === 'body_part' ? 'block' : 'none';

            // person/face/body_part/object に変更時は自動でTagger実行
            if (['person', 'face', 'body_part', 'object'].includes(newType)) {
                performTaggerForAnnotation(anno.id);
            }
        });

        container.appendChild(editItem);
    });
}

// カーソル位置にテキストを挿入
function insertTextAtCursor(el, text) {
    const startPos = el.selectionStart;
    const endPos = el.selectionEnd;
    const val = el.value;
    el.value = val.substring(0, startPos) + text + val.substring(endPos, val.length);
    el.focus();
    el.selectionStart = el.selectionEnd = startPos + text.length;
}

// 括弧で囲む
function insertBracketsAtCursor(el) {
    const startPos = el.selectionStart;
    const endPos = el.selectionEnd;
    const val = el.value;
    const selectedText = val.substring(startPos, endPos);

    const template = `（${selectedText}）`;
    el.value = val.substring(0, startPos) + template + val.substring(endPos, val.length);

    el.focus();
    if (selectedText) {
        el.setSelectionRange(startPos + template.length, startPos + template.length);
    } else {
        el.setSelectionRange(startPos + 1, startPos + 1);
    }
}

// ルビ記法を挿入 (|漢字{かんじ})
function insertRubyNotation(el) {
    const startPos = el.selectionStart;
    const endPos = el.selectionEnd;
    const val = el.value;
    const selectedText = val.substring(startPos, endPos);

    // 選択範囲がある場合は |選択範囲{}
    // ない場合は |文字{るび}
    const template = selectedText ? `|${selectedText}{}` : '|文字{るび}';
    el.value = val.substring(0, startPos) + template + val.substring(endPos, val.length);

    el.focus();
    if (selectedText) {
        // {}の中にカーソルを移動
        const newPos = startPos + template.length - 1;
        el.setSelectionRange(newPos, newPos);
    } else {
        // 「文字」を選択状態にする
        el.setSelectionRange(startPos + 1, startPos + 3);
    }
}

// 表示用に変換 (<ruby> -> {})
function formatTextForDisplay(text) {
    if (!text) return '';
    // <ruby>漢字<rt>かんじ</rt></ruby> -> 漢字{かんじ}
    // 親文字に平仮名などが含まれる場合は | を付けて復元する
    return text.replace(/<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>/g, (match, parent, ruby) => {
        // 漢字以外の文字（平仮名、片仮名など）が含まれているかチェック
        const hasNonKanji = /[^\u3400-\u9FFF\uF900-\uFAFF々〇〻]/.test(parent);
        return hasNonKanji ? `|${parent}{${ruby}}` : `${parent}{${ruby}}`;
    });
}

// 保存用に変換 ({} -> <ruby>)
function formatTextForSave(text) {
    if (!text) return '';

    // 1. パイプ記法を処理: |文字{るび} -> <ruby>文字<rt>るび</rt></ruby>
    // [^{}\s|｜] を使って他のパイプを巻き込まないようにする
    let processed = text.replace(/[|｜]([^{}\s|｜]+)\{([^{}\s]*)\}/g, '<ruby>$1<rt>$2</rt></ruby>');

    // 2. 自動判定: 漢字の塊{るび} または 1文字{るび} -> <ruby>...<rt>...</rt></ruby>
    processed = processed.replace(/([々〇〻\u3400-\u9FFF\uF900-\uFAFF]+)\{([^{}\s]*)\}/g, '<ruby>$1<rt>$2</rt></ruby>');

    // 3. フォールバック: 残った {るび} の直前1文字をルビ対象にする
    processed = processed.replace(/(.)\{([^{}\s]*)\}/g, (match, char, ruby) => {
        if (char === '>') return match; // 既にrubyタグになっている場合はスキップ
        return `<ruby>${char}<rt>${ruby}</rt></ruby>`;
    });

    return processed;
}

// アノテーション情報を保存
async function saveAnnotation(annotationId) {
    const editItem = document.querySelector(`.edit-item:has([data-id="${annotationId}"])`);
    if (!editItem) return;

    const textarea = document.getElementById(`text-${annotationId}`);
    const typeSelect = editItem.querySelector('.edit-type-select');
    const subtypeSelect = editItem.querySelector('.edit-subtype-select');
    const characterInput = editItem.querySelector('.edit-character-input');
    const orderInput = editItem.querySelector('.edit-order-input');

    const anno = currentAnnotations.find(a => a.id === annotationId);
    if (!anno) return;

    // 保存用に変換
    const newText = formatTextForSave(textarea.value);

    const updatedData = {
        image_id: currentImageId,
        type: typeSelect.value,
        subtype: typeSelect.value === 'body_part' ? subtypeSelect.value : null,
        character_id: characterInput.value || null,
        order: parseInt(orderInput.value),
        text: newText,
        bbox_abs: anno.bbox_abs // 座標は変更しない
    };

    const saveBtn = editItem.querySelector('.save-btn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}/${annotationId}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify(updatedData)
        }));

        if (!response.ok) throw new Error('保存に失敗しました');

        // ローカルデータを更新して再読込（リスト表示やキャンバスを最新にするため）
        await selectImage(currentImageId);
        showToast('保存しました');
    } catch (error) {
        console.error('Save error:', error);
        showToast('保存に失敗しました', true);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存';
        }
    }
}

// アノテーションを移動
async function moveAnnotation(annotationId, direction) {
    const currentIndex = currentAnnotations.findIndex(a => a.id === annotationId);
    if (currentIndex === -1) return;

    let newIndex;
    if (direction === 'up') {
        if (currentIndex === 0) return; // 既に最初
        newIndex = currentIndex - 1;
    } else {
        if (currentIndex === currentAnnotations.length - 1) return; // 既に最後
        newIndex = currentIndex + 1;
    }

    // ローカルで配列を入れ替え
    const temp = currentAnnotations[currentIndex];
    currentAnnotations[currentIndex] = currentAnnotations[newIndex];
    currentAnnotations[newIndex] = temp;

    // 新しいIDの順番を作成
    const newOrder = currentAnnotations.map(a => a.id);
    console.log('Sending reorder request:', { annotation_ids: newOrder });

    try {
        // バックエンドに送信
        const response = await fetch(`${API_BASE}/annotations/${currentImageId}/reorder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ annotation_ids: newOrder })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Reorder failed:', response.status, errorData);
            if (errorData.detail && Array.isArray(errorData.detail)) {
                console.error('Validation errors:', JSON.stringify(errorData.detail, null, 2));
            }
            throw new Error(`順番の更新に失敗しました (${response.status})`);
        }

        // 成功したら再読み込み（orderフィールドを正しく更新するため）
        await selectImage(currentImageId);
        showToast('順番を更新しました');
    } catch (error) {
        console.error('Reorder error:', error);
        showToast('順番の更新に失敗しました', true);
        // エラー時は元に戻す
        await selectImage(currentImageId);
    }
}

// アノテーションを指定位置に移動
async function moveAnnotationToPosition(annotationId, newPosition) {
    const currentIndex = currentAnnotations.findIndex(a => a.id === annotationId);
    if (currentIndex === -1) return;

    // 1-indexed から 0-indexed に変換
    const newIndex = newPosition - 1;

    if (newIndex === currentIndex) return; // 同じ位置
    if (newIndex < 0 || newIndex >= currentAnnotations.length) return; // 範囲外

    // 配列から要素を取り出して新しい位置に挿入
    const [movedItem] = currentAnnotations.splice(currentIndex, 1);
    currentAnnotations.splice(newIndex, 0, movedItem);

    // 新しいIDの順番を作成
    const newOrder = currentAnnotations.map(a => a.id);
    console.log('Sending reorder request (to position):', { annotation_ids: newOrder });

    try {
        // バックエンドに送信
        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}/reorder`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ annotation_ids: newOrder })
        }));

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Reorder failed:', response.status, errorData);
            if (errorData.detail && Array.isArray(errorData.detail)) {
                console.error('Validation errors:', JSON.stringify(errorData.detail, null, 2));
            }
            throw new Error(`順番の更新に失敗しました (${response.status})`);
        }

        // 成功したら再読み込み（orderフィールドを正しく更新するため）
        await selectImage(currentImageId);
        showToast(`${newPosition}番に移動しました`);
    } catch (error) {
        console.error('Reorder error:', error);
        showToast('順番の更新に失敗しました', true);
        // エラー時は元に戻す
        await selectImage(currentImageId);
    }
}

// 完了ステータス切り替え
async function toggleCompletionStatus() {
    if (!currentImageId) return;

    try {
        // 現在の状態を取得 (from UI or local state?) 
        // We don't store local is_completed state in variable easily accessible?
        // Let's assume we toggle based on button state or fetch fresh.
        // Better: just send PATCH to toggle or specific value.
        // API: PATCH /annotations/{image_id}/status, body: {is_completed: bool}

        // Helper to check current button state
        const btn = document.getElementById('btnToggleComplete');
        const isCurrentlyCompleted = btn.textContent.includes('完了済み');
        const newStatus = !isCurrentlyCompleted;

        const response = await handleResponse(await fetch(`${API_BASE}/annotations/${currentImageId}/status`, {
            method: 'PATCH',
            headers: getAuthHeaders(),
            body: JSON.stringify({ is_completed: newStatus })
        }));

        if (!response.ok) throw new Error('ステータス更新に失敗しました');

        // UI更新 (reload list to update checkmark, and button)
        await loadImagesList(); // Refresh sidebar list
        // Update button state immediately for responsiveness
        btn.textContent = newStatus ? '完了済み (解除)' : '完了にする';
        btn.classList.toggle('btn-success', newStatus);
        btn.classList.toggle('btn-secondary', !newStatus);

        showToast(newStatus ? '完了としてマークしました' : '完了を取り消しました');

    } catch (error) {
        console.error('Status update error:', error);
        showToast('エラー: ' + error.message, true);
    }
}

// ページサマリー保存
async function savePageSummary() {
    if (!currentImageId) return;
    const summaryInput = document.getElementById('pageSummaryText');
    const saveBtn = document.getElementById('savePageSummaryBtn');
    const summary = summaryInput.value;

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

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
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '説明を保存';
        }
    }
}

// 通知を表示
function showToast(message, isError = false) {
    const notification = document.getElementById('statusNotification');
    if (!notification) return;

    notification.textContent = message;
    notification.style.display = 'block';
    notification.className = 'notification' + (isError ? ' error' : '');

    // 既存のタイマーがあればクリア
    if (window.toastTimer) clearTimeout(window.toastTimer);

    window.toastTimer = setTimeout(() => {
        notification.style.display = 'none';
    }, 3000);
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
        'body_part': '部位',
        'object': '物体',
        'panel': 'コマ'
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
        'body_part': '#e53e3e',
        'object': '#667eea',
        'panel': '#805ad5'
    };
    return colors[type] || '#48bb78';
}

// HEXをRGBAに変換
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 現在選択されている画像IDを取得
function getCurrentImageId() {
    return currentImageId;
}

// キャラクタータグを更新して表示する
function updateCharacterTags() {
    const container = document.getElementById('charTags');
    if (!container) return;

    // 全アノテーションからユニークなcharacter_idを抽出
    const charIds = new Set();
    currentAnnotations.forEach(anno => {
        if (anno.character_id && anno.character_id.trim() !== "") {
            charIds.add(anno.character_id.trim());
        }
    });

    // datalist (入力候補) も更新
    const datalist = document.getElementById('characterSuggestions');
    if (datalist) {
        datalist.innerHTML = Array.from(charIds).map(id => `<option value="${id}">`).join('');
    }

    if (charIds.size === 0) {
        container.innerHTML = '<span style="font-size: 11px; color: #64748b;">(登録キャラクターなし)</span>';
        return;
    }

    container.innerHTML = Array.from(charIds).map(id => `
        <span class="char-tag" style="background: #334155; color: #818cf8; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; border: 1px solid #475569; cursor: pointer;"
              onclick="copyToSummary('${id.replace(/'/g, "\\'")}')" title="クリックで本文末尾に追加">
            ${id}
        </span>
    `).join('');
}

// サニタイズ: <ruby>, <rt> 以外のタグを除去
function sanitizeRuby(html) {
    const div = document.createElement('div');
    div.innerHTML = html;

    // 許可するタグ
    const allowedTags = ['RUBY', 'RT'];

    // すべての要素をスキャンして許可されていないタグを除去
    const walk = (node) => {
        const children = Array.from(node.childNodes);
        children.forEach(child => {
            if (child.nodeType === 1) { // Element node
                if (!allowedTags.includes(child.tagName)) {
                    // タグをテキストとして埋め込むか除去
                    const textNode = document.createTextNode(child.outerHTML);
                    node.replaceChild(textNode, child);
                } else {
                    walk(child);
                }
            }
        });
    };

    walk(div);
    return div.innerHTML;
}

// タグをクリックした時に要約欄の末尾に追加するヘルパー
window.copyToSummary = function (text) {
    const textarea = document.getElementById('pageSummaryText');
    if (!textarea) return;

    const currentVal = textarea.value;
    if (currentVal && !currentVal.endsWith(' ') && !currentVal.endsWith('\n')) {
        textarea.value += ' ' + text;
    } else {
        textarea.value += text;
    }
    textarea.focus();
};

// アノテーションに対してOCRを実行
async function performOCRForAnnotation(annotationId) {
    const anno = currentAnnotations.find(a => a.id === annotationId);
    if (!anno) return;

    showToast('OCR実行中...');

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/ocr`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_id: currentImageId,
                bbox_abs: anno.bbox_abs
            })
        }));

        if (!response.ok) throw new Error('OCR実行に失敗しました');

        const result = await response.json();

        // テキストエリアに結果を設定
        const textarea = document.getElementById(`text-${annotationId}`);
        if (textarea) {
            textarea.value = result.text || '';
            // プレビュー更新
            const preview = document.getElementById(`preview-${annotationId}`);
            if (preview) {
                preview.innerHTML = sanitizeRuby(formatTextForSave(result.text || ''));
            }
        }

        showToast('OCR完了: ' + (result.text || '(空)').substring(0, 30) + '...');

    } catch (error) {
        console.error('OCR error:', error);
        showToast('OCRエラー: ' + error.message, true);
    }
}

// アノテーションに対してTaggerを実行
async function performTaggerForAnnotation(annotationId) {
    const anno = currentAnnotations.find(a => a.id === annotationId);
    if (!anno) return;

    showToast('タグ取得中...');

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/tagger`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_id: currentImageId,
                bbox_abs: anno.bbox_abs,
                threshold: taggerThreshold,
                annotation_type: anno.type
            })
        }));

        if (!response.ok) throw new Error('Tagger実行に失敗しました');

        const result = await response.json();

        // テキストエリアに結果を設定
        const textarea = document.getElementById(`text-${annotationId}`);
        if (textarea) {
            textarea.value = result.text || '';
            // プレビュー更新
            const preview = document.getElementById(`preview-${annotationId}`);
            if (preview) {
                preview.textContent = result.text || '';
            }
        }

        const tagCount = result.tags ? result.tags.length : 0;
        showToast(`タグ取得完了: ${tagCount}件`);

    } catch (error) {
        console.error('Tagger error:', error);
        showToast('タグ取得エラー: ' + error.message, true);
    }
}

// 新規アノテーションの範囲に対してOCRを実行
async function performNewBoxOCR() {
    if (!currentNewRect || !currentImageId) {
        showToast('先に範囲を選択してください', true);
        return;
    }

    showToast('OCR実行中...');

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/ocr`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_id: currentImageId,
                bbox_abs: currentNewRect
            })
        }));

        if (!response.ok) throw new Error('OCR実行に失敗しました');

        const result = await response.json();

        // テキストエリアに結果を設定
        const textarea = document.getElementById('newTextInput');
        if (textarea) {
            textarea.value = result.text || '';
        }

        showToast('OCR完了: ' + (result.text || '(空)').substring(0, 30) + '...');

    } catch (error) {
        console.error('New box OCR error:', error);
        showToast('OCRエラー: ' + error.message, true);
    }
}

// 新規アノテーションの範囲に対してTaggerを実行
async function performNewBoxTagger() {
    if (!currentNewRect || !currentImageId) {
        showToast('先に範囲を選択してください', true);
        return;
    }

    const newType = document.getElementById('newTypeSelect').value;

    showToast('タグ取得中...');

    try {
        const response = await handleResponse(await fetch(`${API_BASE}/tagger`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_id: currentImageId,
                bbox_abs: currentNewRect,
                threshold: taggerThreshold,
                annotation_type: newType
            })
        }));

        if (!response.ok) throw new Error('Tagger実行に失敗しました');

        const result = await response.json();

        // テキストエリアに結果を設定
        const textarea = document.getElementById('newTextInput');
        if (textarea) {
            textarea.value = result.text || '';
        }

        const tagCount = result.tags ? result.tags.length : 0;
        showToast(`タグ取得完了: ${tagCount}件`);

    } catch (error) {
        console.error('New box Tagger error:', error);
        showToast('タグ取得エラー: ' + error.message, true);
    }
}

// すべてのテキスト系アノテーションでOCRを再実行
async function regenerateAllOCR() {
    if (!currentAnnotations || currentAnnotations.length === 0) return;
    if (!confirm('現在のページ内のすべてのテキスト系アノテーション（セリフ、モノローグ等）に対してOCRを再実行しますか？\n既存のテキストは上書きされます。')) return;

    // OCR対象のタイプ
    const targetTypes = ['dialogue', 'monologue', 'whisper', 'narration', 'ruby', 'sound_effect', 'title', 'footnote'];
    const targets = currentAnnotations.filter(a => targetTypes.includes(a.type));

    if (targets.length === 0) {
        showToast('OCR対象のアノテーションがありません', true);
        return;
    }

    showToast(`OCR一括実行中... (対象: ${targets.length}件)`);

    let successCount = 0;
    for (const anno of targets) {
        try {
            await performOCRForAnnotation(anno.id);
            successCount++;
            // 少し待機（負荷軽減）
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.error(`OCR failed for ${anno.id}:`, e);
        }
    }

    showToast(`OCR一括完了: ${successCount}/${targets.length} 件成功`);
}

// すべての人物/顔/物体アノテーションでTagを再実行
async function regenerateAllTags() {
    if (!currentAnnotations || currentAnnotations.length === 0) return;
    if (!confirm(`現在のページ内のすべての人物・物体アノテーションに対してTag再取得を実行しますか？\n現在の閾値(${taggerThreshold})が使用されます。\n既存のテキストは上書きされます。`)) return;

    // Tagger対象のタイプ
    const targetTypes = ['person', 'body_part', 'object'];
    const targets = currentAnnotations.filter(a => targetTypes.includes(a.type));

    if (targets.length === 0) {
        showToast('Tag取得対象のアノテーションがありません', true);
        return;
    }

    showToast(`Tag一括実行中... (対象: ${targets.length}件)`);

    let successCount = 0;
    for (const anno of targets) {
        try {
            await performTaggerForAnnotation(anno.id);
            successCount++;
            // 少し待機（負荷軽減）
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.error(`Tagger failed for ${anno.id}:`, e);
        }
    }

    showToast(`Tag一括完了: ${successCount}/${targets.length} 件成功`);
}

// 設定を読み込む
async function loadTaggerSettings() {
    try {
        const response = await handleResponse(await fetch(`${API_BASE}/settings`, {
            headers: getAuthHeaders()
        }));
        if (!response.ok) return;
        const settings = await response.json();
        if (settings.tagger_threshold !== undefined) {
            taggerThreshold = settings.tagger_threshold;
        }
    } catch (error) {
        console.error('Failed to load tagger settings:', error);
    }
}
